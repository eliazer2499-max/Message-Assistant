// 1.1.23: "I'm having technical trouble playing that video right now because the file is too large
// for my system to process" (FLS's screenshot, 2026-11-24) — youtubeToFile downloaded the whole
// VIDEO and extracted the sound afterwards, so a long video died on the 200 MB cap even though its
// audio was small. The download now asks yt-dlp for the audio-only stream ('bestaudio/best') and the
// cap guards that stream. A fake yt-dlp records its arguments so the test can hold the tool to it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-fake-ytdlp136-'));
const argvLog = path.join(fakeDir, 'argv.jsonl');
const fake = path.join(fakeDir, 'yt-dlp');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === '--version') { console.log('2026.01.01'); process.exit(0); }
if (process.argv.includes('--dump-single-json')) { console.log(JSON.stringify({ id: 'jNQXAC9IVRw', title: 'Me at the zoo', uploader: 'jawed', upload_date: '20050424', duration: 19, thumbnail: '', webpage_url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' })); process.exit(0); }
const i = process.argv.indexOf('-o'); const out = process.argv[i + 1].replace('%(ext)s', 'mp3');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', out]);
console.log('fake yt-dlp downloaded to ' + out);
`, { mode: 0o755 });
import { setupEnv } from './helpers.js';
setupEnv('v136', { MSA_ADMIN_PHONE: '+16465550100', MSA_PUBLIC_URL: 'https://msg.example.com', MSA_YTDLP: fake, MSA_ALLOW_LOCAL: '1' });
import test from 'node:test';
import assert from 'node:assert/strict';
const db = await import('../src/db.js'); db.openDb();
const tools = await import('../src/tools/index.js');
const media = await import('../src/tools/media.js');
const users = await import('../src/users.js');
const u136 = users.arrive({ phone: '+16465550196', name: 'Yaakov', text: 'hi' }).user;

test('the YouTube download takes the audio-only stream, not the whole video', async (t) => {
  if (!(await media.ffmpegOk())) { t.skip('no ffmpeg here'); return; }
  const ctx = { userId: u136.id, files: [] };
  const p = await tools.execTool('youtube_audio', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }, ctx);
  assert.equal(p.preview, true, JSON.stringify(p));
  const r = await tools.execTool('youtube_audio', { confirm: true }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  const calls = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const dl = calls.find(a => a.includes('-o'));
  assert.ok(dl, 'a download happened: ' + JSON.stringify(calls));
  const fi = dl.indexOf('-f');
  assert.ok(fi >= 0 && /bestaudio/.test(dl[fi + 1] || ''), 'the format asked for is the audio-only stream: ' + JSON.stringify(dl));
  const mi = dl.indexOf('--max-filesize');
  assert.ok(mi >= 0 && dl[mi + 1] === '600M', 'the size cap guards the audio stream at 600M: ' + JSON.stringify(dl));
});
