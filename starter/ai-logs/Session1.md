# Prompt
starter.zip
File

START_HERE.md
Document
please go through this file and determine the requirement and Objectives of this Coding round  ,  Analyze this complete SDE assessment problem statement.

Mandatory requirements.
Optional requirements.
Most important features to implement first.
Database schema.
Backend API list.
Frontend page/component list.
Redis usage.
Potential failure scenarios.
A realistic 100-minute development plan.
Do not generate code yet. First help me understand the requirements and priorities.

# Ai Response

GOGHL.AI SDE Coding Round — Complete Requirement Analysis
Project: Switchboard
Problem statement analyzed
Product type: Multi-tenant shared team inbox

Your role: Build the business-side application using Node.js, React, MongoDB and Redis.

Time available: 100 minutes of development, following the initial 10-minute reading/setup period.

Main objective: Build a working support inbox that receives customer messages, lets human support agents reply, and remains reliable when webhooks are duplicated, servers crash, or multiple server instances run simultaneously.

85
Core assessment points

10
Separate bonus billing points

I inspected the uploaded starter.zip, START_HERE.md, BRIEF.md, PIGEON.md, SUBMISSION.md, the optional scaffold, and billing documentation.

The most important discovery: this is not a normal CRUD application. It is a distributed messaging system with a React interface.

The evaluators care much more about reliability, message delivery, data consistency, authentication and multi-instance behaviour than visual design.

1. Understand what you are building
Switchboard — shared team inbox
Transform Your Communication with Unified Inbox - SAAS First
Imagine a company has five customer support agents.

Customers send messages to the company. All messages arrive in your application. Agents log in and can:

See incoming customer conversations.

Open and read messages.

Claim a conversation.

Reply to customers.

See whether their replies were sent, delivered or failed.

Close and reopen conversations.

Receive live updates without refreshing the page.

Multiple businesses use the same application, but their information must remain completely separate.

For example:

Business

Workspace

Users

Acme

ws_acme

Asha, Ben, Eli

Globex

ws_globex

Chloe, Dev, Eli

Eli belongs to both workspaces. This is important: workspace authorization must be checked for every request, not just during login.

Important: An agent means a human support employee. You are NOT building an AI chatbot.

System architecture
This is the architecture described in BRIEF.md:

Switchboard architecture
Simulated customers

Pigeon messaging provider :4010

Signed webhooks

Your Node.js backend

Webhook processing · APIs · Authentication · Message sending

MongoDB

Persistent data

Redis

Coordination and real-time messaging

Authenticated WebSocket connection

React frontend

Human support agents · Inbox · Conversation · Replies

The supporting services are already provided:

Service

Port

Purpose

Pigeon

4010

Simulated messaging provider

Mock Identity Provider

4020

Login and user identity

MongoDB

27017

Persistent database

Redis

6379

Shared coordination

Elasticsearch

9200

Optional search

Paybox

4030

Optional billing

You build the application that connects these services.

2. Mandatory requirements
These are the requirements directly specified in BRIEF.md.

A. Login and authentication
Implement authentication using the provided Mock IdP.

Requirements:

Authorization Code flow.

PKCE with S256.

Login redirect.

Callback handling.

Session cookie.

User workspace and role retrieval.

Authorization for workspace-specific APIs.

Available roles:

admin

agent

The test users are already configured. There are no passwords; the mock login page lets you select a user.

The application must support the five provided test users, including Eli, who belongs to two workspaces.

B. Receive customer messages
Critical
Your backend must implement:

POST /webhooks/pigeon
Pigeon sends events to your server.

Two main event types:

1. Incoming message

{
  "id": "evt_123",
  "type": "message.inbound",
  "workspace": "ws_acme",
  "data": {
    "message_id": "pmsg_123",
    "from": "+14155550101",
    "text": "Hello"
  }
}

2. Message status

{
  "id": "evt_456",
  "type": "message.status",
  "workspace": "ws_acme",
  "data": {
    "message_id": "pm_123",
    "client_ref": "reply_123",
    "status": "delivered"
  }
}

You must process these events safely and update your database.

Critical webhook requirements:

Verify HMAC-SHA256 signature using the raw request body.

Reject invalid signatures with HTTP 401.

Reject timestamps older than five minutes.

Prevent duplicate event processing.

Handle out-of-order events.

Return 2xx only after the event has been safely stored or was already processed.

Unknown event types should receive 2xx.

Do not lose events during server failures.

This is one of the highest-priority parts of the assessment.

C. Inbox and conversation management
Agents should be able to:

View all conversations in their workspace.

See the latest activity first.

Paginate conversations.

Open conversations.

Read messages oldest first.

Claim conversations.

Close conversations.

Reopen conversations.

Two agents must not be able to claim the same conversation simultaneously.

This requires atomic assignment logic, not just a frontend button.

D. Reply to customers
The backend sends replies through Pigeon:

POST http://localhost:4010/v1/messages
Example request:

{
  "to": "+14155550101",
  "text": "Hello, how can we help?",
  "client_ref": "reply_001"
}

Required message states:

Queued
Sent
Delivered
Failed
The system must ensure:

Replies are not duplicated.

Replies are not lost.

Slow provider responses do not create duplicate sends.

Temporary provider outages do not permanently lose agent replies.

Rate limits are respected.

The strongest approach is a persistent outbound queue with idempotency and retry handling.

E. Real-time updates
The React frontend must receive updates without refreshing.

Use WebSockets.

Events include:

message.inbound

message.status

conversation.assigned

Every change must have a workspace-specific increasing sequence number (seq).

If a browser disconnects and reconnects, it must receive missed events using:

GET /ws?workspace=ws_acme&after=41
With multiple server instances, events processed by one instance must also reach clients connected to another instance.

F. Frontend
Build a functional React application that supports the above workflows.

A beautiful interface is not required. A usable interface is.

3. Optional requirements
Don't confuse optional features with mandatory functionality.

Feature

Priority

Scoring

Private encrypted notes

Optional

Reviewed

Elasticsearch message search

Optional

Reviewed

Unit/integration tests

Recommended

Reviewed

Paybox subscription billing

Bonus

10 extra points

My recommendation:

Do not implement billing, Elasticsearch or encrypted notes until the core application and reliability checks are working.

The bonus billing documentation explicitly says it cannot compensate for a failed Must tier.

4. Most important features to implement first
The assessment has five automatic testing levels.

Scoring breakdown
Level 1 — Webhook reliability and single-instance correctness

24/85
Level 2 — Survive process crash and restart

14/85
Level 3 — Multiple instances and shared coordination

22/85
Level 4 — Written provider contract edge cases

10/85
Level 5 — Authentication, isolation and real-time

15/85
Total automatic score

85/85
The START_HERE.md specifically recommends implementing and checking in this order:

Level 1 → Level 5 → Level 2 → Level 3.

Level 4 is the written contract edge-case test, which you should address through the webhook implementation.

Here's how I would prioritize the actual development.

Priority

Feature

Why

P0

Server starts and health check works

Without this, automatic check scores zero

P0

Pigeon webhook verification and persistence

Foundation of the application

P0

Incoming message deduplication

Level 1

P0

Outbound reply queue and idempotency

Level 1 and 2

P0

MongoDB persistence

Crash recovery

P0

Atomic conversation claiming

Concurrent agents

P1

Authentication and workspace isolation

Level 5

P1

WebSocket event delivery and replay

Level 5

P1

Redis coordination and shared rate limiting

Level 3

P1

Background queue recovery

Levels 2 and 3

P2

Close/reopen functionality

Product completeness

P2

Functional React inbox

Product completeness

P3

Encrypted notes and search

Optional

Important distinction: The order above is an implementation recommendation, not a claim that every lower-priority feature is excluded from the grader. The official scoring gives 15 points to Level 5, so authentication and isolation should not be postponed until the end.

5. Recommended database schema
The brief does not prescribe MongoDB collection names or exact document structures. The following is a proposed design derived from its requirements.

I recommend six core collections.

1. Workspaces
{
  "_id": "ws_acme",
  "name": "Acme",
  "createdAt": "timestamp"
}

Purpose: separate each business's information.

2. Conversations
{
  "_id": "conversation_001",
  "workspaceId": "ws_acme",
  "contact": "+14155550101",
  "assignee": "u_ben",
  "status": "open",
  "lastMessageAt": "timestamp",
  "createdAt": "timestamp",
  "updatedAt": "timestamp"
}

Important indexes:

workspaceId + contact (unique)
workspaceId + lastMessageAt
This ensures one conversation per contact per workspace.

3. Messages
{
  "_id": "message_001",
  "workspaceId": "ws_acme",
  "conversationId": "conversation_001",
  "providerMessageId": "pmsg_001",
  "clientRef": null,
  "direction": "inbound",
  "text": "Hello",
  "status": "received",
  "createdAt": "timestamp"
}

For outbound messages, clientRef should be populated.

Important indexes:

workspaceId + conversationId + createdAt
workspaceId + providerMessageId (unique where present)
workspaceId + clientRef (unique where present)
4. WebhookEvents
{
  "_id": "evt_123",
  "workspaceId": "ws_acme",
  "type": "message.inbound",
  "payload": {},
  "processed": true,
  "receivedAt": "timestamp"
}

Purpose:

Prevent duplicate webhook processing.

Track incoming events.

Support recovery and debugging.

Make event IDs unique.

5. OutboundJobs
{
  "_id": "reply_001",
  "workspaceId": "ws_acme",
  "conversationId": "conversation_001",
  "contact": "+14155550101",
  "text": "How can we help?",
  "clientRef": "reply_001",
  "status": "queued",
  "attempts": 0,
  "nextAttemptAt": "timestamp",
  "createdAt": "timestamp"
}

Suggested statuses:

queued

processing

sent

delivered

failed

This is especially important for surviving process crashes.

6. WorkspaceEvents
{
  "_id": "event_001",
  "workspaceId": "ws_acme",
  "seq": 41,
  "type": "message.inbound",
  "contact": "+14155550101",
  "messageId": "pmsg_001",
  "createdAt": "timestamp"
}

Purpose:

Maintain increasing sequence numbers per workspace.

Replay missed WebSocket events.

Support multiple server instances.

Use an atomic per-workspace counter.

Schema note: These are suggested implementation structures, not prescribed schemas from the problem statement. Adjust field names as needed, but preserve the required snapshot semantics and uniqueness guarantees.

6. Backend API list
There are exact endpoints the evaluator expects. These must not be renamed.

A. Mandatory endpoints from the brief
Method

Endpoint

Purpose

POST

/webhooks/pigeon

Receive Pigeon events

GET

/healthz

Health/readiness

GET

/auth/login

Start login

GET

/auth/callback

Complete login

GET

/api/me

Current user

GET

/api/conversations?workspace=id

List conversations

GET

/ws?workspace=id

WebSocket connection

B. Grader-specific endpoints
These are particularly important because the automatic checker uses them.

Method

Endpoint

Purpose

POST

/__grader/reset

Clear application data

GET

/__grader/snapshot

Return application state

POST

/__grader/reply

Submit a reply

POST

/__grader/claim

Claim a conversation

All grader endpoints must verify:

x-grader-token: <GRADER_TOKEN>
Without the correct token, return HTTP 401.

The grader endpoints must use the same underlying business logic as the frontend.

Exact reply endpoint contract
Request:

{
  "workspace": "ws_acme",
  "contact": "+14155550101",
  "text": "Hello",
  "client_ref": "reply_001"
}

Expected:

Return HTTP 202 when safely stored.

Repeating the same client_ref must not create another reply.

A conversation must be created if it doesn't exist.

Exact claim endpoint contract
Request:

{
  "workspace": "ws_acme",
  "contact": "+14155550101",
  "agent": "u_ben"
}

Expected:

200 when successfully claimed.

409 when another agent already owns it.

200 when the current holder claims it again.

Create the conversation if necessary.

Recommended application endpoints
These are not fixed by the grader contract; they are a sensible API design for your UI.

Method

Endpoint

Purpose

GET

/api/conversations/:id/messages

Read messages

POST

/api/conversations/:id/reply

Send reply

POST

/api/conversations/:id/claim

Claim conversation

POST

/api/conversations/:id/close

Close

POST

/api/conversations/:id/reopen

Reopen

7. Redis usage
Redis is not just an optional performance optimization here. It is important for distributed coordination.

You have three main responsibilities.

1. Distributed rate limiting

Pigeon allows:

8 sends in the bucket.

Refills at 4 sends per second.

Limits apply per workspace, not per server instance.

If you run three backend instances, they must share one rate limiter.

Use Redis atomic operations, ideally a Lua script or equivalent atomic operation.

2. WebSocket event broadcasting

Imagine:

Agent A is connected to Server 1.

Agent B is connected to Server 2.

A customer message arrives at Server 1.

Both agents should receive the update.

Use Redis Pub/Sub or a shared event mechanism to broadcast changes between instances. Persist events in MongoDB so Pub/Sub alone is not responsible for reconnect replay.

3. Distributed job coordination

Multiple server instances must not process the same outbound job simultaneously.

Use Redis for distributed coordination if appropriate, but retain durable job state in MongoDB.

MongoDB vs Redis — remember this distinction

MongoDB
Messages

Conversations

Webhook records

Outbound jobs

Event history

Redis
Rate limiting

Pub/Sub

Distributed locks

Temporary coordination

Never make Redis Pub/Sub your only record of a message or job.

8. Potential failure scenarios
This is the most important engineering section.

The assessment deliberately simulates unreliable networks and concurrency.

Scenario

What can go wrong

Required solution

Duplicate webhook

Same message stored twice

Unique event ID and idempotency

Out-of-order webhook

Delivered arrives before sent

Monotonic status transitions

Forged webhook

Attacker injects fake message

HMAC signature verification

Old webhook

Replayed old event

Timestamp validation

Slow provider

HTTP request takes 12 seconds

Durable job and safe timeout handling

Pigeon returns 503

Agent reply never goes out

Retry with backoff

Pigeon returns 429

Requests repeatedly rejected

Respect Retry-After

Duplicate reply request

Customer receives duplicate message

Unique client_ref and idempotency

Server killed

In-memory jobs disappear

MongoDB durable queue

Two agents claim

Both believe they own conversation

Atomic database update

Multiple instances

Duplicate processing

Shared coordination and atomic state

One instance dies

Its jobs remain stuck

Lease expiry and job recovery

Browser disconnects

Missed updates

Sequence numbers and replay

Tenant access violation

Acme sees Globex data

Workspace authorization on every operation

Five particularly important implementation decisions
A. Webhook safety

Never acknowledge an event before safely persisting it.

B. Message delivery

A timeout does not necessarily mean Pigeon failed to deliver. It might have accepted the message and simply returned too late.

Never retry a send with a new idempotency key just because the first request timed out.

C. Status ordering

A delivered event can arrive before sent. Your application must never downgrade a delivered message back to sent.

D. Crash recovery

Do not store important pending work only in JavaScript arrays or variables. A kill -9 will destroy them.

E. Multi-tenant security

Every conversation, message, claim, event and WebSocket must be scoped to the correct workspace.

9. Realistic 100-minute development plan
This is how I recommend spending your actual development time.

100-minute execution roadmap
The first 10 minutes of the round are reserved for reading and starting services, as specified in the brief.

Minutes 0–10

Foundation
Read BRIEF.md and PIGEON.md.

Run npm run up.

Run npm run doctor.

Initialize Git and create the private GitHub repository.

Set up the starter scaffold.

Minutes 10–30

Highest priority
Implement Node.js server.

Implement health endpoint.

Implement Pigeon webhook.

Verify HMAC signatures.

Persist and deduplicate incoming events.

Create conversations and messages.

Send one test reply.

Run npm run check as early as possible.

Minutes 30–45

Core functionality
Implement outbound durable queue.

Implement idempotent replies.

Implement message status webhooks.

Implement atomic conversation claiming.

Handle basic retry logic.

Minutes 45–60

Authentication
Implement IdP login and callback.

Implement sessions.

Implement /api/me.

Implement workspace authorization.

Implement conversation listing.

Minutes 60–75

Real time
Implement WebSocket.

Persist workspace event sequence numbers.

Add event replay.

Use Redis broadcasting between instances.

Address shared rate limiting.

Minutes 75–90

Testing
Build or finish the minimal React inbox.

Run the relevant checker levels.

Test crashes, duplicate requests and concurrency.

Fix the highest-impact failures.

Minutes 90–100

Submission
Stop building.

Run npm run check:full if feasible.

Save the checker report.

Export AI transcripts.

Commit and push.

Make GitHub repository public.

Submit the form before the deadline.

The official START_HERE.md recommends running checks in the order 1, 5, 2, 3. Use that order when deciding which technical problems to tackle.

Important timing correction: The official instructions say to stop building at 1:50 and use the final 10 minutes for submission. The four-minute full checker should ideally be run before that point, if possible. If you cannot run it in time, follow the documented fallback of npm run check and explain the incomplete full check in DECISIONS.md.

10. Exact commands and starter-kit workflow
Your uploaded starter package already contains a scaffold, simulators and checker.

Do not waste time recreating these.

Open the extracted starter folder in VS Code.

Initial commands:

git init
git add -A
git commit -m "starter"
Start MongoDB, Redis and the simulators:

npm run up
Check services:

npm run doctor
Install the optional scaffold dependencies:

npm run scaffold:install
Start your backend:

npm run scaffold:server
In another terminal, start React:

npm run scaffold:web
Test incoming customer traffic:

npm run inbound
Stop the automatic customer message trickle:

npm run quiet
Check what Pigeon has recorded:

npm run report
Run the automatic checker:

npm run check
For the full check:

npm run check:full
Critical warning
The checker deletes application data and starts your server itself. Stop your own development server before running it. It also selects the server port through PORT, so do not hardcode port 4000.

The switchboard.json file must specify the correct installation and startup commands.

11. Submission requirements
The repository must contain these files:

File

Required

README.md

Yes

switchboard.json

Yes

DECISIONS.md

Yes

CHECK_REPORT.json

Yes, ideally from full check

ai-logs/

Yes

PROTOCOL.md

Only if attempting encrypted notes

Your DECISIONS.md must explain:

What you implemented.

What you deliberately left out.

Assumptions you made.

What you know is still incorrect.

Do not hide known bugs.

The final form requires your repository URL, exact final commit ID, name, email and AI tools used.

Keep the repository public and unchanged for 14 days.