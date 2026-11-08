// 1.0.2: websites for every approved person (Abish, Nov 8 2026: "Yes, add it there as well, but there allow admin to
// set if it needs additional approval.").
//   - Each person has their own workspace folder (<data>/workspaces/<user id>/<project>/…). Every path is resolved inside
//     it and checked again after symlinks, so nobody can read, write or publish another person's files.
//   - Limits (admin): size per person (workspace + published sites, default 50 MB), sites per person (default 5).
//   - Who can build: everyone (default), only chosen people, or nobody (setting sites_mode = all | chosen | off).
//   - Publishing: the person's one YES. With "admin approves" on (sites_approval = 1) the YES files it for the admin,
//     who gets the name, the site, a picture and a private preview link (text + dashboard) and answers YES / NO.
//   - Live at <address>/sites/<slug>-<site>/ (slug = their name + their number, e.g. moshe7-bakery).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { all, get, run, now, setting, setSetting, audit, log } from './db.js';
import { userById, adminPhones, userByPhone, publicUser, whenRemoved } from './users.js';
import { SITE_NAME } from './siteserve.js';

export const USER_EXPIRY_MS = 30 * 60 * 1000;          // the person's YES must come within 30 min
export const ADMIN_EXPIRY_MS = 3 * 24 * 3600 * 1000;   // the admin has 3 days
export const FRESH_MS = 10 * 60 * 1000;
export const MAX_FILE = 2 * 1024 * 1024;
const MB = 1024 * 1024;

export const dirs = {
  workspaces: () => path.join(cfg.dataDir, 'workspaces'),
  sites: () => path.join(cfg.dataDir, 'sites'),
  staging: () => path.join(cfg.dataDir, 'site-staging'),
  media: () => path.join(cfg.dataDir, 'media'),
};
const err = (m, status = 400) => Object.assign(new Error(m), { status });

// ---------------- settings ----------------
export function mode() { const m = setting('sites_mode'); return ['all', 'chosen', 'off'].includes(m) ? m : 'all'; }
export function approvalOn() { return setting('sites_approval') === '1'; }
export function quotaBytes() { const n = parseFloat(setting('sites_quota_mb')); return Math.round((n > 0 && n <= 10240 ? n : 50) * MB); }
export function maxSites() { const n = parseInt(setting('sites_max'), 10); return n >= 0 && n <= 1000 ? n : 5; }
export function config() {
  return { mode: mode(), approval: approvalOn(), quota_mb: Math.round(quotaBytes() / MB * 10) / 10, max_sites: maxSites(),
    chosen: all("SELECT id FROM users WHERE sites_allowed=1 AND status='approved'").map(r => r.id) };
}
export function setConfig(b = {}, actor = 'admin') {
  const changed = [];
  if (b.mode !== undefined) { if (!['all', 'chosen', 'off'].includes(b.mode)) throw err('mode must be all, chosen or off'); setSetting('sites_mode', b.mode); changed.push('building ' + b.mode); }
  if (b.approval !== undefined) { const on = b.approval === true || b.approval === '1' || b.approval === 'on'; setSetting('sites_approval', on ? '1' : '0'); changed.push('admin approval ' + (on ? 'on' : 'off')); }
  if (b.quota_mb !== undefined) { const n = parseFloat(b.quota_mb); if (!(n > 0 && n <= 10240)) throw err('Size per person: 1 to 10240 MB'); setSetting('sites_quota_mb', String(n)); changed.push('size ' + n + ' MB'); }
  if (b.max_sites !== undefined) { const n = parseInt(b.max_sites, 10); if (!(n >= 0 && n <= 1000)) throw err('Sites per person: 0 to 1000'); setSetting('sites_max', String(n)); changed.push('max ' + n + ' sites'); }
  if (Array.isArray(b.chosen)) {
    run('UPDATE users SET sites_allowed=NULL WHERE sites_allowed=1');
    for (const id of b.chosen) run('UPDATE users SET sites_allowed=1 WHERE id=?', Number(id));
    changed.push('chosen people: ' + b.chosen.length);
  }
  if (changed.length) audit(actor, 'sites.settings', changed.join(', '));
  return config();
}
export function setAllowed(userId, on, actor = 'admin') {
  run('UPDATE users SET sites_allowed=? WHERE id=?', on ? 1 : null, Number(userId));
  audit(actor, 'sites.allowed', `#${userId} ${on ? 'can' : 'cannot'} build sites (when "only chosen people")`);
}
/** Can this person build and publish sites? */
export function allowed(user) {
  const u = typeof user === 'object' ? user : userById(user);
  if (!u || u.status !== 'approved') return false;
  const m = mode();
  if (m === 'off') return false;
  if (m === 'chosen') return u.sites_allowed === 1 || isAdminUser(u);
  return true;
}
export function isAdminUser(u) { return !!u && adminPhones().includes(u.phone); }

// ---------------- names and folders ----------------
export function safeName(n, what = 'name') {
  const s = String(n ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(s)) throw err(`Bad ${what} "${String(n).slice(0, 60)}": use letters, numbers and dashes (up to 40)`);
  return s;
}
/** The person's part of the address: their first name (letters only) + their number, fixed the first time. */
export function slugOf(userId) {
  const u = userById(userId); if (!u) throw err('No such person', 404);
  if (u.site_slug) return u.site_slug;
  let s = {}; try { s = JSON.parse(u.settings || '{}'); } catch {}
  const first = String(s.name || u.name || '').normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().split(/\s+/)[0] || '';
  const letters = /^\+?[\d\s().-]*$/.test(u.name || '') && !s.name ? '' : first.replace(/[^a-z]/g, '').slice(0, 12);
  const slug = (letters || 'u') + u.id;
  run('UPDATE users SET site_slug=? WHERE id=?', slug, u.id);
  return slug;
}
export function publicName(userId, site) { return slugOf(userId) + '-' + safeName(site, 'site name'); }
export function siteUrl(pub) { return `${cfg.publicUrl}/sites/${pub}/`; }

export function userRoot(userId, create = false) {
  const id = Number(userId); if (!Number.isInteger(id) || id <= 0) throw err('No such person');
  const d = path.join(dirs.workspaces(), String(id));
  if (create) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
export function projectDir(userId, project, create = false) {
  const base = userRoot(userId, create);
  const d = path.join(base, safeName(project, 'project name'));
  if (create) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  else if (!fs.existsSync(d)) throw err(`No project "${project}" yet. Write a file into it to create it.`, 404);
  return d;
}
function inside(base, p) {
  const rb = fs.realpathSync(base);
  return p === rb || p.startsWith(rb + path.sep);
}
/** A path inside one person's project. Refuses .., absolute tricks, hidden files and symlinks that lead out. */
export function inProject(userId, project, rel, create = false) {
  const base = projectDir(userId, project, create);
  const r = String(rel ?? '.').replace(/\\/g, '/');
  if (r.includes('\0')) throw err('Bad path');
  const parts = r.split('/').filter(x => x && x !== '.');
  if (parts.some(x => x === '..' || x.startsWith('.'))) throw err('That path leaves the project folder (no .. or hidden files)');
  const p = path.resolve(base, ...parts);
  if (p !== base && !p.startsWith(base + path.sep)) throw err('That path leaves the project folder');
  // the deepest part that exists must still be inside (no symlink out)
  let probe = p;
  while (!fs.existsSync(probe) && probe !== base) probe = path.dirname(probe);
  if (!inside(base, fs.realpathSync(probe))) throw err('That path leaves the project folder');
  return p;
}

export function dirBytes(d) {
  let n = 0;
  const walk = (p) => { let st; try { st = fs.lstatSync(p); } catch { return; } if (st.isSymbolicLink()) return; if (st.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); } else n += st.size; };
  walk(d); return n;
}
/** Bytes this person uses: their workspace + their published sites. */
export function usedBytes(userId) {
  let n = 0;
  try { n += dirBytes(userRoot(userId)); } catch {}
  for (const s of all('SELECT bytes FROM sites WHERE user_id=?', Number(userId))) n += s.bytes || 0;
  return n;
}
const mb = (b) => b < MB ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / MB).toFixed(b < 10 * MB ? 1 : 0) + ' MB';
export function usageText(userId) { return `${mb(usedBytes(userId))} of ${mb(quotaBytes())} used`; }

// ---------------- the person's files ----------------
export function listProjects(userId) {
  const base = userRoot(userId);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => ({ name: d.name, size: mb(dirBytes(path.join(base, d.name))) }));
}
export function writeFile(userId, project, rel, content) {
  const text = String(content ?? '');
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_FILE) throw err('That file is over 2 MB. Split it into smaller files.');
  const p = inProject(userId, project, rel, true);
  if (p === projectDir(userId, project)) throw err('Give a file name, like index.html');
  const old = fs.existsSync(p) && fs.statSync(p).isFile() ? fs.statSync(p).size : 0;
  if (usedBytes(userId) - old + bytes > quotaBytes()) throw err(`Not enough space: ${usageText(userId)}. Delete some files or ask the admin for more.`);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, text, { mode: 0o600 });
  return { written: path.relative(projectDir(userId, project), p), bytes };
}
export function readFile(userId, project, rel) {
  const p = inProject(userId, project, rel);
  const st = fs.statSync(p);
  if (!st.isFile()) throw err('That is a folder, not a file');
  if (st.size > MAX_FILE) throw err('That file is over 2 MB');
  return fs.readFileSync(p);
}
export function listFiles(userId, project, rel = '.') {
  const base = inProject(userId, project, rel);
  const out = [];
  const walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.') || e.isSymbolicLink()) continue; const p = path.join(d, e.name); out.push(path.relative(base, p) + (e.isDirectory() ? '/' : '')); if (e.isDirectory() && depth < 5 && out.length < 300) walk(p, depth + 1); } };
  walk(base, 0);
  return out.slice(0, 300);
}
export function deletePath(userId, project, rel) {
  const p = inProject(userId, project, rel || '.');
  if (!fs.existsSync(p)) throw err('Nothing there', 404);
  fs.rmSync(p, { recursive: true, force: true });
  return { deleted: rel && rel !== '.' ? rel : 'project ' + project };
}

function copyTree(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, dereference: false, filter: (s) => { const r = path.relative(src, s); return !r || !r.split(path.sep).some(x => x.startsWith('.') && x !== '.well-known'); } });
  const fix = (p) => { const st = fs.lstatSync(p); if (st.isSymbolicLink()) { fs.rmSync(p); return; } fs.chmodSync(p, st.isDirectory() ? 0o755 : 0o644); if (st.isDirectory()) for (const f of fs.readdirSync(p)) fix(path.join(p, f)); };
  fix(dst);
}

// ---------------- private media / preview links ----------------
const token = () => crypto.randomBytes(18).toString('base64url');
/** Save a picture (or a file to send) and give it a private, unguessable link (7 days). */
export function saveMedia(buf, { userId = null, ext = 'png', name = null } = {}) {
  fs.mkdirSync(dirs.media(), { recursive: true, mode: 0o700 });
  const t = token();
  const file = path.join(dirs.media(), t + '.' + String(ext).replace(/[^a-z0-9]/gi, '').slice(0, 8));
  fs.writeFileSync(file, buf, { mode: 0o600 });
  run('INSERT INTO media(token, file, name, user_id, created, expires) VALUES(?,?,?,?,?,?)', t, file, name, userId, now(), now() + 7 * 24 * 3600 * 1000);
  return { token: t, file, url: `${cfg.publicUrl}/m/${t}/${encodeURIComponent(name || path.basename(file))}` };
}
export function mediaByToken(t) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(t))) return null;
  const r = get('SELECT * FROM media WHERE token=? AND expires>?', String(t), now());
  return r && fs.existsSync(r.file) ? r : null;
}
export function cleanMedia() {
  for (const r of all('SELECT token, file FROM media WHERE expires<?', now())) { try { fs.rmSync(r.file, { force: true }); } catch {} run('DELETE FROM media WHERE token=?', r.token); }
}

// ---------------- requests ----------------
// status: ask_user (waiting for the person's YES) → ask_admin (waiting for the admin) → published
//         or cancelled / rejected / expired / replaced / failed
export function expire() {
  const rows = all("SELECT * FROM site_requests WHERE (status='ask_user' AND created<?) OR (status='ask_admin' AND updated<?)", now() - USER_EXPIRY_MS, now() - ADMIN_EXPIRY_MS);
  for (const r of rows) {
    run("UPDATE site_requests SET status='expired', updated=? WHERE id=?", now(), r.id);
    dropStaging(r.id);
    audit('system', 'site.expired', `S${r.id} ${r.site}`);
    if (r.status === 'ask_admin') expiredNotice?.(r);
  }
  return rows;
}
let expiredNotice = null;
export function onAdminExpired(fn) { expiredNotice = fn; }
export function requestById(id) { return get('SELECT * FROM site_requests WHERE id=?', Number(id)) || null; }
export function waitingForUser(userId) { expire(); return all("SELECT * FROM site_requests WHERE user_id=? AND status='ask_user' ORDER BY id", Number(userId)); }
export function waitingForAdmin() { expire(); return all("SELECT * FROM site_requests WHERE status='ask_admin' ORDER BY id"); }

/** Checks for a publish (also at the moment it goes live). */
function checkLimits(userId, site, extraBytes = 0) {
  const pub = publicName(userId, site);
  const mine = all('SELECT public_name FROM sites WHERE user_id=?', Number(userId)).map(r => r.public_name);
  if (!mine.includes(pub) && mine.length >= maxSites()) throw err(maxSites() ? `You already have ${mine.length} sites (the most allowed is ${maxSites()}). Unpublish one first.` : 'Publishing sites is not allowed here.');
  if (extraBytes && usedBytes(userId) + extraBytes > quotaBytes()) throw err(`Not enough space to publish: ${usageText(userId)}.`);
  return pub;
}
/** publish_site: file a request for the person's YES (a newer request for the same site replaces the old one). */
export function fileRequest(userId, { project, site, folder = '.' }) {
  const u = userById(userId);
  if (!allowed(u)) throw err('Building sites is not turned on for you here. Ask the admin.', 403);
  const s = safeName(site || project, 'site name');
  const src = inProject(userId, project, folder || '.');
  if (!fs.existsSync(path.join(src, 'index.html'))) throw err('That folder has no index.html yet.');
  const pub = checkLimits(userId, s);
  const size = dirBytes(src);
  if (size > quotaBytes()) throw err(`That site is ${mb(size)}; the most allowed is ${mb(quotaBytes())}.`);
  expire();
  const old = all("SELECT id FROM site_requests WHERE user_id=? AND site=? AND status IN ('ask_user','ask_admin')", u.id, s);
  for (const o of old) { run("UPDATE site_requests SET status='replaced', updated=? WHERE id=?", now(), o.id); dropStaging(o.id); }
  const r = run("INSERT INTO site_requests(user_id, site, public_name, project, folder, status, created, updated) VALUES(?,?,?,?,?,'ask_user',?,?)",
    u.id, s, pub, safeName(project, 'project name'), String(folder || '.'), now(), now());
  const id = Number(r.lastInsertRowid);
  audit('user#' + u.id, 'site.requested', `S${id} ${pub} (${project}/${folder || '.'})`);
  return requestById(id);
}
export function stagingDir(id) { return path.join(dirs.staging(), String(Number(id))); }
function dropStaging(id) { try { fs.rmSync(stagingDir(id), { recursive: true, force: true }); } catch {} }
/** Freeze what will go live (what the admin previews is exactly what is published). */
export function stage(r) {
  const src = inProject(r.user_id, r.project, r.folder || '.');
  if (!fs.existsSync(path.join(src, 'index.html'))) throw err('That folder has no index.html any more.');
  fs.mkdirSync(dirs.staging(), { recursive: true, mode: 0o700 });
  copyTree(src, stagingDir(r.id));
  const t = r.preview_token || token();
  run('UPDATE site_requests SET preview_token=?, updated=? WHERE id=?', t, now(), r.id);
  return { dir: stagingDir(r.id), token: t };
}
export function previewUrl(r) { return r.preview_token ? `${cfg.publicUrl}/preview/${r.preview_token}/` : null; }
export function requestByPreview(t) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(t))) return null;
  return get("SELECT * FROM site_requests WHERE preview_token=? AND status='ask_admin'", String(t)) || null;
}

/** Make it live: the staged copy (or the project now) → <data>/sites/<public name>. */
export function goLive(r, actor) {
  const dir = fs.existsSync(stagingDir(r.id)) ? stagingDir(r.id) : stage(r).dir;
  const size = dirBytes(dir);
  const prev = get('SELECT * FROM sites WHERE public_name=?', r.public_name);
  checkLimits(r.user_id, r.site, Math.max(0, size - (prev ? prev.bytes : 0)));
  fs.mkdirSync(dirs.sites(), { recursive: true, mode: 0o755 });
  const dst = path.join(dirs.sites(), r.public_name), tmp = dst + '.new-' + r.id;
  copyTree(dir, tmp);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.renameSync(tmp, dst);
  if (prev) run('UPDATE sites SET bytes=?, updated=?, project=?, request_id=? WHERE id=?', size, now(), r.project, r.id, prev.id);
  else run('INSERT INTO sites(user_id, name, public_name, project, bytes, created, updated, request_id) VALUES(?,?,?,?,?,?,?,?)', r.user_id, r.site, r.public_name, r.project, size, now(), now(), r.id);
  run("UPDATE site_requests SET status='published', decided_by=?, updated=? WHERE id=?", actor, now(), r.id);
  dropStaging(r.id);
  audit(actor, 'site.published', `${r.public_name} (S${r.id}, ${mb(size)})`);
  return siteUrl(r.public_name);
}
export function setStatus(id, status, actor) { run('UPDATE site_requests SET status=?, decided_by=?, updated=? WHERE id=?', status, actor, now(), Number(id)); dropStaging(id); }

// ---------------- published sites ----------------
export function listSites(userId = null) {
  const rows = userId ? all('SELECT * FROM sites WHERE user_id=? ORDER BY updated DESC', Number(userId)) : all('SELECT * FROM sites ORDER BY updated DESC');
  return rows.map(s => { const u = userById(s.user_id); return { id: s.id, user_id: s.user_id, user: u ? publicUser(u).label : '#' + s.user_id, name: s.name, public_name: s.public_name, url: siteUrl(s.public_name), size: mb(s.bytes || 0), bytes: s.bytes || 0, created: s.created, updated: s.updated }; });
}
/** Take a site down. userId given = only that person's own site. */
export function unpublish({ userId = null, name = null, id = null }, actor) {
  let s;
  if (id !== null) s = get('SELECT * FROM sites WHERE id=?', Number(id));
  else {
    const n = String(name || '').trim().toLowerCase();
    s = userId ? get('SELECT * FROM sites WHERE user_id=? AND (name=? OR public_name=?)', Number(userId), n, n) : get('SELECT * FROM sites WHERE public_name=?', n);
  }
  if (!s || (userId && s.user_id !== Number(userId))) throw err(userId ? `You have no published site called "${name}".` : 'No such site', 404);
  fs.rmSync(path.join(dirs.sites(), s.public_name), { recursive: true, force: true });
  run('DELETE FROM sites WHERE id=?', s.id);
  audit(actor, 'site.unpublished', s.public_name);
  return s;
}
/** Removing a person removes their files, sites and requests too. */
export function forgetUser(userId) {
  for (const s of all('SELECT * FROM sites WHERE user_id=?', Number(userId))) fs.rmSync(path.join(dirs.sites(), s.public_name), { recursive: true, force: true });
  for (const r of all('SELECT id FROM site_requests WHERE user_id=?', Number(userId))) dropStaging(r.id);
  run('DELETE FROM sites WHERE user_id=?', Number(userId)); run('DELETE FROM site_requests WHERE user_id=?', Number(userId));
  try { fs.rmSync(userRoot(userId), { recursive: true, force: true }); } catch {}
}
whenRemoved(forgetUser);
export function adminUsers() { return adminPhones().map(p => userByPhone(p)).filter(Boolean); }
export { log };
