// 1.0.2: the person's own web chat (Abish, Nov 8 2026: "when a user logs in with his phone number allow him to see
// his chat and as well chat from there").
//   - Sign-in: his phone number → a 6-digit code texted to him (10 min, one a minute, 5 an hour, newest only). The
//     answer is the same for every number, so nobody can find out who uses the assistant. Only APPROVED people.
//   - Its own cookie (msa_uid) and CSRF token, 30 days; it never opens the admin dashboard (that is msa_sid).
//   - What he sees is his own chat only: his texts and everything the assistant texted him (pictures too). A text
//     typed on the web goes through the same router as an RCS text: same commands, same one YES, same answers,
//     and the answer is texted to his phone too, so both stay the same.
import crypto from 'node:crypto';
import { all, get, run, now, setting, setSetting, audit } from './db.js';
import { token, sha256, safeEqual } from './crypto.js';
import { normalizePhone, userByPhone, userById, whenRemoved, publicUser } from './users.js';
import { enqueueText } from './outbox.js';
import { AuthError } from './adminauth.js';

export const CODE_TTL = 10 * 60000;
export const SESSION_TTL = 30 * 24 * 3600000;
export const LIMITS = { gap: 60000, perPhoneHour: 5, perIpHour: 10, tries: 5, failsWindow: 15 * 60000, failsMax: 5, sendsPerMinute: 12 };
export const SAME = 'If that number uses this assistant, a 6-digit code is on its way by text.';

export function enabled() { return setting('portal_enabled') !== '0'; }
export function setEnabled(on, actor = 'admin') {
  setSetting('portal_enabled', on ? '1' : '0');
  if (!on) run('DELETE FROM user_sessions');
  audit(actor, 'portal.' + (on ? 'on' : 'off'), on ? 'people can sign in to their web chat' : 'web chat off; everyone signed out');
}
const count = (kind, k, since, ok = null) => get(`SELECT COUNT(*) AS n FROM attempts WHERE kind=? AND k=? AND ts>?${ok === null ? '' : ' AND ok=' + (ok ? 1 : 0)}`, kind, k, since).n;
const note = (kind, k, ok = 0) => run('INSERT INTO attempts(kind, k, ts, ok) VALUES(?,?,?,?)', kind, k, now(), ok ? 1 : 0);
const off = () => new AuthError(403, 'The web chat is turned off by the admin.');

export function requestCode(rawPhone, ip) {
  if (!enabled()) throw off();
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new AuthError(400, 'Type your phone number with area code, e.g. +1 646 555 0100');
  const t = now();
  if (count('ucode_ip', ip, t - 3600000) >= LIMITS.perIpHour) throw new AuthError(429, 'Too many codes asked from here. Try again in an hour.');
  note('ucode_ip', ip);
  const u = userByPhone(phone);
  if (!u || u.status !== 'approved') { audit('anonymous', 'portal.code_unknown', `${phone.slice(0, 4)}… from ${ip}`); return { message: SAME }; }
  const last = get('SELECT created FROM user_codes WHERE user_id=? ORDER BY id DESC LIMIT 1', u.id);
  if (last && t - last.created < LIMITS.gap) return { message: SAME };                    // same answer; no second code
  if (count('ucode_phone', phone, t - 3600000) >= LIMITS.perPhoneHour) return { message: SAME };
  note('ucode_phone', phone);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = token(12);
  run('UPDATE user_codes SET used=1 WHERE user_id=? AND used=0', u.id);
  run('INSERT INTO user_codes(user_id, phone, code_hash, created, expires) VALUES(?,?,?,?,?)', u.id, phone, salt + '$' + sha256(salt + code), t, t + CODE_TTL);
  enqueueText({ userId: u.id, text: `Your web chat code is ${code}. It works for 10 minutes. If you did not ask for it, ignore this text.`, kind: 'code' });
  audit('system', 'portal.code_sent', `#${u.id}`);
  return { message: SAME };
}
export function verifyCode(rawPhone, code, ip, ua = '') {
  if (!enabled()) throw off();
  const phone = normalizePhone(rawPhone); const t = now();
  if (count('ulogin_ip', ip, t - LIMITS.failsWindow, false) >= LIMITS.failsMax) throw new AuthError(429, 'Too many wrong tries. Wait 15 minutes.');
  const u = phone ? userByPhone(phone) : null;
  const row = u && get('SELECT * FROM user_codes WHERE user_id=? AND used=0 ORDER BY id DESC LIMIT 1', u.id);
  const c = String(code || '').replace(/\D/g, '');
  if (!u || u.status !== 'approved' || !row || row.expires < t || row.tries >= LIMITS.tries || c.length !== 6) {
    note('ulogin_ip', ip, 0);
    throw new AuthError(401, row && row.tries >= LIMITS.tries ? 'Too many wrong tries for this code. Ask for a new one.' : 'That code is not right or has expired.');
  }
  const [salt, h] = row.code_hash.split('$');
  if (!safeEqual(sha256(salt + c), h)) { run('UPDATE user_codes SET tries=tries+1 WHERE id=?', row.id); note('ulogin_ip', ip, 0); throw new AuthError(401, 'That code is not right.'); }
  run('UPDATE user_codes SET used=1 WHERE id=?', row.id); note('ulogin_ip', ip, 1);
  const id = token(32), csrf = token(18);
  run('INSERT INTO user_sessions(id, user_id, csrf, created, expires, ip, ua) VALUES(?,?,?,?,?,?,?)', sha256(id), u.id, csrf, t, t + SESSION_TTL, ip, String(ua).slice(0, 200));
  audit('user#' + u.id, 'portal.login', `from ${ip}`);
  return { id, csrf, user: u };
}
/** The signed-in person, or null (expired, blocked, removed, or the web chat turned off). */
export function sessionFrom(id) {
  if (!id || !enabled()) return null;
  const s = get('SELECT * FROM user_sessions WHERE id=?', sha256(id));
  if (!s || s.expires < now()) return null;
  const u = userById(s.user_id);
  if (!u || u.status !== 'approved') return null;
  return { ...s, user: u };
}
export function endSession(id) { if (id) run('DELETE FROM user_sessions WHERE id=?', sha256(id)); }
export function endUserSessions(userId) { run('DELETE FROM user_sessions WHERE user_id=?', Number(userId)); }
whenRemoved(endUserSessions);
export function canSend(userId) {
  const k = String(userId);
  if (count('usend', k, now() - 60000) >= LIMITS.sendsPerMinute) return false;
  note('usend', k, 1); return true;
}

/** His own chat: his texts + what the assistant texted him (sent or waiting), oldest first. after = item time. */
export function chat(userId, after = 0, limit = 200) {
  const u = userById(userId); if (!u) return [];
  const mine = all("SELECT id, text, ts FROM messages WHERE user_id=? AND role IN ('user','user_cmd') AND ts>? ORDER BY id DESC LIMIT ?", u.id, Number(after) || 0, limit)
    .map(m => ({ id: 'm' + m.id, who: 'me', text: m.text, ts: m.ts }));
  const out = all(`SELECT id, text, media_url, status, created FROM outbox WHERE (user_id=? OR (user_id IS NULL AND to_phone=?)) AND kind<>'code' AND status IN ('queued','sending','unconfirmed','sent') AND created>? ORDER BY id DESC LIMIT ?`,
    u.id, u.phone, Number(after) || 0, limit)
    .map(o => { const tk = /\/m\/([A-Za-z0-9_-]{20,40})\//.exec(o.media_url || ''); return { id: 'o' + o.id, who: 'bot', text: o.text || '', img: tk ? `/m/${tk[1]}/picture` : null, ts: o.created, status: o.status === 'sent' ? 'sent' : 'sending' }; })
    .filter(o => o.text || o.img);
  return [...mine, ...out].sort((a, b) => a.ts - b.ts || (a.who === 'me' ? -1 : 1)).slice(-limit);
}
export function me(s) { const p = publicUser(s.user); return { signed_in: true, csrf: s.csrf, name: (p.settings && p.settings.name) || p.name || '', phone: p.phone }; }
