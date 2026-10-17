// The line under a search result: where the query's words are, with them marked.

/** Characters shown before the first match, so it reads in context. */
const LEAD = 24;
/** Characters of the line; the row truncates it further to fit. */
const LINE = 220;

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A line for a result: the snippet when a query word is in it, else the stretch of the body around the
 * first word found there, else the snippet. `words` are lowercase (searchWords).
 */
export function resultLine(e: { snippet: string; text: string }, words: string[]): string {
  const snippet = e.snippet.replace(/\s+/g, " ").trim();
  if (!words.length) return snippet;
  const lower = snippet.toLowerCase();
  if (words.some((w) => lower.includes(w))) return snippet;
  const text = e.text ?? "";
  const body = text.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = body.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return snippet;
  let start = Math.max(0, at - LEAD);
  // Start on a word, not in the middle of one.
  if (start > 0) {
    const space = text.slice(start, at).search(/\s/);
    if (space >= 0) start += space + 1;
  }
  const line = text.slice(start, start + LINE).replace(/\s+/g, " ").trim();
  return start > 0 ? `…${line}` : line;
}

/** `text` split into plain and matched parts (case-insensitive), longest words first so "park" doesn't split "parking". */
export function markParts(text: string, words: string[]): { text: string; hit: boolean }[] {
  const ws = words.filter(Boolean).sort((a, b) => b.length - a.length);
  if (!ws.length || !text) return text ? [{ text, hit: false }] : [];
  const re = new RegExp(`(${ws.map(escape).join("|")})`, "gi");
  const out: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i), hit: false });
    out.push({ text: m[0], hit: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}
