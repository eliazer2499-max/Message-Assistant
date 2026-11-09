// Message Assistant admin dashboard (no framework; works on a phone).
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// 1.0.3: the version this page was served as (the server fills it in). When the server runs a newer one (after
// Update now), the page reloads once by itself, so a phone never keeps an old page, style or logo.
const PAGE_V = '__V__';
function reloadIfNewVersion(v) {
  if (!v || PAGE_V.startsWith('__') || v === PAGE_V) return false;
  try { const k = 'msa-reloaded-' + v; if (sessionStorage.getItem(k)) return false; sessionStorage.setItem(k, '1'); } catch {}
  location.reload(); return true;
}
let CSRF = '', VIEW = 'home', screenTimer = null, overviewTimer = null, peopleStatus = 'pending', KEYS = [], PRESETS = [], editingKey = null;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (t) => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return new Date(t).toLocaleDateString(); };
const when = (t) => t ? new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
function msg(node, text, ok = false) { node.textContent = text || ''; node.className = 'msg ' + (text ? (ok ? 'ok' : 'err') : ''); }

async function api(method, path, body, ms = 0) {
  // 1.0.3: an optional time limit, so a slow answer can never leave the page waiting forever
  const ac = ms ? new AbortController() : null, tm = ms ? setTimeout(() => ac.abort(), ms) : null;
  let r;
  try { r = await fetch(path, { method, signal: ac ? ac.signal : undefined, headers: { 'Content-Type': 'application/json', ...(CSRF ? { 'X-CSRF-Token': CSRF } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch (e) { if (e.name === 'AbortError') { const t = new Error('No answer in ' + Math.round(ms / 1000) + ' seconds'); t.timeout = true; throw t; } throw e; }
  finally { clearTimeout(tm); }
  if (r.status === 401 && !path.startsWith('/api/login')) { showLogin(); throw new Error('Please sign in'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : null;
  if (!r.ok) throw new Error((data && data.error) || ('Error ' + r.status));
  if (data && data.csrf) CSRF = data.csrf;
  return data;
}
const GET = (p) => api('GET', p), POST = (p, b = {}) => api('POST', p, b);

// ---------------- sign-in ----------------
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); stopTimers(); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); go(VIEW); overviewTimer = setInterval(refreshOverview, 10000); }
function stopTimers() { clearInterval(overviewTimer); clearInterval(screenTimer); overviewTimer = screenTimer = null; }
$$('#loginTabs button').forEach(b => b.onclick = () => {
  $$('#loginTabs button').forEach(x => x.classList.toggle('on', x === b));
  const t = b.dataset.t; $('#fPhone').classList.toggle('hidden', t !== 'phone'); $('#fCode').classList.add('hidden'); $('#fPass').classList.toggle('hidden', t !== 'password'); msg($('#loginMsg'), '');
});
$('#fPhone').onsubmit = async (e) => {
  e.preventDefault();
  try { const r = await POST('/api/login/code', { phone: $('#lPhone').value }); msg($('#loginMsg'), r.hint || r.message, !r.hint); $('#fPhone').classList.add('hidden'); $('#fCode').classList.remove('hidden'); $('#lCode').focus(); }
  catch (er) { msg($('#loginMsg'), er.message); }
};
$('#codeBack').onclick = () => { $('#fCode').classList.add('hidden'); $('#fPhone').classList.remove('hidden'); };
$('#fCode').onsubmit = async (e) => { e.preventDefault(); try { await POST('/api/login/verify', { phone: $('#lPhone').value, code: $('#lCode').value }); $('#lCode').value = ''; showApp(); } catch (er) { msg($('#loginMsg'), er.message); } };
$('#fPass').onsubmit = async (e) => { e.preventDefault(); try { await POST('/api/login/password', { username: $('#lUser').value, password: $('#lPass').value }); $('#lPass').value = ''; showApp(); } catch (er) { msg($('#loginMsg'), er.message); } };
$('#logout').onclick = async () => { await POST('/api/logout').catch(() => {}); CSRF = ''; showLogin(); };

// ---------------- navigation ----------------
$$('#nav button').forEach(b => b.onclick = () => go(b.dataset.v));
function go(v) {
  VIEW = v; $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); $$('.view').forEach(s => s.classList.toggle('hidden', s.id !== 'v-' + v));
  clearInterval(screenTimer); screenTimer = null;
  if (v === 'home') refreshOverview(); if (v === 'people') loadPeople(); if (v === 'keys') loadKeys(); if (v === 'settings') loadSettings(); if (v === 'sites') loadSites();
  if (v === 'connect') { loadConnect(); screenTimer = setInterval(loadConnect, 1500); }
}
const STATE_CLASS = { connected: 'ok', phone_offline: 'warn', pairing: 'warn', signed_out: 'warn', signin_blocked: 'bad', error: 'bad', other_tab: 'warn' };

// ---------------- home ----------------
async function refreshOverview() {
  let o; try { o = await GET('/api/overview'); } catch { return; }
  if (reloadIfNewVersion(o.version)) return;
  const m = o.messages, cls = STATE_CLASS[m.state] || '';
  $('#connDot').className = 'dot ' + (cls === 'ok' ? 'ok' : cls === 'bad' ? 'bad' : 'warn');
  const down = m.state !== 'connected';
  $('#banner').classList.toggle('hidden', !down || VIEW === 'connect');   // 1.0.4: Connect says it itself
  if (down) $('#banner').textContent = `Google Messages: ${m.words}. Texts wait until it is fixed (Connect tab).${m.outbox_waiting ? ' ' + m.outbox_waiting + ' waiting.' : ''}`;
  sitesBadge(o.sites ? o.sites.waiting : 0);
  if (VIEW !== 'home') { badge(o.people.pending); return; }
  $('#homeConn').innerHTML = `<h2>Google Messages</h2><p class="state ${cls}">${esc(m.words)}</p><p class="muted small">since ${ago(m.since)}${m.detail ? ' · ' + esc(m.detail) : ''}${m.outbox_waiting ? ' · ' + m.outbox_waiting + ' text(s) waiting to go out' : ''}</p>${down ? '<button class="primary" id="toConnect">Open Connect</button>' : ''}`;
  const tc = $('#toConnect'); if (tc) tc.onclick = () => go('connect');
  $('#alerts').innerHTML = o.alerts.length ? o.alerts.map(a => `<div class="alert ${a.level}">${esc(a.text)}<div class="muted small">${when(a.ts)}</div></div>`).join('') : '<p class="muted small">No alerts.</p>';
  $('#homeCounts').innerHTML = `<div class="stat"><b>${o.people.pending}</b><span>waiting</span></div><div class="stat"><b>${o.people.approved}</b><span>approved</span></div><div class="stat"><b>${o.today.messages}</b><span>texts today</span></div>`;
  $('#homeKeys').innerHTML = o.keys.length ? o.keys.map(k => `<span class="chip ${k.status}">${esc(k.name)} · ${statusWord(k.status)}</span>`).join('') : '<p class="muted small">No AI keys yet. Add one in the AI keys tab.</p>';
  $('#homeQueue').innerHTML = `<div class="kv"><span>Thinking now</span><b>${o.queue.running}</b><span>Waiting in line</span><b>${o.queue.queued}</b><span>Waiting for a free AI key</span><b>${o.queue.waiting_for_ai}</b><span>Browser steps running / waiting</span><b>${o.browser.running} / ${o.browser.waiting}</b><span>Replies today</span><b>${o.today.replies}</b></div>`;
  badge(o.people.pending);
}
function sitesBadge(n) { const b = $('#sitesBadge'); b.textContent = n; b.classList.toggle('hidden', !n); }
function badge(n) { const b = $('#pendBadge'); b.textContent = n; b.classList.toggle('hidden', !n); }
$('#clearAlerts').onclick = async () => { await POST('/api/alerts/clear'); refreshOverview(); };
const statusWord = (s) => ({ ok: 'ok', cooling: 'cooling down', bad: 'bad', off: 'off', no_key: 'no key' }[s] || s);

// ---------------- people ----------------
$$('#peopleTabs button').forEach(b => b.onclick = () => { peopleStatus = b.dataset.s; $$('#peopleTabs button').forEach(x => x.classList.toggle('on', x === b)); loadPeople(); });
async function loadPeople() {
  const { users } = await GET('/api/users' + (peopleStatus ? '?status=' + peopleStatus : ''));
  const box = $('#people'); box.innerHTML = '';
  if (!users.length) { box.innerHTML = `<div class="card muted">Nobody here.</div>`; return; }
  const card = el('<div class="card"></div>');
  for (const u of users) {
    const it = el(`<div class="item"><div class="top"><span class="name">${esc(u.label)}</span><span class="chip ${u.status}">${u.status === 'pending' ? 'waiting' : u.status}${u.paused ? ' · paused' : ''}</span></div>
      <div class="sub">${u.phone && u.phone !== u.label ? esc(u.phone) + ' · ' : ''}last text ${ago(u.last_seen)} · today ${u.today.messages} msg${u.status === 'pending' && u.first_text ? '<br>“' + esc(u.first_text) + '”' : ''}</div>
      <div class="acts"></div></div>`);
    const acts = $('.acts', it);
    const add = (label, cls, fn) => { const b = el(`<button class="${cls}">${label}</button>`); b.onclick = fn; acts.appendChild(b); };
    if (u.status !== 'approved') add('Approve', 'primary', async () => { await POST(`/api/users/${u.id}/approve`); loadPeople(); refreshOverview(); });
    if (u.status !== 'blocked') add('Block', '', async () => { if (confirm(`Block ${u.label}? They get no more answers.`)) { await POST(`/api/users/${u.id}/block`); loadPeople(); } });
    add('Remove', 'danger', async () => { if (confirm(`Remove ${u.label} and ALL their data (history, notes, reminders)? If they text again they start as waiting.`)) { await POST(`/api/users/${u.id}/remove`); loadPeople(); } });
    if (u.status === 'approved') add('Details', '', () => openUser(u.id));
    card.appendChild(it);
  }
  box.appendChild(card);
}
async function openUser(id) {
  const d = await GET('/api/users/' + id);
  const u = d.user;
  $('#sheetContent').innerHTML = `<h2>${esc(u.label)}</h2><p class="muted small">${esc(u.phone)} · approved ${when(u.approved_at)}</p>
    <div class="kv"><span>Today</span><b>${d.today.messages} texts · ${d.today.model_calls} AI calls · ${Math.round(d.today.browser_ms / 1000)} s browser</b><span>All time</span><b>${d.total.messages} texts · ${d.total.searches} searches</b></div>
    <label>Daily limit (blank = default, 0 = none)<input id="uLimit" inputmode="numeric" value="${u.daily_limit ?? ''}"></label>
    <label class="check"><input type="checkbox" id="uPaused" ${u.paused ? 'checked' : ''}> Paused</label>
    <button id="uSave">Save</button>
    <h2>Notes (${d.notes.length})</h2>${d.notes.map(n => `<div class="item"><div class="top"><span>${esc(n.fact)}</span><button class="link small" data-note="${n.id}">Delete</button></div></div>`).join('') || '<p class="muted small">None.</p>'}
    <h2>Reminders</h2>${d.reminders.map(r => `<div class="sub">${when(r.due)} — ${esc(r.text)}${r.every_minutes ? ' (every ' + r.every_minutes + ' min)' : ''}</div>`).join('') || '<p class="muted small">None.</p>'}
    <h2>Recent messages</h2>${d.messages.map(m => `<div class="bubble ${m.role}">${esc(m.text)}</div>`).join('') || '<p class="muted small">None.</p>'}`;
  $('#sheet').classList.remove('hidden');
  $('#uSave').onclick = async () => { await POST('/api/users/' + id, { daily_limit: $('#uLimit').value, paused: $('#uPaused').checked }); $('#sheet').classList.add('hidden'); loadPeople(); };
  $$('[data-note]').forEach(b => b.onclick = async () => { await POST(`/api/users/${id}/notes/${b.dataset.note}/delete`); openUser(id); });
}
$('#sheetClose').onclick = () => $('#sheet').classList.add('hidden');

// 1.0.6: which browser runs, in plain words ("Browser: full (visible)" / "Browser: basic")
function browserWords(b) { return b && b.label ? 'Browser: ' + b.label : ''; }
function browserDiag(b) {
  if (!b || !b.mode) return 'Browser: not started';
  const bits = ['Browser: ' + b.label];
  if (b.version) bits.push('Chromium ' + b.version);
  if (b.mode === 'visible' && b.screen) bits.push('virtual screen ' + b.screen);
  if (b.mode === 'basic' && b.why) bits.push(b.why);
  if (b.automatedFlag) bits.push('reports itself as automated');
  return bits.join(' · ');
}
// ---------------- connect: pair with the phone (1.0.4: straight to the QR code) ----------------
let shotUrl = null, loadingShot = false, liveOpenedFor = '';
async function loadConnect() {
  if (VIEW !== 'connect' || document.hidden) return;
  let s = null;
  try {
    s = await GET('/api/messages/status');
    const cls = STATE_CLASS[s.state] || '';
    $('#cState').className = 'state ' + cls; $('#cState').textContent = s.words + (s.detail && !['connected', 'pairing', 'signed_out', 'signin_blocked'].includes(s.state) ? ' — ' + s.detail : '');
    $('#banner').classList.add('hidden');
    const paired = s.state === 'connected', showQr = !!s.qr && s.state === 'pairing';
    const needsSignIn = s.state === 'signed_out' || s.state === 'signin_blocked';
    $('#pairedBox').classList.toggle('hidden', !paired);
    $('#qrCard').classList.toggle('hidden', !showQr); if (showQr && $('#qrImg').getAttribute('src') !== s.qr) $('#qrImg').src = s.qr;
    $('#pairSteps').classList.toggle('hidden', paired);
    $('#gmPair').classList.toggle('hidden', paired);
    $('#gmPair').textContent = showQr ? 'New QR code' : 'Start pairing';
    $('#signinNote').classList.toggle('hidden', !needsSignIn);
    $('#browserLine').textContent = browserWords(s.browserInfo);
    $('#signinNote').textContent = s.state === 'signin_blocked'
      ? (s.browserInfo && s.browserInfo.mode === 'basic'
        ? "Google refused the sign-in from the server's basic browser. Settings → Updates → Update now installs the full one, then Start pairing again."
        : "Google refused the sign-in from the server's browser. Tap Restart browser, then Start pairing, and sign in again.")
      : "Google first wants the phone's Google account signed in, one time. Do it in the picture below (tap a box, then type in the box under the picture). The QR code shows right after.";
    // the live picture opens by itself only when Google asks for the sign-in (or the page needs a hand)
    const wantLive = needsSignIn || s.state === 'other_tab' || s.state === 'error';
    if (wantLive && liveOpenedFor !== s.state) { $('#liveCard').open = true; liveOpenedFor = s.state; }
    if (!wantLive) liveOpenedFor = '';
  } catch {}
  if (!$('#liveCard').open) return;
  if (loadingShot) return; loadingShot = true;
  try {
    const r = await fetch('/api/messages/screen', { credentials: 'same-origin' });
    if (r.status === 200) { const b = await r.blob(); const u = URL.createObjectURL(b); $('#screen').src = u; if (shotUrl) URL.revokeObjectURL(shotUrl); shotUrl = u; $('#screenNote').textContent = 'Live (tap the picture to click there).'; }
    else $('#screenNote').textContent = r.status === 204 ? 'No picture (Messages is in test mode or the browser is starting).' : 'Picture not available (' + r.status + ').';
  } catch { } finally { loadingShot = false; }
}
$('#liveCard').addEventListener('toggle', () => { if ($('#liveCard').open) loadConnect(); });
$('#gmPair').onclick = async () => {
  const b = $('#gmPair'); b.disabled = true; const was = b.textContent; b.textContent = 'Getting the QR code…';
  try { await POST('/api/messages/input', { type: 'pair' }); } catch (er) { alert(er.message); }
  finally { b.disabled = false; b.textContent = was; loadConnect(); }
};
$('#screen').onclick = async (e) => {
  const r = e.target.getBoundingClientRect();
  await POST('/api/messages/input', { type: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }).catch(er => alert(er.message));
  loadConnect();
};
$('#typeBtn').onclick = async () => { const t = $('#typeText').value; if (!t) return; await POST('/api/messages/input', { type: 'text', text: t }).catch(er => alert(er.message)); $('#typeText').value = ''; loadConnect(); };
$$('[data-key]').forEach(b => b.onclick = () => POST('/api/messages/input', { type: 'key', key: b.dataset.key }).then(loadConnect).catch(er => alert(er.message)));
$$('[data-act]').forEach(b => b.onclick = () => {
  const a = b.dataset.act;
  const body = a === 'scrollDown' ? { type: 'scroll', dy: 1 } : a === 'scrollUp' ? { type: 'scroll', dy: -1 } : a === 'messages' ? { type: 'goto', where: 'messages' } : { type: a };
  POST('/api/messages/input', body).then(loadConnect).catch(er => alert(er.message));
});
$('#gmRestart').onclick = () => POST('/api/messages/restart').then(loadConnect).catch(er => alert(er.message));
$('#gmSignout').onclick = () => { if (confirm('Unpair this server from the phone? To use it again you pair again with the QR code.')) POST('/api/messages/signout').then(loadConnect).catch(er => alert(er.message)); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && VIEW === 'connect') loadConnect(); });

// ---------------- AI keys ----------------
async function loadKeys() {
  const d = await GET('/api/keys'); KEYS = d.keys; PRESETS = d.presets;
  const box = $('#keys'); box.innerHTML = KEYS.length ? '' : '<p class="muted">No keys yet. Tap “+ Add key”. A free Gemini key: aistudio.google.com/apikey · Groq: console.groq.com/keys</p>';
  KEYS.forEach((k, i) => {
    const p = PRESETS.find(x => x.id === k.preset);
    const extra = k.status === 'cooling' && k.resting_until_text ? ' until ' + k.resting_until_text : '';
    const it = el(`<div class="item"><div class="top"><span class="name">${i + 1}. ${esc(k.name)}</span><span class="chip ${k.status}">${statusWord(k.status)}${esc(extra)}</span></div>
      <div class="sub">${esc(p ? p.label : k.kind_label)} · ${esc(k.kind === 'cloudflare' ? (k.effective_chat_model || '') : (k.effective_model || k.model || ''))} · key ${esc(k.masked || '—')}${k.last_error && k.status !== 'ok' ? '<br>' + esc(k.last_error) : ''}${k.last_ok ? '<br>last worked ' + ago(k.last_ok) : ''}</div><div class="acts"></div></div>`);
    const acts = $('.acts', it);
    const add = (label, fn, cls = '') => { const b = el(`<button class="${cls}">${label}</button>`); b.onclick = fn; acts.appendChild(b); };
    add('↑', () => move(i, -1)); add('↓', () => move(i, 1));
    add(k.active ? 'Switch off' : 'Switch on', async () => { await POST('/api/keys/' + k.id, { active: !k.active }); loadKeys(); });
    add('Test', async (e) => { e.target.textContent = 'Testing…'; const r = await POST(`/api/keys/${k.id}/test`).catch(er => ({ ok: false, error: er.message })); alert(r.ok ? 'Works ✓' : 'Did not work: ' + r.error); loadKeys(); });
    if (k.status === 'cooling' || k.status === 'bad') add('Try now', async () => { await POST(`/api/keys/${k.id}/wake`); loadKeys(); });
    add('Edit', () => openKeyForm(k));
    add('Delete', async () => { if (confirm(`Delete the key "${k.name}"?`)) { await POST(`/api/keys/${k.id}/delete`); loadKeys(); } }, 'danger');
    box.appendChild(it);
  });
}
async function move(i, d) { const ids = KEYS.map(k => k.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; await POST('/api/keys/reorder', { ids }); loadKeys(); }
$('#addKeyBtn').onclick = () => openKeyForm(null);
function openKeyForm(k) {
  editingKey = k;
  $('#kfTitle').textContent = k ? 'Edit “' + k.name + '”' : 'Add a key';
  $('#kfPreset').innerHTML = PRESETS.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  $('#kfPreset').value = k ? k.preset : 'gemini';
  $('#kfName').value = k ? k.name : ''; $('#kfKey').value = ''; $('#kfKey').placeholder = k ? 'leave empty to keep the saved key (' + (k.masked || '') + ')' : 'paste the key';
  $('#kfActive').checked = k ? k.active : true;
  presetChanged(!k);
  if (k) { $('#kfBase').value = k.base_url || ''; $('#kfModel').value = k.kind === 'cloudflare' ? (k.chat_model || '') : (k.model || ''); $('#kfAcct').value = k.account_id || ''; }
  msg($('#kfMsg'), ''); $('#keyForm').classList.remove('hidden'); $('#keyForm').scrollIntoView({ behavior: 'smooth' });
}
function presetChanged(fill = true) {
  const p = PRESETS.find(x => x.id === $('#kfPreset').value) || PRESETS[0];
  $('#kfHelp').textContent = p.help || '';
  $('#kfAcctL').classList.toggle('hidden', p.kind !== 'cloudflare');
  $('#kfBaseL').classList.toggle('hidden', p.kind !== 'openai');
  $('#kfModelL').firstChild.textContent = p.kind === 'cloudflare' ? 'Chat model (blank = default)' : p.kind === 'gemini' ? 'Model (blank = default)' : 'Model';
  if (fill) { $('#kfBase').value = p.base_url || ''; $('#kfModel').value = p.model || ''; if (!$('#kfName').value || PRESETS.some(x => $('#kfName').value.startsWith(x.label))) $('#kfName').value = p.label + ' ' + (KEYS.filter(k => k.preset === p.id).length + 1); }
}
$('#kfPreset').onchange = () => presetChanged(true);
$('#kfCancel').onclick = () => $('#keyForm').classList.add('hidden');
$('#kfSave').onclick = async () => {
  const p = PRESETS.find(x => x.id === $('#kfPreset').value);
  const b = { name: $('#kfName').value, kind: p.kind, active: $('#kfActive').checked };
  if (p.kind === 'openai') { b.base_url = $('#kfBase').value; b.model = $('#kfModel').value; }
  if (p.kind === 'gemini') b.model = $('#kfModel').value;
  if (p.kind === 'cloudflare') { b.account_id = $('#kfAcct').value; b.chat_model = $('#kfModel').value; }
  if ($('#kfKey').value.trim()) b.key = $('#kfKey').value.trim();
  try { if (editingKey) await POST('/api/keys/' + editingKey.id, b); else await POST('/api/keys', b); $('#kfKey').value = ''; $('#keyForm').classList.add('hidden'); loadKeys(); }
  catch (er) { msg($('#kfMsg'), er.message); }
};


// ---------------- sites (1.0.2) ----------------
let SITES = null;
function showSites(d) {
  SITES = d; const c = d.settings;
  $('#sApproval').checked = !!c.approval; $('#sMode').value = c.mode; $('#sQuota').value = c.quota_mb; $('#sMax').value = c.max_sites;
  $('#sApprovalHelp').textContent = c.approval ? 'On: after the person\'s YES, you get a picture and a private preview link (text + here) and approve or reject.' : 'Off: the person\'s own YES puts their site online.';
  const ch = $('#sChosen'); ch.classList.toggle('hidden', c.mode !== 'chosen');
  ch.innerHTML = c.mode === 'chosen' ? (d.people.length ? d.people.map(p => `<label class="check"><input type="checkbox" data-pid="${p.id}" ${p.chosen ? 'checked' : ''}> ${esc(p.label)} <span class="muted small">${esc(p.used)}</span></label>`).join('') : '<p class="muted small">No approved people yet.</p>') : '';
  $$('[data-pid]', ch).forEach(i => i.onchange = async () => { try { showSites(await POST('/api/sites/people/' + i.dataset.pid, { allowed: i.checked })); } catch (er) { msg($('#sMsg'), er.message); } });
  $('#sWaitCard').classList.toggle('hidden', !d.waiting.length);
  $('#sWaiting').innerHTML = d.waiting.map(r => `<div class="item"><div class="top"><span class="name">${esc(r.site)}</span><span class="chip pending">S${r.id}</span></div>
    <div class="sub">${esc(r.user)} · ${ago(r.since)}</div>${r.shot ? `<img class="shot" src="${esc(r.shot)}" alt="Picture of ${esc(r.site)}">` : ''}
    <div class="sub"><a href="${esc(r.preview)}" target="_blank" rel="noopener">Open private preview</a> · goes to ${esc(r.url)}</div>
    <div class="acts"><button class="primary" data-ok="${r.id}">Approve</button><button class="danger" data-no="${r.id}">Reject</button></div></div>`).join('');
  $$('[data-ok]').forEach(b => b.onclick = () => decideSite(b.dataset.ok, true));
  $$('[data-no]').forEach(b => b.onclick = () => decideSite(b.dataset.no, false));
  $('#sList').innerHTML = d.sites.length ? d.sites.map(x => `<div class="item"><div class="top"><span class="name">${esc(x.name)}</span><span class="muted small">${esc(x.size)}</span></div>
    <div class="sub">${esc(x.user)} · ${when(x.updated)}</div><div class="sub"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url.replace(/^https?:\/\//, ''))}</a></div>
    <div class="acts"><button class="danger" data-un="${x.id}">Unpublish</button></div></div>`).join('') : '<p class="muted small">No published sites yet.</p>';
  $$('[data-un]').forEach(b => b.onclick = async () => { const x = d.sites.find(s => String(s.id) === b.dataset.un); if (!confirm(`Take "${x.name}" by ${x.user} offline? They get a short text.`)) return; try { showSites(await POST('/api/sites/' + b.dataset.un + '/unpublish')); } catch (er) { msg($('#sMsg'), er.message); } });
  sitesBadge(d.waiting.length);
}
async function loadSites() { try { showSites(await GET('/api/sites')); } catch (er) { msg($('#sMsg'), er.message); } }
async function decideSite(id, yes) {
  try { const r = await POST(`/api/sites/requests/${id}/${yes ? 'approve' : 'reject'}`); showSites(r); msg($('#sMsg'), yes ? 'Published. They got the link.' : 'Rejected. They were told.', true); }
  catch (er) { msg($('#sMsg'), er.message); loadSites(); }
}
$('#sMode').onchange = () => { if (SITES) showSites({ ...SITES, settings: { ...SITES.settings, mode: $('#sMode').value } }); };
$('#sSave').onclick = async () => {
  try { showSites(await POST('/api/sites/settings', { approval: $('#sApproval').checked, mode: $('#sMode').value, quota_mb: $('#sQuota').value, max_sites: $('#sMax').value })); msg($('#sMsg'), 'Saved.', true); }
  catch (er) { msg($('#sMsg'), er.message); }
};

// ---------------- settings ----------------
async function loadSettings() {
  checkUpdates(false);   // 1.0.3: first and on its own (before, a slow or failed part above it left "Checking…" forever)
  try {
    const d = await GET('/api/settings');
    $$('[data-s]', $('#setForm')).forEach(i => { const v = d.settings[i.dataset.s] ?? ''; if (i.type === 'checkbox') i.checked = v === '1'; else i.value = v; });
    $('#adminPhones').value = d.admin_phones.join(', '); if (d.portal_url) $('#portalUrl').textContent = d.portal_url; $('#pwUser').value = d.admin_username || 'admin';
  } catch (er) { msg($('#setMsg'), er.message); }
  try {
    const a = await GET('/api/activity');
    $('#activity').innerHTML = a.items.map(x => `<div><span class="muted">${when(x.ts)}</span> <b>${esc(x.action)}</b> ${esc(x.detail)}</div>`).join('');
  } catch {}
  try { const me = await GET('/api/me'); $('#ver').textContent = 'Message Assistant ' + me.version; reloadIfNewVersion(me.version); } catch {}
  try { const m = await GET('/api/messages/status'); $('#diagBrowser').textContent = browserDiag(m.browserInfo); } catch {}
}
// ---------------- updates (1.0.1; 1.0.3: a check always ends, editable update source) ----------------
const CHECK_LIMIT_MS = 15000;
let updBusy = false, srcEditing = false;
function updLine(text, cls) { const p = $('#updVer'); p.textContent = text; p.className = 'updstat ' + (cls || ''); }
const srcLabel = (s) => String(s || '').replace(/^https?:\/\//, '');
function showSource(u) {
  if (!u || !u.source_default) return;
  $('#usrc').options[0].textContent = srcLabel(u.source_default) + ' (default)';
  if (!srcEditing) { $('#usrc').value = u.source ? 'custom' : 'default'; $('#usrcLink').value = u.source || ''; }
  $('#usrcBox').classList.toggle('hidden', $('#usrc').value !== 'custom');
  $('#usrcOrder').innerHTML = (u.sources || []).map((s, i) => `<li>${esc(srcLabel(s))}${i === 0 ? ' <span class="muted">— first</span>' : ''}</li>`).join('');
}
function showUpdates(u) {
  const state = u.state || (u.update_available ? 'available' : u.latest ? 'up_to_date' : 'error');
  const words = u.words || (state === 'available' ? `${u.latest} available — Update now` : state === 'up_to_date' ? `Up to date (${u.current})` : 'Couldn\'t reach the update source');
  updLine(words, state === 'available' ? 'new' : state === 'up_to_date' ? 'ok' : 'err');
  $('#updSub').textContent = `This server: ${u.current}` + (u.checked_at ? ` · checked ${when(u.checked_at)}` : '') + (u.checked_from ? ` from ${u.checked_from}` : '') + (state === 'error' && (u.detail || u.check_error) ? ` · ${u.detail || u.check_error}` : '');
  if ($('#updAuto')) $('#updAuto').checked = !!u.auto;
  $('#updNow').disabled = !!u.pending || state === 'up_to_date';
  $('#updNotes').classList.toggle('hidden', !(u.update_available && u.notes));
  $('#updNotes').textContent = u.update_available && u.notes ? 'What\'s new in ' + u.latest + ':\n' + u.notes : '';
  const l = u.last;
  $('#updLast').textContent = u.pending ? 'An update is running…'
    : u.stuck ? 'Update now did not start on the server. On the server type: sudo messageassistant update'
    : (l && l.at && l.result !== 'up_to_date' ? `Last update: ${when(Date.parse(l.at))} — ${l.message || l.result}` : '');
  showSource(u);
}
async function checkUpdates(fresh) {
  if (updBusy) return; updBusy = true;
  updLine('Checking…', 'busy'); $('#updCheck').disabled = true;
  try { showUpdates(fresh ? await api('POST', '/api/update/check', {}, CHECK_LIMIT_MS) : await api('GET', '/api/update', undefined, CHECK_LIMIT_MS)); }
  catch (er) { updLine('Couldn\'t reach the update source', 'err'); $('#updSub').textContent = er.timeout ? 'No answer in 15 seconds. Try again in a minute.' : er.message; }
  finally { updBusy = false; $('#updCheck').disabled = false; }
}
if ($('#updAuto')) $('#updAuto').onchange = async () => {
  try { showUpdates(await POST('/api/update/auto', { on: $('#updAuto').checked })); msg($('#updMsg'), $('#updAuto').checked ? 'Auto-update is on.' : 'Auto-update is off.', true); }
  catch (er) { msg($('#updMsg'), er.message); }
};
$('#updCheck').onclick = () => checkUpdates(true);
$('#usrc').onchange = () => { srcEditing = true; $('#usrcBox').classList.toggle('hidden', $('#usrc').value !== 'custom'); if ($('#usrc').value === 'custom') $('#usrcLink').focus(); };
$('#usrcLink').oninput = () => { srcEditing = true; };
$('#usrcSave').onclick = async () => {
  try {
    const r = $('#usrc').value === 'default' ? await POST('/api/update/source/reset') : await POST('/api/update/source', { url: $('#usrcLink').value });
    srcEditing = false; showSource(r); msg($('#usrcMsg'), r.source ? 'Saved.' : 'Saved: using the default.', true); checkUpdates(true);
  } catch (er) { msg($('#usrcMsg'), er.message); }
};
$('#usrcReset').onclick = async () => {
  try { const r = await POST('/api/update/source/reset'); srcEditing = false; showSource(r); msg($('#usrcMsg'), 'Back to the default.', true); checkUpdates(true); }
  catch (er) { msg($('#usrcMsg'), er.message); }
};
$('#updNow').onclick = async () => {
  if (!confirm('Update now? The assistant restarts for about a minute.')) return;
  try {
    const r = await POST('/api/update/now'); msg($('#updMsg'), r.words, true); $('#updNow').disabled = true;
    const was = (await api('GET', '/api/update', undefined, CHECK_LIMIT_MS)).current; let n = 0;
    const t = setInterval(async () => {
      n++; try { const u = await api('GET', '/api/update/log', undefined, CHECK_LIMIT_MS); if (u.log) { $('#updLog').classList.remove('hidden'); $('#updLog').textContent = u.log; $('#updLog').scrollTop = 1e9; } if (!u.pending || u.current !== was || n > 60) { clearInterval(t); showUpdates(u); if (u.current !== was) { msg($('#updMsg'), 'Updated to ' + u.current + '. Reloading…', true); setTimeout(() => reloadIfNewVersion(u.current), 1500); } } } catch {}
    }, 5000);
  } catch (er) { msg($('#updMsg'), er.message); }
};

$('#saveSettings').onclick = async () => {
  const b = { admin_phones: $('#adminPhones').value };
  $$('[data-s]', $('#setForm')).forEach(i => { b[i.dataset.s] = i.type === 'checkbox' ? (i.checked ? '1' : '0') : i.value; });
  try { await POST('/api/settings', b); msg($('#setMsg'), 'Saved.', true); } catch (er) { msg($('#setMsg'), er.message); }
};
$('#backupBtn').onclick = async () => { try { const r = await POST('/api/backup'); msg($('#setMsg'), 'Saved ' + r.file, true); } catch (er) { msg($('#setMsg'), er.message); } };
$('#pwSave').onclick = async () => {
  try { await POST('/api/password', { username: $('#pwUser').value, current: $('#pwCur').value, password: $('#pwNew').value }); alert('Password changed. Sign in again.'); showLogin(); }
  catch (er) { msg($('#pwMsg'), er.message); }
};

// ---------------- start ----------------
(async () => {
  try { const me = await GET('/api/me'); if (me.signed_in) { CSRF = me.csrf; showApp(); } else showLogin(); }
  catch { showLogin(); }
})();
