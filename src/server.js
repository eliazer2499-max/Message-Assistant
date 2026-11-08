// Message Assistant: the admin dashboard (HTTP on 127.0.0.1:8788 behind Caddy) and the service itself.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { cfg, VERSION, APP_DIR, PRODUCT, isHttps } from './config.js';
import { all, get, run, now, setting, setSetting, allSettings, audit, log, redact } from './db.js';
import * as aikeys from './aikeys.js';
import { PRESETS } from './presets.js';
import { testKeyById } from './models.js';
import * as users from './users.js';
import * as auth from './adminauth.js';
import { approveAndWelcome } from './router.js';
import { listAlerts, clearAlerts } from './alerts.js';
import { queueStats } from './agent.js';
import { pending as outboxPending, recent as outboxRecent } from './outbox.js';
import * as B from './browser.js';
import { startApp, channel as appChannel, STATE_WORDS } from './app.js';
import { backup } from './scheduler.js';
import * as upd from './updates.js';

let CH = null;
const PUBLIC = path.join(APP_DIR, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const EDITABLE = ['assistant_name', 'timezone', 'waiting_text', 'welcome_text', 'busy_text', 'daily_limit', 'max_steps', 'job_minutes', 'history_messages', 'max_parallel',
  'browser_enabled', 'browser_job_seconds', 'browser_parallel', 'alert_webhook', 'model'];

function send(res, status, body, headers = {}) {
  const h = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", ...headers };
  if (Buffer.isBuffer(body)) { res.writeHead(status, h); return res.end(body); }
  if (typeof body === 'string') { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...h }); return res.end(body); }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...h });
  res.end(JSON.stringify(body));
}
function cookies(req) { const o = {}; for (const p of String(req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
function clientIp(req) {
  const ra = req.socket.remoteAddress || '';
  if (/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(ra) && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim().slice(0, 64);
  return ra;
}
async function body(req, limit = 64 * 1024) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('Too much data'), { status: 413 }); chunks.push(c); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}
const cookieFlags = () => `Path=/; HttpOnly; SameSite=Strict${isHttps() ? '; Secure' : ''}`;
function setSession(res, s) { return { 'Set-Cookie': `msa_sid=${s.id}; Max-Age=${Math.floor(auth.SESSION_TTL / 1000)}; ${cookieFlags()}` }; }

function messagesStatus() {
  const s = CH ? CH.status() : { state: 'not_started' };
  return { ...s, words: STATE_WORDS[s.state] || s.state, outbox_waiting: outboxPending() };
}

const routes = [];
const on = (method, re, fn, { open = false } = {}) => routes.push({ method, re, fn, open });

// ---------- public ----------
on('GET', /^\/healthz$/, async () => ({ ok: true, version: VERSION }), { open: true });
on('GET', /^\/api\/me$/, async (req, { session }) => ({ signed_in: !!session, csrf: session ? session.csrf : null, version: VERSION, product: setting('assistant_name') || PRODUCT,
  password_login: auth.hasPassword(), phone_login: users.adminPhones().length > 0 }), { open: true });
on('POST', /^\/api\/login\/code$/, async (req, { b }) => auth.requestCode(b.phone, clientIp(req), CH ? CH.status().state : 'stopped'), { open: true });
on('POST', /^\/api\/login\/verify$/, async (req, { b }) => { const s = auth.verifyCode(b.phone, b.code, clientIp(req), req.headers['user-agent']); return { __headers: setSession(null, s), ok: true, csrf: s.csrf }; }, { open: true });
on('POST', /^\/api\/login\/password$/, async (req, { b }) => { const s = auth.passwordLogin(b.username, b.password, clientIp(req), req.headers['user-agent']); return { __headers: setSession(null, s), ok: true, csrf: s.csrf }; }, { open: true });
on('POST', /^\/api\/logout$/, async (req, { sid }) => { auth.endSession(sid); return { __headers: { 'Set-Cookie': `msa_sid=; Max-Age=0; ${cookieFlags()}` }, ok: true }; }, { open: true });

// ---------- overview ----------
on('GET', /^\/api\/overview$/, async () => ({
  version: VERSION, messages: messagesStatus(), alerts: listAlerts(true),
  people: { pending: get("SELECT COUNT(*) AS n FROM users WHERE status='pending'").n, approved: get("SELECT COUNT(*) AS n FROM users WHERE status='approved'").n, blocked: get("SELECT COUNT(*) AS n FROM users WHERE status='blocked'").n },
  keys: aikeys.listKeys().map(k => ({ id: k.id, name: k.name, status: k.status })), queue: queueStats(), browser: B.stats(),
  today: get('SELECT COALESCE(SUM(messages),0) AS messages, COALESCE(SUM(replies),0) AS replies, COALESCE(SUM(model_calls),0) AS model_calls FROM usage WHERE day=?', users.today()),
}));
on('POST', /^\/api\/alerts\/clear$/, async (req, { b }) => { clearAlerts(b.id || null); return { ok: true }; });
on('GET', /^\/api\/activity$/, async () => ({ items: all('SELECT id, ts, actor, action, detail FROM audit ORDER BY id DESC LIMIT 200'), outbox: outboxRecent(30) }));

// ---------- people ----------
on('GET', /^\/api\/users$/, async (req, { url }) => ({ users: users.listUsers(url.searchParams.get('status') || null) }));
on('GET', /^\/api\/users\/(\d+)$/, async (req, { m }) => {
  const u = users.userById(m[1]); if (!u) throw Object.assign(new Error('Not found'), { status: 404 });
  return { user: users.publicUser(u), today: users.usageOf(u.id), total: users.usageTotals(u.id), limit: users.dailyLimit(u),
    notes: all('SELECT id, fact, ts FROM memory WHERE user_id=? ORDER BY id DESC', u.id),
    reminders: all('SELECT id, text, due, every_minutes FROM reminders WHERE user_id=? AND active=1 ORDER BY due', u.id),
    messages: all('SELECT id, role, text, ts FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 40', u.id).reverse() };
});
on('POST', /^\/api\/users\/(\d+)\/approve$/, async (req, { m }) => ({ user: users.publicUser(approveAndWelcome(Number(m[1]))) }));
on('POST', /^\/api\/users\/(\d+)\/block$/, async (req, { m }) => ({ user: users.publicUser(users.block(Number(m[1]))) }));
on('POST', /^\/api\/users\/(\d+)\/remove$/, async (req, { m }) => { B.forgetUser(Number(m[1])); return users.remove(Number(m[1])); });
on('POST', /^\/api\/users\/(\d+)$/, async (req, { m, b }) => ({ user: users.publicUser(users.updateUser(Number(m[1]), b)) }));
on('POST', /^\/api\/users\/(\d+)\/notes\/(\d+)\/delete$/, async (req, { m }) => ({ deleted: run('DELETE FROM memory WHERE id=? AND user_id=?', Number(m[2]), Number(m[1])).changes }));

// ---------- AI keys ----------
on('GET', /^\/api\/keys$/, async () => ({ keys: aikeys.listKeys(), presets: PRESETS }));
on('POST', /^\/api\/keys$/, async (req, { b }) => ({ key: aikeys.addKey(b) }));
on('POST', /^\/api\/keys\/reorder$/, async (req, { b }) => ({ keys: aikeys.reorderKeys(b.ids) }));
on('POST', /^\/api\/keys\/(\d+)$/, async (req, { m, b }) => ({ key: aikeys.updateKey(Number(m[1]), b) }));
on('POST', /^\/api\/keys\/(\d+)\/delete$/, async (req, { m }) => { aikeys.removeKey(Number(m[1])); return { ok: true }; });
on('POST', /^\/api\/keys\/(\d+)\/move$/, async (req, { m, b }) => { aikeys.moveKey(Number(m[1]), b.dir); return { keys: aikeys.listKeys() }; });
on('POST', /^\/api\/keys\/(\d+)\/test$/, async (req, { m }) => testKeyById(Number(m[1])));
on('POST', /^\/api\/keys\/(\d+)\/wake$/, async (req, { m }) => ({ key: aikeys.wakeKey(Number(m[1])) }));

// ---------- settings ----------
on('GET', /^\/api\/settings$/, async () => { const s = allSettings(); const o = {}; for (const k of EDITABLE) o[k] = s[k]; return { settings: o, admin_phones: users.adminPhones(), admin_username: setting('admin_username') }; });
on('POST', /^\/api\/settings$/, async (req, { b }) => {
  for (const k of EDITABLE) if (b[k] !== undefined) {
    let v = String(b[k] ?? '').slice(0, 2000);
    if (k === 'alert_webhook' && v && !/^https:\/\/[^\s]+$/.test(v)) throw Object.assign(new Error('The alert address must start with https://'), { status: 400 });
    if (k === 'timezone') { try { new Date().toLocaleString('en-US', { timeZone: v }); } catch { throw Object.assign(new Error('Unknown timezone'), { status: 400 }); } }
    setSetting(k, v);
  }
  if (b.admin_phones !== undefined) {
    const list = String(b.admin_phones).split(/[,;\n]+/).map(x => x.trim()).filter(Boolean).map(x => users.normalizePhone(x));
    if (list.some(x => !x)) throw Object.assign(new Error('A phone number is not right; use +1 646 555 0100'), { status: 400 });
    setSetting('admin_phones', list.join(','));
  }
  audit('admin', 'settings.saved', Object.keys(b).join(', '));
  return { ok: true };
});
on('POST', /^\/api\/password$/, async (req, { b }) => {
  if (auth.hasPassword()) { try { auth.passwordLogin(setting('admin_username'), b.current, clientIp(req)); } catch { throw Object.assign(new Error('The current password is not right'), { status: 400 }); } }
  auth.setPassword(b.password, b.username || null);
  return { ok: true, signed_out: true };
});
on('POST', /^\/api\/backup$/, async () => ({ file: path.basename(backup('manual')) }));
// ---------- updates (1.0.1) ----------
on('GET', /^\/api\/update$/, async () => upd.info());
on('POST', /^\/api\/update\/auto$/, async (req, { b }) => { const on = !!b.on; upd.setAuto(on); audit('admin', 'update.auto', on ? 'on' : 'off'); return upd.info(); });
on('POST', /^\/api\/update\/check$/, async () => upd.info({ fresh: true }));
on('POST', /^\/api\/update\/now$/, async () => { upd.requestNow(); audit('admin', 'update.now', ''); return { ok: true, words: 'Update started. The dashboard reloads by itself in a minute or two.' }; });

// ---------- Google Messages connection (live view) ----------
on('GET', /^\/api\/messages\/status$/, async () => messagesStatus());
on('GET', /^\/api\/messages\/screen$/, async () => { const jpg = CH ? await CH.screen() : null; if (!jpg) return { __raw: Buffer.alloc(0), __status: 204 }; return { __raw: Buffer.from(jpg), __type: 'image/jpeg' }; });
on('POST', /^\/api\/messages\/input$/, async (req, { b }) => { if (b.type === 'text') audit('admin', 'messages.typed', `${String(b.text || '').length} characters into the Messages browser`); return CH.input(b); });
on('POST', /^\/api\/messages\/restart$/, async () => { audit('admin', 'messages.restart', ''); return CH.restart(); });
on('POST', /^\/api\/messages\/signout$/, async () => { audit('admin', 'messages.signout', 'Google sign-in and pairing removed'); return CH.signOut(); });

// ---------- static ----------
function serveStatic(req, res, p) {
  const rel = p === '/' ? 'index.html' : p.slice(1);
  if (!/^[a-z0-9._-]+$/i.test(rel)) return false;
  const f = path.join(PUBLIC, rel);
  if (!fs.existsSync(f)) return false;
  send(res, 200, fs.readFileSync(f), { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  return true;
}

export function handler() {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && url.pathname !== '/healthz') { if (serveStatic(req, res, url.pathname)) return; return send(res, 404, 'Not found'); }
      const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
      if (!r) return send(res, 404, { error: 'Not found' });
      const sid = cookies(req).msa_sid;
      const session = auth.sessionFrom(sid);
      if (!r.open && !session) return send(res, 401, { error: 'Please sign in' });
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host && new URL(origin).host !== new URL(cfg.publicUrl).host) return send(res, 403, { error: 'Wrong origin' });
        if (!r.open && req.headers['x-csrf-token'] !== session.csrf) return send(res, 403, { error: 'Please reload the page' });
      }
      const b = req.method === 'POST' ? await body(req) : {};
      const out = await r.fn(req, { m: url.pathname.match(r.re), b, url, session, sid });
      if (out && out.__raw) return send(res, out.__status || 200, out.__raw, { 'Content-Type': out.__type || 'application/octet-stream' });
      if (out && out.__status === 204) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
      const headers = (out && out.__headers) || {};
      if (out && out.__headers) delete out.__headers;
      send(res, 200, out ?? { ok: true }, headers);
    } catch (e) {
      const status = e.status || (e instanceof auth.AuthError ? e.status : 500);
      if (status >= 500) log('http', req.method, url.pathname, 'failed:', e.stack || e.message);
      send(res, status, { error: redact(status >= 500 ? 'Something went wrong: ' + e.message : e.message) });
    }
  };
}

export async function main({ channel = null, port = cfg.port, host = cfg.host } = {}) {
  const app = await startApp({ channel });
  CH = app.channel;
  const srv = http.createServer(handler());
  await new Promise(r => srv.listen(port, host, r));
  log('http', `${PRODUCT} ${VERSION} listening on ${host}:${srv.address().port}`);
  const stop = async () => { srv.close(); await app.stop(); await B.shutdown(); };
  return { server: srv, port: srv.address().port, channel: CH, stop };
}

// 1.0.1: started through the /opt/messageassistant/current symlink, argv[1] and APP_DIR differ as strings
// (APP_DIR is the real releases/<version> path), so compare real paths. 1.0.0 compared plain paths and never started.
function isEntry() {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(process.argv[1]) === real(path.join(APP_DIR, 'src', 'server.js'));
}
if (isEntry()) {
  const s = await main();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { log('http', 'stopping'); await s.stop().catch(() => {}); process.exit(0); });
}
