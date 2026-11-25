'use strict';

// Paybox: a simulated payment provider. Zero dependencies, Node 20+.
// Test cards, customers, per-seat subscriptions, proration, failed renewals,
// card authentication, signed webhooks and a test clock you can move forward.
// Read PAYBOX.md for the contract. No real money, no real cards.

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4030);
const PUBLIC_URL = process.env.PAYBOX_PUBLIC_URL || 'http://localhost:' + PORT;
const TARGET = process.env.PAYBOX_TARGET_URL || 'http://localhost:4000/webhooks/paybox';
const SECRET = process.env.PAYBOX_WEBHOOK_SECRET || 'whsec_paybox_dev';
const SK = process.env.PAYBOX_SECRET_KEY || 'sk_test_paybox_51c0de';
const PK = process.env.PAYBOX_PUBLISHABLE_KEY || 'pk_test_paybox_9a7b3e';

const DAY = 86400000;
const PERIOD = 30 * DAY;
const PRICES = { price_seat_monthly: { id: 'price_seat_monthly', unit_amount: 1200, currency: 'usd', interval: '30 days', per: 'seat' } };
const CARDS = {
  '4242424242424242': { brand: 'visa', behavior: 'ok' },
  '5555555555554444': { brand: 'mastercard', behavior: 'ok' },
  '4000000000000002': { brand: 'visa', behavior: 'declined', code: 'card_declined' },
  '4000000000009995': { brand: 'visa', behavior: 'declined', code: 'insufficient_funds' },
  '4000000000000341': { brand: 'visa', behavior: 'fail_after_first' },
  '4000002500003155': { brand: 'visa', behavior: 'auth_first' },
  '4000000000000069': { brand: 'visa', behavior: 'expired' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Fields starting with an underscore are Paybox internals and never leave the server.
const clone = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k.startsWith('_') ? undefined : v)));

let S;
function reset() {
  S = {
    seq: 0,
    offset: 0,
    tokens: new Map(),
    customers: new Map(),
    subs: new Map(),
    invoices: new Map(),
    payments: new Map(),
    idem: new Map(),
    deliveries: [],
    flags: { rawCardViaSecretKey: 0, postsWithoutIdempotencyKey: 0 },
  };
}
reset();
const now = () => Date.now() + S.offset;
const unix = (ms) => Math.floor(ms / 1000);
const id = (p) => p + '_' + (++S.seq).toString(36).padStart(4, '0') + crypto.randomBytes(3).toString('hex');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// ---------------- webhooks ----------------
async function post(event, forged) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', forged ? 'not-the-secret' : SECRET).update(t + '.' + body).digest('hex');
  const rec = { eventId: event.id, type: event.type, forged: !!forged, status: 0 };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(TARGET, { method: 'POST', headers: { 'content-type': 'application/json', 'x-paybox-signature': 't=' + t + ',v1=' + mac, 'x-paybox-event-id': event.id }, body, signal: ctl.signal });
    rec.status = res.status;
    await res.arrayBuffer().catch(() => {});
  } catch (e) {
    rec.error = e.name === 'AbortError' ? 'timeout' : 'connect';
  } finally {
    clearTimeout(timer);
  }
  S.deliveries.push(rec);
  return rec;
}

// At least once, in no guaranteed order.
function emit(type, object) {
  const event = { id: id('evt'), type, created: unix(now()), data: { object: clone(object) } };
  const epoch = S;
  (async () => {
    await sleep(Math.floor(Math.random() * 800));
    for (let attempt = 1; attempt <= 3 && epoch === S; attempt++) {
      const rec = await post(event, false);
      if (rec.status >= 200 && rec.status < 300) break;
      await sleep(attempt * 1500);
    }
    if (epoch === S && Math.random() < 0.15) {
      await sleep(300 + Math.floor(Math.random() * 1500));
      await post(event, false);
    }
  })();
  return event;
}

// ---------------- domain ----------------
function view(sub) {
  const inv = S.invoices.get(sub.latest_invoice);
  return Object.assign(clone(sub), { latest_invoice: inv ? invoiceView(inv) : null });
}
function invoiceView(inv) {
  const pay = inv.payment ? S.payments.get(inv.payment) : null;
  return Object.assign(clone(inv), { payment: pay ? clone(pay) : null });
}

function charge(customer, invoice) {
  const pm = customer.payment_method;
  const pay = { id: id('pay'), object: 'payment', invoice: invoice.id, amount: invoice.amount_due, status: 'failed', created: unix(now()) };
  S.payments.set(pay.id, pay);
  invoice.payment = pay.id;
  invoice.attempt_count += 1;
  if (invoice.amount_due <= 0) pay.status = 'succeeded';
  else if (!pm) pay.error = { code: 'no_payment_method' };
  else {
    const b = pm.behavior;
    if (b === 'ok' || (b === 'fail_after_first' && pm.charges === 0) || (b === 'auth_first' && pm.authenticated)) pay.status = 'succeeded';
    else if (b === 'auth_first') {
      pay.status = 'requires_action';
      pay.next_action = { type: 'redirect_to_url', url: PUBLIC_URL + '/authenticate/' + pay.id };
    } else pay.error = { code: pm.code || 'card_declined' };
    if (pay.status === 'succeeded') pm.charges += 1;
  }
  if (pay.status === 'succeeded') {
    invoice.status = 'paid';
    invoice.paid_at = unix(now());
  }
  return pay;
}

function newInvoice(sub, amount, reason) {
  const inv = { id: id('in'), object: 'invoice', customer: sub.customer, subscription: sub.id, amount_due: amount, currency: 'usd', status: 'open', reason, attempt_count: 0, next_payment_attempt: null, created: unix(now()), payment: null };
  S.invoices.set(inv.id, inv);
  return inv;
}

function createSubscription(body) {
  const customer = S.customers.get(body.customer);
  if (!customer) throw new ApiError(400, 'no_such_customer');
  const price = PRICES[body.price];
  if (!price) throw new ApiError(400, 'no_such_price');
  if (!Number.isInteger(body.quantity) || body.quantity < 1) throw new ApiError(400, 'invalid_quantity', 'quantity must be a whole number of seats, 1 or more');
  if (!customer.payment_method) throw new ApiError(400, 'no_payment_method', 'attach a payment method to the customer first');
  const t = now();
  const sub = { id: id('sub'), object: 'subscription', customer: customer.id, price: price.id, quantity: body.quantity, status: 'incomplete', current_period_start: unix(t), current_period_end: unix(t + PERIOD), cancel_at_period_end: false, created: unix(t), metadata: body.metadata || {}, latest_invoice: null, _start: t, _end: t + PERIOD, _incompleteUntil: t + 23 * 3600000 };
  S.subs.set(sub.id, sub);
  const inv = newInvoice(sub, price.unit_amount * body.quantity, 'subscription_create');
  sub.latest_invoice = inv.id;
  const pay = charge(customer, inv);
  if (pay.status === 'succeeded') sub.status = 'active';
  emit('customer.subscription.created', view(sub));
  if (pay.status === 'succeeded') emit('invoice.paid', invoiceView(inv));
  else if (pay.status === 'requires_action') emit('invoice.payment_action_required', invoiceView(inv));
  else emit('invoice.payment_failed', invoiceView(inv));
  return view(sub);
}

function updateSubscription(sub, body) {
  const customer = S.customers.get(sub.customer);
  if (body.cancel_at_period_end !== undefined) sub.cancel_at_period_end = !!body.cancel_at_period_end;
  if (body.quantity !== undefined && body.quantity !== sub.quantity) {
    if (!['active', 'past_due'].includes(sub.status)) throw new ApiError(400, 'subscription_not_active', 'cannot change seats on a subscription that is ' + sub.status);
    if (!Number.isInteger(body.quantity) || body.quantity < 1) throw new ApiError(400, 'invalid_quantity');
    const unit = PRICES[sub.price].unit_amount;
    const remaining = Math.max(0, sub._end - now()) / (sub._end - sub._start);
    const delta = body.quantity - sub.quantity;
    if (delta > 0) {
      // Seat increases are charged now, pro rata, and are all-or-nothing.
      const inv = newInvoice(sub, Math.round(delta * unit * remaining), 'proration');
      const pay = charge(customer, inv);
      if (pay.status !== 'succeeded') {
        inv.status = 'void';
        emit('invoice.payment_failed', invoiceView(inv));
        throw new ApiError(402, (pay.error && pay.error.code) || 'payment_requires_action', 'the proration charge did not succeed; seats were not changed');
      }
      sub.latest_invoice = inv.id;
      emit('invoice.paid', invoiceView(inv));
    } else {
      // Seat decreases take effect now; the unused part becomes credit on the next invoice.
      customer.credit_balance += Math.round(-delta * unit * remaining);
    }
    sub.quantity = body.quantity;
  }
  emit('customer.subscription.updated', view(sub));
  return view(sub);
}

function cancel(sub) {
  sub.status = 'canceled';
  sub.canceled_at = unix(now());
  emit('customer.subscription.deleted', view(sub));
}

function authenticate(payId, outcome) {
  const pay = S.payments.get(payId);
  if (!pay || pay.status !== 'requires_action') throw new ApiError(400, 'payment_not_awaiting_action');
  const inv = S.invoices.get(pay.invoice);
  const sub = S.subs.get(inv.subscription);
  const customer = S.customers.get(sub.customer);
  delete pay.next_action;
  if (outcome === 'approve') {
    pay.status = 'succeeded';
    customer.payment_method.authenticated = true;
    customer.payment_method.charges += 1;
    inv.status = 'paid';
    inv.paid_at = unix(now());
    if (sub.status === 'incomplete') sub.status = 'active';
    emit('invoice.paid', invoiceView(inv));
    emit('customer.subscription.updated', view(sub));
  } else {
    pay.status = 'failed';
    pay.error = { code: 'authentication_failed' };
    emit('invoice.payment_failed', invoiceView(inv));
  }
  return clone(pay);
}

// ---------------- test clock ----------------
function dueActions() {
  const out = [];
  for (const sub of S.subs.values()) {
    if (sub.status === 'incomplete') out.push({ at: sub._incompleteUntil, run: () => { sub.status = 'incomplete_expired'; emit('customer.subscription.deleted', view(sub)); } });
    if (sub.status !== 'active' && sub.status !== 'past_due') continue;
    const open = sub._cycleInvoice ? S.invoices.get(sub._cycleInvoice) : null;
    if (open && open.status === 'open') {
      out.push({ at: open._retryAt, run: () => retry(sub, open) });
    } else {
      out.push({ at: sub._end, run: () => renew(sub) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function renew(sub) {
  if (sub.cancel_at_period_end) return cancel(sub);
  const customer = S.customers.get(sub.customer);
  const gross = PRICES[sub.price].unit_amount * sub.quantity;
  const credit = Math.min(customer.credit_balance, gross);
  customer.credit_balance -= credit;
  sub._start = sub._end;
  sub._end = sub._start + PERIOD;
  sub.current_period_start = unix(sub._start);
  sub.current_period_end = unix(sub._end);
  const inv = newInvoice(sub, gross - credit, 'subscription_cycle');
  sub.latest_invoice = inv.id;
  sub._cycleInvoice = inv.id;
  settle(sub, inv, charge(customer, inv));
}

function retry(sub, inv) {
  settle(sub, inv, charge(S.customers.get(sub.customer), inv));
}

// Failed renewals are retried 3 and 5 days after the first failure, then the subscription is canceled.
function settle(sub, inv, pay) {
  if (pay.status === 'succeeded') {
    inv.next_payment_attempt = null;
    sub.status = 'active';
    emit('invoice.paid', invoiceView(inv));
    emit('customer.subscription.updated', view(sub));
    return;
  }
  if (inv.attempt_count >= 3) {
    inv.status = 'uncollectible';
    inv.next_payment_attempt = null;
    emit('invoice.payment_failed', invoiceView(inv));
    return cancel(sub);
  }
  inv._retryAt = now() + (inv.attempt_count === 1 ? 3 : 2) * DAY;
  inv.next_payment_attempt = unix(inv._retryAt);
  const was = sub.status;
  sub.status = 'past_due';
  emit('invoice.payment_failed', invoiceView(inv));
  if (was !== 'past_due') emit('customer.subscription.updated', view(sub));
}

function advance(ms) {
  const target = now() + ms;
  const realNow = Date.now();
  for (let guard = 0; guard < 500; guard++) {
    const next = dueActions()[0];
    if (!next || next.at > target) break;
    S.offset = Math.max(S.offset, next.at - realNow);
    next.run();
  }
  S.offset = target - realNow;
}

// ---------------- report ----------------
function report() {
  const customers = Array.from(S.customers.values()).map((c) => ({
    id: c.id,
    workspace: (c.metadata && c.metadata.workspace) || null,
    credit_balance: c.credit_balance,
    card: c.payment_method ? c.payment_method.last4 : null,
    subscriptions: Array.from(S.subs.values()).filter((s) => s.customer === c.id).map((s) => ({
      id: s.id,
      status: s.status,
      quantity: s.quantity,
      cancel_at_period_end: s.cancel_at_period_end,
      current_period_end: s.current_period_end,
      invoices: Array.from(S.invoices.values()).filter((i) => i.subscription === s.id).map((i) => ({ id: i.id, reason: i.reason, amount_due: i.amount_due, status: i.status, attempts: i.attempt_count })),
    })),
  }));
  const real = S.deliveries.filter((d) => !d.forged);
  const forged = S.deliveries.filter((d) => d.forged);
  const ok = (d) => d.status >= 200 && d.status < 300;
  return {
    clock: new Date(now()).toISOString(),
    customers,
    flags: S.flags,
    webhooks: { sent: real.length, acked: real.filter(ok).length, forgedSent: forged.length, forgedAccepted: forged.filter(ok).length },
  };
}

// ---------------- http ----------------
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        resolve(null);
      }
    });
  });
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, idempotency-key', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS' };

async function route(req, path, body, key) {
  const m = (re) => path.match(re);
  const secret = () => {
    if (key !== SK) throw new ApiError(401, 'secret_key_required', 'this endpoint needs the secret key and must be called from your server');
  };
  let x;

  if (req.method === 'GET' && path === '/healthz') return [200, { ok: true, target: TARGET, clock: new Date(now()).toISOString() }];
  if (req.method === 'GET' && path === '/v1/prices') return [200, { data: Object.values(PRICES) }];

  if (req.method === 'POST' && path === '/v1/tokens') {
    if (key !== PK && key !== SK) throw new ApiError(401, 'invalid_api_key');
    if (key === SK) S.flags.rawCardViaSecretKey += 1; // a card number passed through somebody's server
    const card = body.card || {};
    const number = String(card.number || '').replace(/\s+/g, '');
    const known = CARDS[number];
    if (!known) throw new ApiError(402, 'invalid_number', 'not a Paybox test card; see PAYBOX.md');
    if (!/^\d{3,4}$/.test(String(card.cvc || ''))) throw new ApiError(402, 'invalid_cvc');
    const exp = new Date(Date.UTC(Number(card.exp_year), Number(card.exp_month), 1));
    if (known.behavior === 'expired' || !(exp.getTime() > now())) throw new ApiError(402, 'expired_card');
    const tok = { id: id('tok'), object: 'token', used: false, card: { brand: known.brand, last4: number.slice(-4), exp_month: Number(card.exp_month), exp_year: Number(card.exp_year) }, _number: number };
    S.tokens.set(tok.id, tok);
    return [200, { id: tok.id, object: 'token', card: tok.card }];
  }

  if (req.method === 'POST' && path === '/v1/customers') {
    secret();
    const c = { id: id('cus'), object: 'customer', name: body.name || null, email: body.email || null, metadata: body.metadata || {}, credit_balance: 0, payment_method: null, created: unix(now()) };
    S.customers.set(c.id, c);
    return [200, customerView(c)];
  }
  if ((x = m(/^\/v1\/customers\/(\w+)$/)) && req.method === 'GET') {
    secret();
    const c = S.customers.get(x[1]);
    if (!c) throw new ApiError(404, 'no_such_customer');
    return [200, customerView(c)];
  }
  if ((x = m(/^\/v1\/customers\/(\w+)\/payment_method$/)) && req.method === 'POST') {
    secret();
    const c = S.customers.get(x[1]);
    if (!c) throw new ApiError(404, 'no_such_customer');
    const tok = S.tokens.get(body.token);
    if (!tok) throw new ApiError(400, 'no_such_token');
    if (tok.used) throw new ApiError(400, 'token_already_used', 'a token can be used once');
    tok.used = true;
    const known = CARDS[tok._number];
    c.payment_method = { id: id('pm'), brand: tok.card.brand, last4: tok.card.last4, exp_month: tok.card.exp_month, exp_year: tok.card.exp_year, behavior: known.behavior, code: known.code, charges: 0, authenticated: false };
    return [200, customerView(c)];
  }

  if (req.method === 'POST' && path === '/v1/subscriptions') {
    secret();
    return [200, createSubscription(body)];
  }
  if (req.method === 'GET' && path === '/v1/subscriptions') {
    secret();
    const q = new URL(req.url, PUBLIC_URL).searchParams.get('customer');
    return [200, { data: Array.from(S.subs.values()).filter((s) => !q || s.customer === q).map(view) }];
  }
  if ((x = m(/^\/v1\/subscriptions\/(\w+)$/))) {
    secret();
    const sub = S.subs.get(x[1]);
    if (!sub) throw new ApiError(404, 'no_such_subscription');
    if (req.method === 'GET') return [200, view(sub)];
    if (req.method === 'POST') return [200, updateSubscription(sub, body)];
    if (req.method === 'DELETE') {
      if (sub.status !== 'canceled') cancel(sub);
      return [200, view(sub)];
    }
  }
  if (req.method === 'GET' && path === '/v1/invoices') {
    secret();
    const q = new URL(req.url, PUBLIC_URL).searchParams.get('subscription');
    return [200, { data: Array.from(S.invoices.values()).filter((i) => !q || i.subscription === q).map(invoiceView) }];
  }

  if (path === '/v1/test_clock' && req.method === 'GET') return [200, { now: new Date(now()).toISOString() }];
  if (path === '/v1/test_clock/advance' && req.method === 'POST') {
    const ms = (Number(body.days) || 0) * DAY + (Number(body.hours) || 0) * 3600000;
    if (!(ms > 0)) throw new ApiError(400, 'invalid_advance', 'send { "days": n } or { "hours": n }');
    advance(ms);
    return [200, { now: new Date(now()).toISOString() }];
  }

  if ((x = m(/^\/authenticate\/(\w+)$/))) {
    if (req.method === 'POST') return [200, authenticate(x[1], body.outcome === 'fail' ? 'fail' : 'approve')];
    const page = '<!doctype html><meta charset="utf-8"><title>Paybox</title><body style="font:16px system-ui;max-width:420px;margin:80px auto;text-align:center"><h2>Your bank</h2><p>Approve this payment?</p>' +
      ['approve', 'fail'].map((o) => '<button style="font-size:16px;padding:10px 22px;margin:6px" onclick="fetch(location.pathname,{method:\'POST\',headers:{\'content-type\':\'application/json\'},body:JSON.stringify({outcome:\'' + o + '\'})}).then(function(){document.body.innerHTML=\'<p>Done. You can close this tab.</p>\'})">' + (o === 'approve' ? 'Approve' : 'Decline') + '</button>').join('') + '</body>';
    return [200, page, { 'content-type': 'text/html; charset=utf-8' }];
  }

  if (req.method === 'POST' && path === '/__admin/reset') {
    reset();
    return [200, { ok: true }];
  }
  if (req.method === 'GET' && path === '/__admin/report') return [200, report()];
  if (req.method === 'POST' && path === '/__admin/forge') {
    // An attacker posts a webhook claiming a subscription is paid and active.
    const sub = Array.from(S.subs.values()).reverse().find((s) => (S.customers.get(s.customer).metadata || {}).workspace === body.workspace);
    if (!sub) throw new ApiError(400, 'no_subscription_for_workspace');
    const fake = Object.assign(view(sub), { status: 'active' });
    const rec = await post({ id: id('evt'), type: body.type || 'customer.subscription.updated', created: unix(now()), data: { object: fake } }, true);
    return [200, { delivered: rec.status }];
  }
  throw new ApiError(404, 'not_found');
}

function customerView(c) {
  const out = clone(c);
  if (out.payment_method) out.payment_method = { id: c.payment_method.id, brand: c.payment_method.brand, last4: c.payment_method.last4, exp_month: c.payment_method.exp_month, exp_year: c.payment_method.exp_year };
  return out;
}

http
  .createServer(async (req, res) => {
    const send = (status, body, headers) => {
      const isText = typeof body === 'string';
      res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, CORS, headers || {}));
      res.end(isText ? body : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204, {});
    const path = req.url.split('?')[0];
    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const body = req.method === 'POST' ? await readJson(req) : {};
    if (body === null) return send(400, { error: { code: 'bad_json' } });
    const idemKey = req.headers['idempotency-key'];
    const tracked = req.method === 'POST' && key === SK && /^\/v1\/(customers|subscriptions)/.test(path);
    const slot = tracked && idemKey ? req.method + ' ' + path + ' ' + idemKey : null;
    try {
      if (slot && S.idem.has(slot)) {
        const [status, saved] = await S.idem.get(slot);
        return send(status, saved);
      }
      if (tracked && !idemKey) S.flags.postsWithoutIdempotencyKey += 1;
      const work = route(req, path, body, key).catch((err) => {
        if (!(err instanceof ApiError)) throw err;
        return [err.status, { error: { code: err.code, message: err.message } }];
      });
      if (slot) S.idem.set(slot, work);
      const [status, out, headers] = await work;
      send(status, out, headers);
    } catch (err) {
      send(500, { error: { code: 'internal', message: String(err && err.message) } });
    }
  })
  .listen(PORT, () => console.log('paybox listening on :' + PORT + '  webhooks -> ' + TARGET));
