// Learns "mail from X usually goes to folder Y" from where the user has
// already filed things. Accepted / rejected suggestions feed back in.

import type { Email, Folder, SenderHabit } from "@/lib/types";

export function computeHabits(
  emails: Email[],
  folders: Folder[],
): Map<string, SenderHabit> {
  const userFolders = new Set(folders.filter((f) => !f.system).map((f) => f.id));
  const habits = new Map<string, SenderHabit>();
  for (const e of emails) {
    if (!userFolders.has(e.folderId)) continue;
    recordFiling(habits, e.from.address, e.folderId);
  }
  return habits;
}

export function recordFiling(
  habits: Map<string, SenderHabit>,
  sender: string,
  folderId: string,
): Map<string, SenderHabit> {
  const key = sender.toLowerCase();
  const h = habits.get(key) ?? { sender: key, total: 0, byFolder: {} };
  h.total += 1;
  h.byFolder[folderId] = (h.byFolder[folderId] ?? 0) + 1;
  habits.set(key, h);
  return habits;
}
