// @vitest-environment jsdom
// Sorting new mail must not rescan every email; helper behaviour for the faster paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder, Triage } from "@/lib/types";

const acct = { id: "p", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const inbox: Folder = { id: "p:INBOX", accountId: "p", name: "Inbox", system: "inbox" };
const other: Folder = { id: "p:X", accountId: "p", name: "X" } as Folder;
const mail = (id: string, text = "Payment due October 18", date = new Date().toISOString()): Email =>
  ({ id, accountId: "p", threadId: id, folderId: inbox.id, from: { name: "A", address: `${id}@x.com` }, to: [], subject: "Statement", snippet: "", text, date, unread: false, starred: false, labels: [] }) as unknown as Email;

let sent: string[] = [];
/** Every email sent to the decision model, how many triageAll calls ran at once, and an optional gate they wait on. */
let decided: string[] = [];
let inFlight = 0;
let maxInFlight = 0;
let gate: Promise<void> | null = null;

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [acct],
  saveRegistry: async () => {},
  calendarProviderFor: () => null,
  mailProviderFor: () => ({
    account: acct,
    listFolders: async () => [inbox],
    listMessages: async () => [mail("a"), mail("b")],
  }),
}));
vi.mock("@/lib/db", () => ({
  kvGet: async () => null,
  kvSet: async () => {},
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({
  triageAll: async (_p: unknown, emails: Email[], _c: unknown, onResult: (t: Triage) => void) => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    try {
      if (gate) await gate;
      for (const e of emails) {
        decided.push(e.id);
        onResult({ emailId: e.id, bucket: "worth_skim", category: "transactions", urgency: 0, model: "jev" } as unknown as Triage);
      }
    } finally {
      inFlight--;
    }
    return { done: emails.length, failed: 0 };
  },
}));
vi.mock("@/lib/ai/providers", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/providers")>()),
  generativeProvider: () => ({ name: "fake-writer" }),
}));
vi.mock("@/lib/ai/dates", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/dates")>()),
  extractDates: async (_p: unknown, e: Email) => {
    sent.push(e.id);
    return [];
  },
}));

const fresh = async () => {
  vi.resetModules();
  return import("@/lib/store");
};

beforeEach(() => {
  sent = [];
  decided = [];
  inFlight = maxInFlight = 0;
  gate = null;
});

describe("inboxFolderIds / isInbox", () => {
  it("returns inbox ids, cached per folders array", async () => {
    const { inboxFolderIds } = await fresh();
    const folders = [inbox, other];
    const ids = inboxFolderIds(folders);
    expect([...ids]).toEqual([inbox.id]);
    expect(inboxFolderIds(folders)).toBe(ids);
    expect(inboxFolderIds([inbox, other])).not.toBe(ids);
  });

  it("is false for snoozed mail and true for inbox mail", async () => {
    const { isInbox } = await fresh();
    const e = mail("a");
    expect(isInbox({ folders: [inbox], snoozed: {} }, e)).toBe(true);
    expect(isInbox({ folders: [inbox], snoozed: { a: Date.now() + 1e6 } }, e)).toBe(false);
    expect(isInbox({ folders: [inbox], snoozed: { a: Date.now() - 1e6 } }, e)).toBe(true);
    expect(isInbox({ folders: [other], snoozed: {} }, e)).toBe(false);
  });
});

describe("mergeByDateDesc", () => {
  const d = (n: number) => new Date(2026, 0, n).toISOString();
  it("interleaves, sorting the second list first", async () => {
    const { mergeByDateDesc } = await fresh();
    const a = [mail("a5", "", d(5)), mail("a3", "", d(3)), mail("a1", "", d(1))];
    const b = [mail("b2", "", d(2)), mail("b4", "", d(4)), mail("b6", "", d(6))];
    expect(mergeByDateDesc(a, b).map((e) => e.id)).toEqual(["b6", "a5", "b4", "a3", "b2", "a1"]);
  });
  it("is stable for equal dates (existing first)", async () => {
    const { mergeByDateDesc } = await fresh();
    const a = [mail("a1", "", d(3)), mail("a2", "", d(3))];
    const b = [mail("b1", "", d(3)), mail("b2", "", d(3))];
    expect(mergeByDateDesc(a, b).map((e) => e.id)).toEqual(["a1", "a2", "b1", "b2"]);
  });
  it("handles empty arrays", async () => {
    const { mergeByDateDesc } = await fresh();
    const a = [mail("a", "", d(1))];
    expect(mergeByDateDesc([], [])).toEqual([]);
    expect(mergeByDateDesc(a, []).map((e) => e.id)).toEqual(["a"]);
    expect(mergeByDateDesc([], a).map((e) => e.id)).toEqual(["a"]);
  });
});

describe("scoped findDates after sort", () => {
  it("reads only the newly sorted mail on the second sort", async () => {
    const { useMail } = await fresh();
    await useMail.getState().load();
    await vi.waitFor(() => expect([...sent].sort()).toEqual(["a", "b"]));
    sent = [];
    // x is already triaged (so the sort skips it) but was never date-read; a full scan would pick it up.
    const xTriage = { emailId: "x", bucket: "worth_skim", category: "transactions", urgency: 0, model: "jev" } as unknown as Triage;
    useMail.setState((s) => ({ emails: [mail("c"), mail("x"), ...s.emails], triage: { ...s.triage, x: xTriage } }));
    await useMail.getState().sort({ onlyNew: true });
    await vi.waitFor(() => expect(sent).toContain("c"));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual(["c"]);
  });
});

describe("sort never overlaps", () => {
  const start = async () => {
    const { useMail } = await fresh();
    useMail.setState({ folders: [inbox], emails: [mail("a"), mail("b")] });
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    return { s: useMail.getState(), open, useMail };
  };

  it("three concurrent sorts of new mail decide each email once", async () => {
    const { s, open } = await start();
    const runs = [s.sort({ onlyNew: true }), s.sort({ onlyNew: true }), s.sort({ onlyNew: true })];
    open();
    await Promise.all(runs);
    expect(decided.sort()).toEqual(["a", "b"]);
    expect(maxInFlight).toBe(1);
  });

  it("full sorts queued behind a running one take turns, and a later sort doesn't start beside the last", async () => {
    const { s, open } = await start();
    const runs = [s.sort(), s.sort(), s.sort()];
    open();
    await Promise.all(runs);
    expect(maxInFlight).toBe(1);
    expect(decided).toEqual(["a", "b", "a", "b", "a", "b"]);
    gate = new Promise(() => {});
    void s.sort();
    void s.sort();
    await new Promise((r) => setTimeout(r, 0));
    expect(inFlight).toBe(1);
  });
});
