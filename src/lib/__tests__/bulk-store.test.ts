// @vitest-environment jsdom
// Bulk actions in the store: chunking by the provider's batch size, skipping
// mail that's already there, stopping on failure, resume, undo, and accounts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const outlook = { id: "o", kind: "m365" as const, name: "Work", address: "z@example.org" };
const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:TRASH", accountId: "g", name: "Trash", system: "trash" },
  { id: "g:ARCHIVE", accountId: "g", name: "All Mail", system: "archive" },
  { id: "g:Label_1", accountId: "g", name: "Receipts" },
  { id: "o:inbox", accountId: "o", name: "Inbox", system: "inbox" },
  { id: "o:deleted", accountId: "o", name: "Deleted Items", system: "trash" },
];
const row = (id: string, accountId = "g", over: Partial<Email> = {}) =>
  ({ id, accountId, threadId: id, folderId: `${accountId === "g" ? "g:INBOX" : "o:inbox"}`, from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date: "2026-01-01T00:00:00Z", unread: true, starred: false, labels: ["INBOX"], ...over }) as Email;

const moves: { account: string; ids: string[]; folderId: string }[] = [];
let failOnCall = -1;
let call = 0;
let withRestore = false;
const restored: { id: string; labels: string[] }[][] = [];
const fake = (account: typeof gmail) => ({
  account,
  batchSize: 2,
  listFolders: async () => folders.filter((f) => f.accountId === account.id),
  listMessages: async () => (account.id === "g" ? [row("c1")] : []),
  batchMove: async (emails: Email[], folderId: string) => {
    if (call++ === failOnCall) throw new Error("network down");
    moves.push({ account: account.id, ids: emails.map((e) => e.id), folderId });
    return { skipped: [], failed: [] };
  },
  batchSetRead: async (ids: string[]) => ({ skipped: ids.filter((id) => id === "gone"), failed: ids.filter((id) => id === "bad") }),
  batchSetStarred: async () => ({ skipped: [], failed: [] }),
  get restoreLabels() {
    return withRestore ? async (entries: { id: string; labels: string[] }[]) => (restored.push(entries), { skipped: [], failed: [] }) : undefined;
  },
  getMessage: async (id: string) => row(id, account.id, { text: "full body", partial: undefined }),
});

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail, outlook],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "g", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: (a: typeof gmail) => fake(a),
}));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));

const { useMail } = await import("@/lib/store");
const { needsConfirm } = await import("@/lib/mail/bulk");

beforeEach(async () => {
  moves.length = 0;
  failOnCall = -1;
  call = 0;
  withRestore = false;
  restored.length = 0;
  if (!useMail.getState().accounts.length) await useMail.getState().load();
});

describe("approval rule", () => {
  it("undoable ops on 3 or fewer run directly; everything else confirms", () => {
    expect(needsConfirm({ kind: "archive" }, 3)).toBe(false);
    expect(needsConfirm({ kind: "archive" }, 4)).toBe(true);
    expect(needsConfirm({ kind: "read", read: true }, 3)).toBe(false);
    expect(needsConfirm({ kind: "section", sectionId: "s" }, 3)).toBe(false);
    expect(needsConfirm({ kind: "trash" }, 1)).toBe(true);
    expect(needsConfirm({ kind: "spam" }, 1)).toBe(true);
    expect(needsConfirm({ kind: "move", folderId: "g:Label_1" }, 1)).toBe(true);
  });
});

describe("bulkApply", () => {
  it("trashes in provider-sized chunks, skips mail already there, and records undo", async () => {
    const res = await useMail.getState().bulkApply([row("a"), row("b"), row("c"), row("t", "g", { folderId: "g:TRASH" })], { kind: "trash" });
    expect(moves.map((m) => m.ids)).toEqual([["a", "b"], ["c"]]);
    expect(res).toMatchObject({ done: 3, skipped: 1, failed: [] });
    expect(res.undo.map((u) => [u.id, u.folderId])).toEqual([["a", "g:INBOX"], ["b", "g:INBOX"], ["c", "g:INBOX"]]);
  });

  it("stops at a failed chunk, reports the rest as failed, and resumes", async () => {
    failOnCall = 1;
    const emails = [row("a"), row("b"), row("c"), row("d"), row("e")];
    const res = await useMail.getState().bulkApply(emails, { kind: "trash" });
    expect(res.done).toBe(2);
    expect(res.failed.map((e) => e.id)).toEqual(["c", "d", "e"]);
    expect(res.error).toMatch(/network down/);
    const again = await useMail.getState().bulkApply(res.failed, { kind: "trash" });
    expect(again).toMatchObject({ done: 3, failed: [] });
  });

  it("move to a folder only moves that folder's account", async () => {
    const res = await useMail.getState().bulkApply([row("a"), row("x", "o")], { kind: "move", folderId: "g:Label_1" });
    expect(moves).toEqual([{ account: "g", ids: ["a"], folderId: "g:Label_1" }]);
    expect(res.failed.map((e) => e.id)).toEqual(["x"]);
    expect(res.error).toMatch(/belongs to another account/);
  });

  it("resolves trash per account for mixed sets", async () => {
    await useMail.getState().bulkApply([row("a"), row("x", "o")], { kind: "trash" });
    expect(moves).toEqual([
      { account: "g", ids: ["a"], folderId: "g:TRASH" },
      { account: "o", ids: ["x"], folderId: "o:deleted" },
    ]);
  });

  it("undo moves each email back to where it was", async () => {
    const res = await useMail.getState().bulkApply([row("a"), row("r", "g", { folderId: "g:Label_1" })], { kind: "trash" });
    moves.length = 0;
    await useMail.getState().bulkUndo(res.undo, { kind: "trash" });
    expect(moves).toEqual([
      { account: "g", ids: ["a"], folderId: "g:INBOX" },
      { account: "g", ids: ["r"], folderId: "g:Label_1" },
    ]);
  });

  it("counts ids the server says are gone as skipped", async () => {
    const res = await useMail.getState().bulkApply([row("gone"), row("k")], { kind: "read", read: true });
    expect(res).toMatchObject({ done: 1, skipped: 1 });
  });

  it("updates cached emails in place", async () => {
    await useMail.getState().bulkApply([useMail.getState().emails.find((e) => e.id === "c1")!], { kind: "read", read: true });
    expect(useMail.getState().emails.find((e) => e.id === "c1")?.unread).toBe(false);
  });

  it("puts mail in a section and undoes it", async () => {
    const res = await useMail.getState().bulkApply([row("a")], { kind: "section", sectionId: "sec1" });
    expect(useMail.getState().sectionOverrides.a).toBe("sec1");
    await useMail.getState().bulkUndo(res.undo, { kind: "section", sectionId: "sec1" });
    expect("a" in useMail.getState().sectionOverrides).toBe(false);
  });
});

describe("failures are never reported as done", () => {
  it("returns provider-reported failures and the untouched rest, and undo covers only what changed", async () => {
    const res = await useMail.getState().bulkApply([row("a"), row("bad"), row("c")], { kind: "read", read: true });
    expect(res.done).toBe(1);
    expect(res.failed.map((e) => e.id)).toEqual(["bad", "c"]);
    expect(res.error).toMatch(/couldn't be changed/);
    expect(res.undo.map((u) => u.id)).toEqual(["a"]);
  });
});

const addToStore = (...es: Email[]) => useMail.setState((s) => ({ emails: [...s.emails, ...es] }));

describe("undo fidelity", () => {
  it("undoing mark-read restores only unread, not folder or star", async () => {
    addToStore(row("rd"));
    const res = await useMail.getState().bulkApply([row("rd")], { kind: "read", read: true });
    useMail.setState((s) => ({ emails: s.emails.map((e) => (e.id === "rd" ? { ...e, folderId: "g:ARCHIVE", starred: true } : e)) }));
    await useMail.getState().bulkUndo(res.undo, { kind: "read", read: true });
    const e = useMail.getState().emails.find((x) => x.id === "rd")!;
    expect([e.unread, e.folderId, e.starred]).toEqual([true, "g:ARCHIVE", true]);
  });

  it("undoes a star", async () => {
    addToStore(row("st"));
    const res = await useMail.getState().bulkApply([row("st")], { kind: "star", starred: true });
    expect(useMail.getState().emails.find((x) => x.id === "st")?.starred).toBe(true);
    await useMail.getState().bulkUndo(res.undo, { kind: "star", starred: true });
    expect(useMail.getState().emails.find((x) => x.id === "st")?.starred).toBe(false);
  });

  it("undoing a section action removes the lesson it taught and restores a replaced one", async () => {
    addToStore(row("l1"), row("l2"));
    useMail.getState().setSection(["l1"], "old");
    const res = await useMail.getState().bulkApply([row("l1"), row("l2")], { kind: "section", sectionId: "new" });
    const sec = (id: string) => useMail.getState().lessons.filter((l) => l.emailId === id && "section" in l).map((l) => l.section);
    expect([sec("l1"), sec("l2")]).toEqual([["new"], ["new"]]);
    await useMail.getState().bulkUndo(res.undo, { kind: "section", sectionId: "new" });
    expect([sec("l1"), sec("l2")]).toEqual([["old"], []]);
  });

  it("restores labels through the provider when it can, otherwise moves back", async () => {
    withRestore = false;
    const res = await useMail.getState().bulkApply([row("a", "g", { folderId: "g:Label_1", labels: ["Label_1", "Label_2"] })], { kind: "archive" });
    moves.length = 0;
    await useMail.getState().bulkUndo(res.undo, { kind: "archive" });
    expect(moves).toEqual([{ account: "g", ids: ["a"], folderId: "g:Label_1" }]);
    expect(restored).toEqual([]);

    withRestore = true;
    const res2 = await useMail.getState().bulkApply([row("b", "g", { folderId: "g:Label_1", labels: ["Label_1", "Label_2"] })], { kind: "archive" });
    moves.length = 0;
    await useMail.getState().bulkUndo(res2.undo, { kind: "archive" });
    expect(moves).toEqual([]);
    expect(restored).toEqual([[{ id: "b", labels: ["Label_1", "Label_2"] }]]);
  });
});

describe("chained moves", () => {
  it("tracks Gmail labels on a forward move, so a second undo goes back to the right place", async () => {
    withRestore = true;
    addToStore(row("ch"));
    const first = await useMail.getState().bulkApply([useMail.getState().emails.find((e) => e.id === "ch")!], { kind: "archive" });
    expect(useMail.getState().emails.find((e) => e.id === "ch")?.labels).not.toContain("INBOX");
    const second = await useMail.getState().bulkApply([useMail.getState().emails.find((e) => e.id === "ch")!], { kind: "move", folderId: "g:Label_1" });
    expect(useMail.getState().emails.find((e) => e.id === "ch")?.labels).toContain("Label_1");
    moves.length = 0;
    restored.length = 0;
    await useMail.getState().bulkUndo(second.undo, { kind: "move", folderId: "g:Label_1" });
    // Archived mail has no folder labels; restoring those exact labels removes Label_1 and never touches Inbox.
    expect(restored).toEqual([[{ id: "ch", labels: [] }]]);
    expect(moves).toEqual([]);
    expect(useMail.getState().emails.find((e) => e.id === "ch")).toMatchObject({ folderId: "g:ARCHIVE", labels: [] });
    expect(first.undo[0].folderId).toBe("g:INBOX");
  });

  it("falls back to a plain move when recorded labels disagree with the recorded folder", async () => {
    withRestore = true;
    addToStore(row("q", "g", { folderId: "g:Label_1", labels: ["Label_1"] }));
    await useMail.getState().bulkUndo([{ id: "q", accountId: "g", folderId: "g:ARCHIVE", unread: false, starred: false, labels: ["INBOX"] }], { kind: "move", folderId: "g:Label_1" });
    expect(restored).toEqual([]);
    expect(moves).toEqual([{ account: "g", ids: ["q"], folderId: "g:ARCHIVE" }]);
    // Untrusted labels are not written back next to a folder they disagree with.
    expect(useMail.getState().emails.find((e) => e.id === "q")).toMatchObject({ folderId: "g:ARCHIVE", labels: ["Label_1"] });
  });
});

describe("progress, cancellation and reasons", () => {
  it("reports progress up to the total when some mail is already there", async () => {
    const seen: number[][] = [];
    await useMail.getState().bulkApply([row("a"), row("b"), row("z", "g", { folderId: "g:ARCHIVE" })], { kind: "archive" }, { onProgress: (d, t) => seen.push([d, t]) });
    expect(seen.at(-1)).toEqual([3, 3]);
  });

  it("stops when cancelled and returns the rest", async () => {
    let n = 0;
    const res = await useMail.getState().bulkApply([row("a"), row("b"), row("c")], { kind: "trash" }, { isCancelled: () => n++ >= 1 });
    expect(moves.map((m) => m.ids)).toEqual([["a", "b"]]);
    expect(res.failed.map((e) => e.id)).toEqual(["c"]);
    expect(res.error).toBe("Stopped.");
  });

  it("does not report a stopped run as complete", async () => {
    const seen: number[][] = [];
    await useMail.getState().bulkApply([row("a"), row("b"), row("c")], { kind: "trash" }, { onProgress: (d, t) => seen.push([d, t]), isCancelled: () => seen.length >= 1 });
    expect(seen.at(-1)).toEqual([2, 3]);
  });

  it("says when a folder no longer exists and names accounts", async () => {
    const gone = await useMail.getState().bulkApply([row("a")], { kind: "move", folderId: "g:nope" });
    expect(gone.error).toBe("That folder no longer exists.");
    const mixed = await useMail.getState().bulkApply([row("a"), row("x", "o")], { kind: "move", folderId: "g:Label_1" });
    expect(mixed.error).toContain("Work");
  });
});

describe("ensureEmail", () => {
  it("fetches a header-only email in full and adds it to the store", async () => {
    const e = await useMail.getState().ensureEmail({ id: "old1", accountId: "g" });
    expect(e.text).toBe("full body");
    expect(useMail.getState().emails.some((x) => x.id === "old1" && !x.partial)).toBe(true);
  });
});
