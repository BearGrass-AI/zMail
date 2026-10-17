import type { Email } from "@/lib/types";

/** The quoted block under a forward. */
export function forwardBody(e: Email) {
  return `\n\n---------- Forwarded message ----------\nFrom: ${e.from.name} <${e.from.address}>\nSubject: ${e.subject}\n\n${e.text}`;
}

/**
 * Who a reply goes to. Reply: the sender. Reply all: the sender plus the other To
 * recipients in To, and the original Cc in Cc. The user's own addresses and duplicates
 * are dropped (case-insensitive); if that leaves To empty (the user wrote the email),
 * the original To recipients are used.
 */
export function replyRecipients(e: Email, mine: string[], all: boolean): { to: string[]; cc: string[] } {
  const me = new Set(mine.map((a) => a.toLowerCase()));
  const seen = new Set<string>();
  const keep = (list: { address: string }[]) =>
    list.map((c) => c.address).filter((a) => {
      const k = a.toLowerCase();
      if (!a || me.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  if (!all) {
    const to = keep([e.from]);
    // Only the user's own email falls back to its To; a sender with no usable address
    // (a malformed From) gets an empty To rather than a reply to the other recipients.
    return { to: to.length || !me.has(e.from.address.toLowerCase()) ? to : keep(e.to), cc: [] };
  }
  let to = keep([e.from, ...e.to]);
  if (!to.length) to = keep(e.to);
  return { to, cc: keep(e.cc ?? []) };
}
