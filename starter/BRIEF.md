# Switchboard — build round

Build the first version of **Switchboard**, a shared team inbox. Customers
write to a business over a messaging provider. Support agents (people who work
at that business) log in, see conversations arrive in real time, reply, and
leave private notes for each other.

Several businesses (workspaces) use the same deployment. They must never see
each other's data.

**You will not finish everything below.** That is intended. Build the product
first, then make it survive: a small product that keeps working when the
network is bad, the process dies or a second copy is started beats a large one
that works only on the happy path.

Use any AI tools you like. You own every line you submit: in the follow-up
call we open your code, ask why it is the way it is, and debug it with you.

## The two hours

| Time | What |
| --- | --- |
| 0:00 – 0:10 | Read `START_HERE.md` and this brief. Start the services. |
| 0:10 – 1:50 | Build. Commit at least every 15 minutes. |
| 1:50 – 2:00 | Run the full check, push, make the repository public, send the form. See `SUBMISSION.md`. |

The form closes at 2:00. What counts is the commit you name in the form.

## How it fits together

```
simulated customers -> Pigeon :4010 --webhook POST--> YOUR SERVER --WebSocket--> YOUR REACT APP
        (given)          (given)                      (you build)                 (you build)

agent types a reply -> YOUR SERVER -> POST /v1/messages on Pigeon -> status webhooks back to you
```

You build the business side only. The customers are simulated and live inside
Pigeon; there is no customer app, and they do not answer your replies.

| Service | Port | What it is |
| --- | --- | --- |
| Pigeon | 4010 | The messaging provider (simulated). Sends you webhooks, accepts your sends. Unreliable on purpose. See `PIGEON.md`. |
| Mock IdP | 4020 | OpenID Connect provider with five test users. Discovery at `/.well-known/openid-configuration`. Client id `switchboard-web`. PKCE (S256) is required. |
| MongoDB | 27017 | Real. |
| Redis | 6379 | Real. |
| Elasticsearch | 9200 | Real, optional: `npm run up:search`. |
| Paybox | 4030 | Simulated payment provider. Only for the bonus. See `PAYBOX.md`. |

`scaffold/` is an optional empty shell (Express + TypeScript server, Vite +
React app, already pointed at the services). It has no product code. Use it,
or delete it and bring your own Node stack; then change the `start` command in
`switchboard.json`.

## What to build

### The product
1. **Login.** Sign in through the IdP (authorization code + PKCE). A user's
   workspaces and roles come from the `workspaces` claim. Roles: `admin`, `agent`.
2. **Receive messages.** Accept Pigeon webhooks at `POST /webhooks/pigeon`.
   Pigeon is not a friendly network: read `PIGEON.md` before you write this.
3. **Inbox.** Conversations per contact, newest activity first, paginated.
   Open a conversation and read its messages in order. An agent can claim a
   conversation; two agents cannot both hold it. Close and reopen.
4. **Reply.** An agent replies and the message goes out through Pigeon. The
   agent sees its status: queued, sent, delivered, failed. A customer must
   never receive the same reply twice, and a reply must not be lost.
5. **Real time.** New messages, status changes and assignments appear without
   a refresh (WebSockets). A client that drops and reconnects misses nothing.
6. **Frontend.** A React app an agent could actually use for the above.

### Making it survive: the five levels
The automatic check has five levels. Each is worth points on its own. You can
run all of them yourself except level 4.

| Level | Situation | Points |
| --- | --- | --- |
| 1 | One copy of your server. Webhooks arrive duplicated, out of order, forged and replayed. Pigeon rate-limits you, answers slowly, and goes down for a while. Six agents claim one conversation in the same instant. | 24 |
| 2 | Your server is **killed without warning** (`kill -9`) and started again a few seconds later: once in the middle of a flood of webhooks, once just after it accepted a batch of replies. Nothing may be lost, duplicated or sent twice. | 14 |
| 3 | **Several copies** of your server run behind a load balancer and share MongoDB and Redis. Everything in level 1 must still hold, the rate limit is per workspace and not per copy, and when one copy dies for good the others finish its work within 60 seconds. | 22 |
| 4 | **The written rules.** Not in the check you can run. We send your server the awkward cases that `PIGEON.md` ("How your endpoint must answer") and the contract below describe in words. Ten rules, one point each. | 10 |
| 5 | **Login, tenant isolation and real time**, with several copies running. The check signs in through the IdP as a browser would, calls your API as a user of one workspace, and listens on your WebSocket while customers write. | 15 |

### Also valued (reviewed, not checked automatically)
- **Private notes, end-to-end encrypted.** Agents leave a note on a
  conversation for other agents in the workspace. The server stores it but
  must not be able to read it. Write `PROTOCOL.md`: who holds which key, what
  the server stores, and three attacks your scheme does **not** stop.
- **Tests** for the two or three pieces of logic most likely to be wrong.
- **Search** over messages with Elasticsearch, limited to the user's workspace.
- **Bonus: billing.** Per-seat subscriptions through Paybox. Scored separately
  (10 bonus points). See `BONUS_BILLING.md`. Last, if at all.

## The contract the check relies on

Keep these exactly as written. Everything else about your API is yours.

**A. `switchboard.json`** in the repository root holds the command that starts
your server from a clean clone after `install`. The check runs it itself.

```json
{ "install": "npm run scaffold:install", "start": "npm --prefix scaffold/server start", "health": "/healthz" }
```

**B. Configuration comes from the environment.** Your server listens on the
port in `PORT` and reads every URL and secret from the variables in
`.env.example`. Hard-coded ports or URLs will fail the check. The health path
answers `200` once the server is ready for traffic, and the check waits for that.

**C. Webhook path:** `POST /webhooks/pigeon`.

**D. Check endpoints**, protected by header `x-grader-token` equal to the env
var `GRADER_TOKEN`; without it, or with a wrong one, they answer `401`. They must go through the same code paths your UI uses.

| Endpoint | What it does |
| --- | --- |
| `POST /__grader/reset` | Delete all application data, in MongoDB and Redis (login sessions may stay). Answer `200`. |
| `GET /__grader/snapshot` | Return what your system currently believes (shape below). |
| `POST /__grader/reply` `{ workspace, contact, text, client_ref }` | Send a reply to that contact as if an agent typed it, using the given `client_ref` with Pigeon. The contact may not have written yet: the reply still goes out and a conversation now exists. Answer `202` once it is safely stored. The same `client_ref` asked twice, even at the same instant, is one reply and both requests get `202`. A workspace that does not exist is a `4xx`. |
| `POST /__grader/claim` `{ workspace, contact, agent }` | Agent claims that contact's conversation. `200` if this agent now holds it, `409` if someone else does. The holder claiming again gets `200`. If the contact has not written yet, the claim creates the conversation. `agent` is an opaque id; do not look it up in the IdP. |

**E. Login and API**, used by level 5 and by your own frontend.

| Endpoint | What it does |
| --- | --- |
| `GET /auth/login` | Redirects the browser to the IdP (authorization code + PKCE). |
| `GET /auth/callback` | Finishes the login and sets a session cookie. |
| `GET /api/me` | `200 { "sub": "u_ben", "workspaces": [{ "id": "ws_acme", "role": "agent" }] }` with a session, `401` without. |
| `GET /api/conversations?workspace=<id>` | The inbox list, in any shape you like. `200` for a member of that workspace, `403` for a signed-in user who is not a member, `401` without a session. |

**F. WebSocket:** `GET /ws?workspace=<id>`, authenticated by the same session
cookie. Refuse the upgrade without a session, or for a workspace the user is
not a member of. Send JSON text frames. Every frame that reports a change
carries `seq`, an integer that only goes up within a workspace:

```json
{ "seq": 41, "type": "message.inbound", "contact": "+14155550101", "message_id": "pmsg_00001ab12" }
{ "seq": 42, "type": "message.status", "contact": "+14155550101", "client_ref": "<ref>", "status": "delivered" }
{ "seq": 43, "type": "conversation.assigned", "contact": "+14155550101", "assignee": "u_ben" }
```

Add any other fields you need. `GET /ws?workspace=<id>&after=41` first sends
every frame after 41 that the client missed, then continues live. With several
copies running, a browser connected to one copy must receive what another
copy processed.

The snapshot shape:

```json
{
  "workspaces": {
    "ws_acme": {
      "contacts": {
        "+14155550101": { "inbound": ["pmsg_00001ab12", "pmsg_00007cd34"], "assignee": "u_ben" }
      },
      "outbound": { "<client_ref>": "delivered" }
    }
  }
}
```

`inbound` is the list of Pigeon `message_id`s for that contact, in the order
your UI shows them, oldest first. `assignee` is who holds the conversation, or
`null`. `outbound` maps the `client_ref` of each message you sent to its
current status.

## Checking yourself

The check is the same program we run on your final commit. We run it with
larger numbers, three copies, different timing, and level 4 added. Reading
`harness/check.js` is allowed and sensible.
Do the levels in the order 1, 5, 2, 3: a product people can log in to comes
before one that survives a crash.

```
npm run check         # level 1 only, about 90 seconds
npm run check:full    # levels 1, 2, 3 and 5, about 4 minutes, writes CHECK_REPORT.json
npm run check -- --levels 5     # one level on its own (or several: --levels 1,5)
```

Stop your own dev server first: the check starts your server itself (from
`switchboard.json`) behind a small load balancer on port 4000. **It deletes
your application data.** Server output goes to `.check-logs/`.

## How you are scored

| | Points |
| --- | --- |
| The check: levels 1 to 5 | 24 + 14 + 22 + 10 + 15 = **85** |
| Security beyond the check: sessions, secrets, encrypted notes if attempted | 4 |
| Data model, structure, code quality and tests | 5 |
| The frontend, and what you chose to build and cut | 3 |
| How you worked with AI (from `ai-logs/`) | 3 |

A submission whose check cannot start scores 0 of 85, so keep
`npm run check` working from your first hour on.

## What the repository must contain

- The code, with history.
- `README.md`: how to run it from a clean clone.
- `switchboard.json`: correct `install` and `start` commands.
- `DECISIONS.md`, half a page: what you built, what you cut and why, what you
  assumed where this brief is silent, and **what you know is still wrong**.
  An honest "level 3 loses replies when a copy dies; I think it is the lock"
  is worth more than silence.
- `CHECK_REPORT.json`: written by your last `npm run check:full`.
- `ai-logs/`: exported transcripts of every AI session you used. Required:
  without them the AI part scores 0 and your submission goes to manual review.
- `PROTOCOL.md`, only if you attempted encrypted notes.

This brief leaves several things unsaid. When you hit one, decide, write the
decision in `DECISIONS.md`, and move on. Questions go in the question channel;
answers go to everyone.
