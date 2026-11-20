// A stand-in AI that RECORDS the media riding on the person's turn (MSA_MOCK_MODULE for the
// incoming-media tests, 1.1.11). Replies name the kinds it was handed, so a test can also
// watch the answer come back.
export const calls = [];
export default async function mock({ system, items, tools, noTools }) {
  calls.push(JSON.parse(JSON.stringify(items.map(i => ({ role: i.role, text: i.text || '', media: (i.media || []).map(m => ({ kind: m.kind, name: m.name, mime: m.mime, data: m.data })) })))));
  const last = [...items].reverse().find(i => i.role === 'user');
  const kinds = (last?.media || []).map(m => m.kind).join('+');
  return { text: kinds ? `mock saw ${kinds}` : 'mock plain answer', calls: [] };
}
