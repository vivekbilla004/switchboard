'use strict';

// Shortcuts for driving Pigeon while you develop.
//
//   npm run inbound                 one contact writes to ws_acme now
//   npm run inbound -- ws_globex "+442079460201" "hello there"
//   npm run quiet                   stop the automatic trickle of messages (npm run drizzle restarts it)
//   npm run chaos                   45 s of the traffic profile the grader uses
//   npm run report                  what Pigeon saw: your acks, your sends, the truth

const PIGEON = process.env.PIGEON_URL || 'http://localhost:4010';
const [cmd, ...rest] = process.argv.slice(2);
const post = (path, body) => fetch(PIGEON + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());

(async () => {
  try {
    if (cmd === 'inbound') {
      const ev = await post('/v1/simulate/inbound', { workspace: rest[0] || 'ws_acme', from: rest[1], text: rest[2] });
      console.log('sent', ev.data.message_id, 'from', ev.data.from, 'to', ev.workspace);
    } else if (cmd === 'chaos') {
      const s = await post('/__admin/start', { profile: 'chaos', seconds: Number(rest[0]) || 45 });
      console.log('chaos running until', new Date(s.endsAt).toLocaleTimeString(), '- then: npm run report');
    } else if (cmd === 'quiet' || cmd === 'drizzle') {
      const r = await post('/__admin/drizzle', { on: cmd === 'drizzle' });
      console.log(r.drizzle ? 'Pigeon is sending a customer message every few seconds.' : 'Pigeon is quiet. Send messages yourself with: npm run inbound');
    } else if (cmd === 'report') {
      const r = await (await fetch(PIGEON + '/__admin/report')).json();
      const n = Object.values(r.truth.inbound).reduce((a, ws) => a + Object.values(ws).reduce((b, list) => b + list.length, 0), 0);
      console.log('genuine inbound messages Pigeon sent you:', n);
      console.log('webhooks:', JSON.stringify(r.webhooks, null, 2));
      console.log('your sends:', JSON.stringify(Object.assign({}, r.sends, { finalStatusByClientRef: Object.keys(r.sends.finalStatusByClientRef).length + ' messages' }), null, 2));
      console.log('\nFull JSON, including the true order of every message: curl ' + PIGEON + '/__admin/report');
    } else {
      console.log('usage: node harness/pigeon.js inbound|quiet|drizzle|chaos|report');
    }
  } catch (e) {
    console.error('Could not reach Pigeon at ' + PIGEON + '. Run: npm run doctor');
    process.exit(1);
  }
})();
