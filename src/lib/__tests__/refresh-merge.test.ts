// @vitest-environment jsdom
// A refresh merges only what changed (syncChanges) instead of re-reading the whole cache,
// and focus refreshes are rate-limited.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";
import type { SyncChanges } from "@/lib/mail/provider";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const outlook = { id: "m", kind: "m365" as const, name: "M365", address: "z@example.org" };
const foldersOf = (acc: string): Folder[] => [
  { id: `${acc}:INBOX`, accountId: acc, name: "Inbox", system: "inbox" },
  { id: `${acc}:TRASH`, accountId: acc, name: "Trash", system: "trash" },
];
const row = (id: string, date: string, over: Partial<Email> = {}) => {
  const acc = over.accountId ?? "g";
  return { id, accountId: acc, threadId: id, folderId: `${acc}:INBOX`, from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date, unread: true, starred: false, labels: ["INBOX"], ...over } as Email;
};

/** What each account's SQLite cache holds (load() and a full re-sync read it). */
const disk = new Map<string, Email[]>();
/** The next syncChanges() result per account. */
const next = new Map<string, SyncChanges>();
const counts = { listMessages: 0, syncChanges: 0 };
/** Accounts whose syncChanges() throws. */
const failing = new Set<string>();
/** While set, moves and read/star changes wait on it before the "server" answers. */
let held: Promise<void> | null = null;
const ok = async () => {
  if (held) await held;
  return { skipped: [], failed: [] };
};

function fakeFor(account: typeof gmail | typeof outlook) {
  return {
    account,
    batchSize: 50,
    listFolders: async () => foldersOf(account.id),
    listMessages: async () => {
      counts.listMessages++;
      return disk.get(account.id) ?? [];
    },
    syncChanges: async () => {
      counts.syncChanges++;
      if (failing.has(account.id)) throw new Error("offline");
      return next.get(account.id) ?? { full: false, changed: [], removed: [] };
    },
    batchMove: ok,
    batchSetRead: ok,
    batchSetStarred: ok,
  };
}

let accounts: (typeof gmail | typeof outlook)[] = [gmail];
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => accounts,
  saveRegistry: async () => {},
  calendarProviderFor: () => null,
  mailProviderFor: (a: typeof gmail) => fakeFor(a),
}));
const kv = new Map<string, unknown>();
vi.mock("@/lib/db", () => ({
  kvGet: async (k: string) => kv.get(k) ?? null,
  kvSet: async (k: string, v: unknown) => void kv.set(k, v),
  cacheListFolders: async (acc: string) => foldersOf(acc).map((f) => JSON.stringify(f)),
  cacheListMessages: async (acc: string) => (disk.get(acc) ?? []).map((e) => ({ id: e.id, folder_id: e.folderId, date: e.date, json: JSON.stringify(e) })),
  cachePutMessages: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));

let store: typeof import("@/lib/store");
const state = () => store.useMail.getState();

/** Window listeners added by this test's store, removed afterwards so old stores don't react to later focus events. */
const listeners: [string, EventListenerOrEventListenerObject][] = [];

async function settle() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(100);
}

async function start() {
  const loading = state().load();
  await settle();
  await loading;
}

beforeEach(async () => {
  vi.useFakeTimers();
  kv.clear();
  disk.clear();
  next.clear();
  failing.clear();
  held = null;
  counts.listMessages = counts.syncChanges = 0;
  accounts = [gmail];
  // Nothing to backfill: keep the refresh focused on the merge.
  kv.set("backfill.g", { done: true });
  kv.set("backfill.m", { done: true });
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
    listeners.push([type, fn]);
    add(type, fn, opts);
  });
  vi.resetModules();
  store = await import("@/lib/store");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [type, fn] of listeners) window.removeEventListener(type, fn);
  listeners.length = 0;
  vi.useRealTimers();
});

describe("applyEmailChanges", () => {
  const a = row("a", "2026-10-10T00:00:00Z");
  const b = row("b", "2026-10-09T00:00:00Z");
  const c = row("c", "2026-10-08T00:00:00Z");

  it("keeps identity for untouched mail, replaces a changed one in place, and drops removed ids", () => {
    const b2 = { ...b, unread: false };
    const out = store.applyEmailChanges([a, b, c], [b2], ["c"]);
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b2);
  });

  it("inserts new mail in date order", () => {
    const n = row("n", "2026-10-09T12:00:00Z");
    const old = row("old", "2026-01-01T00:00:00Z");
    const out = store.applyEmailChanges([a, b, c], [old, n], []);
    expect(out.map((e) => e.id)).toEqual(["a", "n", "b", "c", "old"]);
    expect(out[0]).toBe(a);
    expect(out[2]).toBe(b);
  });

  it("re-places a changed email whose date moved", () => {
    const c2 = { ...c, date: "2026-10-11T00:00:00Z" };
    expect(store.applyEmailChanges([a, b, c], [c2], []).map((e) => e.id)).toEqual(["c", "a", "b"]);
  });

  it("removal wins over a change for the same id, and nothing to do returns the same array", () => {
    const cur = [a, b, c];
    expect(store.applyEmailChanges(cur, [{ ...b, unread: false }], ["b"]).map((e) => e.id)).toEqual(["a", "c"]);
    expect(store.applyEmailChanges(cur, [], [])).toBe(cur);
    expect(store.applyEmailChanges(cur, [], ["nope"])).toBe(cur);
  });

  it("handles empty input", () => {
    expect(store.applyEmailChanges([], [], [])).toEqual([]);
    const n = row("n", "2026-10-09T12:00:00Z");
    expect(store.applyEmailChanges([], [n], ["x"])).toEqual([n]);
  });
});

describe("protectPending", () => {
  const none = new Set<string>();
  const a = row("a", "2026-10-10T00:00:00Z");
  const b = row("b", "2026-10-09T00:00:00Z", { unread: false, starred: true });

  it("leaves everything alone with nothing pending", () => {
    const changed = [{ ...a, unread: false }];
    const [c, r] = store.protectPending(changed, ["b"], [a, b], { moving: none, unread: none, starred: none });
    expect(c).toEqual(changed);
    expect(r).toEqual(["b"]);
  });

  it("keeps mail being moved as it is locally: its changed row is skipped and it isn't removed", () => {
    const [c, r] = store.protectPending([{ ...a, folderId: "g:INBOX" }, b], ["a", "x"], [a, b], { moving: new Set(["a"]), unread: none, starred: none });
    expect(c).toEqual([b]);
    expect(r).toEqual(["x"]);
  });

  it("keeps the local read and star values of mail with a change on its way, and takes the rest of the row", () => {
    const incoming = [{ ...b, unread: true, starred: false, subject: "new" }];
    const [read] = store.protectPending(incoming, [], [a, b], { moving: none, unread: new Set(["b"]), starred: none });
    expect(read[0]).toMatchObject({ unread: false, starred: false, subject: "new" });
    const [star] = store.protectPending(incoming, [], [a, b], { moving: none, unread: none, starred: new Map([["b", 1]]) });
    expect(star[0]).toMatchObject({ unread: true, starred: true, subject: "new" });
  });
});

describe("refresh with syncChanges", () => {
  it("doesn't undo a move or a read change still on its way to the server", async () => {
    disk.set("g", [row("g1", "2026-10-10T00:00:00Z"), row("g2", "2026-10-09T00:00:00Z")]);
    await start();
    let release = () => {};
    held = new Promise<void>((r) => (release = r));
    const moving = state().move(["g1"], "g:TRASH");
    const reading = state().setRead(["g2"], true);
    // The sync read both rows before the server applied either change.
    next.set("g", { full: false, changed: [row("g1", "2026-10-10T00:00:00Z"), row("g2", "2026-10-09T00:00:00Z")], removed: [] });
    await state().refresh();
    expect(state().emails.find((e) => e.id === "g1")!.folderId).toBe("g:TRASH");
    expect(state().emails.find((e) => e.id === "g2")!.unread).toBe(false);
    release();
    await Promise.all([moving, reading]);
    // Once the server has them, the next sync's rows are taken as they come.
    next.set("g", { full: false, changed: [row("g2", "2026-10-09T00:00:00Z")], removed: [] });
    await state().refresh();
    expect(state().emails.find((e) => e.id === "g2")!.unread).toBe(true);
  });

  it("merges only the changes: untouched mail keeps its objects, listMessages isn't called", async () => {
    disk.set("g", [row("g1", "2026-10-10T00:00:00Z"), row("g2", "2026-10-09T00:00:00Z"), row("g3", "2026-10-08T00:00:00Z")]);
    await start();
    expect(state().emails.map((e) => e.id)).toEqual(["g1", "g2", "g3"]);
    const [g1, g2] = state().emails;
    const g2read = { ...g2, unread: false };
    next.set("g", { full: false, changed: [g2read, row("n1", "2026-10-09T12:00:00Z")], removed: ["g3"] });
    await state().refresh();
    const emails = state().emails;
    expect(emails.map((e) => e.id)).toEqual(["g1", "n1", "g2"]);
    expect(emails[0]).toBe(g1);
    expect(emails[2]).toEqual({ ...g2read, bodyTrimmed: true }); // synced rows arrive slim
    expect(counts.listMessages).toBe(0);
    expect(counts.syncChanges).toBeGreaterThanOrEqual(2);
    expect(state().accountStatus.g).toMatchObject({ state: "ok" });
  });

  it("a full re-sync replaces only that account's mail, from its cache", async () => {
    accounts = [gmail, outlook];
    disk.set("g", [row("g1", "2026-10-10T00:00:00Z")]);
    disk.set("m", [row("m1", "2026-10-09T00:00:00Z", { accountId: "m" }), row("m2", "2026-10-07T00:00:00Z", { accountId: "m" })]);
    await start();
    const before = state().emails;
    expect(before.map((e) => e.id)).toEqual(["g1", "m1", "m2"]);
    disk.set("g", [row("g9", "2026-10-08T00:00:00Z")]);
    next.set("g", { full: true });
    await state().refresh();
    const emails = state().emails;
    expect(emails.map((e) => e.id)).toEqual(["m1", "g9", "m2"]);
    expect(emails[0]).toBe(before[1]);
    expect(emails[2]).toBe(before[2]);
    expect(counts.listMessages).toBe(0);
  });

  it("an error keeps the account's mail and marks it as failed", async () => {
    disk.set("g", [row("g1", "2026-10-10T00:00:00Z")]);
    await start();
    const before = state().emails;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    failing.add("g");
    await state().refresh();
    expect(err).toHaveBeenCalled();
    expect(state().emails).toBe(before);
    expect(state().accountStatus.g).toMatchObject({ state: "error", error: "offline" });
    expect(counts.listMessages).toBe(0);
  });
});

describe("focus refresh throttle", () => {
  it("two focus events within a minute run one refresh", async () => {
    await start();
    // Past the throttle window since load's refresh, but before the 2-minute timer.
    await vi.advanceTimersByTimeAsync(61_000);
    counts.syncChanges = 0;
    window.dispatchEvent(new Event("focus"));
    await settle();
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(counts.syncChanges).toBe(1);
  });

  it("the 2-minute timer refreshes regardless", async () => {
    await start();
    counts.syncChanges = 0;
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    expect(counts.syncChanges).toBe(1);
  });
});
