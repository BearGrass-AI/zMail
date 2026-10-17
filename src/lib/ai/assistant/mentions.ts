// @-mentions in the assistant input: which picked people are still in the text,
// and the note that gives the model their addresses.

export interface MentionRef {
  name: string;
  address: string;
}

const BOUNDARY = /[\s.,;:!?)\]]/;

/** Where each picked "@Name" sits in the text. Whole names only (longest first, so "@Tom Smith" isn't also "@Tom"), never overlapping. */
export function mentionSpans(text: string, picked: MentionRef[]): { start: number; end: number; ref: MentionRef }[] {
  const spans: { start: number; end: number; ref: MentionRef }[] = [];
  const byLength = [...picked].sort((a, b) => b.name.length - a.name.length);
  for (const ref of byLength) {
    if (!ref.name) continue;
    const needle = `@${ref.name}`;
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
      const end = i + needle.length;
      if (end < text.length && !BOUNDARY.test(text[end])) continue;
      if (spans.some((s) => i < s.end && end > s.start)) continue;
      spans.push({ start: i, end, ref });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** Picked people whose "@Name" is still in the text, first appearance order, one per address. */
export function liveMentions(text: string, picked: MentionRef[]): MentionRef[] {
  const seen = new Set<string>();
  return mentionSpans(text, picked)
    .map((s) => s.ref)
    .filter((m) => {
      const k = m.address.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** The model's copy of the message: the text plus who each @Name is. Unchanged when nobody is mentioned. */
export function withMentions(text: string, mentions: MentionRef[] | undefined): string {
  const live = liveMentions(text, mentions ?? []);
  if (!live.length) return text;
  return `${text}\n\n[People I @mentioned: ${live.map((m) => `${m.name} <${m.address}>`).join("; ")}. Use these addresses; no need to look them up.]`;
}

/** The text cut into plain runs and "@Name" runs, for emphasis in the user's bubble. */
export function splitMentions(text: string, mentions: MentionRef[]): { text: string; mention: boolean }[] {
  const parts: { text: string; mention: boolean }[] = [];
  let at = 0;
  for (const sp of mentionSpans(text, mentions)) {
    if (sp.start > at) parts.push({ text: text.slice(at, sp.start), mention: false });
    parts.push({ text: text.slice(sp.start, sp.end), mention: true });
    at = sp.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mention: false });
  return parts;
}
