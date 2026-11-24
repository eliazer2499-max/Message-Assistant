// 1.1.22: "it doesn't always read voice notes, only sometimes" (FLS). Three holes made it intermittent:
// (1) captureByPlaying accepted a 206 ranged response as the WHOLE file whenever its Content-Range
//     had no plain numeric total ("bytes 0-99/*") — a fragment went to the model, Gemini refused it
//     (400), and the note went unread; whether a note failed depended on how it was served that time.
//     A 206 is now never a whole file (except a single range that IS the whole file); unplaceable
//     pieces are counted in the diagnosis instead. (2) A failed MP3 conversion silently kept the
//     original format — now audited as media.audio_unconverted with ffmpeg's reason. (3) When the
//     hearing key was resting, a deaf key answered the note from the "cannot open it" text — a job
//     with audio now waits for a hearing key that is only resting (hearingWaitAt).
// NOTE on order (the v131 lesson): the driver test runs FIRST in this file.
import { setupEnv, until } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeMessages } from './fake-gm.js';
const { st, fake } = fakeMessages();
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(HERE, 'mock-media.js');
setupEnv('v135', { MSA_CHANNEL: 'web', MSA_GM_URL: `http://127.0.0.1:${fake.address().port}/web`, MSA_POLL_MS: '300', MSA_HEALTH_MS: '500', MSA_MOCK_MODULE: MOCK, MSA_ADMIN_PHONE: '+16465550100' });
import test from 'node:test';
import assert from 'node:assert/strict';
test.after(() => { fake.close(); fake.closeAllConnections?.(); });
const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 30000 }, (e, stdout, stderr) => e ? reject(new Error(String(stderr || e.message))) : resolve(stdout)));

test('a voice note served only as star-range pieces is NEVER handed to the AI as a fragment', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 150000 }, async () => {
  st.mode = 'connected'; st.voicePlayer = true; st.voiceStarRange = true;
  st.convs.length = 0;
  st.convs.push({ id: '312', name: '+1 646-555-0100', unread: false, msgs: [{ id: 's0', out: false, text: 'old admin text' }] });
  const { main } = await import('../src/server.js');
  const db = await import('../src/db.js');
  const mockMedia = await import('./mock-media.js');
  const app = await main({ port: 0 });
  const conv = () => st.convs.find(c => c.id === '312');
  try {
    await until(() => app.channel.status().state === 'connected', 30000, 'connected');
    await until(() => db.setting('gm_baseline_done') === '1', 10000, 'baseline');
    const before = mockMedia.calls.length;
    conv().msgs.push({ id: 'vnS', out: false, text: '', media: 'audio' }); conv().unread = true;
    await until(() => db.all("SELECT detail FROM audit WHERE action='media.incoming_failed'").some(r => /no usable size header/.test(r.detail)), 90000, 'the failure line names the unplaceable pieces');
    const sawAudio = mockMedia.calls.slice(before).some(c => [...c].reverse().find(i => i.role === 'user')?.media?.some(m => m.kind === 'audio'));
    assert.equal(sawAudio, false, 'no fragment ever reached the AI as if it were the voice note');
    await until(() => mockMedia.calls.slice(before).some(c => /could not be opened/.test([...c].reverse().find(i => i.role === 'user')?.text || '')), 60000, 'the job still ran honestly, without the note');
  } finally { st.voiceStarRange = false; await app.stop(); }
});

test('hearingWaitAt: a voice-note job waits only when a hearing key exists and is merely resting', async () => {
  const db = await import('../src/db.js'); db.openDb();
  const { hearingWaitAt } = await import('../src/aikeys.js');
  const t = Date.now();
  const gemFree = { kind: 'gemini', model: 'gm', cool_until: 0, problem: null, caps: null };
  const gemRest = { kind: 'gemini', model: 'gm', cool_until: t + 60000, problem: null, caps: null };
  const gemBroken = { kind: 'gemini', model: 'gm', cool_until: 0, problem: 'model not found', caps: null };
  const oaDeaf = { kind: 'openai', model: 'om', base_url: 'https://x', cool_until: 0, problem: null, caps: null };
  const oaHearCaps = JSON.stringify({ kind: 'openai', model: 'om', base_url: 'https://x', audio: true });
  const oaHearFree = { kind: 'openai', model: 'om', base_url: 'https://x', cool_until: 0, problem: null, caps: oaHearCaps };
  const oaHearRest = { kind: 'openai', model: 'om', base_url: 'https://x', cool_until: t + 30000, problem: null, caps: oaHearCaps };
  assert.equal(hearingWaitAt([gemFree, oaDeaf], t), 0, 'a hearing key is free — no wait');
  assert.equal(hearingWaitAt([gemRest, oaDeaf], t), t + 60000, 'the hearing key is resting — wait for it, do not let the deaf key answer');
  assert.equal(hearingWaitAt([oaDeaf], t), 0, 'no hearing key exists at all — proceed as before');
  assert.equal(hearingWaitAt([gemBroken, oaDeaf], t), 0, 'a broken hearing key is not worth waiting for');
  assert.equal(hearingWaitAt([gemRest, oaHearRest], t), t + 30000, 'the earliest hearing key sets the wait');
  assert.equal(hearingWaitAt([gemRest, oaHearFree], t), 0, 'a tested OpenAI key that can hear counts as hearing');
});

test('a voice note that cannot be converted leaves its reason in the Activity log; a real one converts quietly', { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(HERE, 'v135-'));
  const m4a = path.join(dir, 'tone.m4a');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-codec:a', 'aac', m4a]);
  const m4aBuf = fs.readFileSync(m4a);
  const { main } = await import('../src/server.js');
  const db = await import('../src/db.js');
  const { handleIncoming } = await import('../src/router.js');
  const users = await import('../src/users.js');
  const mockMedia = await import('./mock-media.js');
  const app = await main({ port: 0 });
  try {
    const r0 = users.arrive({ phone: '+12125550176', convId: 'conv-v135', name: '', text: 'hi' });
    users.approve(r0.user.id, 'test');
    const u = users.userById(r0.user.id);
    const count = () => db.all("SELECT detail FROM audit WHERE action='media.audio_unconverted'").length;
    assert.equal(count(), 0);
    const fakeBuf = Buffer.from('fake-voice-note-bytes-1.1.11');
    const preFake = mockMedia.calls.length;
    await handleIncoming({ phone: u.phone, convId: u.conv_id, name: '', text: '', extId: 'vn-fake', media: [{ kind: 'audio', name: 'voice-note.m4a', mime: 'audio/mp4', data: fakeBuf.toString('base64') }] });
    assert.equal(count(), 1, 'the failed conversion is in the Activity log');
    assert.match(db.all("SELECT detail FROM audit WHERE action='media.audio_unconverted'")[0].detail, /conversion failed/i, 'with the reason');
    await until(() => mockMedia.calls.length > preFake, 30000, 'the AI was called for the fake note');   // let that job finish before timing the real one
    const before = mockMedia.calls.length;
    await handleIncoming({ phone: u.phone, convId: u.conv_id, name: '', text: '', extId: 'vn-real', media: [{ kind: 'audio', name: 'voice-note.m4a', mime: 'audio/mp4', data: m4aBuf.toString('base64') }] });
    assert.equal(count(), 1, 'a note that converts leaves no such line');
    await until(() => mockMedia.calls.length > before, 30000, 'the AI was called for the real note');
    const turn = [...mockMedia.calls[before]].reverse().find(i => i.role === 'user');
    assert.equal(turn.media?.[0]?.mime, 'audio/mpeg', 'the real note still arrives as mp3');
  } finally { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
