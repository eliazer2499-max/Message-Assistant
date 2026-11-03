// Admin sign-in. 1) Phone: the admin types his number, a 6-digit code is texted to it through the same Google
// Messages session, he types the code. 2) Fallback: username + password (scrypt hash, set at install, reset with
// `sudo messageassistant reset-password`). Codes and logins are rate-limited per number, per address and per username.
// Answers never tell a stranger whether a number is the admin's.
import crypto from 'node:crypto';
import { get, run, now, setting, setSetting, secret, setSecret, audit } from './db.js';
import { hashPassword, verifyPassword, token, sha256, safeEqual } from './crypto.js';
import { normalizePhone, isAdminPhone } from './users.js';
import { enqueueText } from './outbox.js';

export const CODE_TTL = 10 * 60000;
export const SESSION_TTL = 12 * 3600000;
export const LIMITS = {
  codePerPhoneGap: 60000,          // one code a minute per number
  codesPerPhoneHour: 5,
  codesPerIpHour: 10,
  codeTries: 5,                    // wrong guesses per code
  loginFailsWindow: 15 * 60000,
  loginFailsMax: 5,                // per address and per username, then 15 min wait
};
export class AuthError extends Error { constructor(status, msg, extra = {}) { super(msg); this.status = status; Object.assign(this, extra); } }

function count(kind, k, since, okOnly = null) {
  return get(`SELECT COUNT(*) AS n FROM attempts WHERE kind=? AND k=? AND ts>?${okOnly === null ? '' : ' AND ok=' + (okOnly ? 1 : 0)}`, kind, k, since).n;
}
function note(kind, k, ok = 0) { run('INSERT INTO attempts(kind, k, ts, ok) VALUES(?,?,?,?)', kind, k, now(), ok ? 1 : 0); }
export function cleanupAttempts() { run('DELETE FROM attempts WHERE ts<?', now() - 24 * 3600000); run('DELETE FROM admin_codes WHERE expires<?', now() - 3600000); run('DELETE FROM sessions WHERE expires<?', now()); }

const SAME = 'If that number belongs to the admin, a 6-digit code is on its way by text. No code within a minute? Use username + password.';

/** Step 1 of phone sign-in. channelState: the Messages connection state (a code can only go out when connected). */
export function requestCode(rawPhone, ip, channelState = 'connected') {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new AuthError(400, 'Type the phone number with area code, e.g. +1 646 555 0100');
  const t = now();
  if (count('code_ip', ip, t - 3600000) >= LIMITS.codesPerIpHour) throw new AuthError(429, 'Too many codes asked from here. Try again in an hour, or use username + password.');
  note('code_ip', ip);
  if (!isAdminPhone(phone)) { audit('anonymous', 'login.code_unknown_number', `${phone.slice(0, 4)}… from ${ip}`); return { message: SAME }; }
  const last = get('SELECT created FROM admin_codes WHERE phone=? ORDER BY id DESC LIMIT 1', phone);
  if (last && t - last.created < LIMITS.codePerPhoneGap) throw new AuthError(429, 'A code was just sent. Wait a minute before asking for another.');
  if (count('code_phone', phone, t - 3600000) >= LIMITS.codesPerPhoneHour) throw new AuthError(429, 'Too many codes for this number. Try again in an hour, or use username + password.');
  note('code_phone', phone);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = token(12);
  run('UPDATE admin_codes SET used=1 WHERE phone=? AND used=0', phone);          // only the newest code works
  run('INSERT INTO admin_codes(phone, code_hash, created, expires) VALUES(?,?,?,?)', phone, salt + '$' + sha256(salt + code), t, t + CODE_TTL);
  enqueueText({ toPhone: phone, text: `Your Message Assistant admin code is ${code}. It works for 10 minutes. If you did not ask for it, ignore this text.`, kind: 'code' });
  audit('system', 'login.code_sent', phone + (channelState !== 'connected' ? ' (Messages is not connected; the code waits until it is)' : ''));
  return { message: SAME, ...(channelState !== 'connected' ? { hint: 'Messages is not connected right now, so the code can\'t go out yet. Use username + password.' } : {}) };
}

/** Step 2: the code. Returns a new session. */
export function verifyCode(rawPhone, code, ip, ua = '') {
  const phone = normalizePhone(rawPhone);
  const t = now();
  if (count('login_ip', ip, t - LIMITS.loginFailsWindow, false) >= LIMITS.loginFailsMax) throw new AuthError(429, 'Too many wrong tries. Wait 15 minutes.');
  const row = phone && get('SELECT * FROM admin_codes WHERE phone=? AND used=0 ORDER BY id DESC LIMIT 1', phone);
  const c = String(code || '').replace(/\D/g, '');
  if (!row || row.expires < t || row.tries >= LIMITS.codeTries || c.length !== 6) {
    note('login_ip', ip, 0);
    throw new AuthError(401, row && row.tries >= LIMITS.codeTries ? 'Too many wrong tries for this code. Ask for a new one.' : 'That code is not right or has expired.');
  }
  const [salt, h] = row.code_hash.split('$');
  if (!safeEqual(sha256(salt + c), h)) {
    run('UPDATE admin_codes SET tries=tries+1 WHERE id=?', row.id); note('login_ip', ip, 0);
    throw new AuthError(401, 'That code is not right.');
  }
  run('UPDATE admin_codes SET used=1 WHERE id=?', row.id);
  note('login_ip', ip, 1);
  audit('admin', 'login.ok', `code to ${phone} from ${ip}`);
  return newSession(ip, ua, 'code');
}

// ---- password ----
export function hasPassword() { return !!secret('admin_password_hash'); }
export function setPassword(pw, username = null) {
  pw = String(pw || '');
  if (pw.length < 8) throw new AuthError(400, 'The password needs at least 8 characters.');
  setSecret('admin_password_hash', hashPassword(pw));
  if (username) setSetting('admin_username', String(username).trim().slice(0, 40) || 'admin');
  run('DELETE FROM sessions');                       // a new password signs everyone out
  audit('admin', 'login.password_set', 'admin password changed');
}
export function randomPassword() { const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 14; i++) s += a[crypto.randomInt(0, a.length)]; return s; }
export function passwordLogin(username, pw, ip, ua = '') {
  const t = now(); const u = String(username || '').trim().toLowerCase();
  if (count('login_ip', ip, t - LIMITS.loginFailsWindow, false) >= LIMITS.loginFailsMax || count('login_user', u, t - LIMITS.loginFailsWindow, false) >= LIMITS.loginFailsMax)
    throw new AuthError(429, 'Too many wrong tries. Wait 15 minutes.');
  const want = String(setting('admin_username') || 'admin').toLowerCase();
  const stored = secret('admin_password_hash');
  const ok = !!stored && verifyPassword(pw, stored) && safeEqual(u, want);
  if (!ok) { note('login_ip', ip, 0); note('login_user', u, 0); audit('anonymous', 'login.failed', `password for "${u.slice(0, 40)}" from ${ip}`); throw new AuthError(401, 'Wrong username or password.'); }
  note('login_ip', ip, 1);
  audit('admin', 'login.ok', `password from ${ip}`);
  return newSession(ip, ua, 'password');
}

// ---- sessions (the cookie holds a random token; only its hash is stored) ----
export function newSession(ip, ua, via) {
  const id = token(32), csrf = token(18);
  run('INSERT INTO sessions(id, csrf, created, expires, ip, ua, via) VALUES(?,?,?,?,?,?,?)', sha256(id), csrf, now(), now() + SESSION_TTL, ip, String(ua).slice(0, 200), via);
  return { id, csrf };
}
export function sessionFrom(id) {
  if (!id) return null;
  const s = get('SELECT * FROM sessions WHERE id=?', sha256(id));
  if (!s || s.expires < now()) return null;
  return s;
}
export function endSession(id) { if (id) run('DELETE FROM sessions WHERE id=?', sha256(id)); }
