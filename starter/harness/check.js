'use strict';

// The Switchboard check. This is the same program the hiring team runs on
// your final commit; they run it with larger numbers and different timing.
//
//   npm run check         level 1 only, about 90 seconds
//   npm run check:full    levels 1, 2, 3 and 5, about 4 minutes, writes CHECK_REPORT.json
//   npm run check -- --levels 5    one level on its own
//
// The check starts your server itself, using the "start" command in
// switchboard.json, so stop your own dev server first. MongoDB, Redis and the
// simulators must be running (npm run up, or npm run mocks).
//
// It puts a small load balancer on :4000 and runs your server behind it on
// :4001, :4002 ... Your server must listen on the port given in the PORT
// environment variable.

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(process.env.SB_ROOT || path.join(__dirname, '..'));
const PIGEON = process.env.PIGEON_URL || 'http://localhost:4010';
const TOKEN = process.env.GRADER_TOKEN || 'grader-dev-token';
const LB_PORT = Number(process.env.SB_LB_PORT || 4000);
const APP = 'http://127.0.0.1:' + LB_PORT;
const LOG_DIR = process.env.SB_LOG_DIR || path.join(ROOT, '.check-logs');

const PROFILES = {
  // name: chaos seconds, replies in a burst, outage seconds, instances for level 3
  quick: { levels: [1], chaos: 20, replies: 12, outage: 8, instances: 2, down: 4 },
  full: { levels: [1, 2, 3, 5], chaos: 20, replies: 12, outage: 8, instances: 2, down: 4 },
};

const DEFAULT_ENV = {
  WEB_ORIGIN: 'http://localhost:5173',
  GRADER_TOKEN: TOKEN,
  MONGO_URL: 'mongodb://localhost:27017/switchboard',
  REDIS_URL: 'redis://localhost:6379',
  ELASTICSEARCH_URL: 'http://localhost:9200',
  PIGEON_URL: PIGEON,
  PIGEON_WEBHOOK_SECRET: 'whsec_pigeon_dev',
  PIGEON_KEY_WS_ACME: 'pk_acme_7d1f0a',
  PIGEON_KEY_WS_GLOBEX: 'pk_globex_c93b22',
  OIDC_ISSUER: 'http://localhost:4020',
  OIDC_CLIENT_ID: 'switchboard-web',
  OIDC_CLIENT_SECRET: 'dev-secret-not-for-production',
  OIDC_REDIRECT_URI: 'http://localhost:4000/auth/callback',
  PAYBOX_URL: 'http://localhost:4030',
  PAYBOX_SECRET_KEY: 'sk_test_paybox_51c0de',
  PAYBOX_PUBLISHABLE_KEY: 'pk_test_paybox_9a7b3e',
  PAYBOX_WEBHOOK_SECRET: 'whsec_paybox_dev',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => process.stderr.write(a.join(' ') + '\n');
const hdr = { 'content-type': 'application/json', 'x-grader-token': TOKEN };
const jpost = (url, body, headers, ms) => fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: JSON.stringify(body || {}), signal: AbortSignal.timeout(ms || 20000) });
const pigeonReport = async () => (await fetch(PIGEON + '/__admin/report')).json();

// ---------------------------------------------------------------- instances
function readManifest() {
  const file = path.join(ROOT, 'switchboard.json');
  let m = {};
  try {
    m = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error('switchboard.json is missing or is not valid JSON (' + file + ')');
  }
  if (!m.start) throw new Error('switchboard.json has no "start" command');
  return { start: m.start, health: m.health || '/healthz' };
}

const instances = []; // { port, child, alive }
function startInstance(manifest, index) {
  const port = LB_PORT + 1 + index;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = fs.openSync(path.join(LOG_DIR, 'instance-' + (index + 1) + '.log'), 'a');
  const env = Object.assign({}, DEFAULT_ENV, process.env, { PORT: String(port), NODE_ENV: process.env.NODE_ENV || 'production' });
  const child = spawn('sh', ['-c', manifest.start], { cwd: ROOT, env, detached: true, stdio: ['ignore', log, log] });
  const inst = instances[index] || (instances[index] = { port });
  inst.child = child;
  inst.alive = true;
  child.on('exit', () => {
    if (inst.child === child) inst.alive = false;
  });
  return inst;
}

function killInstance(index) {
  const inst = instances[index];
  if (!inst || !inst.child) return;
  inst.alive = false;
  try {
    process.kill(-inst.child.pid, 'SIGKILL'); // the whole process group, no warning
  } catch (e) {
    /* already gone */
  }
}

async function waitHealthy(manifest, index, seconds) {
  const url = 'http://127.0.0.1:' + instances[index].port + manifest.health;
  const until = Date.now() + (seconds || 60) * 1000;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return true;
    } catch (e) {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

async function ensureInstances(manifest, n) {
  for (let i = 0; i < instances.length; i++) if (i >= n) killInstance(i);
  for (let i = 0; i < n; i++) if (!instances[i] || !instances[i].alive) startInstance(manifest, i);
  for (let i = 0; i < n; i++) {
    if (!(await waitHealthy(manifest, i, 90))) throw new Error('instance ' + (i + 1) + ' did not answer ' + manifest.health + ' on port ' + instances[i].port + ' within 90 s. See .check-logs/instance-' + (i + 1) + '.log');
  }
}

// ------------------------------------------------------------ load balancer
// Round robin over the instances that are up. If one refuses the connection,
// the next one is tried, as a real load balancer with health checks would.
let rr = 0;
function startBalancer() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const order = [];
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[(rr + i) % instances.length];
        if (inst && inst.alive) order.push(inst);
      }
      rr++;
      const attempt = (k) => {
        if (k >= order.length) {
          res.writeHead(502, { 'content-type': 'application/json' });
          return res.end('{"error":"no instance available"}');
        }
        const up = http.request({ host: '127.0.0.1', port: order[k].port, method: req.method, path: req.url, headers: req.headers }, (ur) => {
          res.writeHead(ur.statusCode, ur.headers);
          ur.pipe(res);
          ur.on('error', () => res.destroy());
        });
        up.on('error', (e) => {
          if (res.headersSent) return res.destroy();
          if (e.code === 'ECONNREFUSED') return attempt(k + 1);
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end('{"error":"instance closed the connection"}');
        });
        up.end(body);
      };
      attempt(0);
    });
  });
  // WebSocket upgrades are passed through untouched to one instance.
  server.on('upgrade', (req, socket, head) => {
    const alive = instances.filter((i) => i && i.alive);
    if (!alive.length) return socket.destroy();
    const inst = alive[rr++ % alive.length];
    const up = net.connect(inst.port, '127.0.0.1', () => {
      up.write(req.method + ' ' + req.url + ' HTTP/1.1\r\n' + Object.entries(req.headers).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? 'Port ' + LB_PORT + ' is in use. Stop your own server first: the check starts it for you.' : String(e.message))));
    server.listen(LB_PORT, () => resolve(server));
  });
}

// ------------------------------------------------------------------ helpers
async function snapshot() {
  const res = await fetch(APP + '/__grader/snapshot', { headers: { 'x-grader-token': TOKEN }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('GET /__grader/snapshot returned ' + res.status);
  return res.json();
}

async function resetAll() {
  const r = await jpost(APP + '/__grader/reset', {}, hdr).catch(() => null);
  if (!r || !r.ok) throw new Error('POST /__grader/reset returned ' + (r ? r.status : 'no answer'));
  await jpost(PIGEON + '/__admin/reset');
}

function inversionsIn(list, truthOrder) {
  const pos = new Map(truthOrder.map((id, i) => [id, i]));
  let last = -1;
  let n = 0;
  for (const id of list) {
    if (!pos.has(id)) continue;
    if (pos.get(id) < last) n++;
    last = Math.max(last, pos.get(id));
  }
  return n;
}

function compareInbound(report, snap) {
  const truth = report.truth.inbound;
  let expected = 0, present = 0, dupes = 0, inversions = 0, leaked = 0;
  const where = new Map();
  for (const ws of Object.keys(truth)) for (const c of Object.keys(truth[ws])) for (const id of truth[ws][c]) where.set(id, ws + '|' + c);
  for (const ws of Object.keys(truth)) {
    for (const contact of Object.keys(truth[ws])) {
      const want = truth[ws][contact];
      const got = (((snap.workspaces || {})[ws] || {}).contacts || {})[contact];
      const have = (got && got.inbound) || [];
      expected += want.length;
      present += want.filter((id) => have.includes(id)).length;
      dupes += have.length - new Set(have).size;
      inversions += inversionsIn(Array.from(new Set(have)), want);
    }
  }
  for (const ws of Object.keys(snap.workspaces || {})) {
    for (const contact of Object.keys(snap.workspaces[ws].contacts || {})) {
      for (const id of snap.workspaces[ws].contacts[contact].inbound || []) {
        if (where.has(id) && where.get(id) !== ws + '|' + contact) leaked++;
        if (/^(forged|stale)_/.test(id)) leaked++;
      }
    }
  }
  return { expected, present, dupes, inversions, leaked, truth, w: report.webhooks };
}

// Run the chaos traffic profile. `during(startedAt)` may kill and restart things.
async function inboundPhase(seconds, tail, during) {
  await resetAll();
  await jpost(PIGEON + '/__admin/start', { profile: 'chaos', seconds });
  const t0 = Date.now();
  if (during) await during(t0);
  await sleep(Math.max(0, t0 + (seconds + tail) * 1000 - Date.now()));
  return compareInbound(await pigeonReport(), await snapshot());
}

let refSeq = 0;
// Ask for n replies at the same instant. A request that gets no answer is
// asked again once with the same client_ref, as a browser would.
async function requestReplies(n, workspace, contacts, tag) {
  const stamp = tag + Date.now().toString(36) + (refSeq++).toString(36);
  const refs = Array.from({ length: n }, (_, i) => stamp + '_' + i);
  const one = async (ref, i) => {
    const body = { workspace, contact: contacts[i % contacts.length], text: 'Check reply ' + i, client_ref: ref };
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await jpost(APP + '/__grader/reply', body, hdr, 30000).catch(() => null);
      if (res && res.status >= 200 && res.status < 300) return true;
      await sleep(1000);
    }
    return false;
  };
  const ok = await Promise.all(refs.map(one));
  return { refs, accepted: refs.filter((_, i) => ok[i]) };
}

async function waitForSends(refs, seconds) {
  const until = Date.now() + seconds * 1000;
  let report = await pigeonReport();
  while (Date.now() < until && !refs.every((r) => r in report.sends.finalStatusByClientRef)) {
    await sleep(1500);
    report = await pigeonReport();
  }
  await sleep(8000); // status webhooks, and their duplicates, are still on the way
  report = await pigeonReport();
  const s = report.sends;
  const snap = await snapshot();
  const out = {};
  for (const ws of Object.keys(snap.workspaces || {})) Object.assign(out, snap.workspaces[ws].outbound || {});
  const reached = refs.filter((r) => r in s.finalStatusByClientRef);
  return {
    s,
    reached: reached.length,
    twice: s.deliveredMoreThanOnce.filter((d) => refs.includes(d.clientRef)).length,
    statusRight: reached.filter((r) => out[r] === s.finalStatusByClientRef[r]).length,
  };
}

// --------------------------------------------------------------------- run
async function run(profileName, opts) {
  if (typeof WebSocket === 'undefined') throw new Error('Node 22 or newer is needed (this is Node ' + process.versions.node + ')');
  // the hiring team passes its own numbers in SB_PROFILE
  const P = Object.assign({}, PROFILES[profileName] || PROFILES.quick, process.env.SB_PROFILE ? JSON.parse(process.env.SB_PROFILE) : {}, opts || {});
  const checks = [];
  const add = (level, id, max, got, detail) => {
    const g = Math.round(Math.max(0, Math.min(max, got)) * 100) / 100;
    checks.push({ level, id, max, got: g, detail });
    say('  ' + (g >= max ? 'PASS' : g > 0 ? 'PART' : 'FAIL') + '  ' + (g + '/' + max).padEnd(8) + id.padEnd(28) + detail);
  };
  const out = { profile: profileName, startedAt: new Date().toISOString(), checks, score: 0, max: 0, levels: {} };
  let balancer;
  const ACME = ['+14155550101', '+14155550102', '+14155550103', '+12125550104', '+12125550105', '+13035550106'];
  const GLOBEX = ['+442079460201', '+442079460202', '+442079460203', '+4930901820204', '+34600111205', '+34600111206'];

  try {
    const manifest = readManifest();
    const pg = await fetch(PIGEON + '/healthz').catch(() => null);
    if (!pg || !pg.ok) throw new Error('Pigeon is not reachable at ' + PIGEON + '. Run: npm run up   (or: npm run mocks)');
    balancer = await startBalancer();
    await jpost(PIGEON + '/__admin/drizzle', { on: false }).catch(() => null);

    // ============ Level 1: one instance, a bad network ============
    if (P.levels.includes(1)) {
      say('\nLevel 1: one instance, a bad network');
      await ensureInstances(manifest, 1);
      const r = await inboundPhase(P.chaos, 12);
      add(1, 'inbound_complete', 4, 4 * (r.present / Math.max(1, r.expected)) - (r.present < r.expected ? 0.5 : 0), r.present + ' of ' + r.expected + ' genuine messages stored');
      add(1, 'inbound_no_duplicates', 3, r.dupes === 0 ? 3 : r.dupes <= 2 ? 1 : 0, r.dupes + ' duplicate entries');
      add(1, 'inbound_order', 3, r.inversions === 0 ? 3 : r.inversions <= 3 ? 1.5 : 0, r.inversions + ' out-of-order positions (by occurred_at)');
      add(1, 'isolation', 2, r.leaked === 0 && r.present > 0 ? 2 : 0, r.leaked + ' messages under the wrong workspace or contact, or forged/replayed ids stored');
      add(1, 'rejects_forged', 2, r.w.forgedSent ? 2 * (1 - r.w.forgedAccepted / r.w.forgedSent) : 0, r.w.forgedAccepted + ' of ' + r.w.forgedSent + ' forged webhooks accepted');
      add(1, 'rejects_stale', 1, r.w.staleSent ? 1 - r.w.staleAccepted / r.w.staleSent : 0, r.w.staleAccepted + ' of ' + r.w.staleSent + ' replayed webhooks accepted');
      add(1, 'ack_speed', 1, r.w.ackMsP95 !== null && r.w.ackMsP95 < 1000 && r.w.firstAttemptFailed <= 2 ? 1 : 0, 'p95 acknowledgement ' + r.w.ackMsP95 + ' ms, ' + r.w.firstAttemptFailed + ' first attempts not acknowledged');

      const a = await requestReplies(P.replies, 'ws_acme', ACME, 'b');
      const sa = await waitForSends(a.refs, 45);
      add(1, 'outbound_exactly_once', 2, sa.twice > 0 ? 0 : sa.reached === a.refs.length ? 2 : 2 * (sa.reached / a.refs.length) - 0.5, sa.reached + ' of ' + a.refs.length + ' replies reached the carrier, ' + sa.twice + ' more than once, ' + sa.s.withoutIdempotencyKey + ' requests without Idempotency-Key');
      add(1, 'honours_retry_after', 1, sa.s.sentDuringCoolOff === 0 ? 1 : sa.s.sentDuringCoolOff <= 3 ? 0.5 : 0, sa.s.sentDuringCoolOff + ' requests sent inside a Retry-After window');
      add(1, 'status_lifecycle', 1, sa.reached ? sa.statusRight / sa.reached : 0, sa.statusRight + ' of ' + sa.reached + ' final statuses match the carrier');

      const c = await claimRace(GLOBEX.slice(0, 5));
      add(1, 'claim_atomic', 2, c.many > 0 ? 0 : 1.5 * (c.one / 5) + 0.5 * (c.assigneeRight / 5), c.text);

      await jpost(PIGEON + '/__admin/outage', { seconds: P.outage });
      const o = await requestReplies(6, 'ws_globex', GLOBEX, 'o');
      const so = await waitForSends(o.refs, P.outage + 40);
      add(1, 'outage_recovery', 2, so.twice > 0 ? 0 : 2 * (so.reached / o.refs.length) - (so.s.requestsDuringOutage > 6 * P.outage ? 0.5 : 0), so.reached + ' of ' + o.refs.length + ' replies requested during a ' + P.outage + ' s provider outage were delivered afterwards, ' + so.twice + ' more than once; ' + so.s.requestsDuringOutage + ' requests made during the outage');
    }

    // ============ Level 2: your process is killed ============
    if (P.levels.includes(2)) {
      say('\nLevel 2: one instance, killed without warning and started again');
      await ensureInstances(manifest, 1);
      const killAt = Math.round(P.chaos * (0.35 + 0.3 * Math.random()));
      const r = await inboundPhase(P.chaos, 34, async (t0) => {
        await sleep(Math.max(0, t0 + killAt * 1000 - Date.now()));
        killInstance(0);
        await sleep(P.down * 1000);
        startInstance(manifest, 0);
        await waitHealthy(manifest, 0, 60);
      });
      const tag = 'killed at ' + killAt + ' s, down ' + P.down + ' s: ';
      add(2, 'crash_inbound_complete', 3, r.present === r.expected ? 3 : 3 * (r.present / Math.max(1, r.expected)) - 1, tag + r.present + ' of ' + r.expected + ' genuine messages stored');
      add(2, 'crash_inbound_no_dupes', 2, r.present === 0 ? 0 : r.dupes === 0 ? 2 : r.dupes <= 2 ? 0.5 : 0, r.dupes + ' duplicate entries');
      add(2, 'crash_inbound_order', 2, r.present === 0 ? 0 : r.inversions === 0 ? 2 : r.inversions <= 3 ? 1 : 0, r.inversions + ' out-of-order positions');

      await ensureInstances(manifest, 1);
      await resetAll();
      const a = await requestReplies(P.replies, 'ws_acme', ACME, 'k');
      killInstance(0); // replies are accepted and queued; some are in flight
      await sleep(3000);
      startInstance(manifest, 0);
      await waitHealthy(manifest, 0, 60);
      const sa = await waitForSends(a.accepted, 60);
      const n = Math.max(1, a.accepted.length);
      const enough = a.accepted.length >= P.replies / 2;
      add(2, 'crash_sends_delivered', 4, enough ? (sa.reached === n ? 4 : 4 * (sa.reached / n) - 1) : 0, sa.reached + ' of ' + a.accepted.length + ' replies your server accepted (202) before it was killed reached the carrier after the restart');
      add(2, 'crash_sends_once', 2, enough && sa.reached > 0 && sa.twice === 0 ? 2 : 0, sa.twice + ' delivered more than once');
      add(2, 'crash_sends_status', 1, enough && sa.reached ? sa.statusRight / sa.reached : 0, sa.statusRight + ' of ' + sa.reached + ' final statuses match the carrier');
    }

    // ============ Level 3: several instances behind a load balancer ============
    if (P.levels.includes(3)) {
      say('\nLevel 3: ' + P.instances + ' instances behind a load balancer');
      await ensureInstances(manifest, P.instances);
      const r = await inboundPhase(P.chaos, 12);
      add(3, 'multi_inbound_complete', 2, r.present === r.expected ? 2 : 2 * (r.present / Math.max(1, r.expected)) - 0.5, r.present + ' of ' + r.expected + ' genuine messages stored');
      add(3, 'multi_inbound_no_dupes', 2, r.present === 0 ? 0 : r.dupes === 0 ? 2 : 0, r.dupes + ' duplicate entries');
      add(3, 'multi_inbound_order', 2, r.present === 0 ? 0 : r.inversions === 0 ? 2 : r.inversions <= 3 ? 1 : 0, r.inversions + ' out-of-order positions');

      const c = await claimRace(GLOBEX.slice(0, 5));
      add(3, 'multi_claim', 3, c.many > 0 ? 0 : 2 * (c.one / 5) + (c.assigneeRight / 5), c.text);

      const big = P.replies * 2;
      const a = await requestReplies(big, 'ws_acme', ACME, 'm');
      const sa = await waitForSends(a.refs, 60);
      add(3, 'multi_sends_once', 3, sa.twice > 0 ? 0 : sa.reached === big ? 3 : 3 * (sa.reached / big) - 1, sa.reached + ' of ' + big + ' replies reached the carrier, ' + sa.twice + ' more than once');
      add(3, 'multi_retry_after', 3, sa.reached < big / 2 ? 0 : sa.s.sentDuringCoolOff === 0 ? 3 : sa.s.sentDuringCoolOff <= 2 ? 1.5 : 0, sa.s.sentDuringCoolOff + ' requests sent inside a Retry-After window (the limit is per workspace, not per instance)');

      await resetAll();
      const f = await requestReplies(P.replies, 'ws_globex', GLOBEX, 'f');
      killInstance(0); // this instance does not come back
      const sf = await waitForSends(f.accepted, 60);
      const n = Math.max(1, f.accepted.length);
      const enough = f.accepted.length >= P.replies / 2;
      add(3, 'failover_delivered', 5, !enough || sf.twice > 0 ? 0 : sf.reached === n ? 5 : 5 * (sf.reached / n) - 1.5, sf.reached + ' of ' + f.accepted.length + ' accepted replies reached the carrier within 60 s of one instance dying for good, ' + sf.twice + ' more than once');
      add(3, 'failover_status', 2, enough && sf.reached ? 2 * (sf.statusRight / sf.reached) : 0, sf.statusRight + ' of ' + sf.reached + ' final statuses match the carrier');
    }

    // ============ Level 4: the rules written in PIGEON.md and BRIEF.md ============
    // Not part of the public check. The hiring team's copy loads it from a private file.
    if (P.levels.includes(4) && process.env.SB_LEVEL4) {
      say('\nLevel 4: the written rules');
      await ensureInstances(manifest, 1);
      await resetAll();
      await require(path.resolve(process.env.SB_LEVEL4))({ add: (id, max, got, detail) => add(4, id, max, got, detail), APP, PIGEON, TOKEN, hdr, jpost, snapshot, resetAll, sleep, pigeonReport, ACME, GLOBEX });
    }

    // ============ Level 5: login, tenant isolation and real time ============
    if (P.levels.includes(5)) {
      say('\nLevel 5: login, tenant isolation and real time, ' + P.instances + ' instances');
      await ensureInstances(manifest, P.instances);
      await resetAll();
      await level5(add);
    }
  } catch (err) {
    out.error = String(err && err.message);
    say('\nSTOPPED: ' + out.error);
  } finally {
    for (let i = 0; i < instances.length; i++) killInstance(i);
    if (balancer) balancer.close();
  }

  const MAX = { 1: 24, 2: 14, 3: 22, 4: 10, 5: 15 };
  if (!process.env.SB_LEVEL4) P.levels = P.levels.filter((l) => l !== 4);
  for (const l of P.levels) out.levels[l] = { got: Math.round(checks.filter((c) => c.level === l).reduce((a, c) => a + c.got, 0) * 10) / 10, max: MAX[l] };
  out.max = P.levels.reduce((a, l) => a + MAX[l], 0);
  out.score = Math.round(checks.reduce((a, c) => a + c.got, 0) * 10) / 10;
  out.finishedAt = new Date().toISOString();
  return out;

  async function claimRace(contacts) {
    let one = 0, many = 0, none = 0, assigneeRight = 0;
    const winners = {};
    await Promise.all(
      contacts.map(async (contact) => {
        const ws = 'ws_globex';
        const res = await Promise.all(Array.from({ length: 6 }, (_, i) => jpost(APP + '/__grader/claim', { workspace: ws, contact, agent: 'check_agent_' + (i + 1) }, hdr).then((x) => x.status).catch(() => 0)));
        const won = res.map((st, i) => (st === 200 ? 'check_agent_' + (i + 1) : null)).filter(Boolean);
        if (won.length === 1) (one++, (winners[contact] = won[0]));
        else if (won.length > 1) many++;
        else none++;
      })
    );
    const snap = await snapshot();
    for (const c of Object.keys(winners)) if (((((snap.workspaces || {}).ws_globex || {}).contacts || {})[c] || {}).assignee === winners[c]) assigneeRight++;
    return { one, many, none, assigneeRight, text: one + ' of ' + contacts.length + ' conversations had exactly one winner out of six, ' + many + ' had several, ' + none + ' had none; snapshot assignee correct for ' + assigneeRight };
  }
}

// ---------------------------------------------------------------- level 5
// Signs in through the mock IdP exactly as a browser would, then uses the
// session cookie on your API and your WebSocket.
async function signIn(sub) {
  const jar = {};
  const keep = (res) => {
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i).trim()] = pair.slice(i + 1);
    }
  };
  const cookie = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const get = (url) => fetch(url, { redirect: 'manual', headers: { cookie: cookie() }, signal: AbortSignal.timeout(10000) });
  const start = await get(APP + '/auth/login');
  keep(start);
  const toIdp = start.headers.get('location');
  if (!toIdp || start.status < 300 || start.status > 399) return { error: 'GET /auth/login answered ' + start.status + ' and did not redirect to the IdP' };
  const picked = await fetch(toIdp + (toIdp.includes('?') ? '&' : '?') + 'login=' + sub, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  let back = picked.headers.get('location');
  if (!back) return { error: 'the IdP refused the login request your server built (' + picked.status + '): ' + (await picked.text()).slice(0, 160) };
  // follow your own redirects (callback, then wherever you send the browser) on this host only
  for (let hop = 0; hop < 4 && back; hop++) {
    const u = new URL(back, APP);
    if (u.port !== String(LB_PORT) && hop > 0) break; // off to the web app: the session is set by now
    const res = await get(APP + u.pathname + u.search);
    keep(res);
    if (res.status >= 400 && hop === 0) return { error: u.pathname + ' answered ' + res.status };
    if (res.status >= 400) break;
    back = res.status >= 300 ? res.headers.get('location') : null;
  }
  return { cookie: cookie() };
}

function openSocket(workspace, cookie, after) {
  const frames = [];
  const url = 'ws://127.0.0.1:' + LB_PORT + '/ws?workspace=' + workspace + (after === undefined ? '' : '&after=' + after);
  return new Promise((resolve) => {
    let ws;
    let settled = false;
    const done = (opened) => {
      if (settled) return;
      settled = true;
      resolve({ opened, frames, close: () => { try { ws.close(); } catch (e) { /* closed */ } } });
    };
    try {
      ws = new WebSocket(url, { headers: cookie ? { cookie } : {} });
    } catch (e) {
      return done(false);
    }
    ws.addEventListener('open', () => done(true));
    ws.addEventListener('error', () => done(false));
    ws.addEventListener('close', () => done(false));
    ws.addEventListener('message', (m) => {
      try {
        const f = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8'));
        if (f && typeof f.seq === 'number') frames.push(f);
      } catch (e) {
        /* frames that are not JSON are ignored */
      }
    });
    setTimeout(() => done(false), 6000);
  });
}

async function level5(add) {
  const L = 5;
  const simulate = async (workspace, from) => (await (await jpost(PIGEON + '/v1/simulate/inbound', { workspace, from, text: 'level 5' })).json()).data.message_id;
  const status = (url, cookie) => fetch(url, { headers: cookie ? { cookie } : {}, redirect: 'manual', signal: AbortSignal.timeout(10000) }).then((r) => r.status).catch(() => 0);

  const ben = await signIn('u_ben'); // agent in ws_acme only
  let me = null;
  if (ben.cookie) me = await fetch(APP + '/api/me', { headers: { cookie: ben.cookie } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const meOk = !!(me && me.sub === 'u_ben' && Array.isArray(me.workspaces) && me.workspaces.length === 1 && me.workspaces[0].id === 'ws_acme' && me.workspaces[0].role === 'agent');
  add(L, 'login', 3, meOk ? 3 : ben.cookie ? 1 : 0, ben.error ? ben.error : meOk ? 'signed in as u_ben through the IdP; GET /api/me is correct' : 'signed in, but GET /api/me returned ' + JSON.stringify(me).slice(0, 120));
  const anon = await status(APP + '/api/me');
  add(L, 'me_needs_session', 1, anon === 401 ? 1 : 0, 'GET /api/me without a session: ' + anon + ' (want 401)');
  if (!ben.cookie) {
    for (const [id, max] of [['api_tenant_isolation', 3], ['socket_refuses_strangers', 2], ['socket_live', 3], ['socket_replay', 3]]) add(L, id, max, 0, 'not run: login did not work');
    return;
  }
  const own = await status(APP + '/api/conversations?workspace=ws_acme', ben.cookie);
  const other = await status(APP + '/api/conversations?workspace=ws_globex', ben.cookie);
  const none = await status(APP + '/api/conversations?workspace=ws_acme');
  add(L, 'api_tenant_isolation', 3, (own === 200 ? 1 : 0) + (other === 403 ? 1.5 : 0) + (none === 401 ? 0.5 : 0), 'GET /api/conversations as u_ben: own workspace ' + own + ' (want 200), another workspace ' + other + ' (want 403), no session ' + none + ' (want 401)');

  const s0 = await openSocket('ws_acme', null);
  const s1 = await openSocket('ws_globex', ben.cookie);
  s0.close();
  s1.close();
  const sock = await openSocket('ws_acme', ben.cookie);
  add(L, 'socket_refuses_strangers', 2, !sock.opened ? 0 : (s0.opened ? 0 : 1) + (s1.opened ? 0 : 1), 'WebSocket /ws without a session: ' + (s0.opened ? 'OPENED' : 'refused') + '; as u_ben for ws_globex: ' + (s1.opened ? 'OPENED' : 'refused') + (sock.opened ? '' : '; and it did not open for u_ben in his own workspace'));
  if (!sock.opened) {
    add(L, 'socket_live', 3, 0, 'GET /ws?workspace=ws_acme did not open with a valid session');
    add(L, 'socket_replay', 3, 0, 'not run');
    return;
  }
  const A = ['+14155550101', '+14155550102', '+14155550103'];
  const mine = [];
  const theirs = [];
  for (let i = 0; i < 6; i++) mine.push(await simulate('ws_acme', A[i % 3]));
  for (let i = 0; i < 3; i++) theirs.push(await simulate('ws_globex', '+442079460201'));
  await sleep(5000);
  const inbound = sock.frames.filter((f) => f.type === 'message.inbound');
  const got = mine.filter((id) => inbound.some((f) => f.message_id === id)).length;
  const leaked = sock.frames.filter((f) => theirs.includes(f.message_id)).length;
  const seqs = sock.frames.map((f) => f.seq);
  const rising = seqs.every((v, i) => i === 0 || v > seqs[i - 1]);
  add(L, 'socket_live', 3, leaked ? 0 : 2 * (got / mine.length) + (rising && got ? 1 : 0), got + ' of ' + mine.length + ' new messages arrived on the socket within 5 s; ' + leaked + ' frames from another workspace; seq ' + (rising ? 'increasing' : 'NOT increasing'));
  const last = seqs.length ? seqs[seqs.length - 1] : 0;
  sock.close();
  await sleep(500);
  const missed = [];
  for (let i = 0; i < 4; i++) missed.push(await simulate('ws_acme', A[i % 3]));
  await sleep(4000);
  const again = await openSocket('ws_acme', ben.cookie, last);
  await sleep(3000);
  const back = missed.filter((id) => again.frames.some((f) => f.type === 'message.inbound' && f.message_id === id)).length;
  const old = again.frames.filter((f) => f.seq <= last).length;
  again.close();
  add(L, 'socket_replay', 3, !again.opened ? 0 : 3 * (back / missed.length) - (old ? 1 : 0), again.opened ? back + ' of ' + missed.length + ' messages that arrived while disconnected were replayed after reconnecting with after=' + last + '; ' + old + ' frames at or before that seq were sent again' : 'reconnecting with after=' + last + ' did not open');
}

module.exports = { run, PROFILES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const profile = process.env.SB_PROFILE ? 'hiring-team' : args.includes('--full') ? 'full' : 'quick';
  const outArg = args.indexOf('--out');
  const file = outArg >= 0 ? args[outArg + 1] : profile === 'full' ? path.join(ROOT, 'CHECK_REPORT.json') : null;
  say('Switchboard check, profile "' + profile + '". Your server is started from switchboard.json; logs go to .check-logs/');
  const lv = args.indexOf('--levels');
  run(profile, lv >= 0 ? { levels: args[lv + 1].split(',').map(Number) } : null).then((out) => {
    say('\nScore ' + out.score + ' of ' + out.max + '   ' + Object.keys(out.levels).map((l) => 'level ' + l + ': ' + out.levels[l].got + '/' + out.levels[l].max).join('   '));
    if (file) {
      fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
      say('Written to ' + path.relative(process.cwd(), file) + (profile === 'full' ? '. Commit it.' : ''));
    }
    say('The trickle of customer messages is off after a check. Turn it back on with: npm run drizzle');
    process.exit(out.error ? 2 : 0);
  });
}
