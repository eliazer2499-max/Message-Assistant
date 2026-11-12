// Everything the assistant texts goes through here: replies, the waiting-for-approval line, welcome, reminders,
// admin codes and alerts. One sender at a time (the Messages page is one page); admin codes go first.
// If Messages is not connected, texts wait (they are not lost and no tries are used up).
import { all, get, run, now, log, audit } from './db.js';
import { userById, userByPhone } from './users.js';
import { splitText } from './channels/gmweb.js';
const splitPartsCount = (t) => Math.max(1, splitText(t || '').length);

let channel = null, timer = null, busy = false, onFail = null;
export const PRIORITY = { code: 0, admin: 1, reply: 5, busy: 4, waiting: 6, welcome: 5, reminder: 5, notice: 6 };
export function attachChannel(ch, { onFailed } = {}) { channel = ch; onFail = onFailed || null; }
// 1.0.2: media = a picture/file on this server to attach (mediaUrl = its private link, sent instead if attaching fails)
export function enqueueText({ userId = null, toPhone = null, convId = null, text, kind = 'reply', priority = null, media = null, mediaUrl = null }) {
  if ((!text || !String(text).trim()) && !media) return null;
  const u = userId ? userById(userId) : null;
  const r = run('INSERT INTO outbox(user_id, to_phone, conv_id, text, kind, priority, status, created, media, media_url) VALUES(?,?,?,?,?,?,?,?,?,?)',
    userId, toPhone || (u && !u.phone.startsWith('conv:') ? u.phone : null), convId || (u ? u.conv_id : null), String(text || '').trim(), kind, priority ?? PRIORITY[kind] ?? 5, 'queued', now(), media, mediaUrl);
  setImmediate(drain);
  return Number(r.lastInsertRowid);
}
export function startOutbox(ms = 3000) { if (!timer) { timer = setInterval(drain, ms); timer.unref?.(); } }
export function stopOutbox() { if (timer) clearInterval(timer); timer = null; }
export function pending() { return get("SELECT COUNT(*) AS n FROM outbox WHERE status IN ('queued','unconfirmed')").n; }
// 1.0.7: when to look again at a text Google Messages had not shown as sent (15 s, 30 s, 1, 2, 4, 8, 16 min, then given up)
export const CHECK_AFTER_MS = [15000, 30000, 60000, 120000, 240000, 480000, 960000];
let checkScale = 1; export function _setCheckScale(x) { checkScale = x; }
export async function drain() {
  if (busy || !channel) return; busy = true;
  try {
    for (;;) {
      if (channel.status().state !== 'connected') return;
      if (await checkUnconfirmed()) continue;
      const m = get("SELECT * FROM outbox WHERE status='queued' ORDER BY priority, id LIMIT 1");
      if (!m) return;
      run("UPDATE outbox SET status='sending', tries=tries+1 WHERE id=?", m.id);
      const t0 = Date.now();
      try {
        const u = m.user_id ? userById(m.user_id) : null;
        if (m.user_id && !u) { run("UPDATE outbox SET status='cancelled' WHERE id=?", m.id); continue; }
        const known = !u && m.to_phone ? userByPhone(m.to_phone) : null;      // e.g. the admin, who also texts the assistant
        const convId = (u && u.conv_id) || m.conv_id || (known && known.conv_id) || null;
        const phone = m.to_phone || (u && !u.phone.startsWith('conv:') ? u.phone : null);
        const r = await channel.send({ convId, phone, text: m.text, skipParts: m.parts_done || 0, ...(m.media ? { media: m.media, mediaUrl: m.media_url } : {}) });
        run("UPDATE outbox SET status='sent', sent_at=?, conv_id=?, error=NULL WHERE id=?", now(), r.convId || convId, m.id);
        log('outbox', `#${m.id} (${m.kind}) sent in ${Date.now() - t0} ms, ${Math.round((Date.now() - m.created) / 100) / 10} s after it was queued`);
        if (u && r.convId && !u.conv_id) run('UPDATE users SET conv_id=? WHERE id=?', String(r.convId), u.id);
      } catch (e) {
        if (e.notConnected) { run("UPDATE outbox SET status='queued', tries=tries-1 WHERE id=?", m.id); return; }
        const done = e.partsDone ?? (m.parts_done || 0);     // parts already shown as sent (absolute)
        if (e.convId) run('UPDATE outbox SET conv_id=? WHERE id=?', String(e.convId), m.id);
        if (e.unconfirmed) {
          // it left the typing box but Google does not show it as sent: keep it, look at the chat again later, never type it twice
          run("UPDATE outbox SET status='unconfirmed', parts_done=?, check_text=?, checks=0, check_at=?, error=? WHERE id=?",
            done, String(e.partText || m.text), now() + CHECK_AFTER_MS[0] * checkScale, String(e.message).slice(0, 300), m.id);
          log('outbox', `#${m.id} not confirmed as sent yet (${e.message}); checking the chat again in ${CHECK_AFTER_MS[0] * checkScale / 1000} s`);
          return;
        }
        run('UPDATE outbox SET parts_done=? WHERE id=?', done, m.id);
        fail(m, e);
        return;     // try again on the next round (a short pause between tries)
      }
    }
  } finally { busy = false; }
}
function fail(m, e) {
  const tries = get('SELECT tries FROM outbox WHERE id=?', m.id).tries;
  log('outbox', `send #${m.id} failed (${tries}):`, e.message);
  if (tries >= 3) {
    run("UPDATE outbox SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 300), m.id);
    audit('system', 'outbox.failed', `#${m.id} (${m.kind}): ${e.message}`);
    if (m.kind !== 'admin' && m.kind !== 'code') onFail?.(m, e);
  } else run("UPDATE outbox SET status='queued', error=? WHERE id=?", String(e.message).slice(0, 300), m.id);
}
/** One due 'unconfirmed' text: look at its chat. Returns true when it handled one. */
async function checkUnconfirmed() {
  const m = get("SELECT * FROM outbox WHERE status='unconfirmed' AND check_at<=? ORDER BY check_at LIMIT 1", now());
  if (!m || !channel.confirmSent) return false;
  let r;
  try { r = await channel.confirmSent({ convId: m.conv_id, text: m.check_text || m.text }); }
  catch (e) {
    if (e.notConnected) return false;
    r = 'pending'; log('outbox', `#${m.id} check failed:`, e.message);
  }
  const checks = (m.checks || 0) + 1;
  if (r === 'sent') {
    const total = splitPartsCount(m.text);
    const done = (m.parts_done || 0) + 1;
    if (done >= total) { run("UPDATE outbox SET status='sent', sent_at=?, parts_done=?, error=NULL WHERE id=?", now(), done, m.id); log('outbox', `#${m.id} confirmed as sent on check ${checks}`); }
    else { run("UPDATE outbox SET status='queued', parts_done=?, error=NULL WHERE id=?", done, m.id); log('outbox', `#${m.id} part ${done} confirmed; sending the rest`); }
  } else if (r === 'failed' || r === 'missing') {
    log('outbox', `#${m.id} ${r === 'failed' ? 'shows "not sent" in Google Messages' : 'is not in the chat'}; sending it again`);
    fail(m, new Error(r === 'failed' ? 'Google Messages shows the message as not sent' : 'the message never appeared in the chat'));
  } else if (checks >= CHECK_AFTER_MS.length) {
    run("UPDATE outbox SET status='failed', checks=?, error=? WHERE id=?", checks, 'still "sending" in Google Messages after about 30 minutes', m.id);
    audit('system', 'outbox.failed', `#${m.id} (${m.kind}): still sending in Google Messages after about 30 minutes`);
    if (m.kind !== 'admin' && m.kind !== 'code') onFail?.(m, new Error('still sending in Google Messages'));
  } else {
    run('UPDATE outbox SET checks=?, check_at=? WHERE id=?', checks, now() + CHECK_AFTER_MS[checks] * checkScale, m.id);
    log('outbox', `#${m.id} still not shown as sent (check ${checks}); next look in ${CHECK_AFTER_MS[checks] * checkScale / 1000} s`);
  }
  return true;
}
export function recoverOutbox() { run("UPDATE outbox SET status='queued' WHERE status='sending'"); }
export function recent(limit = 50) { return all('SELECT id, user_id, kind, status, tries, created, sent_at, error, CASE WHEN media IS NOT NULL THEN \'[picture] \' ELSE \'\' END || substr(text,1,120) AS text FROM outbox ORDER BY id DESC LIMIT ?', limit); }
