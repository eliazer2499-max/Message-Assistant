// Every ~20 s: reminders that are due, jobs waiting for a free AI key, clean-up; once a day a database backup.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, now, setting, setSetting, db, log, audit } from './db.js';
import { cfg } from './config.js';
import { userById, today, accessEnded } from './users.js';
import { enqueueText } from './outbox.js';
import { pump } from './agent.js';
import { cleanupAttempts } from './adminauth.js';

let timer = null;
export function startScheduler(ms = cfg.tickMs) { if (!timer) { timer = setInterval(() => tick().catch(e => log('tick', e.message)), ms); timer.unref?.(); } }
export function stopScheduler() { if (timer) clearInterval(timer); timer = null; }

export async function tick(t = now()) {
  for (const r of all('SELECT * FROM reminders WHERE active=1 AND due<=? ORDER BY due LIMIT 50', t)) {
    const u = userById(r.user_id);
    if (!u || u.status !== 'approved') { run('UPDATE reminders SET active=0 WHERE id=?', r.id); continue; }
    if (!u.paused && !accessEnded(u)) enqueueText({ userId: u.id, text: '⏰ Reminder: ' + r.text, kind: 'reminder' });     // 1.0.8: none after the end date
    if (r.every_minutes > 0) {
      let next = r.due + r.every_minutes * 60000; while (next <= t) next += r.every_minutes * 60000;
      run('UPDATE reminders SET due=?, last_fired=? WHERE id=?', next, t, r.id);
    } else run('UPDATE reminders SET active=0, last_fired=? WHERE id=?', t, r.id);
  }
  pump();
  if (Math.random() < 0.05) { cleanupAttempts(); run('DELETE FROM seen WHERE ts<?', t - 60 * 86400000); run("DELETE FROM outbox WHERE status IN ('sent','cancelled') AND created<?", t - 30 * 86400000); }
  const day = today(t);
  if (setting('last_backup_day') !== day && !cfg.testMode) { setSetting('last_backup_day', day); backup('daily'); }
}

/** A consistent copy of the database in <dataDir>/backups (the 7 newest daily copies are kept). */
export function backup(kind = 'manual') {
  const dir = path.join(cfg.dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
  try { fs.chmodSync(f, 0o600); } catch {}
  const daily = fs.readdirSync(dir).filter(n => n.startsWith('daily-')).sort();
  for (const old of daily.slice(0, Math.max(0, daily.length - 7))) fs.rmSync(path.join(dir, old), { force: true });
  audit('system', 'backup', path.basename(f));
  return f;
}
