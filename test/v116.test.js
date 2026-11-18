// 1.1.5: (1) a picture must arrive as a picture — the Messages driver no longer texts a file's private link
// when attaching fails (Abish got "…/thumbnail.jpg" as a text). (2) A video request searches YouTube, a song
// request searches YouTube Music, unless told otherwise. (3) Google Save says what is missing instead of a
// silent "Saved." that changed nothing.
import { setupEnv } from './helpers.js';
const DIR = setupEnv('v116', { MSA_ADMIN_PHONE: '+16465550100' });
import test from 'node:test';
import assert from 'node:assert/strict';
const db = await import('../src/db.js');
const { loadMasterKey } = await import('../src/crypto.js');
const { cfg } = await import('../src/config.js');
loadMasterKey(cfg.dataDir); db.openDb();
const { GoogleMessagesWeb } = await import('../src/channels/gmweb.js');
const media = await import('../src/tools/media.js');
const INTEG = await import('../src/integrations.js');

test('a file that cannot be attached is NEVER sent as a link (picture, not just audio)', async () => {
  const d = new GoogleMessagesWeb({ dataDir: DIR, isSeen: () => true, markSeen: () => {}, needsBaseline: () => false, baselineDone: () => {} });
  d.enqueue = (kind, fn) => fn();                       // isolate send()'s logic from the browser plumbing
  d.state = 'connected'; d.stopped = false;
  d.openChat = async () => {}; d.snap = async () => ({ msgs: [], convs: [] }); d.page = { goto: async () => {} };
  const typed = []; d.typeAndSend = async (t) => { typed.push(t); return true; };
  d.attachAndSend = async () => { throw new Error('no attach button on this page'); };
  await assert.rejects(
    () => d.send({ convId: '101', text: 'Is this the one?', media: '/tmp/thumbnail.jpg', mediaUrl: 'https://msg.example.com/m/tok/thumbnail.jpg' }),
    /could not be attached/);
  assert.deepEqual(typed, [], 'nothing was typed at all — above all, no link');
  d.attachAndSend = async () => true;
  await d.send({ convId: '101', text: 'Is this the one?', media: '/tmp/thumbnail.jpg', mediaUrl: 'https://msg.example.com/m/tok/thumbnail.jpg' });
  assert.deepEqual(typed, ['Is this the one?'], 'with the picture attached, the text goes out exactly as written');
});

test('default source: video → YouTube, song → YouTube Music, a link or an explicit word wins', () => {
  assert.equal(media.defaultSourceFor('the song by Yaakov Shwekey'), 'music');
  assert.equal(media.defaultSourceFor('that niggun from the wedding'), 'music');
  assert.equal(media.defaultSourceFor('new music album'), 'music');
  assert.equal(media.defaultSourceFor('video of the chasuna'), 'youtube');
  assert.equal(media.defaultSourceFor('shiur on emunah part 2'), 'youtube');
  assert.equal(media.defaultSourceFor('anything', 'https://music.youtube.com/watch?v=x'), 'music');
  assert.equal(media.defaultSourceFor('anything', 'https://www.youtube.com/watch?v=x'), 'youtube');
});

test('Google Save: the example ID is refused, an ID alone is not "on", ID + secret is', () => {
  assert.throws(() => INTEG.setGoogleClient({ client_id: '1234-abc.apps.googleusercontent.com', client_secret: 'real-secret-123' }), /example text/);
  let g = INTEG.setGoogleClient({ client_id: '123456789012-real.apps.googleusercontent.com' });
  assert.equal(g.ready, false, 'ID without a secret is not ready — the button must say so, not just "Saved."');
  g = INTEG.setGoogleClient({ client_secret: 'real-secret-123' });
  assert.equal(g.ready, true);
  assert.equal(g.client_id, '123456789012-real.apps.googleusercontent.com');
});
