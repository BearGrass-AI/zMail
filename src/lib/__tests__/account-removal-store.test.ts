// @vitest-environment jsdom
// Removing an account while its sync is still running: nothing the sync brings back may land.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarInfo, Email, Folder, Triage } from "@/lib/types";
import type { SyncChanges } from "@/lib/mail/provider";
import type { CalendarProvider } from "@/lib/calendar/provider";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const outlook = { id: "m", kind: "m365" as const, name: "M365", address: "z@example.org" };
const foldersOf = (acc: string): Folder[] => [
  { id: `${acc}:INBOX`, accountId: acc, name: "Inbox", system: "inbox" },
  { id: `${acc}:TRASH`, accountId: acc, name: "Trash", system: "trash" },
];
const row = (id: string, date: string, acc = "g") =>
  ({ id, accountId: acc, threadId: id, folderId: `${acc}:INBOX`, from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date, unread: true, starred: false, labels: ["INBOX"] }) as Email;

/** What each account's cache holds. */
const disk = new Map<string, Email[]>();
/** The next syncChanges() result per account. */
const next = new Map<string, SyncChanges>();
/** While set, syncChanges() and listMessages() wait on it before answering. */
let held: Promise<void> | null = null;
const ok = async () => ({ skipped: [], failed: [] });

function fakeFor(account: typeof gmail | typeof outlook) {
  return {
    account,
    batchSize: 50,
    listFolders: async () => foldersOf(account.id),
    listMessages: async () => {
      if (held) await held;
      return disk.get(account.id) ?? [];
    },
    // Only Gmail reports deltas here, so Outlook goes through syncMail.
    ...(account.id === "g"
      ? {
          syncChanges: async () => {
            if (held) await held;
            return next.get(account.id) ?? { full: false, changed: [], removed: [] };
          },
        }
      : {}),
    batchMove: ok,
    batchSetRead: ok,
    batchSetStarred: ok,
  };
}

/** Calendar providers by account (none unless a test sets one), and the ranges each was asked for. */
const calFakes = new Map<string, CalendarProvider>();
const calAsks: string[] = [];
function calFake(accountId: string): CalendarProvider {
  const no = async () => {
    throw new Error("not in this test");
  };
  return {
    accountId,
    nativeVideo: [],
    listCalendars: async (): Promise<CalendarInfo[]> => [{ id: `${accountId}:c`, accountId, name: "Cal", source: "google", hue: 1 }],
    listEvents: async (_ids: string[], from: Date, to: Date) => {
      calAsks.push(`${accountId} ${from.toDateString()}-${to.toDateString()}`);
      return [];
    },
    createEvent: no,
    respond: no,
    deleteEvent: no,
  };
}

let accounts: (typeof gmail | typeof outlook)[] = [gmail];
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => accounts,
  saveRegistry: async () => {},
  calendarProviderFor: (a: typeof gmail) => calFakes.get(a.id) ?? null,
  mailProviderFor: (a: typeof gmail) => fakeFor(a),
}));
const kv = new Map<string, unknown>();
vi.mock("@/lib/db", () => ({
  kvGet: async (k: string) => kv.get(k) ?? null,
  kvSet: async (k: string, v: unknown) => void kv.set(k, v),
  cacheListFolders: async (acc: string) => foldersOf(acc).map((f) => JSON.stringify(f)),
  cacheListMessages: async (acc: string) => (disk.get(acc) ?? []).map((e) => ({ id: e.id, folder_id: e.folderId, date: e.date, json: JSON.stringify(e) })),
  cachePutMessages: async () => {},
  cacheDeleteAccount: async (acc: string) => {
    const ids = (disk.get(acc) ?? []).map((e) => e.id);
    disk.delete(acc);
    return ids;
  },
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));

let store: typeof import("@/lib/store");
const state = () => store.useMail.getState();
const listeners: [string, EventListenerOrEventListenerObject][] = [];

async function settle() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(100);
}

async function start() {
  const loading = state().load();
  await settle();
  await loading;
}

/** Hold the providers' answers until the returned function is called. */
function hold() {
  let release = () => {};
  held = new Promise<void>((r) => (release = r));
  return () => {
    held = null;
    release();
  };
}

const rowsOf = (acc: string) => ({
  emails: state().emails.filter((e) => e.accountId === acc).map((e) => e.id),
  folders: state().folders.filter((f) => f.accountId === acc).map((f) => f.id),
});

beforeEach(async () => {
  vi.useFakeTimers();
  kv.clear();
  disk.clear();
  next.clear();
  held = null;
  accounts = [gmail];
  calFakes.clear();
  calAsks.length = 0;
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

describe("removing an account mid-sync", () => {
  it("a refresh that answers after the account is removed doesn't bring its mail back", async () => {
    disk.set("g", [row("g1", "2026-10-10T00:00:00Z")]);
    await start();
    expect(rowsOf("g").emails).toEqual(["g1"]);
    const release = hold();
    next.set("g", { full: false, changed: [row("g2", "2026-10-11T00:00:00Z")], removed: [] });
    const refreshing = state().refresh();
    await settle();
    await state().removeAccount("g");
    release();
    await settle();
    await refreshing;
    expect(rowsOf("g")).toEqual({ emails: [], folders: [] });
  });

  it("a full re-sync that answers after removal doesn't bring the cached mail back", async () => {
    disk.set("g", [row("g1", "2026-10-10T00:00:00Z")]);
    await start();
    const release = hold();
    next.set("g", { full: true });
    const refreshing = state().refresh();
    await settle();
    await state().removeAccount("g");
    release();
    await settle();
    await refreshing;
    expect(rowsOf("g")).toEqual({ emails: [], folders: [] });
  });

  it("mail a sync wrote to the cache after removal is deleted again, and the account's status doesn't come back", async () => {
    accounts = [gmail, outlook];
    disk.set("g", [row("g1", "2026-10-10T00:00:00Z")]);
    disk.set("m", [row("m1", "2026-10-09T00:00:00Z", "m")]);
    await start();
    const release = hold();
    const refreshing = state().refresh();
    await settle();
    await state().removeAccount("g");
    await state().removeAccount("m");
    // The providers' syncs, still under way, write to the cache after removeAccount cleared it.
    disk.set("g", [row("g2", "2026-10-11T00:00:00Z")]);
    disk.set("m", [row("m2", "2026-10-11T00:00:00Z", "m")]);
    release();
    await settle();
    await refreshing;
    expect(disk.has("g")).toBe(false);
    expect(disk.has("m")).toBe(false);
    expect(rowsOf("m")).toEqual({ emails: [], folders: [] });
    expect(state().accountStatus).toEqual({});
  });

  it("an account removed while it's being added doesn't come back when its first sync finishes", async () => {
    await start();
    disk.set("m", [row("m1", "2026-10-10T00:00:00Z", "m")]);
    const release = hold();
    const adding = state().addAccount(outlook);
    await settle();
    await state().removeAccount("m");
    release();
    await settle();
    await adding;
    expect(rowsOf("m")).toEqual({ emails: [], folders: [] });
    expect(state().accounts.map((a) => a.id)).toEqual(["g"]);
  });
});

describe("calendar weeks loaded on demand", () => {
  it("an added account's events are fetched for weeks already loaded for the others", async () => {
    vi.setSystemTime(new Date("2026-10-13T12:00:00"));
    calFakes.set("g", calFake("g"));
    calFakes.set("m", calFake("m"));
    await start();
    // A far week, loaded for Gmail.
    const week = [new Date(2026, 11, 2), new Date(2026, 11, 3)] as const;
    expect(await store.ensureEventRange(...week)).toBe(true);
    expect(calAsks.filter((a) => a.includes("Dec 06"))).toEqual(["g Sun Nov 29 2026-Sun Dec 06 2026"]);
    await state().addAccount(outlook);
    await settle();
    calAsks.length = 0;
    expect(await store.ensureEventRange(...week)).toBe(true);
    expect(calAsks).toContain("m Sun Nov 29 2026-Sun Dec 06 2026");
  });
});

describe("removing an account", () => {
  const sorted = (emailId: string): Triage => ({
    emailId,
    bucket: "worth_skim",
    bucketProbs: { needs_you: 0, worth_skim: 1, ready_archive: 0 },
    category: "updates",
    urgency: 0,
    needsReply: 0,
    model: "fake",
  });

  it("deletes its cached mail and drops its sorting and Needs-you results, keeping other accounts'", async () => {
    accounts = [gmail, outlook];
    disk.set("g", [row("g1", "2026-10-10T00:00:00Z")]);
    disk.set("m", [row("m1", "2026-10-09T00:00:00Z", "m")]);
    await start();
    // g0 is cached but not loaded (older than what's listed).
    disk.set("g", [...disk.get("g")!, row("g0", "2026-01-01T00:00:00Z")]);
    store.useMail.setState({
      triage: { g1: sorted("g1"), g0: sorted("g0"), m1: sorted("m1") },
      resolved: { g1: { at: 1, why: "done" }, g0: { at: 1, why: "aged" }, m1: { at: 1, why: "replied" } },
    });
    await state().removeAccount("g");
    expect(disk.has("g")).toBe(false);
    expect(Object.keys(state().triage)).toEqual(["m1"]);
    expect(Object.keys(state().resolved)).toEqual(["m1"]);
    expect(rowsOf("m").emails).toEqual(["m1"]);
  });
});
