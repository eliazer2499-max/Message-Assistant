// 1.1.16: on FLS's real page EVERY attach fails the same way (his Activity log, 11/20 + 11/22): the attach
// button is in the DOM but a Playwright click on it times out ("waiting for locator('[data…')"), and both
// keyboard shortcuts open no chooser. Two routes answer that: (1b) click the button from INSIDE the page
// (a DOM click fires the page's own handler even when the button can't be clicked by coordinates), and
// (3b) hand the file to the page's file box directly via DataTransfer + change. And the error now leads
// with terse per-route codes — the dashboard used to cut the long notes before the later routes were named.
import { setupEnv, until } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { fakeMessages } from './fake-gm.js';
const { st, fake } = fakeMessages();
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const dataDir = setupEnv('v128', { MSA_CHANNEL: 'web', MSA_GM_URL: `http://127.0.0.1:${fake.address().port}/web`, MSA_POLL_MS: '300', MSA_HEALTH_MS: '500' });
import test from 'node:test';
import assert from 'node:assert/strict';
test.after(() => { fake.close(); fake.closeAllConnections?.(); });

test('a covered attach button (Playwright click times out) still sends the picture via the JS click', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 120000 }, async () => {
  st.mode = 'connected'; st.attachMode = 'covered'; st.noAttach = false;
  const { GoogleMessagesWeb } = await import('../src/channels/gmweb.js');
  const seen = new Set();
  const gm = new GoogleMessagesWeb({ dataDir, isSeen: (id) => seen.has(id), markSeen: (id) => seen.add(id), needsBaseline: () => false, baselineDone: () => {}, attachWaitMs: 200, chooserMs: 3000 });
  await gm.start();
  try {
    await until(() => gm.status().state === 'connected', 40000, 'connected');
    const img = path.join(dataDir, 'pic-covered.png');
    fs.writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    const conv = () => st.convs.find(c => c.id === '101');
    const before = conv().msgs.filter(m => m.out).length;
    await gm.send({ convId: '101', text: 'the picture', media: img, mediaUrl: 'https://msg.example.com/m/tok/pic.png' });
    const out = conv().msgs.filter(m => m.out).slice(before);
    assert.ok(out.some(m => m.media === 'pic-covered.png'), 'the picture itself was attached: ' + JSON.stringify(out));
    assert.ok(!out.some(m => /example\.com/.test(m.text || '')), 'no link was texted');
  } finally { await gm.stop(); }
});

test('when nothing can attach, the error leads with the per-route codes', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 120000 }, async () => {
  st.mode = 'connected'; st.attachMode = 'none'; st.noAttach = true;
  const { GoogleMessagesWeb } = await import('../src/channels/gmweb.js');
  const seen = new Set();
  const gm = new GoogleMessagesWeb({ dataDir, isSeen: (id) => seen.has(id), markSeen: (id) => seen.add(id), needsBaseline: () => false, baselineDone: () => {}, attachWaitMs: 200, chooserMs: 1000 });
  await gm.start();
  try {
    await until(() => gm.status().state === 'connected', 40000, 'connected');
    const img = path.join(dataDir, 'pic-none.png');
    fs.writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    await assert.rejects(gm.send({ convId: '101', text: 'the picture', media: img, mediaUrl: 'https://msg.example.com/m/tok/pic.png' }), (e) => {
      assert.match(e.message, /attach failed \[btn:absent \| btnJS:absent \| keys:no-chooser \| box:absent \| boxJS:absent \| paste:no \| drop:no\]/, 'codes lead the error: ' + e.message);
      return true;
    });
  } finally { await gm.stop(); }
});
