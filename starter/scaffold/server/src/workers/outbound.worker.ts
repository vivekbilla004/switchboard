
import { getDb } from "../db.js";
import { config } from "../config.js";
import type { OutboundJob, Message } from "../models/types.js";

const POLL_MS = 400;
const LEASE_MS = 45_000;
const MAX_ATTEMPTS = 12;

let running = false;
let stopped = false;

function retryDelay(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 120_000);
    }

    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 0), 120_000);
    }
  }

  return (
    Math.min(1000 * 2 ** Math.max(attempt - 1, 0), 60_000) +
    Math.floor(Math.random() * 300)
  );
}

async function updateMessageStatus(
  message: Message,
  status: "sent" | "delivered" | "failed",
  providerMessageId?: string,
): Promise<void> {
  const db = await getDb();
  const messages = db.collection<Message>("messages");

  const rank = { queued: 0, sending: 1, sent: 2, delivered: 3, failed: 3 };
  const current = message.status;

  // A delivered or failed message must never be downgraded.
  if (
    current === "delivered" ||
    current === "failed" ||
    rank[status] <= (rank[current as keyof typeof rank] ?? 0)
  ) {
    return;
  }

  await messages.updateOne(
    { _id: message._id, workspaceId: message.workspaceId },
    {
      $set: {
        status,
        ...(providerMessageId ? { providerMessageId } : {}),
        updatedAt: new Date(),
      },
    },
  );
}

async function sendJob(job: OutboundJob): Promise<void> {
  const db = await getDb();
  const jobs = db.collection<OutboundJob>("outbound_jobs");
  const messages = db.collection<Message>("messages");

  const message = await messages.findOne({
    _id: job.messageId,
    workspaceId: job.workspaceId,
  });

  if (!message) {
    throw new Error("Outbound message record missing");
  }

  await messages.updateOne(
    { _id: message._id, workspaceId: job.workspaceId },
    { $set: { status: "sending", updatedAt: new Date() } },
  );

  const apiKey = config.pigeon.apiKeys[job.workspaceId];

  if (!apiKey) {
    throw new Error(`No Pigeon API key for ${job.workspaceId}`);
  }

  let response: globalThis.Response;

  try {
    response = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": job.clientRef,
      },
      body: JSON.stringify({
        to: message.to,
        text: message.text,
        client_ref: job.clientRef,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    // A timeout is ambiguous. Pigeon may already have accepted the message.
    // Retry with exactly the same Idempotency-Key.
    throw new Error(
      `Pigeon request outcome unknown: ${
        error instanceof Error ? error.message : "network error"
      }`,
    );
  }

  if (response.status === 429 || response.status === 503) {
    const error = new Error(`Pigeon returned ${response.status}`) as Error & {
      retryAfter?: string | null;
    };
    error.retryAfter = response.headers.get("retry-after");
    throw error;
  }

  if (!response.ok) {
    // A non-retryable provider response must not be retried forever.
    const error = new Error(`Pigeon rejected message: HTTP ${response.status}`);
    (error as Error & { permanent?: boolean }).permanent =
      response.status >= 400 && response.status < 500;
    throw error;
  }

  const result = (await response.json()) as {
    id?: string;
    status?: string;
  };

  if (!result.id || result.status !== "accepted") {
    throw new Error("Unexpected Pigeon acceptance response");
  }

  await messages.updateOne(
    {
      _id: message._id,
      workspaceId: job.workspaceId,
    },
    {
        $set: {
            providerMessageId: result.id,
            status: "sent",
            updatedAt: new Date(),
          },
    },
  );

  await jobs.updateOne(
    { _id: job._id, status: "processing" },
    {
      $set: {
        status: "sent",
        leaseUntil: null,
        updatedAt: new Date(),
        lastError: null,
      },
    },
  );

  // Reconcile a status webhook that arrived before Pigeon's HTTP response.
  const pendingStatuses = db.collection<{
    workspaceId: string;
    clientRef: string;
    status: "sent" | "delivered" | "failed";
    providerMessageId?: string;
  }>("pending_message_status");

  const pending = await pendingStatuses.findOne({
    workspaceId: job.workspaceId,
    clientRef: job.clientRef,
  });

  if (pending) {
    const refreshed = await messages.findOne({
      _id: message._id,
      workspaceId: job.workspaceId,
    });

    if (refreshed) {
      await updateMessageStatus(
        refreshed,
        pending.status,
        pending.providerMessageId ?? result.id,
      );
    }

    await pendingStatuses.deleteOne({
      workspaceId: job.workspaceId,
      clientRef: job.clientRef,
    });
  }
}

async function processNextJob(): Promise<boolean> {
  const db = await getDb();
  const jobs = db.collection<OutboundJob>("outbound_jobs");
  const now = new Date();

  const job = await jobs.findOneAndUpdate(
    {
      $or: [
        { status: "pending", nextAttemptAt: { $lte: now } },
        { status: "processing", leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "processing",
        leaseUntil: new Date(Date.now() + LEASE_MS),
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
    {
      sort: { nextAttemptAt: 1, createdAt: 1 },
      returnDocument: "after",
    },
  );

  if (!job) return false;

  try {
    await sendJob(job);
  } catch (error) {
    const detail = error as Error & {
      retryAfter?: string | null;
      permanent?: boolean;
    };

    const permanent = detail.permanent === true;
    const exhausted = job.attempts >= MAX_ATTEMPTS;
    const failed = permanent || exhausted;

    const delay = retryDelay(job.attempts, detail.retryAfter);

    await jobs.updateOne(
      { _id: job._id, status: "processing" },
      {
        $set: {
          status: failed ? "failed" : "pending",
          nextAttemptAt: new Date(Date.now() + delay),
          leaseUntil: null,
          lastError: detail.message ?? "Unknown outbound error",
          updatedAt: new Date(),
        },
      },
    );

    await db.collection<Message>("messages").updateOne(
        {
          _id: job.messageId,
          workspaceId: job.workspaceId,
          status: { $in: ["queued", "sending"] },
        },
        {
          $set: {
            status: failed ? "failed" : "queued",
            updatedAt: new Date(),
          },
        },
      );

    console.error(`Outbound job ${job.clientRef}:`, detail.message);
  }

  return true;
}

export function startOutboundWorker(): void {
  if (running) return;

  running = true;
  stopped = false;

  void (async () => {
    while (!stopped) {
      try {
        const worked = await processNextJob();

        if (!worked) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } catch (error) {
        console.error("Outbound worker error:", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    running = false;
  })();
}

export function stopOutboundWorker(): void {
  stopped = true;
}
