// People who text the assistant. Everyone starts "pending"; only the admin approves, blocks or removes.
// A pending person gets ONE polite "waiting for approval" reply, then nothing until approved.
// Every per-user table (messages, memory, reminders, usage, jobs, outbox) is keyed by user_id; the helpers here
// and in tools/ always take the user id from the conversation, never from the model, so one user can never see
// another user's data.
import { all, get, run, now, setting, audit, tx } from './db.js';
import { cfg } from './config.js';

export const STATUSES = ['pending', 'approved', 'blocked'];

/** "+1 (646) 626-4996", "646-626-4996", "16466264996" → "+16466264996". Not a phone number → ''. */
export function normalizePhone(raw, cc = cfg.countryCode) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (/[a-z]/i.test(s.replace(/\b(ext|x)\b.*$/i, ''))) return '';      // a name, not a number
  const plus = s.startsWith('+') || s.startsWith('00');
  let d = s.replace(/\D/g, '');
  if (s.startsWith('00')) d = d.slice(2);
  if (d.length < 7 || d.length > 15) return '';
  if (plus) return d.length >= 8 ? '+' + d : '';
  if (cc === '1') return d.length === 10 ? '+1' + d : d.length === 11 && d.startsWith('1') ? '+' + d : d.length > 11 ? '+' + d : '';
  if (d.length > 11) return '+' + d;
  return d.length >= 8 ? '+' + cc + d.replace(/^0+/, '') : '';
}
export function isAdminPhone(phone) {
  const p = normalizePhone(phone); if (!p) return false;
  return adminPhones().includes(p);
}
export function adminPhones() { return String(setting('admin_phones') || '').split(/[,;]+/).map(x => normalizePhone(x)).filter(Boolean); }

export function userById(id) { return get('SELECT * FROM users WHERE id=?', Number(id)) || null; }
export function userByPhone(phone) { const p = normalizePhone(phone); return p ? get('SELECT * FROM users WHERE phone=?', p) || null : null; }
export function userByConv(convId) { return convId ? get('SELECT * FROM users WHERE conv_id=?', String(convId)) || null : null; }

/**
 * Someone texted. Returns { user, isNew, action } where action is what the router should do:
 *   'run'   approved → think and answer
 *   'wait'  pending, first time → send the one waiting reply
 *   'quiet' pending again, blocked, or not a phone number → nothing
 * The waiting reply is marked sent in the same transaction, so it can never go out twice (two quick texts).
 */
export function arrive({ phone, convId = '', name = '', text = '' }) {
  const p = normalizePhone(phone);
  // A sender we can't read as a number (e.g. a contact name on the host phone) is keyed by its conversation.
  const key = p || (convId ? 'conv:' + convId : '');
  if (!key) return { user: null, isNew: false, action: 'quiet' };
  return tx(() => {
    let u = get('SELECT * FROM users WHERE phone=?', key) || (convId ? get('SELECT * FROM users WHERE conv_id=?', String(convId)) : null);
    let isNew = false;
    if (!u) {
      const r = run('INSERT INTO users(phone, conv_id, name, status, created, last_seen, first_text) VALUES(?,?,?,?,?,?,?)',
        key, convId ? String(convId) : null, String(name || '').slice(0, 80), 'pending', now(), now(), String(text || '').slice(0, 300));
      u = userById(Number(r.lastInsertRowid)); isNew = true;
      audit('system', 'user.new', `${key} is waiting for approval`);
    } else {
      run('UPDATE users SET last_seen=?, conv_id=COALESCE(?, conv_id), name=CASE WHEN COALESCE(name,\'\')=\'\' THEN ? ELSE name END WHERE id=?',
        now(), convId ? String(convId) : null, String(name || '').slice(0, 80), u.id);
      u = userById(u.id);
    }
    if (u.status === 'approved') return { user: u, isNew, action: 'run' };
    if (u.status === 'blocked') return { user: u, isNew, action: 'quiet' };
    if (!u.waiting_reply_sent) {
      run('UPDATE users SET waiting_reply_sent=1 WHERE id=?', u.id);
      return { user: userById(u.id), isNew, action: 'wait' };
    }
    return { user: u, isNew, action: 'quiet' };
  });
}

export function listUsers(status = null) {
  const rows = status ? all('SELECT * FROM users WHERE status=? ORDER BY last_seen DESC', status) : all('SELECT * FROM users ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'approved\' THEN 1 ELSE 2 END, last_seen DESC');
  const day = today();
  return rows.map(u => ({ ...publicUser(u), today: usageOf(u.id, day) }));
}
export function publicUser(u) {
  if (!u) return null;
  let settings = {}; try { settings = JSON.parse(u.settings || '{}'); } catch {}
  return { id: u.id, phone: u.phone.startsWith('conv:') ? '' : u.phone, label: u.name || u.phone, name: u.name || '', status: u.status,
    created: u.created, approved_at: u.approved_at, last_seen: u.last_seen, paused: !!u.paused, daily_limit: u.daily_limit, settings,
    first_text: u.first_text || '' };
}

export function approve(id, actor = 'admin') {
  const u = userById(id); if (!u) throw notFound();
  run('UPDATE users SET status=?, approved_at=?, paused=0 WHERE id=?', 'approved', now(), u.id);
  audit(actor, 'user.approved', u.phone);
  return userById(u.id);
}
export function block(id, actor = 'admin') {
  const u = userById(id); if (!u) throw notFound();
  run('UPDATE users SET status=? WHERE id=?', 'blocked', u.id);
  run("UPDATE jobs SET status='cancelled', updated=? WHERE user_id=? AND status IN ('queued','waiting')", now(), u.id);
  run("UPDATE outbox SET status='cancelled' WHERE user_id=? AND status='queued'", u.id);
  audit(actor, 'user.blocked', u.phone);
  return userById(u.id);
}
/** Remove: the person and ALL their data (history, notes, reminders, usage). If they text again they start as pending. */
export function remove(id, actor = 'admin') {
  const u = userById(id); if (!u) throw notFound();
  tx(() => {
    for (const t of ['messages', 'memory', 'reminders', 'usage', 'jobs', 'outbox']) run(`DELETE FROM ${t} WHERE user_id=?`, u.id);
    run('DELETE FROM users WHERE id=?', u.id);
  });
  audit(actor, 'user.removed', u.phone);
  for (const fn of onRemove) { try { fn(u.id); } catch {} }
  return { ok: true };
}
const onRemove = [];
export function whenRemoved(fn) { onRemove.push(fn); }     // 1.0.2: sites.js removes their files and sites
export function updateUser(id, b = {}) {
  const u = userById(id); if (!u) throw notFound();
  if (b.name !== undefined) run('UPDATE users SET name=? WHERE id=?', String(b.name).slice(0, 80), u.id);
  if (b.daily_limit !== undefined) run('UPDATE users SET daily_limit=? WHERE id=?', b.daily_limit === null || b.daily_limit === '' ? null : Math.max(0, parseInt(b.daily_limit, 10) || 0), u.id);
  if (b.paused !== undefined) run('UPDATE users SET paused=? WHERE id=?', b.paused ? 1 : 0, u.id);
  if (b.settings && typeof b.settings === 'object') setUserSettings(u.id, b.settings);
  return userById(u.id);
}
export function userSettings(id) { try { return JSON.parse(userById(id)?.settings || '{}'); } catch { return {}; } }
const SETTING_KEYS = { name: 80, timezone: 60, language: 40, style: 200 };
export function setUserSettings(id, patch) {
  const cur = userSettings(id);
  for (const [k, max] of Object.entries(SETTING_KEYS)) if (patch[k] !== undefined) { const v = String(patch[k] ?? '').trim().slice(0, max); if (v) cur[k] = v; else delete cur[k]; }
  run('UPDATE users SET settings=? WHERE id=?', JSON.stringify(cur), Number(id));
  return cur;
}

// ---- usage (per user, per day in the admin's timezone) ----
export function today(t = now()) {
  try { return new Date(t).toLocaleDateString('en-CA', { timeZone: setting('timezone') || 'America/New_York' }); } catch { return new Date(t).toISOString().slice(0, 10); }
}
export function addUsage(userId, field, n = 1) {
  if (!['messages', 'replies', 'model_calls', 'tokens', 'browser_ms', 'searches'].includes(field)) return;
  const day = today();
  run('INSERT INTO usage(user_id, day) VALUES(?,?) ON CONFLICT(user_id, day) DO NOTHING', Number(userId), day);
  run(`UPDATE usage SET ${field}=${field}+? WHERE user_id=? AND day=?`, Math.round(n), Number(userId), day);
}
export function usageOf(userId, day = today()) {
  return get('SELECT messages, replies, model_calls, tokens, browser_ms, searches FROM usage WHERE user_id=? AND day=?', Number(userId), day)
    || { messages: 0, replies: 0, model_calls: 0, tokens: 0, browser_ms: 0, searches: 0 };
}
export function usageTotals(userId) {
  return get('SELECT COALESCE(SUM(messages),0) AS messages, COALESCE(SUM(replies),0) AS replies, COALESCE(SUM(model_calls),0) AS model_calls, COALESCE(SUM(tokens),0) AS tokens, COALESCE(SUM(browser_ms),0) AS browser_ms, COALESCE(SUM(searches),0) AS searches FROM usage WHERE user_id=?', Number(userId));
}
export function dailyLimit(u) {
  if (u.daily_limit !== null && u.daily_limit !== undefined) return u.daily_limit;
  return Math.max(0, parseInt(setting('daily_limit'), 10) || 0);
}
export function overLimit(u) { const lim = dailyLimit(u); return lim > 0 && usageOf(u.id).messages > lim; }

// ---- history (one user's only) ----
export function addMessage(userId, role, text, extId = null) {
  return Number(run('INSERT INTO messages(user_id, role, text, ts, ext_id) VALUES(?,?,?,?,?)', Number(userId), role, String(text ?? '').slice(0, 20000), now(), extId).lastInsertRowid);
}
export function history(userId, limit = 14, beforeId = null) {
  const rows = beforeId
    ? all('SELECT id, role, text, ts FROM messages WHERE user_id=? AND id<? ORDER BY id DESC LIMIT ?', Number(userId), Number(beforeId), limit)
    : all('SELECT id, role, text, ts FROM messages WHERE user_id=? ORDER BY id DESC LIMIT ?', Number(userId), limit);
  return rows.reverse();
}
export function clearHistory(userId) { run('DELETE FROM messages WHERE user_id=?', Number(userId)); }

function notFound() { const e = new Error('That person is not on the list any more'); e.status = 404; return e; }
