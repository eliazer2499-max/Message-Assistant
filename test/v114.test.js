// 1.1.4: (a) reactions — the emoji fits what the person asked (🔍 search, 🎵 song, ⏰ reminder), reacted on
// their own message through the channel; plain chat gets none. (b) YouTube/YouTube Music: a PREVIEW first
// (thumbnail picture + title, artist, release date, length) and the audio only after the person says yes.
// (c) audio files never fall back to a link when attaching.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
// a tiny thumbnail server + a fake yt-dlp that knows the video's details
const THUMB = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwEf/9k=', 'base64');
const thumbSrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(THUMB); });
await new Promise(r => thumbSrv.listen(0, '127.0.0.1', r));
const THUMB_URL = `http://127.0.0.1:${thumbSrv.address().port}/thumb.jpg`;
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-fake-ytdlp114-'));
const fake = path.join(fakeDir, 'yt-dlp');
fs.writeFileSync(fake, `#!/usr/bin/env node
const { execFileSync } = require('child_process');
if (process.argv[2] === '--version') { console.log('2026.01.01'); process.exit(0); }
if (process.argv.includes('--get-title')) { console.log('Fake Song Title'); process.exit(0); }
if (process.argv.includes('--dump-single-json')) { console.log(JSON.stringify({ id: 'abc123XYZ09', title: 'Fake Song Title', uploader: 'Fake Singer', upload_date: '20210305', duration: 253, thumbnail: '${THUMB_URL}', webpage_url: 'https://www.youtube.com/watch?v=abc123XYZ09' })); process.exit(0); }
const i = process.argv.indexOf('-o'); const out = process.argv[i + 1].replace('%(ext)s', 'mp3');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=130', '-codec:a', 'libmp3lame', '-q:a', '4', out]);
console.log('fake download ok');
`, { mode: 0o755 });
import { setupEnv } from './helpers.js';
setupEnv('v114', { MSA_ADMIN_PHONE: '+16465550100', MSA_PUBLIC_URL: 'https://msg.example.com', MSA_YTDLP: fake, MSA_PART_SECONDS: '60', MSA_ALLOW_LOCAL: '1' });
import test from 'node:test';
import assert from 'node:assert/strict';
const db = await import('../src/db.js');
db.openDb();
const users = await import('../src/users.js');
const tools = await import('../src/tools/index.js');
const media = await import('../src/tools/media.js');
const { reactionFor } = await import('../src/reactions.js');
const outbox = await import('../src/outbox.js');
const { MockChannel } = await import('../src/channels/mock.js');
const { isAudioFile } = await import('../src/channels/gmweb.js');
const u = users.arrive({ phone: '+16465550197', name: 'Chaim', text: 'hi' }).user;
test.after(() => { thumbSrv.close(); });

test('the reaction fits the request, like a human would pick it', () => {
  assert.equal(reactionFor('look for the nearest pharmacy'), '🔍');
  assert.equal(reactionFor('can you search for a good price on tires?'), '🔍');
  assert.equal(reactionFor('find me that song from youtube music'), '🎵');
  assert.equal(reactionFor('remind me at 5pm to call mom'), '⏰');
  assert.equal(reactionFor('thank you so much!'), '❤️');
  assert.equal(reactionFor('tell me a joke'), '😂');
  assert.equal(reactionFor('send me the file please'), '👍');
  assert.equal(reactionFor('yes'), '👍');
  assert.equal(reactionFor('the weather is nice today'), '');
  assert.equal(reactionFor(''), '');
});

test('the reaction lands on the person’s own message through the channel', async () => {
  const ch = new MockChannel(); await ch.start();
  outbox.attachChannel(ch);
  db.run('UPDATE users SET conv_id=? WHERE id=?', ch.convFor(u.phone), u.id);
  outbox.enqueueReaction({ userId: u.id, emoji: '🔍' });
  await outbox.drain();
  assert.equal(ch.reactions.length, 1);
  assert.equal(ch.reactions[0].emoji, '🔍');
  assert.equal(ch.reactions[0].convId, ch.convFor(u.phone));
  outbox.attachChannel(null);
});

test('YouTube Music preview: thumbnail + details first, audio only after the yes', async (t) => {
  if (!(await media.ffmpegOk())) { t.skip('no ffmpeg here'); return; }
  assert.equal(media._test.fmtDate('20210305'), 'March 5, 2021');
  assert.equal(media._test.durText(253), '4:13');
  const ctx = { userId: u.id, files: [] };
  const p = await tools.execTool('youtube_audio', { query: 'fake song', source: 'music' }, ctx);
  assert.equal(p.preview, true, JSON.stringify(p));
  assert.equal(p.title, 'Fake Song Title'); assert.equal(p.by, 'Fake Singer');
  assert.equal(p.released, 'March 5, 2021'); assert.equal(p.duration, '4:13');
  assert.equal(p.thumbnail_attached, true);
  assert.equal(ctx.files.length, 1); assert.match(ctx.files[0].media.file, /\.jpg$/, 'the thumbnail picture, not audio');
  // no yes yet → a second preview does not download either; confirm sends the audio (130 s → 3 parts of 60 s)
  const r = await tools.execTool('youtube_audio', { confirm: true }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.parts, 3);
  assert.equal(ctx.files.filter(f => /\.mp3$/.test(f.media.file)).length, 3);
  const again = await tools.execTool('youtube_audio', { confirm: true }, ctx);
  assert.match(again.error, /no video waiting/i, 'the yes is used once');
});

test('audio files are the ones that never fall back to a link', () => {
  assert.equal(isAudioFile('/data/media/x/part01.mp3'), true);
  assert.equal(isAudioFile('voice.m4a'), true);
  assert.equal(isAudioFile('song.ogg'), true);
  assert.equal(isAudioFile('site.png'), false);
  assert.equal(isAudioFile('photo.jpg'), false);
});
