// 1.1.20: incoming voice notes arrive in whatever format the phone used (m4a, AMR, Ogg…) — but the AI
// models only reliably open MP3/WAV. Gemini refused a captured m4a outright ('the file or media data
// is empty, corrupted, or malformed', FLS's brain.switch line, 2026-11-23) even when the bytes were
// whole, and OpenAI-style models take a voice clip only as mp3/wav input_audio. So every incoming
// voice note is converted to MP3 once, when the router saves it. If the conversion cannot be done
// (not real audio, ffmpeg missing), the original bytes are kept and nothing breaks — the caller
// decides from the null.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { log } from './db.js';

function run(cmd, args, ms) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: ms, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) { e.stderr = String(stderr || '').slice(-600); reject(e); } else resolve({ stdout, stderr });
    });
  });
}

/** Voice-note bytes in any format ffmpeg knows → MP3 bytes, or null when it cannot be converted. */
export async function audioToMp3(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-audio-'));
  try {
    const inF = path.join(dir, 'in.audio'), outF = path.join(dir, 'out.mp3');
    fs.writeFileSync(inF, buf, { mode: 0o600 });
    await run('ffmpeg', ['-y', '-v', 'error', '-i', inF, '-vn', '-codec:a', 'libmp3lame', '-q:a', '4', outF], 60000);
    const out = fs.readFileSync(outF);
    return out.length ? out : null;
  } catch (e) {
    log('audioconv', 'conversion failed:', String(e.stderr || e.message || e).slice(0, 200));
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
