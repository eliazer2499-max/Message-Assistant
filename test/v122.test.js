// 1.1.11: incoming media. A voice note / picture a person sends TO the assistant is no longer skipped in
// silence: the driver downloads it from the Messages page, the router stores it, and the agent hands it
// to the AI on the person's own turn (search / reminders / everything then work as if they had typed).
// If the file can't be fetched, the person is told honestly instead of being ignored.
import { setupEnv, until, sleep } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(HERE, 'mock-media.js');
const ADMIN = '+16465550100';
setupEnv('v122', { MSA_MOCK_MODULE: MOCK, MSA_ADMIN_PHONE: ADMIN, MSA_PUBLIC_URL: 'https://msg.example.com' });
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const { handleIncoming } = await import('../src/router.js');
const users = await import('../src/users.js');
const db = await import('../src/db.js');
const mockMedia = await import('./mock-media.js');

const MP3 = Buffer.from('voice-note-bytes-for-the-router-test');
const PNG = Buffer.from('89504e470d0a1a0a-picture-bytes', 'latin1');

function approvedUser(phone) {
  const r = users.arrive({ phone, convId: 'conv-' + phone, name: '', text: 'hi' });
  users.approve(r.user.id, 'test');
  return users.userById(r.user.id);
}

test('a voice note reaches the AI as audio on the person\u2019s turn; a failed picture is answered honestly', async () => {
  const app = await main({ port: 0 });
  try {
    const u = approvedUser('+12125550199');
    const r1 = await handleIncoming({ phone: u.phone, convId: u.conv_id, name: '', text: '', extId: 'vn-1', media: [{ kind: 'audio', name: 'voice.mp3', mime: 'audio/mpeg', data: MP3.toString('base64') }] });
    assert.equal(r1.action, 'run');
    const job = db.get('SELECT * FROM jobs WHERE user_id=? ORDER BY id DESC LIMIT 1', u.id);
    assert.ok(job.media && JSON.parse(job.media)[0].kind === 'audio', 'the job carries the media token');
    await until(() => mockMedia.calls.length >= 1, 8000, 'the AI was called');
    const turn = [...mockMedia.calls[0]].reverse().find(i => i.role === 'user');
    assert.equal(turn.media?.[0]?.kind, 'audio');
    assert.equal(Buffer.from(turn.media[0].data, 'base64').toString(), MP3.toString(), 'the actual voice-note bytes reached the AI');

    const r2 = await handleIncoming({ phone: u.phone, convId: u.conv_id, name: '', text: '', extId: 'ph-fail', mediaFailed: 'image' });
    assert.equal(r2.action, 'run');
    await until(() => mockMedia.calls.length >= 2, 8000, 'the AI was called for the failed picture');
    const turn2 = [...mockMedia.calls[1]].reverse().find(i => i.role === 'user');
    assert.match(turn2.text, /could not be opened/, 'the AI is told to answer honestly, not to stay silent');
    assert.ok(!turn2.media?.length, 'no media rides when the fetch failed');
  } finally { await app.stop(); }
});
