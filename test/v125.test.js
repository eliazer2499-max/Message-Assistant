// 1.1.13: THE crash. On FLS's server the log showed the app dying on every media send — restart counter
// 77+ — from an UNHANDLED rejection: attachAndSend created a filechooser promise, the attach-button
// click threw before the promise was awaited, and 6 s later its timeout rejection killed the whole
// Node process ("the server goes down every few minutes", pictures failing, the assistant going deaf).
// The fix attaches the catch when the promise is created. This test drives the exact shape: an attach
// button that can never be clicked (disabled), so the click throws and the chooser times out alone.
// Before the fix the rejection escapes and takes this test process with it; after it, the send falls
// through to paste and goes out, and the driver stays healthy.
import { setupEnv, until, sleep } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { fakeMessages } from './fake-gm.js';
const { st, fake } = fakeMessages();
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const dataDir = setupEnv('v125', { MSA_CHANNEL: 'web', MSA_GM_URL: `http://127.0.0.1:${fake.address().port}/web`, MSA_POLL_MS: '300', MSA_HEALTH_MS: '500' });
import test from 'node:test';
import assert from 'node:assert/strict';
test.after(() => { fake.close(); fake.closeAllConnections?.(); });

test('a dead attach button cannot crash the process; the picture still goes out (paste) and the driver lives', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 120000 }, async () => {
  st.mode = 'connected'; st.attachMode = 'deadchooser'; st.noAttach = false;
  const { GoogleMessagesWeb } = await import('../src/channels/gmweb.js');
  const seen = new Set();
  const gm = new GoogleMessagesWeb({ dataDir, isSeen: (id) => seen.has(id), markSeen: (id) => seen.add(id), needsBaseline: () => false, baselineDone: () => {}, attachWaitMs: 200, chooserMs: 1200 });
  await gm.start();
  try {
    await until(() => gm.status().state === 'connected', 40000, 'connected');
    const img = path.join(dataDir, 'pic-dead.png');
    fs.writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    const conv = () => st.convs.find(c => c.id === '101');
    const before = conv().msgs.filter(m => m.out).length;
    await gm.send({ convId: '101', text: 'the picture', media: img, mediaUrl: 'https://msg.example.com/m/tok/pic.png' });
    const out = conv().msgs.filter(m => m.out).slice(before);
    assert.ok(out.some(m => m.media === 'pic-dead.png'), 'the picture itself was attached (via paste): ' + JSON.stringify(out));
    await sleep(2500);   // any orphaned chooser rejection would have fired by now and killed this process
    await gm.send({ convId: '101', text: 'still alive' });
    assert.ok(conv().msgs.some(m => m.out && m.text === 'still alive'), 'the driver is still healthy after the dead-chooser send');
  } finally { await gm.stop(); }
});
