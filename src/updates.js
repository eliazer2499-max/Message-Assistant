// Message Assistant: self-update, the dashboard side. MANUAL ONLY: nothing installs by itself.
// The real work is done by root: /usr/local/sbin/messageassistant-update (written by install.sh), started
//   - right away when this app writes <data>/update-request ("Update now"; messageassistant-update.path watches it)
//   - by hand: sudo messageassistant update
// There is no update timer (1.0.1 removed it). 1.0.2 adds a once-a-day CHECK in the app: it only shows a badge and
// texts the admin once per new version (Settings can turn the text off); it never installs.
// The app only writes small files in its data folder (update-request) and reads update-status.json / update.log
// (written by the updater). It never runs anything as root.
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
      const j = await r.json();
      const v = String(j?.version || '').trim().replace(/^v/i, '');
      if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('no version');
      if (!best || newer(v, best.latest)) best = { latest: v, source: base, notes: String(j.notes || '').slice(0, 4000), date: String(j.date || '').slice(0, 20) };
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
    current: VERSION, latest: cache.latest, update_available: !!cache.latest && newer(cache.latest, VERSION), notes: cache.notes || '', date: cache.date || '',
    checked_at: cache.at, check_error: cache.error, auto: autoOn(), every_hours: 6, pending, last,
  };
}

// ---------- 1.0.2: the update log while it runs, a once-a-day check (badge + one optional text), never an install ----------
export function logTail(lines = 40) {
  try { const t = fs.readFileSync(f('update.log'), 'utf8'); return t.split('\n').slice(-lines).join('\n').replace(/[^\x09\x0a\x20-\x7e\u00a0-\uffff]/g, ''); } catch { return ''; }
}
/** For the dashboard's badge (from the last check; no network). */
export function badge() { return { available: !!(cache && cache.latest && newer(cache.latest, VERSION)), latest: cache ? cache.latest : null }; }
let dailyTimer = null;
/** Once a day: check; when a NEW version shows up the first time, text the admin once (Settings can turn the text off). */
export async function dailyCheck({ notify } = {}) {
  const i = await info({ fresh: true });
  if (!i.update_available) return { checked: true, available: false };
  const { setting, setSetting } = await import('./db.js');
  if (setting('update_notified') === i.latest) return { checked: true, available: true, notified: false };
  setSetting('update_notified', i.latest);
  if (setting('update_notify') !== '0' && notify) notify(`Message Assistant ${i.latest} is available (this server: ${VERSION}). To install: dashboard → Settings → Updates → Update now.`);
  return { checked: true, available: true, notified: setting('update_notify') !== '0' };
}
export function startDailyCheck(notify, ms = 24 * 3600 * 1000) {
  if (dailyTimer) return;
  const go = () => dailyCheck({ notify }).catch(() => {});
  setTimeout(go, cfg.testMode ? 10 : 5 * 60 * 1000).unref?.();
  dailyTimer = setInterval(go, ms); dailyTimer.unref?.();
}
export function stopDailyCheck() { if (dailyTimer) clearInterval(dailyTimer); dailyTimer = null; }
