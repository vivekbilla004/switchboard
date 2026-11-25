# Paybox — payment provider contract

Base URL `http://localhost:4030`. Only needed for the bonus track.

| Key | Value | Use it from |
| --- | --- | --- |
| Publishable | `pk_test_paybox_9a7b3e` | The browser. Can only create card tokens. |
| Secret | `sk_test_paybox_51c0de` | Your server only. Everything else. |
| Webhook signing secret | `whsec_paybox_dev` | Your server only. |

Send keys as `Authorization: Bearer <key>`. Bodies are JSON. Amounts are in
cents. The one price is `price_seat_monthly`: **1200 per seat per 30 days**.

## Test cards

Any future expiry, any three-digit CVC.

| Number | Behaviour |
| --- | --- |
| `4242 4242 4242 4242` | Always succeeds. |
| `5555 5555 5555 4444` | Always succeeds. |
| `4000 0000 0000 0002` | Every charge is declined (`card_declined`). |
| `4000 0000 0000 9995` | Every charge is declined (`insufficient_funds`). |
| `4000 0000 0000 0341` | First charge succeeds. Every later charge is declined. |
| `4000 0025 0000 3155` | First charge needs the cardholder to approve it at their bank. |
| `4000 0000 0000 0069` | Expired. Rejected when you create the token. |

## The flow

1. **Browser → Paybox:** `POST /v1/tokens` with the publishable key and
   `{ "card": { "number", "exp_month", "exp_year", "cvc" } }`. You get
   `{ "id": "tok_..." }`. A token works once. Paybox counts every card number
   that reaches it through a secret key, because that means the number passed
   through somebody's server.
2. **Server → Paybox:** `POST /v1/customers` `{ name, email, metadata }`.
   Set `metadata.workspace` to the workspace id; it is how Paybox reports
   refer to your customer.
3. `POST /v1/customers/:id/payment_method` `{ token }`.
4. `POST /v1/subscriptions` `{ customer, price, quantity }`.

`POST /v1/subscriptions/:id` `{ quantity }` changes seats.
`POST /v1/subscriptions/:id` `{ cancel_at_period_end: true }` cancels at the
end of the period. `DELETE /v1/subscriptions/:id` cancels now.
`GET /v1/subscriptions/:id`, `GET /v1/subscriptions?customer=`,
`GET /v1/invoices?subscription=`, `GET /v1/customers/:id` read state.

## Things that will catch you out

- **HTTP 200 means Paybox understood you, not that money moved.** Creating a
  subscription with a declining card returns `200` and a subscription whose
  `status` is `incomplete`. Read `status` and `latest_invoice.payment.status`.
- **Subscription status:** `incomplete` (first payment not made yet; expires
  after 23 hours) → `active` → `past_due` (a renewal failed and is being
  retried) → `canceled`. A renewal that fails is retried 3 days and 5 days
  later; after the third failure Paybox cancels the subscription.
- **Authentication.** With the `3155` card the first payment comes back
  `requires_action` with `next_action.url`. Send the user's browser there;
  they approve or decline. You find out the result by webhook, not from that
  page.
- **Seat increases** are charged immediately, pro rata for the rest of the
  period, and are all-or-nothing: if that charge fails you get `402` and the
  seat count does not change. **Seat decreases** take effect immediately and
  the unused amount becomes credit on the next invoice. No refunds.
- **Idempotency-Key** header on `POST`: the same key returns the original
  response and does nothing twice. Without one, a retry creates a second
  customer or a second subscription.

## Webhooks Paybox sends you

`POST http://localhost:4000/webhooks/paybox`, signed exactly like Pigeon:
`x-paybox-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.

```json
{ "id": "evt_...", "type": "invoice.payment_failed", "created": 1795000000,
  "data": { "object": { "...": "the subscription or invoice as it was when the event was created" } } }
```

Types: `customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`,
`invoice.payment_action_required`.

Delivery is at least once and in no particular order. `invoice.paid` can
arrive before `customer.subscription.created`. The object inside an event is a
photograph of the past; `GET /v1/subscriptions/:id` is the present.
The URL is public: anyone can post a fake "payment succeeded" to it.

## The test clock

Nothing renews while you wait, so move time yourself:

```
curl -X POST localhost:4030/v1/test_clock/advance -H 'content-type: application/json' -d '{"days": 31}'
curl localhost:4030/v1/test_clock
```

Advancing runs every renewal, retry and expiry that falls due, in order, and
sends the webhooks. `curl localhost:4030/__admin/report` shows every customer,
subscription and invoice Paybox holds, and what it noticed about your calls.
`curl -X POST localhost:4030/__admin/reset` wipes Paybox.
