// 1.1.6: pictures and voice notes MUST go out on text. The old attachAndSend set the hidden file box and
// pressed Send blind; on the real Messages page the file could silently never stage, and the send died
// (in ≤1.1.4 it even fell back to a link). Now every attach route a person has is tried and VERIFIED:
// the attach button's file chooser, the Ctrl+K shortcut, the file box, and pasting the file itself.
// The fake page here offers each route in isolation ('chooser' has no file box at all; 'paste' has neither
// box nor button), so each strategy has to work on its own. Real Chromium; skipped without one.
import { setupEnv, until } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { fakeMessages } from './fake-gm.js';
const { st, fake } = fakeMessages();
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const dataDir = setupEnv('v117', { MSA_CHANNEL: 'web', MSA_GM_URL: `http://127.0.0.1:${fake.address().port}/web`, MSA_POLL_MS: '300', MSA_HEALTH_MS: '500' });
import test from 'node:test';
import assert from 'node:assert/strict';
test.after(() => { fake.close(); fake.closeAllConnections?.(); });

for (const mode of ['input', 'chooser', 'paste']) {
  test(`a picture is attached and sent when the page only allows: ${mode}`, { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 120000 }, async () => {
    st.mode = 'connected'; st.attachMode = mode; st.noAttach = false;
    const { GoogleMessagesWeb } = await import('../src/channels/gmweb.js');
    const seen = new Set();
    const gm = new GoogleMessagesWeb({ dataDir, isSeen: (id) => seen.has(id), markSeen: (id) => seen.add(id), needsBaseline: () => false, baselineDone: () => {}, attachWaitMs: 200, chooserMs: 5000 });
    await gm.start();
    try {
      await until(() => gm.status().state === 'connected', 40000, 'connected');
      const img = path.join(dataDir, 'pic-' + mode + '.png');
      fs.writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
      const conv = () => st.convs.find(c => c.id === '101');
      const before = conv().msgs.filter(m => m.out).length;
      await gm.send({ convId: '101', text: 'the picture for ' + mode, media: img, mediaUrl: 'https://msg.example.com/m/tok/pic.png' });
      const out = conv().msgs.filter(m => m.out).slice(before);
      assert.ok(out.some(m => m.media === 'pic-' + mode + '.png'), mode + ': the picture itself was attached: ' + JSON.stringify(out));
      assert.ok(!out.some(m => /example\.com/.test(m.text || '')), mode + ': no link was texted');
    } finally { await gm.stop(); }
  });
}
