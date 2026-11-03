// Everything the assistant texts goes through here: replies, the waiting-for-approval line, welcome, reminders,
// admin codes and alerts. One sender at a time (the Messages page is one page); admin codes go first.
// If Messages is not connected, texts wait (they are not lost and no tries are used up).
import { all, get, run, now, log, audit } from './db.js';
import { userById, userByPhone } from './users.js';

let channel = null, timer = null, busy = false, onFail = null;
export const PRIORITY = { code: 0, admin: 1, reply: 5, busy: 4, waiting: 6, welcome: 5, reminder: 5, notice: 6 };
export function attachChannel(ch, { onFailed } = {}) { channel = ch; onFail = onFailed || null; }
export function enqueueText({ userId = null, toPhone = null, convId = null, text, kind = 'reply', priority = null }) {
  if (!text || !String(text).trim()) return null;
  const u = userId ? userById(userId) : null;
  const r = run('INSERT INTO outbox(user_id, to_phone, conv_id, text, kind, priority, status, created) VALUES(?,?,?,?,?,?,?,?)',
    userId, toPhone || (u && !u.phone.startsWith('conv:') ? u.phone : null), convId || (u ? u.conv_id : null), String(text), kind, priority ?? PRIORITY[kind] ?? 5, 'queued', now());
  setImmediate(drain);
  return Number(r.lastInsertRowid);
}
export function startOutbox(ms = 3000) { if (!timer) { timer = setInterval(drain, ms); timer.unref?.(); } }
export function stopOutbox() { if (timer) clearInterval(timer); timer = null; }
export function pending() { return get("SELECT COUNT(*) AS n FROM outbox WHERE status='queued'").n; }
export async function drain() {
  if (busy || !channel) return; busy = true;
  try {
    for (;;) {
      if (channel.status().state !== 'connected') return;
      const m = get("SELECT * FROM outbox WHERE status='queued' ORDER BY priority, id LIMIT 1");
      if (!m) return;
      run("UPDATE outbox SET status='sending', tries=tries+1 WHERE id=?", m.id);
      try {
        const u = m.user_id ? userById(m.user_id) : null;
        if (m.user_id && !u) { run("UPDATE outbox SET status='cancelled' WHERE id=?", m.id); continue; }
        const known = !u && m.to_phone ? userByPhone(m.to_phone) : null;      // e.g. the admin, who also texts the assistant
        const convId = (u && u.conv_id) || m.conv_id || (known && known.conv_id) || null;
        const phone = m.to_phone || (u && !u.phone.startsWith('conv:') ? u.phone : null);
        const r = await channel.send({ convId, phone, text: m.text });
        run("UPDATE outbox SET status='sent', sent_at=?, conv_id=? WHERE id=?", now(), r.convId || convId, m.id);
        if (u && r.convId && !u.conv_id) run('UPDATE users SET conv_id=? WHERE id=?', String(r.convId), u.id);
      } catch (e) {
        if (e.notConnected) { run("UPDATE outbox SET status='queued', tries=tries-1 WHERE id=?", m.id); return; }
        const tries = get('SELECT tries FROM outbox WHERE id=?', m.id).tries;
        log('outbox', `send #${m.id} failed (${tries}):`, e.message);
        if (tries >= 3) {
          run("UPDATE outbox SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 300), m.id);
          audit('system', 'outbox.failed', `#${m.id} (${m.kind}): ${e.message}`);
          if (m.kind !== 'admin' && m.kind !== 'code') onFail?.(m, e);
        } else run("UPDATE outbox SET status='queued', error=? WHERE id=?", String(e.message).slice(0, 300), m.id);
        return;     // try again on the next round (a short pause between tries)
      }
    }
  } finally { busy = false; }
}
export function recoverOutbox() { run("UPDATE outbox SET status='queued' WHERE status='sending'"); }
export function recent(limit = 50) { return all('SELECT id, user_id, kind, status, tries, created, sent_at, error, substr(text,1,120) AS text FROM outbox ORDER BY id DESC LIMIT ?', limit); }
