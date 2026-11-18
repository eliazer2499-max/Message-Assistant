// 1.1.2: "go to YouTube, find X, send it to me" — the people using the assistant have NO internet, so the
// assistant searches YouTube itself, downloads the audio (yt-dlp) and the audio FILE is attached to the reply
// like a voice note. A YouTube link is never the answer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// a fake yt-dlp: --version works; a "download" writes a 2-second mp3 where the -o template says
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-fake-ytdlp-'));
const fake = path.join(fakeDir, 'yt-dlp');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
if (process.argv[2] === '--version') { console.log('2026.01.01'); process.exit(0); }
const i = process.argv.indexOf('-o'); const out = process.argv[i + 1].replace('%(ext)s', 'mp3');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', out]);
console.log('fake yt-dlp downloaded to ' + out);
`, { mode: 0o755 });
import { setupEnv } from './helpers.js';
setupEnv('v112', { MSA_ADMIN_PHONE: '+16465550100', MSA_PUBLIC_URL: 'https://msg.example.com', MSA_YTDLP: fake, MSA_ALLOW_LOCAL: '1' });
import test from 'node:test';
import assert from 'node:assert/strict';
const db = await import('../src/db.js');
db.openDb();
const tools = await import('../src/tools/index.js');
const media = await import('../src/tools/media.js');

test('YouTube search results are parsed (id, title, length)', () => {
  const html = 'x"videoRenderer":{"videoId":"jNQXAC9IVRw","thumbnail":{},"title":{"runs":[{"text":"Me at the zoo"}],"navigationEndpoint":{}},"lengthText":{"accessibility":{},"simpleText":"0:19"} y "videoRenderer":{"videoId":"dQw4w9WgXcQ","title":{"runs":[{"text":"Rick Astley - Never Gonna Give You Up (Official Video)"}]},"lengthText":{"simpleText":"3:33"}';
  const v = media.parseYoutubeSearch(html);
  assert.equal(v.length, 2);
  assert.equal(v[0].id, 'jNQXAC9IVRw');
  assert.equal(v[0].title, 'Me at the zoo');
  assert.equal(v[0].duration, '0:19');
  assert.equal(v[1].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(media.isYoutubeUrl('https://youtu.be/jNQXAC9IVRw'), true);
  assert.equal(media.isYoutubeUrl('https://example.com/clip.mp4'), false);
});

test('youtube_audio: the audio file itself is attached (never a link)', async (t) => {
  if (!(await media.ffmpegOk())) { t.skip('no ffmpeg here'); return; }
  assert.equal(await media.ytdlpPath(), fake);
  const ctx = { userId: 999, files: [] };
  const r = await tools.execTool('youtube_audio', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ctx.files.length, 1, 'one attachment queued for the reply');
  assert.ok(fs.existsSync(ctx.files[0].media.file), 'the audio file exists on the server');
  assert.match(ctx.files[0].media.file, /\.mp3$/);
  assert.ok(r.audio_duration_seconds >= 1);
  assert.doesNotMatch(JSON.stringify(r), /youtube\.com\/watch/, 'no YouTube link in the result');
  // extract_audio with a YouTube link takes the same road
  const ctx2 = { userId: 999, files: [] };
  const r2 = await tools.execTool('extract_audio', { url: 'https://youtu.be/jNQXAC9IVRw' }, ctx2);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(ctx2.files.length, 1);
  assert.ok(tools.TOOLS.some(x => x.name === 'youtube_audio'), 'the tool is offered to the AI');
});
