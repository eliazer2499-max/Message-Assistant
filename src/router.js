// Incoming texts → the right place. Duplicate deliveries are dropped (each message id is handled once).
// pending → one "waiting for approval" reply (and an alert to the admin), then silence; blocked → silence;
// approved → commands (HELP, STOP, START, RESET, NOTES, FORGET ALL) or the agent. The admin's own phone is approved
// automatically and can also answer an alert by text: APPROVE 12 / BLOCK 12 / PENDING.
import { run, all, get, setting, seenOnce, audit, log, now } from './db.js';
import { accessEnded } from './users.js';
import { arrive, isAdminPhone, normalizePhone, userById, userByPhone, approve, block, addMessage, addUsage, usageOf, dailyLimit, clearHistory, publicUser } from './users.js';
import { enqueueText } from './outbox.js';
import { enqueueJob } from './agent.js';
import { alert } from './alerts.js';
import { PRODUCT } from './config.js';
import { handleUserText as siteDecision } from './siteflow.js';
import { audioToMp3 } from './audioconv.js';
import * as S from './sites.js';

// 1.1.11: incoming media (a voice note / picture / video / file sent TO the assistant)
const KIND_LABEL = { audio: '[Voice note]', image: '[Photo]', video: '[Video]', pdf: '[PDF file]', file: '[File]' };
const KIND_WORD = { audio: 'voice note', image: 'picture', video: 'video', pdf: 'PDF file', file: 'file' };
const EXT_OF_MIME = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/webm': 'webm', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf' };
const couldNotOpen = (kind) => `\n[The person sent a ${KIND_WORD[kind] || 'file'}, but it could not be opened on this side. Tell them plainly that you could not open it, and ask them to type what it says or send it again.]`;

const HELP = (name) => `${name} tips:\n• Ask anything: "what time does Costco close?", "summarize this link …"\n• Tasks on the web: "check the price of … on …"\n• Reminders: "remind me at 6pm to call mom"\n• NOTES = what I remember about you\n• FORGET ALL = delete those notes\n• RESET = start a fresh conversation\n• STOP = pause me, START = turn me back on`;

export function expiredText() { return String(setting('expired_text') || 'Your access to {name} has ended. Please contact the admin if you would like to keep using it. Thank you!').replace(/\{name\}/g, setting('assistant_name') || PRODUCT); }
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
  // 1.1.11: a message can be ONLY media (a voice note, a picture) — it is not "empty"
  const media = Array.isArray(m.media) ? m.media.filter(x => x && x.data && x.kind) : [];
  if (!text && !media.length && !m.mediaFailed) return { action: 'empty' };
  if (m.extId && !seenOnce('in:' + m.extId)) return { action: 'duplicate' };
  const shownText = text || KIND_LABEL[media[0]?.kind || m.mediaFailed] || '[File]';   // what history / the waiting reply call this message
  const phone = normalizePhone(m.phone) || normalizePhone(m.name);
  const admin = phone && isAdminPhone(phone);
  if (admin) {
    const ex = userByPhone(phone);
    if (!ex) { arrive({ phone, convId: m.convId, name: 'Admin', text: shownText }); }
    const u0 = userByPhone(phone);
    if (u0 && u0.status !== 'approved') approve(u0.id, 'system');
    if (text) {
      // 1.0.2: YES / NO for a site waiting for the admin (or the admin's own publish question)
      const ua = userByPhone(phone);
      if (ua && await siteDecision(ua, text, { isAdmin: true })) { arrive({ phone, convId: m.convId, name: m.name, text }); return { action: 'site_decision' }; }
      const cmd = adminCommand(text);
      if (cmd) { arrive({ phone, convId: m.convId, name: m.name, text }); enqueueText({ userId: userByPhone(phone).id, text: cmd, kind: 'admin' }); return { action: 'admin_command' }; }
    }
  }
  const { user, action, isNew } = arrive({ phone, convId: m.convId, name: m.name, text: shownText });
  if (!user) return { action: 'ignored' };
  if (action === 'wait') {
    enqueueText({ userId: user.id, text: setting('waiting_text'), kind: 'waiting' });
    alert('info', `New person waiting for approval: ${publicUser(user).label} (#${user.id}). First message: "${shownText.slice(0, 120)}". Approve in the dashboard, or reply APPROVE ${user.id} / BLOCK ${user.id}.`, { key: 'new-user-' + user.id });
    return { action, user };
  }
  if (action !== 'run') return { action, user };
  // 1.0.8: access ended (the admin's end date): one polite text, then silence until the admin extends it
  if (accessEnded(user) && !isAdminPhone(user.phone)) {
    if (!user.expired_notice_sent) {
      run('UPDATE users SET expired_notice_sent=1 WHERE id=?', user.id);
      enqueueText({ userId: user.id, text: expiredText(), kind: 'notice' });
      audit('system', 'user.access_ended', `#${user.id}: told once`);
    }
    return { action: 'access_ended', user };
  }
  const word = text.toUpperCase().replace(/[^A-Z ]/g, '').trim();
  // 1.0.2: commands are kept for the person's web chat (not shown to the AI)
  if (['STOP', 'PAUSE', 'START', 'UNPAUSE', 'HELP', 'MENU', 'RESET', 'NEW CHAT', 'NOTES', 'MEMORY', 'FORGET ALL'].includes(word) || /^forget\s+#?\d+$/i.test(text)) addMessage(user.id, 'user_cmd', text, m.extId || null);
  if (word === 'STOP' || word === 'PAUSE') { run('UPDATE users SET paused=1 WHERE id=?', user.id); enqueueText({ userId: user.id, text: 'Paused. I won\'t answer until you text START.', kind: 'notice' }); return { action: 'paused', user }; }
  if (word === 'START' || word === 'UNPAUSE') { run('UPDATE users SET paused=0 WHERE id=?', user.id); enqueueText({ userId: user.id, text: 'I\'m back on. Ask me anything!', kind: 'notice' }); return { action: 'started', user }; }
  if (user.paused) return { action: 'paused_quiet', user };
  if (text && await siteDecision(user, text)) return { action: 'site_decision', user };      // 1.0.2: the one YES for a publish
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
  addMessage(user.id, 'user', shownText, m.extId || null);
  // 1.1.11: keep the media in the media store; the job carries tokens, the agent loads the bytes for the AI
  let jobText = shownText, jobMedia = null;
  if (media.length) {
    jobMedia = [];
    for (const mm of media.slice(0, 4)) {
      try {
        let buf = Buffer.from(mm.data, 'base64');
        if (!buf.length || buf.length > 26 * 1024 * 1024) continue;
        let name = mm.name || '', mime = mm.mime || '';
        // 1.1.20: a voice note is converted to MP3 once, here — the models open mp3 reliably
        // (Gemini refused an m4a as 'corrupted or malformed'); the original is kept when the
        // conversion cannot be done.
        if (mm.kind === 'audio' && mime !== 'audio/mpeg') {
          const mp3 = await audioToMp3(buf).catch(() => null);
          if (mp3 && mp3.length) { buf = mp3; mime = 'audio/mpeg'; name = name ? name.replace(/\.[\p{L}\d]{1,8}$/u, '') + '.mp3' : 'voice-note.mp3'; }
        }
        const ext = (name && /\.([\p{L}\d]{1,8})$/u.exec(name)?.[1]) || EXT_OF_MIME[mime] || 'bin';
        const saved = S.saveMedia(buf, { userId: user.id, ext, name: name || ('attachment.' + ext) });
        jobMedia.push({ token: saved.token, kind: mm.kind, name: name || 'attachment', mime });
      } catch {}
    }
    if (!jobMedia.length) { jobMedia = null; jobText = shownText + couldNotOpen(media[0].kind); }
  } else if (m.mediaFailed) jobText = shownText + couldNotOpen(m.mediaFailed);
  const jobId = enqueueJob(user.id, jobText, jobMedia);
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
