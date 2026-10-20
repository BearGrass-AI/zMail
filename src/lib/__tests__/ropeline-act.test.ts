// @vitest-environment jsdom
// Confident spam moves to Spam only when the user turns that on. Undo puts it back. Trash is not used.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";
import { confidentSpamIds, SPAM_REASON } from "@/lib/ropeline-act";
import { flagFor } from "@/lib/ropeline";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@acmeplumbing.example" };
const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:SPAM", accountId: "g", name: "Spam", system: "spam" },
  { id: "g:TRASH", accountId: "g", name: "Trash", system: "trash" },
];
const row = (id: string, over: Partial<Email> = {}): Email =>
  ({
    id,
    accountId: "g",
    threadId: id,
    folderId: "g:INBOX",
    from: { name: "Pat Example", address: "pat@example.com" },
    to: [],
    subject: "Hello there",
    snippet: "",
    text: "A plain note with enough words to be a real message for the reader today.",
    date: "2026-10-18T00:00:00Z",
    unread: true,
    starred: false,
    labels: ["INBOX"],
    ...over,
  }) as Email;

const moves: { ids: string[]; folderId: string }[] = [];
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));
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
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => null,
  mailProviderFor: () => ({
    account: gmail,
    batchSize: 20,
    listFolders: async () => folders,
    listMessages: async () => [],
    batchMove: async (emails: Email[], folderId: string) => {
      moves.push({ ids: emails.map((e) => e.id), folderId });
      return { skipped: [], failed: [] };
    },
    batchSetRead: async () => ({ skipped: [], failed: [] }),
    batchSetStarred: async () => ({ skipped: [], failed: [] }),
  }),
}));
vi.mock("@/lib/ai/triage", () => ({
  triageAll: async () => ({ done: 0, failed: 0 }),
  consistentBucket: (t: { bucket: string }) => t.bucket,
}));

const { useMail } = await import("@/lib/store");
const { useSettings } = await import("@/lib/settings");

beforeEach(async () => {
  moves.length = 0;
  toastMock.mockClear();
  useSettings.setState({ ropeLineAct: false, ropeLineHosted: false, ropeLineHostedUrl: "" });
  if (!useMail.getState().accounts.length) await useMail.getState().load();
  useMail.setState({ folders, emails: [], triage: {}, ropelineFlags: {}, autoRules: [] });
});

describe("acting on a verdict", () => {
  it("moves nothing unless the user turns it on, and never treats unsure as spam", () => {
    const spam = row("s");
    const unsure = row("u");
    const flags = {
      s: { ...flagFor(spam, []), verdict: "spam" as const },
      u: { ...flagFor(unsure, []), verdict: "unsure" as const },
    };
    const inbox = new Set(["g:INBOX"]);
    expect(confidentSpamIds([spam, unsure], flags, inbox, false)).toEqual([]);
    expect(confidentSpamIds([spam, unsure], flags, inbox, true)).toEqual(["s"]);
  });

  it("moves confident spam to Spam, shows the reason, and Undo puts it back", async () => {
    const spam = row("s", { from: { name: "Shop", address: "shop@gmail.com" }, subject: "Pay", text: "Open https://bit.ly/q when you can please." });
    const plain = row("p");
    const flagged = { ...flagFor(spam, []), verdict: "spam" as const };
    useSettings.setState({ ropeLineAct: true });
    useMail.setState({ emails: [spam, plain], ropelineFlags: { s: flagged } });
    await useMail.getState().sort();
    expect(moves).toEqual([{ ids: ["s"], folderId: "g:SPAM" }]);
    expect(moves.some((m) => m.folderId === "g:TRASH")).toBe(false);
    expect(useMail.getState().emails.find((e) => e.id === "s")?.folderId).toBe("g:SPAM");
    expect(useMail.getState().emails.find((e) => e.id === "p")?.folderId).toBe("g:INBOX");
    expect(useMail.getState().ropelineFlags.s?.reason).toBe(SPAM_REASON);
    expect(toastMock).toHaveBeenCalled();
    const note = toastMock.mock.calls.find((c) => String(c[0]).includes("RopeLine"));
    expect(note?.[1].description).toBe(SPAM_REASON);
    moves.length = 0;
    note?.[1].action.onClick();
    await vi.waitFor(() => expect(moves).toEqual([{ ids: ["s"], folderId: "g:INBOX" }]));
  });

  it("leaves a spam verdict in the inbox while acting is off", async () => {
    const spam = row("s2");
    useMail.setState({ emails: [spam], ropelineFlags: { s2: { ...flagFor(spam, []), verdict: "spam" } } });
    await useMail.getState().sort();
    expect(moves).toEqual([]);
    expect(useMail.getState().emails[0].folderId).toBe("g:INBOX");
  });
});
