// Incoming texts → the right place. Duplicate deliveries are dropped (each message id is handled once).
// pending → one "waiting for approval" reply (and an alert to the admin), then silence; blocked → silence;
// approved → commands (HELP, STOP, START, RESET, NOTES, FORGET ALL) or the agent. The admin's own phone is approved
// automatically and can also answer an alert by text: APPROVE 12 / BLOCK 12 / PENDING.
import { run, all, get, setting, seenOnce, audit, log, now } from './db.js';
import { arrive, isAdminPhone, normalizePhone, userById, userByPhone, approve, block, addMessage, addUsage, usageOf, dailyLimit, clearHistory, publicUser } from './users.js';
import { enqueueText } from './outbox.js';
import { enqueueJob } from './agent.js';
import { alert } from './alerts.js';
import { PRODUCT } from './config.js';
import { handleUserText as siteDecision } from './siteflow.js';

const HELP = (name) => `${name} tips:\n• Ask anything: "what time does Costco close?", "summarize this link …"\n• Tasks on the web: "check the price of … on …"\n• Reminders: "remind me at 6pm to call mom"\n• NOTES = what I remember about you\n• FORGET ALL = delete those notes\n• RESET = start a fresh conversation\n• STOP = pause me, START = turn me back on`;

export function welcomeText() { return String(setting('welcome_text') || '').replace(/\{name\}/g, setting('assistant_name') || PRODUCT); }

/** Admin approves in the dashboard (or by text): the person hears it right away. */
export function approveAndWelcome(id, actor = 'admin') {
  const before = userById(id);
  const u = approve(id, actor);
  if (before && before.status !== 'approved') enqueueText({ userId: u.id, text: welcomeText(), kind: 'welcome' });
  return u;
}

export async function handleIncoming(m) {
  const text = String(m.text || '').trim();
  if (!text) return { action: 'empty' };
  if (m.extId && !seenOnce('in:' + m.extId)) return { action: 'duplicate' };
  const phone = normalizePhone(m.phone) || normalizePhone(m.name);
  const admin = phone && isAdminPhone(phone);
  if (admin) {
    const ex = userByPhone(phone);
    if (!ex) { arrive({ phone, convId: m.convId, name: 'Admin', text }); }
    const u0 = userByPhone(phone);
    if (u0 && u0.status !== 'approved') approve(u0.id, 'system');
    // 1.0.2: YES / NO for a site waiting for the admin (or the admin's own publish question)
    const ua = userByPhone(phone);
    if (ua && await siteDecision(ua, text, { isAdmin: true })) { arrive({ phone, convId: m.convId, name: m.name, text }); return { action: 'site_decision' }; }
    const cmd = adminCommand(text);
    if (cmd) { arrive({ phone, convId: m.convId, name: m.name, text }); enqueueText({ userId: userByPhone(phone).id, text: cmd, kind: 'admin' }); return { action: 'admin_command' }; }
  }
  const { user, action, isNew } = arrive({ phone, convId: m.convId, name: m.name, text });
  if (!user) return { action: 'ignored' };
  if (action === 'wait') {
    enqueueText({ userId: user.id, text: setting('waiting_text'), kind: 'waiting' });
    alert('info', `New person waiting for approval: ${publicUser(user).label} (#${user.id}). First message: "${text.slice(0, 120)}". Approve in the dashboard, or reply APPROVE ${user.id} / BLOCK ${user.id}.`, { key: 'new-user-' + user.id });
    return { action, user };
  }
  if (action !== 'run') return { action, user };
  const word = text.toUpperCase().replace(/[^A-Z ]/g, '').trim();
  // 1.0.2: commands are kept for the person's web chat (not shown to the AI)
  if (['STOP', 'PAUSE', 'START', 'UNPAUSE', 'HELP', 'MENU', 'RESET', 'NEW CHAT', 'NOTES', 'MEMORY', 'FORGET ALL'].includes(word) || /^forget\s+#?\d+$/i.test(text)) addMessage(user.id, 'user_cmd', text, m.extId || null);
  if (word === 'STOP' || word === 'PAUSE') { run('UPDATE users SET paused=1 WHERE id=?', user.id); enqueueText({ userId: user.id, text: 'Paused. I won\'t answer until you text START.', kind: 'notice' }); return { action: 'paused', user }; }
  if (word === 'START' || word === 'UNPAUSE') { run('UPDATE users SET paused=0 WHERE id=?', user.id); enqueueText({ userId: user.id, text: 'I\'m back on. Ask me anything!', kind: 'notice' }); return { action: 'started', user }; }
  if (user.paused) return { action: 'paused_quiet', user };
  if (await siteDecision(user, text)) return { action: 'site_decision', user };      // 1.0.2: the one YES for a publish
  if (word === 'HELP' || word === 'MENU') { enqueueText({ userId: user.id, text: HELP(setting('assistant_name') || PRODUCT), kind: 'notice' }); return { action: 'help', user }; }
  if (word === 'RESET' || word === 'NEW CHAT') { clearHistory(user.id); enqueueText({ userId: user.id, text: 'Fresh start. Your notes and reminders are kept (text NOTES to see them).', kind: 'notice' }); return { action: 'reset', user }; }
  if (word === 'NOTES' || word === 'MEMORY') {
    const notes = all('SELECT id, fact FROM memory WHERE user_id=? ORDER BY id LIMIT 30', user.id);
    enqueueText({ userId: user.id, text: notes.length ? 'What I remember about you:\n' + notes.map(n => `${n.id}. ${n.fact}`).join('\n') + '\n\nText "forget 3" (any number) or FORGET ALL.' : 'I have no notes about you yet.', kind: 'notice' });
    return { action: 'notes', user };
  }
  if (word === 'FORGET ALL') { const n = run('DELETE FROM memory WHERE user_id=?', user.id).changes; enqueueText({ userId: user.id, text: `Done, I deleted ${n} note(s) about you.`, kind: 'notice' }); return { action: 'forget_all', user }; }
  const f = /^forget\s+#?(\d+)$/i.exec(text);
  if (f) { const n = run('DELETE FROM memory WHERE user_id=? AND id=?', user.id, Number(f[1])).changes; enqueueText({ userId: user.id, text: n ? 'Deleted that note.' : 'I could not find that note (text NOTES to see the numbers).', kind: 'notice' }); return { action: 'forget', user }; }

  addUsage(user.id, 'messages');
  const lim = dailyLimit(user), used = usageOf(user.id).messages;
  if (lim > 0 && used > lim) {
    if (used === lim + 1) enqueueText({ userId: user.id, text: `You've reached today's limit of ${lim} messages. It resets at midnight.`, kind: 'notice' });
    return { action: 'limit', user };
  }
  addMessage(user.id, 'user', text, m.extId || null);
  const jobId = enqueueJob(user.id, text);
  return { action: 'run', user, jobId };
}

/** 1.0.2: a text typed in the person's web chat: exactly like a text from their phone (the answer is texted too). */
export function handleWebText(user, text) {
  return handleIncoming({ phone: user.phone.startsWith('conv:') ? '' : user.phone, convId: user.conv_id || '', name: user.name || '', text, extId: 'web:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) });
}

function adminCommand(text) {
  const t = text.trim();
  let m;
  if (/^pending$/i.test(t)) {
    const rows = all("SELECT id, phone, name, first_text FROM users WHERE status='pending' ORDER BY id LIMIT 20");
    return rows.length ? 'Waiting for approval:\n' + rows.map(r => `#${r.id} ${r.name && r.name !== r.phone ? r.name + ' ' : ''}${r.phone.startsWith('conv:') ? '' : r.phone} — "${String(r.first_text || '').slice(0, 60)}"`).join('\n') + '\nReply APPROVE <#> or BLOCK <#>.' : 'Nobody is waiting.';
  }
  if ((m = /^(approve|block)\s+#?(\+?[\d\s().-]+)$/i.exec(t))) {
    const raw = m[2].trim();
    const u = /^\d{1,6}$/.test(raw) ? userById(Number(raw)) : userByPhone(raw);
    if (!u) return `I can't find #${raw}. Text PENDING for the list.`;
    if (/^approve/i.test(m[1])) { approveAndWelcome(u.id, 'admin (by text)'); return `Approved ${publicUser(u).label}. They got the welcome text.`; }
    block(u.id, 'admin (by text)'); return `Blocked ${publicUser(u).label}.`;
  }
  return null;
}
