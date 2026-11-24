// 1.1.22: a name is all the person gives — the assistant finds the channel and reads its own tabs.
// FLS: "when I send him a name, I want him to search for the channel, and when he goes into his
// channel differentiate between shorts, live stream, regular videos — the same as when I go into a
// YouTube channel", and it must know "which one is the newest, which one is older". A channel tab is
// newest-first, so the first entry of the right tab IS the answer. Faked here: the results page
// (fetch stub) carries the channel; a fake yt-dlp serves the tabs and the per-video info.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-fake-ytdlp-'));
const fake = path.join(fakeDir, 'yt-dlp');
fs.writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2026.01.01'); process.exit(0); }
const target = args[args.length - 1] || '';
const single = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
if (target.includes('/channel/') && target.endsWith('/videos')) single({ entries: [
  { id: 'VID00000001', title: 'Newest Regular Video', duration: 754 },
  { id: 'VID00000002', title: 'Older Regular Video', duration: 400 } ] });
if (target.includes('/channel/') && target.endsWith('/shorts')) single({ entries: [
  { id: 'SHO00000001', title: 'Newest Short', duration: 47 },
  { id: 'SHO00000002', title: 'Older Short', duration: 30 } ] });
if (target.includes('/channel/') && target.endsWith('/streams')) single({ entries: [
  { id: 'STR00000001', title: 'Latest Stream', duration: 5400 } ] });
const INFO = {
  VID00000001: { id: 'VID00000001', title: 'Newest Regular Video', uploader: 'Channel Name', upload_date: '20261122', duration: 754, thumbnail: '', webpage_url: 'https://www.youtube.com/watch?v=VID00000001' },
  VID00000002: { id: 'VID00000002', title: 'Older Regular Video', uploader: 'Channel Name', upload_date: '20261001', duration: 400, thumbnail: '', webpage_url: 'https://www.youtube.com/watch?v=VID00000002' },
  SHO00000001: { id: 'SHO00000001', title: 'Newest Short', uploader: 'Channel Name', upload_date: '20261123', duration: 47, thumbnail: '', webpage_url: 'https://www.youtube.com/watch?v=SHO00000001' },
  SHO00000002: { id: 'SHO00000002', title: 'Older Short', uploader: 'Channel Name', upload_date: '20261110', duration: 30, thumbnail: '', webpage_url: 'https://www.youtube.com/watch?v=SHO00000002' },
  STR00000001: { id: 'STR00000001', title: 'Latest Stream', uploader: 'Channel Name', upload_date: '20261121', duration: 5400, was_live: true, thumbnail: '', webpage_url: 'https://www.youtube.com/watch?v=STR00000001' } };
const m = /[?&]v=([\\w-]{11})/.exec(target);
if (m && INFO[m[1]]) single(INFO[m[1]]);
console.error('fake yt-dlp: unexpected target ' + target); process.exit(1);
`, { mode: 0o755 });
import { setupEnv } from './helpers.js';
setupEnv('v134', { MSA_ADMIN_PHONE: '+16465550100', MSA_YTDLP: fake, MSA_ALLOW_LOCAL: '1' });
import test from 'node:test';
import assert from 'node:assert/strict';
const db = await import('../src/db.js'); db.openDb();
const tools = await import('../src/tools/index.js');
const media = await import('../src/tools/media.js');
const users = await import('../src/users.js');
const u134 = users.arrive({ phone: '+16465550177', name: 'Chan', text: 'hi' }).user;

// the results page the channel search reads: the channel itself, plus a similarly-named second one
const SEARCH_HTML = 'x"channelRenderer":{"channelId":"UCabcdefghijklmnopqrstuv","title":{"simpleText":"Channel Name"},"subscriberCountText":{"simpleText":"1M"}}'
  + ' y "channelRenderer":{"channelId":"UCzzzzzzzzzzzzzzzzzzzzzz","title":{"simpleText":"Channel Name Clips"}}';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('youtube.com/results')) return { ok: true, status: 200, text: async () => SEARCH_HTML };
  if (u.includes('i.ytimg.com')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  return realFetch(url);
};
test.after(() => { globalThis.fetch = realFetch; });

test('parse: channels are found on the results page, with their channel urls', () => {
  const chans = media.parseChannelSearch(SEARCH_HTML);
  assert.equal(chans.length, 2);
  assert.equal(chans[0].title, 'Channel Name');
  assert.equal(chans[0].url, 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv');
});

test('kind: the ask picks the tab — short, live, or regular video', () => {
  assert.equal(media.kindForQuery('his latest short video'), 'short');
  assert.equal(media.kindForQuery('watch his live stream from yesterday'), 'live');
  assert.equal(media.kindForQuery('his latest video'), 'video');
});

test('channel flow: the Videos tab answers "latest video" — newest first, from the channel itself', async (t) => {
  if (!(await media.ffmpegOk())) { t.skip('no ffmpeg here'); return; }
  const ctx = { userId: u134.id, files: [] };
  const p = await tools.execTool('youtube_audio', { channel: 'Channel Name', query: 'Channel Name latest video', kind: 'video' }, ctx);
  assert.equal(p.preview, true, JSON.stringify(p));
  assert.equal(p.title, 'Newest Regular Video', 'the first Videos-tab entry — the newest regular upload');
  assert.equal(p.channel, 'Channel Name');
  assert.equal(p.from_channel_tab, 'video');
  assert.ok(!p.chosen_is_livestream, 'a regular video is not a livestream');
  assert.ok(p.other_matches.some(s => s.includes('Older Regular Video')), 'the older one is offered as the next pick');
});

test('channel flow: the Shorts tab answers "latest short" — not a video, not a stream', async (t) => {
  if (!(await media.ffmpegOk())) { t.skip('no ffmpeg here'); return; }
  const ctx = { userId: u134.id, files: [] };
  const p = await tools.execTool('youtube_audio', { channel: 'Channel Name', query: 'Channel Name latest short', kind: 'short' }, ctx);
  assert.equal(p.title, 'Newest Short');
  assert.equal(p.from_channel_tab, 'short');
});

test('channel flow: the Live tab answers a stream ask, and says it is a livestream', async (t) => {
  if (!(await media.ffmpegOk())) { t.skip('no ffmpeg here'); return; }
  const ctx = { userId: u134.id, files: [] };
  const p = await tools.execTool('youtube_audio', { channel: 'Channel Name', query: 'Channel Name latest stream' }, ctx);
  assert.equal(p.title, 'Latest Stream');
  assert.equal(p.from_channel_tab, 'live');
  assert.equal(p.chosen_is_livestream, true, 'the preview is honest that this one is a stream');
});
