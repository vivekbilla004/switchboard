'use strict';

// Starts the three simulators with plain Node, no Docker. Ctrl+C stops them.
// MongoDB and Redis are not started by this: use ones you already have.
//
//   node harness/run-mocks.js

const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const app = process.env.APP_URL || 'http://localhost:4000';
const mocks = [
  { name: 'pigeon', dir: 'pigeon', env: { PORT: '4010', PIGEON_TARGET_URL: app + '/webhooks/pigeon' } },
  { name: 'idp   ', dir: 'idp', env: { PORT: '4020' } },
  { name: 'paybox', dir: 'paybox', env: { PORT: '4030', PAYBOX_TARGET_URL: app + '/webhooks/paybox' } },
];

const children = mocks.map((m) => {
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(root, m.dir), env: Object.assign({}, process.env, m.env) });
  const tag = (line) => line && console.log('[' + m.name + '] ' + line);
  child.stdout.on('data', (d) => d.toString().split('\n').forEach(tag));
  child.stderr.on('data', (d) => d.toString().split('\n').forEach(tag));
  child.on('exit', (code) => console.log('[' + m.name + '] exited with code ' + code + (code ? '  (is the port already in use? try: npm run down)' : '')));
  return child;
});

const stop = () => {
  children.forEach((c) => c.kill());
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
