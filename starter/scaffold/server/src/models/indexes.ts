import type { Db } from "mongodb";
import type {
  Workspace,
  Conversation,
  Message,
  WebhookEvent,
  OutboundJob,
  WorkspaceCounter,
  WorkspaceEvent,
} from "./types.js";

export async function createIndexes(db: Db): Promise<void> {
  const conversations = db.collection<Conversation>("conversations");
  const messages = db.collection<Message>("messages");
  const webhookEvents = db.collection<WebhookEvent>("webhook_events");
  const outboundJobs = db.collection<OutboundJob>("outbound_jobs");
  const workspaceEvents = db.collection<WorkspaceEvent>("workspace_events");

  await db
    .collection("pending_message_status")
    .createIndex(
      { workspaceId: 1, clientRef: 1 },
      { unique: true, name: "unique_pending_message_status" },
    );

  // One conversation per customer in each workspace.
  await conversations.createIndex(
    { workspaceId: 1, contact: 1 },
    { unique: true, name: "unique_workspace_contact" },
  );

  // Efficient inbox sorting and pagination.
  await conversations.createIndex(
    { workspaceId: 1, lastMessageAt: -1, _id: 1 },
    { name: "workspace_inbox_order" },
  );

  // Fetch conversation messages in chronological order.
  await messages.createIndex(
    { workspaceId: 1, conversationId: 1, createdAt: 1, _id: 1 },
    { name: "conversation_messages_order" },
  );

  // A provider message must not be inserted twice.
  await messages.createIndex(
    { workspaceId: 1, providerMessageId: 1 },
    {
      unique: true,
      name: "unique_provider_message",
      partialFilterExpression: {
        providerMessageId: { $type: "string" },
      },
    },
  );

  // An outbound client reference must be unique per workspace.
  await messages.createIndex(
    { workspaceId: 1, clientRef: 1 },
    {
      unique: true,
      name: "unique_outbound_client_ref",
      partialFilterExpression: {
        clientRef: { $type: "string" },
      },
    },
  );

  // The event ID is the provider delivery deduplication key.
  await webhookEvents.createIndex(
    { eventId: 1 },
    { unique: true, name: "unique_webhook_event_id" },
  );

  // Find pending events and recover expired processing leases.
  await webhookEvents.createIndex(
    { status: 1, leaseUntil: 1, receivedAt: 1 },
    { name: "webhook_status_recovery" },
  );

  // Prevent duplicate outbound jobs.
  await outboundJobs.createIndex(
    { workspaceId: 1, clientRef: 1 },
    { unique: true, name: "unique_outbound_job" },
  );

  // Find jobs ready for sending or expired-lease recovery.
  await outboundJobs.createIndex(
    { status: 1, nextAttemptAt: 1, leaseUntil: 1 },
    { name: "outbound_job_scheduler" },
  );

  // Ordered workspace events for WebSocket replay.
  await workspaceEvents.createIndex(
    { workspaceId: 1, seq: 1 },
    { unique: true, name: "unique_workspace_sequence" },
  );

  console.log("MongoDB indexes initialized");
}

export async function seedWorkspaces(db: Db): Promise<void> {
  const workspaces = db.collection<Workspace>("workspaces");

  const initialWorkspaces: Workspace[] = [
    {
      _id: "ws_acme",
      name: "Acme",
      createdAt: new Date(),
    },
    {
      _id: "ws_globex",
      name: "Globex",
      createdAt: new Date(),
    },
  ];

  for (const workspace of initialWorkspaces) {
    const { _id, ...fields } = workspace;

    await workspaces.updateOne(
      { _id },
      { $setOnInsert: fields },
      { upsert: true },
    );
  }

  console.log("Initial workspaces verified");
}
