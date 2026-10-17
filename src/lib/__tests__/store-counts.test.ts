// @vitest-environment jsdom
// Sidebar unread counts: adjusted locally right away, then re-read once per burst.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const base = (): Folder[] => [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox", unread: 677 },
  { id: "g:TRASH", accountId: "g", name: "Trash", system: "trash", unread: 2 },
  { id: "g:Label_1", accountId: "g", name: "Receipts", unread: 0 },
];
const row = (id: string, over: Partial<Email> = {}) =>
  ({ id, accountId: "g", threadId: id, folderId: "g:INBOX", from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date: "2026-01-01T00:00:00Z", unread: true, starred: false, labels: ["INBOX"], ...over }) as Email;

const refreshed: string[][] = [];
let server: Record<string, number> = {};
let failRefresh = false;
const fake = {
  account: gmail,
  batchSize: 50,
  listFolders: async () => base(),
  listMessages: async () => [] as Email[],
  move: async () => {},
  setRead: async () => {},
  batchMove: async () => ({ skipped: [], failed: [] }),
  batchSetRead: async () => ({ skipped: [], failed: [] }),
  batchSetStarred: async () => ({ skipped: [], failed: [] }),
  getMessage: async (id: string) => row(id),
  refreshCounts: async (ids: string[]) => {
    refreshed.push(ids);
    if (failRefresh) throw new Error("offline");
    return Object.fromEntries(ids.filter((i) => i in server).map((i) => [i, server[i]]));
  },
};

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "g", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: () => fake,
}));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));

const { useMail, folderUnread } = await import("@/lib/store");
const unread = (id: string) => useMail.getState().folders.find((f) => f.id === id)?.unread;

beforeEach(async () => {
  if (!useMail.getState().accounts.length) await useMail.getState().load();
  vi.useFakeTimers();
  refreshed.length = 0;
  server = {};
  failRefresh = false;
  // Let any earlier test's pending refresh run and settle, then start clean.
  await vi.advanceTimersByTimeAsync(20_000);
  refreshed.length = 0;
  useMail.setState({ folders: base(), emails: [row("a"), row("b"), row("r", { unread: false }), ...Array.from({ length: 60 }, (_, i) => row(`m${i}`))] });
});
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(20_000); // flush any pending re-read before the fake clock goes away
  vi.useRealTimers();
});

describe("local count adjustment", () => {
  it("trashing an unread inbox email moves one from inbox to trash", async () => {
    await useMail.getState().trash(["a"]);
    expect(unread("g:INBOX")).toBe(676);
    expect(unread("g:TRASH")).toBe(3);
  });

  it("a read email leaving the inbox changes nothing", async () => {
    await useMail.getState().trash(["r"]);
    expect(unread("g:INBOX")).toBe(677);
    expect(unread("g:TRASH")).toBe(2);
  });

  it("marking read and unread adjusts the folder", async () => {
    await useMail.getState().setRead(["a"], true);
    expect(unread("g:INBOX")).toBe(676);
    await useMail.getState().setRead(["a"], false);
    expect(unread("g:INBOX")).toBe(677);
  });

  it("bulk undo reverses a bulk trash", async () => {
    const emails = useMail.getState().emails.filter((e) => ["a", "b"].includes(e.id));
    const res = await useMail.getState().bulkApply(emails, { kind: "trash" });
    expect([unread("g:INBOX"), unread("g:TRASH")]).toEqual([675, 4]);
    await useMail.getState().bulkUndo(res.undo, { kind: "trash" });
    expect([unread("g:INBOX"), unread("g:TRASH")]).toEqual([677, 2]);
  });

  it("never goes below zero, and the sidebar number follows", async () => {
    useMail.setState((s) => ({ folders: s.folders.map((f) => (f.id === "g:INBOX" ? { ...f, unread: 0 } : f)) }));
    await useMail.getState().trash(["a"]);
    expect(unread("g:INBOX")).toBe(0);
    const s = useMail.getState();
    expect(folderUnread(s, s.folders[0])).toBe(s.emails.filter((e) => e.folderId === "g:INBOX" && e.unread).length);
  });

  it("skips a destination that has no server count", async () => {
    await useMail.getState().move(["a"], "g:NOPE", { learn: false });
    expect(unread("g:INBOX")).toBe(676);
    expect(useMail.getState().folders.find((f) => f.id === "g:NOPE")).toBeUndefined();
  });
});

describe("debounced re-sync", () => {
  it("10 quick actions make one refreshCounts call for the affected folders, merged into the store", async () => {
    server = { "g:INBOX": 600, "g:TRASH": 40 };
    for (let i = 0; i < 10; i++) await useMail.getState().trash([`m${i}`]);
    expect(refreshed).toEqual([]);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(refreshed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refreshed).toHaveLength(1);
    expect([...refreshed[0]].sort()).toEqual(["g:INBOX", "g:TRASH"]);
    expect([unread("g:INBOX"), unread("g:TRASH")]).toEqual([600, 40]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshed).toHaveLength(1);
  });

  it("a burst of 50 bulk deletes is one call over two folders", async () => {
    const emails = useMail.getState().emails.filter((e) => e.id.startsWith("m")).slice(0, 50);
    for (const e of emails) await useMail.getState().bulkApply([e], { kind: "trash" });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toHaveLength(2);
  });

  it("a fresh local count survives a full folder sync until the re-read lands", async () => {
    await useMail.getState().trash(["a"]);
    await useMail.getState().refresh();
    expect(unread("g:INBOX")).toBe(676);
  });

  it("errors are swallowed, with no retry", async () => {
    failRefresh = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await useMail.getState().trash(["a"]);
    await vi.advanceTimersByTimeAsync(16_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refreshed).toHaveLength(1);
    expect(unread("g:INBOX")).toBe(676);
    warn.mockRestore();
  });

  it("does nothing while offline", async () => {
    const nav = vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(false);
    await useMail.getState().trash(["a"]);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(refreshed).toEqual([]);
    nav.mockRestore();
  });
});
