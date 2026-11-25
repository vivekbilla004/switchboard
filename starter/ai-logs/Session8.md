# Prompt
Yes , its a Success , MongoDB indexes initialized
Initial workspaces verified
server on http://localhost:4000
MongoDB connection ready , lets move to WebHook feature quickly

# Ai Response ( ChatGpt )
Great! MongoDB is now fully initialized. Let's implement the Pigeon inbound webhook as our next priority, with reliability built in rather than just making the endpoint return 200.

We'll use this flow:

Pigeon sends webhook

Verify HMAC signature + timestamp

Validate event + workspace

Persist event in MongoDB

Return 2xx — only after durable storage

Background worker processes event idempotently

We'll keep MongoDB as the source of truth. Redis will not be required to acknowledge or persist webhook events.

Step 1 — Create the webhook route
Create or open:

scaffold/server/src/routes/pigeonWebhook.ts

Replace its contents with:


import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db.js';
import type { WebhookEvent, Workspace } from '../models/types.js';

const router = Router();

const MAX_AGE_SECONDS = 5 * 60;

function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;

  const match = /^t=(\d+),v1=([a-f0-9]{64})$/i.exec(signatureHeader);
  if (!match) return false;

  const timestamp = Number(match[1]);
  const receivedSignature = match[2];

  if (!Number.isSafeInteger(timestamp)) return false;

  const ageSeconds = Math.floor(Date.now() / 1000) - timestamp;

  if (ageSeconds > MAX_AGE_SECONDS) return false;

  const expectedSignature = createHmac(
    'sha256',
    process.env.PIGEON_WEBHOOK_SECRET ?? 'whsec_pigeon_dev',
  )
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');

  const received = Buffer.from(receivedSignature, 'hex');
  const expected = Buffer.from(expectedSignature, 'hex');

  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
}

router.post(
  '/',
  async (req: Request, res: Response): Promise<void> => {
    const rawBody = req.body;

    if (!Buffer.isBuffer(rawBody)) {
      res.status(400).json({ error: 'Expected raw JSON body' });
      return;
    }

    if (
      !verifySignature(
        rawBody,
        req.header('x-pigeon-signature'),
      )
    ) {
      res.status(401).json({ error: 'Invalid or expired signature' });
      return;
    }

    let payload: Record<string, unknown>;

    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));

      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        res.status(400).json({ error: 'Invalid event body' });
        return;
      }

      payload = parsed as Record<string, unknown>;
    } catch {
      res.status(400).json({ error: 'Malformed JSON' });
      return;
    }

    const eventId = req.header('x-pigeon-event-id');
    const bodyEventId = payload.id;
    const eventType = payload.type;
    const workspaceId = payload.workspace;
    const occurredAt = payload.occurred_at;

    if (
      !eventId ||
      typeof bodyEventId !== 'string' ||
      bodyEventId !== eventId ||
      typeof eventType !== 'string' ||
      typeof workspaceId !== 'string' ||
      typeof occurredAt !== 'string' ||
      Number.isNaN(Date.parse(occurredAt))
    ) {
      res.status(400).json({ error: 'Invalid event fields' });
      return;
    }

    // Unknown event types are acknowledged and ignored.
    if (!['message.inbound', 'message.status'].includes(eventType)) {
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    try {
      const db = await getDb();

      const workspace = await db
        .collection<Workspace>('workspaces')
        .findOne({ _id: workspaceId });

      // Unknown workspaces must be acknowledged but ignored.
      if (!workspace) {
        res.status(200).json({ received: true, ignored: true });
        return;
      }

      const event: WebhookEvent = {
        eventId,
        workspaceId,
        type: eventType,
        occurredAt: new Date(occurredAt),
        receivedAt: new Date(),
        payload,
        status: 'pending',
        attempts: 0,
        leaseUntil: null,
        processedAt: null,
      };

      try {
        await db.collection<WebhookEvent>('webhook_events').insertOne(event);
      } catch (error: unknown) {
        const mongoError = error as { code?: number };

        // Duplicate event means it was already safely persisted.
        if (mongoError.code === 11000) {
          res.status(200).json({ received: true, duplicate: true });
          return;
        }

        throw error;
      }

      res.status(202).json({ received: true });
    } catch (error) {
      console.error('Pigeon webhook persistence failed:', error);
      res.status(500).json({ error: 'Could not persist webhook event' });
    }
  },
);

export default router;

Important: This uses the exact Pigeon signature format: HMAC-SHA256 of timestamp + "." + raw request body. It also checks that the timestamp is not older than five minutes.

Step 2 — Register the raw-body route correctly
Open:

scaffold/server/src/index.ts

Add the import:

import pigeonWebhookRouter from './routes/pigeonWebhook.js';

Then, after creating app, register the webhook route before express.json():

app.use(
  '/webhooks/pigeon',
  express.raw({ type: 'application/json', limit: '1mb' }),
  pigeonWebhookRouter,
);

app.use(express.json());

Keep your existing /healthz, MongoDB startup, HTTP server, and graceful shutdown code.

This middleware order is critical: if express.json() runs first, it consumes the request body and the signature check will no longer have the original raw bytes.

Step 3 — Implement durable background processing
The webhook route now stores events as pending. Next, create the worker that claims those events, processes them, and marks them as processed. Expired processing leases can be reclaimed after a crash.

Create:

scaffold/server/src/workers/webhookWorker.ts


import { getDb } from '../db.js';
import type {
  WebhookEvent,
  Conversation,
  Message,
} from '../models/types.js';

const LEASE_MS = 30_000;
const POLL_MS = 500;

let running = false;
let stopped = false;

async function processInbound(
  event: WebhookEvent,
): Promise<void> {
  const data = event.payload.data as Record<string, unknown> | undefined;

  if (
    !data ||
    typeof data.message_id !== 'string' ||
    typeof data.from !== 'string' ||
    typeof data.text !== 'string'
  ) {
    throw new Error('Invalid inbound message payload');
  }

  const db = await getDb();
  const conversations = db.collection<Conversation>('conversations');
  const messages = db.collection<Message>('messages');

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
        status: 'open',
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
    throw new Error('Conversation could not be created');
  }

  // Unique providerMessageId prevents duplicate message insertion.
  try {
    await messages.insertOne({
      workspaceId: event.workspaceId,
      conversationId: conversation._id,
      providerMessageId: data.message_id,
      direction: 'inbound',
      from: data.from,
      to: '',
      text: data.text,
      status: 'received',
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
      $or: [
        { lastMessageAt: null },
        { lastMessageAt: { $lte: occurredAt } },
      ],
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

async function processStatus(
  event: WebhookEvent,
): Promise<void> {
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

  const message = await messages.findOne({
    workspaceId: event.workspaceId,
    $or: [
      { providerMessageId: data.message_id },
      ...(typeof data.client_ref === 'string'
        ? [{ clientRef: data.client_ref }]
        : []),
    ],
    direction: 'outbound',
  });

  // The provider may send a status before the outbound message is known.
  if (!message?._id) return;

  const currentStatus = message.status;
  const incomingStatus = data.status as 'sent' | 'delivered' | 'failed';

  // Do not downgrade a delivered or failed message.
  if (
    currentStatus === 'delivered' ||
    currentStatus === 'failed'
  ) {
    return;
  }

  if (
    currentStatus === 'sent' &&
    incomingStatus === 'sent'
  ) {
    return;
  }

  await messages.updateOne(
    {
      _id: message._id,
      workspaceId: event.workspaceId,
      status: currentStatus,
    },
    {
      $set: {
        status: incomingStatus,
        updatedAt: new Date(),
      },
    },
  );
}

async function processEvent(event: WebhookEvent): Promise<void> {
  if (event.type === 'message.inbound') {
    await processInbound(event);
    return;
  }

  if (event.type === 'message.status') {
    await processStatus(event);
  }
}

async function processNextEvent(): Promise<boolean> {
  const db = await getDb();
  const events = db.collection<WebhookEvent>('webhook_events');
  const now = new Date();

  const event = await events.findOneAndUpdate(
    {
      $or: [
        { status: 'pending' },
        {
          status: 'processing',
          leaseUntil: { $lte: now },
        },
      ],
    },
    {
      $set: {
        status: 'processing',
        leaseUntil: new Date(Date.now() + LEASE_MS),
      },
      $inc: { attempts: 1 },
    },
    {
      sort: { receivedAt: 1 },
      returnDocument: 'after',
    },
  );

  if (!event) return false;

  try {
    await processEvent(event);

    await events.updateOne(
      {
        _id: event._id,
        status: 'processing',
      },
      {
        $set: {
          status: 'processed',
          processedAt: new Date(),
          leaseUntil: null,
        },
      },
    );
  } catch (error) {
    console.error(`Webhook event ${event.eventId} failed:`, error);

    // Return it to pending so it can be retried.
    await events.updateOne(
      {
        _id: event._id,
        status: 'processing',
      },
      {
        $set: {
          status: 'pending',
          leaseUntil: null,
          lastError:
            error instanceof Error ? error.message : 'Unknown error',
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
        console.error('Webhook worker error:', error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    running = false;
  })();
}

export function stopWebhookWorker(): void {
  stopped = true;
}

One important implementation note: the worker uses findOneAndUpdate to atomically claim events. This prevents two server instances from processing the same pending event simultaneously. The lease allows another instance to recover work if the first crashes.

Step 4 — Start the worker with the server
In index.ts, add:

import {
  startWebhookWorker,
  stopWebhookWorker,
} from './workers/webhookWorker.js';

Inside your existing startServer() function, start the worker after await getDb() and before server.listen():

await getDb();
startWebhookWorker();

Inside shutdown(), call this before closing the HTTP server:

stopWebhookWorker();

Small reliability correction
In webhookWorker.ts, find the catch block inside processNextEvent(). Replace its updateOne with this:

const retryDelay = Math.min(
  1000 * 2 ** Math.min(event.attempts, 6),
  60_000,
);

await events.updateOne(
  {
    _id: event._id,
    status: 'processing',
  },
  {
    $set: {
      status: 'processing',
      leaseUntil: new Date(Date.now() + retryDelay),
      lastError:
        error instanceof Error ? error.message : 'Unknown error',
    },
  },
);

This prevents invalid or temporarily failing events from being retried continuously. The worker will reclaim them after their lease expires.

Also, in pigeonWebhook.ts, import your existing config:

import { config } from '../config.js';

Then replace:

process.env.PIGEON_WEBHOOK_SECRET ?? 'whsec_pigeon_dev'

with:

config.pigeon.webhookSecret

This ensures signature verification uses the same environment configuration as the rest of the backend.

Step 5 — Compile and test
Stop the running backend, then run:

npm --prefix scaffold/server run typecheck

If it passes, start the backend:

npm run scaffold:server

Keep this terminal running. Open a second PowerShell terminal in the project root.

Start Pigeon's inbound event simulator:

npm run inbound

Let it run for a few seconds, then inspect the provider report:

npm run report

You should see inbound events being generated and accepted.

Step 6 — Verify the implementation
Test these cases before moving to outbound messaging:

Test

Expected result

Valid signed inbound event

202

Same event delivered again

200, duplicate

Invalid signature

401

Expired signature

401

Malformed JSON with valid signature

400

Unknown workspace

200, ignored

Unknown event type

200, ignored

Server restart with pending events

Worker recovers events

One important limitation to address next: status events that arrive before their outbound message currently get acknowledged and ignored. We'll improve this when implementing outbound message reconciliation, so an early delivered event cannot be lost.

Your immediate task

Apply the webhook route and worker files.
Register and start the worker in index.ts.

Run the TypeScript check.
Run the inbound simulator and report.
Send me the typecheck output first if it fails, or the simulator/report output if it succeeds. We'll fix any issues before moving to the outbound queue.

Git reminder: Commit this working webhook implementation once it passes the initial tests. Keep your assessment's 15-minute commit interval in mind.