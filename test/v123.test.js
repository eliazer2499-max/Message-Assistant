// 1.1.11, driver level: a voice note and a picture arrive in the (fake) Messages page; the real driver in
// real Chromium must spot them, download the actual bytes from the page, and hand them to the AI on the
// person's turn — and the AI's answer must come back into the same chat.
import { setupEnv, until, sleep } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeMessages, FAKE_MEDIA } from './fake-gm.js';
const { st, fake } = fakeMessages();
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-media.js');
setupEnv('v123', { MSA_CHANNEL: 'web', MSA_GM_URL: `http://127.0.0.1:${fake.address().port}/web`, MSA_POLL_MS: '300', MSA_HEALTH_MS: '500', MSA_MOCK_MODULE: MOCK, MSA_ADMIN_PHONE: '+16465550100' });
import test from 'node:test';
import assert from 'node:assert/strict';
test.after(() => { fake.close(); fake.closeAllConnections?.(); });

test('the driver downloads an incoming voice note and picture and the AI receives the bytes', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 150000 }, async () => {
  st.mode = 'connected';
  st.convs.length = 0;
  st.convs.push({ id: '301', name: '+1 646-555-0100', unread: false, msgs: [{ id: 'a0', out: false, text: 'old admin text' }] });
  const { main } = await import('../src/server.js');
  const db = await import('../src/db.js');
  const mockMedia = await import('./mock-media.js');
  const app = await main({ port: 0 });
  const conv = () => st.convs.find(c => c.id === '301');
  try {
    await until(() => app.channel.status().state === 'connected', 30000, 'connected');
    await until(() => db.setting('gm_baseline_done') === '1', 10000, 'baseline');
    // a voice note arrives (no text at all)
    conv().msgs.push({ id: 'vn1', out: false, text: '', media: 'audio' }); conv().unread = true;
    await until(() => mockMedia.calls.some(c => [...c].reverse().find(i => i.role === 'user')?.media?.[0]?.kind === 'audio'), 40000, 'the AI got the voice note');
    const turnA = [...mockMedia.calls.find(c => [...c].reverse().find(i => i.role === 'user')?.media?.length)].reverse().find(i => i.role === 'user');
    assert.equal(turnA.media[0].data, FAKE_MEDIA.mp3.toString('base64'), 'the actual bytes from the page, not a placeholder');
    await until(() => conv().msgs.some(m => m.out && /mock saw audio/.test(m.text)), 40000, 'the answer was typed back into the chat');
    // a picture with a caption arrives
    conv().msgs.push({ id: 'ph1', out: false, text: 'look at this', media: 'image' }); conv().unread = true;
    await until(() => mockMedia.calls.some(c => [...c].reverse().find(i => i.role === 'user')?.media?.[0]?.kind === 'image'), 40000, 'the AI got the picture');
    const turnB = [...mockMedia.calls.filter(c => [...c].reverse().find(i => i.role === 'user')?.media?.length).at(-1)].reverse().find(i => i.role === 'user');
    assert.equal(turnB.media[0].data, FAKE_MEDIA.png.toString('base64'), 'the actual picture bytes');
    assert.match(turnB.text, /look at this/, 'the caption rides along');
    await until(() => conv().msgs.some(m => m.out && /mock saw image/.test(m.text)), 40000, 'the picture answer came back too');
  } finally { await app.stop(); }
});
