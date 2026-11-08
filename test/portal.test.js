// 1.0.2: the person's own web chat at /me — sign-in by a texted code (approved people only, same answer for every
// number), its own cookie (never the admin's), their own chat only, web texts answered on the web AND by text,
// phone texts showing on the web, the one YES from the web, on/off by the admin, logout, expiry, safe formatting.
import { setupEnv, until, sleep, client } from './helpers.js';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(HERE, 'mock-model.js');
const ADMIN = '+16465550100';
setupEnv('portal', { MSA_MOCK_MODULE: MOCK, MSA_ADMIN_PHONE: ADMIN, MSA_PUBLIC_URL: 'https://msg.example.com' });
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const { MockChannel } = await import('../src/channels/mock.js');
const db = await import('../src/db.js');
const auth = await import('../src/adminauth.js');
const users = await import('../src/users.js');
const portal = await import('../src/portal.js');
const F = await import('../src/siteflow.js');
const { approveAndWelcome } = await import('../src/router.js');
const { renderMarkdown } = await import('../public/markdown.js');
F.setShooter(async () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

const ch = new MockChannel();
const app = await main({ channel: ch, port: 0 });
const base = `http://127.0.0.1:${app.port}`;
test.after(() => app.stop());
const A = '+17185550201', B = '+17185550202', P = '+17185550203';
const texts = (p) => ch.sent.filter(s => s.phone === p && s.text).map(s => s.text);
const codeFor = async (p, n = 1) => { const t = await until(() => texts(p).filter(x => /web chat code is \d{6}/.test(x))[n - 1], 5000, 'code'); return /(\d{6})/.exec(t)[1]; };
let ua, ub;
async function signIn(phone, n = 1) {
  const c = client(base);
  const r = await c.post('/api/u/login/code', { phone });
  assert.equal(r.data.message, portal.SAME);
  const v = await c.post('/api/u/login/verify', { phone, code: await codeFor(phone, n) });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return c;
}

test('setup', async () => {
  for (const p of [A, B, P]) ch.inject({ phone: p, text: 'hi' });
  ua = await until(() => users.userByPhone(A)); ub = await until(() => users.userByPhone(B)); await until(() => users.userByPhone(P));
  approveAndWelcome(ua.id); approveAndWelcome(ub.id);       // P stays pending
  await until(() => texts(A).length >= 2 && texts(B).length >= 2);
});

test('sign-in: only approved people get a code; the answer is the same for everyone', async () => {
  const c = client(base);
  for (const p of [P, '+12125550999']) {
    const r = await c.post('/api/u/login/code', { phone: p });
    assert.equal(r.status, 200); assert.equal(r.data.message, portal.SAME);
  }
  await sleep(150);
  assert.equal(texts(P).filter(t => /code/.test(t)).length, 0, 'pending person: no code');
  assert.equal(ch.sent.filter(s => s.phone === '+12125550999').length, 0, 'stranger: nothing sent');
  assert.equal((await c.post('/api/u/login/verify', { phone: P, code: '123456' })).status, 401);
  // approved: one code a minute (asking again gives the same answer but no second code)
  await c.post('/api/u/login/code', { phone: A });
  await c.post('/api/u/login/code', { phone: A });
  await sleep(150);
  assert.equal(texts(A).filter(t => /web chat code/.test(t)).length, 1);
  // wrong code, then the right one
  assert.equal((await c.post('/api/u/login/verify', { phone: A, code: '000000' })).status, 401);
  const ok = await c.post('/api/u/login/verify', { phone: A, code: await codeFor(A) });
  assert.equal(ok.status, 200);
  const me = await c.get('/api/u/me');
  assert.equal(me.data.signed_in, true); assert.equal(me.data.phone, A);
  // the code works once
  const c2 = client(base);
  assert.equal((await c2.post('/api/u/login/verify', { phone: A, code: await codeFor(A) })).status, 401);
});

test('5 wrong codes → that code stops working', async () => {
  db.run('DELETE FROM user_codes WHERE user_id=?', ub.id);
  const c = client(base);
  await c.post('/api/u/login/code', { phone: B });
  const good = await codeFor(B);
  const bad = good === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) { db.run('DELETE FROM attempts WHERE kind=?', 'ulogin_ip'); await c.post('/api/u/login/verify', { phone: B, code: bad }); }
  db.run('DELETE FROM attempts WHERE kind=?', 'ulogin_ip');   // (the per-address limit would also stop it; check the per-code one)
  const r = await c.post('/api/u/login/verify', { phone: B, code: good });
  assert.equal(r.status, 401); assert.match(r.data.error, /Too many wrong tries/);
});

test('a user session never opens the admin dashboard, and the admin cookie never opens a web chat', async () => {
  db.run('DELETE FROM user_codes'); db.run("DELETE FROM attempts WHERE kind LIKE 'u%'");
  const c = await signIn(A, 2);
  for (const p of ['/api/overview', '/api/users', '/api/sites', '/api/settings', '/api/keys']) assert.equal((await c.get(p)).status, 401, p);
  assert.equal((await c.post('/api/sites/settings', { approval: true })).status, 401);
  auth.setPassword('portal-pass-123', 'admin');
  const adm = client(base); await adm.post('/api/login/password', { username: 'admin', password: 'portal-pass-123' });
  assert.equal((await adm.get('/api/overview')).status, 200);
  assert.equal((await adm.get('/api/u/chat')).status, 401, 'admin cookie is not a user session');
  // CSRF: a user POST without the token is refused; a sandboxed site's request (Origin: null) is refused
  const st = c.state();
  let r = await fetch(base + '/api/u/send', { method: 'POST', headers: { Cookie: st.cookie, 'Content-Type': 'application/json' }, body: '{"text":"x"}' });
  assert.equal(r.status, 403);
  r = await fetch(base + '/api/u/send', { method: 'POST', headers: { Cookie: st.cookie, 'X-CSRF-Token': st.csrf, Origin: 'null', 'Content-Type': 'application/json' }, body: '{"text":"x"}' });
  assert.equal(r.status, 403);
});

test('web chat: own chat only; a web text is answered on the web AND texted; phone texts show on the web', async () => {
  db.run('DELETE FROM user_codes'); db.run("DELETE FROM attempts WHERE kind LIKE 'u%'");
  const ca = await signIn(A, 3);
  const cb = await signIn(B, 2);
  const n = texts(A).length;
  const r = await ca.post('/api/u/send', { text: 'what is 2+2 from the web', user_id: ub.id });   // a tampered id is ignored
  assert.equal(r.status, 200);
  await until(() => texts(A).slice(n).includes('echo: what is 2+2 from the web'), 5000, 'texted to the phone too');
  const chatA = (await ca.get('/api/u/chat')).data.items;
  assert.ok(chatA.some(i => i.who === 'me' && i.text === 'what is 2+2 from the web'));
  assert.ok(chatA.some(i => i.who === 'bot' && i.text === 'echo: what is 2+2 from the web'));
  // B's chat has none of it (and no way to ask for A's)
  const chatB = (await cb.get('/api/u/chat?user_id=' + ua.id)).data.items;
  assert.ok(!chatB.some(i => /2\+2/.test(i.text)));
  assert.ok(!JSON.stringify(chatB).includes(A));
  assert.ok(!chatB.some(i => /web chat code/.test(i.text)), 'login codes are never shown in the chat');
  // a text from the phone appears in the web chat
  ch.inject({ phone: B, text: 'hello from my phone' });
  await until(async () => (await cb.get('/api/u/chat')).data.items.some(i => i.text === 'echo: hello from my phone'), 5000, 'phone text on web');
  const after = (await cb.get('/api/u/chat')).data.items;
  assert.ok(after.some(i => i.who === 'me' && i.text === 'hello from my phone'));
  // commands work from the web too
  await cb.post('/api/u/send', { text: 'HELP' });
  await until(async () => (await cb.get('/api/u/chat')).data.items.some(i => /tips:/.test(i.text)), 5000, 'help');
  assert.ok((await cb.get('/api/u/chat')).data.items.some(i => i.who === 'me' && i.text === 'HELP'));
});

test('sites from the web: the one question, YES typed on the web publishes, the picture shows in the chat', async () => {
  const ca = await (async () => { db.run('DELETE FROM user_codes'); db.run("DELETE FROM attempts WHERE kind LIKE 'u%'"); return signIn(A, 4); })();
  await ca.post('/api/u/send', { text: 'write shop index.html <h1>Web shop</h1>' });
  await ca.post('/api/u/send', { text: 'publish shop' });
  await until(async () => (await ca.get('/api/u/chat')).data.items.some(i => /^Publish "shop"/.test(i.text)), 5000, 'question on web');
  const items = (await ca.get('/api/u/chat')).data.items;
  const pic = items.find(i => i.img);
  assert.ok(pic, 'picture in the web chat');
  assert.equal((await fetch(base + pic.img)).headers.get('content-type'), 'image/png');
  await ca.post('/api/u/send', { text: 'YES' });
  await until(async () => (await ca.get('/api/u/chat')).data.items.some(i => /^Live: https:\/\/msg\.example\.com\/sites\//.test(i.text)), 5000, 'live');
  assert.ok(texts(A).some(t => /^Live: /.test(t)), 'and texted');
});

test('rate limit, logout, blocked, expiry, admin switch (dashboard + CLI)', async () => {
  db.run('DELETE FROM user_codes'); db.run("DELETE FROM attempts WHERE kind LIKE 'u%'");
  const cb = await signIn(B, 3);
  db.run("DELETE FROM attempts WHERE kind='usend'");
  let last;
  for (let i = 0; i < 13; i++) last = await cb.post('/api/u/send', { text: 'm' + i });
  assert.equal(last.status, 429);
  // expiry
  db.run('UPDATE user_sessions SET expires=? WHERE user_id=?', Date.now() - 1, ub.id);
  assert.equal((await cb.get('/api/u/chat')).status, 401);
  db.run('UPDATE user_sessions SET expires=? WHERE user_id=?', Date.now() + 3600000, ub.id);
  assert.equal((await cb.get('/api/u/chat')).status, 200);
  // blocked → out at once
  users.block(ub.id);
  assert.equal((await cb.get('/api/u/chat')).status, 401);
  approveAndWelcome(ub.id);
  assert.equal((await cb.get('/api/u/chat')).status, 200);
  // logout
  await cb.post('/api/u/logout');
  assert.equal((await cb.get('/api/u/chat')).status, 401);
  // the admin turns it off (dashboard): everyone is signed out and no codes go out
  db.run('DELETE FROM user_codes'); db.run("DELETE FROM attempts WHERE kind LIKE 'u%'");
  const ca = await signIn(A, 5);
  const adm = client(base); await adm.post('/api/login/password', { username: 'admin', password: 'portal-pass-123' });
  await adm.post('/api/settings', { portal_enabled: '0' });
  assert.equal(portal.enabled(), false);
  assert.equal((await ca.get('/api/u/chat')).status, 401);
  assert.equal((await ca.post('/api/u/login/code', { phone: A })).status, 403);
  assert.equal((await ca.get('/api/u/me')).data.enabled, false);
  // and on again from the CLI
  const o = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(HERE, '..', 'src', 'cli.js'), 'portal', 'on'], { env: process.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(o.status, 0, o.stderr); assert.match(o.stdout, /Web chat for people: ON/);
  assert.equal(portal.enabled(), true);
  // the page itself is served at /me
  const page = await fetch(base + '/me');
  assert.equal(page.status, 200); assert.match(await page.text(), /Your chat on the web/);
});

test('replies are formatted safely in the web chat (no HTML from a message survives)', () => {
  assert.equal(renderMarkdown('**hi**'), '<p><strong>hi</strong></p>');
  for (const bad of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '<a href="javascript:1">x</a>']) {
    const h = renderMarkdown(bad);
    assert.doesNotMatch(h, /<script|<img|<a href="javascript/i, bad);
    assert.ok(!/<[a-z]+[^>]*\son\w+=/i.test(h), 'no live event attribute: ' + h);
  }
  assert.match(renderMarkdown('see https://msg.example.com/sites/a1-b/'), /<a href="https:\/\/msg\.example\.com\/sites\/a1-b\/" target="_blank" rel="noopener noreferrer nofollow">/);
});
