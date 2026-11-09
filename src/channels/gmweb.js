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
  composer: 'textarea[data-e2e-message-input-box], mws-message-compose textarea, textarea.input, textarea',
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
const PRIO = { send: 0, input: 1, screen: 2, health: 3, poll: 4 };

export function loadSelectors(dataDir = cfg.dataDir) {
  try { const o = JSON.parse(fs.readFileSync(path.join(dataDir, 'gm-selectors.json'), 'utf8')); return { ...SELECTORS, ...o }; } catch { return { ...SELECTORS }; }
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
  const msgs = qa(document, sel.message).slice(-40).map((w, i) => {
    const out = w.getAttribute(sel.outgoingAttr);
    const textEl = q(w, sel.messageText);
    return { id: w.getAttribute(sel.messageIdAttr) || '', outgoing: out === 'true' || (out === null && /outgoing/.test(w.className || '')), text: textEl ? (textEl.innerText || textEl.textContent || '').trim() : '' };
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
    await this.closeBrowser();
    this.setState('stopped');
  }
  async playwright() {
    if (this.opts.playwright) return this.opts.playwright;
    const mod = await import(process.env.MSA_PLAYWRIGHT_PATH || 'playwright-core');
    return mod.chromium ? mod : mod.default;
  }
  async ensureBrowser() {
    if (this.ctx && this.page && !this.page.isClosed()) return;
    await this.closeBrowser();
    const pw = await this.playwright();
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { fs.rmSync(path.join(this.profileDir, f), { force: true }); } catch {} }
    // 1.0.4: the full Chromium build (pickBrowser), never the headless shell Google refuses to sign in from
    this.browser = this.opts.launch?.executablePath ? { executablePath: this.opts.launch.executablePath, kind: isHeadlessShell(this.opts.launch.executablePath) ? 'shell' : 'full', why: 'test' }
      : pickBrowser({ configured: cfg.chromium });
    const launch = {
      headless: true, viewport: VIEW, locale: 'en-US',
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--lang=en-US'],
      ...(this.browser.executablePath ? { executablePath: this.browser.executablePath } : { channel: this.browser.channel }),
      ...(this.opts.launch || {}),
    };
    if (this.ua) launch.userAgent = this.ua;
    try { this.ctx = await pw.chromium.launchPersistentContext(this.profileDir, launch); }
    catch (e) {
      if (!launch.channel) throw e;
      // no full build where Playwright looks: fall back to its default (the shell) rather than not starting at all
      log('gm', 'full Chromium did not start (' + String(e.message).split('\n')[0].slice(0, 120) + '); using the default browser');
      delete launch.channel; this.browser = { kind: 'shell', why: 'fallback: the full build is not installed' };
      this.ctx = await pw.chromium.launchPersistentContext(this.profileDir, launch);
    }
    if (!this.loggedBrowser) { this.loggedBrowser = true; log('gm', `browser: ${this.browser.kind === 'full' ? 'full Chromium' : 'headless shell'} (${this.browser.why})`); }
    this.page = this.ctx.pages()[0] || await this.ctx.newPage();
    if (!this.ua && !launch.userAgent) {
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
    // looks like a person's browser where that is cheap: no webdriver flag
    await this.ctx.addInitScript(() => { try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); } catch {} }).catch(() => {});
    this.page.on('crash', () => { log('gm', 'page crashed'); this.page = null; });
    this.ctx.on('close', () => { this.ctx = null; this.page = null; });
    this.page.setDefaultTimeout(20000);
    await this.page.goto(this.url + '/conversations', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log('gm', 'open failed:', e.message));
    await sleep(this.opts.settleMs ?? 2500);
    this.launchFails = 0;
  }
  async closeBrowser() { const c = this.ctx; this.ctx = null; this.page = null; if (c) await c.close().catch(() => {}); }
  async restart() { return this.enqueue('input', async () => { await this.closeBrowser(); await this.ensureBrowser(); await this.health(); return { ok: true }; }, { noEnsure: true }); }
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
      browser: this.browser ? this.browser.kind : null, driver: 'google-messages-web', queue: this.queue.length };
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
      const take = new Set(run.slice(-3));
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
  send({ convId = null, phone = null, text, media = null, mediaUrl = null }) {
    return this.enqueue('send', async () => {
      if (this.state !== 'connected') { const e = new Error('Messages is not connected (' + this.state + ')'); e.notConnected = true; throw e; }
      let id = convId;
      if (!id) id = await this.newChat(phone);
      await this.openChat(id);
      // 1.0.2: a picture first; if this page won't take it, its private link goes as text instead (never lost)
      if (media) {
        let ok = false;
        try { await this.attachAndSend(media); ok = true; } catch (e) { this.lastAttachError = String(e.message || e).slice(0, 200); }
        if (!ok && mediaUrl) text = (text ? text + '\n' : '') + mediaUrl;
      }
      for (const part of (text ? splitText(text) : [])) await this.typeAndSend(part);
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
  async typeAndSend(part) {
    const box = this.page.locator(this.sel.composer).first();
    await box.waitFor({ timeout: 15000 });
    await box.fill(part);
    const before = (await this.snap()).msgs.filter(m => m.outgoing).length;
    await box.press('Enter');
    const ok = await this.waitOutgoing(before, 8000);
    if (!ok) {
      await this.page.locator(this.sel.sendButton).first().click({ timeout: 5000 }).catch(() => {});
      if (!await this.waitOutgoing(before, 8000)) throw new Error('the message did not appear as sent');
    }
    await sleep(this.opts.betweenSendsMs ?? 700);
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
  async waitOutgoing(before, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = await this.snap();
      if (s.msgs.filter(m => m.outgoing).length > before) return true;
      const val = await this.page.locator(this.sel.composer).first().inputValue().catch(() => 'x');
      if (val === '' && s.msgs.length) return true;      // box emptied: sent (the list may be virtualized)
      await sleep(300);
    }
    return false;
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
  screen() {
    return this.enqueue('screen', async () => this.page.screenshot({ type: 'jpeg', quality: 60, timeout: 10000 }), { dedupe: true });
  }
  input(b = {}) {
    return this.enqueue('input', async () => {
      const p = this.page;
      if (b.type === 'click') {
        const x = Math.max(0, Math.min(VIEW.width, Number(b.x) * VIEW.width)), y = Math.max(0, Math.min(VIEW.height, Number(b.y) * VIEW.height));
        await p.mouse.click(x, y);
      } else if (b.type === 'text') await p.keyboard.type(String(b.text || '').slice(0, 500), { delay: 30 });
      else if (b.type === 'key') { const k = String(b.key || ''); if (!/^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageDown|PageUp|Space)$/.test(k)) throw new Error('key not allowed'); await p.keyboard.press(k === 'Space' ? ' ' : k); }
      else if (b.type === 'scroll') await p.mouse.wheel(0, Number(b.dy) > 0 ? 500 : -500);
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
