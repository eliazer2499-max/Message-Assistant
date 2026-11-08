// Message Assistant: self-update, the dashboard side. MANUAL ONLY: nothing installs by itself.
// The real work is done by root: /usr/local/sbin/messageassistant-update (written by install.sh), started
//   - right away when this app writes <data>/update-request ("Update now"; messageassistant-update.path watches it)
//   - by hand: sudo messageassistant update
// There is no update timer (1.0.1 removed it). 1.0.2 adds a once-a-day CHECK in the app: it only shows a badge and
// texts the admin once per new version (Settings can turn the text off); it never installs.
// The app only writes small files in its data folder (update-request, update-source) and reads update-status.json / update.log
// (written by the updater). It never runs anything as root.
import fs from 'node:fs';
import path from 'node:path';
import { cfg, VERSION } from './config.js';

export const GITHUB_DOCS = (cfg.testMode && process.env.MSA_TEST_DEFAULT_SOURCE) || 'https://raw.githubusercontent.com/eliazer2499-max/Message-Assistant/main/docs';   // the override is for tests only
const f = (n) => path.join(cfg.dataDir, n);

/** "1.0.10" > "1.0.9"; only plain x.y.z counts. */
export function newer(a, b) {
  const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
  if (x.length !== 3 || x.some(isNaN)) return false;
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
// 1.0.3: the admin can choose where updates come from (Settings → Updates → Update source, or
// `sudo messageassistant update-source set <url>`). It is saved in <data>/update-source (one line); the root updater
// reads the same file and checks it again itself. Only https; a GitHub repo link means its /docs folder on main.
let cache = null;   // { at, latest, source, error }
export const SOURCE_RE = /^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:\d{1,5})?(\/[A-Za-z0-9._~%+=,\/-]*)?$/;
const LOCAL_TEST_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}(\/[A-Za-z0-9._~%+=,\/-]*)?$/;   // tests only (MSA_TEST_MODE=1)
/** Clean up what was typed: spaces, trailing /, a pasted .../version.json, a GitHub repo link → its /docs on main. */
export function normalizeSource(s) {
  s = String(s || '').trim().replace(/\/+$/, '').replace(/\/version\.json$/i, '').replace(/\/+$/, '');
  const gh = s.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?(?:\/tree\/([A-Za-z0-9_.\/-]{1,100}?))?$/i);
  if (gh) {
    const [, owner, repo, rest] = gh;
    const parts = rest ? rest.split('/') : ['main'];
    const branch = parts[0], folder = parts.slice(1).join('/') || 'docs';
    s = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${folder}`;
  }
  return s;
}
/** The address check (also used by the CLI). Throws a short, plain error. */
export function checkSource(s) {
  const v = normalizeSource(s);
  if (!v) throw new Error('Type an address, or press Reset to default');
  if (v.length > 300) throw new Error('That address is too long');
  if (/^http:\/\//i.test(v) && !(cfg.testMode && LOCAL_TEST_RE.test(v))) throw new Error('The address must start with https://');
  if (!SOURCE_RE.test(v) && !(cfg.testMode && LOCAL_TEST_RE.test(v))) throw new Error('Not a valid address. Example: https://updates.example.com/docs');
  return v;
}
/** The saved address, or '' for the default. A bad file is ignored (the root updater ignores it too). */
export function savedSource() {
  try { const v = normalizeSource(fs.readFileSync(f('update-source'), 'utf8').split('\n')[0]); return checkSource(v); } catch { return ''; }
}
export function setSource(s) {
  const v = checkSource(s);
  if (v === GITHUB_DOCS) { resetSource(); return ''; }
  fs.writeFileSync(f('update-source.tmp'), v + '\n', { mode: 0o644 }); fs.renameSync(f('update-source.tmp'), f('update-source'));
  cache = null;
  return v;
}
export function resetSource() { try { fs.rmSync(f('update-source'), { force: true }); } catch {} cache = null; }
export function sources() {
  const out = [];
  for (let s of [savedSource(), process.env.MSA_UPDATE_SOURCE, GITHUB_DOCS]) {
    s = normalizeSource(s);
    if (/^https?:\/\/[^\s/]+/.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}
export function sourceInfo() {
  const saved = savedSource();
  return { source: saved, source_default: GITHUB_DOCS, sources: sources() };
}
export function autoOn() {
  try { return fs.readFileSync(f('auto-update'), 'utf8').trim() !== 'off'; } catch { return true; }   // default ON
}
export function setAuto(on) { fs.writeFileSync(f('auto-update'), on ? 'on\n' : 'off\n', { mode: 0o644 }); }
export function requestNow() { fs.writeFileSync(f('update-request'), String(Date.now()) + '\n', { mode: 0o644 }); }
function lastRun() {
  try { return JSON.parse(fs.readFileSync(f('update-status.json'), 'utf8')); } catch { return null; }
}

// 1.0.3: a check ALWAYS ends. Every source is asked at the same time, each with its own time limit, and the whole
// check has one deadline (CHECK_MS). The first source in the list wins when it answers; otherwise the next one.
export const CHECK_MS = Number(process.env.MSA_UPDATE_CHECK_MS) || 12000;
const short = (base) => base.replace(/^https?:\/\//, '');
function plainError(e) {
  const m = String((e && (e.message || e)) || '');
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'no answer in time';
  if (/^HTTP 404/.test(m)) return 'no version.json there (404)';
  if (/^HTTP \d+/.test(m)) return 'it answered ' + m.replace('HTTP ', 'error ');
  if (/no version|JSON|Unexpected token|not valid/i.test(m)) return 'its version.json is not valid';
  if (/ENOTFOUND|EAI_AGAIN/.test(m + (e?.cause?.code || ''))) return 'address not found';
  return 'could not connect';
}
async function askSource(base, signal) {
  const r = await fetch(base + '/version.json?t=' + Date.now(), { headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'messageassistant-updater' }, redirect: 'follow', signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = (await r.text()).slice(0, 200000);
  let j; try { j = JSON.parse(text); } catch { throw new Error('not valid JSON'); }
  const v = String(j?.version || '').trim().replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('no version');
  return { latest: v, source: base, notes: String(j.notes || '').slice(0, 4000), date: String(j.date || '').slice(0, 20) };
}
async function fetchLatest() {
  const list = sources();
  const deadline = AbortSignal.timeout(CHECK_MS);
  const asks = list.map(base => askSource(base, AbortSignal.any([deadline, AbortSignal.timeout(CHECK_MS - 500)]))
    .then(v => ({ ok: true, v }), e => ({ ok: false, base, e })));
  // a hard stop even if something below ignores the abort
  let timer; const stop = new Promise(r => { timer = setTimeout(() => r('deadline'), CHECK_MS + 500); timer.unref?.(); });
  const results = await Promise.race([Promise.all(asks), stop]); clearTimeout(timer);
  if (results === 'deadline') return { latest: null, source: null, error: 'no source answered in time', errors: list.map(b => short(b) + ': no answer in time') };
  let best = null; const errors = [];
  for (const r of results) {        // in list order: the first answer wins unless a later one has a NEWER version
    if (!r.ok) { errors.push(short(r.base) + ': ' + plainError(r.e)); continue; }
    if (!best || newer(r.v.latest, best.latest)) best = r.v;
  }
  return best ? { ...best, error: null, errors } : { latest: null, source: null, error: errors.join('; ') || 'no source', errors };
}
let inflight = null;
function check() { if (!inflight) inflight = fetchLatest().finally(() => { inflight = null; }); return inflight; }

/** Words for the dashboard: one of three endings, never "checking" forever. */
function outcome(c) {
  if (c.latest && newer(c.latest, VERSION)) return { state: 'available', words: `${c.latest} available — Update now` };
  if (c.latest) return { state: 'up_to_date', words: `Up to date (${VERSION})` };
  return { state: 'error', words: 'Couldn\'t reach the update source', detail: c.error || '' };
}
const STUCK_MS = 3 * 60 * 1000;
export async function info({ fresh = false } = {}) {
  if (fresh || !cache || Date.now() - cache.at > 15 * 60 * 1000) cache = { at: Date.now(), ...(await check()) };
  let pending = false, stuck = false;
  let reqAt = 0; try { reqAt = fs.statSync(f('update-request')).mtimeMs; pending = true; } catch {}
  const last = lastRun();
  const running = !!(last && last.result === 'running' && Date.now() - Date.parse(last.at || 0) < 20 * 60 * 1000);
  // 1.0.3: "Update now" leaves a request file that root's updater removes within seconds. If it is still there after
  // a few minutes, the updater did not start: say so instead of "starting…" forever.
  if (pending && !running && Date.now() - reqAt > STUCK_MS) { pending = false; stuck = true; }
  if (running) pending = true;
  const o = outcome(cache);
  return {
    current: VERSION, latest: cache.latest, update_available: !!cache.latest && newer(cache.latest, VERSION), notes: cache.notes || '', date: cache.date || '',
    checked_at: cache.at, check_error: cache.error, checked_from: cache.source ? short(cache.source) : null, ...o,
    auto: autoOn(), every_hours: 6, pending, stuck, last, ...sourceInfo(),
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
