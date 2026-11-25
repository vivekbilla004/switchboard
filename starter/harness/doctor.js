'use strict';

// Checks that your machine and the harness are ready, and says what to fix.
// Zero dependencies.
//
//   node harness/doctor.js              tools + every service
//   node harness/doctor.js --wait       same, but waits up to 90 s for services to come up
//   node harness/doctor.js --preflight  tools and Docker images only (run this before the day)

const net = require('net');
const os = require('os');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PREFLIGHT = args.includes('--preflight');
const WAIT = args.includes('--wait');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const add = (state, name, detail) => rows.push([state, name, detail || '']);

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', timeout: 20000 });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

function tcp(port, payload, expect) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
    let data = '';
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.on('connect', () => (payload ? sock.write(payload) : done(true)));
    sock.on('data', (d) => {
      data += d.toString();
      if (!expect || data.includes(expect)) done(true);
    });
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

async function http(url, test) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    const body = await res.json().catch(() => ({}));
    return res.ok && (!test || test(body));
  } catch (e) {
    return false;
  }
}

const SERVICES = [
  { name: 'Pigeon (messaging provider) :4010', check: () => http('http://localhost:4010/healthz', (b) => b.ok), fix: 'npm run up   (or npm run mocks without Docker)' },
  { name: 'Mock IdP (login) :4020', check: () => http('http://localhost:4020/.well-known/openid-configuration', (b) => !!b.issuer), fix: 'npm run up   (or npm run mocks without Docker)' },
  { name: 'Paybox (payments, bonus) :4030', check: () => http('http://localhost:4030/healthz', (b) => b.ok), fix: 'npm run up   (or npm run mocks without Docker)' },
  { name: 'MongoDB :27017', check: () => tcp(27017), fix: 'npm run up   (or set MONGO_URL to a MongoDB you have)' },
  { name: 'Redis :6379', check: () => tcp(6379, 'PING\r\n', 'PONG'), fix: 'npm run up   (or set REDIS_URL to a Redis you have)' },
  { name: 'Elasticsearch :9200 (optional)', check: () => http('http://localhost:9200', (b) => !!b.version), fix: 'npm run up:search   (only if you plan to build search)', optional: true },
];

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22 ? 'PASS' : 'FAIL', 'Node.js ' + process.versions.node, major >= 22 ? '' : 'install Node 22 (https://nodejs.org)');
  const git = run('git', ['--version']);
  add(git.ok ? 'PASS' : 'FAIL', 'git', git.ok ? '' : 'install git');
  const gb = os.totalmem() / 2 ** 30;
  add(gb >= 7.5 ? 'PASS' : 'WARN', 'memory ' + gb.toFixed(0) + ' GB', gb >= 7.5 ? '' : 'skip Elasticsearch on this machine');

  const docker = run('docker', ['--version']);
  const daemon = docker.ok && run('docker', ['info', '--format', '{{.ServerVersion}}']);
  const compose = docker.ok && run('docker', ['compose', 'version']);
  if (!docker.ok) add('WARN', 'Docker not installed', 'install Docker Desktop, or use npm run mocks plus your own MongoDB and Redis');
  else if (!daemon.ok) add('WARN', 'Docker is installed but not running', 'start Docker Desktop, then run this again');
  else add(compose.ok ? 'PASS' : 'WARN', 'Docker ' + daemon.out + (compose.ok ? ' with compose' : ''), compose.ok ? '' : 'update Docker: "docker compose" is missing');

  if (PREFLIGHT) {
    if (daemon && daemon.ok) {
      for (const image of ['mongo:7', 'redis:7-alpine', 'node:22-alpine']) {
        const have = run('docker', ['image', 'inspect', image]).ok;
        add(have ? 'PASS' : 'WARN', 'image ' + image, have ? '' : 'docker pull ' + image);
      }
      const es = 'docker.elastic.co/elasticsearch/elasticsearch:8.15.3';
      add(run('docker', ['image', 'inspect', es]).ok ? 'PASS' : 'INFO', 'image elasticsearch (optional)', 'docker pull ' + es);
    }
  } else {
    const deadline = Date.now() + (WAIT ? 90000 : 0);
    let results;
    for (;;) {
      results = await Promise.all(SERVICES.map((s) => s.check()));
      if (results.every((ok, i) => ok || SERVICES[i].optional) || Date.now() >= deadline) break;
      await sleep(2000);
    }
    SERVICES.forEach((s, i) => add(results[i] ? 'PASS' : s.optional ? 'INFO' : 'FAIL', s.name, results[i] ? '' : s.fix));
    const app = await tcp(4000);
    add('INFO', 'your app on :4000', app ? 'something is listening' : 'nothing listening yet (that is your job)');
  }

  const width = Math.max(...rows.map((r) => r[1].length));
  for (const [state, name, detail] of rows) console.log(state.padEnd(5) + name.padEnd(width + 2) + (detail ? '-> ' + detail : ''));
  const failed = rows.filter((r) => r[0] === 'FAIL').length;
  console.log(failed ? '\n' + failed + ' thing(s) to fix.' : '\nReady.');
  process.exit(failed ? 1 : 0);
}

main();
