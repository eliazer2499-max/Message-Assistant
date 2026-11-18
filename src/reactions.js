// 1.1.4: reactions (Abish: "when I ask to look for something, react with 🔍 — like a human would react").
// When a person's message asks the assistant to DO something, the assistant reacts to that message itself
// (RCS / Google Messages reaction on their bubble) with the emoji that fits what they said — instantly, before
// the answer is even written. Plain chat gets no reaction (a human doesn't react to everything either).
const RULES = [
  [/thank|\btoda\b|🙏/i, '❤️'],
  [/song|music|youtube|video|play (me|the|a)|listen|shiur|lecture|niggun|album/i, '🎵'],
  [/\b(look|search|find|check|google)\b|look up|what(’|')?s|what is|who is|when (is|does|did)|where (is|can)|how (much|many|long|far)/i, '🔍'],   // nouns alone (weather/news/price) don't count — a statement about the weather is just chat; a question still lands here via what's/how, or via the trailing-? rule
  [/remind|alarm|wake me|at \d{1,2}(:\d{2})?\s*(am|pm)|tomorrow at/i, '⏰'],
  [/joke|funny|make me laugh|😂|🤣/i, '😂'],
  [/love|amazing|awesome|incredible|beautiful|mazal tov|congrat/i, '❤️'],
  [/sad|sorry to hear|passed away|not feeling|terrible|awful/i, '😢'],
  [/wow|omg|unbelievable|no way|really\?!/i, '😮'],
  [/^(hi+|hey+|hello|shalom|good (morning|afternoon|evening))\b/i, '👋'],
  [/picture|photo|image|draw|paint/i, '🎨'],
  [/email|gmail|calendar|meeting|schedule/i, '📅'],
  [/send|give me|get me|bring me|show me|download|extract|convert|write|make|create|build|set|add|book|order|buy|translate|summari[sz]e|explain|tell me|help me|can you|could you|please|do it|go ahead/i, '👍'],
];
/** The reaction for an incoming message, or '' for none. */
export function reactionFor(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 300) return '';
  for (const [re, emoji] of RULES) if (re.test(t)) return emoji;
  if (/\?\s*$/.test(t)) return '🔍';                    // a question is a small search
  if (/^(yes|yeah|yep|ok|okay|sure|go|do it)[\s!.]*$/i.test(t)) return '👍';
  return '';
}
