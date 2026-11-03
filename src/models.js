// Message Assistant: the AI model calls. Taken from My Assistant 2.3.14's brain.js (providers + the key failover),
// unchanged in behaviour: Gemini, any OpenAI-compatible API (Groq, OpenRouter, ...), Cloudflare Workers AI chat.
// callModel() tries the admin's active keys in his order and moves to the next key on a limit (429/quota),
// a refused key or a provider that is down. Keys that hit a limit rest (cool down) and come back by themselves.
import { cfg } from './config.js';
import { setting, redact, log, audit, rememberSecret, now } from './db.js';
import * as aikeys from './aikeys.js';
import { classify } from './aikeys.js';
export { aikeys };

// ---------------- providers ----------------
function geminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type') o.type = String(v).toUpperCase();
    else if (k === 'properties') o.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, geminiSchema(pv)]));
    else if (k === 'items') o.items = geminiSchema(v);
    else o[k] = v;
  }
  if (o.type === 'OBJECT' && o.properties && !Object.keys(o.properties).length) delete o.properties;
  if (Array.isArray(o.required) && !o.required.length) delete o.required;
  return o;
}
// 2.3.2: media this model's Test showed it can't take becomes a short note instead (so the request still works).
const CAP_OF = { image: 'images', audio: 'audio', pdf: 'pdf' };
const mediaLabel = (m) => `"${m.name}" (${m.kind === 'audio' ? 'voice note' : m.kind === 'image' ? 'photo' : m.kind})`;
function splitMedia(media, caps) {
  const keep = [], skipped = [];
  for (const m of media || []) (caps && caps[CAP_OF[m.kind]] === false ? skipped : keep).push(m);
  return { keep, skipped };
}
const capsNote = (skipped) => skipped.length ? `[The person attached ${skipped.map(mediaLabel).join(', ')}, but this AI model cannot open that kind of file (its Test showed it). Tell them this kind of attachment can't be read right now; ask for the text instead.]` : '';
export function toGeminiContents(items, caps = null, opts = {}) {
  const out = [];
  for (const it of items) {
    if (it.role === 'user') {
      // Photos, voice notes and PDFs go to Gemini directly (inlineData), so it sees / hears them itself.
      const { keep, skipped } = splitMedia(it.media, caps);
      const parts = keep.map(m => ({ inlineData: { mimeType: geminiMime(m.mime), data: m.data } }));
      const note = capsNote(skipped);
      parts.push({ text: [it.text, note].filter(Boolean).join('\n\n') || (parts.length ? '(attachment)' : '…') });
      out.push({ role: 'user', parts });
    }
    else if (it.role === 'assistant') {
      if (it.raw) out.push({ role: 'model', parts: it.raw });      // Gemini's own parts, exactly as returned (thoughtSignature included)
      else {
        const parts = [];
        if (it.text) parts.push({ text: it.text });
        for (const c of it.calls || []) parts.push({ functionCall: { name: c.name, args: c.args } });
        if (parts.length) out.push({ role: 'model', parts });
      }
    } else if (it.role === 'tool') {
      const part = { functionResponse: { name: it.name, response: { result: it.result } } };
      if (it.id && !String(it.id).startsWith('local-')) part.functionResponse.id = it.id;
      const last = out[out.length - 1];
      // 2.3.6: a tool can hand the model a picture to look at (site_screenshot, video_make frames); it rides after the answers
      const seen = last && last.role === 'user' && last.parts.some(p => p.functionResponse) && last.parts.every(p => p.functionResponse || p.toolMedia);
      if (seen) { const at = last.parts.findIndex(p => p.toolMedia); at < 0 ? last.parts.push(part) : last.parts.splice(at, 0, part); }
      else out.push({ role: 'user', parts: [part] });
      const turn = out[out.length - 1];
      for (const p of toolMediaParts(it, caps)) turn.parts.push(p);
    }
  }
  // (toolMedia only marks where tool pictures start; it is not sent)
  for (const c of out) for (const p of c.parts) if (p.toolMedia) delete p.toolMedia;
  return opts.fillSignatures ? withSignatures(out) : out;
}

// ---------------- 2.3.14: Gemini thought signatures ----------------
// Gemini 3 (and newer) thinking models put a `thoughtSignature` on the parts they return (on every functionCall part
// that starts a step; sometimes on the last text part). Docs (ai.google.dev thinking#signatures; Google Cloud
// "Thought signatures", checked Nov 2 2026): send every part back exactly as returned, signature inside its own part
// (never merged or moved); in each step of the current turn the FIRST functionCall part must carry its signature,
// otherwise the answer is 400 "Function call is missing a thought_signature in functionCall parts".
// The assistant already sends Gemini's own parts back unchanged (`raw`, kept since 2.0). What broke (Nov 2 2026):
// a job whose earlier step was answered by ANOTHER key (Groq, OpenRouter, Cloudflare…) or an older Gemini model has
// tool calls with no signature at all; when a Gemini 3 key took over, Google refused the whole job.
// For exactly that case Google documents a stand-in value: "skip_thought_signature_validator" ("for functionCall parts
// that were not generated by the API … e.g. history transferred from a model that does not include signatures").
// Real signatures are never touched; only a missing one on a step's first functionCall gets the stand-in.
export const SKIP_SIGNATURE = 'skip_thought_signature_validator';
/** Does this Gemini model check thought signatures? (Gemini 3 and newer, and the moving "latest" names.) */
export function geminiChecksSignatures(model) {
  const m = String(model || '').toLowerCase();
  const v = /gemini-(\d+(?:\.\d+)?)/.exec(m);
  if (v) return parseFloat(v[1]) >= 3;
  return /gemini/.test(m) && /latest/.test(m);
}
/** contents → the same contents where every model step's first functionCall part has a thoughtSignature. */
export function withSignatures(contents) {
  return contents.map(c => {
    if (c.role !== 'model' || !Array.isArray(c.parts)) return c;
    const i = c.parts.findIndex(p => p && p.functionCall);
    if (i < 0 || c.parts[i].thoughtSignature) return c;
    const parts = c.parts.slice();
    parts[i] = { ...parts[i], thoughtSignature: SKIP_SIGNATURE };
    return { ...c, parts };
  });
}
// 2.3.6: pictures a tool returned for the model to look at. A model whose Test showed it cannot see pictures gets a note.
function toolMediaParts(it, caps) {
  const media = (it.media || []).filter(m => m.kind === 'image' && m.data);
  if (!media.length) return [];
  if (caps && caps.images === false) return [{ toolMedia: true, text: `[${it.name} made a picture, but this AI model cannot look at pictures (its Test showed it). Rely on the problems_found list instead.]` }];
  const parts = media.map(m => ({ toolMedia: true, inlineData: { mimeType: m.mime, data: m.data } }));
  parts.push({ toolMedia: true, text: `[Picture${media.length > 1 ? 's' : ''} from ${it.name}: ${media.map(m => m.name || 'image').join('; ')}. Look at ${media.length > 1 ? 'them' : 'it'} now.]` });
  return parts;
}
const hasToolPictures = (items) => items.some(it => it.role === 'tool' && it.media && it.media.length);
export function withoutToolPictures(items) {
  return items.map(it => it.role === 'tool' && it.media ? { ...it, media: undefined, result: { ...(it.result || {}), picture: '(this AI model could not take the picture; rely on problems_found)' } } : it);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function geminiMime(m) {
  m = String(m || '').split(';')[0];
  return m === 'audio/mp4' ? 'audio/mp4' : m === 'audio/x-wav' ? 'audio/wav' : m;
}

// One request to one key. A network failure or 5xx gets one quick second try on the same key; anything
// else comes straight back so the brain can move to the next key instead of waiting.
async function postOnce(url, init, provider) {
  let last = '';
  for (let i = 0; i < 2; i++) {
    let r;
    try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(180000) }); }
    catch (e) { last = e.cause?.code || e.name === 'TimeoutError' ? (e.cause?.code || 'timed out') : e.message; if (i === 0) { await sleep(cfg.testMode ? 50 : 2000); continue; } break; }
    if ([500, 502, 503, 504].includes(r.status) && i === 0) { await r.text().catch(() => ''); await sleep(cfg.testMode ? 50 : 2000); continue; }
    return r;
  }
  throw keyFail(classify({ networkError: last || 'no answer', provider }));
}
function keyFail(c) { const e = new Error(c.reason); e.keyFail = c; return e; }
async function failFrom(r, provider) {
  const text = await r.text().catch(() => '');
  return keyFail(classify({ status: r.status, text, headers: r.headers, provider }));
}

export async function geminiModels(key) {
  const r = await fetch((cfg.geminiBase || 'https://generativelanguage.googleapis.com') + '/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (!r.ok) throw new Error('Gemini: ' + (j.error?.message || r.status));
  return (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
}

async function gemini({ system, items, tools, noTools, model, key, retried, caps, sigRetried = false }) {
  if (!key) throw keyFail({ kind: 'bad_key', reason: 'no key saved — paste it', until: 0, problem: 'no key' });
  model = model || setting('model') || 'gemini-3.6-flash';
  // 2.3.14: tool calls with no thought signature (made by another key / an older model) get Google's stand-in for models
  // that check them; any other model gets it too if Google still asks for a signature (one more try, below).
  const body = { systemInstruction: { parts: [{ text: system }] }, contents: toGeminiContents(items, caps, { fillSignatures: sigRetried || geminiChecksSignatures(model) }) };
  if (tools && tools.length) {
    body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
    body.toolConfig = { functionCallingConfig: { mode: noTools ? 'NONE' : 'AUTO' } };
  }
  const r = await postOnce(`${cfg.geminiBase || 'https://generativelanguage.googleapis.com'}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) }, 'gemini');
  if (r.status === 404 && !retried) {
    const names = await geminiModels(key).catch(() => []);
    const flash = names.filter(n => /^gemini-[\d.]+-flash$/.test(n)).sort((a, b) => parseFloat(b.split('-')[1]) - parseFloat(a.split('-')[1]));
    if (flash[0] && flash[0] !== model) { log('model', model, 'not found; using', flash[0]); return gemini({ system, items, tools, noTools, model: flash[0], key, retried: true, caps, sigRetried }); }
  }
  if (r.status === 400) {
    const text = await r.text().catch(() => '');
    // 2.3.14: "Function call is missing a thought_signature" → once more with the stand-in signature on every step
    if (!sigRetried && /thought[_ ]?signature/i.test(text)) { log('model', model, 'asked for thought signatures; sending the stand-in'); return gemini({ system, items, tools, noTools, model, key, retried, caps, sigRetried: true }); }
    // 2.3.6: a model that refuses a tool's picture still gets the request, with a note instead of the picture
    if (hasToolPictures(items)) { log('model', model, 'refused a tool picture; sending without it'); return gemini({ system, items: withoutToolPictures(items), tools, noTools, model, key, retried, caps, sigRetried }); }
    throw keyFail(classify({ status: 400, text, headers: r.headers, provider: 'gemini' }));
  }
  if (!r.ok) throw await failFrom(r, 'gemini');
  const j = await r.json().catch(() => ({}));
  const cand = (j.candidates || [])[0];
  if (!cand) throw new Error('Gemini returned no answer' + (j.promptFeedback?.blockReason ? ' (blocked: ' + j.promptFeedback.blockReason + ')' : ''));
  const parts = cand.content?.parts || [];
  const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
  const calls = parts.filter(p => p.functionCall).map((p, i) => ({ id: p.functionCall.id || 'local-' + i, name: p.functionCall.name, args: p.functionCall.args || {} }));
  if (!text && !calls.length && cand.finishReason && cand.finishReason !== 'STOP') return { text: `(The model stopped: ${cand.finishReason}.)`, calls: [], raw: parts };
  return { text, calls, raw: parts };
}

// OpenAI-compatible APIs take images as data URLs; audio and PDF are not portable, so they become a note.
export function openaiUserContent(it, caps = null) {
  if (!it.media || !it.media.length) return it.text;
  const parts = []; const skipped = [], refused = [];
  for (const m of it.media) {
    const fmt = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3' }[String(m.mime).split(';')[0]];
    if (caps && caps[CAP_OF[m.kind]] === false) refused.push(m);
    else if (m.kind === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${m.mime};base64,${m.data}` } });
    // 2.3.2: a model whose Test showed it can hear gets wav/mp3 voice clips directly (other formats stay a note)
    else if (m.kind === 'audio' && caps?.audio === true && fmt) parts.push({ type: 'input_audio', input_audio: { data: m.data, format: fmt } });
    else skipped.push(mediaLabel(m));
  }
  const note = skipped.length ? `[The person attached ${skipped.join(', ')}, but the current model cannot open it (no Gemini key was free). Tell them this kind of attachment can't be read right now; ask for the text instead.]` : '';
  parts.unshift({ type: 'text', text: [it.text, note, capsNote(refused)].filter(Boolean).join('\n\n') || '(attachment)' });
  return parts;
}

export function toOpenAIMessages(system, items, caps = null) {
  const msgs = [{ role: 'system', content: system }];
  let pics = [];        // 2.3.6: pictures from tools go in one user message right after the tool answers
  const flush = () => {
    if (!pics.length) return;
    const parts = pics.flatMap(({ it, parts }) => parts.map(p => p.inlineData ? { type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } } : { type: 'text', text: p.text }));
    msgs.push({ role: 'user', content: parts });
    pics = [];
  };
  for (const it of items) {
    if (it.role !== 'tool') flush();
    if (it.role === 'user') msgs.push({ role: 'user', content: openaiUserContent(it, caps) });
    else if (it.role === 'assistant') msgs.push({ role: 'assistant', content: it.text || null, ...(it.calls?.length ? { tool_calls: it.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) });
    else if (it.role === 'tool') {
      msgs.push({ role: 'tool', tool_call_id: it.id, content: JSON.stringify(it.result) });
      const parts = toolMediaParts(it, caps);
      if (parts.length) pics.push({ it, parts });
    }
  }
  flush();
  return msgs;
}

// 2.3.14: OpenAI and Groq name the answer-length field max_completion_tokens (OpenAI's reasoning models refuse max_tokens);
// other OpenAI-compatible providers read max_tokens.
const maxField = (base) => /api\.openai\.com|groq\.com/i.test(String(base || '')) ? 'max_completion_tokens' : 'max_tokens';
async function openaiCompat({ system, items, tools, noTools, base, model, key, caps, extraBody = null, onFail = null, onUsage = null, bodyFor = null, maxOut = 0 }) {
  base = String(base || '').replace(/\/+$/, '');
  if (!model) throw keyFail({ kind: 'model', reason: 'no model name — tap Test and pick one', until: 0, problem: 'model not found' });
  const msgs = toOpenAIMessages(system, items, caps);
  const useTools = tools?.length && !noTools ? tools : null;
  let body;
  if (bodyFor) body = bodyFor(msgs, useTools);          // 2.3.14: Cloudflare builds its own body (its schema is stricter)
  else {
    body = { model, messages: msgs, ...(extraBody || {}) };
    if (useTools) body.tools = useTools.map(t => ({ type: 'function', function: t }));
    if (maxOut) body[maxField(base)] = maxOut;          // 2.3.14: a size-capped request also caps the answer (the limit counts both)
  }
  const r = await postOnce(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) }, 'openai');
  if (r.status === 400 && hasToolPictures(items)) { log('model', model, 'refused a tool picture; sending without it'); return openaiCompat({ system, items: withoutToolPictures(items), tools, noTools, base, model, key, caps, extraBody, onFail, onUsage, bodyFor, maxOut }); }
  if (!r.ok) throw onFail ? onFail(r.status, await r.text().catch(() => '')) : await failFrom(r, 'openai');      // 2.3.13: Cloudflare reads its own errors
  const j = await r.json().catch(() => ({}));
  if (onUsage) { try { onUsage(j.usage || null); } catch {} }
  const m = j.choices?.[0]?.message || {};
  const calls = (m.tool_calls || []).map(c => { let a = {}; try { a = JSON.parse(c.function.arguments || '{}'); } catch {} return { id: c.id, name: c.function.name, args: a }; });
  return { text: (m.content || '').trim(), calls };
}

/**
 * 2.3.13: chat with his Cloudflare key (Workers AI's OpenAI-compatible Chat Completions, his free daily amount).
 * Same messages and tools as any OpenAI-compatible key. Cloudflare's own errors decide the rest: out of today's free
 * amount (429 / 3036) → the key rests until 00:00 UTC and the next key answers. The Neurons are added to the same
 * daily estimate as the pictures (2.3.12's counter). The token only travels in the Authorization header.
 */
async function cfChat({ system, items, tools, noTools, key, k, caps, maxOut = 0 }) {
  const { cfChatBase, cfChatFail, chatNeurons, CF_CHAT_MAX_TOKENS, cfChatBody } = await import('./cfchat.js');
  const { cfAddUsage, cfMarkUsedUp, cleanAccountId } = await import('./cloudflare.js');
  rememberSecret(key);
  if (!key) throw keyFail({ kind: 'bad_key', reason: 'no API token saved — paste it and tap Save', until: 0, problem: 'bad key' });
  if (!cleanAccountId(k.base_url)) throw keyFail({ kind: 'bad_key', reason: 'the Account ID is not right — fix it and tap Test', until: 0, problem: 'key not allowed' });
  const model = aikeys.cfChatModelOf(k);
  // 2.3.14: the body is built to Workers AI's own schema (cfChatBody: string content everywhere, tools with type +
  // description on every property). A chat model whose Test showed it can't call tools gets plain chat (no tools).
  // If Cloudflare still answers "Bad input" (the request didn't fit the model's schema), one more try in the plainest
  // documented shape (role + text only, no tools) before the next key.
  const noToolModel = caps?.tools === false;
  const go = (plain) => openaiCompat({ system, items, tools, noTools, base: cfChatBase(k.base_url), model, key, caps,
    bodyFor: (msgs, useTools) => cfChatBody({ model, messages: msgs, tools: useTools, plain, maxTokens: maxOut || CF_CHAT_MAX_TOKENS }),      // Cloudflare's default is only 256 tokens
    onFail: (status, text) => { const c = cfChatFail(status, text, key); if (c.perDay) cfMarkUsedUp(k.id); return keyFail(c); },
    onUsage: (u) => cfAddUsage(k.id, chatNeurons(model, u || {})) });
  try { return await go(noToolModel); }
  catch (e) {
    if (noToolModel || !e.keyFail?.badInput) throw e;
    log('model', model, 'Cloudflare said bad input; trying plain chat');
    return go(true);
  }
}

// ---------------- 2.3.14: requests that are too large for a key ----------------
// A free Groq key allows only ~6,000–12,000 tokens a minute per model (8,000 for gpt-oss-120b), and ONE request counts
// all of it: the system prompt, the history, every tool's description (~10,000 tokens for the full list) and the room
// for the answer. Such a key answers 413 "Request too large". Then the same key gets one smaller request (fitToSize)
// before the next key is tried; the limit in the error is remembered for that key, so later requests start small.
const CHARS_PER_TOKEN = 3.2;      // careful: real text is ~4 characters a token; JSON and other languages are denser
export function estimateTokens(x) { return Math.ceil(JSON.stringify(x ?? '').length / CHARS_PER_TOKEN); }
const CORE_TOOLS = ['calculator', 'memory_recall', 'memory_save', 'web_search', 'web_fetch', 'tasks_add', 'tasks_list', 'schedule_job', 'notify_me', 'react', 'send_file'];
const TOOL_WORDS = [
  [/e-?mail|gmail|inbox|mail\b/i, /^gmail_|^inbox_/], [/calendar|meeting|event|appointment/i, /^calendar_/], [/drive|\bdocs?\b|sheet|spreadsheet/i, /^drive_|^docs_|^sheets_/],
  [/contact|phone number/i, /^contacts_/], [/remind|reminder|every (day|week|morning)|schedule|later/i, /^schedule_|^tasks_/], [/task|to-?do/i, /^tasks_/],
  [/site|website|web ?page|publish/i, /site|publish|pages/], [/browser|log ?in|sign ?up|account|password|click/i, /^browser_|^signup_/],
  [/picture|image|photo|draw|logo/i, /^image_|^send_file$/], [/video/i, /^video_/], [/apk|android|app\b/i, /^android_/], [/server|ssh|command|terminal/i, /^ssh_|^servers_|^run_command$/],
  [/file|folder|project|code/i, /^file_|^project_|^run_command$/], [/whatsapp|sms|text (him|her|them)|message (him|her)/i, /^whatsapp_send$|^sms_send$/], [/github|repo/i, /^github_/],
  [/update|version/i, /^check_update$/], [/remember|memory|forget/i, /^memory_/], [/search|look up|find|news|price|weather/i, /^web_/],
];
function shortTool(t) {
  const cut = (x, n) => { x = String(x || ''); const one = x.split(/(?<=[.!?])\s/)[0]; return (one.length <= n ? one : x.slice(0, n - 1) + '…'); };
  const p = t.parameters && typeof t.parameters === 'object' ? t.parameters : null;
  const props = {};
  for (const [k, v] of Object.entries(p?.properties || {})) props[k] = v && typeof v === 'object' ? { ...v, ...(v.description ? { description: cut(v.description, 80) } : {}) } : v;
  return { ...t, description: cut(t.description, 160), ...(p ? { parameters: { ...p, properties: props } } : {}) };
}
function pickTools(tools, items, userText, budget) {
  const used = new Set(items.flatMap(it => (it.calls || []).map(c => c.name)));
  const score = (t) => {
    let s = used.has(t.name) ? 1000 : 0;
    if (CORE_TOOLS.includes(t.name)) s += 5;
    for (const [said, names] of TOOL_WORDS) if (said.test(userText) && names.test(t.name)) s += 20;
    const words = new Set(String(userText).toLowerCase().match(/[a-z]{4,}/g) || []);
    for (const w of words) { if (t.name.includes(w)) s += 10; else if (String(t.description || '').toLowerCase().includes(w)) s += 1; }
    return s;
  };
  const ranked = tools.map((t, i) => ({ t: shortTool(t), s: score(t), i })).sort((a, b) => b.s - a.s || a.i - b.i);
  const out = []; let size = 0;
  for (const r of ranked) {
    const n = estimateTokens(r.t);
    if (size + n > budget && !(r.s >= 1000)) continue;       // a tool this job already called always stays
    out.push(r); size += n;
  }
  return out.sort((a, b) => a.i - b.i).map(r => r.t);
}
const clip = (s, n) => { s = String(s ?? ''); return s.length <= n ? s : s.slice(0, n) + `… [${s.length - n} more characters cut to fit this AI key's size limit]`; };
const MEDIA_NOTE = (it) => `[${(it.media || []).length} attachment(s) left out: this AI key only takes small requests]`;
/**
 * args ({system, items, tools, noTools}) cut down to about capTokens: fewer tools (the ones this job used, the ones his
 * words point at, then the everyday ones) with shorter descriptions, no attachments, long tool answers and messages
 * shortened, then the oldest history dropped. His current message and this job's steps always stay (tool calls keep
 * their answers, so the conversation still fits together). → { args, trimmed, est, maxOut }
 */
export function fitToSize(args, capTokens, { force = false } = {}) {
  const maxOut = Math.max(512, Math.min(2048, Math.floor(capTokens * 0.25)));
  const room = Math.floor(capTokens * 0.9) - maxOut;
  const est = (a) => estimateTokens({ s: a.system, i: a.items, t: a.noTools ? [] : a.tools || [] });
  if (!force && est(args) <= room) return { args, trimmed: false, est: est(args), maxOut };
  let items = (args.items || []).map(it => ({ ...it }));
  // where this job starts: his message just before the first tool call (or his last message)
  let start = items.findIndex(it => it.role === 'tool' || (it.calls && it.calls.length));
  start = start < 0 ? items.length : start;
  let cur = -1; for (let i = start - 1; i >= 0; i--) if (items[i].role === 'user') { cur = i; break; }
  if (cur < 0) cur = Math.max(0, items.findLastIndex(it => it.role === 'user'));
  const userText = String(items[cur]?.text || '');
  let tools = args.tools || [];
  const a = () => ({ ...args, items, tools });
  const fits = () => !force && est(a()) <= room;
  const lastTool = () => items.findLastIndex(it => it.role === 'tool');
  const clipTools = (nLast, nOther) => { const lt = lastTool(); items = items.map((it, i) => { if (it.role !== 'tool') return it; const j = JSON.stringify(it.result ?? null); const n = i === lt ? nLast : nOther; return j.length > n ? { ...it, result: { shortened: clip(j, n) } } : it; }); };
  const clipText = (n, nCur) => { items = items.map((it, i) => it.text && it.text.length > (i === cur ? nCur : n) ? { ...it, text: clip(it.text, i === cur ? nCur : n) } : it); };
  // 1. fewer tools, shorter descriptions (the full list alone is ~10,000 tokens)
  if (tools.length && !args.noTools) tools = pickTools(tools, items, userText, Math.floor(room * 0.45));
  // 2. attachments out (one picture is tens of thousands of tokens)
  items = items.map(it => !(it.media && it.media.length) ? it : it.role === 'tool'
    ? { ...it, media: undefined, result: { ...(it.result && typeof it.result === 'object' ? it.result : { result: it.result }), picture: 'left out: this AI key only takes small requests' } }
    : { ...it, media: undefined, text: [it.text, MEDIA_NOTE(it)].filter(Boolean).join('\n\n') });
  // 3. long tool answers shortened (the latest keeps more), long messages shortened (his current one keeps more)
  if (!fits()) clipTools(2500, 800);
  if (!fits()) clipText(2000, 6000);
  // 4. the oldest history first (never his current message or this job's steps); start with his words
  while (est(a()) > room && cur > 0) { items.splice(0, 1); cur--; }
  while (items.length > 1 && items[0].role !== 'user' && cur > 0) { items.splice(0, 1); cur--; }
  // 5. still too big: harder
  if (est(a()) > room) { clipTools(1200, 300); clipText(600, 2500); }
  if (est(a()) > room && tools.length) tools = pickTools(tools, items, userText, Math.floor(room * 0.2));
  return { args: a(), trimmed: true, est: est(a()), maxOut };
}

let mockFn = null;
const heavyMedia = (items) => items.some(it => (it.media || []).some(m => m.kind !== 'image'));
const anyMedia = (items) => items.some(it => (it.media || []).length);
const mediaKindsOf = (items) => [...new Set(items.flatMap(it => (it.media || []).map(m => m.kind)).filter(k => ['image', 'audio', 'pdf'].includes(k)))];

// ---------------- 2.3.1: which kind of job is this model call for ("Use for") ----------------
export const CODING_TOOLS = new Set(['project_list', 'file_write', 'file_read', 'file_list', 'run_command', 'publish_site', 'unpublish_site', 'sites_list',
  'github_publish', 'cloudflare_pages_publish', 'android_build_apk', 'ssh_run', 'servers_list', 'site_screenshot', 'video_make']);
const CODE_WORDS = /```|\b(code|coding|coder|program(ming)?|script|function|bug|debug|compile|refactor|html|css|javascript|typescript|python|node\.?js|react|kotlin|java|php|sql|regex|json|yaml|repo(sitory)?|github|git|commit|apk|android app|web ?site|web ?app|landing page|deploy|ssh|docker|nginx|stack ?trace|syntax|unit tests?|api endpoint|backend|frontend|build (me )?(an?|the) (app|site|tool|bot|page))\b/i;
export function looksLikeCode(text) { return CODE_WORDS.test(String(text || '')); }
/**
 * media: the request carries a voice note, photo, PDF, or he attached any file (Word, Excel, zip…) · coding: building/servers tools are
 * in play, or his words are clearly about code · background: scheduled jobs and helpers · else chat.
 * (Pictures are the image_generate tool, which picks its own key.)
 */
export function jobKind({ items = [], channel = 'web', isHelper = false, codeText = false, hasFiles = false } = {}) {
  if (hasFiles) return 'media';                                  // he attached something to this message
  const toolsUsed = items.some(it => it.role === 'assistant' && (it.calls || []).some(c => CODING_TOOLS.has(c.name)));
  const code = toolsUsed || codeText, bg = isHelper || channel === 'system';
  if (bg && !code) return 'background';                         // scheduled jobs and helpers (even if the chat had a voice note)
  if (anyMedia(items)) return 'media';                          // a recent voice note/photo/PDF travels along in the history
  if (code) return 'coding';
  if (bg) return 'background';
  return 'chat';
}
const bullet = (rows) => rows.map(x => `• ${x.name}: ${x.reason}`).join('\n');

/**
 * 2.3 failover: try the active AI keys in order for THIS model call. A key that hits its limit, is
 * refused, or whose provider is down gets a status (and a rest when waiting helps), and the same
 * request goes to the next key. Only the model call is repeated, never a tool: tools run after
 * an answer comes back, once.
 */
export async function callModel(args, opts = {}) {
  if (cfg.testMode && cfg.mockModule) {
    if (!mockFn) mockFn = (await import(cfg.mockModule)).default;
    return mockFn(args);
  }
  const withMedia = heavyMedia(args.items || []);
  const use = opts.use && aikeys.USES.includes(opts.use) ? opts.use : null;
  const keys = aikeys.usableKeys({ withMedia, use, mediaKinds: mediaKindsOf(args.items || []) });
  if (!keys.length) {
    const any = aikeys.listRows().length;
    const e = userError(any ? 'All AI keys are switched off (or have no key saved). Open the dashboard → AI keys and switch one on.'
      : 'No AI key yet. Open the dashboard → AI keys → Add key (a free Gemini key comes from aistudio.google.com/apikey).');
    e.noKeys = true; throw e;
  }
  const reasons = new Map();            // key id → why it was not used, for the final message
  const retryable = new Set();          // ids that failed in a way a short wait may fix
  const prevInUse = setting('ai_key_in_use');
  for (let pass = 0; pass < 3; pass++) {
    for (const k0 of keys) {
      const k = aikeys.keyRow(k0.id); if (!k || !k.active) continue;
      if (pass > 0 && !retryable.has(k.id)) continue;
      if (k.cool_until > now()) { if (!reasons.has(k.id)) reasons.set(k.id, `${k.last_error || 'resting'}${/until|resets/.test(k.last_error || '') ? '' : ' (resting until ' + aikeys.clock(k.cool_until) + ')'}`); retryable.add(k.id); continue; }
      if (k.problem === 'model not found') { reasons.set(k.id, k.last_error || 'model not found — tap Test and pick one from the list'); continue; }
      try {
        const key = aikeys.keyValue(k.id);
        const caps = aikeys.freshCaps(k);      // 2.3.2: null for a key that was never tested → exactly like 2.3.1
        const once = (a, maxOut = 0) => k.kind === 'gemini'
          ? gemini({ ...a, key, model: k.model || setting('model'), caps })
          : k.kind === 'cloudflare' ? cfChat({ ...a, key, k, caps, maxOut })          // 2.3.13
          : openaiCompat({ ...a, key, base: k.base_url, model: k.model, caps, maxOut });
        // 2.3.14: a key known to take only small requests (a limit it told us before, or a free Groq key) gets a request
        // cut to fit; a "request too large" answer gets ONE smaller try on the same key before the next key.
        const cap = aikeys.sizeCap(k);
        const first = cap ? fitToSize(args, cap) : { args, trimmed: false, maxOut: 0 };
        if (first.trimmed) log('brain', `key "${k.name}": request cut to ~${first.est} tokens to fit its limit (${cap})`);
        let resp;
        try { resp = await once(first.args, first.maxOut); }
        catch (e) {
          if (e.keyFail?.kind !== 'too_large') throw e;
          const f = e.keyFail;
          if (f.limit) aikeys.learnSizeCap(k.id, f.limit);
          const sent = estimateTokens({ s: first.args.system, i: first.args.items, t: first.args.noTools ? [] : first.args.tools || [] });
          const target = f.limit ? Math.min(f.limit, cap || f.limit) : Math.max(2000, Math.floor(Math.min(sent, f.requested || sent) * 0.5));
          const smaller = fitToSize(args, Math.floor(target * (first.trimmed && !f.limit ? 0.7 : 1)), { force: true });
          log('brain', `key "${k.name}": request too large (${f.requested || '?'} of ${f.limit || '?'} tokens); one more try at ~${smaller.est} tokens`);
          try { resp = await once(smaller.args, smaller.maxOut); }
          catch (e2) { if (e2.keyFail?.kind === 'too_large') e2.keyFail.reason += ' (also after making the request smaller)'; throw e2; }
        }
        aikeys.markOk(k.id);
        if (String(k.id) !== prevInUse && reasons.size) {
          const [fid, why] = [...reasons.entries()][0];
          const from = keys.find(x => x.id === fid)?.name || 'previous key';
          audit('assistant', 'brain.switch', `Switched from '${from}' to '${k.name}': ${why}`);
        } else if (String(k.id) !== prevInUse && prevInUse) audit('assistant', 'brain.switch', `Using '${k.name}' again`);
        return { ...resp, keyId: k.id, keyName: k.name, keyKind: k.kind, use, tagged: !!k0.tagged };
      } catch (e) {
        if (!e.keyFail) throw e;
        aikeys.markFail(k.id, e.keyFail);
        reasons.set(k.id, e.keyFail.reason);
        if (['quota', 'server', 'network'].includes(e.keyFail.kind)) retryable.add(k.id); else retryable.delete(k.id);
        log('brain', `key "${k.name}" failed:`, e.keyFail.reason);
      }
    }
    // Nothing answered. If a key is only resting for a short per-minute limit, wait for it once more.
    const t = now();
    const soon = keys.map(k => aikeys.keyRow(k.id)).filter(k => k && retryable.has(k.id) && k.cool_until > t).map(k => k.cool_until);
    const wait = soon.length ? Math.min(...soon) - t + 250 : Infinity;
    if (pass < 2 && wait <= 65000 && (!opts.deadline || t + wait < opts.deadline)) { await sleep(wait); continue; }
    break;
  }
  const rows = keys.map(k => ({ name: k.name, reason: reasons.get(k.id) || 'did not answer' }));
  const off = aikeys.listRows().filter(r => !r.active).length;
  const e = userError(`No AI key could answer:\n${bullet(rows)}${off ? `\n(${off} more switched off.)` : ''}\nFix or add keys in the dashboard → AI keys.`);
  // Message Assistant: when every key is only resting (limits that come back by themselves), the message waits
  // in the queue instead of failing; retryAt = the first moment a key is free again.
  const t2 = now();
  const rest = keys.map(k => aikeys.keyRow(k.id)).filter(Boolean);
  const resting = rest.filter(k => retryable.has(k.id) || k.cool_until > t2);
  if (rest.length && resting.length === rest.length) {
    e.allResting = true;
    const at = rest.map(k => k.cool_until).filter(x => x > t2);
    e.retryAt = at.length ? Math.min(...at) : t2 + 60000;
  }
  throw e;
}
function userError(msg) { const e = new Error(msg); e.userMessage = msg; return e; }


/** Message Assistant: the dashboard's "Test" on one key — one tiny request to that key only. */
export async function testKeyById(id) {
  const k = aikeys.keyRow(id);
  if (!k) return { ok: false, error: 'That key was removed' };
  const key = aikeys.keyValue(k.id);
  const args = { system: 'Reply with the single word OK.', items: [{ role: 'user', text: 'Say OK' }], tools: [] };
  try {
    const r = k.kind === 'gemini' ? await gemini({ ...args, key, model: k.model || setting('model') })
      : k.kind === 'cloudflare' ? await cfChat({ ...args, key, k })
      : await openaiCompat({ ...args, key, base: k.base_url, model: k.model, maxOut: 20 });
    aikeys.markTested(k.id);
    return { ok: true, reply: String(r.text || '').slice(0, 60), key: aikeys.publicKey(aikeys.keyRow(k.id)) };
  } catch (e) {
    if (e.keyFail) { aikeys.markFail(k.id, e.keyFail, { fromTest: true }); return { ok: false, error: e.keyFail.reason, key: aikeys.publicKey(aikeys.keyRow(k.id)) }; }
    return { ok: false, error: redact(String(e.message || e)).slice(0, 200) };
  }
}
