// 1.1.10: (1) send_web_file — a file from the web (a PDF…) goes by text as the file itself, never a link.
// (2) A plain-text answer jumps ahead of a picture/file send in the Messages driver queue, so a stuck
// attach cannot make the assistant look deaf. (3) The YouTube preview checks its match: the asked words
// must appear in the title IN ORDER, or the match is flagged uncertain (the "Dylan Paige" → "Paige Dylan" case).
import { setupEnv } from './helpers.js';
const DIR = setupEnv('v121', { MSA_ADMIN_PHONE: '+16465550100', MSA_PUBLIC_URL: 'https://msg.example.com', MSA_ALLOW_LOCAL: '1' });
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
const { main } = await import('../src/server.js');
const { MEDIA_TOOLS, scoreMatch } = await import('../src/tools/media.js');
const { GoogleMessagesWeb } = await import('../src/channels/gmweb.js');

test('scoreMatch: in-order words are strong, reversed words are not', () => {
  assert.equal(scoreMatch('Dylan Paige', 'Dylan Paige — my newest video').strong, true);
  assert.equal(scoreMatch('Dylan Paige', 'I Smile Back Screenwriter Paige Dylan on what the film means').strong, false, 'same words, reversed — a different person');
  assert.equal(scoreMatch('Mordechai Shapiro Yedidim', 'Mordechai Shapiro & Yedidim — Live').strong, true);
  assert.equal(scoreMatch('Dylan Paige', 'Cooking with gas — episode 4').score, 0);
  assert.ok(scoreMatch('Dylan Paige', 'Dylan Paige vlog').rank > scoreMatch('Dylan Paige', 'Paige Dylan interview').rank, 'an in-order match outranks a reversed one');
});

test('send_web_file: the file itself is attached, with its real name; a web page is refused', async () => {
  const pdf = Buffer.from('%PDF-1.4 fake but bytes are bytes');
  const srv = http.createServer((req, res) => {
    if (req.url === '/form') { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="Tax Form 2026.pdf"', 'Content-Length': pdf.length }); return res.end(pdf); }
    if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<html>not a file</html>'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const app = await main({ port: 0 });
  try {
    const tool = MEDIA_TOOLS.find(t => t.name === 'send_web_file');
    assert.ok(tool, 'the tool exists');
    const ctx = { userId: null, files: [] };
    const out = await tool.run({ url: `http://127.0.0.1:${srv.address().port}/form` }, ctx);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.sent_file, 'Tax Form 2026.pdf');
    assert.equal(ctx.files.length, 1, 'the file is queued to be attached to the answer');
    assert.deepEqual(fs.readFileSync(ctx.files[0].media.file), pdf, 'the actual bytes, not a link');
    const page = await tool.run({ url: `http://127.0.0.1:${srv.address().port}/page` }, { userId: null, files: [] });
    assert.match(page.error || '', /web page, not a file/);
  } finally { await app.stop(); srv.close(); }
});

test('driver queue: a text answer goes before a file send, even when the file was queued first', async () => {
  const d = new GoogleMessagesWeb({ dataDir: DIR, isSeen: () => true, markSeen: () => {}, needsBaseline: () => false, baselineDone: () => {} });
  d.ensureBrowser = async () => {}; d.state = 'connected'; d.stopped = false;   // as start() leaves it, without launching a browser
  d.page = { goto: async () => {} };
  d.snap = async () => ({ msgs: [], convs: [] });
  d.openChat = async () => {};
  const order = [];
  d.attachAndSend = async () => { order.push('media'); };
  d.typeAndSend = async () => { order.push('text'); };
  let release; const gate = new Promise(r => { release = r; });
  const blocked = d.enqueue('screen', async () => { await gate; });
  const mediaSend = d.send({ convId: 'c1', text: '', media: { file: '/tmp/x.pdf' } });
  const textSend = d.send({ convId: 'c1', text: 'a plain answer' });
  release();
  await Promise.all([blocked, mediaSend, textSend]);
  assert.deepEqual(order, ['text', 'media'], 'the answer is not stuck behind the file');
  await d.stop();
});
