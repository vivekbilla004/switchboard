
import type { ObjectId } from 'mongodb';

// ---------- Shared types ----------

export type ConversationStatus = 'open' | 'closed';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageStatus =
  | 'received'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'failed';

export type WebhookStatus = 'pending' | 'processing' | 'processed';
export type OutboundJobStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed';

// ---------- Workspaces ----------

export interface Workspace {
  _id: string;
  name: string;
  createdAt: Date;
}

// ---------- Conversations ----------

export interface Conversation {
  _id?: ObjectId;
  workspaceId: string;
  contact: string;
  status: ConversationStatus;
  assignedTo: string | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------- Messages ----------

export interface Message {
  _id?: ObjectId;
  workspaceId: string;
  conversationId: ObjectId;

  providerMessageId?: string;
  clientRef?: string;

  direction: MessageDirection;
  from: string;
  to: string;
  text: string;

  status: MessageStatus;
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ---------- Webhook events ----------

export interface WebhookEvent {
  _id?: ObjectId;
  eventId: string;
  workspaceId: string;
  type: string;

  occurredAt: Date;
  receivedAt: Date;

  payload: Record<string, unknown>;

  status: WebhookStatus;
  attempts: number;
  leaseUntil: Date | null;
  processedAt: Date | null;
  lastError?: string | null;
}

// ---------- Outbound jobs ----------

export interface OutboundJob {
  _id?: ObjectId;
  workspaceId: string;
  conversationId: ObjectId;
  messageId: ObjectId;
  clientRef: string;

  status: OutboundJobStatus;
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;

  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------- Workspace counters ----------

export interface WorkspaceCounter {
  _id: string;
  seq: number;
}

// ---------- Workspace events ----------

export interface WorkspaceEvent {
  _id?: ObjectId;
  workspaceId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}
