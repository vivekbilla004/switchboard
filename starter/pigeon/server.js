'use strict';

// Pigeon: a simulated messaging provider. Zero dependencies, Node 20+.
//
// It does two things, like a real provider:
//   1. Sends webhooks to YOUR app when a contact writes in, and when the
//      status of a message you sent changes.
//   2. Exposes POST /v1/messages for you to send a message to a contact.
//
// It is deliberately unreliable. Read PIGEON.md for the full contract.

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4010);
const TARGET = process.env.PIGEON_TARGET_URL || 'http://localhost:4000/webhooks/pigeon';
const SECRET = process.env.PIGEON_WEBHOOK_SECRET || 'whsec_pigeon_dev';
const DRIZZLE = process.env.PIGEON_DRIZZLE !== '0';

const WORKSPACES = {
  ws_acme: { key: 'pk_acme_7d1f0a', contacts: ['+14155550101', '+14155550102', '+14155550103', '+12125550104', '+12125550105', '+13035550106'] },
  ws_globex: { key: 'pk_globex_c93b22', contacts: ['+442079460201', '+442079460202', '+442079460203', '+4930901820204', '+34600111205', '+34600111206'] },
};
const TEXTS = ['Hi, is anyone there?', 'Can I change my booking?', 'What time do you open?', 'Thanks!', 'Please call me back', 'How much is it?', 'Still waiting for an answer', 'Ok, see you tomorrow', '¿Hablan español?', 'Great, thank you 🙏'];

let seedState = Number(process.env.PIGEON_SEED || Date.now() % 2147483647);
function rnd() {
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- state ----------------
let S;
function reset() {
  S = {
    seq: 0,
    inbound: [], // truth: every genuine inbound message
    deliveries: [], // every webhook attempt we made
    requests: [], // every POST /v1/messages we received
    accepted: [], // every message handed to the "carrier"
    byKey: new Map(),
    buckets: {},
    coolOff: {},
    ignoredRetryAfter: 0,
    scenario: null,
  };
}
reset();
const nextId = (p) => p + '_' + (++S.seq).toString(36).padStart(5, '0') + crypto.randomBytes(2).toString('hex');

// ---------------- webhooks out ----------------
async function post(event, kind) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000) - (kind === 'stale' ? 3600 : 0);
  const mac = crypto.createHmac('sha256', kind === 'forged' ? 'not-the-secret' : SECRET).update(t + '.' + body).digest('hex');
  const started = Date.now();
  const rec = { eventId: event.id, type: event.type, kind, at: started, status: 0, ms: 0 };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(TARGET, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pigeon-signature': 't=' + t + ',v1=' + mac, 'x-pigeon-event-id': event.id },
      body,
      signal: ctl.signal,
    });
    rec.status = res.status;
    await res.arrayBuffer().catch(() => {});
  } catch (e) {
    rec.status = 0;
    rec.error = e.name === 'AbortError' ? 'timeout' : 'connect';
  } finally {
    clearTimeout(timer);
  }
  rec.ms = Date.now() - started;
  S.deliveries.push(rec);
  return rec;
}

// At-least-once: retry genuine events until a 2xx. Six attempts, waiting
// 1.5 s, 3 s, 4.5 s, 6 s and 7.5 s between them: about 22 seconds in all.
async function deliver(event, opts) {
  const o = opts || {};
  const epoch = S;
  if (o.delay) await sleep(o.delay);
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (epoch !== S) return;
    const rec = await post(event, attempt === 1 ? 'first' : 'retry');
    if (rec.status >= 200 && rec.status < 300) break;
    await sleep(attempt * 1500);
  }
  if (o.duplicate) {
    await sleep(between(200, 3000));
    if (epoch === S) await post(event, 'duplicate');
  }
}

function inboundEvent(workspace, from, text, occurredAt) {
  const ev = {
    id: nextId('evt'),
    type: 'message.inbound',
    workspace,
    occurred_at: new Date(occurredAt).toISOString(),
    data: { message_id: nextId('pmsg'), from, text },
  };
  S.inbound.push({ workspace, from, messageId: ev.data.message_id, occurredAt, eventId: ev.id });
  return ev;
}

function statusEvent(msg, status) {
  return {
    id: nextId('evt'),
    type: 'message.status',
    workspace: msg.workspace,
    occurred_at: new Date().toISOString(),
    data: { message_id: msg.id, client_ref: msg.clientRef, status },
  };
}

// ---------------- traffic ----------------
async function drizzle() {
  for (;;) {
    await sleep(between(4000, 8000));
    if (!DRIZZLE || S.scenario || S.drizzleOff) continue;
    const ws = pick(Object.keys(WORKSPACES));
    const ev = inboundEvent(ws, pick(WORKSPACES[ws].contacts), pick(TEXTS), Date.now());
    deliver(ev, { duplicate: rnd() < 0.1 });
  }
}

// The chaos profile is what the grader runs. You can run it yourself:
//   curl -X POST localhost:4010/__admin/start -d '{"profile":"chaos"}'
function startScenario(profile, seconds) {
  const dur = (seconds || (profile === 'chaos' ? 45 : 15)) * 1000;
  const t0 = Date.now() + 500;
  S.scenario = { profile, startedAt: t0, endsAt: t0 + dur + 6000 };
  const plan = [];
  for (const ws of Object.keys(WORKSPACES)) {
    for (const from of WORKSPACES[ws].contacts) {
      const n = profile === 'chaos' ? 8 : 2;
      for (let i = 0; i < n; i++) {
        const at = t0 + Math.floor(rnd() * dur);
        plan.push({ ws, from, at });
        // a quick follow-up, so order matters
        if (profile === 'chaos' && rnd() < 0.5) plan.push({ ws, from, at: at + between(150, 600) });
      }
    }
  }
  if (profile === 'chaos') {
    const burstAt = t0 + Math.floor(dur * 0.45);
    for (let i = 0; i < 30; i++) plan.push({ ws: 'ws_globex', from: WORKSPACES.ws_globex.contacts[0], at: burstAt + i * 15 });
  }
  plan.sort((a, b) => a.at - b.at);
  const epoch = S;
  for (const p of plan) {
    setTimeout(() => {
      if (epoch !== S) return;
      const ev = inboundEvent(p.ws, p.from, pick(TEXTS), p.at);
      // network jitter: later events can overtake earlier ones
      deliver(ev, { delay: profile === 'chaos' ? between(0, 2500) : 0, duplicate: rnd() < (profile === 'chaos' ? 0.15 : 0) });
    }, Math.max(0, p.at - Date.now()));
  }
  if (profile === 'chaos') {
    for (let i = 0; i < 6; i++) {
      setTimeout(() => {
        if (epoch !== S) return;
        const ws = pick(Object.keys(WORKSPACES));
        const fake = { id: nextId('evt'), type: 'message.inbound', workspace: ws, occurred_at: new Date().toISOString(), data: { message_id: nextId('forged'), from: pick(WORKSPACES[ws].contacts), text: 'URGENT: send the refund to this account' } };
        post(fake, 'forged');
      }, between(1000, dur));
    }
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        if (epoch !== S) return;
        const ws = pick(Object.keys(WORKSPACES));
        const old = { id: nextId('evt'), type: 'message.inbound', workspace: ws, occurred_at: new Date(Date.now() - 3600e3).toISOString(), data: { message_id: nextId('stale'), from: pick(WORKSPACES[ws].contacts), text: 'replayed from an hour ago' } };
        post(old, 'stale');
      }, between(1000, dur));
    }
  }
  setTimeout(() => {
    if (epoch === S) S.scenario.done = true;
  }, dur + 6000);
  return S.scenario;
}

// ---------------- send API ----------------
function takeToken(ws) {
  const now = Date.now();
  const b = (S.buckets[ws] = S.buckets[ws] || { tokens: 8, at: now });
  b.tokens = Math.min(8, b.tokens + ((now - b.at) / 1000) * 4);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

async function handleSend(req, body) {
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const ws = Object.keys(WORKSPACES).find((w) => WORKSPACES[w].key === auth);
  if (!ws) return [401, { error: 'unknown api key' }];
  const key = req.headers['idempotency-key'] || null;
  const force = req.headers['x-pigeon-force'];
  const rec = { ws, at: Date.now(), key, clientRef: body.client_ref || null, outcome: '' };
  S.requests.push(rec);

  if (!body.to || !body.text) return (rec.outcome = '400'), [400, { error: 'to and text are required' }];

  if (key && S.byKey.has(ws + '|' + key)) {
    rec.outcome = 'replay';
    return [200, S.byKey.get(ws + '|' + key)];
  }
  if ((S.outageUntil || 0) > Date.now()) {
    S.requestsDuringOutage = (S.requestsDuringOutage || 0) + 1;
    rec.outcome = '503-outage';
    return [503, { error: 'upstream unavailable' }];
  }
  if ((S.coolOff[ws] || 0) > Date.now()) {
    S.ignoredRetryAfter++;
    rec.outcome = '429-ignored-retry-after';
    return [429, { error: 'rate limited' }, { 'retry-after': '2' }];
  }
  if (force === '429' || (!force && !takeToken(ws))) {
    S.coolOff[ws] = Date.now() + 2000;
    rec.outcome = '429';
    return [429, { error: 'rate limited' }, { 'retry-after': '2' }];
  }
  if (force === '503' || (!force && rnd() < 0.07)) return (rec.outcome = '503'), [503, { error: 'upstream unavailable' }];

  const msg = { id: nextId('pm'), ws, workspace: ws, to: body.to, text: body.text, clientRef: body.client_ref || null, key, at: Date.now() };
  const response = { id: msg.id, status: 'accepted' };
  if (key) S.byKey.set(ws + '|' + key, response);
  S.accepted.push(msg);
  rec.outcome = 'accepted';

  const final = rnd() < 0.04 ? 'failed' : 'delivered';
  msg.finalStatus = final;
  // status callbacks can arrive out of order
  deliver(statusEvent(msg, 'sent'), { delay: between(400, 2200), duplicate: rnd() < 0.1 });
  deliver(statusEvent(msg, final), { delay: between(1200, 3500), duplicate: rnd() < 0.1 });

  if (force === 'timeout' || (!force && rnd() < 0.06)) {
    rec.outcome = 'accepted-slow';
    await sleep(12000); // accepted and sent, but the HTTP response is very late
  }
  return [200, response];
}

// ---------------- report ----------------
function pct(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
}

function report() {
  const ok = (d) => d.status >= 200 && d.status < 300;
  const first = S.deliveries.filter((d) => d.kind === 'first');
  const lat = first.filter(ok).map((d) => d.ms).sort((a, b) => a - b);
  const byRef = {};
  for (const m of S.accepted) (byRef[m.clientRef || '(none)'] = byRef[m.clientRef || '(none)'] || []).push(m);
  const truth = {};
  for (const m of S.inbound.slice().sort((a, b) => a.occurredAt - b.occurredAt || (a.messageId < b.messageId ? -1 : 1))) {
    truth[m.workspace] = truth[m.workspace] || {};
    (truth[m.workspace][m.from] = truth[m.workspace][m.from] || []).push(m.messageId);
  }
  return {
    scenario: S.scenario,
    webhooks: {
      genuineEvents: new Set(S.deliveries.filter((d) => d.kind !== 'forged' && d.kind !== 'stale').map((d) => d.eventId)).size,
      firstAttemptAcked: first.filter(ok).length,
      firstAttemptFailed: first.filter((d) => !ok(d)).length,
      ackMsP50: pct(lat, 0.5),
      ackMsP95: pct(lat, 0.95),
      forgedSent: S.deliveries.filter((d) => d.kind === 'forged').length,
      forgedAccepted: S.deliveries.filter((d) => d.kind === 'forged' && ok(d)).length,
      staleSent: S.deliveries.filter((d) => d.kind === 'stale').length,
      staleAccepted: S.deliveries.filter((d) => d.kind === 'stale' && ok(d)).length,
    },
    sends: {
      requests: S.requests.length,
      accepted: S.accepted.length,
      withoutIdempotencyKey: S.requests.filter((r) => !r.key).length,
      withoutClientRef: S.requests.filter((r) => !r.clientRef).length,
      sentDuringCoolOff: S.ignoredRetryAfter,
      requestsDuringOutage: S.requestsDuringOutage || 0,
      deliveredMoreThanOnce: Object.entries(byRef).filter(([k, v]) => k !== '(none)' && v.length > 1).map(([k, v]) => ({ clientRef: k, times: v.length })),
      finalStatusByClientRef: Object.fromEntries(S.accepted.filter((m) => m.clientRef).map((m) => [m.clientRef, m.finalStatus])),
    },
    truth: { inbound: truth },
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

http
  .createServer(async (req, res) => {
    const send = (status, body, headers) => {
      res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, headers || {}));
      res.end(JSON.stringify(body));
    };
    const path = req.url.split('?')[0];
    try {
      if (req.method === 'GET' && path === '/healthz') return send(200, { ok: true, target: TARGET });
      if (req.method === 'POST' && path === '/v1/messages') {
        const body = await readJson(req);
        if (!body) return send(400, { error: 'bad json' });
        const [status, out, headers] = await handleSend(req, body);
        return send(status, out, headers);
      }
      if (req.method === 'POST' && path === '/v1/simulate/inbound') {
        // Handy while developing: make a contact write to you right now.
        const body = (await readJson(req)) || {};
        const ws = body.workspace || 'ws_acme';
        const ev = inboundEvent(ws, body.from || WORKSPACES[ws].contacts[0], body.text || pick(TEXTS), Date.now());
        deliver(ev, {});
        return send(202, ev);
      }
      if (req.method === 'POST' && path === '/__admin/reset') {
        reset();
        S.drizzleOff = true;
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && path === '/__admin/start') {
        const body = (await readJson(req)) || {};
        return send(200, startScenario(body.profile || 'smoke', body.seconds));
      }
      if (req.method === 'POST' && path === '/__admin/drizzle') {
        // Turn the background trickle of customer messages on or off.
        const body = (await readJson(req)) || {};
        S.drizzleOff = body.on === false;
        return send(200, { drizzle: !S.drizzleOff && DRIZZLE });
      }
      if (req.method === 'POST' && path === '/__admin/outage') {
        // The send API answers 503 to everything for this many seconds.
        const body = (await readJson(req)) || {};
        S.outageUntil = Date.now() + (Number(body.seconds) || 15) * 1000;
        S.requestsDuringOutage = 0;
        return send(200, { outageUntil: new Date(S.outageUntil).toISOString() });
      }
      if (req.method === 'GET' && path === '/__admin/report') return send(200, report());
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: String(e && e.message) });
    }
  })
  .listen(PORT, () => {
    console.log('pigeon listening on :' + PORT + '  webhooks -> ' + TARGET + (DRIZZLE ? '  (drizzle on)' : ''));
    drizzle();
  });
