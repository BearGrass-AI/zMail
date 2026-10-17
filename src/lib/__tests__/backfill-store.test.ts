// @vitest-environment jsdom
// Background Inbox backfill in the store, and batched triage writes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder, Triage } from "@/lib/types";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:TRASH", accountId: "g", name: "Trash", system: "trash" },
];
const row = (id: string, date: string, over: Partial<Email> = {}) =>
  ({ id, accountId: "g", threadId: id, folderId: "g:INBOX", from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date, unread: true, starred: false, labels: ["INBOX"], ...over }) as Email;

type Page = { emails: Email[]; next?: string; total?: number; failed?: number } | Error;
let pages: Record<string, Page> = {};
/** Cursors the store asked for, in order. */
const calls: (string | undefined)[] = [];
/** What the provider has cached (listMessages returns it, like the real providers). */
const cached: Email[] = [];
let recent: Email[] = [];
const log: string[] = [];
const fake = {
  account: gmail,
  batchSize: 50,
  listFolders: async () => folders,
  listMessages: async () => [...recent, ...cached],
  backfillInbox: async (cursor?: string) => {
    calls.push(cursor);
    const p = pages[cursor ?? ""];
    if (!p) throw new Error(`no page ${cursor}`);
    if (p instanceof Error) throw p;
    cached.push(...p.emails);
    return p;
  },
  batchMove: async (emails: Email[]) => {
    log.push(`move:${emails.map((e) => e.id).join(",")}`);
    return { skipped: [], failed: [] };
  },
  batchSetRead: async () => ({ skipped: [], failed: [] }),
  batchSetStarred: async () => ({ skipped: [], failed: [] }),
};

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => null,
  mailProviderFor: () => fake,
}));
const kv = new Map<string, unknown>();
vi.mock("@/lib/db", () => ({
  kvGet: async (k: string) => kv.get(k) ?? null,
  kvSet: async (k: string, v: unknown) => void kv.set(k, v),
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
/** Milliseconds the fake model waits before each result (0 = all at once). */
let gap = 0;
const result = (emailId: string) => ({ emailId, bucket: "fyi", category: "updates", urgency: 0, needsReply: 0, model: "fake" }) as unknown as Triage;
vi.mock("@/lib/ai/triage", () => ({
  triageAll: async (_p: unknown, emails: Email[], _ctx: unknown, onResult: (t: Triage) => void) => {
    if (emails.length) log.push(`triage:${emails.map((e) => e.id).join(",")}`);
    for (const e of emails) {
      if (gap) await new Promise((r) => setTimeout(r, gap));
      onResult(result(e.id));
    }
    return { done: emails.length, failed: 0 };
  },
}));

let store: typeof import("@/lib/store");
const state = () => store.useMail.getState();

/** Let the loop run: page fetches, sorts and the pauses between pages. */
async function settle() {
  for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(300);
}

/** Load the store with the clock running (load waits for the first sort). */
async function start() {
  const loading = state().load();
  await settle();
  await loading;
}

beforeEach(async () => {
  vi.useFakeTimers();
  kv.clear();
  calls.length = 0;
  cached.length = 0;
  log.length = 0;
  pages = {};
  recent = [];
  gap = 0;
  vi.resetModules();
  store = await import("@/lib/store");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Inbox backfill", () => {
  it("pages until there's no next, merges new mail in date order, then saves done", async () => {
    recent = [row("r1", "2026-10-10T00:00:00Z")];
    pages = {
      "": { emails: [row("b1", "2026-09-01T00:00:00Z"), row("b2", "2026-08-01T00:00:00Z")], next: "p2", total: 5 },
      // b1 again (already merged) must not be duplicated.
      p2: { emails: [row("b3", "2026-07-01T00:00:00Z"), row("b1", "2026-09-01T00:00:00Z")] },
    };
    await start();
    expect(calls).toEqual([undefined, "p2"]);
    expect(kv.get("backfill.g")).toEqual({ done: true });
    expect(state().emails.map((e) => e.id)).toEqual(["r1", "b1", "b2", "b3"]);
    expect(state().backfill.g).toEqual({ loaded: 4, total: 5, running: false });
    expect(Object.keys(state().triage).sort()).toEqual(["b1", "b2", "b3", "r1"]);
  });

  it("skips an account whose saved cursor says done", async () => {
    kv.set("backfill.g", { done: true });
    await start();
    expect(calls).toEqual([]);
    expect(state().backfill.g).toBeUndefined();
  });

  it("resumes from the saved next", async () => {
    kv.set("backfill.g", { next: "p2" });
    pages = { p2: { emails: [row("b3", "2026-07-01T00:00:00Z")] } };
    await start();
    expect(calls).toEqual(["p2"]);
    expect(kv.get("backfill.g")).toEqual({ done: true });
    expect(state().emails.map((e) => e.id)).toEqual(["b3"]);
  });

  it("runs automatic rules on backfilled mail before sorting it", async () => {
    pages = {
      "": { emails: [row("b1", "2026-09-01T00:00:00Z"), row("b2", "2026-08-01T00:00:00Z", { from: { name: "Shop", address: "ship@amazon.com" } })] },
    };
    const rule = state().addAutoRule({ from: "amazon.com", action: "trash" });
    // Rules only act on mail sent after they were made; this one predates the backfilled mail.
    store.useMail.setState({ autoRules: [{ ...rule, createdAt: "2026-01-01T00:00:00Z" }] });
    const { sort, bulkApply } = state();
    const sortSpy = vi.fn((...a: Parameters<typeof sort>) => (log.push("sort"), sort(...a)));
    const rulesSpy = vi.fn((...a: Parameters<typeof bulkApply>) => (log.push("rules"), bulkApply(...a)));
    store.useMail.setState({ sort: sortSpy, bulkApply: rulesSpy });
    await start();
    const i = log.indexOf("move:b2");
    expect(i).toBeGreaterThan(-1);
    expect(log.slice(i - 1)).toEqual(["rules", "move:b2", "sort", "triage:b1"]);
    expect(rulesSpy).toHaveBeenCalled();
    expect(state().triage.b1).toBeDefined();
    expect(state().triage.b2).toBeUndefined();
  });

  it("runs once per session: another refresh, during or after, doesn't start it again", async () => {
    pages = {
      "": { emails: [row("b1", "2026-09-01T00:00:00Z")], next: "p2" },
      p2: { emails: [row("b2", "2026-08-01T00:00:00Z")] },
    };
    await state().load();
    // Mid-loop refreshes.
    await state().refresh();
    await vi.advanceTimersByTimeAsync(100);
    await state().refresh();
    await settle();
    expect(calls).toEqual([undefined, "p2"]);
    // Even with the cursor gone, a later refresh this session leaves it alone.
    kv.delete("backfill.g");
    await state().refresh();
    await settle();
    expect(calls).toEqual([undefined, "p2"]);
  });

  it("an error stops the account for the session and keeps the saved cursor", async () => {
    pages = { "": { emails: [row("b1", "2026-09-01T00:00:00Z")], next: "p2", total: 9 }, p2: new Error("quota") };
    await start();
    expect(calls).toEqual([undefined, "p2"]);
    expect(kv.get("backfill.g")).toEqual({ next: "p2" });
    expect(state().backfill.g).toMatchObject({ running: false, error: "quota", loaded: 1, total: 9 });
    await state().refresh();
    await settle();
    expect(calls).toEqual([undefined, "p2"]);
  });

  it("a page with uncached mail holds the saved cursor there, while the loop finishes this session", async () => {
    pages = {
      "": { emails: [row("b1", "2026-09-01T00:00:00Z")], next: "p2" },
      p2: { emails: [row("b2", "2026-08-01T00:00:00Z")], next: "p3", failed: 1 },
      p3: { emails: [row("b3", "2026-07-01T00:00:00Z")], next: "p4", failed: 2 },
      p4: { emails: [row("b4", "2026-06-01T00:00:00Z")] },
    };
    await start();
    expect(calls).toEqual([undefined, "p2", "p3", "p4"]);
    expect(kv.get("backfill.g")).toEqual({ next: "p2" });
    expect(state().emails.map((e) => e.id)).toEqual(["b1", "b2", "b3", "b4"]);
    expect(state().backfill.g).toMatchObject({ running: false });
    expect(state().backfill.g.error).toBeUndefined();
  });

  it("failures on the first page save no cursor (start from the top next time), never done", async () => {
    pages = { "": { emails: [row("b1", "2026-09-01T00:00:00Z")], next: "p2", failed: 1 }, p2: { emails: [] } };
    await start();
    expect(calls).toEqual([undefined, "p2"]);
    expect(kv.get("backfill.g")).toEqual({});
  });

  it("a stale saved cursor (4xx) is cleared and the account restarts from the top, once", async () => {
    const { HttpError } = await import("@/lib/transport");
    kv.set("backfill.g", { next: "old" });
    pages = {
      old: new HttpError(400, "Invalid pageToken"),
      "": { emails: [row("b1", "2026-09-01T00:00:00Z")], next: "p2" },
      p2: new HttpError(400, "Invalid pageToken"),
    };
    await start();
    expect(calls).toEqual(["old", undefined, "p2"]);
    expect(kv.get("backfill.g")).toEqual({ next: "p2" });
    expect(state().backfill.g).toMatchObject({ running: false, error: expect.stringContaining("400") });
  });

  it.each([401, 403, 429, 500])("a %i on the saved cursor keeps it", async (status) => {
    const { HttpError } = await import("@/lib/transport");
    kv.set("backfill.g", { next: "old" });
    pages = { old: new HttpError(status, "nope"), "": { emails: [] } };
    await start();
    expect(calls).toEqual(["old"]);
    expect(kv.get("backfill.g")).toEqual({ next: "old" });
  });

  it("shows progress while running", async () => {
    pages = { "": { emails: [row("b1", "2026-09-01T00:00:00Z")], next: "p2", total: 1200 }, p2: { emails: [] } };
    const seen: (string | null)[] = [];
    store.useMail.subscribe((s) => seen.push(store.backfillLine(s.backfill)));
    await start();
    expect(seen).toContain("Loading older Inbox mail · 1 of ~1,200");
    expect(store.backfillLine(state().backfill)).toBeNull();
  });
});

describe("backfillLine", () => {
  it("formats loaded of total, loaded alone, and nothing when idle", () => {
    expect(store.backfillLine({ g: { loaded: 400, total: 1200, running: true } })).toBe("Loading older Inbox mail · 400 of ~1,200");
    expect(store.backfillLine({ g: { loaded: 400, running: true } })).toBe("Loading older Inbox mail · 400");
    expect(store.backfillLine({ g: { loaded: 400, total: 1200, running: false } })).toBeNull();
    expect(store.backfillLine({})).toBeNull();
  });
});

describe("batched triage writes", () => {
  const twenty = () => Array.from({ length: 20 }, (_, i) => row(`t${i}`, `2026-10-${String(10 + (i % 9)).padStart(2, "0")}T00:00:00Z`));

  it("20 results at once make far fewer than 20 store updates", async () => {
    pages = { "": { emails: [] } };
    recent = twenty();
    let updates = 0;
    store.useMail.subscribe((s, prev) => void (s.triage !== prev.triage && updates++));
    await start();
    expect(Object.keys(state().triage)).toHaveLength(20);
    expect(state().sorting).toMatchObject({ running: false, done: 20, total: 20 });
    expect(updates).toBeLessThanOrEqual(3);
  });

  it("results spread over time are applied at most every 250 ms", async () => {
    pages = { "": { emails: [] } };
    recent = twenty();
    gap = 100; // 20 results over 2 s
    let updates = 0;
    const done: number[] = [];
    store.useMail.subscribe((s, prev) => {
      if (s.triage === prev.triage) return;
      updates++;
      done.push(s.sorting.done);
    });
    await start();
    expect(Object.keys(state().triage)).toHaveLength(20);
    expect(state().sorting.done).toBe(20);
    expect(updates).toBeGreaterThan(2);
    expect(updates).toBeLessThanOrEqual(10);
    // Progress counts the batch, ending at the total.
    expect(done.at(-1)).toBe(20);
  });
});
