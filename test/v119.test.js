// 1.1.8: "I toggle it on and it's not getting saved." Root cause: the Google-connect and own-AI-keys
// toggles post { settings: { key: value } } (the shape GET /api/settings returns), but POST /api/settings
// only ever read FLAT keys — so the save returned success, the dashboard showed a green "on", and nothing
// was stored. On the next visit the switch was back where it started. POST now accepts both shapes.
import { setupEnv, client } from './helpers.js';
const ADMIN = '+16465550100';
setupEnv('v119', { MSA_ADMIN_PHONE: ADMIN, MSA_PUBLIC_URL: 'https://msg.example.com' });
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const { MockChannel } = await import('../src/channels/mock.js');
const auth = await import('../src/adminauth.js');
const ch = new MockChannel();
const app = await main({ channel: ch, port: 0 });
const base = `http://127.0.0.1:${app.port}`;
test.after(async () => { await app.stop(); });
auth.setPassword('pass-119-abcdef', 'admin');
const api = client(base);
await api.post('/api/login/password', { username: 'admin', password: 'pass-119-abcdef' });

test('the Google toggle saves — in the nested shape the dashboard sent, and the flat one', async () => {
  assert.equal((await api.get('/api/integrations')).data.google_enabled, true, 'starts on (the default)');
  let r = await api.post('/api/settings', { settings: { google_connect_enabled: '0' } });      // the shape the toggle sent in ≤1.1.7
  assert.equal(r.status, 200);
  assert.equal((await api.get('/api/integrations')).data.google_enabled, false, 'nested shape: off actually saved');
  r = await api.post('/api/settings', { google_connect_enabled: '1' });                        // flat shape
  assert.equal(r.status, 200);
  assert.equal((await api.get('/api/integrations')).data.google_enabled, true, 'flat shape: on actually saved');
  r = await api.post('/api/settings', { settings: { google_connect_enabled: '0' } });
  assert.equal((await api.get('/api/settings')).data.settings.google_connect_enabled, '0', 'and it is still off after a fresh read');
});

test('the own-AI-keys toggle saves too (same bug, same fix)', async () => {
  await api.post('/api/settings', { settings: { allow_own_ai_keys: '0' } });
  assert.equal((await api.get('/api/settings')).data.settings.allow_own_ai_keys, '0');
  await api.post('/api/settings', { settings: { allow_own_ai_keys: '1' } });
  assert.equal((await api.get('/api/settings')).data.settings.allow_own_ai_keys, '1');
});
