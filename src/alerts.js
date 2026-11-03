// Admin alerts: the dashboard banner, the activity list, an optional free webhook (e.g. https://ntfy.sh/<topic> — the
// ntfy app on his phone then pings him; any URL that takes a POST works), and a text to the admin phone(s) when
// Messages itself is working. The same alert is not repeated within 10 minutes.
import { all, run, now, setting, audit, log, redact } from './db.js';
import { adminPhones } from './users.js';
import { enqueueText } from './outbox.js';

const recentAlerts = new Map();
let channelState = () => 'unknown';
export function alertsChannelState(fn) { channelState = fn; }
export function alert(level, text, { rcs = true, key = null } = {}) {
  const k = key || text; const t = now();
  if (recentAlerts.has(k) && t - recentAlerts.get(k) < 10 * 60000) return false;
  recentAlerts.set(k, t);
  run('INSERT INTO alerts(ts, level, text) VALUES(?,?,?)', t, level, redact(text).slice(0, 1000));
  audit('system', 'alert.' + level, text);
  const hook = setting('alert_webhook');
  if (hook && /^https:\/\//.test(hook)) {
    fetch(hook, { method: 'POST', headers: { 'Content-Type': 'text/plain', Title: 'Message Assistant', Priority: level === 'error' ? 'high' : 'default' }, body: redact(text).slice(0, 1000), signal: AbortSignal.timeout(10000) })
      .catch(e => log('alert', 'webhook failed:', e.message));
  }
  if (rcs && channelState() === 'connected') for (const p of adminPhones()) enqueueText({ toPhone: p, text: 'Message Assistant: ' + text, kind: 'admin' });
  return true;
}
export function listAlerts(open = true) { return all(`SELECT id, ts, level, text FROM alerts ${open ? 'WHERE cleared=0' : ''} ORDER BY id DESC LIMIT 50`); }
export function clearAlerts(id = null) { if (id) run('UPDATE alerts SET cleared=1 WHERE id=?', Number(id)); else run('UPDATE alerts SET cleared=1'); }
