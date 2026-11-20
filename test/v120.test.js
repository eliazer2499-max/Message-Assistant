// 1.1.9: "the server goes down — bad gateway, often around an update." Root cause: main() only opened the
// dashboard port AFTER the whole app had started, and starting includes launching Chromium for Google
// Messages — tens of seconds on a good day, forever on a hung one. The proxy had nothing to talk to, so
// every restart and update was a Bad Gateway window. Now main() listens FIRST: while the app starts,
// /healthz answers and the dashboard page loads; data calls get a clean 503 "starting" they can retry.
import { setupEnv } from './helpers.js';
setupEnv('v120', { MSA_ADMIN_PHONE: '+16465550100', MSA_PUBLIC_URL: 'https://msg.example.com' });
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
const { main } = await import('../src/server.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class StuckChannel extends EventEmitter {
  constructor() { super(); this.release = null; }
  async start() { await new Promise(r => { this.release = r; }); }   // a browser launch that does not finish until released
  async stop() {}
  status() { return { state: 'starting', detail: 'test channel' }; }
  async send() { throw new Error('not connected'); }
  async sendPicture() { throw new Error('not connected'); }
}

test('the port answers /healthz while the Messages browser is still starting', async () => {
  const port = await new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const ch = new StuckChannel();
  const mp = main({ channel: ch, port, host: '127.0.0.1' });
  let app = null;
  try {
    let hz = null;
    for (let i = 0; i < 50 && !hz; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.status === 200) hz = await r.json(); } catch {} if (!hz) await sleep(100); }
    assert.ok(hz && hz.ok === true && hz.starting === true, 'healthz answers during startup instead of a Bad Gateway: ' + JSON.stringify(hz));
    const api = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(api.status, 503, 'data calls get a clean starting answer, not a hang or a crash');
    ch.release();
    app = await mp;
    const done = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(done.ok, true); assert.equal(done.starting, undefined, 'once started, healthz is the normal one');
  } finally { if (app) await app.stop(); else { ch.release?.(); await mp.catch(() => {}); } }
});
