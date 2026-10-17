// Sidebar unread counts.
// Server counts (Folder.unread) are cached for minutes. Mail actions adjust them locally in
// the same set() as the email change, then one debounced, cheap re-read per account fixes drift.

import type { Email, Folder } from "@/lib/types";
import { useMail } from "@/lib/store";
import { providers } from "./providers";
import type { MailState } from "./types";

const COUNT_WINDOW_MS = 15_000;
const COUNT_MAX_FOLDERS = 5;
/** Locally adjusted counts not yet confirmed by a re-read; a full folder sync must not undo them. */
export const pendingCounts = new Map<string, number>();
const countTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; ids: Set<string> }>();

/** Net change in unread per folder when `patch` is applied to `emails`. */
function unreadDeltas(emails: Email[], patch: (e: Email) => Partial<Email> | undefined) {
  const deltas = new Map<string, number>();
  for (const e of emails) {
    const p = patch(e);
    if (!p) continue;
    const to = p.folderId ?? e.folderId;
    const nowUnread = p.unread ?? e.unread;
    if (e.unread) deltas.set(e.folderId, (deltas.get(e.folderId) ?? 0) - 1);
    if (nowUnread) deltas.set(to, (deltas.get(to) ?? 0) + 1);
  }
  return deltas;
}

/** Apply deltas to folders that carry a server count (never below 0). */
function adjustFolderCounts(folders: Folder[], deltas: Map<string, number>) {
  const touched: string[] = [];
  const next = folders.map((f) => {
    const d = deltas.get(f.id);
    if (!d || f.unread === undefined) return f;
    const unread = Math.max(0, f.unread + d);
    if (unread === f.unread) return f;
    touched.push(f.id);
    pendingCounts.set(f.id, unread);
    return { ...f, unread };
  });
  return { folders: touched.length ? next : folders, touched };
}

/** Compute the patched folders for a state change; call inside set(), then `scheduleCountRefresh`. */
export function countsFor(s: Pick<MailState, "emails" | "folders">, patch: (e: Email) => Partial<Email> | undefined) {
  return adjustFolderCounts(s.folders, unreadDeltas(s.emails, patch));
}

/** One trailing re-read per account per window, for at most a handful of folders. */
export function scheduleCountRefresh(folderIds: string[]) {
  if (!folderIds.length) return;
  const { folders } = useMail.getState();
  for (const id of folderIds) {
    const accountId = folders.find((f) => f.id === id)?.accountId;
    if (!accountId || !providers.get(accountId)?.refreshCounts) continue;
    let slot = countTimers.get(accountId);
    if (!slot) {
      slot = { ids: new Set(), timer: setTimeout(() => void runCountRefresh(accountId), COUNT_WINDOW_MS) };
      countTimers.set(accountId, slot);
    }
    slot.ids.add(id);
  }
}

async function runCountRefresh(accountId: string) {
  const slot = countTimers.get(accountId);
  countTimers.delete(accountId);
  if (!slot) return;
  const all = [...slot.ids];
  const ids = all.slice(0, COUNT_MAX_FOLDERS);
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const counts = await providers.get(accountId)?.refreshCounts?.(ids);
    if (counts && Object.keys(counts).length)
      useMail.setState((s) => ({ folders: s.folders.map((f) => (f.id in counts ? { ...f, unread: counts[f.id] } : f)) }));
  } catch (err) {
    console.warn("[counts] refresh failed", err);
  } finally {
    for (const id of all) pendingCounts.delete(id);
  }
}
