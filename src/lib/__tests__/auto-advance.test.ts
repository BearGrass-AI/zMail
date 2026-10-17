// @vitest-environment jsdom
// Acting on the open email opens the next one in on-screen order (or the previous, or none).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:ARCHIVE", accountId: "g", name: "All Mail", system: "archive" },
  { id: "g:TRASH", accountId: "g", name: "Trash", system: "trash" },
];
const row = (id: string, over: Partial<Email> = {}) =>
  ({ id, accountId: "g", threadId: id, folderId: "g:INBOX", from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date: "2026-01-01T00:00:00Z", unread: false, starred: false, labels: ["INBOX"], ...over }) as Email;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
type Outcome = { skipped: string[]; failed: string[] };

const calls: { kind: string; ids: string[]; value: unknown; reply: ReturnType<typeof deferred<Outcome>> }[] = [];
const call = (kind: string, ids: string[], value: unknown) => {
  const reply = deferred<Outcome>();
  calls.push({ kind, ids, value, reply });
  return reply.promise;
};
const fake = {
  account: gmail,
  batchSize: 50,
  listFolders: async () => folders,
  listMessages: async () => [] as Email[],
  batchMove: (es: Email[], folderId: string) => call("move", es.map((e) => e.id), folderId),
  batchSetRead: (ids: string[], read: boolean) => call("read", ids, read),
  batchSetStarred: (ids: string[], starred: boolean) => call("star", ids, starred),
  getMessage: async (id: string) => row(id),
};

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "g", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: () => fake,
}));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ai/triage")>()), triageAll: async () => ({ done: 0, failed: 0 }) }));
vi.mock("sonner", () => {
  const t = () => 1;
  t.error = t;
  t.success = t;
  return { toast: t };
});

const { useMail, nextAfterRemoval } = await import("@/lib/store");
const flush = () => new Promise((r) => setTimeout(r, 0));

// Descending dates so on-screen order is a, b, c.
const inbox = (unreadIds: string[] = []) => [
  row("a", { date: "2026-01-03T00:00:00Z", unread: unreadIds.includes("a") }),
  row("b", { date: "2026-01-02T00:00:00Z", unread: unreadIds.includes("b") }),
  row("c", { date: "2026-01-01T00:00:00Z", unread: unreadIds.includes("c") }),
];
const selected = () => useMail.getState().selectedId;

afterEach(async () => {
  // Let every pending fake server call finish so no email stays "on its way" into the next test.
  for (const c of calls) c.reply.resolve({ skipped: [], failed: [] });
  await flush();
});

beforeEach(async () => {
  if (!useMail.getState().accounts.length) await useMail.getState().load();
  calls.length = 0;
  useMail.setState({ folders, view: { kind: "inbox" }, emails: inbox(), selectedId: "b", checked: new Set(), snoozed: {} });
});

describe("nextAfterRemoval", () => {
  it("picks the next, else the previous, else nothing", () => {
    expect(nextAfterRemoval(["a", "b", "c"], new Set(["a", "c"]), "b")).toBe("c");
    expect(nextAfterRemoval(["a", "b", "c"], new Set(["a", "b"]), "c")).toBe("b");
    expect(nextAfterRemoval(["a", "b", "c"], new Set(), "b")).toBeNull();
  });
});

describe("acting on the open email", () => {
  it("opens the next one at once, before the server answers", () => {
    void useMail.getState().archive(["b"]);
    expect(selected()).toBe("c");
  });

  it("opens the previous one when the last was acted on", () => {
    useMail.setState({ selectedId: "c" });
    void useMail.getState().archive(["c"]);
    expect(selected()).toBe("b");
  });

  it("closes the reader when nothing is left", () => {
    useMail.setState({ emails: [row("b")] });
    void useMail.getState().archive(["b"]);
    expect(selected()).toBeNull();
  });

  it("skips other emails archived in the same go", () => {
    useMail.setState({ checked: new Set(["a", "b"]) });
    void useMail.getState().archive(["a", "b"]);
    expect(selected()).toBe("c");
  });

  it("stays put when the email still shows in the view", () => {
    useMail.setState({ view: { kind: "starred" }, emails: inbox().map((e) => ({ ...e, starred: true })) });
    void useMail.getState().move(["b"], "g:ARCHIVE");
    expect(selected()).toBe("b");
  });

  it("does not go back to a refused email", async () => {
    const done = useMail.getState().move(["b"], "g:ARCHIVE");
    expect(selected()).toBe("c");
    await flush();
    calls[0].reply.resolve({ skipped: [], failed: ["b"] });
    await done;
    expect(useMail.getState().emails.find((e) => e.id === "b")!.folderId).toBe("g:INBOX");
    expect(selected()).toBe("c");
  });

  it("opens the next one when the open email is snoozed", () => {
    useMail.getState().snooze(["b"], Date.now() + 3_600_000);
    expect(selected()).toBe("c");
  });

  it("marks the newly opened unread email read", async () => {
    useMail.setState({ emails: inbox(["c"]) });
    void useMail.getState().archive(["b"]);
    await flush();
    const reads = calls.filter((c) => c.kind === "read");
    expect(reads).toHaveLength(1);
    expect(reads[0].ids).toEqual(["c"]);
    expect(reads[0].value).toBe(true);
  });
});
