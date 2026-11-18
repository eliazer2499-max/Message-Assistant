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
export function parseYoutubeSearch(html) {
  const out = [];
  for (const chunk of String(html || '').split('"videoRenderer":').slice(1)) {
    if (out.length >= 8) break;
    const id = /"videoId":"([\w-]{11})"/.exec(chunk)?.[1];
    if (!id || out.some(v => v.id === id)) continue;
    const tm = /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/.exec(chunk) || /"title":\{"simpleText":"((?:[^"\\]|\\.)*)"/.exec(chunk);
    const title = tm ? tm[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
    const len = /"lengthText":\{[\s\S]{0,160}?"simpleText":"([\d:]+)"/.exec(chunk)?.[1] || '';
    out.push({ id, title, duration: len, url: 'https://www.youtube.com/watch?v=' + id });
  }
  return out;
}
export async function searchYoutube(query) {
  const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), { signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!r.ok) throw new Error('YouTube search answered ' + r.status);
  return parseYoutubeSearch(await r.text());
}
const errLine = (e) => { const s = String(e?.stderr || e?.message || e); const lines = s.split('\n').map(x => x.trim()).filter(x => /error|sign in|unavailable|private|blocked/i.test(x)); return (lines[lines.length - 1] || s.split('\n').filter(Boolean).pop() || 'download failed').replace(/^ERROR:\s*/i, '').slice(0, 220); };
async function youtubeToFile(target, fmt, dir) {
  const bin = await ytdlpPath();
  if (!bin) throw Object.assign(new Error(NO_YTDLP), { noYtdlp: true });
  await run(bin, ['--js-runtimes', 'node', '--playlist-items', '1', '--no-progress', '--no-warnings', '--socket-timeout', '30', '--retries', '2',
    '-x', '--audio-format', fmt, '--audio-quality', '2', '--max-filesize', '200M', '-o', path.join(dir, 'audio.%(ext)s'), target], 300000);
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
async function youtubeAudio({ query, url, format, source }, ctx) {
  if (!(await ffmpegOk())) return { error: NO_FFMPEG };
  if (!(await ytdlpPath())) return { error: NO_YTDLP };
  const fmt = ['mp3', 'm4a', 'ogg'].includes(String(format || 'mp3').toLowerCase()) ? String(format || 'mp3').toLowerCase() : 'mp3';
  const music = String(source || '').toLowerCase() === 'music' || /music\.youtube\.com/i.test(String(url || ''));
  let target = '', title = '';
  if (url && isYoutubeUrl(url)) { target = String(url); }
  else {
    const q = String(query || url || '').trim();
    if (!q) return { error: 'Tell me what to look for (a name or a few words).' };
    if (music) { target = 'https://music.youtube.com/search?q=' + encodeURIComponent(q); title = await ytdlpTitle(target); }   // 1.1.3: YouTube Music search
    else {
      try { const found = await searchYoutube(q); if (found.length) { target = found[0].url; title = found[0].title; } } catch {}
      if (!target) target = 'ytsearch1:' + q;      // yt-dlp searches itself when the page scrape fails
    }
  }
  const dir = workdir(ctx.userId);
  try {
    const f = await youtubeToFile(target, fmt, dir);
    return { ...(await sendAudioParts(ctx, f, fmt, title || (music ? 'YouTube Music audio' : 'YouTube audio'), dir)), ...(title ? { title } : {}), source: music ? 'YouTube Music' : 'YouTube' };
  } catch (e) { return { error: e.noYtdlp ? NO_YTDLP : (music ? 'YouTube Music' : 'YouTube') + ' download failed: ' + errLine(e) }; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export const MEDIA_TOOLS = [
  { name: 'youtube_audio', description: 'Find a video on YouTube (or a song on YouTube Music) and send its AUDIO to the person as file(s) attached to your answer, like voice notes they can play — they have no internet and can never open a YouTube link, so NEVER answer a YouTube request with a link. Give search words (the video/song/shiur name) or a YouTube / YouTube Music link. The best match is sent, in full and in clear quality; when it is long it arrives as several voice-note parts, one after another.',
    params: { query: S_('What to find, e.g. "Mordechai Shapiro Yedidim" or "shiur on emunah part 2"'), url: S_('A YouTube or YouTube Music link instead of search words (optional)'), source: S_('"music" to search YouTube Music instead of YouTube (songs) — only when they ask for YouTube Music'), format: S_('mp3 (default), m4a or ogg') },
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
];
export const _test = { download, probe, parseExt: (u) => (MEDIA_EXT.exec(u) || [])[1] || null, splitIntoParts, sendAudioParts };
