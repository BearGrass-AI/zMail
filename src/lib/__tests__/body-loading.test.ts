// @vitest-environment jsdom
// List rows from the cache are slim (no html, capped text, `bodyTrimmed`); ensureBody loads the
// full body when an email is opened, from the cache first and the provider on a miss.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const folders: Folder[] = [{ id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" }];
const row = (id: string, date: string, over: Partial<Email> = {}) =>
  ({ id, accountId: "g", threadId: id, folderId: "g:INBOX", from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date, unread: false, starred: false, labels: ["INBOX"], ...over }) as Email;
const slim = (e: Email): Email => {
  const { html: _, ...rest } = e;
  return { ...rest, text: e.text.slice(0, 8000), bodyTrimmed: true };
};

/** Full rows as SQLite stores them; the listing returns them slim, as the Rust query does. */
const disk = new Map<string, Email>();
const getMessage = vi.fn(async (id: string) => row(id, "2026-10-01T00:00:00Z", { text: "from provider", html: "<p>from provider</p>" }));
const cacheGetMessage = vi.fn(async (id: string) => {
  const e = disk.get(id);
  return e ? { id, folder_id: e.folderId, date: e.date, json: JSON.stringify(e) } : null;
});

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => null,
  mailProviderFor: (account: typeof gmail) => ({
    account,
    batchSize: 50,
    listFolders: async () => folders,
    listMessages: async () => [...disk.values()].map(slim),
    syncChanges: async () => ({ full: false, changed: [], removed: [] }),
    getMessage,
  }),
}));
const kv = new Map<string, unknown>([["backfill.g", { done: true }]]);
vi.mock("@/lib/db", () => ({
  kvGet: async (k: string) => kv.get(k) ?? null,
  kvSet: async (k: string, v: unknown) => void kv.set(k, v),
  cacheListFolders: async () => folders.map((f) => JSON.stringify(f)),
  cacheListMessages: async () => [...disk.values()].map((e) => ({ id: e.id, folder_id: e.folderId, date: e.date, json: JSON.stringify(slim(e)) })),
  cachePutMessages: async () => {},
  cacheGetMessage: (id: string) => cacheGetMessage(id),
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));

let store: typeof import("@/lib/store");
const state = () => store.useMail.getState();
const long = "x".repeat(9000) + " tail";

beforeEach(async () => {
  vi.useFakeTimers();
  disk.clear();
  disk.set("a", row("a", "2026-10-03T00:00:00Z", { text: long, html: "<p>a</p>" }));
  disk.set("b", row("b", "2026-10-02T00:00:00Z", { text: "b body", html: "<p>b</p>" }));
  disk.set("c", row("c", "2026-10-01T00:00:00Z", { text: "c body" }));
  getMessage.mockClear();
  cacheGetMessage.mockClear();
  vi.resetModules();
  store = await import("@/lib/store");
  const loading = state().load();
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(100);
  await loading;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ensureBody", () => {
  it("loads slim list rows", () => {
    const a = state().emails.find((e) => e.id === "a")!;
    expect(a.bodyTrimmed).toBe(true);
    expect(a.html).toBeUndefined();
    expect(a.text.length).toBe(8000);
  });

  it("replaces a trimmed email with the full one, keeping order and the others' identity", async () => {
    const before = state().emails;
    const full = await state().ensureBody("a");
    const after = state().emails;
    expect(full?.html).toBe("<p>a</p>");
    expect(full?.text).toBe(long);
    expect(full?.bodyTrimmed).toBeUndefined();
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
    expect(after.find((e) => e.id === "a")).toBe(full);
    expect(after.find((e) => e.id === "b")).toBe(before.find((e) => e.id === "b"));
    expect(after.find((e) => e.id === "c")).toBe(before.find((e) => e.id === "c"));
    expect(cacheGetMessage).toHaveBeenCalledTimes(1);
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("keeps the store's newer flags when swapping in the body", async () => {
    store.useMail.setState((s) => ({ emails: s.emails.map((e) => (e.id === "a" ? { ...e, unread: true, starred: true } : e)) }));
    const full = await state().ensureBody("a");
    expect(full).toMatchObject({ unread: true, starred: true, html: "<p>a</p>" });
  });

  it("returns an untrimmed email without reading the cache", async () => {
    await state().ensureBody("b");
    cacheGetMessage.mockClear();
    const b = state().emails.find((e) => e.id === "b");
    expect(await state().ensureBody("b")).toBe(b);
    expect(cacheGetMessage).not.toHaveBeenCalled();
  });

  it("falls back to the provider on a cache miss", async () => {
    disk.delete("c");
    const full = await state().ensureBody("c");
    expect(getMessage).toHaveBeenCalledWith("c");
    expect(full?.text).toBe("from provider");
    expect(full?.html).toBe("<p>from provider</p>");
    expect(full?.bodyTrimmed).toBeUndefined();
  });

  it("treats a cached row that is itself trimmed as a miss", async () => {
    disk.set("c", slim(disk.get("c")!));
    await state().ensureBody("c");
    expect(getMessage).toHaveBeenCalledWith("c");
  });

  it("shares one load between concurrent callers", async () => {
    const [x, y] = await Promise.all([state().ensureBody("a"), state().ensureBody("a")]);
    expect(x).toBe(y);
    expect(cacheGetMessage).toHaveBeenCalledTimes(1);
  });
});

describe("callers that need the full body", () => {
  it("ensureEmail (the assistant's getEmail) returns the full body for a listed row", async () => {
    const e = await state().ensureEmail({ id: "a", accountId: "g" });
    expect(e.text).toBe(long);
    expect(e.html).toBe("<p>a</p>");
  });

  it("openCompose loads the replied-to body before the composer opens", async () => {
    state().openCompose({ mode: "blank", replyTo: "a", forward: true });
    expect(state().compose).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(state().compose).toMatchObject({ replyTo: "a", forward: true });
    expect(state().emails.find((e) => e.id === "a")?.text).toBe(long);
  });

  it("a later openCompose wins over one still waiting on a body", async () => {
    state().openCompose({ mode: "blank", replyTo: "a", forward: true });
    state().openCompose(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(state().compose).toBeNull();
  });
});

describe("body memory cap", () => {
  it("re-slims the oldest loaded body past 12, but never the selected one", async () => {
    for (let i = 0; i < 13; i++) disk.set(`m${i}`, row(`m${i}`, `2026-09-${String(10 + i)}T00:00:00Z`, { text: long, html: `<p>m${i}</p>` }));
    store.useMail.setState((st) => ({ emails: [...st.emails, ...[...disk.values()].filter((e) => e.id.startsWith("m")).map(slim)], selectedId: "m0" }));
    for (let i = 0; i < 13; i++) await state().ensureBody(`m${i}`);
    const get = (id: string) => state().emails.find((e) => e.id === id)!;
    expect(get("m0").bodyTrimmed).toBeUndefined();
    expect(get("m0").html).toBe("<p>m0</p>");
    const m1 = get("m1");
    expect(m1.bodyTrimmed).toBe(true);
    expect(m1.html).toBeUndefined();
    expect(m1.text.length).toBeLessThanOrEqual(8000);
    expect(get("m12").bodyTrimmed).toBeUndefined();
    const again = await state().ensureBody("m1");
    expect(again?.html).toBe("<p>m1</p>");
  });
});

describe("synced rows and the snapshot", () => {
  it("slims incoming rows except the open email, the reply source and kept bodies", async () => {
    const full = (id: string) => row(id, "2026-10-05T00:00:00Z", { text: long, html: `<p>${id}</p>` });
    const out = store.slimIncoming([full("n1"), full("n2"), full("n3")], { selectedId: "n1", compose: { replyTo: "n2" } as never });
    expect(out[0].html).toBe("<p>n1</p>");
    expect(out[1].html).toBe("<p>n2</p>");
    expect(out[2].html).toBeUndefined();
    expect(out[2].bodyTrimmed).toBe(true);
    expect(out[2].text.length).toBeLessThanOrEqual(8000);
  });

  it("a refresh merge leaves non-selected rows without html", () => {
    const incoming = row("n9", "2026-10-06T00:00:00Z", { text: "t", html: "<p>n9</p>" });
    store.useMail.setState((st) => ({ emails: store.applyEmailChanges(st.emails, store.slimIncoming([incoming], st), []) }));
    expect(state().emails.find((e) => e.id === "n9")?.html).toBeUndefined();
  });

  // The cap on the rest is tested in needs-you-resolution.test.ts.
  it("saves triage for mail that isn't loaded too (it may still be in the mailbox)", () => {
    const t = { bucket: "reply" } as never;
    store.useMail.setState({ triage: { a: t, "18f3a2b4c5d6e7f8": t } });
    expect(Object.keys(store.snapshot(state()).triage).sort()).toEqual(["18f3a2b4c5d6e7f8", "a"]);
  });

  it("keeps all triage when no mail has loaded", () => {
    const t = { bucket: "reply" } as never;
    store.useMail.setState({ emails: [], triage: { a: t, "18f3a2b4c5d6e7f8": t } });
    expect(Object.keys(store.snapshot(state()).triage).sort()).toEqual(["18f3a2b4c5d6e7f8", "a"]);
  });
});
