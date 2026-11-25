# Pigeon — provider contract

Base URL `http://localhost:4010`. Workspaces and API keys:

| Workspace | API key |
| --- | --- |
| `ws_acme` | `pk_acme_7d1f0a` |
| `ws_globex` | `pk_globex_c93b22` |

Webhook signing secret: `whsec_pigeon_dev`.

## Who is on the other end

Nobody real. Pigeon contains twelve simulated customers, six per workspace,
and a small set of canned texts. It picks one and posts it to you as if that
person had just written to the business. There is no customer app to build.
Customers do not answer your replies; they write on their own schedule.
Nothing you send goes anywhere: Pigeon records it and reports a status.

| Workspace | Simulated customers |
| --- | --- |
| `ws_acme` | +14155550101, +14155550102, +14155550103, +12125550104, +12125550105, +13035550106 |
| `ws_globex` | +442079460201, +442079460202, +442079460203, +4930901820204, +34600111205, +34600111206 |

## Webhooks Pigeon sends you

`POST <your url>` (default `http://localhost:4000/webhooks/pigeon`)

Headers:

- `x-pigeon-signature: t=<unix seconds>,v1=<hex>` where `v1` is
  HMAC-SHA256 of `"<t>.<raw request body>"` with the signing secret.
- `x-pigeon-event-id: <event id>`

Body, a contact wrote in:

```json
{ "id": "evt_...", "type": "message.inbound", "workspace": "ws_acme",
  "occurred_at": "2026-11-18T09:30:00.123Z",
  "data": { "message_id": "pmsg_...", "from": "+14155550101", "text": "Hi" } }
```

Body, status of a message you sent:

```json
{ "id": "evt_...", "type": "message.status", "workspace": "ws_acme",
  "occurred_at": "2026-11-18T09:30:02.456Z",
  "data": { "message_id": "pm_...", "client_ref": "<yours>", "status": "sent" } }
```

`status` is `sent`, then `delivered` or `failed`.

What Pigeon promises, and what it does not:

- **At least once.** The same event can arrive several times.
- **No ordering.** Events can arrive in a different order than `occurred_at`.
  `delivered` can arrive before `sent`.
- **Retries.** If you do not answer `2xx` within 5 seconds, Pigeon sends the
  event again: six attempts in all, spread over about 22 seconds. After that
  it is gone. A server that is down for a few seconds therefore loses nothing,
  provided it never answers `2xx` for an event it has not safely stored.
- **Bursts.** Dozens of events in under a second happen.
- **The URL is public.** Anyone can post to it. Pigeon expects you to reject
  requests that are not genuinely from Pigeon, and requests whose timestamp is
  more than five minutes old, with `401`.

### How your endpoint must answer

| Request | Your answer |
| --- | --- |
| Signature missing, malformed, or not matching the raw body | `401`. Never a `5xx`. |
| Signature valid, timestamp more than five minutes old | `401` |
| Signature valid, timestamp up to five minutes old | Genuine. Slow networks exist. |
| Valid event, stored safely (or already stored earlier) | `2xx`, within 5 seconds |
| Valid signature, an event `type` you do not know | `2xx`. Pigeon adds event types without notice, and anything else makes it retry. |
| Valid signature, a status for a message you never sent | `2xx`, and ignore it |
| Valid signature, a body you cannot parse | `400`. Never a `5xx`. |
| Valid signature, a `workspace` you do not know | `2xx`, and ignore it |

## Sending a message

`POST /v1/messages` with `Authorization: Bearer <api key>`

```json
{ "to": "+14155550101", "text": "Hello", "client_ref": "<your id for this message>" }
```

`200 { "id": "pm_...", "status": "accepted" }`

- `Idempotency-Key` header: a repeated key returns the original response and
  does not send again.
- The limit is per workspace: a bucket of 8 sends that refills at 4 a second.
  Beyond it you get `429` with `Retry-After: <seconds>`. Requests sent before that time has
  passed are rejected and counted against you.
- `503` now and then.
- Sometimes Pigeon accepts and delivers a message but its HTTP response takes
  12 seconds. Your client will probably have given up by then.
- Now and then Pigeon is down altogether for a while: every send gets `503`
  until it recovers. A reply an agent sent in that window must still go out.

## While developing

```
# make a contact write to you now
curl -X POST localhost:4010/v1/simulate/inbound -H 'content-type: application/json' \
  -d '{"workspace":"ws_acme","from":"+14155550101","text":"hello"}'

# force a failure on a send: timeout | 503 | 429
curl -X POST localhost:4010/v1/messages -H 'authorization: Bearer pk_acme_7d1f0a' \
  -H 'x-pigeon-force: timeout' -H 'content-type: application/json' \
  -d '{"to":"+14155550101","text":"hi","client_ref":"m1"}'

# run the traffic profile the check uses
curl -X POST localhost:4010/__admin/start -H 'content-type: application/json' -d '{"profile":"chaos"}'

# what Pigeon saw
curl localhost:4010/__admin/report

# take the send API down for 15 seconds
curl -X POST localhost:4010/__admin/outage -H 'content-type: application/json' -d '{"seconds":15}'
```

The same things as npm scripts: `npm run inbound`, `npm run chaos`, `npm run report`.

By default Pigeon also sends one message every 4 to 8 seconds ("drizzle") so
your inbox is never empty. `npm run quiet` stops that and `npm run drizzle`
turns it back on.
