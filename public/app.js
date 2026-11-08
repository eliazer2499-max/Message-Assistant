// Message Assistant admin dashboard (no framework; works on a phone).
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
let CSRF = '', VIEW = 'home', screenTimer = null, overviewTimer = null, peopleStatus = 'pending', KEYS = [], PRESETS = [], editingKey = null;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (t) => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return new Date(t).toLocaleDateString(); };
const when = (t) => t ? new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
function msg(node, text, ok = false) { node.textContent = text || ''; node.className = 'msg ' + (text ? (ok ? 'ok' : 'err') : ''); }

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(CSRF ? { 'X-CSRF-Token': CSRF } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
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
  if (v === 'home') refreshOverview(); if (v === 'people') loadPeople(); if (v === 'keys') loadKeys(); if (v === 'settings') loadSettings();
  if (v === 'connect') { loadConnect(); screenTimer = setInterval(loadConnect, 1500); }
}
const STATE_CLASS = { connected: 'ok', phone_offline: 'warn', pairing: 'warn', signed_out: 'bad', error: 'bad', other_tab: 'warn' };

// ---------------- home ----------------
async function refreshOverview() {
  let o; try { o = await GET('/api/overview'); } catch { return; }
  const m = o.messages, cls = STATE_CLASS[m.state] || '';
  $('#connDot').className = 'dot ' + (cls === 'ok' ? 'ok' : cls === 'bad' ? 'bad' : 'warn');
  const down = m.state !== 'connected';
  $('#banner').classList.toggle('hidden', !down);
  if (down) $('#banner').textContent = `Google Messages: ${m.words}. Texts wait until it is fixed (Connect tab).${m.outbox_waiting ? ' ' + m.outbox_waiting + ' waiting.' : ''}`;
  if (VIEW !== 'home') { badge(o.people.pending); return; }
  $('#homeConn').innerHTML = `<h2>Google Messages</h2><p class="state ${cls}">${esc(m.words)}</p><p class="muted small">since ${ago(m.since)}${m.detail ? ' · ' + esc(m.detail) : ''}${m.outbox_waiting ? ' · ' + m.outbox_waiting + ' text(s) waiting to go out' : ''}</p>${down ? '<button class="primary" id="toConnect">Open Connect</button>' : ''}`;
  const tc = $('#toConnect'); if (tc) tc.onclick = () => go('connect');
  $('#alerts').innerHTML = o.alerts.length ? o.alerts.map(a => `<div class="alert ${a.level}">${esc(a.text)}<div class="muted small">${when(a.ts)}</div></div>`).join('') : '<p class="muted small">No alerts.</p>';
  $('#homeCounts').innerHTML = `<div class="stat"><b>${o.people.pending}</b><span>waiting</span></div><div class="stat"><b>${o.people.approved}</b><span>approved</span></div><div class="stat"><b>${o.today.messages}</b><span>texts today</span></div>`;
  $('#homeKeys').innerHTML = o.keys.length ? o.keys.map(k => `<span class="chip ${k.status}">${esc(k.name)} · ${statusWord(k.status)}</span>`).join('') : '<p class="muted small">No AI keys yet. Add one in the AI keys tab.</p>';
  $('#homeQueue').innerHTML = `<div class="kv"><span>Thinking now</span><b>${o.queue.running}</b><span>Waiting in line</span><b>${o.queue.queued}</b><span>Waiting for a free AI key</span><b>${o.queue.waiting_for_ai}</b><span>Browser steps running / waiting</span><b>${o.browser.running} / ${o.browser.waiting}</b><span>Replies today</span><b>${o.today.replies}</b></div>`;
  badge(o.people.pending);
}
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

// ---------------- connect (live view of the server's browser) ----------------
let shotUrl = null, loadingShot = false;
async function loadConnect() {
  if (VIEW !== 'connect' || document.hidden) return;
  try {
    const s = await GET('/api/messages/status');
    const cls = STATE_CLASS[s.state] || '';
    $('#cState').className = 'state ' + cls; $('#cState').textContent = s.words + (s.detail ? ' — ' + s.detail : '');
    $('#qrCard').classList.toggle('hidden', !s.qr); if (s.qr) $('#qrImg').src = s.qr;
  } catch {}
  if (loadingShot) return; loadingShot = true;
  try {
    const r = await fetch('/api/messages/screen', { credentials: 'same-origin' });
    if (r.status === 200) { const b = await r.blob(); const u = URL.createObjectURL(b); $('#screen').src = u; if (shotUrl) URL.revokeObjectURL(shotUrl); shotUrl = u; $('#screenNote').textContent = 'Live (tap the picture to click there).'; }
    else $('#screenNote').textContent = r.status === 204 ? 'No picture (Messages is in test mode or the browser is starting).' : 'Picture not available (' + r.status + ').';
  } catch { } finally { loadingShot = false; }
}
$('#screen').onclick = async (e) => {
  const r = e.target.getBoundingClientRect();
  await POST('/api/messages/input', { type: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }).catch(er => alert(er.message));
  loadConnect();
};
$('#typeBtn').onclick = async () => { const t = $('#typeText').value; if (!t) return; await POST('/api/messages/input', { type: 'text', text: t }).catch(er => alert(er.message)); $('#typeText').value = ''; loadConnect(); };
$$('[data-key]').forEach(b => b.onclick = () => POST('/api/messages/input', { type: 'key', key: b.dataset.key }).then(loadConnect).catch(er => alert(er.message)));
$$('[data-act]').forEach(b => b.onclick = () => {
  const a = b.dataset.act;
  const body = a === 'scrollDown' ? { type: 'scroll', dy: 1 } : a === 'scrollUp' ? { type: 'scroll', dy: -1 } : a === 'messages' ? { type: 'goto', where: 'messages' } : a === 'signin' ? { type: 'goto', where: 'signin' } : { type: a };
  POST('/api/messages/input', body).then(loadConnect).catch(er => alert(er.message));
});
$('#gmRestart').onclick = () => POST('/api/messages/restart').then(loadConnect).catch(er => alert(er.message));
$('#gmSignout').onclick = () => { if (confirm('Unpair and sign out of Google in the server browser? You will need to sign in and scan the QR code again.')) POST('/api/messages/signout').then(loadConnect).catch(er => alert(er.message)); };
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

// ---------------- settings ----------------
async function loadSettings() {
  const d = await GET('/api/settings');
  $$('[data-s]', $('#setForm')).forEach(i => { const v = d.settings[i.dataset.s] ?? ''; if (i.type === 'checkbox') i.checked = v === '1'; else i.value = v; });
  $('#adminPhones').value = d.admin_phones.join(', '); $('#pwUser').value = d.admin_username || 'admin';
  const a = await GET('/api/activity');
  $('#activity').innerHTML = a.items.map(x => `<div><span class="muted">${when(x.ts)}</span> <b>${esc(x.action)}</b> ${esc(x.detail)}</div>`).join('');
  const me = await GET('/api/me'); $('#ver').textContent = 'Message Assistant ' + me.version;
  loadUpdates();
}
// ---------------- updates (1.0.1) ----------------
function showUpdates(u) {
  const latest = u.latest ? u.latest : '(could not check' + (u.check_error ? ': ' + u.check_error : '') + ')';
  $('#updVer').textContent = `This server: ${u.current} · Latest: ${latest}` + (u.update_available ? ' · update available' : (u.latest ? ' · up to date' : ''));
  if ($('#updAuto')) $('#updAuto').checked = !!u.auto;
  $('#updNow').disabled = !!u.pending;
  const l = u.last;
  $('#updLast').textContent = u.pending ? 'An update is starting…' : (l && l.at ? `Last update check: ${when(Date.parse(l.at))} — ${l.message || l.result}` : '');
}
async function loadUpdates(fresh) {
  try { showUpdates(fresh ? await POST('/api/update/check') : await GET('/api/update')); } catch (er) { msg($('#updMsg'), er.message); }
}
if ($('#updAuto')) $('#updAuto').onchange = async () => {
  try { showUpdates(await POST('/api/update/auto', { on: $('#updAuto').checked })); msg($('#updMsg'), $('#updAuto').checked ? 'Auto-update is on.' : 'Auto-update is off.', true); }
  catch (er) { msg($('#updMsg'), er.message); }
};
$('#updCheck').onclick = () => loadUpdates(true);
$('#updNow').onclick = async () => {
  if (!confirm('Update now? The assistant restarts for about a minute.')) return;
  try {
    const r = await POST('/api/update/now'); msg($('#updMsg'), r.words, true); $('#updNow').disabled = true;
    const was = (await GET('/api/update')).current; let n = 0;
    const t = setInterval(async () => {
      n++; try { const u = await GET('/api/update'); if (!u.pending || u.current !== was || n > 60) { clearInterval(t); showUpdates(u); if (u.current !== was) msg($('#updMsg'), 'Updated to ' + u.current + '.', true); } } catch {}
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
