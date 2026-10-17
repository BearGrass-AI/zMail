// Counts shown next to lanes, sections and account chips are unread emails (like the dock badge):
// opening an email doesn't move it out of its lane, but it stops counting.

export const unreadCount = (emails: readonly { unread?: boolean }[]) => emails.reduce((n, e) => n + (e.unread ? 1 : 0), 0);

export type TodayShow = "all" | "unread";

/**
 * A Today list with unread mail first (each part keeps its order) and read mail after, or
 * without the read mail at all. `keep` (the open email, or all emails opened this visit) counts
 * as unread, so it doesn't jump below the divider (or vanish) the moment opening it marks it read.
 */
export function todayList<T extends { id: string; unread?: boolean }>(list: T[], show: TodayShow, keep?: ReadonlySet<string> | string | null): { list: T[]; read: number } {
  const kept = (id: string) => (typeof keep === "string" ? id === keep : !!keep && keep.has(id));
  const isUnread = (e: T) => !!e.unread || kept(e.id);
  const unread = list.filter(isUnread);
  const read = list.filter((e) => !isUnread(e));
  return { list: show === "unread" ? unread : [...unread, ...read], read: read.length };
}

export type NeedsSort = "urgency" | "newest" | "oldest";

/** Needs you in the chosen order. "urgency" keeps the model's order (most urgent first). */
export function sortNeeds<T extends { date: string }>(list: T[], sort: NeedsSort): T[] {
  if (sort === "urgency") return list;
  const dir = sort === "newest" ? -1 : 1;
  return [...list].sort((a, b) => dir * (Date.parse(a.date) - Date.parse(b.date)));
}
