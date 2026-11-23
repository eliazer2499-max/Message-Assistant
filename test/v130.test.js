// 1.1.17: a voice note on the REAL Messages page is a custom player with no file address until it plays —
// 1.1.11's fetch found no src and no download, so the assistant told FLS "I couldn't open your voice note"
// (his screenshot, 2026-11-22). The driver now presses play and captures the sound as it loads. The fake
// renders the player kind (st.voicePlayer): a labelled div, no <audio> element or src anywhere, until a
// click creates one and starts playback.
import { setupEnv, until } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeMessages, FAKE_MEDIA } from './fake-gm.js';
const { st, fake } = fakeMessages();
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-media.js');
setupEnv('v130', { MSA_CHANNEL: 'web', MSA_GM_URL: `http://127.0.0.1:${fake.address().port}/web`, MSA_POLL_MS: '300', MSA_HEALTH_MS: '500', MSA_MOCK_MODULE: MOCK, MSA_ADMIN_PHONE: '+16465550100' });
import test from 'node:test';
import assert from 'node:assert/strict';
test.after(() => { fake.close(); fake.closeAllConnections?.(); });

test('a player-style voice note (no address until it plays) still reaches the AI, byte for byte', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 150000 }, async () => {
  st.mode = 'connected'; st.voicePlayer = true;
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
    conv().msgs.push({ id: 'vn9', out: false, text: '', media: 'audio' }); conv().unread = true;
    await until(() => mockMedia.calls.some(c => [...c].reverse().find(i => i.role === 'user')?.media?.[0]?.kind === 'audio'), 60000, 'the AI got the played voice note');
    const turn = [...mockMedia.calls.find(c => [...c].reverse().find(i => i.role === 'user')?.media?.length)].reverse().find(i => i.role === 'user');
    assert.equal(turn.media[0].data, FAKE_MEDIA.mp3.toString('base64'), 'the actual bytes, captured by playing the note');
    await until(() => conv().msgs.some(m => m.out && /mock saw audio/.test(m.text)), 40000, 'the answer was typed back into the chat');
  } finally { await app.stop(); }
});

test('a voice note that never loads still answers honestly — and the failure is readable in the Activity log', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 180000 }, async () => {
  st.mode = 'connected'; st.voicePlayer = true; st.voiceBroken = true;
  st.convs.length = 0;
  st.convs.push({ id: '302', name: '+1 646-555-0100', unread: false, msgs: [{ id: 'b0', out: false, text: 'old admin text' }] });
  const { main } = await import('../src/server.js');
  const db = await import('../src/db.js');
  const app = await main({ port: 0 });
  const conv = () => st.convs.find(c => c.id === '302');
  try {
    await until(() => app.channel.status().state === 'connected', 30000, 'connected');
    await until(() => db.setting('gm_baseline_done') === '1', 10000, 'baseline');
    conv().msgs.push({ id: 'vnX', out: false, text: '', media: 'audio' }); conv().unread = true;
    const rows = await until(() => { const r = db.all("SELECT detail FROM audit WHERE action='media.incoming_failed'"); return r.length ? r : null; }, 120000, 'the failure diagnosis in the audit log');
    assert.match(rows[0].detail, /audio: element .* no file address/, 'stage 1 named: ' + rows[0].detail);
    assert.match(rows[0].detail, /play: pressing/, 'the play attempt named: ' + rows[0].detail);
    assert.match(rows[0].detail, /nothing loaded/, 'the outcome named: ' + rows[0].detail);
  } finally { st.voiceBroken = false; await app.stop(); }
});
