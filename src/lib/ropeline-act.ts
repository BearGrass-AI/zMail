// Acting on a RopeLine verdict. Flag-only unless the user turns this on.
// Confident spam goes to the provider's Spam folder. Trash is not used.

import type { RopeLineFlag } from "@/lib/ropeline";

export const SPAM_REASON = "RopeLine: confident spam";

/** Inbox ids whose hosted verdict is spam. Empty while acting is off, and for every other verdict. */
export function confidentSpamIds(
  emails: { id: string; folderId: string }[],
  flags: Record<string, Pick<RopeLineFlag, "verdict"> | undefined>,
  inboxIds: Set<string>,
  act: boolean,
): string[] {
  if (!act) return [];
  return emails.filter((e) => inboxIds.has(e.folderId) && flags[e.id]?.verdict === "spam").map((e) => e.id);
}
