// 1.0.2: websites per person — isolation (incl. ../ tricks), limits, the one YES (approval off), the admin's approval
// (on: YES → live, NO → nothing), the 404 page, unpublish, the dashboard Sites page and the CLI switch.
import { setupEnv, until, sleep, client } from './helpers.js';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(HERE, 'mock-model.js');
const ADMIN = '+16465550100';
const dataDir = setupEnv('sites', { MSA_MOCK_MODULE: MOCK, MSA_ADMIN_PHONE: ADMIN, MSA_PUBLIC_URL: 'https://msg.example.com' });
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const { MockChannel } = await import('../src/channels/mock.js');
const db = await import('../src/db.js');
const auth = await import('../src/adminauth.js');
const { approveAndWelcome } = await import('../src/router.js');
const users = await import('../src/users.js');
const S = await import('../src/sites.js');
const F = await import('../src/siteflow.js');
const { execTool, declarations } = await import('../src/tools/index.js');

// a stand-in camera: a tiny PNG that names the folder it was given (the real one is a phone-size Chromium picture)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const shots = [];
F.setShooter(async (userId, dir) => { shots.push({ userId, dir }); return PNG; });

const ch = new MockChannel();
const app = await main({ channel: ch, port: 0 });
const base = `http://127.0.0.1:${app.port}`;
const api = client(base);
auth.setPassword('sites-pass-123', 'admin');
await api.post('/api/login/password', { username: 'admin', password: 'sites-pass-123' });
test.after(() => app.stop());

const A = '+17185550101', Bp = '+17185550102';
const texts = (p) => ch.sent.filter(s => s.phone === p && s.text).map(s => s.text);
const pics = (p) => ch.sent.filter(s => s.phone === p && s.media);
let ua, ub, adminU;
const say = (phone, text) => ch.inject({ phone, text });
const fetchSite = (u) => fetch(u.replace('https://msg.example.com', base));
const lastText = (p) => texts(p).at(-1);

test('setup: two approved people and the admin', async () => {
  say(A, 'hi'); say(Bp, 'hello');
  ua = await until(() => users.userByPhone(A)); ub = await until(() => users.userByPhone(Bp));
  users.updateUser(ua.id, { name: 'Moshe Green' }); users.updateUser(ub.id, { name: 'Rivka' });
  approveAndWelcome(ua.id); approveAndWelcome(ub.id);
  say(ADMIN, 'hi there');
  adminU = await until(() => users.userByPhone(ADMIN));
  await until(() => texts(A).length >= 2 && texts(Bp).length >= 2);
  assert.equal(S.slugOf(ua.id), 'moshe' + ua.id);
  assert.equal(S.slugOf(ub.id), 'rivka' + ub.id);
});

test('isolation: each person has their own files; ../, absolute paths, bad names and symlinks are refused', async () => {
  const ctxA = { userId: ua.id }, ctxB = { userId: ub.id };
  assert.ok((await execTool('file_write', { project: 'shop', path: 'index.html', content: '<h1>Moshe shop</h1>' }, ctxA)).written);
  assert.match((await execTool('file_read', { project: 'shop', path: 'index.html' }, ctxA)).text, /Moshe shop/);
  // B can't see A's project, even by name
  assert.match((await execTool('file_read', { project: 'shop', path: 'index.html' }, ctxB)).error, /No project/);
  assert.deepEqual((await execTool('project_list', {}, ctxB)).projects, []);
  // traversal in the path
  for (const bad of ['../../' + ua.id + '/shop/index.html', '../shop/index.html', '..\\..\\x', 'a/../../b', '.hidden', 'x/.git/config', 'a\0b'])
    assert.ok((await execTool('file_write', { project: 'p', path: bad, content: 'x' }, ctxB)).error, 'refused: ' + bad);
  assert.ok((await execTool('file_read', { project: 'shop', path: '../../' + ub.id + '/x' }, ctxA)).error);
  // traversal in the project name
  for (const bad of ['..', '../' + ua.id, '.', 'a/b', '/etc', '%2e%2e', ''])
    assert.ok((await execTool('file_write', { project: bad, path: 'index.html', content: 'x' }, ctxB)).error, 'refused project: ' + bad);
  // an absolute path stays inside the project
  const w = await execTool('file_write', { project: 'p', path: '/etc/passwd', content: 'mine' }, ctxB);
  assert.equal(w.written, path.join('etc', 'passwd'));
  assert.notEqual(fs.readFileSync('/etc/passwd', 'utf8'), 'mine');
  // a symlink that points out of the project is not followed
  const pb = S.projectDir(ub.id, 'p');
  fs.symlinkSync(S.projectDir(ua.id, 'shop'), path.join(pb, 'peek'));
  assert.match((await execTool('file_read', { project: 'p', path: 'peek/index.html' }, ctxB)).error, /leaves/);
  assert.ok((await execTool('file_write', { project: 'p', path: 'peek/evil.html', content: 'x' }, ctxB)).error);
  assert.ok(!fs.existsSync(path.join(S.projectDir(ua.id, 'shop'), 'evil.html')));
  fs.rmSync(path.join(pb, 'peek'));
  // B cannot publish A's project or unpublish A's site
  assert.match((await execTool('publish_site', { project: 'shop' }, ctxB)).error, /No project/);
  // the folders really are per person
  assert.ok(fs.existsSync(path.join(dataDir, 'workspaces', String(ua.id), 'shop', 'index.html')));
});

test('approval OFF (default): one question with a picture, one YES → live; no code, no second ask', async () => {
  assert.equal(S.approvalOn(), false);
  const before = texts(A).length;
  say(A, 'publish shop');
  const q = await until(() => texts(A).slice(before).find(t => /^Publish "shop"/.test(t)), 5000, 'question');
  const url = `https://msg.example.com/sites/moshe${ua.id}-shop/`;
  assert.equal(q, `Publish "shop" at ${url} ?\nReply YES to publish, or NO.`);
  assert.doesNotMatch(q, /S\d/, 'no code when only one is waiting');
  assert.equal(pics(A).length, 1, 'the picture came first');
  assert.ok(ch.sent.indexOf(pics(A)[0]) < ch.sent.findIndex(s => s.text === q));
  assert.equal(texts(A).slice(before).length, 1, 'nothing else was said (no "reply YES" from the AI too)');
  assert.equal((await fetchSite(url)).status, 404, 'not live before the YES');
  say(A, 'Yes');
  await until(() => lastText(A) === 'Live: ' + url, 5000, 'live');
  const r = await fetchSite(url);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Moshe shop/);
  assert.match(r.headers.get('content-security-policy'), /^sandbox allow-scripts/, 'site runs sealed off from the dashboard');
  assert.equal(texts(A).filter(t => /Reply YES/.test(t)).length, 1, 'asked once');
  assert.equal(S.listSites(ua.id).length, 1);
});

test('a chatty AI answer that repeats "reply YES" is dropped (the question is the one confirmation)', async () => {
  await execTool('file_write', { project: 'blog', path: 'index.html', content: '<h1>Blog</h1>' }, { userId: ua.id });
  const before = texts(A).length;
  say(A, 'chatty publish blog');
  await until(() => texts(A).slice(before).some(t => /^Publish "blog"/.test(t)), 5000, 'question');
  await sleep(150);
  assert.deepEqual(texts(A).slice(before).filter(t => /yes/i.test(t)).length, 1);
  say(A, 'no');
  await until(() => lastText(A) === 'OK, not published.');
  assert.equal((await fetchSite(`https://msg.example.com/sites/moshe${ua.id}-blog/`)).status, 404);
});

test('a picture right after building is not sent again with the publish question', async () => {
  await execTool('file_write', { project: 'cafe', path: 'index.html', content: '<h1>Cafe</h1>' }, { userId: ua.id });
  const p0 = pics(A).length, n0 = texts(A).length;
  say(A, 'shot cafe');
  await until(() => texts(A).slice(n0).includes('Here is how it looks on a phone.'));
  assert.equal(pics(A).length, p0 + 1);
  say(A, 'publish cafe');
  await until(() => texts(A).slice(n0).some(t => /^Publish "cafe"/.test(t)));
  assert.equal(pics(A).length, p0 + 1, 'no second picture');
  say(A, 'no');
  await until(() => lastText(A) === 'OK, not published.');
});

test('pasted page code is taken out of the chat (picture/file instead)', async () => {
  const before = texts(A).length;
  say(A, 'paste demo');
  const t = await until(() => texts(A).slice(before)[0]);
  assert.doesNotMatch(t, /<html|<body|<h1/);
  assert.match(t, /left the code out/);
});

test('same site again replaces the older request; two different ones → a bare YES asks which; 30 min expiry', async () => {
  const ctx = { userId: ub.id };
  await execTool('file_write', { project: 'cakes', path: 'index.html', content: '<h1>Cakes</h1>' }, ctx);
  await execTool('file_write', { project: 'pies', path: 'index.html', content: '<h1>Pies</h1>' }, ctx);
  const r1 = S.fileRequest(ub.id, { project: 'cakes', site: 'cakes' });
  const r2 = S.fileRequest(ub.id, { project: 'cakes', site: 'cakes' });
  assert.equal(S.requestById(r1.id).status, 'replaced');
  assert.equal(S.waitingForUser(ub.id).length, 1);
  const r3 = S.fileRequest(ub.id, { project: 'pies', site: 'pies' });
  say(Bp, 'yes');
  await until(() => /^Which one\? YES S\d+ = "cakes" · YES S\d+ = "pies"$/.test(lastText(Bp) || ''), 5000, 'which one');
  // nothing was published by the bare YES
  assert.equal(S.listSites(ub.id).length, 0);
  // expire both (older than 30 min) → a YES says it ran out
  db.run('UPDATE site_requests SET created=? WHERE id IN (?,?)', Date.now() - 31 * 60000, r2.id, r3.id);
  say(Bp, 'YES');
  await until(() => /ran out \(30 min\)/.test(lastText(Bp) || ''), 5000, 'expired');
  assert.equal(S.requestById(r2.id).status, 'expired');
});

test('limits: space per person and sites per person (admin-changeable)', async () => {
  S.setConfig({ quota_mb: 0.01 });     // 10 KB
  const big = 'x'.repeat(20 * 1024);
  assert.match((await execTool('file_write', { project: 'big', path: 'index.html', content: big }, { userId: ub.id })).error, /Not enough space/);
  S.setConfig({ quota_mb: 50, max_sites: 1 });
  // A already has 1 site: a different second one is refused, the same one may be updated
  await execTool('file_write', { project: 'third', path: 'index.html', content: '<p>3</p>' }, { userId: ua.id });
  assert.match((await execTool('publish_site', { project: 'third' }, { userId: ua.id })).error, /most allowed is 1/);
  assert.ok((await execTool('publish_site', { project: 'shop' }, { userId: ua.id })).asked, 'republishing the same site is fine');
  S.setConfig({ max_sites: 5 });
  db.run("UPDATE site_requests SET status='cancelled' WHERE status='ask_user'");
});

test('approval ON: user YES → "waiting" once → admin gets picture + private preview → admin YES → live', async () => {
  S.setConfig({ approval: true });
  const ctx = { userId: ub.id };
  await execTool('file_write', { project: 'bakery', path: 'index.html', content: '<h1>Rivka bakery</h1>' }, ctx);
  const nB = texts(Bp).length, nAd = texts(ADMIN).length, pAd = pics(ADMIN).length;
  say(Bp, 'publish bakery');
  await until(() => texts(Bp).slice(nB).some(t => /^Publish "bakery"/.test(t)));
  say(Bp, 'yes please');
  await until(() => lastText(Bp) === 'Waiting for admin approval. I\'ll text you when it\'s decided.');
  const req = await until(() => texts(ADMIN).slice(nAd).find(t => /^Site request: Rivka/.test(t)), 5000, 'admin request');
  assert.match(req, /wants to publish "bakery"/);
  assert.match(req, /\nReply YES to publish or NO to refuse\.$/);
  await until(() => pics(ADMIN).length === pAd + 1, 5000, 'admin picture');
  const preview = /Preview \(private\): (\S+)/.exec(req)[1];
  const pv = await fetchSite(preview);
  assert.equal(pv.status, 200); assert.match(await pv.text(), /Rivka bakery/);
  assert.equal((await fetchSite(preview.replace(/\/preview\/[^/]+\//, '/preview/AAAAAAAAAAAAAAAAAAAAAAAA/'))).status, 404, 'a guessed preview link shows nothing');
  const url = `https://msg.example.com/sites/rivka${ub.id}-bakery/`;
  assert.equal((await fetchSite(url)).status, 404, 'not live yet');
  // what the admin previewed is what goes live, even if the files change meanwhile
  await execTool('file_write', { project: 'bakery', path: 'index.html', content: '<h1>changed later</h1>' }, ctx);
  // the dashboard shows it
  const page = (await api.get('/api/sites')).data;
  assert.equal(page.waiting.length, 1); assert.equal(page.waiting[0].site, 'bakery'); assert.ok(page.waiting[0].shot);
  assert.equal((await fetch(base + page.waiting[0].shot)).headers.get('content-type'), 'image/png');
  say(ADMIN, 'YES');
  await until(() => /^Approved! "bakery" is live: /.test(lastText(Bp) || ''), 5000, 'user told');
  await until(() => /^Published "bakery"/.test(lastText(ADMIN) || ''), 5000, 'admin told');
  const r = await fetchSite(url);
  assert.equal(r.status, 200); assert.match(await r.text(), /Rivka bakery/);
  assert.equal(texts(Bp).filter(t => /Waiting for admin approval/.test(t)).length, 1, 'told "waiting" once');
  assert.equal(fs.existsSync(path.join(dataDir, 'site-staging')) ? fs.readdirSync(path.join(dataDir, 'site-staging')).length : 0, 0, 'staged copy cleaned up');
});

test('approval ON: admin NO → the person is told, nothing is published', async () => {
  const ctx = { userId: ub.id };
  await execTool('file_write', { project: 'menu', path: 'index.html', content: '<h1>Menu</h1>' }, ctx);
  say(Bp, 'publish menu');
  await until(() => /^Publish "menu"/.test(lastText(Bp) || ''));
  say(Bp, 'YES');
  await until(() => /Waiting for admin approval/.test(lastText(Bp) || ''));
  await until(() => /wants to publish "menu"/.test(lastText(ADMIN) || ''));
  say(ADMIN, 'no');
  await until(() => lastText(Bp) === 'The admin didn\'t approve "menu", so it was not published.');
  await until(() => /^Refused "menu"/.test(lastText(ADMIN) || ''));
  assert.equal((await fetchSite(`https://msg.example.com/sites/rivka${ub.id}-menu/`)).status, 404);
  assert.equal(S.listSites(ub.id).length, 1);
});

test('approval ON: the dashboard Approve / Reject buttons; 2 waiting → the admin\'s text shows codes', async () => {
  const ctx = { userId: ub.id };
  for (const p of ['one', 'two']) { await execTool('file_write', { project: p, path: 'index.html', content: '<h1>' + p + '</h1>' }, ctx); const r = S.fileRequest(ub.id, { project: p, site: p }); await F.userDecide(r, true, users.userById(ub.id)); }
  const two = await until(() => texts(ADMIN).find(t => /^Site request S\d+: .*"two"/.test(t)), 5000, 'coded admin text');
  assert.match(two, /Reply YES S\d+ to publish or NO S\d+ to refuse/);
  const w = (await api.get('/api/sites')).data.waiting;
  assert.equal(w.length, 2);
  const ok = await api.post(`/api/sites/requests/${w[0].id}/approve`);
  assert.equal(ok.status, 200); assert.equal(ok.data.status, 'published');
  const no = await api.post(`/api/sites/requests/${w[1].id}/reject`);
  assert.equal(no.data.status, 'rejected');
  assert.equal((await api.post(`/api/sites/requests/${w[1].id}/approve`)).status, 409, 'decided once');
  await until(() => texts(Bp).some(t => t.startsWith('Approved! "one"')) && texts(Bp).some(t => t === 'The admin didn\'t approve "two", so it was not published.'));
});

test('the admin\'s own site skips the admin queue', async () => {
  await execTool('file_write', { project: 'home', path: 'index.html', content: '<h1>Admin</h1>' }, { userId: adminU.id });
  say(ADMIN, 'publish home');
  await until(() => /^Publish "home"/.test(lastText(ADMIN) || ''));
  say(ADMIN, 'yes');
  await until(() => /^Live: .*-home\/$/.test(lastText(ADMIN) || ''), 5000, 'admin site live');
  S.setConfig({ approval: false });
});

test('404: a missing page shows the built-in "Page not found" with a link home; a site\'s own 404.html wins', async () => {
  const site = `https://msg.example.com/sites/moshe${ua.id}-shop/`;
  let r = await fetchSite(site + 'nope.html');
  assert.equal(r.status, 404);
  let h = await r.text();
  assert.match(h, /Page not found/); assert.match(h, new RegExp(`href="/sites/moshe${ua.id}-shop/"`));
  r = await fetchSite('https://msg.example.com/sites/nobody-here/x');
  assert.equal(r.status, 404); h = await r.text(); assert.match(h, /This site does not exist/); assert.doesNotMatch(h, /Go to the home page/);
  // own 404.html
  await execTool('file_write', { project: 'shop', path: '404.html', content: '<h1>Oops, Moshe 404</h1>' }, { userId: ua.id });
  const q = S.fileRequest(ua.id, { project: 'shop', site: 'shop' });
  await F.userDecide(q, true, users.userById(ua.id));
  r = await fetchSite(site + 'missing/page');
  assert.equal(r.status, 404); assert.match(await r.text(), /Oops, Moshe 404/);
  // traversal through the web address
  for (const bad of ['../../workspaces/' + ua.id + '/shop/index.html', '%2e%2e/%2e%2e/messageassistant.db', '..%2f..%2fmaster.key', '.%2e/x'])
    assert.equal((await fetch(`${base}/sites/moshe${ua.id}-shop/${bad}`)).status, 404, bad);
  assert.equal((await fetch(`${base}/sites/moshe${ua.id}-shop`, { redirect: 'manual' })).status, 301);
  assert.equal((await fetch(`${base}/sites/moshe${ua.id}-shop/`, { method: 'POST' })).status, 405);
});

test('unpublish: the person\'s own site only; the admin can unpublish anyone\'s (they are told)', async () => {
  const before = texts(Bp).length;
  say(Bp, 'unpublish shop');           // B has no "shop" (that is A's)
  await until(() => texts(Bp).length > before);
  assert.match(lastText(Bp), /no published site called/);
  assert.equal((await fetchSite(`https://msg.example.com/sites/moshe${ua.id}-shop/`)).status, 200, 'A\'s site is untouched');
  say(A, 'unpublish shop');
  await until(() => /unpublished/.test(lastText(A) || ''));
  assert.equal((await fetchSite(`https://msg.example.com/sites/moshe${ua.id}-shop/`)).status, 404);
  // the admin, from the dashboard
  const list = (await api.get('/api/sites')).data.sites;
  const bakery = list.find(s => s.name === 'bakery');
  assert.ok(bakery && bakery.user === 'Rivka' && /(KB|MB)$/.test(bakery.size) && bakery.url.endsWith(`rivka${ub.id}-bakery/`));
  await api.post(`/api/sites/${bakery.id}/unpublish`);
  await until(() => lastText(Bp) === 'The admin took your site "bakery" offline.');
  assert.equal((await fetchSite(bakery.url)).status, 404);
});

test('admin: site building off / only chosen people; the dashboard settings and the CLI switch', async () => {
  let r = await api.post('/api/sites/settings', { mode: 'off' });
  assert.equal(r.data.settings.mode, 'off');
  assert.ok(!declarations(undefined, users.userById(ua.id)).some(t => t.name === 'publish_site'), 'no site tools when off');
  assert.match((await execTool('file_write', { project: 'x', path: 'index.html', content: 'x' }, { userId: ua.id })).error, /not turned on/);
  r = await api.post('/api/sites/settings', { mode: 'chosen' });
  await api.post(`/api/sites/people/${ub.id}`, { allowed: true });
  assert.ok(!S.allowed(ua.id)); assert.ok(S.allowed(ub.id)); assert.ok(S.allowed(adminU.id), 'the admin always can');
  assert.ok(declarations(undefined, users.userById(ub.id)).some(t => t.name === 'publish_site'));
  r = await api.post('/api/sites/settings', { mode: 'all', quota_mb: 'abc' });
  assert.equal(r.status, 400);
  await api.post('/api/sites/settings', { mode: 'all' });
  // CLI (another process, same database): sudo messageassistant sites-approval on|off|show
  const cli = (...a) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(HERE, '..', 'src', 'cli.js'), ...a], { env: { ...process.env }, encoding: 'utf8', timeout: 20000 });
  let o = cli('sites-approval', 'on');
  assert.equal(o.status, 0, o.stderr); assert.match(o.stdout, /Site publishing: ON/);
  assert.equal(S.approvalOn(), true);
  o = cli('sites-approval', 'off'); assert.match(o.stdout, /Site publishing: OFF/); assert.equal(S.approvalOn(), false);
  o = cli('sites-approval'); assert.match(o.stdout, /OFF/);
  o = cli('sites-approval', 'maybe'); assert.equal(o.status, 1);
  o = cli('sites'); assert.equal(o.status, 0); assert.match(o.stdout, /home/);
});

test('removing a person removes their files and sites', async () => {
  const pub = S.listSites(ub.id);
  assert.ok(pub.length >= 1);
  await api.post(`/api/users/${ub.id}/remove`);
  assert.ok(!fs.existsSync(path.join(dataDir, 'workspaces', String(ub.id))));
  for (const s of pub) assert.equal((await fetchSite(s.url)).status, 404);
  assert.equal(S.listSites(ub.id).length, 0);
});
