// 1.1.4: the secure vault. A person saves ANY account here — a website login, an API token, any secret —
// from their own page. The secret itself is sealed in the secrets table (same encryption as the AI keys);
// this table holds only the label and the non-secret fields. Rules, by design:
//  - a secret is NEVER shown again (not on the page, not in a chat, not to the assistant's brain);
//  - the assistant can list the NAMES (so it knows what it can use) and can have a login FILLED IN by
//    browser_login, which reads the sealed value server-side and types it straight into the page.
import { all, get, run, now, secret, setSecret, audit } from './db.js';
import { whenRemoved } from './users.js';

const SEC = (id) => 'vault_' + id;
export const KINDS = ['login', 'token', 'secret'];
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

export function addEntry(userId, b = {}) {
  const kind = KINDS.includes(b.kind) ? b.kind : 'login';
  const label = clean(b.label, 80); if (!label) throw Object.assign(new Error('Give it a label, e.g. "Cloudflare" or "Chase bank"'), { status: 400 });
  const value = String(b.secret ?? '').trim(); if (!value) throw Object.assign(new Error('Paste the password, token or secret to store'), { status: 400 });
  if (value.length > 4000) throw Object.assign(new Error('That is too long for one vault entry'), { status: 400 });
  const t = now();
  const r = run('INSERT INTO vault_entries(user_id, label, kind, site, username, created, updated) VALUES(?,?,?,?,?,?,?)',
    Number(userId), label, kind, clean(b.site, 200) || null, clean(b.username, 200) || null, t, t);
  const id = Number(r.lastInsertRowid);
  setSecret(SEC(id), value);
  audit('user#' + userId, 'vault.added', `"${label}" (${kind})`);
  return entryRow(id);
}
export function entryRow(id) { return get('SELECT * FROM vault_entries WHERE id=?', Number(id)); }
/** What anyone (page, assistant) may see: everything EXCEPT the secret. */
export function listEntries(userId) {
  return all('SELECT id, label, kind, site, username, created, updated FROM vault_entries WHERE user_id=? ORDER BY id', Number(userId))
    .map(r => ({ ...r, has_secret: !!secret(SEC(r.id)) }));
}
/** Find one of THIS person's entries by id or by (part of) its label. Internal. */
export function findEntry(userId, idOrLabel) {
  const rows = all('SELECT * FROM vault_entries WHERE user_id=? ORDER BY id', Number(userId));
  const byId = rows.find(r => r.id === Number(idOrLabel));
  if (byId) return byId;
  const q = String(idOrLabel || '').trim().toLowerCase();
  if (!q) return null;
  return rows.find(r => r.label.toLowerCase() === q) || rows.find(r => r.label.toLowerCase().includes(q)) || null;
}
/** The sealed value. SERVER-SIDE ONLY: browser_login uses it; it is never returned to a page or the model. */
export function secretOf(id) { return secret(SEC(Number(id))); }
export function removeEntry(userId, id) {
  const r = entryRow(id); if (!r || Number(r.user_id) !== Number(userId)) throw Object.assign(new Error('That entry is gone'), { status: 404 });
  run('DELETE FROM vault_entries WHERE id=?', r.id);
  setSecret(SEC(r.id), '');
  audit('user#' + userId, 'vault.removed', `"${r.label}"`);
  return { ok: true };
}
/** A person was removed from the system: their vault goes with them. */
export function forgetUser(userId) {
  for (const r of all('SELECT id FROM vault_entries WHERE user_id=?', Number(userId))) setSecret(SEC(r.id), '');
  run('DELETE FROM vault_entries WHERE user_id=?', Number(userId));
}
whenRemoved((uid) => forgetUser(uid));
