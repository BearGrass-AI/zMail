// Search across all mail: what typing in the search box does in a mail view.
//
// The keyword index (cacheSearch) finds matches anywhere in the local cache, newest first; rows
// that aren't loaded come from the cache in one batch (cacheGetRows) and wait in the answer
// until they're opened or acted on (adoptResults, see held.ts). Loaded mail matching the query
// is added by resultEmails, so mail newer than the cache and the browser preview are covered.
// With meaning-based search on (src/lib/semantic.ts, all local), the answer also carries a few
// Best matches by keywords and meaning, shown above the rest. Only the answer for the current
// query, scope and account is ever applied. Nothing here is saved.

import type { StoreApi } from "zustand";
import type { Email } from "@/lib/types";
import { cacheGetRows, cacheSearch, type CacheSearchOptions } from "@/lib/db";
import { semanticSearch } from "@/lib/semantic";
import { held } from "./held";
import { mergeByDateDesc } from "./merge";
import { BEST_MAX, inboxFolderIds, orderedEmails, searchHere, searchKey, SEARCH_MAX } from "./selectors";
import type { MailState, SearchScope, SearchState } from "./types";

/** Shorter queries match only loaded mail: a one-letter prefix expands to thousands of index terms and holds the database. */
export const MIN_INDEX_QUERY = 2;
/** How long the keyword answer waits for Best matches before showing without them. */
export const BEST_WAIT_MS = 250;

type Set_ = StoreApi<MailState>["setState"];
type Get = StoreApi<MailState>["getState"];

/** The index request for the current query, scope and account. */
export function searchPlan(s: Pick<MailState, "view" | "accountFilter" | "folders"> & { search: { scope: SearchScope } }): CacheSearchOptions {
  const base: CacheSearchOptions = { order: "date", limit: SEARCH_MAX, ...(s.accountFilter ? { accountIds: [s.accountFilter] } : {}) };
  if (s.search.scope === "all")
    return { ...base, excludeFolderIds: s.folders.filter((f) => f.system === "spam" || f.system === "trash").map((f) => f.id) };
  const here = searchHere(s.view);
  if (here.kind === "folder") return { ...base, folderIds: [here.folderId] };
  if (here.kind === "starred") return { ...base, starred: true };
  // Inbox and Snoozed (snoozed mail stays in the inbox folder; resultEmails keeps just the snoozed).
  return { ...base, folderIds: [...inboxFolderIds(s.folders)] };
}

/** `emails` with the answer's not-yet-loaded rows for `ids` merged in and held; `emails` itself when there are none. */
export function adoptInto(emails: Email[], search: SearchState | null, ids: Iterable<string | null | undefined>): Email[] {
  const rows = search?.results?.rows;
  if (!rows) return emails;
  let have: Set<string> | undefined;
  const add: Email[] = [];
  for (const id of ids) {
    const row = id ? rows[id] : undefined;
    if (!row) continue;
    have ??= new Set(emails.map((e) => e.id));
    if (have.has(row.id)) continue;
    have.add(row.id);
    add.push(row);
  }
  if (!add.length) return emails;
  for (const e of add) held.add(e.id);
  return mergeByDateDesc(emails, add);
}

/**
 * `emails` without the held rows, except those still in use (`keep`); held rows now in an inbox folder
 * (you moved them there) stay as ordinary inbox mail. Always a new array when anything was held.
 */
function releaseHeld(emails: Email[], keep: Set<string>, inbox: Set<string>): Email[] {
  if (!held.size) return emails;
  const out = emails.filter((e) => !held.has(e.id) || keep.has(e.id) || inbox.has(e.folderId));
  for (const e of emails) if (held.has(e.id) && !keep.has(e.id)) held.delete(e.id);
  // Ids whose rows are gone (a sync replaced the account's mail) are let go too.
  const present = new Set(out.map((e) => e.id));
  for (const id of [...held]) if (!present.has(id)) held.delete(id);
  return out;
}

export function searchActions(set: Set_, get: Get) {
  /** Bumped by every request and by leaving search mode: an answer is applied only if no request followed it. */
  let seq = 0;
  /** The key of the latest request, so an unchanged search isn't asked again. */
  let asked = "";

  const fresh = (): SearchState => {
    const s = get();
    return { scope: "all", origin: { selectedId: s.selectedId, checked: s.checked, todayKept: s.todayKept }, results: null };
  };

  /** Ask the index for the current search, unless that's already been asked. */
  const run = () => {
    const s = get();
    if (!s.search) return;
    const key = searchKey(s);
    if (key === asked) return;
    asked = key;
    const mine = ++seq;
    const query = s.query.trim();
    const current = () => mine === seq && !!get().search && searchKey(get()) === key;
    const apply = (ids: string[], rows: Record<string, Email>, indexing: boolean, capped: boolean, best: string[] = []) =>
      set((st) => (st.search ? { search: { ...st.search, results: { key, query, ids, best, rows, indexing, capped } } } : {}));
    // The index treats the last word as a prefix; a one-letter prefix expands to thousands of terms.
    const words = query.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    if (query.length < MIN_INDEX_QUERY || [...(words.at(-1) ?? "")].length < MIN_INDEX_QUERY) {
      // "parking l": keep the answer for "parking" until the next letter. "p": loaded mail only.
      const prev = s.search.results;
      if (words.length > 1 && prev && query.startsWith(prev.query)) return;
      return apply([], {}, false, false);
    }
    const plan = searchPlan({ ...s, search: s.search });
    // Best matches, asked alongside (local only; "not ready" at once without the model). A failure
    // just leaves them out.
    const scope = { accountIds: plan.accountIds, folderIds: plan.folderIds, excludeFolderIds: plan.excludeFolderIds, starred: plan.starred };
    // A few spare: Best matches drop any the scope filters out here (snoozed, a removed account).
    const best = semanticSearch(query, scope, BEST_MAX + 2).then(
      (r) => r.hits.map((h) => h.id),
      (err: unknown) => {
        console.error("[search] best matches", err);
        return [] as string[];
      },
    );
    /** Slim cached rows for the ids that aren't loaded, by id. */
    const readRows = async (ids: string[]) => {
      const loaded = new Set(get().emails.map((e) => e.id));
      const need = [...new Set(ids)].filter((id) => !loaded.has(id));
      const cached = need.length ? await cacheGetRows(need) : [];
      const rows: Record<string, Email> = {};
      for (const c of cached) {
        try {
          const e = JSON.parse(c.json) as Email;
          // The columns are what the index filtered on; keep the row agreeing with them.
          rows[c.id] = { ...e, id: c.id, folderId: c.folder_id };
        } catch {
          // A malformed cached row can't be shown; leave it out.
        }
      }
      return rows;
    };
    void (async () => {
      try {
        const res = await cacheSearch(query, plan);
        if (!current()) return;
        // Usually here by now; when it isn't (the model's first load), the list shows without it and
        // Best matches join when they arrive.
        const early = await new Promise<string[] | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), BEST_WAIT_MS);
          void best.then((b) => {
            clearTimeout(timer);
            resolve(b);
          });
        });
        if (!current()) return;
        const ids = res.hits.map((h) => h.id);
        const rows = await readRows(early ? [...ids, ...early] : ids);
        if (!current()) return;
        apply(ids, rows, res.indexing, res.hits.length >= SEARCH_MAX, early ?? []);
        if (early) return;
        const late = await best;
        if (!late.length || !current()) return;
        const more = await readRows(late);
        if (!current()) return;
        set((st) => {
          const r = st.search?.results;
          return st.search && r?.key === key ? { search: { ...st.search, results: { ...r, best: late, rows: { ...r.rows, ...more } } } } : {};
        });
      } catch (err) {
        console.error("[search]", err);
        // Loaded mail still matches; the index part is just missing.
        if (current()) apply([], {}, false, false);
      }
    })();
  };

  /** Leave search mode. `restore`: go back to where the search started (the box was cleared). */
  const leave = (patch: Partial<MailState>, restore: boolean) => {
    seq++;
    asked = "";
    set((s) => {
      const o = s.search?.origin;
      const base = { ...s, ...patch, search: null };
      // A composer replying to (or editing) a result still needs its email.
      const keep = new Set([base.compose?.replyTo, base.compose?.draft?.emailId].filter((x): x is string => !!x));
      if (!restore) keep.add(base.selectedId ?? "");
      const emails = releaseHeld(s.emails, keep, inboxFolderIds(s.folders));
      if (!restore || !o) return { ...patch, search: null, emails };
      const after = { ...base, emails, todayKept: o.todayKept, selectedId: null };
      const showing = new Set(orderedEmails(after).map((e) => e.id));
      const have = new Set(emails.map((e) => e.id));
      return {
        ...patch,
        search: null,
        emails,
        todayKept: o.todayKept,
        selectedId: o.selectedId && showing.has(o.selectedId) ? o.selectedId : null,
        checked: new Set([...o.checked].filter((id) => have.has(id))),
        checkAnchor: null,
      };
    });
  };

  return {
    run,
    fresh,
    leave,
    actions: {
      setSearchScope(scope) {
        const s = get().search;
        if (!s || s.scope === scope) return;
        set({ search: { ...s, scope } });
        run();
      },
      adoptResults(ids) {
        const s = get();
        if (!s.search?.results) return;
        const emails = adoptInto(s.emails, s.search, ids);
        if (emails !== s.emails) set({ emails });
      },
    } satisfies Pick<MailState, "setSearchScope" | "adoptResults">,
  };
}
