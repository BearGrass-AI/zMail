// @vitest-environment jsdom
// Search across all mail, through the store: typing turns the list pane into one results list over
// every cached email, older mail that isn't loaded can be opened and acted on, and nothing behind the
// results (counts, Today, triage, saving, the model) changes because they're shown.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder, Triage } from "@/lib/types";
import type { CacheSearchOptions, CachedMessage } from "@/lib/db";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const um = { id: "m", kind: "m365" as const, name: "Work", address: "z@example.org" };
const home = { id: "u", kind: "m365" as const, name: "Home", address: "z@home.org" };
const foldersOf = (acc: string): Folder[] => [
  { id: `${acc}:inbox`, accountId: acc, name: "Inbox", system: "inbox", unread: 5 },
  { id: `${acc}:archive`, accountId: acc, name: "Archive", system: "archive", unread: 3 },
  { id: `${acc}:trash`, accountId: acc, name: "Trash", system: "trash" },
  { id: `${acc}:spam`, accountId: acc, name: "Junk", system: "spam" },
  { id: `${acc}:sent`, accountId: acc, name: "Sent", system: "sent" },
  { id: `${acc}:fac`, accountId: acc, name: "Facilities" },
];
const mail = (id: string, folder: string, date: string, subject: string, extra: Partial<Email> = {}, acc = "m") =>
  ({
    id,
    accountId: acc,
    threadId: id,
    folderId: `${acc}:${folder}`,
    from: { name: "Dana Morrow", address: "dana@x.edu" },
    to: [{ name: "Z", address: "z@example.org" }],
    subject,
    snippet: subject,
    text: `${subject}. The rest of the message.`,
    date,
    unread: false,
    starred: false,
    labels: [],
    ...extra,
  }) as Email;

/** Loaded at launch (what cacheListMessages returns), per account. */
const disk = new Map<string, Email[]>();
/** Every cached row, by id: what the keyword index and cacheGetRows see. */
const cache = new Map<string, Email>();
/** Rows the index doesn't have yet (newer than the cache). */
const notIndexed = new Set<string>();
let indexing = false;
let noIndex = false;
/** While set, the next cacheSearch answers only once the promise resolves. */
let gate: Promise<void> | null = null;
const searches: { query: string; opts: CacheSearchOptions }[] = [];
const rowReads: string[][] = [];
const triaged: string[][] = [];
const moves: { ids: string[]; folderId: string }[] = [];
const toRow = (e: Email): CachedMessage => ({ id: e.id, folder_id: e.folderId, date: e.date, json: JSON.stringify(e) });

const h = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), loading: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
  oneLiner: vi.fn(async () => "a line"),
  extractDates: vi.fn(async () => []),
}));
vi.mock("sonner", () => ({ toast: h.toast, Toaster: () => null }));
vi.mock("@/lib/ai/generative", async (orig) => ({ ...(await orig<typeof import("@/lib/ai/generative")>()), oneLiner: h.oneLiner }));
vi.mock("@/lib/ai/dates", async (orig) => ({ ...(await orig<typeof import("@/lib/ai/dates")>()), extractDates: h.extractDates }));
vi.mock("@/lib/ai/providers", async (orig) => {
  const o = await orig<typeof import("@/lib/ai/providers")>();
  return { ...o, generativeProvider: vi.fn(o.generativeProvider), decisionProvider: vi.fn(o.decisionProvider) };
});
vi.mock("@/lib/ai/triage", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/triage")>()),
  triageAll: async (_p: unknown, list: Email[], _c: unknown, onResult: (t: Triage) => void) => {
    triaged.push(list.map((e) => e.id));
    for (const e of list) onResult({ emailId: e.id, bucket: "worth_skim", bucketProbs: { needs_you: 0, worth_skim: 1, ready_archive: 0 }, category: "primary", urgency: 0, needsReply: 0, model: "fake" } as Triage);
    return { done: list.length, failed: 0 };
  },
}));
// Every row mounts (jsdom has no layout to measure).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey: (i: number) => string }) => ({
    getTotalSize: () => count * 64,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ key: getItemKey(i), index: i, start: i * 64 })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));
vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => accounts,
  saveRegistry: async () => {},
  calendarProviderFor: () => null,
  mailProviderFor: (a: typeof um) => ({
    account: a,
    batchSize: 50,
    listFolders: async () => foldersOf(a.id),
    listMessages: async () => disk.get(a.id) ?? [],
    syncChanges: async () => ({ full: false, changed: [], removed: [] }),
    // Cached rows open from the cache, never from the network.
    getMessage: async () => {
      throw new Error("no network in this test");
    },
    batchMove: async (es: Email[], folderId: string) => {
      moves.push({ ids: es.map((e) => e.id), folderId });
      return { skipped: [], failed: [] };
    },
    batchSetRead: async () => ({ skipped: [], failed: [] }),
    batchSetStarred: async () => ({ skipped: [], failed: [] }),
  }),
}));
const kv = new Map<string, unknown>();
vi.mock("@/lib/db", () => ({
  kvGet: async (k: string) => kv.get(k) ?? null,
  kvSet: async (k: string, v: unknown) => void kv.set(k, v),
  cacheListFolders: async (acc: string) => foldersOf(acc).map((f) => JSON.stringify(f)),
  cacheListMessages: async (acc: string) => (disk.get(acc) ?? []).map((e) => ({ ...toRow(e), json: JSON.stringify({ ...e, bodyTrimmed: true }) })),
  cacheGetMessage: async (id: string) => (cache.has(id) ? toRow(cache.get(id)!) : null),
  // Write-backs land in the cache (and so in the index), as the real triggers do; a slim row keeps the stored body.
  cachePutMessages: async (_acc: string, rows: CachedMessage[]) => {
    for (const r of rows) {
      const e = JSON.parse(r.json) as Email;
      const prev = cache.get(r.id);
      if (e.bodyTrimmed && prev) {
        delete e.bodyTrimmed;
        e.text = prev.text;
      }
      cache.set(r.id, { ...e, folderId: r.folder_id });
    }
  },
  cacheDeleteAccount: async () => [],
  cacheSearch: async (query: string, opts: CacheSearchOptions = {}) => {
    searches.push({ query, opts });
    if (gate) {
      const g = gate;
      gate = null;
      await g;
    }
    if (noIndex) return { hits: [], indexing: false };
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [...cache.values()]
      .filter((e) => !notIndexed.has(e.id))
      .filter((e) => words.every((w) => `${e.from.name} ${e.subject} ${e.text}`.toLowerCase().includes(w)))
      .filter((e) => !opts.accountIds || opts.accountIds.includes(e.accountId))
      .filter((e) => !opts.folderIds || opts.folderIds.includes(e.folderId))
      .filter((e) => !opts.excludeFolderIds?.includes(e.folderId))
      .filter((e) => !opts.starred || e.starred)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, opts.limit ?? 50);
    return { hits: hits.map((e) => ({ id: e.id, account_id: e.accountId, folder_id: e.folderId, date: e.date, rank: -1 })), indexing };
  },
  cacheGetRows: async (ids: string[]) => {
    rowReads.push(ids);
    return ids.flatMap((id) => (cache.has(id) ? [{ ...toRow(cache.get(id)!), json: JSON.stringify({ ...cache.get(id)!, bodyTrimmed: true }) }] : []));
  },
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {}, accessToken: async () => "tok" }));

let accounts: (typeof um)[] = [um];
let store: typeof import("@/lib/store");
let ui: typeof import("@/components/mail/search-results");
let actions: typeof import("@/components/email-actions");
let providers: typeof import("@/lib/ai/providers");
const state = () => store.useMail.getState();
const results = () => store.resultEmails({ ...state(), search: state().search! }).map((e) => e.id);

async function settle() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(100);
}

// Loaded: inbox mail, and an archived email new enough to be in the newest rows.
const LOADED = [
  mail("n1", "inbox", "2026-10-12T09:00:00Z", "Parking garage opens early"),
  mail("i1", "inbox", "2026-10-10T09:00:00Z", "Lot P parking closures", { unread: true }),
  mail("i2", "inbox", "2026-10-09T09:00:00Z", "Lunch on Friday"),
  mail("a1", "archive", "2026-09-01T09:00:00Z", "Parking map update"),
];
// Only in the cache: older mail in every kind of folder.
const OLDER = [
  mail("o4", "fac", "2025-07-28T09:00:00Z", "Permit parking renewal", { unread: true }),
  mail("o1", "archive", "2025-03-03T09:00:00Z", "Visitor parking for the board", { starred: true }),
  mail("o2", "trash", "2025-02-01T09:00:00Z", "Parking ticket appeal"),
  mail("o3", "spam", "2025-01-01T09:00:00Z", "Cheap parking deals"),
  mail("o5", "inbox", "2024-05-05T09:00:00Z", "Old parking note", { unread: true }),
];

async function start() {
  const loading = state().load();
  await settle();
  await loading;
}

/** Type a query as the search box does, then let the answer land. */
async function search(q: string) {
  state().setQuery(q);
  await settle();
}

let root: Root | null = null;
const render = (el: ReturnType<typeof createElement>) => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(el));
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  kv.clear();
  disk.clear();
  cache.clear();
  notIndexed.clear();
  searches.length = 0;
  rowReads.length = 0;
  triaged.length = 0;
  moves.length = 0;
  indexing = false;
  noIndex = false;
  gate = null;
  accounts = [um];
  h.toast.mockClear();
  h.oneLiner.mockClear();
  disk.set("m", LOADED);
  for (const e of [...LOADED, ...OLDER]) cache.set(e.id, e);
  notIndexed.add("n1");
  vi.resetModules();
  store = await import("@/lib/store");
  ui = await import("@/components/mail/search-results");
  actions = await import("@/components/email-actions");
  providers = await import("@/lib/ai/providers");
  await start();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("search mode", () => {
  it("replaces the Inbox list with results from all mail, newest first, without Spam or Trash", async () => {
    state().setView({ kind: "inbox" });
    await search("parking");
    expect(state().search?.scope).toBe("all");
    expect(results()).toEqual(["n1", "i1", "a1", "o4", "o1", "o5"]);
    // j/k and ⌘A walk the results.
    expect(store.orderedEmails(state()).map((e) => e.id)).toEqual(results());
    const { opts } = searches.at(-1)!;
    expect(opts).toMatchObject({ order: "date", limit: 500 });
    expect([...opts.excludeFolderIds!].sort()).toEqual(["m:spam", "m:trash"]);
    // Only rows that aren't loaded are read from the cache.
    expect(rowReads.at(-1)!.sort()).toEqual(["o1", "o4", "o5"]);
  });

  it("works from a folder and from Today, and scopes to the view it came from", async () => {
    state().setView({ kind: "folder", folderId: "m:fac" });
    await search("parking");
    expect(results()).toEqual(["n1", "i1", "a1", "o4", "o1", "o5"]);
    state().setSearchScope("here");
    await settle();
    expect(results()).toEqual(["o4"]);
    expect(searches.at(-1)!.opts.folderIds).toEqual(["m:fac"]);

    state().setQuery("");
    state().setView({ kind: "brief" });
    await search("parking");
    // A new search starts on All mail; Today's "here" is the inbox.
    expect(state().search?.scope).toBe("all");
    state().setSearchScope("here");
    await settle();
    expect(results()).toEqual(["n1", "i1", "o5"]);
    expect(state().view).toEqual({ kind: "brief" });
  });

  it("leaves Calendar and Scheduled as they are", async () => {
    state().setView({ kind: "calendar" });
    await search("parking");
    expect(state().search).toBeNull();
    expect(state().query).toBe("parking");
    expect(searches).toHaveLength(0);
    // Back in a mail view with text in the box: results.
    state().setView({ kind: "inbox" });
    await settle();
    expect(results()).toContain("o1");
    // Into Scheduled while searching: search mode ends, the text stays.
    state().setView({ kind: "scheduled" });
    expect(state().search).toBeNull();
    expect(state().query).toBe("parking");
    expect(state().emails.map((e) => e.id).sort()).toEqual(LOADED.map((e) => e.id).sort());
  });

  it("refilters at once when the scope changes, then asks the index for that scope", async () => {
    state().setView({ kind: "folder", folderId: "m:archive" });
    await search("parking");
    const asked = searches.length;
    state().setSearchScope("here");
    // Before the new answer lands, the list is already just this folder.
    expect(results()).toEqual(["a1", "o1"]);
    await settle();
    expect(searches.length).toBe(asked + 1);
    expect(searches.at(-1)!.opts.folderIds).toEqual(["m:archive"]);
    expect(results()).toEqual(["a1", "o1"]);
    state().setSearchScope("all");
    // Loaded matches from every folder at once; the older ones once the index answers.
    expect(results()).toEqual(["n1", "i1", "a1", "o1"]);
    await settle();
    expect(results()).toEqual(["n1", "i1", "a1", "o4", "o1", "o5"]);
  });

  it("scoped to Trash or Spam, searches just that folder", async () => {
    state().setView({ kind: "folder", folderId: "m:trash" });
    await search("parking");
    expect(results()).not.toContain("o2");
    state().setSearchScope("here");
    await settle();
    expect(results()).toEqual(["o2"]);
    expect(searches.at(-1)!.opts.excludeFolderIds).toBeUndefined();
  });

  it("scoped to Starred, finds older starred mail", async () => {
    state().setView({ kind: "starred" });
    await search("parking");
    state().setSearchScope("here");
    await settle();
    expect(searches.at(-1)!.opts.starred).toBe(true);
    expect(results()).toEqual(["o1"]);
  });

  it("honors the account switcher", async () => {
    accounts = [um, home];
    disk.set("u", [mail("u1", "inbox", "2026-10-11T00:00:00Z", "Parking at home", {}, "u")]);
    cache.set("u1", disk.get("u")![0]);
    vi.resetModules();
    store = await import("@/lib/store");
    await start();
    state().setView({ kind: "inbox" });
    await search("parking");
    expect(results()).toContain("u1");
    state().setAccountFilter("u");
    // At once, before the index answers for that account.
    expect(results()).toEqual(["u1"]);
    await settle();
    expect(searches.at(-1)!.opts.accountIds).toEqual(["u"]);
    expect(results()).toEqual(["u1"]);
    state().setAccountFilter("m");
    await settle();
    expect(results()).not.toContain("u1");
    expect(results()).toContain("o1");
  });

  it("adds loaded mail the index doesn't have yet, and works with no index at all", async () => {
    await search("parking");
    expect(results()[0]).toBe("n1");
    state().setQuery("");
    noIndex = true;
    await search("parking");
    // The browser preview: loaded mail only.
    expect(results()).toEqual(["n1", "i1", "a1"]);
  });

  it("matches every word, in any order", async () => {
    await search("closures lot");
    expect(results()).toEqual(["i1"]);
  });

  it("doesn't ask the index for a one-letter query", async () => {
    state().setQuery("p");
    expect(searches).toHaveLength(0);
    // Loaded mail still matches at once.
    expect(results()).toEqual(["n1", "i1", "a1"]);
    await settle();
    expect(searches).toHaveLength(0);
    await search("pa");
    expect(searches).toHaveLength(1);
  });

  it("doesn't ask the index while the last word is one letter, keeping the answer so far", async () => {
    await search("parking");
    const asked = searches.length;
    const answer = state().search?.results;
    await search("parking l");
    expect(searches).toHaveLength(asked);
    expect(state().search?.results).toBe(answer);
    await search("parking lot");
    expect(searches).toHaveLength(asked + 1);
    expect(results()).toEqual(["i1"]);
  });

  it("applies only the answer for the current query and scope", async () => {
    let release = () => {};
    gate = new Promise<void>((r) => (release = r));
    state().setQuery("visitor");
    await settle();
    // A second query answers first; the first one's answer arrives late and is dropped.
    await search("permit");
    expect(state().search?.results?.query).toBe("permit");
    release();
    await settle();
    expect(state().search?.results?.query).toBe("permit");
    expect(results()).toEqual(["o4"]);

    // The same for a scope switch overtaken by another.
    gate = new Promise<void>((r) => (release = r));
    state().setSearchScope("here");
    await settle();
    state().setSearchScope("all");
    await settle();
    release();
    await settle();
    expect(JSON.parse(state().search!.results!.key)[1]).toBe("all");
    expect(results()).toEqual(["o4"]);
  });

  it("Clear goes back to the same view and selection, and drops the results", async () => {
    state().setView({ kind: "inbox" });
    state().select("i2");
    await search("parking");
    state().select("o1");
    expect(state().selectedId).toBe("o1");
    expect(state().emails.some((e) => e.id === "o1")).toBe(true);
    render(createElement(ui.SearchResults));
    const clear = [...document.querySelectorAll("button")].find((b) => b.textContent === "Clear")!;
    act(() => clear.click());
    expect(state().query).toBe("");
    expect(state().search).toBeNull();
    expect(state().view).toEqual({ kind: "inbox" });
    expect(state().selectedId).toBe("i2");
    // The older result is let go again.
    expect(state().emails.map((e) => e.id).sort()).toEqual(LOADED.map((e) => e.id).sort());
  });

  it("Escape in the search box clears it and goes back to Today as it was", async () => {
    const { Sidebar } = await import("@/components/sidebar");
    state().setView({ kind: "brief" });
    state().select("i1");
    const kept = state().todayKept;
    expect(kept.has("i1")).toBe(true);
    render(createElement(Sidebar, { onSettings: () => {} }));
    const input = document.getElementById("global-search") as HTMLInputElement;
    const type = (text: string) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        set.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    type("parking");
    await act(async () => settle());
    expect(state().search).not.toBeNull();
    state().select("o4");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(input.value).toBe("");
    expect(state().search).toBeNull();
    expect(state().view).toEqual({ kind: "brief" });
    expect(state().selectedId).toBe("i1");
    expect([...state().todayKept]).toEqual([...kept]);
  });

  it("archives an older result that isn't loaded, updates the list, and undoes it", async () => {
    state().setView({ kind: "folder", folderId: "m:fac" });
    await search("parking");
    expect(state().emails.some((e) => e.id === "o4")).toBe(false);
    void actions.emailActions().archive(["o4"]);
    await settle();
    expect(moves).toEqual([{ ids: ["o4"], folderId: "m:archive" }]);
    // All mail: still listed, now in Archive.
    expect(results()).toContain("o4");
    expect(store.resultEmails({ ...state(), search: state().search! }).find((e) => e.id === "o4")?.folderId).toBe("m:archive");
    // The cache (and so the index) has the move.
    expect(cache.get("o4")?.folderId).toBe("m:archive");
    // Scoped to Facilities, it's gone.
    state().setSearchScope("here");
    await settle();
    expect(results()).toEqual([]);
    // The same Undo toast as anywhere.
    const [label, opts] = h.toast.mock.calls.at(-1) as [string, { action: { label: string; onClick: () => void } }];
    expect(label).toBe("Archived");
    expect(opts.action.label).toBe("Undo");
    opts.action.onClick();
    await settle();
    expect(moves.at(-1)).toEqual({ ids: ["o4"], folderId: "m:fac" });
    expect(results()).toEqual(["o4"]);
  });

  it("deleting a result takes it out of All mail; starring and reading work on older mail", async () => {
    await search("parking");
    void actions.emailActions().trash(["o1"]);
    await settle();
    expect(moves.at(-1)).toEqual({ ids: ["o1"], folderId: "m:trash" });
    expect(results()).not.toContain("o1");
    expect(h.toast.mock.calls.at(-1)?.[0]).toBe("Deleted");
    actions.emailActions().star("o5");
    actions.emailActions().read(["o5"], true);
    await settle();
    const o5 = state().emails.find((e) => e.id === "o5")!;
    expect(o5.starred).toBe(true);
    expect(o5.unread).toBe(false);
  });

  it("ticks and acts on several results, loaded or not", async () => {
    await search("parking");
    state().setChecked(store.orderedEmails(state()).map((e) => e.id));
    expect(state().checked.size).toBe(6);
    void actions.emailActions().archive([...state().checked]);
    await settle();
    // Loaded and older mail alike; mail already in Archive stays put (and stays ticked).
    expect(moves.flatMap((m) => m.ids).sort()).toEqual(["i1", "n1", "o4", "o5"]);
    expect([...state().checked].sort()).toEqual(["a1", "o1"]);
  });

  it("opening an older result reads it from the cache and marks it read, as any email", async () => {
    await search("parking");
    state().select("o4");
    const e = state().emails.find((x) => x.id === "o4")!;
    expect(e.unread).toBe(false);
    const full = await state().ensureBody("o4");
    expect(full?.text).toContain("Permit parking renewal");
  });
});

describe("nothing else changes behind the results", () => {
  const counts = () => {
    const s = state();
    return {
      folders: s.folders.map((f) => [f.id, store.folderUnread(s, f)]),
      inbox: store.allInboxesUnread(s),
      starred: store.starredCount(s.emails),
      fac: store.idsByFolder(s.emails).get("m:fac") ?? [],
    };
  };

  it("unread and starred counts stay the same while results show and older ones open", async () => {
    const before = counts();
    await search("parking");
    expect(counts()).toEqual(before);
    // An older starred email, opened: it isn't counted, listed or starred-counted.
    state().select("o1");
    expect(counts()).toEqual(before);
    // Ticking older unread mail doesn't count it either.
    state().setChecked(["o4", "o5"]);
    expect(counts()).toEqual(before);
    expect(store.listEmails({ ...state(), view: { kind: "starred" } }).map((e) => e.id)).not.toContain("o1");
    state().setQuery("");
    expect(counts()).toEqual(before);
  });

  it("an older inbox result isn't sorted, put on Today, or saved", async () => {
    const sortedBefore = triaged.flat();
    expect(sortedBefore).not.toContain("o5");
    await search("parking");
    state().select("o5");
    state().setChecked(["o5"]);
    expect(store.homeInbox(state()).map((e) => e.id)).not.toContain("o5");
    expect(store.isInbox(state(), state().emails.find((e) => e.id === "o5")!)).toBe(false);
    await state().refresh();
    await settle();
    expect(triaged.flat()).not.toContain("o5");
    expect(state().triage.o5).toBeUndefined();
    expect(Object.keys(store.snapshot(state()).dateFinds)).not.toContain("o5");
  });

  it("result rows ask no model for anything", async () => {
    const gen = vi.mocked(providers.generativeProvider);
    const dec = vi.mocked(providers.decisionProvider);
    gen.mockClear();
    dec.mockClear();
    h.extractDates.mockClear();
    const sortedBefore = triaged.length;
    await search("parking");
    render(createElement(ui.SearchResults));
    const rows = document.querySelectorAll("div.cursor-default");
    expect(rows.length).toBe(6);
    expect(document.body.textContent).toContain("Results for “parking”");
    expect(document.querySelectorAll("mark").length).toBeGreaterThan(0);
    // Open one, as a click does.
    act(() => (rows[3] as HTMLElement).click());
    await act(async () => settle());
    expect(state().selectedId).toBe("o4");
    expect(h.oneLiner).not.toHaveBeenCalled();
    expect(h.extractDates).not.toHaveBeenCalled();
    expect(gen).not.toHaveBeenCalled();
    expect(dec).not.toHaveBeenCalled();
    expect(triaged.length).toBe(sortedBefore);
  });

  it("the top bar leaves its view count out while results show, so only the results count is on screen", async () => {
    const { TopBar } = await import("@/components/topbar");
    state().setView({ kind: "inbox" });
    render(createElement(TopBar));
    const count = () => document.querySelector("header h1 span.tabular-nums")?.textContent ?? null;
    expect(count()).not.toBeNull();
    await act(async () => search("parking"));
    expect(count()).toBeNull();
    await act(async () => search(""));
    expect(count()).not.toBeNull();
  });

  it("shows the indexing note and the count, capped at 500+", async () => {
    indexing = true;
    for (let i = 0; i < 520; i++) cache.set(`x${i}`, mail(`x${i}`, "sent", `2023-01-01T00:${String(i).padStart(6, "0")}`, "parking reply"));
    await search("parking");
    expect(state().search?.results?.capped).toBe(true);
    expect(results().length).toBe(500);
    render(createElement(ui.SearchResults));
    expect(document.body.textContent).toContain("Still indexing older mail. Some results may be missing.");
    expect(document.body.textContent).toContain("500+");
  });
});
