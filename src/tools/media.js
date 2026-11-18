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

export const MEDIA_TOOLS = [
  { name: 'extract_audio', description: 'Extract the audio from a video (or convert an audio file) and send the person the audio FILE itself as an attachment to your answer. Give a direct link to the video/audio file (…mp4/.mov/.webm/.mp3). format: mp3 (default), m4a or ogg. Use it when they ask for the audio/soundtrack of a video, or to turn a video into audio they can listen to.',
    params: { url: S_('Direct link to the video or audio file'), format: S_('mp3, m4a or ogg (default mp3)'), name: S_('File name to send (optional)') }, required: ['url'],
    run: async ({ url, format = 'mp3', name }, ctx) => {
      if (!(await ffmpegOk())) return { error: NO_FFMPEG };
      const fmt = ['mp3', 'm4a', 'ogg'].includes(String(format).toLowerCase()) ? String(format).toLowerCase() : 'mp3';
      const dir = workdir(ctx.userId);
      try {
        const input = await download(url, dir);
        const before = await probe(input).catch(() => null);
        const out = path.join(dir, 'audio.' + fmt);
        const codec = fmt === 'mp3' ? ['-codec:a', 'libmp3lame', '-q:a', '4'] : fmt === 'm4a' ? ['-codec:a', 'aac', '-b:a', '128k'] : ['-codec:a', 'libopus', '-b:a', '96k'];
        await run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-vn', ...codec, out]);
        const buf = fs.readFileSync(out);
        if (!buf.length) return { error: 'The conversion came out empty — that file may have no audio track.' };
        const fname = String(name || 'audio').replace(/[^\w .()-]+/g, '').slice(0, 60).trim() || 'audio';
        const media = S.saveMedia(buf, { userId: ctx.userId, ext: fmt, name: fname + '.' + fmt });
        ctx.files = [...(ctx.files || []), { media, type: 'audio/' + (fmt === 'mp3' ? 'mpeg' : fmt) }];
        const after = await probe(out).catch(() => null);
        return { ok: true, sent_as_attachment: fname + '.' + fmt, size_mb: Math.round(buf.length / 104857.6) / 10,
          ...(before?.duration_seconds ? { source_duration_seconds: before.duration_seconds } : {}), ...(after?.duration_seconds ? { audio_duration_seconds: after.duration_seconds } : {}),
          note: 'The audio file itself is attached right after your answer. Tell them in one short line what it is; do NOT send any link.' };
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
export const _test = { download, probe, parseExt: (u) => (MEDIA_EXT.exec(u) || [])[1] || null };
