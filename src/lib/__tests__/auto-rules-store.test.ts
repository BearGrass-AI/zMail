// @vitest-environment jsdom
// Automatic rules in the store: they run on new inbox mail before triage sorts it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:TRASH", accountId: "g", name: "Trash", system: "trash" },
];
const row = (id: string, over: Partial<Email> = {}) =>
  ({ id, accountId: "g", threadId: id, folderId: "g:INBOX", from: { name: "Shop", address: "ship@amazon.com" }, to: [], subject: "Your order", snippet: "", text: "", date: "2999-01-01T00:00:00Z", unread: true, starred: false, labels: ["INBOX"], ...over }) as Email;

let failMoves = 0;
let inboxMail: Email[] = [];
const moves: string[][] = [];
const fake = {
  account: gmail,
  batchSize: 50,
  listFolders: async () => folders,
  listMessages: async () => inboxMail,
  batchMove: async (emails: Email[]) => {
    moves.push(emails.map((e) => e.id));
    if (failMoves > 0) {
      failMoves--;
      throw new Error("down");
    }
    return { skipped: [], failed: [] };
  },
  batchSetRead: async () => ({ skipped: [], failed: [] }),
  batchSetStarred: async () => ({ skipped: [], failed: [] }),
};

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => null,
  mailProviderFor: () => fake,
}));
let saved: unknown = null;
vi.mock("@/lib/db", () => ({ kvGet: async () => saved, kvSet: async (_k: string, v: unknown) => void (saved = v), cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
const triaged: string[] = [];
vi.mock("@/lib/ai/triage", () => ({ triageAll: async (_p: unknown, emails: Email[]) => (triaged.push(...emails.map((e) => e.id)), { done: emails.length, failed: 0 }) }));

const { useMail } = await import("@/lib/store");

const order: string[] = [];
beforeEach(async () => {
  moves.length = 0;
  order.length = 0;
  triaged.length = 0;
  failMoves = 0;
  toastMock.mockClear();
  inboxMail = [];
  if (!useMail.getState().accounts.length) await useMail.getState().load();
  useMail.setState({ autoRules: [], triage: {}, autoHandled: {} });
  const { bulkApply, sort } = useMail.getState();
  useMail.setState({
    bulkApply: async (...a) => (order.push("bulkApply"), bulkApply(...a)),
    sort: async (...a) => (order.push("sort"), sort(...a)),
  });
});

describe("automatic rules", () => {
  it("applies a matching new inbox email before sort, bumps hits, and toasts once with Undo", async () => {
    const r = useMail.getState().addAutoRule({ from: "Amazon.com", action: "trash" });
    expect(r).toMatchObject({ enabled: true, hits: 0, match: { from: "amazon.com" } });
    inboxMail = [row("n1"), row("n2", { from: { name: "x", address: "a@other.com" } })];
    await useMail.getState().refresh();
    expect(order).toEqual(["bulkApply", "sort"]);
    expect(moves).toEqual([["n1"]]);
    const hit = useMail.getState().autoRules[0];
    expect(hit.hits).toBe(1);
    expect(hit.lastHitAt).toBeTruthy();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toBe("Auto-trashed 1 from amazon.com");
    const undo = vi.spyOn(useMail.getState(), "bulkUndo");
    moves.length = 0;
    toastMock.mock.calls[0][1].action.onClick();
    await vi.waitFor(() => expect(moves).toEqual([["n1"]]));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("leaves mail that already has a triage result alone", async () => {
    useMail.getState().addAutoRule({ from: "amazon.com", action: "archive" });
    inboxMail = [row("n3")];
    useMail.setState({ triage: { n3: { bucket: "fyi" } as never } });
    await useMail.getState().refresh();
    expect(order).not.toContain("bulkApply");
  });

  it("Undo sticks: mail a rule handled is not matched again on the next refresh", async () => {
    useMail.getState().addAutoRule({ from: "amazon.com", action: "trash" });
    inboxMail = [row("u1")];
    await useMail.getState().refresh();
    expect(moves).toEqual([["u1"]]);
    expect(useMail.getState().autoHandled.u1).toBe(true);
    // Undo put it back in the inbox, untriaged.
    inboxMail = [row("u1")];
    moves.length = 0;
    order.length = 0;
    await useMail.getState().refresh();
    expect(order).not.toContain("bulkApply");
    expect(moves).toEqual([]);
  });

  it("failed mail is skipped by sort, retried on the next refresh, and sorted after 3 failures", async () => {
    useMail.getState().addAutoRule({ from: "amazon.com", action: "trash" });
    inboxMail = [row("f1")];
    failMoves = 99;
    await useMail.getState().refresh();
    expect(triaged).not.toContain("f1");
    expect(useMail.getState().autoHandled.f1).toBeUndefined();
    moves.length = 0;
    await useMail.getState().refresh();
    expect(moves).toEqual([["f1"]]);
    expect(triaged).not.toContain("f1");
    await useMail.getState().refresh();
    expect(triaged).toContain("f1");
    moves.length = 0;
    await useMail.getState().refresh();
    expect(moves).toEqual([]);
  });

  it("rejects a bad sender and supports toggle/remove", () => {
    expect(() => useMail.getState().addAutoRule({ from: "nonsense", action: "trash" })).toThrow();
    const r = useMail.getState().addAutoRule({ from: "a@b.co", action: "mark_read" });
    useMail.getState().setAutoRuleEnabled(r.id, false);
    expect(useMail.getState().autoRules[0].enabled).toBe(false);
    useMail.getState().removeAutoRule(r.id);
    expect(useMail.getState().autoRules).toEqual([]);
  });

  it("round-trips through the saved snapshot", async () => {
    const r = useMail.getState().addAutoRule({ from: "a@b.co", subjectAny: ["x"], action: { moveTo: "g:TRASH" } });
    await vi.waitFor(() => expect((saved as { autoRules?: unknown[] } | null)?.autoRules).toEqual([r]), { timeout: 3000 });
    // A fresh store restores it from disk.
    vi.resetModules();
    const fresh = (await import("@/lib/store")).useMail;
    await fresh.getState().load();
    expect(fresh.getState().autoRules).toEqual([r]);
  });
});
