
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
