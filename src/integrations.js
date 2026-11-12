// 1.0.8: Connect accounts (Abish, Nov 11 2026: "Allow to connect Google accounts and other integrations to his account").
// Each person connects his OWN accounts from his web page (/me); the assistant then uses them for him only.
// Free: the admin makes his own Google OAuth client (Google Cloud console, no cost) and pastes its Client ID and
// secret in Settings. The secret and every person's tokens are sealed in the database like the AI keys.
// Google: read-only — Gmail (read), Calendar (read), Drive (file names). Nothing is sent, changed or deleted.
// Other integrations: a provider is one entry in PROVIDERS (oauth addresses, scopes, a "who am I" call and its tools).
import crypto from 'node:crypto';
import { all, get, run, now, setting, setSecret, secret, hasSecret, audit, log, redact, rememberSecret } from './db.js';
import { cfg } from './config.js';
import { whenRemoved } from './users.js';

const G = {
  auth: () => process.env.MSA_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: () => process.env.MSA_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  api: () => (process.env.MSA_GOOGLE_API_URL || 'https://www.googleapis.com').replace(/\/+$/, ''),
  userinfo: () => process.env.MSA_GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo',
  revoke: () => process.env.MSA_GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
};
export const PROVIDERS = {
  google: {
    name: 'Google', what: 'Gmail, Calendar and Drive (read only)',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/drive.metadata.readonly'],
  },
};
export const REDIRECT_PATH = '/oauth/google/callback';
export const redirectUri = () => cfg.publicUrl + REDIRECT_PATH;
const SEC_CLIENT = 'google_client_secret';
const SEC_TOK = (id) => 'conn_token_' + id;

// ---------- the admin's Google client ----------
export function googleSetup() {
  const id = String(setting('google_client_id') || '').trim();
  return { client_id: id, has_secret: hasSecret(SEC_CLIENT), ready: !!(id && hasSecret(SEC_CLIENT)), redirect_uri: redirectUri(), https: cfg.publicUrl.startsWith('https://'),
    connected: get("SELECT COUNT(*) AS n FROM connections WHERE provider='google' AND status='connected'").n };
}
export function setGoogleClient({ client_id, client_secret }, actor = 'admin') {
  if (client_id !== undefined) {
    const v = String(client_id || '').trim();
    if (v && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(v)) throw Object.assign(new Error('The Client ID ends with .apps.googleusercontent.com — copy it from Google Cloud → Credentials.'), { status: 400 });
    run('INSERT INTO settings(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', 'google_client_id', v);
  }
  if (client_secret) { const v = String(client_secret).trim(); if (v.length < 10) throw Object.assign(new Error('That secret looks too short.'), { status: 400 }); setSecret(SEC_CLIENT, v); rememberSecret(v); }
  audit(actor, 'google.client', client_secret ? 'Client ID and secret saved' : 'Client ID saved');
  return googleSetup();
}

// ---------- a person connects ----------
export function list(userId) {
  return all('SELECT id, provider, account, status, created, last_used, error FROM connections WHERE user_id=? ORDER BY id', Number(userId))
    .map(c => ({ ...c, name: PROVIDERS[c.provider]?.name || c.provider, what: PROVIDERS[c.provider]?.what || '' }));
}
export function hasGoogle(userId) { return !!get("SELECT 1 AS x FROM connections WHERE user_id=? AND provider='google' AND status='connected'", Number(userId)); }
export function startGoogle(userId, back = '/me') {
  const st = googleSetup();
  if (!st.ready) throw Object.assign(new Error('Google connect is not set up yet. The admin adds a Google Client ID and secret in Settings → Connect accounts.'), { status: 409 });
  run('DELETE FROM oauth_states WHERE created<?', now() - 15 * 60000);
  const state = crypto.randomBytes(24).toString('base64url');
  run('INSERT INTO oauth_states(state, user_id, provider, created, back) VALUES(?,?,?,?,?)', state, Number(userId), 'google', now(), back === '/' ? '/' : '/me');
  const q = new URLSearchParams({ client_id: st.client_id, redirect_uri: st.redirect_uri, response_type: 'code', scope: PROVIDERS.google.scopes.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return { url: G.auth() + '?' + q.toString() };
}
async function postForm(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(20000) });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
  if (!r.ok) { const e = new Error(`Google said ${r.status}${j.error ? ': ' + j.error + (j.error_description ? ' (' + j.error_description + ')' : '') : ''}`); e.status = r.status; e.gerr = j.error; throw e; }
  return j;
}
/** Google sends the person back here with ?code&state. Returns { back, account }. */
export async function finishGoogle({ code, state, error }) {
  const row = state ? get('SELECT * FROM oauth_states WHERE state=?', String(state)) : null;
  if (row) run('DELETE FROM oauth_states WHERE state=?', row.state);
  if (!row || now() - row.created > 15 * 60000) throw Object.assign(new Error('This connect link is old. Go back and tap Connect Google again.'), { status: 400 });
  if (error) throw Object.assign(new Error(error === 'access_denied' ? 'You said no on the Google page, so nothing was connected.' : 'Google said: ' + String(error).slice(0, 80)), { status: 400, back: row.back });
  const tok = await postForm(G.token(), { code: String(code || ''), client_id: setting('google_client_id'), client_secret: secret(SEC_CLIENT) || '', redirect_uri: redirectUri(), grant_type: 'authorization_code' });
  let account = '';
  try { const r = await fetch(G.userinfo(), { headers: { Authorization: 'Bearer ' + tok.access_token }, signal: AbortSignal.timeout(15000) }); const j = await r.json(); account = String(j.email || '').slice(0, 200); } catch {}
  const t = now();
  const ex = get("SELECT * FROM connections WHERE user_id=? AND provider='google' AND account=?", row.user_id, account);
  const old = ex ? JSON.parse(secret(SEC_TOK(ex.id)) || '{}') : {};
  const id = ex ? ex.id : Number(run('INSERT INTO connections(user_id, provider, account, scopes, status, created, updated) VALUES(?,?,?,?,?,?,?)', row.user_id, 'google', account, tok.scope || '', 'connected', t, t).lastInsertRowid);
  setSecret(SEC_TOK(id), JSON.stringify({ access_token: tok.access_token, refresh_token: tok.refresh_token || old.refresh_token || '', expires_at: t + (Number(tok.expires_in) || 3600) * 1000 - 60000 }));
  rememberSecret(tok.access_token); if (tok.refresh_token) rememberSecret(tok.refresh_token);
  run("UPDATE connections SET status='connected', scopes=?, updated=?, error=NULL WHERE id=?", tok.scope || '', t, id);
  audit('user#' + row.user_id, 'connect.google', account ? account.replace(/^(.).*(@.*)$/, '$1…$2') : 'connected');
  return { back: row.back, account };
}
export async function disconnect(userId, connId) {
  const c = get('SELECT * FROM connections WHERE id=? AND user_id=?', Number(connId), Number(userId));
  if (!c) throw Object.assign(new Error('Not found'), { status: 404 });
  const tok = JSON.parse(secret(SEC_TOK(c.id)) || '{}');
  if (c.provider === 'google' && (tok.refresh_token || tok.access_token)) await fetch(G.revoke() + '?token=' + encodeURIComponent(tok.refresh_token || tok.access_token), { method: 'POST', signal: AbortSignal.timeout(10000) }).catch(() => {});
  run('DELETE FROM secrets WHERE k=?', SEC_TOK(c.id)); run('DELETE FROM connections WHERE id=?', c.id);
  audit('user#' + userId, 'connect.removed', c.provider);
  return { ok: true };
}
whenRemoved((uid) => { for (const c of all('SELECT id FROM connections WHERE user_id=?', uid)) run('DELETE FROM secrets WHERE k=?', SEC_TOK(c.id)); run('DELETE FROM connections WHERE user_id=?', uid); });

// ---------- using it (read only) ----------
async function accessToken(c) {
  const tok = JSON.parse(secret(SEC_TOK(c.id)) || '{}');
  if (tok.access_token && tok.expires_at > now()) return tok.access_token;
  if (!tok.refresh_token) throw Object.assign(new Error('Google needs to be connected again (open your page → Connect accounts).'), { reconnect: true });
  try {
    const j = await postForm(G.token(), { client_id: setting('google_client_id'), client_secret: secret(SEC_CLIENT) || '', refresh_token: tok.refresh_token, grant_type: 'refresh_token' });
    setSecret(SEC_TOK(c.id), JSON.stringify({ ...tok, access_token: j.access_token, expires_at: now() + (Number(j.expires_in) || 3600) * 1000 - 60000 }));
    rememberSecret(j.access_token);
    return j.access_token;
  } catch (e) {
    if (e.gerr === 'invalid_grant') { run("UPDATE connections SET status='expired', error=? WHERE id=?", 'Google ended this connection; connect again', c.id); throw Object.assign(new Error('Google ended this connection (it happens after 7 days while the Google app is in Testing). Connect again on your page.'), { reconnect: true }); }
    throw e;
  }
}
async function gget(c, path) {
  const tokn = await accessToken(c);
  const r = await fetch(G.api() + path, { headers: { Authorization: 'Bearer ' + tokn }, signal: AbortSignal.timeout(20000) });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(`Google ${r.status}: ${redact(String(j.error?.message || t)).slice(0, 160)}`);
  run('UPDATE connections SET last_used=? WHERE id=?', now(), c.id);
  return j;
}
const conns = (userId) => all("SELECT * FROM connections WHERE user_id=? AND provider='google' AND status='connected' ORDER BY id", Number(userId));
const hdr = (m, n) => (m.payload?.headers || []).find(h => h.name.toLowerCase() === n)?.value || '';
export async function calendarUpcoming(userId, { days = 7, max = 15 } = {}) {
  const out = [];
  for (const c of conns(userId)) {
    const q = new URLSearchParams({ timeMin: new Date().toISOString(), timeMax: new Date(now() + Math.min(60, Math.max(1, days)) * 86400000).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(50, max)) });
    const j = await gget(c, '/calendar/v3/calendars/primary/events?' + q);
    for (const e of j.items || []) out.push({ account: c.account, title: e.summary || '(no title)', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, where: e.location || '' });
  }
  return out.sort((a, b) => String(a.start).localeCompare(String(b.start))).slice(0, max);
}
export async function gmailRecent(userId, { query = 'in:inbox', max = 8 } = {}) {
  const out = [];
  for (const c of conns(userId)) {
    const j = await gget(c, '/gmail/v1/users/me/messages?' + new URLSearchParams({ q: String(query || 'in:inbox').slice(0, 200), maxResults: String(Math.min(15, max)) }));
    for (const m of (j.messages || []).slice(0, Math.min(15, max))) {
      const d = await gget(c, `/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      out.push({ account: c.account, from: hdr(d, 'from'), subject: hdr(d, 'subject'), date: hdr(d, 'date'), snippet: String(d.snippet || '').slice(0, 300), unread: (d.labelIds || []).includes('UNREAD') });
    }
  }
  return out;
}
export async function driveFind(userId, { name = '', max = 10 } = {}) {
  const out = [];
  for (const c of conns(userId)) {
    const q = name ? `name contains '${String(name).replace(/['\\]/g, ' ').slice(0, 100)}' and trashed = false` : 'trashed = false';
    const j = await gget(c, '/drive/v3/files?' + new URLSearchParams({ q, pageSize: String(Math.min(25, max)), orderBy: 'modifiedTime desc', fields: 'files(name,mimeType,modifiedTime,webViewLink)' }));
    for (const f of j.files || []) out.push({ account: c.account, name: f.name, type: f.mimeType, modified: f.modifiedTime, link: f.webViewLink });
  }
  return out;
}
