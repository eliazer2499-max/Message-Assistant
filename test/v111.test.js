// 1.1.1: search works again (DuckDuckGo html answers servers a 202 bot-check with zero results → lite/Bing
// fallback), latest_news (Google News RSS), no links for people without internet unless they ask, media work
// (extract audio from a video, ffmpeg), Connect accounts dead ends (1-hour connect link, no empty-account
// crash), and People opens on All.
import { setupEnv } from './helpers.js';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
setupEnv('v111', { MSA_ADMIN_PHONE: '+16465550100', MSA_PUBLIC_URL: 'https://msg.example.com', MSA_ALLOW_LOCAL: '1' });
import test from 'node:test';
import assert from 'node:assert/strict';

const tools = await import('../src/tools/index.js');
const tidy = await import('../src/tidy.js');
const media = await import('../src/tools/media.js');
const db = await import('../src/db.js');
db.openDb();

test('no links unless asked: stripping keeps the words, asking keeps the links', () => {
  assert.equal(tidy.wantsLinks('what is the latest news?'), false);
  assert.equal(tidy.wantsLinks('send me the link'), true);
  assert.equal(tidy.wantsLinks('where can I see that?'), true);
  const out = tidy.withoutLinks('Big story today. Read more at https://example.com/story and [this report](https://x.com/r).\nSource: https://a.com');
  assert.doesNotMatch(out, /https?:\/\//);
  assert.match(out, /Big story today/);
  assert.match(out, /this report/);
  assert.equal(tidy.withoutLinks('No links here.'), 'No links here.');
});

test('news RSS parsing: title, source, date, summary', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Storm hits the coast - Daily News</title><link>https://news.example/1</link><pubDate>Tue, 18 Nov 2026 10:00:00 GMT</pubDate><description><![CDATA[<a href="https://x">Storm</a> made landfall early today.]]></description><source url="https://daily.example">Daily News</source></item>
    <item><title>Second story</title><link>https://news.example/2</link><pubDate>Tue, 18 Nov 2026 11:00:00 GMT</pubDate><description>Plain &amp; simple</description><source>Wire</source></item>
  </channel></rss>`;
  const s = tools.parseNewsRss(xml);
  assert.equal(s.length, 2);
  assert.equal(s[0].source, 'Daily News');
  assert.match(s[0].description, /made landfall/);
  assert.equal(s[1].description, 'Plain & simple');
  assert.ok(tools.TOOLS.some(t => t.name === 'latest_news'), 'latest_news tool exists');
});

test('web_search falls back when DuckDuckGo html returns a bot-check page (202, no results)', async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url); seen.push(u);
    const body = (t, status = 200) => ({ status, ok: status === 200, text: async () => t, headers: new Map() });
    if (u.includes('html.duckduckgo.com')) return body('<html>bot check</html>', 202);
    if (u.includes('lite.duckduckgo.com')) return body(`<table><tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa" class='result-link'>A result</a></td></tr><tr><td class='result-snippet'>the snippet</td></tr></table>`);
    return body('', 404);
  };
  try {
    const out = await tools.webSearch('anything');
    assert.equal(out.length, 1);
    assert.equal(out[0].title, 'A result');
    assert.equal(out[0].snippet, 'the snippet');
    assert.ok(seen.some(u => u.includes('lite.duckduckgo.com')), 'lite was tried after html');
  } finally { globalThis.fetch = real; }
});

test('media: extract_audio turns a video into an attached mp3; media_info reads it', async (t) => {
  if (!(await media.ffmpegOk())) { t.skip('no ffmpeg here'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-v111-media-'));
  const mp4 = path.join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-codec:a', 'aac', mp4]);
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4' }); fs.createReadStream(mp4).pipe(res); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/clip.mp4`;
  try {
    const ctx = { userId: 999, files: [] };
    const r = await tools.execTool('extract_audio', { url }, ctx);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(ctx.files.length, 1, 'the audio file is queued as an attachment');
    assert.ok(fs.existsSync(ctx.files[0].media.file), 'the mp3 file exists on the server');
    assert.ok(r.audio_duration_seconds >= 1);
    const info = await tools.execTool('media_info', { url }, { userId: 999 });
    assert.ok(info.streams.some(s => s.startsWith('video:')), JSON.stringify(info));
    const bad = await tools.execTool('extract_audio', { url: 'http://127.0.0.1:1/nope.mp4' }, { userId: 999, files: [] });
    assert.ok(bad.error, 'a dead link is an error, not a crash');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('People opens on All (All tab first and selected; the dashboard starts with no filter)', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const tabs = /id="peopleTabs">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.match(tabs, /<button data-s="" class="on">All<\/button>/, 'All is first and on');
  assert.ok(tabs.indexOf('data-s=""') < tabs.indexOf('data-s="pending"'), 'All before Waiting');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /peopleStatus = ''/, 'peopleStatus starts empty (All)');
});

test('Connect accounts: the connect link lives an hour; a no-email Google reply cannot save a broken account', async () => {
  const integ = await import('../src/integrations.js');
  const src = fs.readFileSync(new URL('../src/integrations.js', import.meta.url), 'utf8');
  assert.match(src, /now\(\) - row\.created > 60 \* 60000/, 'state checked against 60 minutes');
  assert.match(src, /if \(!account\) throw/, 'empty account is refused, not saved');
  assert.equal(typeof integ.startGoogle, 'function');
  const me = fs.readFileSync(new URL('../public/me.js', import.meta.url), 'utf8');
  assert.match(me, /google_ready === true/, 'the Connect button shows only when really ready');
});
