// 1.0.8: a stand-in AI that behaves like a search-happy model (what happened on Abish's free Gemini key: 21 AI calls
// for 2 answers). It asks for one more web_search every time tools are allowed, and answers only when they are not.
export const calls = [];
export default async function greedy({ system, items, tools, noTools }) {
  calls.push({ noTools: !!noTools, tools: (tools || []).length });
  const lastUser = [...items].reverse().find(i => i.role === 'user');
  // a plain-chat call it judges wrong: the model asks for the tools (1.0.8 escape)
  if (/NEED_TOOLS/.test(system || '') && /^sing me/i.test(String(lastUser?.text || ''))) return { text: 'NEED_TOOLS', calls: [] };
  if (noTools || !(tools || []).some(t => t.name === 'web_search')) return { text: 'answer to: ' + String(lastUser?.text || '').slice(0, 40), calls: [] };
  const n = items.filter(i => i.role === 'tool').length;
  return { text: '', calls: [{ id: 'g' + calls.length, name: 'web_search', args: { query: 'look ' + n } }] };
}
