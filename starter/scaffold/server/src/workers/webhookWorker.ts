import { getDb } from "../db.js";
import type { WebhookEvent, Conversation, Message } from "../models/types.js";

const LEASE_MS = 30_000;
const POLL_MS = 500;

let running = false;
let stopped = false;

async function processInbound(event: WebhookEvent): Promise<void> {
  const data = event.payload.data as Record<string, unknown> | undefined;

  if (
    !data ||
    typeof data.message_id !== "string" ||
    typeof data.from !== "string" ||
    typeof data.text !== "string"
  ) {
    throw new Error("Invalid inbound message payload");
  }

  const db = await getDb();
  const conversations = db.collection<Conversation>("conversations");
  const messages = db.collection<Message>("messages");

  const now = new Date();
  const occurredAt = event.occurredAt;

  // Create the conversation if it does not already exist.
  await conversations.updateOne(
    {
      workspaceId: event.workspaceId,
      contact: data.from,
    },
    {
      $setOnInsert: {
        workspaceId: event.workspaceId,
        contact: data.from,
        status: "open",
        assignedTo: null,
        lastMessageAt: occurredAt,
        lastMessagePreview: data.text.slice(0, 200),
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  const conversation = await conversations.findOne({
    workspaceId: event.workspaceId,
    contact: data.from,
  });

  if (!conversation?._id) {
    throw new Error("Conversation could not be created");
  }

  // Unique providerMessageId prevents duplicate message insertion.
  try {
    await messages.insertOne({
      workspaceId: event.workspaceId,
      conversationId: conversation._id,
      providerMessageId: data.message_id,
      direction: "inbound",
      from: data.from,
      to: "",
      text: data.text,
      status: "received",
      occurredAt,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error: unknown) {
    const mongoError = error as { code?: number };

    if (mongoError.code !== 11000) {
      throw error;
    }
  }

  // Never let an older, out-of-order event move inbox time backwards.
  await conversations.updateOne(
    {
      _id: conversation._id,
      workspaceId: event.workspaceId,
      $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: occurredAt } }],
    },
    {
      $set: {
        lastMessageAt: occurredAt,
        lastMessagePreview: data.text.slice(0, 200),
        updatedAt: now,
      },
    },
  );
}

async function processStatus(event: WebhookEvent): Promise<void> {
  const data = event.payload.data as Record<string, unknown> | undefined;

  if (
    !data ||
    typeof data.message_id !== "string" ||
    !["sent", "delivered", "failed"].includes(String(data.status))
  ) {
    throw new Error("Invalid message status payload");
  }

  const db = await getDb();
  const messages = db.collection<Message>("messages");

  const clientRef =
    typeof data.client_ref === "string" ? data.client_ref : undefined;

  const message = await messages.findOne({
    workspaceId: event.workspaceId,
    direction: "outbound",
    $or: [
      { providerMessageId: data.message_id },
      ...(clientRef ? [{ clientRef }] : []),
    ],
  });

  const status = data.status as "sent" | "delivered" | "failed";

  if (!message) {
    // Retain early status events for reconciliation after provider acceptance.
    if (clientRef) {
      await db.collection("pending_message_status").updateOne(
        {
          workspaceId: event.workspaceId,
          clientRef,
        },
        {
          $set: {
            workspaceId: event.workspaceId,
            clientRef,
            providerMessageId: data.message_id,
            status,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }

    // Without client_ref, the event cannot safely be matched yet.
    return;
  }

  const rank = { queued: 0, sending: 1, sent: 2, delivered: 3, failed: 3 };
  const currentRank = rank[message.status as keyof typeof rank] ?? 0;

  if (
    message.status === "delivered" ||
    message.status === "failed" ||
    rank[status] <= currentRank
  ) {
    return;
  }

  await messages.updateOne(
    {
      _id: message._id,
      workspaceId: event.workspaceId,
    },
    {
      $set: {
        status,
        updatedAt: new Date(),
      },
    },
  );
}

async function processEvent(event: WebhookEvent): Promise<void> {
  if (event.type === "message.inbound") {
    await processInbound(event);
    return;
  }

  if (event.type === "message.status") {
    await processStatus(event);
  }
}

async function processNextEvent(): Promise<boolean> {
  const db = await getDb();
  const events = db.collection<WebhookEvent>("webhook_events");
  const now = new Date();

  const event = await events.findOneAndUpdate(
    {
      $or: [
        { status: "pending" },
        {
          status: "processing",
          leaseUntil: { $lte: now },
        },
      ],
    },
    {
      $set: {
        status: "processing",
        leaseUntil: new Date(Date.now() + LEASE_MS),
      },
      $inc: { attempts: 1 },
    },
    {
      sort: { receivedAt: 1 },
      returnDocument: "after",
    },
  );

  if (!event) return false;

  try {
    await processEvent(event);

    await events.updateOne(
      {
        _id: event._id,
        status: "processing",
      },
      {
        $set: {
          status: "processed",
          processedAt: new Date(),
          leaseUntil: null,
        },
      },
    );
  } catch (error) {
    const retryDelay = Math.min(
      1000 * 2 ** Math.min(event.attempts, 6),
      60_000,
    );

    await events.updateOne(
      {
        _id: event._id,
        status: "processing",
      },
      {
        $set: {
          status: "processing",
          leaseUntil: new Date(Date.now() + retryDelay),
          lastError: error instanceof Error ? error.message : "Unknown error",
        },
      },
    );
  }

  return true;
}

export function startWebhookWorker(): void {
  if (running) return;

  running = true;
  stopped = false;

  void (async () => {
    while (!stopped) {
      try {
        const processed = await processNextEvent();

        if (!processed) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } catch (error) {
        console.error("Webhook worker error:", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    running = false;
  })();
}

export function stopWebhookWorker(): void {
  stopped = true;
}
