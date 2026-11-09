// Wiring: database, keys, the Messages channel, the router, the outbox, the agent and the scheduler.
import { cfg } from './config.js';
import { openDb, setting, setSetting, seenOnce, isSeen, log, audit } from './db.js';
import { loadMasterKey } from './crypto.js';
import { importEnvKeys } from './aikeys.js';
import { normalizePhone } from './users.js';
import { attachChannel, startOutbox, stopOutbox, recoverOutbox, drain } from './outbox.js';
import { alert, alertsChannelState } from './alerts.js';
import { handleIncoming } from './router.js';
import { recoverJobs, pump } from './agent.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { MockChannel } from './channels/mock.js';
import { startDailyCheck, stopDailyCheck } from './updates.js';
import { adminPhones } from './users.js';
import { enqueueText } from './outbox.js';
import * as SITES from './sites.js';
import './siteflow.js';

export const STATE_WORDS = {
  connected: 'Paired ✓ Connected', pairing: 'Ready to pair: scan the QR code with the phone', signed_out: "Google wants the phone's Google account signed in once",
  signin_blocked: "Google refused the sign-in from the server's browser",
  phone_offline: 'Phone not reachable', other_tab: 'Open in another browser', error: 'Browser problem', unknown: 'Checking…', starting: 'Starting…', stopped: 'Stopped', not_started: 'Not started',
};
export let channel = null;

export async function createChannel() {
  if (cfg.channel === 'mock' || cfg.channel === 'off') return new MockChannel();
  const { GoogleMessagesWeb } = await import('./channels/gmweb.js');
  return new GoogleMessagesWeb({
    isSeen: (id) => isSeen(id), markSeen: (id) => seenOnce(id),
    needsBaseline: () => setting('gm_baseline_done') !== '1',
    baselineDone: (n) => { setSetting('gm_baseline_done', '1'); audit('system', 'messages.baseline', `${n} existing chat(s) marked as already read`); },
    onSignedOut: () => setSetting('gm_baseline_done', '0'),
  });
}

export function seedFromEnv(env = process.env) {
  if (!setting('admin_phones') && env.MSA_ADMIN_PHONE) {
    const p = env.MSA_ADMIN_PHONE.split(/[,;]+/).map(x => normalizePhone(x)).filter(Boolean).join(',');
    if (p) setSetting('admin_phones', p);
  }
  return importEnvKeys(env);
}

export async function startApp({ channel: given = null, env = process.env, start = true } = {}) {
  loadMasterKey(cfg.dataDir);
  openDb(cfg.testMode && env.MSA_DB_FILE ? env.MSA_DB_FILE : undefined);
  seedFromEnv(env);
  recoverJobs(); recoverOutbox();
  channel = given || await createChannel();
  attachChannel(channel, { onFailed: (m, e) => alert('warn', `A text could not be sent after 3 tries (${m.kind}): ${String(e.message).slice(0, 150)}`, { rcs: false, key: 'send-failed' }) });
  alertsChannelState(() => channel.status().state);
  channel.on('message', (m) => handleIncoming(m).catch(e => log('router', 'failed:', e.message)));
  let dropTimer = null, droppedAlerted = false;
  channel.on('state', ({ state, prev, detail }) => {
    setSetting('gm_state', state); setSetting('gm_state_since', String(Date.now()));
    audit('system', 'messages.state', `${prev} → ${state}${detail ? ' (' + detail + ')' : ''}`);
    if (state === 'connected') {
      clearTimeout(dropTimer); dropTimer = null;
      if (droppedAlerted) { droppedAlerted = false; alert('info', 'Google Messages is connected again. Waiting texts are going out now.', { key: 'gm-back' }); }
      drain();
    } else if (!dropTimer && (prev === 'connected' || state === 'signed_out' || state === 'signin_blocked' || state === 'pairing' || state === 'error')) {
      // a short blip is normal; the admin hears about it if it lasts a minute
      dropTimer = setTimeout(() => {
        dropTimer = null;
        const s = channel.status();
        if (s.state !== 'connected' && s.state !== 'stopped') {
          droppedAlerted = true;
          alert('error', `Google Messages is not connected: ${STATE_WORDS[s.state] || s.state}${s.detail ? ' (' + s.detail + ')' : ''}. Open the dashboard → Connect to fix it.`, { rcs: false, key: 'gm-down-' + s.state });
        }
      }, cfg.testMode ? Number(env.MSA_DROP_ALERT_MS || 200) : 60000);
      dropTimer.unref?.();
    }
  });
  if (start && cfg.channel !== 'off') await channel.start();
  startOutbox(cfg.testMode ? 50 : 3000); startScheduler(cfg.testMode ? 100 : cfg.tickMs); pump();
  // 1.0.2: a once-a-day update check (a badge + one text to the admin; it never installs), site request expiry
  if (!cfg.testMode) startDailyCheck((text) => { for (const p of adminPhones()) enqueueText({ toPhone: p, text, kind: 'admin' }); });
  const siteTimer = setInterval(() => { try { SITES.expire(); SITES.cleanMedia(); } catch (e) { log('sites', 'tidy failed:', e.message); } }, cfg.testMode ? 200 : 5 * 60000); siteTimer.unref?.();
  return { channel, stop: async () => { stopOutbox(); stopScheduler(); stopDailyCheck(); clearInterval(siteTimer); await channel.stop().catch(() => {}); } };
}
