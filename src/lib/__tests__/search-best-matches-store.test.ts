// @vitest-environment jsdom
// Best matches in search: with meaning-based search ready, a few results ranked by keywords and
// meaning show above the newest-first list (and aren't repeated in it); without it the list is
// exactly as before. The ranking is local (mocked here as @/lib/semantic); nothing calls a model.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder, Triage } from "@/lib/types";
import type { CacheSearchOptions, CachedMessage } from "@/lib/db";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const um = { id: "m", kind: "m365" as const, name: "Work", address: "z@example.org" };
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
/** What the meaning-based search answers, per query; `semReady` false is "no model". */
const semAnswer = new Map<string, string[]>();
let semReady = true;
/** While set, the next semanticSearch answers only once the promise resolves. */
let semGate: Promise<void> | null = null;
const semCalls: { query: string; scope: Record<string, unknown>; limit: number }[] = [];
vi.mock("@/lib/semantic", () => ({
  semanticSearch: async (query: string, scope: Record<string, unknown>, limit: number) => {
    semCalls.push({ query, scope, limit });
    if (semGate) {
      const g = semGate;
      semGate = null;
      await g;
    }
    if (!semReady) return { ready: false, hits: [] };
    const ids = (semAnswer.get(query) ?? []).slice(0, limit);
    return { ready: true, hits: ids.map((id) => ({ id, account_id: "m", folder_id: cache.get(id)?.folderId ?? "", date: "", rank: 0.03 })) };
  },
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {}, accessToken: async () => "tok" }));

let accounts: (typeof um)[] = [um];
let store: typeof import("@/lib/store");
let ui: typeof import("@/components/mail/search-results");
const state = () => store.useMail.getState();
const results = () => store.resultEmails({ ...state(), search: state().search! }).map((e) => e.id);
const groups = () => {
  const g = store.resultGroups({ ...state(), search: state().search! });
  return { best: g.best.map((e) => e.id), rest: g.rest.map((e) => e.id) };
};

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
  semAnswer.clear();
  semReady = true;
  semGate = null;
  semCalls.length = 0;
  accounts = [um];
  h.toast.mockClear();
  h.oneLiner.mockClear();
  disk.set("m", LOADED);
  for (const e of [...LOADED, ...OLDER]) cache.set(e.id, e);
  notIndexed.add("n1");
  vi.resetModules();
  store = await import("@/lib/store");
  ui = await import("@/components/mail/search-results");
  await start();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("best matches", () => {
  it("show above the newest-first list, aren't repeated in it, and lead j/k", async () => {
    semAnswer.set("parking", ["o1", "i1", "o4", "a1"]);
    await search("parking");
    expect(groups()).toEqual({ best: ["o1", "i1", "o4"], rest: ["n1", "a1", "o5"] });
    expect(results()).toEqual(["o1", "i1", "o4", "n1", "a1", "o5"]);
    expect(store.orderedEmails(state()).map((e) => e.id)).toEqual(results());
    // Asked with the view's scope, as the keyword index is (no order or limit of its own).
    const call = semCalls.at(-1)!;
    expect(call.query).toBe("parking");
    expect([...(call.scope.excludeFolderIds as string[])].sort()).toEqual(["m:spam", "m:trash"]);
    expect(call.scope).not.toHaveProperty("order");
    // Older ones come from the cache in the same read as the other results.
    expect(rowReads.at(-1)!.sort()).toEqual(["o1", "o4", "o5"]);

    render(createElement(ui.SearchResults));
    const text = document.body.textContent ?? "";
    expect(text).toContain("Best matches");
    expect(text).toContain("Newest first");
    expect(text.indexOf("Best matches")).toBeLessThan(text.indexOf("Newest first"));
    // Six rows: three best, three others, none twice.
    expect(document.querySelectorAll("div.cursor-default").length).toBe(6);
  });

  it("without the model, the list is exactly as before", async () => {
    semReady = false;
    semAnswer.set("parking", ["o1"]);
    await search("parking");
    expect(groups().best).toEqual([]);
    expect(results()).toEqual(["n1", "i1", "a1", "o4", "o1", "o5"]);
    render(createElement(ui.SearchResults));
    expect(document.body.textContent).not.toContain("Best matches");
    expect(document.body.textContent).not.toContain("Newest first");
    expect(document.querySelectorAll("div.cursor-default").length).toBe(6);
  });

  it("find mail by meaning when no word matches, and keep to the scope", async () => {
    // Spam isn't in All mail, even when ranked; a meaning-only match shows with no second heading.
    semAnswer.set("car storage", ["o3", "o4"]);
    await search("car storage");
    expect(groups()).toEqual({ best: ["o4"], rest: [] });
    render(createElement(ui.SearchResults));
    expect(document.body.textContent).toContain("Best matches");
    expect(document.body.textContent).not.toContain("Newest first");
    expect(document.body.textContent).not.toContain("No results");
  });

  it("join the list when they're late, but only for the search they answer", async () => {
    semAnswer.set("parking", ["o5"]);
    let release!: () => void;
    semGate = new Promise<void>((r) => (release = r));
    await search("parking");
    // The keyword answer didn't wait past its budget.
    expect(groups().best).toEqual([]);
    expect(results()).toEqual(["n1", "i1", "a1", "o4", "o1", "o5"]);
    release();
    await settle();
    expect(groups()).toEqual({ best: ["o5"], rest: ["n1", "i1", "a1", "o4", "o1"] });

    // A late answer for a query that's been replaced is dropped.
    semAnswer.set("parking map", ["o1"]);
    semAnswer.set("lunch", ["i2"]);
    semGate = new Promise<void>((r) => (release = r));
    await search("parking map");
    await search("lunch");
    release();
    await settle();
    expect(state().search!.results!.query).toBe("lunch");
    expect(groups().best).toEqual(["i2"]);
  });

  it("an older best match opens like any result and is let go when the search ends", async () => {
    semAnswer.set("visitor", ["o1"]);
    await search("visitor");
    expect(groups().best).toEqual(["o1"]);
    state().select("o1");
    expect(state().emails.some((e) => e.id === "o1")).toBe(true);
    state().select(null);
    state().setQuery("");
    expect(state().emails.some((e) => e.id === "o1")).toBe(false);
  });
});
