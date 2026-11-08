// 1.0.2 with a real headless Chromium (skipped without one): the phone-size site picture, and pictures through the
// Messages driver (attached when the page takes a file; its private link as text when it doesn't).
import { setupEnv, until, sleep } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { fakeMessages } from './fake-gm.js';
const { st, fake } = fakeMessages();
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const dataDir = setupEnv('sitesbr', { MSA_CHANNEL: 'web', MSA_GM_URL: `http://127.0.0.1:${fake.address().port}/web`, MSA_POLL_MS: '300', MSA_HEALTH_MS: '500' });
import test from 'node:test';
import assert from 'node:assert/strict';
test.after(() => { fake.close(); fake.closeAllConnections?.(); });

test('site picture: phone size (390×844 at 2×), the site\'s own CSS, and private addresses blocked', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 90000 }, async () => {
  const db = await import('../src/db.js'); db.openDb(':memory:');
  const B = await import('../src/browser.js');
  const http = await import('node:http');
  let hits = 0; const spy = http.createServer((q, s) => { hits++; s.end('x'); }); await new Promise(r => spy.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(dataDir, 'site-'));
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta name=viewport content="width=device-width"><link rel=stylesheet href="css/s.css"><h1>Hi</h1><img src="http://127.0.0.1:${spy.address().port}/x.png"><script>fetch('http://127.0.0.1:${spy.address().port}/api/me').catch(()=>{})</script>`);
  fs.mkdirSync(path.join(dir, 'css')); fs.writeFileSync(path.join(dir, 'css', 's.css'), 'body{background:rgb(255,0,0);margin:0}');
  const png = await B.shootFolder(1, dir, { waitMs: 50 });
  assert.equal(png.slice(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 780); assert.equal(png.readUInt32BE(20), 1688);
  assert.equal(hits, 0, 'the page could not reach this machine');
  spy.close(); await B.shutdown();
});

test('pictures through the real Messages driver: attached, or the private link when the page has no file box', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 120000 }, async () => {
  st.mode = 'connected';
  const { GoogleMessagesWeb } = await import('../src/channels/gmweb.js');
  const seen = new Set();
  const gm = new GoogleMessagesWeb({ isSeen: (id) => seen.has(id), markSeen: (id) => seen.add(id), needsBaseline: () => false, baselineDone: () => {}, attachWaitMs: 200 });
  await gm.start();
  try {
    await until(() => gm.status().state === 'connected', 40000, 'connected');
    const img = path.join(dataDir, 'pic.png'); fs.writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    const conv = () => st.convs.find(c => c.id === '101');
    await gm.send({ convId: '101', text: 'Here it is', media: img, mediaUrl: 'https://msg.example.com/m/tok/site.png' });
    const out = conv().msgs.filter(m => m.out);
    assert.ok(out.some(m => m.media === 'pic.png'), 'the picture was attached: ' + JSON.stringify(out.slice(-3)));
    assert.equal(out.at(-1).text, 'Here it is');
    st.noAttach = true;
    await gm.send({ convId: '101', text: 'Second', media: img, mediaUrl: 'https://msg.example.com/m/tok/site.png' });
    assert.equal(conv().msgs.filter(m => m.out).at(-1).text, 'Second\nhttps://msg.example.com/m/tok/site.png', 'fell back to the link');
  } finally { st.noAttach = false; await gm.stop(); }
});
