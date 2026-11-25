# Prompt
I have Pasted the Output , debug it and clarify the features and build the implementation

# Ai Response
Worked for 43s
I reviewed all five files you pasted. Your existing inbound implementation is working, but I found several issues that should be corrected before we build outbound messaging.

We should preserve the working inbound flow and add outbound processing alongside it.

1. Code review: issues found
File

Finding

Action

types.ts

Outbound job model exists

Extend retry information

indexes.ts

Outbound indexes exist

Add pending-status index

pigeonWebhook.ts

Signature verification and durable insertion are implemented

Preserve

webhookWorker.ts

Early delivery status is discarded if outbound message doesn't exist

Fix

webhookWorker.ts

No maximum attempts or dead-letter state

Fix

webhookWorker.ts

Lease is not extended during long processing

Improve

index.ts

Raw-body middleware is correctly ordered

Preserve and register outbound route

One important distinction: Pigeon returning 200 accepted does not mean the customer received the message. We must distinguish queued, sent, delivered, and failed.

2. Outbound implementation we are building
Agent submits reply

Save message + outbound job in MongoDB

Worker claims job using atomic lease

Send to Pigeon with stable Idempotency-Key

Accepted

Save provider ID and await status webhook.

429 / 503 / timeout

Schedule retry with same idempotency key.

This also prevents duplicate sends when Pigeon accepts a message but the HTTP response times out.

3. Extend the outbound model
In scaffold/server/src/models/types.ts, replace the existing OutboundJobStatus definition with:

export type OutboundJobStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed';

Keep your existing OutboundJob interface. No additional status is needed: sent means Pigeon accepted the message; delivery status belongs on the Message.

In indexes.ts, add this index inside createIndexes():

await db.collection('pending_message_status').createIndex(
  { workspaceId: 1, clientRef: 1 },
  { unique: true, name: 'unique_pending_message_status' },
);

This collection will retain a status webhook that arrives before the outbound message is reconciled.

4. Create the outbound worker
Create scaffold/server/src/workers/outboundWorker.ts:


import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import type { OutboundJob, Message } from '../models/types.js';

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

  return Math.min(1000 * 2 ** Math.max(attempt - 1, 0), 60_000)
    + Math.floor(Math.random() * 300);
}

async function updateMessageStatus(
  message: Message,
  status: 'sent' | 'delivered' | 'failed',
  providerMessageId?: string,
): Promise<void> {
  const db = await getDb();
  const messages = db.collection<Message>('messages');

  const rank = { queued: 0, sending: 1, sent: 2, delivered: 3, failed: 3 };
  const current = message.status;

  // A delivered or failed message must never be downgraded.
  if (
    current === 'delivered' ||
    current === 'failed' ||
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
  const jobs = db.collection<OutboundJob>('outbound_jobs');
  const messages = db.collection<Message>('messages');

  const message = await messages.findOne({
    _id: job.messageId,
    workspaceId: job.workspaceId,
  });

  if (!message) {
    throw new Error('Outbound message record missing');
  }

  await messages.updateOne(
    { _id: message._id, workspaceId: job.workspaceId },
    { $set: { status: 'sending', updatedAt: new Date() } },
  );

  const apiKey = config.pigeon.apiKeys[job.workspaceId];

  if (!apiKey) {
    throw new Error(`No Pigeon API key for ${job.workspaceId}`);
  }

  let response: globalThis.Response;

  try {
    response = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': job.clientRef,
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
        error instanceof Error ? error.message : 'network error'
      }`,
    );
  }

  if (response.status === 429 || response.status === 503) {
    const error = new Error(`Pigeon returned ${response.status}`) as Error & {
      retryAfter?: string | null;
    };
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }

  if (!response.ok) {
    // A non-retryable provider response must not be retried forever.
    const error = new Error(`Pigeon rejected message: HTTP ${response.status}`);
    (error as Error & { permanent?: boolean }).permanent =
      response.status >= 400 && response.status < 500;
    throw error;
  }

  const result = await response.json() as {
    id?: string;
    status?: string;
  };

  if (!result.id || result.status !== 'accepted') {
    throw new Error('Unexpected Pigeon acceptance response');
  }

  await messages.updateOne(
    {
      _id: message._id,
      workspaceId: job.workspaceId,
    },
    {
      $set: {
        providerMessageId: result.id,
        updatedAt: new Date(),
      },
    },
  );

  await jobs.updateOne(
    { _id: job._id, status: 'processing' },
    {
      $set: {
        status: 'sent',
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
    status: 'sent' | 'delivered' | 'failed';
    providerMessageId?: string;
  }>('pending_message_status');

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
  const jobs = db.collection<OutboundJob>('outbound_jobs');
  const now = new Date();

  const job = await jobs.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'processing', leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'processing',
        leaseUntil: new Date(Date.now() + LEASE_MS),
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
    {
      sort: { nextAttemptAt: 1, createdAt: 1 },
      returnDocument: 'after',
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
      { _id: job._id, status: 'processing' },
      {
        $set: {
          status: failed ? 'failed' : 'pending',
          nextAttemptAt: new Date(Date.now() + delay),
          leaseUntil: null,
          lastError: detail.message ?? 'Unknown outbound error',
          updatedAt: new Date(),
        },
      },
    );

    await db.collection<Message>('messages').updateOne(
      {
        _id: job.messageId,
        workspaceId: job.workspaceId,
      },
      {
        $set: {
          status: failed ? 'failed' : 'queued',
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
          await new Promise(resolve => setTimeout(resolve, POLL_MS));
        }
      } catch (error) {
        console.error('Outbound worker error:', error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    running = false;
  })();
}

export function stopOutboundWorker(): void {
  stopped = true;
}

Remove the unused randomUUID import at the top if your TypeScript configuration later enables noUnusedLocals. We will generate the client reference in the route.

5. Create the outbound reply endpoint
Create scaffold/server/src/routes/outbound.ts.

This adds the assessment's grader reply endpoint. It checks the grader token, validates workspace ownership of the conversation, and durably saves the message and job before returning.


import { Router, type Request, type Response } from 'express';
import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import type {
  Conversation,
  Message,
  OutboundJob,
} from '../models/types.js';

const router = Router();

router.post('/__grader/reply', async (req: Request, res: Response) => {
  if (req.header('x-grader-token') !== config.graderToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { workspaceId, conversationId, text } = req.body ?? {};

  if (
    typeof workspaceId !== 'string' ||
    typeof conversationId !== 'string' ||
    !ObjectId.isValid(conversationId) ||
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > 5000
  ) {
    res.status(400).json({ error: 'Invalid reply input' });
    return;
  }

  try {
    const db = await getDb();
    const conversations = db.collection<Conversation>('conversations');

    const conversation = await conversations.findOne({
      _id: new ObjectId(conversationId),
      workspaceId,
    });

    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    if (conversation.status === 'closed') {
      res.status(409).json({ error: 'Conversation is closed' });
      return;
    }

    const now = new Date();
    const clientRef = randomUUID();
    const messageId = new ObjectId();

    const message: Message = {
      _id: messageId,
      workspaceId,
      conversationId: conversation._id!,
      clientRef,
      direction: 'outbound',
      from: '',
      to: conversation.contact,
      text: text.trim(),
      status: 'queued',
      occurredAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const job: OutboundJob = {
      workspaceId,
      conversationId: conversation._id!,
      messageId,
      clientRef,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      leaseUntil: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    // Insert message first. The worker cannot see a job until both records exist.
    await db.collection<Message>('messages').insertOne(message);

    try {
      await db.collection<OutboundJob>('outbound_jobs').insertOne(job);
    } catch (error) {
      // Compensate if job creation fails.
      await db.collection<Message>('messages').deleteOne({
        _id: messageId,
        workspaceId,
      });
      throw error;
    }

    await conversations.updateOne(
      { _id: conversation._id, workspaceId },
      {
        $set: {
          lastMessageAt: now,
          lastMessagePreview: text.trim().slice(0, 200),
          updatedAt: now,
        },
      },
    );

    res.status(202).json({
      accepted: true,
      messageId: messageId.toString(),
      clientRef,
      status: 'queued',
    });
  } catch (error) {
    console.error('Could not queue outbound reply:', error);
    res.status(500).json({ error: 'Could not queue reply' });
  }
});

export default router;

This endpoint uses the grader token because it is an assessment-only route. It is not a substitute for the eventual authenticated agent reply API.

6. Preserve early delivery status events
Your current processStatus() silently discards a status event if the outbound message does not yet exist. That is a real race condition.

In webhookWorker.ts, replace the existing processStatus() function with:


async function processStatus(event: WebhookEvent): Promise<void> {
  const data = event.payload.data as Record<string, unknown> | undefined;

  if (
    !data ||
    typeof data.message_id !== 'string' ||
    !['sent', 'delivered', 'failed'].includes(String(data.status))
  ) {
    throw new Error('Invalid message status payload');
  }

  const db = await getDb();
  const messages = db.collection<Message>('messages');

  const clientRef =
    typeof data.client_ref === 'string' ? data.client_ref : undefined;

  const message = await messages.findOne({
    workspaceId: event.workspaceId,
    direction: 'outbound',
    $or: [
      { providerMessageId: data.message_id },
      ...(clientRef ? [{ clientRef }] : []),
    ],
  });

  const status = data.status as 'sent' | 'delivered' | 'failed';

  if (!message) {
    // Retain early status events for reconciliation after provider acceptance.
    if (clientRef) {
      await db.collection('pending_message_status').updateOne(
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
    message.status === 'delivered' ||
    message.status === 'failed' ||
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

This preserves early status events when the provider supplies client_ref. It also prevents a later sent event from downgrading delivered.

7. Register the new route and worker
Open scaffold/server/src/index.ts.

Add these imports:

import outboundRouter from './routes/outbound.js';
import {
  startOutboundWorker,
  stopOutboundWorker,
} from './workers/outboundWorker.js';

After your existing app.use(express.json()), add:

app.use(outboundRouter);

Inside startServer(), start the outbound worker:

await getDb();

startWebhookWorker();
startOutboundWorker();

Inside shutdown(), stop both workers before closing the HTTP server:

stopWebhookWorker();
stopOutboundWorker();

One essential correction in outboundWorker.ts
Find the successful response's messages.updateOne() call. Replace its $set with:

$set: {
  providerMessageId: result.id,
  status: 'sent',
  updatedAt: new Date(),
},

The subsequent pending-status reconciliation can then upgrade sent to delivered or failed.

Also remove the unused randomUUID import from this worker.

8. Run the implementation checks
First stop the backend and run:

npm --prefix scaffold/server run typecheck

If it passes:

npm run scaffold:server

Then, in a second PowerShell window, test the endpoint. Use an actual conversation ID from MongoDB:

$headers = @{
  "x-grader-token" = "grader-dev-token"
  "Content-Type" = "application/json"
}

$body = @{
  workspaceId = "ws_acme"
  conversationId = "YOUR_CONVERSATION_OBJECT_ID"
  text = "Hello, this is a test reply."
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://localhost:4000/__grader/reply" `
  -Method Post `
  -Headers $headers `
  -Body $body

Expected initial response:

{
  "accepted": true,
  "messageId": "...",
  "clientRef": "...",
  "status": "queued"
}

Then inspect MongoDB:

db.outbound_jobs.find().sort({ createdAt: -1 }).limit(5)

db.messages.find({ direction: "outbound" }).sort({ createdAt: -1 }).limit(5)

9. Critical assessment checklist
Feature

Implementation

Durable outbound job

MongoDB

Stable idempotency key

clientRef

Pigeon authentication

Workspace API key

HTTP 429

Retry-After

HTTP 503

Exponential backoff

Timeout after acceptance

Retry same idempotency key

Duplicate job prevention

Unique index

Concurrent job claiming

Atomic MongoDB update

Early delivery status

Pending status reconciliation

Maximum attempts

12

Permanent client errors

Mark failed

Important limitations to be aware of: this is a first implementation, not yet a verified assessment pass. The worker's 45-second lease is not renewed, and its current failure handling needs lease ownership protection before relying on it under multiple instances. The reply endpoint is also grader-token protected rather than a complete user-authenticated API. Do not claim multi-instance readiness until those cases are tested.

Next action: typecheck now
Send me the complete TypeScript output. If it passes, we'll spend the remaining time on the checker and the highest-value reliability fixes rather than adding optional features.

import { randomUUID } from "node:crypto";
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
    throw new Error(No Pigeon API key for ${job.workspaceId});
  }

  let response: globalThis.Response;

  try {
    response = await fetch(${config.pigeon.url}/v1/messages, {
      method: "POST",
      headers: {
        Authorization: Bearer ${apiKey},
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
    const error = new Error(Pigeon returned ${response.status}) as Error & {
      retryAfter?: string | null;
    };
    error.retryAfter = response.headers.get("retry-after");
    throw error;
  }

  if (!response.ok) {
    // A non-retryable provider response must not be retried forever.
    const error = new Error(Pigeon rejected message: HTTP ${response.status});
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
      },
      {
        $set: {
          status: failed ? "failed" : "queued",
          updatedAt: new Date(),
        },
      },
    );

    console.error(Outbound job ${job.clientRef}:, detail.message);
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
what is the corection here i only have 5 mins
…
Your code is mostly correct. You only need 4 important corrections. Don't rewrite the entire file with 5 minutes remaining.

1. Remove unused import
At the top, delete:

import { randomUUID } from "node:crypto";

2. Fix message status after Pigeon accepts
Find this section in sendJob():

$set: {
  providerMessageId: result.id,
  updatedAt: new Date(),
},

Replace with:

$set: {
  providerMessageId: result.id,
  status: "sent",
  updatedAt: new Date(),
},

Otherwise, the message can remain sending even after Pigeon accepts it.

3. Fix retry handling so delivered messages aren't downgraded
Inside processNextJob(), find the catch block's message update:

await db.collection<Message>("messages").updateOne(
  {
    _id: job.messageId,
    workspaceId: job.workspaceId,
  },
  {
    $set: {
      status: failed ? "failed" : "queued",
      updatedAt: new Date(),
    },
  },
);

Replace it with:

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

This prevents a retry failure from overwriting a delivered or sent status.

4. Fix the retry attempt race
Your current job claim increments attempts atomically, which is good. However, a worker whose lease expires could still update a job after another worker has reclaimed it.

For now, add a unique lease token.

In processNextJob(), before findOneAndUpdate, add:

const leaseToken = randomUUID();

This requires restoring the import:

import { randomUUID } from "node:crypto";

Then add this to the claim $set:

leaseToken,

Your OutboundJob interface must also include:

leaseToken?: string;

And change the job completion update filter to:

{ _id: job._id, status: "processing", leaseToken: job.leaseToken }

Do the same for the retry update filter. This prevents an old worker from modifying a job reclaimed by another worker.

Run these commands immediately
npm --prefix scaffold/server run typecheck

If successful:

git add .
git commit -m "Implement durable outbound messaging and retries"

Then run:

npm run check

Priority Focus on passing the checker, not optional improvements.

One honest warning: this still does not fully solve lease renewal during long requests or reconciliation of early status events without client_ref. If the checker exposes either issue, we must address it.