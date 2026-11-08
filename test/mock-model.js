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
    // 1.0.2 sites: a well-behaved answer after publish_site / site_screenshot (or a chatty one that repeats the YES)
    const lu = [...items].reverse().find(i => i.role === 'user');
    if (last.name === 'publish_site' && !last.result.error) return { text: /chatty/.test(lu?.text || '') ? 'Done! I sent you the request, reply YES to publish it.' : '', calls: [] };
    if (last.name === 'site_screenshot' && !last.result.error) return { text: 'Here is how it looks on a phone.', calls: [] };
    if (last.name === 'file_write' && /paste/.test(lu?.text || '')) return { text: 'Made it:\n```html\n<!doctype html><html><body><h1>Hi</h1></body></html>\n```', calls: [] };
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
  // 1.0.2 sites
  if (!noTools && (m = /^write (\S+) (\S+) ([\s\S]+)/i.exec(t))) return { text: '', calls: [{ id, name: 'file_write', args: { project: m[1], path: m[2], content: m[3] } }] };
  if (!noTools && (m = /^paste (\S+)/i.exec(t))) return { text: '', calls: [{ id, name: 'file_write', args: { project: m[1], path: 'index.html', content: '<h1>Hi</h1>' } }] };
  if (!noTools && (m = /^read (\S+) (\S+)/i.exec(t))) return { text: '', calls: [{ id, name: 'file_read', args: { project: m[1], path: m[2] } }] };
  if (!noTools && (m = /^files (\S+)/i.exec(t))) return { text: '', calls: [{ id, name: 'file_list', args: { project: m[1] } }] };
  if (!noTools && (m = /^shot (\S+)/i.exec(t))) return { text: '', calls: [{ id, name: 'site_screenshot', args: { project: m[1] } }] };
  if (!noTools && (m = /^(?:chatty )?publish (\S+)(?: as (\S+))?/i.exec(t))) return { text: '', calls: [{ id, name: 'publish_site', args: { project: m[1], ...(m[2] ? { name: m[2] } : {}) } }] };
  if (!noTools && (m = /^unpublish (\S+)/i.exec(t))) return { text: '', calls: [{ id, name: 'unpublish_site', args: { name: m[1] } }] };
  if (!noTools && /^my sites/i.test(t)) return { text: '', calls: [{ id, name: 'sites_list', args: {} }] };
  if (/^slow/i.test(t)) await new Promise(r => setTimeout(r, 300));
  return { text: `**echo**: ${lastUser ? lastUser.text : t}`, calls: [] };
}
