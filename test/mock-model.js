// A stand-in AI for routing / isolation tests (MSA_MOCK_MODULE). It follows simple words in the person's last message:
//   "remember <x>"  → memory_save(x)            "what do you remember" → memory_recall
//   "remind me <x>" → reminder_add in 1 hour     "search <x>" → web_search
//   "browse <url>"  → browser_open(url)          anything else → "echo: <text>"
// After a tool answer it replies with a short summary that includes the tool's result (so tests can check it).
let n = 0;
export const calls = [];
export default async function mock({ system, items, tools, noTools }) {
  calls.push({ system, items: JSON.parse(JSON.stringify(items.map(i => ({ ...i, raw: undefined, media: undefined })))), tools: (tools || []).map(t => t.name) });
  const last = items[items.length - 1];
  if (last.role === 'tool') {
    const r = JSON.stringify(last.result).slice(0, 300);
    return { text: `done ${last.name}: ${r}`, calls: [] };
  }
  const t = String(last.text || '');
  const lastUser = [...items].reverse().find(i => i.role === 'user');
  const id = 'call-' + (++n);
  let m;
  if (!noTools && (m = /^remember (.+)/i.exec(t))) return { text: '', calls: [{ id, name: 'memory_save', args: { fact: m[1] } }] };
  if (!noTools && /what do you remember/i.test(t)) return { text: '', calls: [{ id, name: 'memory_recall', args: {} }] };
  if (!noTools && (m = /^remind me (.+)/i.exec(t))) return { text: '', calls: [{ id, name: 'reminder_add', args: { text: m[1], when: new Date(Date.now() + 3600000).toISOString() } }] };
  if (!noTools && (m = /^cancel reminder (\d+)/i.exec(t))) return { text: '', calls: [{ id, name: 'reminder_cancel', args: { id: Number(m[1]) } }] };
  if (!noTools && (m = /^search (.+)/i.exec(t))) return { text: '', calls: [{ id, name: 'web_search', args: { query: m[1] } }] };
  if (!noTools && (m = /^browse (.+)/i.exec(t))) return { text: '', calls: [{ id, name: 'browser_open', args: { url: m[1] } }] };
  if (/^slow/i.test(t)) await new Promise(r => setTimeout(r, 300));
  return { text: `**echo**: ${lastUser ? lastUser.text : t}`, calls: [] };
}
