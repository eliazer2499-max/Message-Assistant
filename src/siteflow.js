// 1.0.2: the conversation side of sites — the one YES, the admin's approval, the pictures. Kept short on purpose.
//   The person asks for a site to go online → publish_site files a request → right after the AI's answer the person
//   gets ONE question (with a picture): 'Publish "bakery" at <link>? Reply YES.' (a code only when 2+ are waiting).
//   YES → live (approval off), or → "Waiting for admin approval." once, and the admin gets the request (picture +
//   private preview link) by text and in the dashboard; the admin's YES/NO (or Approve/Reject) → the person hears it.
import fs from 'node:fs';
import { all, get, run, now, audit, log } from './db.js';
import { userById, publicUser, addMessage, adminPhones } from './users.js';
import { enqueueText } from './outbox.js';
import * as S from './sites.js';
import * as B from './browser.js';
import { alert } from './alerts.js';

// ---------- pictures ----------
let shooter = (userId, dir, opts) => B.shootFolder(userId, dir, opts);
export function setShooter(fn) { shooter = fn; }       // tests
/** A phone-size picture of a folder → { media } (a private link + file) or { error }. */
export async function picture(userId, dir, opts = {}) {
  try {
    const buf = await shooter(userId, dir, opts);
    if (!buf || !buf.length) return { error: 'no picture' };
    return { media: S.saveMedia(buf, { userId, ext: 'png', name: 'site.png' }), buf };
  } catch (e) {
    const m = String(e.message || e);
    return { error: /Executable doesn't exist|browserType\.launch|Failed to launch|Cannot find module/i.test(m) ? 'The browser is not installed on this server, so no picture.' : 'Could not take the picture: ' + m.slice(0, 200) };
  }
}
/** Queue a picture for someone (then the text, if any). */
export function sendPicture({ userId = null, toPhone = null, media, text = '', kind = 'reply' }) {
  return enqueueText({ userId, toPhone, text: text || ' ', kind, media: media.file, mediaUrl: media.url });
}

// a picture of this project already reached the person and nothing changed since → the question goes without a second one
const lastPic = new Map();      // `${userId}:${project}` → time sent
export function notePicSent(userId, project) { lastPic.set(userId + ':' + project, Date.now()); }
function newestChange(dir) {
  let t = 0;
  const walk = (p) => { let st; try { st = fs.lstatSync(p); } catch { return; } if (st.isSymbolicLink()) return; t = Math.max(t, st.mtimeMs); if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(p + '/' + f); };
  walk(dir); return t;
}
function recentPicture(r) {
  const at = lastPic.get(r.user_id + ':' + r.project);
  if (!at || Date.now() - at > 30 * 60000) return false;
  try { return newestChange(S.projectDir(r.user_id, r.project)) <= at; } catch { return false; }
}

// ---------- the question to the person ----------
const q = (r, many) => `Publish "${r.site}" at ${S.siteUrl(r.public_name)} ?\nReply YES${many ? ' S' + r.id : ''} to publish${many ? '' : ', or NO'}.`;
/** Called by the agent after its answer, for each request the job filed. pic = a picture already sent this turn. */
export async function askUser(r, { picSent = false } = {}) {
  const many = S.waitingForUser(r.user_id).length > 1;
  const text = q(r, many);
  if (!picSent && !recentPicture(r)) {
    const p = await picture(r.user_id, S.inProject(r.user_id, r.project, r.folder || '.'));
    if (p.media) { run('UPDATE site_requests SET shot_token=? WHERE id=?', p.media.token, r.id); sendPicture({ userId: r.user_id, media: p.media }); }
  }
  enqueueText({ userId: r.user_id, text, kind: 'reply' });
  addMessage(r.user_id, 'assistant', text);
  return text;
}

// ---------- YES / NO ----------
const YES = new Set(['yes', 'y', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'approve', 'approved', 'publish', 'confirm', 'confirmed']);
const NO = new Set(['no', 'n', 'nope', 'cancel', 'reject', 'deny', 'refuse', 'dont', 'stop']);
const FILL = new Set(['please', 'pls', 'publish', 'it', 'go', 'ahead', 'do', 'thanks', 'thank', 'you', 'now', 'live', 'put', 'online', 'site', 'the', 'not', 'dont', 'yes', 'ok', 'sure']);
/** "YES", "yes please", "Yes S12", "no thanks" → { yes, id } ; anything else → null. */
export function parseDecision(text) {
  const first = String(text || '').split(/\r?\n/)[0].toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9#\s]/g, ' ').trim();
  if (!first || first.length > 60) return null;
  let words = first.split(/\s+/), id = null;
  words = words.filter(w => { const m = /^#?s#?(\d{1,7})$/.exec(w); if (m) { id = Number(m[1]); return false; } return true; });
  const i = words.findIndex(w => w === 's'); if (i >= 0 && /^\d{1,7}$/.test(words[i + 1] || '')) { id = Number(words[i + 1]); words.splice(i, 2); }
  if (!words.length) return null;
  const w0 = words[0];
  const yes = YES.has(w0) ? true : NO.has(w0) ? false : null;
  if (yes === null) return null;
  if (!words.slice(1).every(w => FILL.has(w))) return null;
  if (yes && words.includes('not')) return null;
  return { yes, id };
}
/** Which request a bare YES means: the only one, the newest (if only one is fresh), or ask. */
function pick(list, d) {
  if (d.id !== null) return { r: list.find(x => x.id === d.id) || null, byId: true };
  if (list.length === 1) return { r: list[0] };
  const fresh = list.filter(x => x.updated > now() - S.FRESH_MS || x.created > now() - S.FRESH_MS);
  if (fresh.length >= 2) return { ask: 'Which one? ' + fresh.map(x => `YES S${x.id} = "${x.site}"`).join(' · ') };
  return { r: list[list.length - 1] };
}

/** A text from an approved person. Returns true when it was a publish decision (then the AI does not run). */
export async function handleUserText(user, text, { isAdmin = false } = {}) {
  const d = parseDecision(text);
  if (!d) return false;
  const own = S.waitingForUser(user.id);
  const adminQ = isAdmin ? S.waitingForAdmin().filter(r => r.user_id !== user.id) : [];
  if (!own.length && !adminQ.length) {
    if (/^(yes|y|no|n|approve|publish)$/i.test(String(text).trim().replace(/[.!]+$/, ''))) {
      const ex = get("SELECT * FROM site_requests WHERE user_id=? AND status='expired' AND updated>? ORDER BY id DESC LIMIT 1", user.id, now() - 2 * 3600 * 1000);
      if (ex) { enqueueText({ userId: user.id, text: `That request ran out (30 min). Ask me again to publish "${ex.site}".`, kind: 'notice' }); return true; }
    }
    return false;
  }
  addMessage(user.id, 'user', text);
  const all2 = [...own.map(r => ({ ...r, kind: 'own' })), ...adminQ.map(r => ({ ...r, kind: 'admin' }))].sort((a, b) => a.id - b.id);
  const p = pick(all2, d);
  if (p.ask) { say(user.id, p.ask); return true; }
  if (!p.r) { say(user.id, `There is no waiting request S${d.id}.`); return true; }
  if (p.r.kind === 'admin') { await adminDecide(p.r.id, d.yes, 'admin (by text)', { replyTo: user.id }); return true; }
  await userDecide(p.r, d.yes, user);
  return true;
}
function say(userId, text) { enqueueText({ userId, text, kind: 'notice' }); addMessage(userId, 'assistant', text); }

export async function userDecide(r, yes, user) {
  if (!yes) { S.setStatus(r.id, 'cancelled', 'user#' + user.id); audit('user#' + user.id, 'site.cancelled', `S${r.id} ${r.public_name}`); say(user.id, 'OK, not published.'); return 'cancelled'; }
  if (!S.allowed(user)) { S.setStatus(r.id, 'cancelled', 'system'); say(user.id, 'Building sites is turned off here, so nothing was published.'); return 'off'; }
  try {
    S.stage(r);
    if (S.approvalOn() && !S.isAdminUser(user)) {
      run("UPDATE site_requests SET status='ask_admin', updated=? WHERE id=?", now(), r.id);
      audit('user#' + user.id, 'site.to_admin', `S${r.id} ${r.public_name}`);
      say(user.id, 'Waiting for admin approval. I\'ll text you when it\'s decided.');
      notifyAdmins(S.requestById(r.id)).catch(e => log('sites', 'admin notice failed:', e.message));
      return 'ask_admin';
    }
    const url = S.goLive(S.requestById(r.id), 'user#' + user.id);
    say(user.id, `Live: ${url}`);
    return 'published';
  } catch (e) {
    S.setStatus(r.id, 'failed', 'system');
    say(user.id, 'Not published: ' + String(e.message || e).slice(0, 200));
    return 'failed';
  }
}

// ---------- the admin ----------
export async function notifyAdmins(r) {
  const u = userById(r.user_id); const who = publicUser(u);
  const pic = await picture(r.user_id, S.stagingDir(r.id));
  if (pic.media) run('UPDATE site_requests SET shot_token=? WHERE id=?', pic.media.token, r.id);
  const many = S.waitingForAdmin().length > 1;
  const text = `Site request${many ? ' S' + r.id : ''}: ${who.name || who.label}${who.phone && who.phone !== who.label ? ' (' + who.phone + ')' : ''} wants to publish "${r.site}".\n` +
    `Preview (private): ${S.previewUrl(r)}\nReply YES${many ? ' S' + r.id : ''} to publish or NO${many ? ' S' + r.id : ''} to refuse.`;
  for (const a of S.adminUsers()) {
    if (pic.media) sendPicture({ userId: a.id, media: pic.media, kind: 'admin' });
    enqueueText({ userId: a.id, text, kind: 'admin' });
  }
  for (const p of adminPhones()) if (!S.adminUsers().some(a => a.phone === p)) {
    if (pic.media) sendPicture({ toPhone: p, media: pic.media, kind: 'admin' });
    enqueueText({ toPhone: p, text, kind: 'admin' });
  }
  alert('info', `Site waiting for your approval: "${r.site}" by ${who.label}. Open Sites in the dashboard.`, { rcs: false, key: 'site-req-' + r.id });
}
/** The admin's decision (dashboard button or text). replyTo = the admin's user id when it came by text. */
export async function adminDecide(id, yes, actor = 'admin', { replyTo = null } = {}) {
  S.expire();
  const r = S.requestById(id);
  if (!r || r.status !== 'ask_admin') { const e = new Error(r ? `S${id} is already ${r.status.replace('_', ' ')}.` : `No request S${id}.`); e.status = 409; if (replyTo) say(replyTo, e.message); throw e; }
  const u = userById(r.user_id);
  if (!yes) {
    S.setStatus(r.id, 'rejected', actor);
    audit(actor, 'site.rejected', `S${r.id} ${r.public_name}`);
    if (u) say(u.id, `The admin didn't approve "${r.site}", so it was not published.`);
    if (replyTo) say(replyTo, `Refused "${r.site}". Nothing was published.`);
    return { status: 'rejected' };
  }
  try {
    const url = S.goLive(r, actor);
    if (u) say(u.id, `Approved! "${r.site}" is live: ${url}`);
    if (replyTo) say(replyTo, `Published "${r.site}": ${url}`);
    return { status: 'published', url };
  } catch (e) {
    S.setStatus(r.id, 'failed', actor);
    if (u) say(u.id, `"${r.site}" could not be published: ${String(e.message).slice(0, 150)}`);
    if (replyTo) say(replyTo, 'Could not publish: ' + String(e.message).slice(0, 150));
    const x = new Error(e.message); x.status = 400; throw x;
  }
}
S.onAdminExpired((r) => { const u = userById(r.user_id); if (u) say(u.id, `The admin didn't answer in time, so "${r.site}" was not published. Ask me again any time.`); });

/** The admin took a site down in the dashboard: the person hears it. */
export function adminUnpublish(id, actor = 'admin') {
  const s = S.unpublish({ id }, actor);
  const u = userById(s.user_id);
  if (u) say(u.id, `The admin took your site "${s.name}" offline.`);
  return { ok: true };
}
