// 1.1.3: (a) YouTube Music works too, and long audio is sent IN FULL as several voice-note parts in order
// (never cut off at an hour); (b) Connect accounts: a person may connect with their OWN Google keys or the
// system ones — the admin toggle (on by default) turns own keys off. Fake Google + fake yt-dlp here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
// fake yt-dlp: --version, --get-title, and a "download" that writes a 130-second mp3
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-fake-ytdlp113-'));
const fake = path.join(fakeDir, 'yt-dlp');
fs.writeFileSync(fake, `#!/usr/bin/env node
const { execFileSync } = require('child_process');
if (process.argv[2] === '--version') { console.log('2026.01.01'); process.exit(0); }
if (process.argv.includes('--get-title')) { console.log('Fake Song Title'); process.exit(0); }
if (process.argv.includes('--dump-single-json')) { console.log(JSON.stringify({ id: 'jNQXAC9IVRw', title: 'Fake Song Title', uploader: 'Fake Singer', upload_date: '20210305', duration: 130, thumbnail: '', webpage_url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' })); process.exit(0); }
const i = process.argv.indexOf('-o'); const out = process.argv[i + 1].replace('%(ext)s', 'mp3');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=130', '-codec:a', 'libmp3lame', '-q:a', '4', out]);
console.log('fake download ok');
`, { mode: 0o755 });
// fake Google: two clients — the system one and a person's own one; wrong secret pairing fails
const G = { tokenClient: [], refreshClient: [] };
const fakeG = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const u = new URL(req.url, 'http://x'); const j = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/token') {
    const f = new URLSearchParams(b);
    const okPair = (f.get('client_id') === 'sys-1.apps.googleusercontent.com' && f.get('client_secret') === 'system-secret-123') || (f.get('client_id') === 'own-1.apps.googleusercontent.com' && f.get('client_secret') === 'own-secret-12345');
    if (!okPair) return j({ error: 'invalid_client' }, 401);
    if (f.get('grant_type') === 'authorization_code') { G.tokenClient.push(f.get('client_id')); return j({ access_token: 'ya29.fake', refresh_token: '1//fake-refresh', expires_in: 1, scope: 'openid email', token_type: 'Bearer' }); }
    if (f.get('grant_type') === 'refresh_token') { G.refreshClient.push(f.get('client_id')); return j({ access_token: 'ya29.fake2', expires_in: 3600, token_type: 'Bearer' }); }
    return j({ error: 'unsupported_grant_type' }, 400);
  }
  if (u.pathname === '/userinfo') return j({ email: 'moshe@example.com' });
  if (u.pathname === '/gmail/v1/users/me/messages') return j({ messages: [{ id: 'm1' }] });
  if (u.pathname === '/gmail/v1/users/me/messages/m1') return j({ snippet: 'Hi', labelIds: [], payload: { headers: [{ name: 'From', value: 'Shop' }, { name: 'Subject', value: 'Shipped' }, { name: 'Date', value: 'today' }] } });
  j({ error: 'nope' }, 404);
});
await new Promise(r => fakeG.listen(0, '127.0.0.1', r));
const GB = `http://127.0.0.1:${fakeG.address().port}`;
import { setupEnv } from './helpers.js';
setupEnv('v113', { MSA_ADMIN_PHONE: '+16465550100', MSA_PUBLIC_URL: 'https://msg.example.com', MSA_YTDLP: fake, MSA_PART_SECONDS: '60',
  MSA_GOOGLE_AUTH_URL: GB + '/auth', MSA_GOOGLE_TOKEN_URL: GB + '/token', MSA_GOOGLE_API_URL: GB, MSA_GOOGLE_USERINFO_URL: GB + '/userinfo', MSA_GOOGLE_REVOKE_URL: GB + '/revoke' });
import test from 'node:test';
import assert from 'node:assert/strict';
const db = await import('../src/db.js');
const { loadMasterKey } = await import('../src/crypto.js');
const { cfg } = await import('../src/config.js');
loadMasterKey(cfg.dataDir);
db.openDb();
const INTEG = await import('../src/integrations.js');
const users = await import('../src/users.js');
const tools = await import('../src/tools/index.js');
const media = await import('../src/tools/media.js');
const u = users.arrive({ phone: '+16465550199', name: 'Moshe', text: 'hi' }).user;
test.after(() => { fakeG.close(); });

test('Google connect: each person connects their OWN Google account with the system client; the admin option turns it off', async () => {
  assert.equal(INTEG.googleEnabled(), true, 'Google connect on by default');
  assert.equal(INTEG.googleSetup().ready, false, 'no system client yet');
  assert.throws(() => INTEG.startGoogle(u.id), /not set up yet/);
  INTEG.setGoogleClient({ client_id: 'sys-1.apps.googleusercontent.com', client_secret: 'system-secret-123' });
  const { url } = INTEG.startGoogle(u.id);
  assert.match(url, /client_id=sys-1\.apps\.googleusercontent\.com/, 'the connect starts with the system client');
  const st = db.get('SELECT * FROM oauth_states ORDER BY created DESC LIMIT 1');
  const fin = await INTEG.finishGoogle({ code: 'any', state: st.state });
  assert.equal(fin.account, 'moshe@example.com');
  assert.deepEqual(G.tokenClient, ['sys-1.apps.googleusercontent.com'], 'the code was exchanged with the system client');
  const mail = await INTEG.gmailRecent(u.id);           // access token is already "expired" (expires_in 1) → refresh with the system client
  assert.equal(mail.length, 1);
  assert.deepEqual(G.refreshClient, ['sys-1.apps.googleusercontent.com']);
  // the admin option off: connect refuses, the page hides the card (google_enabled=false)
  db.setSetting('google_connect_enabled', '0');
  assert.equal(INTEG.googleEnabled(), false);
  assert.throws(() => INTEG.startGoogle(u.id), /turned off/);
  db.setSetting('google_connect_enabled', '1');
});

test('long audio arrives IN FULL as voice-note parts, in order (YouTube and YouTube Music)', async (t) => {
  if (!(await media.ffmpegOk())) { t.skip('no ffmpeg here'); return; }
  // the splitter itself: 150 seconds, 60-second parts → 3 files
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-parts-'));
  const src = path.join(dir, 'long.mp3');
  const { execFileSync } = await import('node:child_process');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=150', '-codec:a', 'libmp3lame', '-q:a', '4', src]);
  const parts = await media._test.splitIntoParts(src, 'mp3', dir, 60);
  assert.equal(parts.files.length, 3);
  // through the tool (fake download is 130 s, parts are 60 s here): preview first (1.1.4), then 3 parts attached, named in order
  const ctx = { userId: u.id, files: [] };
  const pv = await tools.execTool('youtube_audio', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }, ctx);
  assert.equal(pv.preview, true, JSON.stringify(pv)); assert.ok(ctx.files.every(f => /\.jpg$/.test(f.media.file)), 'only the thumbnail before the yes');
  const r = await tools.execTool('youtube_audio', { confirm: true }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.parts, 3);
  const auds = ctx.files.filter(f => /\.mp3$/.test(f.media.file));
  assert.equal(auds.length, 3);
  const mname = (f) => db.get('SELECT name FROM media WHERE token=?', f.media.token).name;
  assert.match(mname(auds[0]), /part 1 of 3/); assert.match(mname(auds[2]), /part 3 of 3/);
  assert.ok(auds.every(f => fs.existsSync(f.media.file)));
  // YouTube Music: search words + source music → preview from Music, then the same parts treatment after the yes
  const ctx2 = { userId: u.id, files: [] };
  const pv2 = await tools.execTool('youtube_audio', { query: 'some song', source: 'music' }, ctx2);
  assert.equal(pv2.preview, true, JSON.stringify(pv2));
  assert.equal(pv2.source, 'YouTube Music'); assert.equal(pv2.title, 'Fake Song Title');
  const r2 = await tools.execTool('youtube_audio', { confirm: true }, ctx2);
  assert.equal(r2.ok, true, JSON.stringify(r2)); assert.equal(r2.parts, 3);
  assert.equal(media.isYoutubeUrl('https://music.youtube.com/watch?v=abc'), true);
});
