// Message Assistant 1.0.1: self-update, the dashboard side.
// The real work is done by root: /usr/local/sbin/messageassistant-update (written by install.sh), started
//   - every ~6 hours by messageassistant-update.timer  → `messageassistant update --auto` (skips when Auto-update is off)
//   - right away when this app writes <data>/update-request ("Update now"; messageassistant-update.path watches it)
//   - by hand: sudo messageassistant update
// The app only writes three small files in its data folder: auto-update ("on"/"off"), update-request, and it reads
// update-status.json (written by the updater). It never runs anything as root.
import fs from 'node:fs';
import path from 'node:path';
import { cfg, VERSION } from './config.js';

export const GITHUB_DOCS = 'https://raw.githubusercontent.com/eliazer2499-max/Message-Assistant/main/docs';
const f = (n) => path.join(cfg.dataDir, n);

/** "1.0.10" > "1.0.9"; only plain x.y.z counts. */
export function newer(a, b) {
  const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
  if (x.length !== 3 || x.some(isNaN)) return false;
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
export function sources() {
  const out = [];
  for (let s of [process.env.MSA_UPDATE_SOURCE, GITHUB_DOCS]) {
    s = String(s || '').trim().replace(/\/+$/, '').replace(/\/version\.json$/, '');
    if (/^https?:\/\/[^\s/]+/.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}
export function autoOn() {
  try { return fs.readFileSync(f('auto-update'), 'utf8').trim() !== 'off'; } catch { return true; }   // default ON
}
export function setAuto(on) { fs.writeFileSync(f('auto-update'), on ? 'on\n' : 'off\n', { mode: 0o644 }); }
export function requestNow() { fs.writeFileSync(f('update-request'), String(Date.now()) + '\n', { mode: 0o644 }); }
function lastRun() {
  try { return JSON.parse(fs.readFileSync(f('update-status.json'), 'utf8')); } catch { return null; }
}

let cache = null;   // { at, latest, source, error }
async function fetchLatest() {
  const errors = [];
  let best = null;
  for (const base of sources()) {
    try {
      const r = await fetch(base + '/version.json', { headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'messageassistant-updater' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const v = String((await r.json())?.version || '').trim().replace(/^v/i, '');
      if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('no version');
      if (!best || newer(v, best.latest)) best = { latest: v, source: base };
      if (newer(best.latest, VERSION)) break;
    } catch (e) { errors.push(base.replace(/^https?:\/\//, '') + ': ' + (e.message || e)); }
  }
  return best ? { ...best, error: null } : { latest: null, source: null, error: errors.join('; ') || 'no source' };
}
export async function info({ fresh = false } = {}) {
  if (fresh || !cache || Date.now() - cache.at > 15 * 60 * 1000) cache = { at: Date.now(), ...(await fetchLatest()) };
  let pending = false; try { fs.accessSync(f('update-request')); pending = true; } catch {}
  const last = lastRun();
  if (last && last.result === 'running' && Date.now() - Date.parse(last.at || 0) < 20 * 60 * 1000) pending = true;
  return {
    current: VERSION, latest: cache.latest, update_available: !!cache.latest && newer(cache.latest, VERSION),
    checked_at: cache.at, check_error: cache.error, auto: autoOn(), every_hours: 6, pending, last,
  };
}
