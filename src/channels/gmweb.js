// The Google Messages channel: a headless Chromium (Playwright) signed in to messages.google.com/web with the
// assistant's own Google account, paired with the phone that has RCS. ONE browser, ONE page, ONE worker queue:
// every action (read the list, open a chat, send, health check, dashboard screen) waits its turn, so the page is
// never driven twice at once. Reading is gentle: the conversation list is read every few seconds (MSA_POLL_MS,
// default 4 s) with one page.evaluate, and a chat is only opened when its preview changed or it is unread.
//
// Pairing (Google changed this in 2025-26): messages.google.com/web now starts with "Sign in" (a Google account),
// then pairs with the phone (QR code or a confirmation on the phone). Checked live on 2026-11-08: every pairing page
// (/web/authentication, /web/pair, /web/conversations) sends a browser that is not signed in to /web/welcome, which
// only offers "Sign in"; there is no QR without the account any more.
// 1.0.6: Google refused 1.0.4's sign-in because 1.0.4 faked navigator.webdriver with a script; that script is gone.
// The browser now runs VISIBLE on a virtual screen (Xvfb, started here) as a plain program that this driver attaches
// to over a local debugging port, so nothing Playwright adds at launch is on it. Without Xvfb it falls back to 1.0.4's
// headless launch ("basic"). The dashboard shows which one runs: "Browser: full (visible)" or "Browser: basic".
// 1.0.4: Google refuses that sign-in ("This browser or app may not be secure") from Playwright's stripped-down
// "headless shell" whatever user agent it claims, and accepts the full Chromium build running headless with a normal
// Chrome user agent. So the driver always launches the full build (pickBrowser) and, once signed in, goes straight to
// the QR code: it picks "QR code" when the page offers a choice, turns "Remember this computer" on, re-reads the QR
// every few seconds (Google rotates it) and reports "Paired ✓" the moment the chats list appears.
// The dashboard shows this browser live (a picture refreshed every second or two) and passes the admin's taps and
// typing to it, for the one-time Google sign-in. The profile (cookies) is kept in <dataDir>/gm-profile, so it stays
// paired across restarts.
//
// Google's page can change. Every CSS selector lives in SELECTORS below, and <dataDir>/gm-selectors.json (same keys)
// overrides them without a new release.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { cfg } from '../config.js';
import { log } from '../db.js';

export const SELECTORS = {
  convItem: 'mws-conversation-list-item',
  convLink: 'a[href*="/conversations/"]',
  convName: '[data-e2e-conversation-name], .name, h3, h2',
  convSnippet: 'mws-conversation-snippet, [data-e2e-conversation-snippet], .snippet-text',
  convTime: 'mws-relative-timestamp, [data-e2e-conversation-timestamp], .timestamp',
  convUnread: '[data-e2e-is-unread="true"], .unread, [aria-label*="Unread" i]',
  message: 'mws-message-wrapper',
  messageText: '.text-msg-content, [data-e2e-text-message-content], mws-text-message-part, .text-msg',
  messageIdAttr: 'msg-id',
  outgoingAttr: 'is-outgoing',
  // 1.0.7: Google's typing box is now a contenteditable div (older pages: a textarea) — both are found
  composer: '[data-e2e-message-input-box], mws-message-compose [contenteditable=true], textarea[data-e2e-message-input-box], mws-message-compose textarea, textarea.input, textarea',
  // 1.0.7: a message of ours that has not left yet (clock icon / "Sending…") or did not go ("Not sent")
  messageStatus: '[data-e2e-message-status], mws-message-status, mws-message-status-indicator, .msg-status, [class*="status" i]',
  messageIcon: 'mat-icon, .material-icons, .material-symbols-outlined, .google-symbols',
  sendButton: '[data-e2e-send-text-button], mws-message-send-button button, button[aria-label^="Send" i]',
  newChatInput: 'input[data-e2e-contact-input], mw-contact-chips-input input, input[type="text"]',
  newChatPick: 'mw-contact-selector-button button, [data-e2e-send-to-button], button[aria-label*="Send to" i]',
  qr: 'mw-qr-code img, mw-qr-code canvas, mw-qr-code, img[alt*="QR" i], canvas[aria-label*="QR" i]',
  useHere: 'button:has-text("Use here"), button:has-text("Use Here")',
  rememberToggle: 'mat-slide-toggle input, [role="switch"]',
  // 1.0.4: the QR page. "Pair with QR code" when Google offers it next to pairing with the Google account; the
  // refresh button when a QR code has run out; the welcome page's "Sign in" button.
  qrChoice: 'button:has-text("QR code"), a:has-text("QR code"), [role="tab"]:has-text("QR"), [role="button"]:has-text("QR code"), [role="radio"]:has-text("QR")',
  qrRefresh: 'mw-qr-code button, button:has-text("Refresh"), button:has-text("Generate new"), button:has-text("Try again"), button:has-text("Retry")',
  signInButton: 'button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Sign In")',
  // 1.0.2: pictures. A file box if the page has one, else the attach button's file chooser.
  attachInput: 'mws-message-compose input[type="file"], input[type="file"][accept*="image" i], input[type="file"]',
  attachButton: '[data-e2e-picker-button="ATTACHMENT"], button[aria-label*="Attach" i], button[aria-label*="Add media" i], button[aria-label*="file" i]',
};
export const TEXTS = {
  otherTab: /(open|opened|active) in (another|a different|other) (window|tab|browser)|use (messages )?here/i,
  phoneOff: /trying to (reach|connect to) (your )?phone|phone (is |isn't |is not )?(offline|not connected|disconnected)|check (your )?phone'?s? (connection|internet)|can'?t (reach|connect to) (your )?phone|reconnecting to (your )?phone/i,
  pairing: /scan (this|the) (qr )?code|pair with qr|pair your (phone|device)|device pairing|use your phone to scan|pair(ing)? (this )?(computer|browser)/i,
  signedOut: /^\s*sign in\b|welcome to google messages|sign in to (continue|messages)/im,
  signinBlocked: /this browser or app may not be secure|couldn.t sign you in/i,
};

/** 1.0.4: which Chromium to start. Never the "headless shell" when the full build is there (Google refuses sign-in
 *  from the shell). configured = MSA_CHROMIUM; browsersPath = PLAYWRIGHT_BROWSERS_PATH (the installer's folder). */
export function isHeadlessShell(p) { return /headless[_-]?shell/i.test(String(p || '')); }
export function findFullChromium(root = process.env.PLAYWRIGHT_BROWSERS_PATH) {
  if (!root) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))); } catch { return null; }
  for (const d of dirs) for (const sub of ['chrome-linux64', 'chrome-linux', 'chrome-mac/Chromium.app/Contents/MacOS']) {
    const p = path.join(root, d, sub, sub.startsWith('chrome-mac') ? 'Chromium' : 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
export function pickBrowser({ configured = '', browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH } = {}) {
  const full = findFullChromium(browsersPath);
  if (configured && !isHeadlessShell(configured)) return { executablePath: configured, kind: 'full', why: 'MSA_CHROMIUM' };
  if (full) return { executablePath: full, kind: 'full', why: configured ? 'MSA_CHROMIUM is the headless shell; using the full build next to it' : 'the installed full build' };
  if (configured) return { executablePath: configured, kind: 'shell', why: 'MSA_CHROMIUM (headless shell; Google may refuse the sign-in)' };
  return { channel: 'chromium', kind: 'full', why: "Playwright's full Chromium" };
}
/** A normal Chrome user agent: no "HeadlessChrome", and the reduced version Chrome itself sends (153.0.0.0). */
export function normalUserAgent(ua) {
  return String(ua || '').replace(/HeadlessChrome/g, 'Chrome').replace(/Chrome\/(\d+)\.\d+\.\d+\.\d+/, 'Chrome/$1.0.0.0');
}
const VIEW = { width: 1100, height: 800 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** 1.0.6: the virtual screen. MSA_XVFB names it; else the usual places (the installer puts it in /usr/bin). */
export function findXvfb(env = process.env) {
  for (const p of [env.MSA_XVFB, '/usr/bin/Xvfb', '/usr/local/bin/Xvfb', '/bin/Xvfb']) if (p && fs.existsSync(p)) return p;
  return null;
}
/** 1.0.6: "visible" = the full build on a virtual screen (what Google accepts); "basic" = headless (1.0.4's way). */
export function chooseMode({ wanted = '', kind = 'full', xvfb = null, display = '' } = {}) {
  wanted = String(wanted || 'auto').toLowerCase();
  if (wanted === 'basic' || wanted === 'headless') return { mode: 'basic', why: 'MSA_BROWSER_MODE=' + wanted };
  if (kind === 'shell') return { mode: 'basic', why: 'only the headless shell is installed (Update now installs the full one)' };
  if (display) return { mode: 'visible', display, why: 'screen ' + display + ' (MSA_DISPLAY)' };
  if (xvfb) return { mode: 'visible', xvfb, why: 'virtual screen' };
  return { mode: 'basic', why: 'no virtual screen (Xvfb) on this server; Update now installs it' };
}
const SCREEN = { width: 1280, height: 1024 };

/** 1.0.7: a tap on the picture (x, y as 0..1 of the picture) → the spot in the page. The picture is the page's
 *  visible area, so the same fractions of the page's size; anything outside is pulled to the edge. */
export function tapToPage(b, V) {
  const f = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5; };
  return { x: Math.min(V.width - 1, f(b.x) * V.width), y: Math.min(V.height - 1, f(b.y) * V.height) };
}
const EDITABLE = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=file]):not([type=range]):not([type=color]),textarea,[contenteditable=""],[contenteditable="true"]';
/** In the page: the text box that has the focus now (a password box is named, its letters never read). */
export const focusScript = new Function(`const a = document.activeElement;
  const ok = a && a !== document.body && a.matches(${JSON.stringify(EDITABLE)}) && !a.disabled && !a.readOnly;
  return ok ? { editable: true, kind: a.type === 'password' ? 'password' : a.type === 'email' ? 'email' : a.type === 'tel' || a.type === 'number' ? 'number' : 'text' } : { editable: false };`);
/** In the page: the visible text boxes as [x, y, w, h] fractions of the page, with their kind. */
export const fieldsScript = new Function(`const W = innerWidth, H = innerHeight, out = [];
  for (const e of document.querySelectorAll(${JSON.stringify(EDITABLE)})) {
    if (e.disabled || e.readOnly) continue; const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue;
    const st = getComputedStyle(e); if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
    out.push({ x: +(r.left / W).toFixed(4), y: +(r.top / H).toFixed(4), w: +(r.width / W).toFixed(4), h: +(r.height / H).toFixed(4), kind: e.type === 'password' ? 'password' : e.type === 'email' ? 'email' : 'text' });
    if (out.length >= 20) break;
  }
  return out;`);
/** 1.0.7: mark the profile as closed normally, so the browser never brings back old tabs after a hard stop. */
export function markCleanExit(profileDir) {
  const f = path.join(profileDir, 'Default', 'Preferences');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.profile = j.profile || {};
    if (j.profile.exit_type === 'Normal' && j.profile.exited_cleanly === true) return false;
    j.profile.exit_type = 'Normal'; j.profile.exited_cleanly = true; fs.writeFileSync(f, JSON.stringify(j)); return true;
  } catch { return false; }
}
/** The visible browser's command line: a normal browser with a local debugging port, nothing Playwright adds. */
export function visibleArgs(profileDir, extra = [], port = 0) {
  return [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage', '--hide-crash-restore-bubble',
    `--window-size=${VIEW.width},${VIEW.height + 140}`, '--window-position=0,0', '--lang=en-US', '--mute-audio', ...extra, 'about:blank'];
}
/** A free local port (the browser is given a fixed one: with port 0 it reports itself as automated). */
export function freePort() {
  return new Promise((res, rej) => { const srv = net.createServer(); srv.unref(); srv.on('error', rej); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); }); });
}
/** The port the browser writes into <profile>/DevToolsActivePort once it is listening. */
export async function waitDevToolsPort(profileDir, child, ms = 30000, given = 0) {
  const f = path.join(profileDir, 'DevToolsActivePort'); const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) return null;
    if (given) { try { const r = await fetch(`http://127.0.0.1:${given}/json/version`, { signal: AbortSignal.timeout(1000) }); if (r.ok) return given; } catch {} }
    else try { const port = Number(fs.readFileSync(f, 'utf8').split('\n')[0]); if (port > 0) return port; } catch {}
    await sleep(150);
  }
  return null;
}
const PRIO = { send: 0, input: 1, screen: 2, health: 3, poll: 4 };

export function loadSelectors(dataDir = cfg.dataDir) {
  try { const o = JSON.parse(fs.readFileSync(path.join(dataDir, 'gm-selectors.json'), 'utf8')); return { ...SELECTORS, ...o }; } catch { return { ...SELECTORS }; }
}
/**
 * 1.0.8: is the time Google shows next to a chat in the list ("Now", "5 min", "10:31 PM", "Mon", "Oct 29", "10/29/25")
 * older than `cutoff` (ms)? Unknown words count as not old (so a real new text is never dropped by a word we can't read).
 */
export function listTimeIsOld(label, cutoff, nowMs = Date.now()) {
  const t = String(label || '').trim().toLowerCase();
  if (!t || /^(now|just now)$/.test(t)) return false;
  const min = /^(\d+)\s*(m|min|mins|minutes?)$/.exec(t); if (min) return nowMs - parseInt(min[1], 10) * 60000 < cutoff;
  const hr = /^(\d+)\s*(h|hr|hrs|hours?)$/.exec(t); if (hr) return nowMs - parseInt(hr[1], 10) * 3600000 < cutoff;
  const clock = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/.exec(t.replace(/\u202f/g, ' '));
  if (clock) {
    let h = parseInt(clock[1], 10) % 12; if (clock[3] === 'pm') h += 12; if (!clock[3]) h = parseInt(clock[1], 10);
    const d = new Date(nowMs); d.setHours(h, parseInt(clock[2], 10), 0, 0);
    let ts = d.getTime(); if (ts > nowMs + 60000) ts -= 86400000;     // a later clock time is yesterday's
    return ts < cutoff;
  }
  if (/^yesterday$/.test(t)) return true;
  if (/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/.test(t)) return true;          // this week, not today
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(,?\s+\d{4})?$/.test(t)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)) return true;
  return false;
}
/** 1.0.7: our newest outgoing bubble that was not there before (and carries this text, when we know it). */
export function normText(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
export function sameText(shown, want) {
  const a = normText(shown); if (!want) return true; if (!a) return false;
  return a === want || a.startsWith(want.slice(0, 60)) || want.startsWith(a.slice(0, 60));
}
export function newOutgoing(msgs, before, part) {
  const want = part == null ? '' : normText(part);
  const outs = msgs.filter(m => m.outgoing);
  for (let i = outs.length - 1; i >= 0; i--) {
    const m = outs[i];
    const isNew = m.id ? !before.ids.has(m.id) : i >= before.n;
    if (isNew && sameText(m.text, want)) return m;
  }
  return null;
}
/** Split a long reply into chat-sized parts (on paragraph / line / sentence ends where possible). */
export function splitText(text, max = 1500) {
  const out = []; let s = String(text || '').trim();
  while (s.length > max) {
    let cut = s.lastIndexOf('\n\n', max); if (cut < max * 0.5) cut = s.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = s.lastIndexOf('. ', max) + 1; if (cut < max * 0.5) cut = s.lastIndexOf(' ', max);
    if (cut < max * 0.3) cut = max;
    out.push(s.slice(0, cut).trim()); s = s.slice(cut).trim();
  }
  if (s) out.push(s);
  return out;
}

/** What the page shows, read in ONE evaluate (runs inside the page). */
function snapshotScript(sel) {
  const q = (root, s) => { try { return root.querySelector(s); } catch { return null; } };
  const qa = (root, s) => { try { return [...root.querySelectorAll(s)]; } catch { return []; } };
  const txt = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
  const items = qa(document, sel.convItem);
  const links = items.length ? items : qa(document, sel.convLink).map(a => a.closest('[role="option"], li, div') || a);
  const convs = [];
  for (const it of links.slice(0, 40)) {
    const a = it.matches && it.matches(sel.convLink) ? it : q(it, sel.convLink);
    const href = a ? a.getAttribute('href') || '' : '';
    const m = /\/conversations\/([^/?#]+)/.exec(href); if (!m || m[1] === 'new') continue;
    const nameEl = q(it, sel.convName);
    convs.push({ id: decodeURIComponent(m[1]), name: txt(nameEl), snippet: txt(q(it, sel.convSnippet)).slice(0, 300), time: txt(q(it, sel.convTime)),
      unread: !!(q(it, sel.convUnread) || (it.matches && it.matches(sel.convUnread)) || (a && a.getAttribute('data-e2e-is-unread') === 'true')) });
  }
  // 1.0.7: 'pending' (clock / Sending…), 'failed' (Not sent / error), else '' = shown as sent
  function sendStatus(w) {
    const id = w.getAttribute(sel.messageIdAttr) || '';
    const te = q(w, sel.messageText), body = te ? (te.innerText || te.textContent || '').trim() : '';
    const inText = (e) => !!te && (te === e || te.contains(e));
    // the words of the message itself never count ("I'm sending it now" is not a pending message)
    const clean = (v) => { v = String(v || ''); return body ? v.split(body).join(' ') : v; };
    const bits = [w.getAttribute('data-e2e-message-status'), w.className];
    for (const e of qa(w, sel.messageStatus)) if (!inText(e)) bits.push(e.getAttribute('data-e2e-message-status'), e.getAttribute('aria-label'), e.getAttribute('class'), (e.innerText || e.textContent || '').slice(0, 80));
    for (const e of qa(w, '[aria-label]')) if (!inText(e)) bits.push(e.getAttribute('aria-label'));
    const icons = qa(w, sel.messageIcon).filter(e => !inText(e)).map(e => (e.textContent || '').trim().toLowerCase());
    const all = bits.map(clean).join(' | ').toLowerCase();
    if (/not sent|not delivered|failed|send error|retry|\berror\b/.test(all) || icons.some(t => /^(error|error_outline|warning|sms_failed)$/.test(t))) return 'failed';
    if (/^tmp|^pending/i.test(id) || /sending|pending|queued|waiting to send|\bclock\b/.test(all) || icons.some(t => /^(schedule|access_time|pending|hourglass_empty|hourglass_top|watch_later)$/.test(t))) return 'pending';
    return '';
  }
  const msgs = qa(document, sel.message).slice(-40).map((w, i) => {
    const out = w.getAttribute(sel.outgoingAttr);
    const textEl = q(w, sel.messageText);
    const outgoing = out === 'true' || (out === null && /outgoing/.test(w.className || ''));
    return { id: w.getAttribute(sel.messageIdAttr) || '', outgoing, text: textEl ? (textEl.innerText || textEl.textContent || '').trim() : '', status: outgoing ? sendStatus(w) : '' };
  });
  const cur = /\/conversations\/([^/?#]+)/.exec(location.pathname);
  return { url: location.href, title: document.title, body: (document.body ? document.body.innerText : '').slice(0, 3000), convs, msgs,
    current: cur ? decodeURIComponent(cur[1]) : null, hasQr: !!q(document, sel.qr), hasComposer: !!q(document, sel.composer) };
}

export function classifyPage(snap, sel = SELECTORS) {
  const url = String(snap.url || '');
  const body = String(snap.body || '');
  if (/accounts\.google\.com\/.*signin\/rejected/.test(url) || (/accounts\.google\.com/.test(url) && TEXTS.signinBlocked.test(body))) return { state: 'signin_blocked', detail: 'Google refused the sign-in from this browser' };
  if (/accounts\.google\.com/.test(url)) return { state: 'signed_out', detail: 'Google sign-in page' };
  if (TEXTS.otherTab.test(body) && !snap.convs.length) return { state: 'other_tab', detail: 'Messages is open somewhere else' };
  if (/\/web\/(authentication|pair)/.test(url) || snap.hasQr || (TEXTS.pairing.test(body) && !snap.convs.length)) return { state: 'pairing', detail: 'waiting for the phone to pair' };
  if (/\/web\/welcome/.test(url) || (TEXTS.signedOut.test(body) && !snap.convs.length)) return { state: 'signed_out', detail: 'not signed in' };
  if (TEXTS.phoneOff.test(body)) return { state: 'phone_offline', detail: 'the phone is not reachable' };
  if (/\/web\/conversations/.test(url) || snap.convs.length) return { state: 'connected', detail: '' };
  return { state: 'unknown', detail: (snap.title || '').slice(0, 80) };
}

/** Message id: the page's own msg-id when it has one, else a hash of chat + text + how many identical texts came before. */
export function messageKeys(convId, msgs) {
  const count = new Map();
  return msgs.map(m => {
    if (m.id) return 'gm:' + m.id;
    const base = convId + '|' + (m.outgoing ? 'o' : 'i') + '|' + m.text;
    const n = (count.get(base) || 0) + 1; count.set(base, n);
    return 'gmh:' + crypto.createHash('sha256').update(base + '|' + n).digest('hex').slice(0, 24);
  });
}

export class GoogleMessagesWeb extends EventEmitter {
  /**
   * opts.isSeen(id) / opts.markSeen(id): the message-id store (the database); opts.baseline: true when no chat has
   * been read before (the first pairing): what is already there is marked read, not answered.
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.dataDir = opts.dataDir || cfg.dataDir;
    this.profileDir = path.join(this.dataDir, 'gm-profile');
    this.sel = loadSelectors(this.dataDir);
    this.state = 'stopped'; this.since = Date.now(); this.detail = '';
    this.queue = []; this.running = false; this.ctx = null; this.page = null;
    this.sigs = new Map();          // convId → "snippet|time" last seen
    this.stale = new Map();         // 1.0.8: convId → sig of a chat left alone as history (its last message is older than this start)
    this.startedAt = Date.now();
    this.wasStale = new Map();      // 1.0.8: convId → the old last-message snippet of a chat that was left alone (only newer texts count)
    this.opened = new Set();        // chats read at least once since start
    this.lastSent = new Map();      // convId → last text we sent (our own message is not "new")
    this.timers = []; this.stopped = true; this.launchFails = 0; this.unknownSince = 0; this.lastUseHere = 0;
    this.pollMs = opts.pollMs || cfg.pollMs; this.healthMs = opts.healthMs || cfg.healthMs;
    this.qrMs = opts.qrMs || Number(process.env.MSA_QR_MS) || 3000;   // 1.0.4: while pairing, the QR is re-read this often
    this.qrData = null; this.qrAt = 0; this.pairedAt = 0; this.browser = null;
    this.url = opts.url || cfg.gmUrl;
  }

  // ---------- lifecycle ----------
  async start() {
    this.stopped = false;
    await this.ensureBrowser().catch(e => this.setState('error', 'browser did not start: ' + e.message));
    const quiet = (what) => (e) => { if (!this.stopped) log('gm', what, 'failed:', String(e.message).slice(0, 200)); };
    this.timers.push(setInterval(() => this.enqueue('health', () => this.health(), { dedupe: true, noEnsure: true }).catch(quiet('health')), this.healthMs));
    this.timers.push(setInterval(() => { if (this.state === 'connected') this.enqueue('poll', () => this.poll(), { dedupe: true }).catch(quiet('poll')); }, this.pollMs));
    // 1.0.4: while the QR code is up, look every few seconds: Google rotates the code, and "Paired ✓" should show at once
    this.timers.push(setInterval(() => { if (this.state === 'pairing') this.enqueue('health', () => this.health(), { dedupe: true, noEnsure: true }).catch(quiet('pairing check')); }, this.qrMs));
    this.enqueue('health', () => this.health(), { dedupe: true, noEnsure: true }).catch(quiet('health'));
  }
  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t); this.timers = [];
    for (const j of this.queue.splice(0)) j.reject(new Error('stopped'));
    await this.closeBrowser(); this.stopXvfb();
    this.setState('stopped');
  }
  async playwright() {
    if (this.opts.playwright) return this.opts.playwright;
    const mod = await import(process.env.MSA_PLAYWRIGHT_PATH || 'playwright-core');
    return mod.chromium ? mod : mod.default;
  }
  async ensureBrowser() {
    if (this.ctx && this.page && !this.page.isClosed() && (!this.proc || this.proc.exitCode === null)) return;
    await this.closeBrowser();
    const pw = await this.playwright();
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) { try { fs.rmSync(path.join(this.profileDir, f), { force: true }); } catch {} }
    // 1.0.4: the full Chromium build (pickBrowser), never the headless shell Google refuses to sign in from
    this.browser = this.opts.launch?.executablePath ? { executablePath: this.opts.launch.executablePath, kind: isHeadlessShell(this.opts.launch.executablePath) ? 'shell' : 'full', why: 'test' }
      : pickBrowser({ configured: cfg.chromium });
    // 1.0.6: the full build, VISIBLE on a virtual screen, started as a plain program and attached to afterwards.
    // Checked live on 2026-11-09 with made-up addresses: Google now refuses every browser Playwright starts itself
    // (headless or visible) and a plain one started headless; it accepts the plain one started visible.
    const mode = chooseMode({ wanted: this.opts.mode || cfg.browserMode, kind: this.browser.kind, exe: this.browser.executablePath, xvfb: findXvfb(), display: process.env.MSA_DISPLAY || '' });
    this.browserMode = mode.mode; this.browserWhy = mode.why; this.display = null;
    if (mode.mode === 'visible') {
      try { await this.launchVisible(pw, mode); }
      catch (e) {
        log('gm', 'visible browser did not start (' + String(e.message).split('\n')[0].slice(0, 160) + '); using the basic one');
        await this.closeBrowser(); this.browserMode = 'basic'; this.browserWhy = 'the visible browser did not start: ' + String(e.message).split('\n')[0].slice(0, 120);
      }
    }
    if (this.browserMode !== 'visible') await this.launchBasic(pw);
    const label = this.browserLabel();
    if (this.loggedBrowser !== label) { this.loggedBrowser = label; log('gm', `browser: ${this.browserMode === 'visible' ? 'full Chromium, visible on a virtual screen' : this.browser.kind === 'full' ? 'full Chromium, headless' : 'headless shell'} (${this.browser.why}; ${this.browserWhy})`); }
    this.page.on('crash', () => { log('gm', 'page crashed'); this.page = null; });
    this.watchPage(this.page);
    this.page.setDefaultTimeout(20000);
    await this.page.goto(this.url + '/conversations', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log('gm', 'open failed:', e.message));
    await sleep(this.opts.settleMs ?? 2500);
    this.launchFails = 0;
  }
  /** 1.0.6: Xvfb (a virtual screen) + the browser as a normal program with a local debugging port, then attach. */
  async launchVisible(pw, mode) {
    this.display = mode.display || await this.startXvfb(mode.xvfb);
    const exe = this.browser.executablePath || pw.chromium.executablePath();
    const given = await freePort();
    markCleanExit(this.profileDir);   // 1.0.7
    const args = visibleArgs(this.profileDir, this.opts.extraArgs || [], given);
    const env = { ...process.env, DISPLAY: this.display };
    const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
    this.proc = child; let errTail = '';
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-600); });
    child.on('exit', (code, sig) => { if (this.proc === child) { this.proc = null; this.page = null; if (!this.stopped && !this.closing) log('gm', `browser closed (${sig || code})`); } });
    const port = await waitDevToolsPort(this.profileDir, child, this.opts.launchTimeoutMs ?? 30000, given);
    if (!port) throw new Error('the browser did not open its local port' + (errTail ? ': ' + errTail.replace(/\s+/g, ' ').slice(-160) : ''));
    this.cdp = await pw.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30000 });
    this.cdp.on('disconnected', () => { this.ctx = null; this.page = null; });
    this.ctx = this.cdp.contexts()[0];
    this.page = this.ctx.pages().find(p => !p.url().startsWith('devtools')) || await this.ctx.newPage();
    // 1.0.7: one tab only (old tabs a browser restored would be what the taps go to, not what the picture shows)
    for (const q of this.ctx.pages()) if (q !== this.page && !q.url().startsWith('devtools')) await q.close().catch(() => {});
    // a visible browser already has the normal Chrome name and no webdriver flag; never fake it (Google sees a fake)
    this.webdriver = await this.page.evaluate(() => navigator.webdriver).catch(() => null);
    if (this.webdriver) log('gm', 'note: the browser reports itself as automated (navigator.webdriver); Google may refuse the sign-in');
    this.ua = await this.page.evaluate(() => navigator.userAgent).catch(() => null);
  }
  async startXvfb(bin) {
    if (this.xvfb && this.xvfb.exitCode === null && this.xvfbDisplay) return this.xvfbDisplay;
    try { fs.mkdirSync('/tmp/.X11-unix', { recursive: true, mode: 0o1777 }); } catch {}
    const child = spawn(bin, ['-displayfd', '3', '-screen', '0', `${SCREEN.width}x${SCREEN.height}x24`, '-nolisten', 'tcp', '-ac'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', d => { err = (err + d).slice(-400); });
    const n = await new Promise((res) => {
      let buf = ''; const t = setTimeout(() => res(null), 10000);
      child.stdio[3].on('data', d => { buf += d; const m = /(\d+)\s*\n/.exec(buf); if (m) { clearTimeout(t); res(m[1]); } });
      child.on('exit', () => { clearTimeout(t); res(null); });
    });
    if (!n) { try { child.kill('SIGKILL'); } catch {} throw new Error('the virtual screen did not start' + (err ? ': ' + err.replace(/\s+/g, ' ').slice(-140) : '')); }
    this.xvfb = child; this.xvfbDisplay = ':' + n;
    child.on('exit', () => { if (this.xvfb === child) { this.xvfb = null; this.xvfbDisplay = null; this.page = null; } });
    log('gm', 'virtual screen ' + this.xvfbDisplay + ' started');
    return this.xvfbDisplay;
  }
  /** The 1.0.4 way: Playwright starts the browser headless (kept for servers without the virtual screen). */
  async launchBasic(pw) {
    const launch = {
      headless: true, viewport: VIEW, locale: 'en-US',
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--lang=en-US'],
      ...(this.browser.executablePath ? { executablePath: this.browser.executablePath } : { channel: this.browser.channel }),
      ...(this.opts.launch || {}),
    };
    if (this.ua) launch.userAgent = normalUserAgent(this.ua);
    try { this.ctx = await pw.chromium.launchPersistentContext(this.profileDir, launch); }
    catch (e) {
      if (!launch.channel) throw e;
      // no full build where Playwright looks: fall back to its default (the shell) rather than not starting at all
      log('gm', 'full Chromium did not start (' + String(e.message).split('\n')[0].slice(0, 120) + '); using the default browser');
      delete launch.channel; this.browser = { kind: 'shell', why: 'fallback: the full build is not installed' };
      this.ctx = await pw.chromium.launchPersistentContext(this.profileDir, launch);
    }
    this.page = this.ctx.pages()[0] || await this.ctx.newPage();
    if (!launch.userAgent) {
      // headless Chromium calls itself "HeadlessChrome"; Google gets the normal Chrome name instead
      const ua = await this.page.evaluate(() => navigator.userAgent).catch(() => '');
      const normal = normalUserAgent(ua);
      if (ua && normal !== ua) {
        this.ua = normal;
        await this.ctx.close().catch(() => {});
        this.ctx = await pw.chromium.launchPersistentContext(this.profileDir, { ...launch, userAgent: this.ua });
        this.page = this.ctx.pages()[0] || await this.ctx.newPage();
      } else this.ua = ua || null;
    }
    // 1.0.6: NO script that rewrites navigator.webdriver. 1.0.4 added one, and Google refuses the sign-in when the flag
    // is faked (checked live 2026-11-09: same browser, same address, refused with it and accepted without it). The flag
    // is already false natively (--disable-blink-features=AutomationControlled).
    this.ctx.on('close', () => { this.ctx = null; this.page = null; });
  }
  /** "full (visible)" or "basic" — the words on the Connect page and in Settings. */
  browserLabel() { return this.browserMode === 'visible' ? 'full (visible)' : this.browserMode === 'basic' ? 'basic' : null; }
  browserInfo() {
    if (!this.browserMode) return null;
    const ver = /Chrome\/(\d+)/.exec(this.ua || '')?.[1];
    return { mode: this.browserMode, label: this.browserLabel(), build: this.browser?.kind || null, version: ver || null, screen: this.browserMode === 'visible' ? (this.display || null) : null, automatedFlag: this.webdriver ?? null, why: this.browserWhy || '' };
  }
  async closeBrowser() {
    const c = this.ctx, b = this.cdp, p = this.proc; this.ctx = null; this.page = null; this.cdp = null; this.proc = null;
    this.closing = true;
    try {
      if (b) {
        // the visible browser: ask it to close (it saves the profile), then make sure it is gone
        try { const s = await b.newBrowserCDPSession(); await Promise.race([s.send('Browser.close'), sleep(3000)]); } catch {}
        await b.close().catch(() => {});
      } else if (c) await c.close().catch(() => {});
      if (p && p.exitCode === null) {
        await Promise.race([new Promise(r => p.once('exit', r)), sleep(5000)]);
        if (p.exitCode === null && p.signalCode === null) { try { p.kill('SIGKILL'); } catch {} await Promise.race([new Promise(r => p.once('exit', r)), sleep(2000)]); }
      }
    } finally { this.closing = false; }
  }
  stopXvfb() { const x = this.xvfb; this.xvfb = null; this.xvfbDisplay = null; if (x && x.exitCode === null) { try { x.kill('SIGTERM'); } catch {} } }
  async restart() { return this.enqueue('input', async () => { await this.closeBrowser(); this.stopXvfb(); await this.ensureBrowser(); await this.health(); return { ok: true }; }, { noEnsure: true }); }
  /** Forget the Google sign-in and pairing (a fresh profile). */
  async signOut() {
    return this.enqueue('input', async () => {
      await this.closeBrowser();
      fs.rmSync(this.profileDir, { recursive: true, force: true });
      this.sigs.clear(); this.opened.clear();
      this.opts.onSignedOut?.();
      await this.ensureBrowser(); await this.health(); return { ok: true };
    }, { noEnsure: true });
  }

  // ---------- the one worker queue ----------
  enqueue(kind, fn, { dedupe = false, noEnsure = false } = {}) {
    if (dedupe) { const same = this.queue.find(j => j.kind === kind); if (same) return same.promise; }
    let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
    this.queue.push({ kind, fn, resolve, reject, promise, noEnsure, prio: PRIO[kind] ?? 5, at: Date.now() });
    this.queue.sort((a, b) => a.prio - b.prio || a.at - b.at);
    this.pump();
    return promise;
  }
  async pump() {
    if (this.running) return; this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const j = this.queue.shift();
        try {
          if (!j.noEnsure) await this.ensureBrowser();
          j.resolve(await j.fn());
        } catch (e) {
          if (/Target (page, context or browser )?(has been )?closed|browser has disconnected|crash/i.test(String(e.message))) { this.page = null; }
          j.reject(e);
        }
      }
    } finally { this.running = false; }
  }

  // ---------- state ----------
  setState(state, detail = '') {
    const prev = this.state;
    if (prev === state && detail === this.detail) return;
    if (prev !== state) this.since = Date.now();
    if (state === 'connected' && prev !== 'connected' && ['pairing', 'signed_out', 'signin_blocked'].includes(prev)) this.pairedAt = Date.now();
    if (state !== 'pairing') { this.qrData = null; this.qrAt = 0; }
    this.state = state; this.detail = detail;
    if (prev !== state) { log('gm', `state ${prev} → ${state}${detail ? ' (' + detail + ')' : ''}`); this.emit('state', { state, prev, detail }); }
  }
  status() {
    return { state: this.state, since: this.since, detail: this.detail, qr: this.qrData || null, qrAt: this.qrAt || null, pairedAt: this.pairedAt || null,
      browser: this.browser ? this.browser.kind : null, browserInfo: this.browserInfo(), driver: 'google-messages-web', queue: this.queue.length };
  }
  async snap() { return this.page.evaluate(snapshotScript, this.sel); }

  async health() {
    if (this.stopped) return;
    try { await this.ensureBrowser(); }
    catch (e) { this.launchFails++; this.setState('error', 'browser did not start: ' + String(e.message).slice(0, 160)); return; }
    let s;
    try { s = await this.snap(); }
    catch (e) {
      // 1.0.4: the page was just moving (e.g. to the chats right after the QR scan): look again instead of restarting
      if (/context was destroyed|navigat|Target page.*closed/i.test(String(e.message)) && this.page && !this.page.isClosed()) {
        await this.page.waitForLoadState('domcontentloaded').catch(() => {}); await sleep(800);
        try { s = await this.snap(); } catch {}
      }
      if (!s) { this.setState('error', 'page not readable: ' + String(e.message).slice(0, 120)); await this.closeBrowser(); return; }
    }
    const c = classifyPage(s, this.sel);
    if (c.state === 'other_tab' && Date.now() - this.lastUseHere > 5 * 60000) {
      this.lastUseHere = Date.now();
      try { await this.page.locator(this.sel.useHere).first().click({ timeout: 5000 }); log('gm', 'pressed "Use here"'); await sleep(2000); return this.health(); } catch {}
    }
    if (c.state === 'pairing') { await this.straightToQr(s); await this.readQr(); } else { this.qrData = null; this.qrAt = 0; }
    if (c.state === 'unknown') {
      if (!this.unknownSince) this.unknownSince = Date.now();
      if (Date.now() - this.unknownSince > 3 * 60000) { log('gm', 'page unclear for 3 min; reloading'); this.unknownSince = 0; await this.page.goto(this.url + '/conversations', { waitUntil: 'domcontentloaded' }).catch(() => {}); }
      return;
    }
    this.unknownSince = 0;
    if (c.state === 'connected' && !/\/conversations/.test(s.url)) await this.page.goto(this.url + '/conversations', { waitUntil: 'domcontentloaded' }).catch(() => {});
    this.setState(c.state, c.detail);
    if (c.state === 'connected') await this.poll(s);
  }
  async readQr() {
    try {
      // the most specific match that has a size (the picture itself before its wrapper; a custom element can be 0×0)
      let el = null;
      for (const part of this.sel.qr.split(',').map(x => x.trim()).filter(Boolean)) {
        const c = this.page.locator(part).first();
        if (await c.count()) { const bb = await c.boundingBox().catch(() => null); if (bb && bb.width >= 20 && bb.height >= 20) { el = c; break; } }
      }
      if (!el) { const c = this.page.locator(this.sel.qr).first(); if (await c.count()) el = c; }
      if (el) {
        const png = await el.screenshot({ type: 'png', timeout: 5000 });
        const data = 'data:image/png;base64,' + png.toString('base64');
        if (data !== this.qrData) { this.qrData = data; this.qrAt = Date.now(); }
      } else { this.qrData = null; this.qrAt = 0; }
    } catch { /* the live screen still shows it */ }
  }
  /** 1.0.4: on the pairing page, get the QR code up without anyone tapping: pick "QR code" when Google offers it next
   *  to pairing with the Google account, press refresh when a code ran out, and keep "Remember this computer" on. */
  async straightToQr(s) {
    const p = this.page; const click = async (selector) => { const el = p.locator(selector).first(); if (await el.count() && await el.isVisible().catch(() => false)) { await el.click({ timeout: 4000 }); return true; } return false; };
    try {
      if (!s.hasQr) {
        if (await this.clickQrChoice()) { log('gm', 'picked "QR code"'); await sleep(this.opts.qrSettleMs ?? 1200); return; }
        if (Date.now() - (this.lastQrRefresh || 0) > 20000 && await click(this.sel.qrRefresh)) { this.lastQrRefresh = Date.now(); log('gm', 'refreshed the QR code'); await sleep(this.opts.qrSettleMs ?? 1200); return; }
      }
      if (!this.rememberDone) {
        const t = p.locator(this.sel.rememberToggle).first();
        if (await t.count()) {
          const on = await t.evaluate(el => el.checked === true || el.getAttribute('aria-checked') === 'true').catch(() => true);
          if (!on) { await t.click({ timeout: 4000, force: true }).catch(() => {}); log('gm', 'turned "Remember this computer" on'); }
          this.rememberDone = true;
        }
      }
    } catch { /* the live screen still shows the page */ }
  }
  async clickQrChoice() {
    const all = this.page.locator(this.sel.qrChoice); const n = Math.min(await all.count(), 6);
    for (let i = 0; i < n; i++) {
      const el = all.nth(i); const t = (await el.innerText().catch(() => '')).trim();
      if (!t || /trouble|help|learn|having|can.t|cannot|how to/i.test(t)) continue;      // "Having trouble scanning the QR code?" is not the choice
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 4000 }); return true;
    }
    return false;
  }
  /** 1.0.4: the dashboard's "Start pairing": straight to the QR code; to Google's sign-in box only when Google asks. */
  async startPairing() {
    const p = this.page;
    await p.goto(this.url + '/authentication', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(this.opts.settleMs ?? 2500);
    let s = await this.snap(); let c = classifyPage(s, this.sel);
    if (c.state === 'signed_out' && !/accounts\.google\.com/.test(s.url)) {
      const b = p.locator(this.sel.signInButton).first();
      if (await b.count()) { await b.click({ timeout: 5000 }).catch(() => {}); await p.waitForLoadState('domcontentloaded').catch(() => {}); await sleep(1500); s = await this.snap(); c = classifyPage(s, this.sel); }
    }
    if (c.state === 'pairing') { await this.straightToQr(s); await this.readQr(); }
    this.setState(c.state, c.detail);
    return { ok: true, state: c.state, needsSignIn: c.state === 'signed_out' || c.state === 'signin_blocked' };
  }

  // ---------- reading ----------
  /** One look at the chat list; open only the chats that changed. */
  async poll(given = null) {
    if (this.stopped || !this.page) return;
    const s = given || await this.snap();
    const c = classifyPage(s, this.sel);
    if (c.state !== 'connected') { this.setState(c.state, c.detail); return; }
    const baseline = this.opts.needsBaseline?.();
    const changed = [];
    this.names = this.names || new Map();
    for (const v of s.convs) {
      this.names.set(v.id, v.name);
      if (/,/.test(v.name) && !/^\+?[\d\s().-]+$/.test(v.name)) continue;         // group chats ("Ann, Bob") are not handled
      const sig = v.snippet + '|' + v.time;
      const before = this.sigs.get(v.id);
      this.sigs.set(v.id, sig);
      if (baseline) continue;
      // 1.0.8: a chat whose newest message is from before this start (minus 10 min) is history, not a new text — even
      // when Google still shows it unread (an old "Stop" spam of Oct 29 was answered after a restart on Nov 12)
      if (this.stale.get(v.id) === sig) continue;
      if ((before === undefined || !this.firstListDone) && listTimeIsOld(v.time, this.startedAt - (this.opts.staleMs ?? 600000))) {
        this.stale.set(v.id, sig);
        if (v.unread) log('gmweb', `chat ${v.id}: unread but its last message ("${v.time}") is from before this start; left alone`);
        continue;
      }
      if (this.stale.has(v.id)) { this.wasStale.set(v.id, this.stale.get(v.id).split('|')[0]); this.stale.delete(v.id); }
      if (v.unread || (before !== undefined && before !== sig)) {
        const mine = this.lastSent.get(v.id);
        if (!v.unread && mine && (mine.includes(v.snippet.replace(/^You:\s*/i, '')) || v.snippet.startsWith('You:'))) continue;   // our own reply
        changed.push(v);
      } else if (before === undefined && !this.firstListDone) { /* first look after start: remembered, not opened */ }
      else if (before === undefined) changed.push(v);            // a brand-new chat appeared at the top
    }
    this.firstListDone = true;
    if (baseline) { this.opts.baselineDone?.(s.convs.length); return; }
    if (process.env.MSA_GM_DEBUG) log('gm', 'poll', JSON.stringify(s.convs), 'changed', changed.map(v => v.id).join(','));
    for (const v of changed.slice(0, 5)) await this.readChat(v);
  }
  async openChat(id) {
    if (!this.page.url().includes('/conversations/' + encodeURIComponent(id)) && !this.page.url().includes('/conversations/' + id)) {
      await this.page.goto(this.url + '/conversations/' + encodeURIComponent(id), { waitUntil: 'domcontentloaded' });
    }
    await this.page.locator(this.sel.message).first().waitFor({ timeout: 10000 }).catch(() => {});
    await sleep(this.opts.chatSettleMs ?? 600);
  }
  async readChat(v) {
    await this.openChat(v.id);
    const s = await this.snap();
    const keys = messageKeys(v.id, s.msgs);
    const firstTime = !this.opened.has(v.id); this.opened.add(v.id);
    let fresh = [];
    if (firstTime) {
      // only the incoming messages after our last outgoing one (at most 3) count; older ones are history
      let i = s.msgs.length - 1; const run = [];
      while (i >= 0 && !s.msgs[i].outgoing) { run.unshift(i); i--; }
      let pick = run.slice(-3);
      // 1.0.8: a chat that was left alone as history: only the texts after its old last message are new
      const oldSnip = this.wasStale.get(v.id);
      if (oldSnip !== undefined) {
        this.wasStale.delete(v.id);
        const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim();
        const at = run.map(n => norm(s.msgs[n].text)).lastIndexOf(norm(oldSnip).replace(/^You:\s*/i, ''));
        pick = at >= 0 ? run.slice(at + 1).slice(-3) : run.slice(-1);
      }
      const take = new Set(pick);
      s.msgs.forEach((m, n) => { if (!take.has(n) || this.opts.isSeen?.(keys[n])) this.opts.markSeen?.(keys[n]); else fresh.push(n); });
    } else {
      s.msgs.forEach((m, n) => { if (!m.outgoing && !this.opts.isSeen?.(keys[n])) fresh.push(n); else this.opts.markSeen?.(keys[n]); });
    }
    for (const n of fresh) {
      const m = s.msgs[n];
      this.opts.markSeen?.(keys[n]);
      if (!m.text) continue;                     // pictures / stickers: not handled in 1.0
      this.emit('message', { convId: v.id, phone: v.name, name: v.name, text: m.text, extId: keys[n], ts: Date.now() });
    }
    // leave the chat (so the next incoming message shows as unread in the list)
    await this.page.goto(this.url + '/conversations', { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  // ---------- sending ----------
  send({ convId = null, phone = null, text, media = null, mediaUrl = null, skipParts = 0 }) {
    return this.enqueue('send', async () => {
      if (this.state !== 'connected') { const e = new Error('Messages is not connected (' + this.state + ')'); e.notConnected = true; throw e; }
      let id = convId;
      if (!id) id = await this.newChat(phone);
      await this.openChat(id);
      // 1.0.2: a picture first; if this page won't take it, its private link goes as text instead (never lost)
      if (media && !skipParts) {
        let ok = false;
        try { await this.attachAndSend(media); ok = true; } catch (e) { this.lastAttachError = String(e.message || e).slice(0, 200); }
        if (!ok && mediaUrl) text = (text ? text + '\n' : '') + mediaUrl;
      }
      // 1.0.7: each part must show up in the chat as sent (not "Sending…") before the next one; a part that
      // did not tells the outbox which parts already went (partsDone), so a retry never repeats them
      const parts = text ? splitText(text) : [];
      for (let i = skipParts; i < parts.length; i++) {
        try { await this.typeAndSend(parts[i]); }
        catch (e) { e.partsDone = i; e.convId = id; e.partText = parts[i]; throw e; }
      }
      this.lastSent.set(id, String(text).slice(-200));
      // texts that came in while this chat was open (Google marks them read, so the list won't show them as new)
      const s = await this.snap();
      const keys = messageKeys(id, s.msgs), known = this.opened.has(id);
      s.msgs.forEach((m, n) => {
        const fresh = known && !m.outgoing && m.text && !this.opts.isSeen?.(keys[n]);
        this.opts.markSeen?.(keys[n]);
        if (fresh) this.emit('message', { convId: id, phone: this.names?.get(id) || phone || '', name: this.names?.get(id) || '', text: m.text, extId: keys[n], ts: Date.now() });
      });
      this.opened.add(id);
      const sig = s.convs.find(c => c.id === id); if (sig) this.sigs.set(id, sig.snippet + '|' + sig.time);
      await this.page.goto(this.url + '/conversations', { waitUntil: 'domcontentloaded' }).catch(() => {});
      return { ok: true, convId: id };
    });
  }
  /** What is in the typing box now (a textarea's value or a contenteditable div's text); null if unreadable. */
  async composerText() {
    return this.page.locator(this.sel.composer).first().evaluate(el => ('value' in el ? el.value : el.innerText).trim()).catch(() => null);
  }
  outgoingMark(s) {
    const outs = (s || { msgs: [] }).msgs.filter(m => m.outgoing);
    return { n: outs.length, ids: new Set(outs.map(m => m.id).filter(Boolean)) };
  }
  async typeAndSend(part) {
    const t0 = Date.now();
    const box = this.page.locator(this.sel.composer).first();
    await box.waitFor({ timeout: 15000 });
    await box.fill(part);
    const before = this.outgoingMark(await this.snap());
    await box.press('Enter');
    let r = await this.waitOutgoing(before, this.opts.sendConfirmMs ?? 8000, part);
    if (r === 'none' && await this.composerText()) {          // Enter did nothing (the words are still in the box): the Send button
      await this.page.locator(this.sel.sendButton).first().click({ timeout: 5000 }).catch(() => {});
      r = await this.waitOutgoing(before, this.opts.sendConfirmMs ?? 8000, part);
    }
    // an emptied box is NOT proof: wait longer while Google shows it sending (clock), or for it to appear at all
    if (r === 'pending' || (r === 'none' && (await this.composerText()) === '')) r = await this.waitOutgoing(before, this.opts.pendingWaitMs ?? 20000, part);
    const ms = Date.now() - t0;
    if (r === 'sent') {
      log('gmweb', `sent ${part.length} chars in ${ms} ms`);
      await sleep(this.opts.betweenSendsMs ?? 250);     // 1.0.8: 250 ms (was 700)
      return true;
    }
    const left = await this.composerText();
    if (r === 'failed') { const e = new Error('Google Messages shows the message as not sent'); e.notSent = true; throw e; }
    if (left === '' || r === 'pending') {
      // it left the typing box but is not shown as sent: do NOT type it again now (it may still go); the outbox checks the chat later
      const e = new Error(r === 'pending' ? `still "sending" in Google Messages after ${Math.round(ms / 1000)} s (is the phone online?)` : `the typing box emptied but the message did not appear in the chat (${Math.round(ms / 1000)} s)`);
      e.unconfirmed = true; throw e;
    }
    throw new Error('the message did not appear as sent');
  }
  async attachAndSend(file) {
    const outs = async () => (await this.snap()).msgs.filter(m => m.outgoing);
    const before = await outs();
    const lastId = before.length ? before[before.length - 1].id : '';
    const input = this.page.locator(this.sel.attachInput).first();
    if (await input.count()) await input.setInputFiles(file, { timeout: 8000 });
    else {
      const btn = this.page.locator(this.sel.attachButton).first();
      if (!(await btn.count())) throw new Error('no attach button on this page');
      const [chooser] = await Promise.all([this.page.waitForEvent('filechooser', { timeout: 8000 }), btn.click({ timeout: 5000 })]);
      await chooser.setFiles(file);
    }
    await sleep(this.opts.attachWaitMs ?? 1500);
    const send = this.page.locator(this.sel.sendButton).first();
    if (await send.count()) await send.click({ timeout: 8000 }).catch(() => this.page.locator(this.sel.composer).first().press('Enter'));
    else await this.page.locator(this.sel.composer).first().press('Enter');
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const now = await outs();
      if (now.length > before.length || (now.length && now[now.length - 1].id && now[now.length - 1].id !== lastId)) { await sleep(this.opts.betweenSendsMs ?? 700); return true; }
      await sleep(400);
    }
    throw new Error('the picture did not appear as sent');
  }
  /** Wait for the part we just sent: 'sent' (our new bubble, without the clock/Sending… state), 'pending', 'failed' or 'none'. */
  async waitOutgoing(before, ms, part = null) {
    const end = Date.now() + ms; let seen = 'none';
    while (Date.now() < end) {
      const s = await this.snap().catch(() => null);
      const m = s ? newOutgoing(s.msgs, before, part) : null;
      if (m) { seen = m.status === 'pending' ? 'pending' : m.status === 'failed' ? 'failed' : 'sent'; if (seen !== 'pending') return seen; }
      await sleep(this.opts.sendPollMs ?? 150);     // 1.0.8: look every 150 ms (was 300)
    }
    return seen;
  }
  /** 1.0.7: later check of a text that left the typing box but was not shown as sent: 'sent' | 'pending' | 'failed' | 'missing'. */
  confirmSent({ convId, text }) {
    return this.enqueue('send', async () => {
      if (this.state !== 'connected') { const e = new Error('Messages is not connected (' + this.state + ')'); e.notConnected = true; throw e; }
      await this.openChat(convId);
      const s = await this.snap();
      const want = normText(text);
      const mine = s.msgs.filter(m => m.outgoing && sameText(m.text, want));
      await this.page.goto(this.url + '/conversations', { waitUntil: 'domcontentloaded' }).catch(() => {});
      if (!mine.length) return 'missing';
      const last = mine[mine.length - 1];
      return last.status === 'pending' ? 'pending' : last.status === 'failed' ? 'failed' : 'sent';
    });
  }
  async newChat(phone) {
    if (!phone) throw new Error('no number to text');
    await this.page.goto(this.url + '/conversations/new', { waitUntil: 'domcontentloaded' });
    const box = this.page.locator(this.sel.newChatInput).first();
    await box.waitFor({ timeout: 15000 });
    await box.fill(String(phone));
    await sleep(1500);
    const pick = this.page.locator(this.sel.newChatPick).first();
    if (await pick.count()) await pick.click({ timeout: 5000 }).catch(() => box.press('Enter')); else await box.press('Enter');
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const m = /\/conversations\/([^/?#]+)/.exec(this.page.url());
      if (m && m[1] !== 'new') return decodeURIComponent(m[1]);
      await sleep(300);
    }
    throw new Error('could not start a chat with ' + phone);
  }

  // ---------- the dashboard's live view ----------
  async viewSize() {
    const v = this.page.viewportSize();
    if (v) return v;
    const r = await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null);
    return r && r.width > 0 ? r : VIEW;
  }
  screen() {
    return this.enqueue('screen', async () => {
      const jpg = await this.page.screenshot({ type: 'jpeg', quality: 60, timeout: 10000 });
      // 1.0.7: where the text boxes are in this picture, so a tap on one can open the phone's keyboard at once
      this.lastFields = { fields: await this.page.evaluate(fieldsScript).catch(() => []), focus: await this.focusInfo() };
      return jpg;
    }, { dedupe: true });
  }
  /** 1.0.7: the page the picture shows and the taps go to. Extra tabs (a browser that restored old tabs after a
   *  hard stop) are closed; a window Google opens from the sign-in becomes the page while it is open. */
  watchPage(p) {
    if (!p || p.__msaWatched) return; p.__msaWatched = true;
    p.on('popup', (np) => {
      log('gm', 'the page opened a new window; the picture follows it');
      const back = this.page; this.page = np; this.watchPage(np);
      np.on('close', () => { if (this.page === np) this.page = back && !back.isClosed() ? back : null; });
    });
  }
  async focusInfo() {
    return this.page.evaluate(focusScript).catch(() => ({ editable: false }));
  }
  input(b = {}) {
    return this.enqueue('input', async () => {
      const p = this.page;
      if (b.type === 'click') {
        if (this.browserMode === 'visible') await p.bringToFront().catch(() => {});
        const V = await this.viewSize();   // 1.0.6: the visible browser's real page size (the picture is exactly that)
        const { x, y } = tapToPage(b, V);
        await p.mouse.click(x, y);
        await sleep(250);
        return { ok: true, at: { x: Math.round(x), y: Math.round(y) }, focus: await this.focusInfo() };   // 1.0.7: did a text box get it
      } else if (b.type === 'text') await p.keyboard.type(String(b.text || '').slice(0, 500), { delay: 30 });
      else if (b.type === 'edit') {
        // 1.0.7: typing straight from the phone's keyboard: n backspaces, then the new letters, at the text cursor
        const n = Math.max(0, Math.min(200, Math.floor(Number(b.back) || 0)));
        for (let i = 0; i < n; i++) await p.keyboard.press('Backspace');
        const t = String(b.text || '').slice(0, 500); if (t) await p.keyboard.type(t, { delay: 5 });
        return { ok: true };
      }
      else if (b.type === 'key') { const k = String(b.key || ''); if (!/^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageDown|PageUp|Space)$/.test(k)) throw new Error('key not allowed'); await p.keyboard.press(k === 'Space' ? ' ' : k); }
      else if (b.type === 'scroll') {
        // 1.0.7: a mouse wheel or a swipe on the picture scrolls by that much, where it happened; the buttons keep ±500
        if (b.px !== undefined) {
          const V = await this.viewSize(); const at = tapToPage({ x: b.x ?? 0.5, y: b.y ?? 0.5 }, V);
          await p.mouse.move(at.x, at.y); await p.mouse.wheel(0, Math.max(-3000, Math.min(3000, Number(b.px) || 0)));
        } else await p.mouse.wheel(0, Number(b.dy) > 0 ? 500 : -500);
      }
      else if (b.type === 'pair') return this.startPairing();
      else if (b.type === 'goto') await p.goto(b.where === 'signin' || b.where === 'pair' ? this.url + '/authentication' : this.url + '/conversations', { waitUntil: 'domcontentloaded' });
      else if (b.type === 'reload') await p.reload({ waitUntil: 'domcontentloaded' });
      else if (b.type === 'back') await p.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      else throw new Error('unknown input');
      await sleep(400);
      return { ok: true };
    });
  }
}
