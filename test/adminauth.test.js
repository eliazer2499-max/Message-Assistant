// Admin login: a 6-digit code texted through the Messages session, or username + password. Rate limits. CSRF.
import { setupEnv, until, sleep, client } from './helpers.js';
setupEnv('auth', { MSA_ADMIN_PHONE: '+16465550100' });
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const { MockChannel } = await import('../src/channels/mock.js');
const db = await import('../src/db.js');
const auth = await import('../src/adminauth.js');

const ch = new MockChannel();
const app = await main({ channel: ch, port: 0 });
const base = `http://127.0.0.1:${app.port}`;
test.after(() => app.stop());
const codeTexts = () => ch.sent.filter(s => s.phone === '+16465550100' && /admin code is/.test(s.text));
const codeOf = (t) => /code is (\d{6})/.exec(t)[1];

test('dashboard data needs a session', async () => {
  const c = client(base);
  assert.equal((await c.get('/api/overview')).status, 401);
  assert.equal((await c.get('/api/keys')).status, 401);
  assert.equal((await c.post('/api/users/1/approve')).status, 401);
});

test('phone login: the code arrives by text through Messages and signs in', async () => {
  const c = client(base);
  const r = await c.post('/api/login/code', { phone: '(646) 555-0100' });
  assert.equal(r.status, 200);
  assert.match(r.data.message, /If that number belongs to the admin/);
  await until(() => codeTexts().length === 1, 3000, 'code text');
  const code = codeOf(codeTexts()[0].text);
  const stored = db.get('SELECT code_hash FROM admin_codes ORDER BY id DESC LIMIT 1').code_hash;
  assert.ok(!stored.includes(code), 'only a hash of the code is stored');
  assert.equal((await c.post('/api/login/verify', { phone: '+16465550100', code: '000000' === code ? '111111' : '000000' })).status, 401);
  const ok = await c.post('/api/login/verify', { phone: '+16465550100', code });
  assert.equal(ok.status, 200);
  assert.match(c.state().cookie, /^msa_sid=/);
  assert.equal((await c.get('/api/overview')).status, 200);
  // a code works once
  const again = client(base);
  assert.equal((await again.post('/api/login/verify', { phone: '+16465550100', code })).status, 401);
});

test('a number that is not the admin gets the same answer and no text', async () => {
  const before = ch.sent.length;
  const r = await client(base).post('/api/login/code', { phone: '+12125559999' });
  assert.equal(r.status, 200);
  assert.match(r.data.message, /If that number belongs to the admin/);
  await sleep(200);
  assert.equal(ch.sent.length, before);
});

test('codes are rate-limited: one a minute, five an hour per number', async () => {
  const c = client(base);
  const r1 = await c.post('/api/login/code', { phone: '+16465550100' });
  assert.equal(r1.status, 429, 'second code inside a minute');
  for (let i = 0; i < 4; i++) {
    db.run('UPDATE admin_codes SET created=created-61000');          // pretend a minute passed
    assert.equal((await c.post('/api/login/code', { phone: '+16465550100' })).status, 200, 'code ' + (i + 2));
  }
  db.run('UPDATE admin_codes SET created=created-61000');
  const r6 = await c.post('/api/login/code', { phone: '+16465550100' });
  assert.equal(r6.status, 429);
  assert.match(r6.data.error, /Too many codes/);
});

test('a code dies after 5 wrong guesses, and only the newest code works', async () => {
  db.run('DELETE FROM attempts'); db.run('UPDATE admin_codes SET created=created-3600000');
  const c = client(base);
  await c.post('/api/login/code', { phone: '+16465550100' });
  await until(() => codeTexts().length >= 1);
  await sleep(100);
  const code = codeOf(codeTexts().at(-1).text);
  const wrong = code === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) { db.run("DELETE FROM attempts WHERE kind='login_ip'"); assert.equal((await c.post('/api/login/verify', { phone: '+16465550100', code: wrong })).status, 401); }
  db.run("DELETE FROM attempts WHERE kind='login_ip'");
  const r = await c.post('/api/login/verify', { phone: '+16465550100', code });
  assert.equal(r.status, 401);
  assert.match(r.data.error, /Too many wrong tries/);
});

test('when Messages is down the admin is told to use the password', async () => {
  db.run('DELETE FROM attempts'); db.run('UPDATE admin_codes SET created=created-3600000');
  ch.setState('phone_offline');
  const r = await client(base).post('/api/login/code', { phone: '+16465550100' });
  assert.equal(r.status, 200);
  assert.match(r.data.hint, /username \+ password/);
  ch.setState('connected');
});

test('password login (hashed), wrong passwords lock out after 5 tries', async () => {
  auth.setPassword('a-very-good-pass', 'admin');
  const stored = db.get("SELECT v FROM secrets WHERE k='admin_password_hash'").v;
  assert.ok(!stored.includes('a-very-good-pass'));
  db.run('DELETE FROM attempts');
  const c = client(base);
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/login/password', { username: 'admin', password: 'nope' + i })).status, 401);
  const locked = await c.post('/api/login/password', { username: 'admin', password: 'a-very-good-pass' });
  assert.equal(locked.status, 429);
  db.run('DELETE FROM attempts');
  assert.equal((await c.post('/api/login/password', { username: 'ADMIN', password: 'a-very-good-pass' })).status, 200);
  assert.equal((await c.get('/api/overview')).status, 200);
});

test('changes need the CSRF token; logout ends the session', async () => {
  db.run('DELETE FROM attempts');
  const c = client(base);
  await c.post('/api/login/password', { username: 'admin', password: 'a-very-good-pass' });
  c.forgetCsrf();
  assert.equal((await c.post('/api/settings', { daily_limit: '5' })).status, 403);
  const me = await c.get('/api/me');
  assert.ok(me.data.csrf);
  assert.equal((await c.post('/api/settings', { daily_limit: '5' })).status, 200);
  await c.post('/api/logout');
  assert.equal((await c.get('/api/overview')).status, 401);
});

test('changing the password signs everyone out', async () => {
  db.run('DELETE FROM attempts');
  const c = client(base);
  await c.post('/api/login/password', { username: 'admin', password: 'a-very-good-pass' });
  const r = await c.post('/api/password', { current: 'a-very-good-pass', password: 'another-good-one' });
  assert.equal(r.status, 200);
  assert.equal((await c.get('/api/overview')).status, 401);
  assert.equal((await client(base).post('/api/login/password', { username: 'admin', password: 'another-good-one' })).status, 200);
});
