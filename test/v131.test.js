// 1.1.20: two fixes from FLS's real-server evidence (2026-11-23). His brain.switch line read:
// "Switched from 'Gemini 1' to 'OpenRouter 1': error 400: Unable to process input: the file or media
// data is empty, corrupted, or malformed." — 1.1.19's capture DID hand over a file, but (a) playback
// loads a voice note in ranged pieces and the biggest single piece was kept as if it were the file,
// and (b) an m4a is a format the models refuse even when whole. Now: ranged pieces are reassembled
// into the complete file before anything is handed over, and incoming audio is converted to MP3
// once, when the router saves it (the original is kept when conversion is impossible).
// NOTE on order: the driver test runs FIRST — two app instances in one process share the gmweb
// Chromium profile, and a second instance's driver can lose its browser to the first instance's
// teardown; the router test does not depend on the driver at all, so it goes second.
import { setupEnv, until } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeMessages, FAKE_MEDIA } from './fake-gm.js';
const { st, fake } = fakeMessages();
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(HERE, 'mock-media.js');
setupEnv('v131', { MSA_CHANNEL: 'web', MSA_GM_URL: `http://127.0.0.1:${fake.address().port}/web`, MSA_POLL_MS: '300', MSA_HEALTH_MS: '500', MSA_MOCK_MODULE: MOCK, MSA_ADMIN_PHONE: '+16465550100' });
import test from 'node:test';
import assert from 'node:assert/strict';
test.after(() => { fake.close(); fake.closeAllConnections?.(); });

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 30000 }, (e, stdout, stderr) => e ? reject(new Error(String(stderr || e.message))) : resolve(stdout)));

test('a voice note that only ever arrives in ranged pieces reaches the AI whole, byte for byte', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 150000 }, async () => {
  st.mode = 'connected'; st.voicePlayer = true; st.voiceChunked = true;
  st.convs.length = 0;
  st.convs.push({ id: '311', name: '+1 646-555-0100', unread: false, msgs: [{ id: 'c0', out: false, text: 'old admin text' }] });
  const { main } = await import('../src/server.js');
  const db = await import('../src/db.js');
  const mockMedia = await import('./mock-media.js');
  const app = await main({ port: 0 });
  const conv = () => st.convs.find(c => c.id === '311');
  try {
    await until(() => app.channel.status().state === 'connected', 30000, 'connected');
    await until(() => db.setting('gm_baseline_done') === '1', 10000, 'baseline');
    const before = mockMedia.calls.length;
    conv().msgs.push({ id: 'vnC', out: false, text: '', media: 'audio' }); conv().unread = true;
    await until(() => mockMedia.calls.slice(before).some(c => [...c].reverse().find(i => i.role === 'user')?.media?.[0]?.kind === 'audio'), 60000, 'the AI got the reassembled voice note');
    const turn = [...mockMedia.calls.slice(before).find(c => [...c].reverse().find(i => i.role === 'user')?.media?.length)].reverse().find(i => i.role === 'user');
    assert.equal(turn.media[0].data, FAKE_MEDIA.mp3.toString('base64'), 'the pieces were put back together into the exact original bytes');
    await until(() => conv().msgs.some(m => m.out && /mock saw audio/.test(m.text)), 40000, 'the answer was typed back into the chat');
  } finally { st.voiceChunked = false; await app.stop(); }
});

test('a real m4a voice note is converted to MP3 before the AI gets it', { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(HERE, 'v131-'));
  const m4a = path.join(dir, 'tone.m4a');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-codec:a', 'aac', m4a]);
  const m4aBuf = fs.readFileSync(m4a);
  const { main } = await import('../src/server.js');
  const { handleIncoming } = await import('../src/router.js');
  const users = await import('../src/users.js');
  const mockMedia = await import('./mock-media.js');
  const app = await main({ port: 0 });
  try {
    const r0 = users.arrive({ phone: '+12125550177', convId: 'conv-v131', name: '', text: 'hi' });
    users.approve(r0.user.id, 'test');
    const u = users.userById(r0.user.id);
    const before = mockMedia.calls.length;
    const r = await handleIncoming({ phone: u.phone, convId: u.conv_id, name: '', text: '', extId: 'vn-m4a', media: [{ kind: 'audio', name: 'voice-note.m4a', mime: 'audio/mp4', data: m4aBuf.toString('base64') }] });
    assert.equal(r.action, 'run');
    await until(() => mockMedia.calls.length > before, 30000, 'the AI was called');
    const turn = [...mockMedia.calls[before]].reverse().find(i => i.role === 'user');
    assert.equal(turn.media?.[0]?.kind, 'audio');
    assert.equal(turn.media[0].mime, 'audio/mpeg', 'the AI receives mp3, not the m4a Gemini refused');
    assert.match(turn.media[0].name, /\.mp3$/, 'the saved name follows the conversion');
    const mp3 = Buffer.from(turn.media[0].data, 'base64');
    assert.notDeepEqual(mp3, m4aBuf, 'the bytes were really re-encoded');
    const out = path.join(dir, 'got.mp3'); fs.writeFileSync(out, mp3);
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'json', out]));
    assert.match(probe.format.format_name, /mp3/, 'ffprobe reads the converted file as mp3');
  } finally { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
