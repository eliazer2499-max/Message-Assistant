// 1.1.1: media work (Abish: "it should be able to do everything, like extract audio from videos").
// Uses ffmpeg / ffprobe on the server (install.sh installs ffmpeg; Update now adds it when missing).
// The result is saved like any other file the assistant sends (sites.saveMedia) and ATTACHED to the reply
// by the agent (ctx.files) — the person gets the actual audio file by text, not a link (most have no internet).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { cfg } from '../config.js';
import * as B from '../browser.js';
import * as S from '../sites.js';
import { get as dbGet, run as dbRun } from '../db.js';

const S_ = (description, extra = {}) => ({ type: 'string', description, ...extra });
const MAX_BYTES = 200 * 1024 * 1024;          // what we will download / convert for one message
const TIMEOUT_MS = 180000;

function run(cmd, args, ms = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: ms, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) { e.stderr = String(stderr || '').slice(-600); reject(e); } else resolve({ stdout, stderr });
    });
  });
}
export async function ffmpegOk() {
  try { await run('ffmpeg', ['-version'], 10000); return true; } catch { return false; }
}
const NO_FFMPEG = 'ffmpeg is not installed on this server, so media work is off. The admin can fix it once: sudo apt-get install -y ffmpeg (or press Update now in Settings, which installs it).';

const MEDIA_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|ogg|opus|flac|aac)$/i;
async function download(url, dir) {
  const u = await B.assertPublicUrl(B.cleanUrl(url));
  const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(120000), headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' } });
  if (!r.ok) throw new Error('That address answered ' + r.status);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('That file is too big (over 200 MB).');
  const ct = r.headers.get('content-type') || '';
  let ext = (MEDIA_EXT.exec(new URL(r.url || String(u)).pathname) || [])[1] || (ct.includes('video') ? 'mp4' : ct.includes('audio') ? 'mp3' : '');
  if (!ext) throw new Error('That link is a web page, not a video/audio file. Send a direct link to the video file itself (ending .mp4, .mov, .webm…), or a link this tool can download.');
  const file = path.join(dir, 'in.' + ext.toLowerCase());
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('That file is too big (over 200 MB).');
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return file;
}
async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size,format_name', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', file], 30000);
  const j = JSON.parse(stdout || '{}');
  return { duration_seconds: j.format?.duration ? Math.round(Number(j.format.duration)) : null, size_mb: j.format?.size ? Math.round(Number(j.format.size) / 104857.6) / 10 : null,
    format: j.format?.format_name || '', streams: (j.streams || []).map(s => s.codec_type + ':' + s.codec_name) };
}
function workdir(userId) {
  const d = path.join(cfg.dataDir, 'media-work', String(userId));
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(d, 'job-'));
}

// ---------- YouTube (1.1.2): "go to YouTube, find X, send it to me" ----------
// The people using this assistant have NO internet: they will never open a YouTube link. So the assistant
// searches YouTube itself, downloads the video with yt-dlp (the installer puts it on the server; Node — which
// the app already runs on — is its JavaScript runtime), extracts the audio, and the audio FILE is attached to
// the reply, so it arrives inside the text chat like a voice note they can play.
const NO_YTDLP = 'yt-dlp is not installed on this server, so YouTube downloads are off. The admin can fix it once: press Update now in Settings (it installs yt-dlp), or: sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod +x /usr/local/bin/yt-dlp';
const MAX_SEND_MINUTES = 60;                 // (1.1.2 cap, replaced in 1.1.3 by splitting into parts — see splitIntoParts)
let _ytdlp = null;
export async function ytdlpPath() {
  if (_ytdlp !== null) return _ytdlp;
  for (const c of [cfg.ytdlp, 'yt-dlp', '/usr/local/bin/yt-dlp', path.join(cfg.dataDir, 'bin', 'yt-dlp')].filter(Boolean)) {
    try { await run(c, ['--version'], 10000); _ytdlp = c; return c; } catch {}
  }
  _ytdlp = ''; return '';
}
export const isYoutubeUrl = (u) => /(?:(?:www\.|music\.)?youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/i.test(String(u || ''));
const durToSec = (t) => { const p = String(t || '').split(':').map(Number); if (!p.length || p.some(isNaN)) return 0; return p.reduce((a, n) => a * 60 + n, 0); };
const ageToSec = (t) => { const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(String(t || '').replace(/^streamed\s+/i, '')); if (!m) return null; return Number(m[1]) * ({ second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[m[2].toLowerCase()] || 0) || null; };
export function parseYoutubeSearch(html) {
  const out = [];
  for (const chunk of String(html || '').split('"videoRenderer":').slice(1)) {
    if (out.length >= 8) break;
    const id = /"videoId":"([\w-]{11})"/.exec(chunk)?.[1];
    if (!id || out.some(v => v.id === id)) continue;
    const tm = /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/.exec(chunk) || /"title":\{"simpleText":"((?:[^"\\]|\\.)*)"/.exec(chunk);
    const title = tm ? tm[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
    const len = /"lengthText":\{[\s\S]{0,160}?"simpleText":"([\d:]+)"/.exec(chunk)?.[1] || '';
    // 1.1.22: livestreams poison "his latest video" — the results page marks them: a LIVE badge (live
    // right now) and a "Streamed …" published line (a past stream, usually hours long). Capture both,
    // plus the age, so rankYoutubeMatches can put a regular video first.
    const head = chunk.slice(0, 8000);
    const live = /"iconType":"LIVE"/.test(head) || /BADGE_STYLE_TYPE_LIVE/.test(head);
    const pub = /"publishedTimeText":\{"simpleText":"([^"]+)"/.exec(chunk)?.[1] || '';
    out.push({ id, title, duration: len, duration_seconds: durToSec(len), live, streamed: /^streamed\b/i.test(pub), age_seconds: ageToSec(pub), url: 'https://www.youtube.com/watch?v=' + id });
  }
  return out;
}
export async function searchYoutube(query) {
  const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), { signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!r.ok) throw new Error('YouTube search answered ' + r.status);
  return parseYoutubeSearch(await r.text());
}
// ---------- channels (1.1.22): "his latest video" is a CHANNEL question, not a search question ----------
// FLS: "when I send him a name, I want him to search for the channel, and when he goes into his channel
// differentiate between shorts, live stream, regular videos — the same as when I go into a YouTube
// channel." A channel's own tabs are exactly that, and each tab is newest-first, so "the latest" is
// simply the first entry — no guessing from a mixed search page. The name is all the person gives;
// the channel is found from the same results page the video search already reads.
export function parseChannelSearch(html) {
  const out = [];
  for (const chunk of String(html || '').split('"channelRenderer":').slice(1)) {
    if (out.length >= 5) break;
    const id = /"channelId":"(UC[\w-]{10,})"/.exec(chunk)?.[1];
    if (!id || out.some(c => c.id === id)) continue;
    const tm = /"title":\{"simpleText":"((?:[^"\\]|\\.)*)"/.exec(chunk) || /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/.exec(chunk);
    const title = tm ? tm[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
    if (!title) continue;
    out.push({ id, title, url: 'https://www.youtube.com/channel/' + id });
  }
  return out;
}
export async function searchChannels(query) {
  const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), { signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!r.ok) throw new Error('YouTube search answered ' + r.status);
  return parseChannelSearch(await r.text());
}
/** Which channel tab an ask means: a short → Shorts, a live/stream → Live, anything else → Videos. */
export function kindForQuery(q) {
  const s = String(q || '');
  if (/\b(shorts?|reels?)\b/i.test(s)) return 'short';
  if (/\b(live|livestream|live stream|stream)\b/i.test(s)) return 'live';
  return 'video';
}
const TAB_FOR_KIND = { video: 'videos', short: 'shorts', live: 'streams' };
/** The newest entries of one channel tab, in the tab's own order (newest first). */
async function channelTab(channelUrl, kind, n = 5) {
  const bin = await ytdlpPath();
  if (!bin) throw new Error(NO_YTDLP);
  const { stdout } = await run(bin, ['--js-runtimes', 'node', '--dump-single-json', '--flat-playlist', '--playlist-items', '1:' + n, '--no-warnings', channelUrl + '/' + (TAB_FOR_KIND[kind] || 'videos')], 90000);
  const j = JSON.parse(stdout || '{}');
  const entries = Array.isArray(j.entries) ? j.entries.filter(Boolean) : [];
  return entries.map(e => ({ url: e.id ? 'https://www.youtube.com/watch?v=' + e.id : String(e.url || e.webpage_url || ''), title: e.title || '', live: kind === 'live', short: kind === 'short' })).filter(m => m.url);
}
const errLine = (e) => { const s = String(e?.stderr || e?.message || e); const lines = s.split('\n').map(x => x.trim()).filter(x => /error|sign in|unavailable|private|blocked/i.test(x)); return (lines[lines.length - 1] || s.split('\n').filter(Boolean).pop() || 'download failed').replace(/^ERROR:\s*/i, '').slice(0, 220); };
async function youtubeToFile(target, fmt, dir) {
  const bin = await ytdlpPath();
  if (!bin) throw Object.assign(new Error(NO_YTDLP), { noYtdlp: true });
  // 1.1.23: only the AUDIO is ever wanted, so download the audio-only stream — fetching the whole
  // video first made long videos die on the size cap ("the file is too large for my system to
  // process", FLS's screenshot, 2026-11-24) when it was the VIDEO that was large, not the sound.
  // The cap now guards the audio stream itself, with room for hours of it.
  await run(bin, ['--js-runtimes', 'node', '--playlist-items', '1', '--no-progress', '--no-warnings', '--socket-timeout', '30', '--retries', '2',
    '-f', 'bestaudio/best', '-x', '--audio-format', fmt, '--audio-quality', '2', '--max-filesize', '600M', '-o', path.join(dir, 'audio.%(ext)s'), target], 300000);
  const f = fs.readdirSync(dir).map(n => path.join(dir, n)).find(p => /\.(mp3|m4a|ogg|opus)$/i.test(p) && fs.statSync(p).size > 0);
  if (!f) throw new Error('YouTube did not give an audio file for that video.');
  return f;
}
export function codecArgs(fmt) {
  // 1.1.3: "a clear version" — high quality (mp3 VBR ~190 kbps), still small enough to text in parts
  return fmt === 'mp3' ? ['-codec:a', 'libmp3lame', '-q:a', '2'] : fmt === 'm4a' ? ['-codec:a', 'aac', '-b:a', '160k'] : ['-codec:a', 'libopus', '-b:a', '128k'];
}
const MAX_PARTS = 24;                          // 24 parts × ~15 min ≈ 6 hours: beyond that, ask for a section
/** Split an audio file into voice-note parts of about partSeconds each (one part = the file itself when short). */
export async function splitIntoParts(file, fmt, dir, partSeconds = cfg.partSeconds || 900) {
  const info = await probe(file).catch(() => null);
  const dur = info?.duration_seconds || 0;
  if (!dur || dur <= partSeconds + 5) return { files: [file], duration_seconds: dur };
  const n = Math.ceil(dur / partSeconds);
  if (n > MAX_PARTS) throw new Error(`That is ${Math.round(dur / 60)} minutes — over ${MAX_PARTS} voice-note parts. Ask for a specific section of it.`);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = path.join(dir, `part${String(i + 1).padStart(2, '0')}.${fmt}`);
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(i * partSeconds), '-t', String(partSeconds), '-i', file, '-vn', ...codecArgs(fmt), p], 300000);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) out.push(p);
  }
  if (!out.length) throw new Error('Splitting the audio into parts failed.');
  return { files: out, duration_seconds: dur };
}
/** Attach an audio file to the reply as one voice note — or as several parts, in order, when it is long. */
export async function sendAudioParts(ctx, file, fmt, displayName, dir) {
  const { files, duration_seconds } = await splitIntoParts(file, fmt, dir);
  const fname = String(displayName || 'audio').replace(/[^\w .()-]+/g, '').slice(0, 60).trim() || 'audio';
  let total = 0;
  files.forEach((p, i) => {
    const buf = fs.readFileSync(p); total += buf.length;
    const name = files.length > 1 ? `${fname} (part ${i + 1} of ${files.length})` : fname;
    const media = S.saveMedia(buf, { userId: ctx.userId, ext: fmt, name: name + '.' + fmt });
    ctx.files = [...(ctx.files || []), { media, type: 'audio/' + (fmt === 'mp3' ? 'mpeg' : fmt) }];
  });
  return { ok: true, parts: files.length, sent_as_attachment: files.length > 1 ? `${fname} — ${files.length} parts, one after another` : fname + '.' + fmt,
    size_mb: Math.round(total / 104857.6) / 10, ...(duration_seconds ? { audio_duration_seconds: duration_seconds } : {}),
    note: files.length > 1
      ? `The FULL audio is attached right after your answer as ${files.length} voice notes in order (part 1, part 2, …). Tell them in one short line what it is and that it comes in ${files.length} parts; do NOT send any link.`
      : 'The audio itself is attached right after your answer, like a voice note they can play. Tell them in one short line what it is; do NOT send any link.' };
}
async function ytdlpTitle(target) {
  try { const bin = await ytdlpPath(); const { stdout } = await run(bin, ['--js-runtimes', 'node', '--playlist-items', '1', '--get-title', target], 60000); return stdout.split('\n')[0].trim().slice(0, 120); } catch { return ''; }
}
// 1.1.4: BEFORE anything is sent, the person confirms it is the right one (Abish: "first send the thumbnail and
// the details — and the release date, how long it is — to confirm that this is the actual one I want, and then
// when it gets the okay it should send out that one"). So youtube_audio works in two steps: a call without
// `confirm` only PREVIEWS (thumbnail attached + details, nothing downloaded); the download happens on the
// follow-up call with confirm:true, after the person said yes. The pending choice is kept per person.
async function videoInfo(target) {
  const bin = await ytdlpPath();
  const { stdout } = await run(bin, ['--js-runtimes', 'node', '--playlist-items', '1', '--dump-single-json', '--no-warnings', target], 90000);
  const j = JSON.parse(stdout || '{}');
  const e = Array.isArray(j.entries) ? (j.entries.find(Boolean) || {}) : j;
  return { id: e.id || '', title: e.title || '', by: e.uploader || e.channel || e.artist || '', uploaded: e.upload_date || '',
    duration_seconds: e.duration ? Math.round(Number(e.duration)) : null, live: !!(e.is_live || e.was_live), thumb: e.thumbnail || (e.id ? `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg` : ''),
    url: e.webpage_url || (e.id ? 'https://www.youtube.com/watch?v=' + e.id : target) };
}
export const fmtDate = (yyyymmdd) => { const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(yyyymmdd || '')); if (!m) return ''; try { return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); } catch { return ''; } };
/** 1.1.10: does this title actually match what the person asked for? (Abish asked for "Dylan Paige" the
 *  YouTuber and was confidently offered "Paige Dylan", a different person — the same words, reversed.)
 *  Strong = the asked words appear in the title in the same order (or as an exact phrase). rank orders
 *  search results so an in-order match beats a reversed one. */
const normWords = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter(Boolean);
export function scoreMatch(query, title) {
  const q = normWords(query), t = normWords(title);
  if (!q.length || !t.length) return { score: 0, strong: false, rank: 0 };
  const tSet = new Set(t);
  const score = q.filter(w => tSet.has(w)).length / q.length;
  let qi = 0; for (const w of t) { if (qi < q.length && w === q[qi]) qi++; }
  const strong = qi >= q.length || (q.length >= 2 && t.join(' ').includes(q.join(' ')));
  return { score, strong, rank: (strong ? 2 : 0) + score };
}
export const durText = (s) => { if (!s) return ''; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`; };
/** 1.1.22: order YouTube results the way the person meant. A livestream (live now, or a recording of
 *  one) and a marathon-length video sink below regular videos — UNLESS the ask was for a live/long
 *  one. Title match (scoreMatch) still decides inside a tier, and for a "latest / newest" ask the
 *  newest video wins a tie. Nothing is dropped: if everything is a stream, the best stream surfaces. */
const MARATHON_SEC = 3 * 3600;
export function rankYoutubeMatches(query, list) {
  const q = String(query || '');
  const liveAsk = /\b(live|livestream|live stream|streaming)\b/i.test(q);
  const longOk = liveAsk || /\b(full|complete|entire|long|marathon|shiur|lecture|class|concert)\b/i.test(q);
  const latestAsk = /\b(latest|newest|new|recent|last)\b/i.test(q);
  const penalty = (v) => (liveAsk ? 0 : ((v.live || v.streamed) ? 100 : 0)) + ((!longOk && (v.duration_seconds || 0) > MARATHON_SEC) ? 40 : 0);
  return [...list].sort((a, b) => (penalty(a) - penalty(b)) || (scoreMatch(q, b.title).rank - scoreMatch(q, a.title).rank) || (latestAsk ? ((a.age_seconds ?? Infinity) - (b.age_seconds ?? Infinity)) : 0));
}
/** 1.1.5 (Abish's rule): a VIDEO request searches YouTube; a SONG request searches YouTube Music — unless
 *  the person said otherwise (the model's source argument, or a link, wins over this default). */
export function defaultSourceFor(query = '', url = '') {
  if (/music\.youtube\.com/i.test(String(url || ''))) return 'music';
  if (/\b(song|songs|music|track|album|single|niggun|nigun|melody|tune)\b/i.test(String(query || ''))) return 'music';
  return 'youtube';
}
async function attachThumbnail(ctx, info) {
  if (!info.thumb) return false;
  try {
    const u = await B.assertPublicUrl(B.cleanUrl(info.thumb));
    const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 5 * 1024 * 1024) return false;
    const media = S.saveMedia(buf, { userId: ctx.userId, ext: 'jpg', name: 'thumbnail.jpg' });
    ctx.files = [...(ctx.files || []), { media, type: 'image/jpeg' }];
    return true;
  } catch { return false; }
}
// the pending preview lives in the settings table (users.setUserSettings only keeps name/timezone/language/style)
const PKEY = (ctx) => 'pending_yt_' + Number(ctx.userId);
const getPending = (ctx) => { try { const r = dbGet('SELECT v FROM settings WHERE k=?', PKEY(ctx)); return r ? JSON.parse(r.v) : null; } catch { return null; } };
const setPending = (ctx, p) => { try { if (p) dbRun('INSERT INTO settings(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', PKEY(ctx), JSON.stringify(p)); else dbRun('DELETE FROM settings WHERE k=?', PKEY(ctx)); } catch {} };
async function youtubeAudio({ query, url, format, source, confirm, pick, channel, kind }, ctx) {
  if (!(await ffmpegOk())) return { error: NO_FFMPEG };
  if (!(await ytdlpPath())) return { error: NO_YTDLP };
  const fmt = ['mp3', 'm4a', 'ogg'].includes(String(format || 'mp3').toLowerCase()) ? String(format || 'mp3').toLowerCase() : 'mp3';
  // ---- step 2: they said yes → download the pending one and send the audio itself ----
  if (confirm) {
    const p = getPending(ctx);
    if (!p || Date.now() - (p.ts || 0) > 30 * 60000) return { error: 'There is no video waiting for a yes. Ask me to find it again, and I will show it first.' };
    const chosen = p.matches[p.pick || 0] || p.matches[0];
    setPending(ctx, null);
    const dir = workdir(ctx.userId);
    try {
      const f = await youtubeToFile(chosen.url, p.fmt || fmt, dir);
      return { ...(await sendAudioParts(ctx, f, p.fmt || fmt, p.title || chosen.title || 'YouTube audio', dir)), ...(p.title ? { title: p.title } : {}), source: p.source || 'YouTube' };
    } catch (e) { return { error: e.noYtdlp ? NO_YTDLP : 'Download failed: ' + errLine(e) }; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // ---- step 1: preview (or preview another match with pick) ----
  const want = String(source || '').toLowerCase();
  const music = /music\.youtube\.com/i.test(String(url || '')) || (want ? want === 'music' : defaultSourceFor(query, url) === 'music');   // 1.1.5: video → YouTube, song → YouTube Music, unless told otherwise
  let matches = null, prev = getPending(ctx);
  let channelUsed = null;
  if (pick) {
    if (!prev || !Array.isArray(prev.matches) || !prev.matches[Number(pick) - 1]) return { error: 'There is no other match number ' + pick + ' waiting. Search again with different words.' };
    matches = prev.matches;
  } else if (url && isYoutubeUrl(url)) { matches = [{ url: String(url), title: '' }]; }
  if (!matches && !music && channel && String(channel).trim()) {
    // 1.1.22: they named a channel → find it, open the tab the ask means (Videos / Shorts / Live),
    // and take its own order: the first entry IS the newest of that kind. Any failure falls through
    // to the plain search below — never worse than before.
    try {
      const chans = await searchChannels(String(channel).trim());
      const best = chans.map(c => ({ c, s: scoreMatch(String(channel).trim(), c.title) })).sort((a, b) => b.s.rank - a.s.rank)[0];
      if (best && best.s.strong) {
        const k = ['video', 'short', 'live'].includes(String(kind || '').toLowerCase()) ? String(kind).toLowerCase() : kindForQuery(query || channel);
        const tabMatches = await channelTab(best.c.url, k);
        if (tabMatches.length) { matches = tabMatches; channelUsed = { title: best.c.title, kind: k }; }
      }
    } catch {}
  }
  if (!matches) {
    const q = String(query || url || channel || '').trim();
    if (!q) return { error: 'Tell me what to look for (a name or a few words).' };
    if (music) matches = [{ url: 'https://music.youtube.com/search?q=' + encodeURIComponent(q), title: '' }];
    else {
      try { const found = await searchYoutube(q); if (found.length) { matches = rankYoutubeMatches(q, found).map(v => ({ url: v.url, title: v.title, live: !!(v.live || v.streamed) })); } } catch {}
      if (!matches) matches = [{ url: 'ytsearch1:' + q, title: '' }];
    }
  }
  const pickIdx = pick ? Number(pick) - 1 : 0;
  const chosen = matches[pickIdx];
  let info;
  try { info = await videoInfo(chosen.url); } catch (e) { return { error: (music ? 'YouTube Music' : 'YouTube') + ' could not read that video: ' + errLine(e) }; }
  if (!info.title && chosen.title) info.title = chosen.title;
  if (info.url && /^https:/.test(info.url)) matches[pickIdx] = { url: info.url, title: info.title };
  const thumb = await attachThumbnail(ctx, info);
  setPending(ctx, { matches, pick: pickIdx, title: info.title, source: music ? 'YouTube Music' : 'YouTube', fmt, ts: Date.now() });
  // 1.1.10: a title whose words don't match the ask IN ORDER is not presented as "the one" — it may be a
  // different person with a similar name. The model must say so and let the person pick from the matches.
  const uncertain = !channelUsed && !pick && !(url && isYoutubeUrl(url)) && !!String(query || '').trim() && !scoreMatch(String(query || ''), info.title).strong;
  const chosenLive = !!(info.live || chosen.live);
  return { preview: true, title: info.title, by: info.by, released: fmtDate(info.uploaded), duration: durText(info.duration_seconds), duration_seconds: info.duration_seconds,
    source: music ? 'YouTube Music' : 'YouTube', thumbnail_attached: thumb, ...(uncertain ? { match_uncertain: true } : {}), ...(chosenLive ? { chosen_is_livestream: true } : {}), ...(channelUsed ? { channel: channelUsed.title, from_channel_tab: channelUsed.kind, note_for_channel: 'This came from the channel\'s own ' + channelUsed.kind + ' tab, newest first — so this IS their newest ' + channelUsed.kind + ' on that channel. Say the channel name when you present it.' } : {}),
    other_matches: matches.slice(0, 4).map((m, i) => (i + 1) + '. ' + (m.title || '(video)') + (m.live ? ' (livestream)' : '')).filter((_, i) => i !== pickIdx),
    note: (chosenLive ? 'NOTE: this one is a LIVESTREAM (live now, or a recording of one) — say so plainly when you present it; if they asked for a regular video, offer the non-livestream matches by number. ' : '') + (uncertain
      ? 'STOP — nothing was downloaded, and CAREFUL: this title does NOT closely match what they asked for — their key words are missing or in a different order, so it may be a different person or video with a similar name. Present it honestly: say it is the closest you found and it may NOT be the right one, give its details, and list the other matches by number so they can choose. If they name a number, call youtube_audio with pick:<that number> to preview it; if they say none of them, search again with different words. Download only after they say yes to a specific one.'
      : 'STOP — nothing was downloaded. The thumbnail picture is attached to your answer. Now tell them: the title, who it is by, the release date and how long it is, and ASK if this is the one they want. When they say yes, call youtube_audio again with confirm:true and the audio will be sent. If they say it is the wrong one, call youtube_audio with pick:2 (or 3…) to show another match, or search again with different words.') };
}

export const MEDIA_TOOLS = [
  { name: 'youtube_audio', description: 'Find a video on YouTube (or a song on YouTube Music) for a person with NO internet — NEVER answer with a link. It works in two steps: (1) call it with search words or a link: it shows a PREVIEW — the thumbnail picture is attached and you get the title, who made it, the release date and the length; present those and ASK if this is the one they want. (2) Only when they say yes, call it again with confirm:true — then the audio itself is downloaded and sent as voice-note file(s), in full; long ones arrive as several parts, one after another. If they say it is the wrong one, call with pick:2 (etc.) to preview another match, or search with different words. WHEN THEY NAME A CHANNEL OR CREATOR and want their latest/newest (or a short, or a stream) from that channel, pass channel:<the name they gave> and kind: — the tool then opens that channel\'s own tab (Videos / Shorts / Live, newest first), exactly like opening the channel yourself, instead of a mixed search page.',
    params: { query: S_('What to find, e.g. "Mordechai Shapiro Yedidim" or "shiur on emunah part 2"'), url: S_('A YouTube or YouTube Music link instead of search words (optional)'), channel: S_('The channel/creator name when they ask for something FROM a channel — e.g. "his latest video", "her newest short", "their last stream". Just the name they gave; the tool finds the channel.'), kind: S_('With channel: "short" for a short, "live" for a livestream, "video" (default) for a regular video'), source: S_('Where to search. DEFAULT: a song/music request → "music" (YouTube Music); a video request → "youtube". Set it only to follow what the person asked: "music" when they want a song, "youtube" when they want a video — and the opposite only when they say so explicitly (e.g. "that song, but from regular YouTube")'), format: S_('mp3 (default), m4a or ogg'), confirm: { type: 'boolean', description: 'true ONLY after the person said yes to the preview — downloads and sends the audio' }, pick: { type: 'number', description: 'Preview another match from the last search (2 = second match…)' } },
    run: async (a, ctx) => youtubeAudio(a, ctx) },
  { name: 'extract_audio', description: 'Extract the audio from a video (or convert an audio file) and send the person the audio FILE itself as an attachment to your answer. Give a direct link to the video/audio file (…mp4/.mov/.webm/.mp3), or a YouTube link (for YouTube search words use youtube_audio). format: mp3 (default), m4a or ogg. Use it when they ask for the audio/soundtrack of a video, or to turn a video into audio they can listen to.',
    params: { url: S_('Direct link to the video or audio file'), format: S_('mp3, m4a or ogg (default mp3)'), name: S_('File name to send (optional)') }, required: ['url'],
    run: async ({ url, format = 'mp3', name }, ctx) => {
      if (isYoutubeUrl(url)) return youtubeAudio({ url, format }, ctx);
      if (!(await ffmpegOk())) return { error: NO_FFMPEG };
      const fmt = ['mp3', 'm4a', 'ogg'].includes(String(format).toLowerCase()) ? String(format).toLowerCase() : 'mp3';
      const dir = workdir(ctx.userId);
      try {
        const input = await download(url, dir);
        const before = await probe(input).catch(() => null);
        const out = path.join(dir, 'audio.' + fmt);
        await run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-vn', ...codecArgs(fmt), out], 300000);
        if (!fs.existsSync(out) || !fs.statSync(out).size) return { error: 'The conversion came out empty — that file may have no audio track.' };
        const sent = await sendAudioParts(ctx, out, fmt, name || 'audio', dir);
        return { ...sent, ...(before?.duration_seconds ? { source_duration_seconds: before.duration_seconds } : {}) };
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    } },
  { name: 'media_info', description: 'Look at a video/audio file link: how long it is, its size and what is inside (video/audio tracks). Use before extract_audio when the file might be very large, or when they ask how long a video/audio is.',
    params: { url: S_('Direct link to the video or audio file') }, required: ['url'],
    run: async ({ url }, ctx) => {
      if (!(await ffmpegOk())) return { error: NO_FFMPEG };
      const dir = workdir(ctx.userId);
      try { const input = await download(url, dir); return await probe(input); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }
    } },
  { name: 'send_web_file', description: 'Send the person a FILE from the web — a PDF, a form, a document, a spreadsheet, a zip — as an attachment to your answer, never a link (they have no internet). Give the direct address of the file itself (ending .pdf, .docx, .zip…). Use it whenever they ask for a file, a PDF, a form, a document, or a copy of something that lives at a web address. Up to 100 MB.',
    params: { url: S_('The direct web address of the file'), name: S_('File name to send it as (optional — taken from the address when omitted)') }, required: ['url'],
    run: async ({ url, name }, ctx) => {
      const CAP = 100 * 1024 * 1024;
      let u; try { u = await B.assertPublicUrl(B.cleanUrl(url)); } catch (e) { return { error: e.message }; }
      let r; try { r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(120000), headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' } }); }
      catch (e) { return { error: 'That file could not be fetched: ' + errLine(e) }; }
      if (!r.ok) return { error: 'That address answered ' + r.status + ' — the file could not be fetched.' };
      const ct = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (ct === 'text/html') return { error: 'That address is a web page, not a file. If the file is linked from that page, open the page with the browser tools and use the file\u2019s own address.' };
      if (Number(r.headers.get('content-length') || 0) > CAP) return { error: 'That file is too big to send by text (over 100 MB).' };
      const chunks = []; let total = 0;
      try {
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > CAP) { reader.cancel().catch(() => {}); return { error: 'That file is too big to send by text (over 100 MB).' }; }
          chunks.push(value);
        }
      } catch (e) { return { error: 'The download broke off: ' + errLine(e) }; }
      const buf = Buffer.concat(chunks);
      if (!buf.length) return { error: 'That address gave an empty file.' };
      const CT_EXT = { 'application/pdf': 'pdf', 'application/zip': 'zip', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'text/plain': 'txt', 'text/csv': 'csv', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'application/json': 'json' };
      let fname = String(name || '').trim();
      if (!fname) { const cd = String(r.headers.get('content-disposition') || ''); const cm = /filename\*=(?:UTF-8'')?([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(cd); fname = cm ? decodeURIComponent((cm[1] || cm[2] || cm[3] || '').trim().replace(/^"|"$/g, '')) : ''; }
      if (!fname) { try { fname = decodeURIComponent(path.basename(new URL(r.url || String(u)).pathname)); } catch {} }
      fname = String(fname || 'file').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';
      let ext = path.extname(fname).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
      if (!ext) { ext = CT_EXT[ct] || 'bin'; if (ext !== 'bin') fname += '.' + ext; }
      const media = S.saveMedia(buf, { userId: ctx.userId, ext, name: fname });
      ctx.files = [...(ctx.files || []), { media, type: ct || 'application/octet-stream' }];
      return { ok: true, sent_file: fname, size_kb: Math.max(1, Math.round(buf.length / 1024)), note: 'The file itself is attached to your answer — do NOT paste a link. Confirm in one short line what you sent.' };
    } },
];
export const _test = { download, probe, parseExt: (u) => (MEDIA_EXT.exec(u) || [])[1] || null, splitIntoParts, sendAudioParts, videoInfo, fmtDate, durText };
