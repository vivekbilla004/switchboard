# Bonus track: billing

Only start this when `npm run check:full` is where you want it. It is scored
separately (10 bonus points) and never makes up for a Must tier that fails.

## The problem

Switchboard is sold per seat, per month. Build that on Paybox (`PAYBOX.md`).

1. A workspace **admin** subscribes the workspace: picks a number of seats,
   enters a card, pays. Agents cannot see or change billing.
2. Card details are entered in your UI and never touch your server.
3. The admin can change the number of seats later.
4. The app always knows the workspace's subscription state, including when it
   changes without anyone clicking anything: a renewal fails, the bank asks
   for approval, Paybox cancels after its retries run out.
5. A workspace whose subscription is **canceled** cannot send messages. It
   can still read its inbox. A workspace that has **never subscribed** is on a
   free trial and can send.
6. The admin sees the current state in plain words and what to do about it.

## Contract additions for the grader

Create the Paybox customer with `metadata.workspace` set to the workspace id.
Accept Paybox webhooks at `POST /webhooks/paybox`.

| Endpoint | What it does |
| --- | --- |
| `POST /__grader/billing/subscribe` `{ workspace, seats, token }` | What your UI does when the admin submits the form, with a card token already made. `200` if the subscription is active, `402` if it is not. |
| `POST /__grader/billing/seats` `{ workspace, seats }` | Change the seat count. `200` if changed, `402` if not. |

Add to each workspace in `GET /__grader/snapshot`:

```json
"billing": { "status": "active", "seats": 3, "can_send": true }
```

`status` is `none`, `incomplete`, `active`, `past_due` or `canceled`.
When `can_send` is false, `POST /__grader/reply` for that workspace must
answer `402` and must not send.

## What the grader does

Subscribes a workspace three times in the same instant. Changes seats. Pays
for a second workspace with a card that only works once, then moves the clock
past the renewal and past the retries. Posts a forged webhook. Checks that the
canceled workspace cannot send and the paying one still can. Reads Paybox's
own record of how you called it.

## Left for you to decide (write it in DECISIONS.md)

What a `past_due` workspace is allowed to do, and for how long. What happens
to agents when seats are reduced below the number of people in the workspace.
Whether an admin who removes seats mid-month should be told about the credit.
What the UI shows while a payment is waiting for the bank.
