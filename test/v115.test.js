// 1.1.4 (as Abish actually asked): (1) a switch lets each person add their OWN AI keys for the brain —
// their chats run on their keys first, the system's are the backup. (2) A secure vault for ANY account:
// logins/tokens/secrets stored sealed; the assistant sees labels only and browser_login fills a password
// in server-side, never through the model.
import { setupEnv } from './helpers.js';
setupEnv('v115', { MSA_ADMIN_PHONE: '+16465550100' });
import test from 'node:test';
import assert from 'node:assert/strict';
const db = await import('../src/db.js');
const { loadMasterKey } = await import('../src/crypto.js');
const { cfg } = await import('../src/config.js');
loadMasterKey(cfg.dataDir); db.openDb();
const aikeys = await import('../src/aikeys.js');
const VAULT = await import('../src/vault.js');
const users = await import('../src/users.js');
const { execTool } = await import('../src/tools/index.js');
const u = users.arrive({ phone: '+16465550191', name: 'A', text: 'hi' }).user;
const u2 = users.arrive({ phone: '+16465550192', name: 'B', text: 'hi' }).user;

test('own AI keys: his keys run FIRST for him, system keys are the backup, nobody else\'s keys leak in', () => {
  const sys = aikeys.addKey({ name: 'System Gemini', kind: 'gemini', key: 'sys-key-123' });
  assert.equal(aikeys.ownAiAllowed(), true, 'the switch is on by default');
  const mine = aikeys.addUserKey(u.id, { preset: 'gemini', key: 'my-own-key-456' });
  assert.equal(mine.name, 'Gemini (mine)');
  const other = aikeys.addUserKey(u2.id, { preset: 'groq', key: 'other-key-789' });
  const chain = aikeys.usableKeys({ use: 'chat', userId: u.id }).map(k => k.id);
  assert.equal(chain[0], mine.id, 'his key first');
  assert.ok(chain.includes(sys.id), 'system key as backup');
  assert.ok(!chain.includes(other.id), 'another person\'s key never appears');
  assert.deepEqual(aikeys.usableKeys({ use: 'chat' }).map(k => k.id), [sys.id], 'no userId = system keys only (pictures/background unchanged)');
  assert.deepEqual(aikeys.listKeys().map(k => k.id), [sys.id], 'the admin dashboard lists system keys only');
  assert.deepEqual(aikeys.listUserKeys(u.id).map(k => k.id), [mine.id]);
  assert.ok(!JSON.stringify(aikeys.listUserKeys(u.id)).includes('my-own-key-456'), 'the value never leaves');
  db.setSetting('allow_own_ai_keys', '0');
  assert.deepEqual(aikeys.usableKeys({ use: 'chat', userId: u.id }).map(k => k.id), [sys.id], 'switch off: his keys are ignored');
  assert.throws(() => aikeys.addUserKey(u.id, { preset: 'gemini', key: 'x' }), /turned off/);
  db.setSetting('allow_own_ai_keys', '1');
  assert.throws(() => aikeys.removeUserKey(u.id, other.id), /removed/, 'he cannot remove another person\'s key');
  aikeys.removeUserKey(u.id, mine.id);
  assert.deepEqual(aikeys.listUserKeys(u.id), []);
});

test('the vault: sealed secrets, labels only for the assistant, browser_login guards', async () => {
  const e = VAULT.addEntry(u.id, { kind: 'login', label: 'Cloudflare', site: 'dash.cloudflare.com', username: 'me@example.com', secret: 'hunter2-secret' });
  VAULT.addEntry(u.id, { kind: 'token', label: 'Some API', secret: 'tok-abc-123' });
  const list = VAULT.listEntries(u.id);
  assert.equal(list.length, 2);
  assert.ok(!JSON.stringify(list).includes('hunter2'), 'listings never carry the secret');
  assert.equal(VAULT.findEntry(u.id, 'cloudflare').id, e.id);
  assert.equal(VAULT.findEntry(u2.id, 'cloudflare'), null, 'another person\'s vault is invisible');
  const vl = await execTool('vault_list', {}, { userId: u.id });
  assert.equal(vl.entries.length, 2);
  assert.ok(!JSON.stringify(vl).includes('hunter2') && !JSON.stringify(vl).includes('tok-abc'), 'the brain never sees a secret');
  const bad = await execTool('browser_login', { entry: 'Nope' }, { userId: u.id });
  assert.match(bad.error, /No vault entry/);
  const tok = await execTool('browser_login', { entry: 'Some API' }, { userId: u.id });
  assert.match(tok.error, /not a website login/);
  VAULT.removeEntry(u.id, e.id);
  assert.equal(VAULT.listEntries(u.id).length, 1);
  assert.throws(() => VAULT.removeEntry(u2.id, list[1].id), /gone/);
});
