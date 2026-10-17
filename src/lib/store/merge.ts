// Merging a sync's rows into the date-descending email list without losing what the user just did.

import type { Email } from "@/lib/types";

/** Merge two date-descending lists (b is sorted first); stable, with a before b on equal dates. */
export function mergeByDateDesc(a: Email[], b: Email[]): Email[] {
  if (!b.length) return a;
  const sb = [...b].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  const out: Email[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < sb.length) out.push(a[i].date >= sb[j].date ? a[i++] : sb[j++]);
  while (i < a.length) out.push(a[i++]);
  while (j < sb.length) out.push(sb[j++]);
  return out;
}

/**
 * A sync may have read a row before the server applied what the user just did. Mail still being
 * moved keeps its local row (neither replaced nor removed); mail with a read or star change on its
 * way keeps its local `unread` / `starred` on the incoming row. Returns applyEmailChanges' arguments.
 */
export function protectPending(
  changed: Email[],
  removed: string[],
  local: Email[],
  pending: { moving: { has(id: string): boolean }; unread: { has(id: string): boolean }; starred: { has(id: string): boolean } },
): [Email[], string[]] {
  const flagged = (id: string) => pending.unread.has(id) || pending.starred.has(id);
  const mine = changed.some((e) => flagged(e.id)) ? new Map(local.map((e) => [e.id, e])) : null;
  const keep: Email[] = [];
  for (const e of changed) {
    if (pending.moving.has(e.id)) continue;
    const l = mine && flagged(e.id) ? mine.get(e.id) : undefined;
    if (!l) keep.push(e);
    else keep.push({ ...e, ...(pending.unread.has(e.id) ? { unread: l.unread } : {}), ...(pending.starred.has(e.id) ? { starred: l.starred } : {}) });
  }
  return [keep, removed.filter((id) => !pending.moving.has(id))];
}

/**
 * Apply a sync's changes to a date-descending list: drop `removed` ids, swap in each changed
 * email (in place when its date is unchanged, else re-merged), and merge new ones by date.
 * Untouched emails keep their object identity; with nothing to do, `current` itself is returned.
 */
export function applyEmailChanges(current: Email[], changed: Email[], removed: string[]): Email[] {
  if (!changed.length && !removed.length) return current;
  const drop = new Set(removed);
  const byId = new Map<string, Email>();
  for (const e of changed) if (!drop.has(e.id)) byId.set(e.id, e);
  let touched = false;
  const kept: Email[] = [];
  const moved: Email[] = [];
  for (const e of current) {
    if (drop.has(e.id)) {
      touched = true;
      continue;
    }
    const c = byId.get(e.id);
    if (!c) {
      kept.push(e);
      continue;
    }
    byId.delete(e.id);
    touched = true;
    if (c.date === e.date) kept.push(c);
    else moved.push(c);
  }
  moved.push(...byId.values());
  if (!touched && !moved.length) return current;
  return mergeByDateDesc(kept, moved);
}
