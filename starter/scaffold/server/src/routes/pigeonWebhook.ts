import { Router, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "../db.js";
import type { WebhookEvent, Workspace } from "../models/types.js";
import { config } from "../config.js";

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
    "sha256",
    config.pigeon.webhookSecret
  )
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");

  const received = Buffer.from(receivedSignature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");

  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

router.post("/", async (req: Request, res: Response): Promise<void> => {
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: "Expected raw JSON body" });
    return;
  }

  if (!verifySignature(rawBody, req.header("x-pigeon-signature"))) {
    res.status(401).json({ error: "Invalid or expired signature" });
    return;
  }

  let payload: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      res.status(400).json({ error: "Invalid event body" });
      return;
    }

    payload = parsed as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: "Malformed JSON" });
    return;
  }

  const eventId = req.header("x-pigeon-event-id");
  const bodyEventId = payload.id;
  const eventType = payload.type;
  const workspaceId = payload.workspace;
  const occurredAt = payload.occurred_at;

  if (
    !eventId ||
    typeof bodyEventId !== "string" ||
    bodyEventId !== eventId ||
    typeof eventType !== "string" ||
    typeof workspaceId !== "string" ||
    typeof occurredAt !== "string" ||
    Number.isNaN(Date.parse(occurredAt))
  ) {
    res.status(400).json({ error: "Invalid event fields" });
    return;
  }

  // Unknown event types are acknowledged and ignored.
  if (!["message.inbound", "message.status"].includes(eventType)) {
    res.status(200).json({ received: true, ignored: true });
    return;
  }

  try {
    const db = await getDb();

    const workspace = await db
      .collection<Workspace>("workspaces")
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
      status: "pending",
      attempts: 0,
      leaseUntil: null,
      processedAt: null,
    };

    try {
      await db.collection<WebhookEvent>("webhook_events").insertOne(event);
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
    console.error("Pigeon webhook persistence failed:", error);
    res.status(500).json({ error: "Could not persist webhook event" });
  }
});

export default router;
