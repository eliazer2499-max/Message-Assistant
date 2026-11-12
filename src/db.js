// SQLite (Node's built-in node:sqlite). One file: <dataDir>/messageassistant.db (mode 600).
// Every per-user table carries user_id; nothing reads another user's rows (see users.js / tools).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { seal, unseal } from './crypto.js';

export let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS secrets (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, actor TEXT, action TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, csrf TEXT, created INTEGER, expires INTEGER, ip TEXT, ua TEXT, via TEXT);
CREATE TABLE IF NOT EXISTS attempts (kind TEXT, k TEXT, ts INTEGER, ok INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS admin_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, code_hash TEXT, created INTEGER, expires INTEGER, tries INTEGER DEFAULT 0, used INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE, conv_id TEXT, name TEXT, status TEXT NOT NULL DEFAULT 'pending',
  created INTEGER, approved_at INTEGER, last_seen INTEGER, waiting_reply_sent INTEGER DEFAULT 0, paused INTEGER DEFAULT 0,
  daily_limit INTEGER, settings TEXT DEFAULT '{}', first_text TEXT);
CREATE TABLE IF NOT EXISTS usage (user_id INTEGER, day TEXT, messages INTEGER DEFAULT 0, replies INTEGER DEFAULT 0, model_calls INTEGER DEFAULT 0,
  tokens INTEGER DEFAULT 0, browser_ms INTEGER DEFAULT 0, searches INTEGER DEFAULT 0, PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, role TEXT, text TEXT, ts INTEGER, ext_id TEXT);
CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, fact TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, text TEXT, due INTEGER, every_minutes INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1, created INTEGER, last_fired INTEGER);
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, status TEXT, text TEXT, created INTEGER, updated INTEGER,
  steps INTEGER DEFAULT 0, result TEXT, error TEXT, retry_at INTEGER DEFAULT 0, busy_sent INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, to_phone TEXT, conv_id TEXT, text TEXT, kind TEXT DEFAULT 'reply',
  priority INTEGER DEFAULT 5, status TEXT DEFAULT 'queued', tries INTEGER DEFAULT 0, created INTEGER, sent_at INTEGER, error TEXT);
CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, ts INTEGER);
CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, level TEXT, text TEXT, cleared INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT, public_name TEXT UNIQUE, project TEXT, bytes INTEGER DEFAULT 0,
  created INTEGER, updated INTEGER, request_id INTEGER);
CREATE TABLE IF NOT EXISTS site_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, site TEXT, public_name TEXT, project TEXT, folder TEXT,
  status TEXT, created INTEGER, updated INTEGER, preview_token TEXT, shot_token TEXT, decided_by TEXT);
CREATE TABLE IF NOT EXISTS media (token TEXT PRIMARY KEY, file TEXT, name TEXT, user_id INTEGER, created INTEGER, expires INTEGER);
CREATE TABLE IF NOT EXISTS user_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, phone TEXT, code_hash TEXT, created INTEGER, expires INTEGER, tries INTEGER DEFAULT 0, used INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS user_sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf TEXT, created INTEGER, expires INTEGER, ip TEXT, ua TEXT);
CREATE INDEX IF NOT EXISTS idx_usess_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_msg_user ON messages(user_id, id);
CREATE INDEX IF NOT EXISTS idx_mem_user ON memory(user_id);
CREATE INDEX IF NOT EXISTS idx_rem_due ON reminders(active, due);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, priority, id);
CREATE INDEX IF NOT EXISTS idx_attempts ON attempts(kind, k, ts);
`;

export function openDb(file) {
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const f = file || path.join(cfg.dataDir, 'messageassistant.db');
  db = new DatabaseSync(f);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  try { if (f !== ':memory:') fs.chmodSync(f, 0o600); } catch {}
  if (get('PRAGMA user_version').user_version < 1) db.exec('PRAGMA user_version=1');
  // 1.0.2: sites (per-person address part, "chosen people" flag) and pictures/files on outgoing texts
  const cols = (t) => all(`PRAGMA table_info(${t})`).map(c => c.name);
  const add = (t, c, type) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`); };
  add('users', 'site_slug', 'TEXT'); add('users', 'sites_allowed', 'INTEGER');
  add('outbox', 'media', 'TEXT'); add('outbox', 'media_url', 'TEXT');
  // 1.0.7: a text that left the typing box but is not shown as sent yet is checked again later (never typed twice)
  // 1.0.8: access until a date (admin: 1 month / a date / no end); one polite "access ended" text
  add('users', 'access_until', 'INTEGER'); add('users', 'expired_notice_sent', 'INTEGER DEFAULT 0');
  // 1.0.8: speed — where each reply's time went
  add('jobs', 'timing', 'TEXT');
  // 1.0.8: connected accounts (Google…), per person; tokens are sealed in secrets (like the AI keys)
  db.exec(`CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, provider TEXT NOT NULL, account TEXT, scopes TEXT,
    status TEXT DEFAULT 'connected', created INTEGER, updated INTEGER, last_used INTEGER, error TEXT, UNIQUE(user_id, provider, account))`);
  db.exec('CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, user_id INTEGER, provider TEXT, created INTEGER, back TEXT)');
  add('outbox', 'parts_done', 'INTEGER DEFAULT 0'); add('outbox', 'check_at', 'INTEGER'); add('outbox', 'checks', 'INTEGER DEFAULT 0'); add('outbox', 'check_text', 'TEXT');
  if (get('PRAGMA user_version').user_version < 2) db.exec('PRAGMA user_version=2');
  return db;
}

export const now = () => Date.now();
export function all(sql, ...a) { return db.prepare(sql).all(...a); }
export function get(sql, ...a) { return db.prepare(sql).get(...a); }
export function run(sql, ...a) { return db.prepare(sql).run(...a); }
export function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

// ---- settings (plain, non-secret) ----
export const DEFAULTS = {
  assistant_name: 'Message Assistant',
  model: 'gemini-3.6-flash',                   // default Gemini model (aikeys.js reads it)
  openai_base_url: 'https://api.openai.com/v1',
  provider: 'gemini',
  timezone: 'America/New_York',
  admin_phones: '',                             // E.164, comma separated
  admin_username: 'admin',
  waiting_text: 'Hi! Thanks for your message. This assistant is invite-only, and your number is waiting for approval. You will get a message here as soon as you are approved.',
  welcome_text: 'You are approved! I am {name}. Text me any question, or ask me to look something up or do a task on the web. Text HELP for tips.',
  blocked_silent: '1',
  daily_limit: '60',                            // messages per user per day (0 = no limit); protects the free keys
  max_steps: '12',                              // model steps for one message
  job_minutes: '6',                             // longest one message may take
  history_messages: '14',
  max_parallel: '2',                            // messages thinking at the same time
  browser_enabled: '1',
  browser_job_seconds: '180',                   // per browser job (one user's turn holding the browser)
  browser_parallel: '1',
  alert_webhook: '',                            // optional free alert: e.g. https://ntfy.sh/<your-topic>
  gm_state: 'not_started',
  gm_state_since: '0',
  gm_baseline_done: '0',
  busy_text: 'Busy right now, one moment. I will answer as soon as I can.',
  expired_text: 'Your access to {name} has ended. Please contact the admin if you would like to keep using it. Thank you!',   // 1.0.8
  tool_rounds: '3',                             // 1.0.8: at most this many rounds of tools (search, browser…) per message, then it answers
  fast_chat: '1',                               // 1.0.8: plain chat ("hi", "thanks") is answered in ONE AI call, no tools
  google_client_id: '',                         // 1.0.8: the admin's own Google OAuth client (Connect accounts); the secret is sealed
  sites_mode: 'all',                            // 1.0.2: who can build sites: all | chosen | off
  sites_approval: '0',                          // 1.0.2: 1 = the admin approves every publish too
  sites_quota_mb: '50',                         // per person: workspace + published sites
  sites_max: '5',                               // published sites per person
 portal_enabled: '1',                          // 1.0.2: people can sign in to their own web chat
  update_notify: '1',                           // 1.0.2: text the admin once when a new version is out
};
export function setting(k) {
  const r = get('SELECT v FROM settings WHERE k=?', k);
  return r ? r.v : (DEFAULTS[k] ?? '');
}
export function setSetting(k, v) {
  run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v ?? ''));
}
export function allSettings() {
  const o = { ...DEFAULTS };
  for (const r of all('SELECT k,v FROM settings')) o[r.k] = r.v;
  return o;
}

// ---- secrets (AES-256-GCM sealed with master.key) ----
export function setSecret(k, v) {
  if (v === null || v === undefined || v === '') { run('DELETE FROM secrets WHERE k=?', k); return; }
  run('INSERT INTO secrets(k,v,updated) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated=excluded.updated', k, seal(v), now());
  rememberSecret(String(v));
}
export function secret(k) {
  const r = get('SELECT v FROM secrets WHERE k=?', k);
  if (!r) return '';
  const v = unseal(r.v); rememberSecret(v); return v;
}
export function hasSecret(k) { return !!get('SELECT 1 AS x FROM secrets WHERE k=?', k); }

// Every secret value decrypted in this process; redact() hides them from logs and the activity list.
const KNOWN = new Set();
export function rememberSecret(v) { if (v && String(v).length >= 8) KNOWN.add(String(v)); }
export function redact(text) {
  let s = String(text ?? '');
  for (const v of KNOWN) if (s.includes(v)) s = s.split(v).join('[hidden]');
  return s
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[hidden]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[hidden]')
    .replace(/\bya29\.[0-9A-Za-z_\-]+/g, '[hidden]')
    .replace(/\bsk-[A-Za-z0-9_\-]{20,}\b/g, '[hidden]')
    .replace(/\b(gsk|xai|sk-or-v1)[_-][A-Za-z0-9_\-]{20,}\b/g, '[hidden]')
    .replace(/\b(nvapi|csk)-[A-Za-z0-9_\-]{20,}\b/g, '[hidden]')                      // NVIDIA / Cerebras keys
    .replace(/\bhf_[A-Za-z0-9]{20,}\b/g, '[hidden]')                                    // Hugging Face tokens
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[hidden private key]');
}
/** A key shown back to the admin: never the whole value. */
export function mask(v) {
  const s = String(v || '');
  if (!s) return '';
  return s.length <= 8 ? '••••' : '••••' + s.slice(-4);
}

export function audit(actor, action, detail) {
  run('INSERT INTO audit(ts,actor,action,detail) VALUES(?,?,?,?)', now(), actor, action, redact(typeof detail === 'string' ? detail : JSON.stringify(detail ?? '')).slice(0, 4000));
}
export function log(...a) {
  if (cfg.testMode && !process.env.SHOW_LOGS) return;
  console.log(new Date().toISOString(), redact(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')));
}
export function seenOnce(id) {
  try { run('INSERT INTO seen(id,ts) VALUES(?,?)', String(id), now()); return true; } catch { return false; }
}
export function isSeen(id) { return !!get('SELECT 1 AS x FROM seen WHERE id=?', String(id)); }
