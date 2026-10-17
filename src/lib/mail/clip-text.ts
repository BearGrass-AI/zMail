// Capping email text that gets cached.

/**
 * The first `max` UTF-16 units of `s`, or one fewer when the cut would land between the two halves
 * of a surrogate pair (an emoji, say). Half a pair cached as `\ud83d` comes back from SQLite as
 * bytes that aren't UTF-8, which the cache's readers can't decode.
 */
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
