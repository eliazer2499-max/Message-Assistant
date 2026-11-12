// 1.0.8: phone sign-in shows ALL of the person's chats; Connect accounts (Google, read only, with a fake Google here);
// the admin signs in the same way and gets "Manage system"; access until a date (1 month / a date / no end) with ONE
// polite "access ended" text; fewer AI calls per reply (plain chat = 1 call, tool rounds capped); old chats are not
// answered after a restart.
import { setupEnv, until, sleep, client } from './helpers.js';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = '+16465550100';
// a fake Google (OAuth + the read-only APIs) and a fake search page, on this computer only
const G = { tokens: 0, refreshes: 0, revoked: [], lastAuth: null };
const fakeG = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const u = new URL(req.url, 'http://x'); const j = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/token') {
    const f = new URLSearchParams(b);
    if (f.get('client_secret') !== 'test-secret-1234567') return j({ error: 'invalid_client' }, 401);
    if (f.get('grant_type') === 'authorization_code') { if (f.get('code') !== 'good-code') return j({ error: 'invalid_grant' }, 400); G.tokens++; return j({ access_token: 'ya29.fake-access-' + G.tokens, refresh_token: '1//fake-refresh-token', expires_in: 1, scope: 'openid email gmail.readonly', token_type: 'Bearer' }); }
    if (f.get('grant_type') === 'refresh_token') { G.refreshes++; return j({ access_token: 'ya29.fake-access-r' + G.refreshes, expires_in: 3600 }); }
    return j({ error: 'unsupported_grant_type' }, 400);
  }
  if (u.pathname === '/userinfo') return j({ email: 'moshe@example.com' });
  if (u.pathname === '/revoke') { G.revoked.push(u.searchParams.get('token')); return j({}); }
  const auth = req.headers.authorization || '';
  if (!/^Bearer ya29\.fake-access-/.test(auth)) return j({ error: { message: 'no token' } }, 401);
  if (u.pathname === '/calendar/v3/calendars/primary/events') return j({ items: [{ summary: 'Dentist', start: { dateTime: '2026-11-13T10:00:00-05:00' }, end: { dateTime: '2026-11-13T11:00:00-05:00' }, location: 'Main St' }] });
  if (u.pathname === '/gmail/v1/users/me/messages') return j({ messages: [{ id: 'm1' }] });
  if (u.pathname === '/gmail/v1/users/me/messages/m1') return j({ snippet: 'Your order shipped', labelIds: ['UNREAD'], payload: { headers: [{ name: 'From', value: 'Shop <s@shop.com>' }, { name: 'Subject', value: 'Shipped!' }, { name: 'Date', value: 'Thu, 12 Nov 2026' }] } });
  if (u.pathname === '/drive/v3/files') return j({ files: [{ name: 'Budget 2026', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-11-01T00:00:00Z', webViewLink: 'https://docs.example/x' }] });
  if (u.pathname === '/html/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<a class="result__a" href="https://example.com/a">A result</a><a class="result__snippet">snippet</a>'); }
  j({ error: 'nope' }, 404);
});
await new Promise(r => fakeG.listen(0, '127.0.0.1', r));
const GB = `http://127.0.0.1:${fakeG.address().port}`;
setupEnv('v108', { MSA_MOCK_MODULE: path.join(HERE, 'mock-greedy.js'), MSA_ADMIN_PHONE: ADMIN, MSA_PUBLIC_URL: 'https://msg.example.com', MSA_SEARCH_BASE: GB,
  MSA_GOOGLE_AUTH_URL: GB + '/auth', MSA_GOOGLE_TOKEN_URL: GB + '/token', MSA_GOOGLE_API_URL: GB, MSA_GOOGLE_USERINFO_URL: GB + '/userinfo', MSA_GOOGLE_REVOKE_URL: GB + '/revoke' });
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const { MockChannel } = await import('../src/channels/mock.js');
const db = await import('../src/db.js');
const auth = await import('../src/adminauth.js');
const users = await import('../src/users.js');
const portal = await import('../src/portal.js');
const INTEG = await import('../src/integrations.js');
const { execTool, declarations, TOOLS } = await import('../src/tools/index.js');
const { plainChat } = await import('../src/agent.js');
const { approveAndWelcome } = await import('../src/router.js');
const { listTimeIsOld } = await import('../src/channels/gmweb.js');
const greedy = await import('./mock-greedy.js');

const ch = new MockChannel();
const app = await main({ channel: ch, port: 0 });
const base = `http://127.0.0.1:${app.port}`;
test.after(async () => { await app.stop(); fakeG.close(); });
const P = '+17185550301';
const texts = (p) => ch.sent.filter(s => s.phone === p && s.text).map(s => s.text);
const codeFor = async (p, n = 1) => { const t = await until(() => texts(p).filter(x => /web chat code is \d{6}/.test(x))[n - 1], 5000, 'code'); return /(\d{6})/.exec(t)[1]; };
let u, pc;
const signIn = async (phone, n = 1) => { const c = client(base); await c.post('/api/u/login/code', { phone }); const code = await codeFor(phone, n); const r = await c.post('/api/u/login/verify', { phone, code }); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; };

test('setup: one approved person', async () => {
  ch.inject({ phone: P, text: 'hello there' });
  u = await until(() => users.userByPhone(P));
  approveAndWelcome(u.id, 'admin');
  await until(() => texts(P).length >= 2, 5000, 'waiting + welcome');
});

test('plain chat is ONE AI call with no tools; a question that needs the web is capped at tool_rounds (3) + the answer', async () => {
  assert.equal(plainChat('hi'), true); assert.equal(plainChat('Thanks so much!'), true); assert.equal(plainChat('good night 🙏'), true);
  assert.equal(plainChat('what time is candle lighting today?'), false); assert.equal(plainChat('remind me at 6 to call mom'), false); assert.equal(plainChat('check https://x.com'), false);
  greedy.calls.length = 0;
  ch.inject({ phone: P, text: 'thanks!' });
  await until(() => texts(P).some(t => t === 'answer to: thanks!'), 8000, 'answer');
  assert.equal(greedy.calls.length, 1, 'one AI call'); assert.equal(greedy.calls[0].tools, 0, 'no tool list sent');
  const job = db.get("SELECT * FROM jobs WHERE text='thanks!'"); const tm = JSON.parse(job.timing);
  assert.equal(tm.ai_calls, 1); assert.equal(tm.fast, true); assert.ok(tm.total_ms >= 0 && tm.queued_ms >= 0);
  greedy.calls.length = 0;
  ch.inject({ phone: P, text: 'what are the store hours on sunday?' });
  await until(() => texts(P).some(t => t.startsWith('answer to: what are the store')), 15000, 'answer');
  assert.equal(greedy.calls.length, 4, 'three rounds of searching, then the answer (1.0.7: up to 12)');
  assert.equal(greedy.calls.at(-1).noTools, true);
  assert.ok(db.get('SELECT searches FROM usage WHERE user_id=?', u.id).searches <= 3);
});

test('plain chat that turns out to need tools: the model says NEED_TOOLS and gets them; "yes" after our question uses tools', async () => {
  assert.equal(plainChat('write shop index.html <h1>x</h1>'), false); assert.equal(plainChat('paste demo'), false); assert.equal(plainChat('shot cafe'), false);
  users.addMessage(u.id, 'assistant', 'Glad to help.');
  greedy.calls.length = 0;
  ch.inject({ phone: P, text: 'sing me a song' });
  await until(() => texts(P).some(t => t === 'answer to: sing me a song'), 15000, 'answer');
  assert.equal(greedy.calls[0].tools, 0); assert.ok(greedy.calls[1].tools > 0, 'second call has the tools');
  users.addMessage(u.id, 'assistant', 'Shall I look that up for you?');
  greedy.calls.length = 0;
  ch.inject({ phone: P, text: 'yes' });
  await until(() => texts(P).some(t => t === 'answer to: yes'), 15000, 'answer');
  assert.ok(greedy.calls[0].tools > 0, 'after our own question, "yes" goes the full way');
});

test('access until a date: 1 month, a date, ended = one polite text then silence, extended = answered again', async () => {
  let r = users.setAccessUntil(u.id, { months: 1 });
  const inMonth = new Date(); inMonth.setMonth(inMonth.getMonth() + 1);
  assert.ok(Math.abs(r.access_until - inMonth.getTime()) < 5000);
  const api = client(base); auth.setPassword('pass-108-abcdef', 'admin'); await api.post('/api/login/password', { username: 'admin', password: 'pass-108-abcdef' });
  r = await api.post(`/api/users/${u.id}/access`, { until: '2026-01-31' });
  assert.equal(r.status, 200); assert.equal(new Date(r.data.user.access_until).getDate(), 31); assert.equal(r.data.user.access_ended, true);
  const list = (await api.get('/api/users')).data.users; assert.ok(list.find(x => x.id === u.id).access_until, 'the list shows the end date');
  const before = texts(P).length;
  ch.inject({ phone: P, text: 'are you there?' });
  await until(() => texts(P).length === before + 1, 5000, 'one text');
  assert.match(texts(P).at(-1), /access to .* has ended\. Please contact the admin/);
  ch.inject({ phone: P, text: 'hello??' }); ch.inject({ phone: P, text: 'please answer' });
  await sleep(800);
  assert.equal(texts(P).length, before + 1, 'told once, then silence');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND text IN ('are you there?','hello??','please answer')", u.id).n, 0, 'no AI calls after the end');
  r = await api.post(`/api/users/${u.id}/access`, { until: null });
  assert.equal(r.data.user.access_until, null);
  ch.inject({ phone: P, text: 'back again' });
  await until(() => texts(P).some(t => t === 'answer to: back again'), 8000, 'answered again');
  r = await api.post(`/api/users/${u.id}/access`, { until: 'soon' }); assert.equal(r.status, 400);
});

test('phone sign-in: ALL his chats (older pages too), his own only', async () => {
  for (let i = 0; i < 230; i++) users.addMessage(u.id, i % 2 ? 'assistant' : 'user', 'old line ' + i);
  db.run('UPDATE messages SET ts = ts - 86400000 * 40 WHERE text LIKE ?', 'old line %');
  const c = pc = await signIn(P);
  const me = (await c.get('/api/u/me')).data;
  assert.equal(me.signed_in, true); assert.equal(me.is_admin, false); assert.ok(me.oldest > 0);
  const first = (await c.get('/api/u/chat')).data;
  assert.equal(first.items.length, 200);
  const older = (await c.get('/api/u/chat?before=' + first.items[0].ts)).data;
  assert.ok(older.items.length > 0 && older.items.every(i => i.ts < first.items[0].ts), 'earlier messages page');
  assert.ok([...first.items, ...older.items].some(i => i.text === 'old line 1' && i.who === 'bot'), 'old answers kept in history show too');
  const r = await c.post('/api/u/manage'); assert.equal(r.status, 403, 'not the admin: no Manage system');
});

test('the admin signs in by phone like anyone, sees his chats, and "Manage system" opens the dashboard', async () => {
  const c = await signIn(ADMIN);
  const me = (await c.get('/api/u/me')).data;
  assert.equal(me.is_admin, true);
  const r = await c.post('/api/u/manage');
  assert.equal(r.status, 200); assert.equal(r.data.go, '/');
  const s = await c.get('/api/settings');
  assert.equal(s.status, 200, 'the same browser now has the admin dashboard'); assert.ok(s.data.settings);
  const d = client(base); await d.post('/api/login/password', { username: 'admin', password: 'pass-108-abcdef' });
  const mc = await d.post('/api/my-chats'); assert.equal(mc.status, 200); assert.equal(mc.data.go, '/me');
  assert.equal((await d.get('/api/u/me')).data.is_admin, true, 'dashboard → My chats signs him in to his own page');
});

test('Connect accounts: admin adds his Google client; the person connects Google; the assistant reads it (read only); disconnect', async () => {
  const c = pc;
  let me = (await c.get('/api/u/me')).data;
  assert.equal(me.google_ready, false);
  assert.equal((await c.post('/api/u/connect/google')).status, 409, 'not set up yet');
  const api = client(base); await api.post('/api/login/password', { username: 'admin', password: 'pass-108-abcdef' });
  assert.equal((await api.post('/api/integrations/google', { client_id: 'nope' })).status, 400);
  let g = (await api.post('/api/integrations/google', { client_id: '1234-abc.apps.googleusercontent.com', client_secret: 'test-secret-1234567' })).data.google;
  assert.equal(g.ready, true); assert.equal(g.redirect_uri, 'https://msg.example.com/oauth/google/callback');
  assert.equal(JSON.stringify((await api.get('/api/integrations')).data).includes('test-secret'), false, 'the secret never comes back');
  const st = (await c.post('/api/u/connect/google')).data;
  const au = new URL(st.url);
  assert.equal(au.searchParams.get('client_id'), '1234-abc.apps.googleusercontent.com');
  assert.equal(au.searchParams.get('redirect_uri'), 'https://msg.example.com/oauth/google/callback');
  assert.match(au.searchParams.get('scope'), /gmail\.readonly/); assert.doesNotMatch(au.searchParams.get('scope'), /gmail\.send|gmail\.modify|auth\/calendar(\s|$)|auth\/drive(\s|$)/);
  assert.equal(au.searchParams.get('access_type'), 'offline');
  // a wrong / old state does nothing
  let cb = await fetch(base + '/oauth/google/callback?code=good-code&state=forged', { redirect: 'manual' });
  assert.equal(cb.status, 302); assert.match(cb.headers.get('location'), /connect_error=/);
  cb = await fetch(base + `/oauth/google/callback?code=good-code&state=${au.searchParams.get('state')}`, { redirect: 'manual' });
  assert.equal(cb.status, 302); assert.equal(cb.headers.get('location'), '/me?connected=google#accounts');
  me = (await c.get('/api/u/me')).data;
  assert.equal(me.connections.length, 1); assert.equal(me.connections[0].account, 'moshe@example.com'); assert.equal(me.connections[0].status, 'connected');
  // tokens are sealed: not in the database as plain text
  const raw = db.all('SELECT v FROM secrets').map(r => r.v).join('|');
  assert.equal(raw.includes('fake-refresh-token') || raw.includes('test-secret-1234567'), false);
  // the AI gets the Google tools only for him, and they read
  assert.ok(TOOLS.every(Boolean), 'no holes in the tool list');
  assert.ok(declarations(undefined, users.userById(u.id)).some(t => t.name === 'gmail_recent'));
  const other = users.userByPhone(ADMIN);
  assert.equal(declarations(undefined, other).some(t => t.name === 'gmail_recent'), false, 'not for someone who did not connect');
  assert.match(String((await execTool('gmail_recent', {}, { userId: other.id })).error), /No Google account/);
  await sleep(1100);          // the first access token (1 s) runs out: it is refreshed by itself
  const cal = await execTool('google_calendar_upcoming', { days: 3 }, { userId: u.id });
  assert.equal(cal.events[0].title, 'Dentist'); assert.equal(G.refreshes, 1);
  const mail = await execTool('gmail_recent', { query: 'is:unread' }, { userId: u.id });
  assert.equal(mail.emails[0].subject, 'Shipped!'); assert.equal(mail.emails[0].unread, true);
  const files = await execTool('drive_find', { name: 'Budget' }, { userId: u.id });
  assert.equal(files.files[0].name, 'Budget 2026');
  // disconnect: revoked at Google and gone here
  const rm = await c.post(`/api/u/connections/${me.connections[0].id}/remove`);
  assert.equal(rm.status, 200); assert.equal(G.revoked.length, 1);
  assert.equal((await c.get('/api/u/connections')).data.connections.length, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM secrets WHERE k LIKE 'conn_token_%'").n, 0);
});

test('old chats are not answered after a restart: the list time says when its last message came', () => {
  const now = new Date(2026, 10, 12, 0, 5).getTime(), start = now - 60000, cutoff = start - 600000;
  for (const old of ['Oct 29', 'Mon', 'Yesterday', '10/29/25', '11:30 PM', '1 h']) assert.equal(listTimeIsOld(old, cutoff, now), true, old);
  for (const fresh of ['Now', 'Just now', '2 min', '5m', '12:03 AM', '']) assert.equal(listTimeIsOld(fresh, cutoff, now), false, fresh);
});
