// @vitest-environment jsdom
// sort stamps a RopeLine flag on every inbox email and does not move any of them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@acmeplumbing.example" };
const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:SPAM", accountId: "g", name: "Spam", system: "spam" },
];
const row = (id: string, over: Partial<Email> = {}): Email =>
  ({
    id,
    accountId: "g",
    threadId: id,
    folderId: "g:INBOX",
    from: { name: "Pat Example", address: "pat@example.com" },
    to: [],
    subject: "Hello",
    snippet: "",
    text: "A short note with no date in it.",
    date: "2026-10-18T00:00:00Z",
    unread: true,
    starred: false,
    labels: ["INBOX"],
    ...over,
  }) as Email;

const moves: string[] = [];
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/lib/db", () => ({
  kvGet: async () => null,
  kvSet: async () => {},
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
  cacheGetMessage: async () => null,
  cacheDeleteAccount: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [],
  saveRegistry: async () => {},
  calendarProviderFor: () => null,
  mailProviderFor: () => ({
    account: gmail,
    batchSize: 20,
    batchMove: async (emails: Email[]) => {
      moves.push(...emails.map((e) => e.id));
      return { skipped: [], failed: [] };
    },
    batchSetRead: async () => ({ skipped: [], failed: [] }),
    batchSetStarred: async () => ({ skipped: [], failed: [] }),
  }),
}));

const { useMail } = await import("@/lib/store");
const { snapshot } = await import("@/lib/store/persistence");

beforeEach(() => {
  moves.length = 0;
  useMail.setState({
    accounts: [gmail],
    folders,
    emails: [],
    triage: {},
    ropelineFlags: {},
    autoRules: [],
    sections: [],
    lessons: [],
  });
});

describe("sort", () => {
  it("flags every inbox email and leaves folders alone", async () => {
    const clean = row("clean");
    const bad = row("bad", { from: { name: "Shop", address: "shop@gmail.com" }, subject: "Pay", text: "Open https://bit.ly/q when you can." });
    const filed = row("filed", { folderId: "g:SPAM", text: "https://bit.ly/already" });
    useMail.setState({ emails: [clean, bad, filed] });
    await useMail.getState().sort();
    const s = useMail.getState();
    expect(s.emails.map((e) => [e.id, e.folderId])).toEqual([
      ["clean", "g:INBOX"],
      ["bad", "g:INBOX"],
      ["filed", "g:SPAM"],
    ]);
    expect(moves).toEqual([]);
    expect(s.ropelineFlags.clean?.flagged).toBe(false);
    expect(s.ropelineFlags.bad?.flagged).toBe(true);
    expect(s.ropelineFlags.bad?.signals.some((x) => x.kind === "shortener")).toBe(true);
    expect(s.ropelineFlags.filed).toBeUndefined();
    expect(snapshot(s).ropelineFlags.bad?.flagged).toBe(true);
  });
});
