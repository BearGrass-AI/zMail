// @vitest-environment jsdom
// startNotifications at launch: a banner click that launched zMail opens its email, and
// banners left from earlier sessions are taken back once their email no longer needs you.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder, Triage } from "@/lib/types";

const h = vi.hoisted(() => ({
  pending: null as { id: string; emailId?: string | null; accountId?: string | null } | null,
  delivered: [] as string[],
  remove: vi.fn(async (_ids: string[]) => {}),
  take: vi.fn(),
  tauri: false,
  badge: vi.fn(async (_n?: number) => {}),
}));
vi.mock("@/lib/notify-native", () => ({
  notifyStatus: async () => "authorized",
  notifyShow: async () => {},
  notifyRemove: h.remove,
  notifyDelivered: async () => h.delivered,
  notifyTakePending: h.take,
  onNotificationOpen: async () => () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => h.tauri, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: h.badge }) }));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));

const { useMail } = await import("@/lib/store");
const { badgeCount, resetNotifications, startNotifications } = await import("@/lib/notifications");
const { useSettings } = await import("@/lib/settings");

const folders: Folder[] = [{ id: "a:inbox", accountId: "a", name: "Inbox", system: "inbox" }];
const mail = (id: string, over: Partial<Email> = {}) =>
  ({
    id,
    accountId: "a",
    threadId: id,
    folderId: "a:inbox",
    from: { name: `Sender ${id}`, address: `${id}@example.com` },
    to: [],
    subject: `Subject ${id}`,
    snippet: "",
    text: "",
    // Days old: a banner from an earlier session is still wanted while its email needs you.
    date: "2026-10-01T09:00:00Z",
    unread: true,
    starred: false,
    labels: [],
    ...over,
  }) as Email;
const needs = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { emailId: id, bucket: "needs_you" } as Triage]));

beforeEach(() => {
  resetNotifications();
  h.pending = null;
  h.delivered = [];
  h.remove.mockClear();
  h.take.mockReset();
  h.take.mockImplementation(async () => {
    const p = h.pending;
    h.pending = null;
    return p;
  });
  useMail.setState({ emails: [], folders, triage: {}, overrides: {}, snoozed: {}, accounts: [], selectedId: null, compose: null, composeDirty: false });
});

afterEach(() => {
  resetNotifications();
  h.tauri = false;
});

describe("startNotifications at launch", () => {
  it("opens the email of a click that launched zMail", async () => {
    useMail.setState({ emails: [mail("e1", { unread: false })], triage: needs("e1") });
    h.pending = { id: "e1", emailId: "e1", accountId: "a" };
    await startNotifications();
    await vi.waitFor(() => expect(useMail.getState().selectedId).toBe("e1"));
    expect(useMail.getState().view).toEqual({ kind: "inbox" });
    expect(h.pending).toBeNull();
  });

  it("opens nothing when no click is pending", async () => {
    useMail.setState({ emails: [mail("e1", { unread: false })], triage: needs("e1") });
    await startNotifications();
    expect(h.take).toHaveBeenCalledTimes(1);
    expect(useMail.getState().selectedId).toBeNull();
  });

  it("takes back earlier sessions' banners whose email is read, gone or old summaries", async () => {
    useMail.setState({ emails: [mail("read", { unread: false }), mail("waiting")], triage: needs("read", "waiting") });
    h.delivered = ["read", "waiting", "gone", "summary-1", `summary-${Date.now() + 60_000}`, "test-1"];
    await startNotifications();
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.remove).toHaveBeenCalledWith(["read", "gone", "summary-1"]);

    // The one still waiting is watched like this session's: reading it takes its banner back.
    useMail.setState({ emails: [mail("read", { unread: false }), mail("waiting", { unread: false })] });
    expect(h.remove).toHaveBeenLastCalledWith(["waiting"]);
  });

  it("keeps the dock number equal to badgeCount as mail changes", async () => {
    // Only the dock badge path asks isTauri here; the native notification calls are mocked.
    h.tauri = true;
    h.badge.mockClear();
    useMail.setState({ emails: [mail("e1"), mail("e2")], triage: needs("e1", "e2") });
    await startNotifications();
    const expected = () => badgeCount(useMail.getState(), useSettings.getState().notifications.badge);
    expect(h.badge).toHaveBeenLastCalledWith(expected());
    useMail.setState({ emails: [mail("e1"), mail("e2", { unread: false }), mail("e3")], triage: needs("e1", "e2", "e3") });
    expect(h.badge).toHaveBeenLastCalledWith(expected());
    useMail.setState({ emails: [mail("e1", { unread: false })] });
    expect(expected()).toBeUndefined();
    expect(h.badge).toHaveBeenLastCalledWith(undefined);
  });

  it("removes nothing when Notification Center is empty", async () => {
    useMail.setState({ emails: [mail("e1")], triage: needs("e1") });
    await startNotifications();
    expect(h.remove).not.toHaveBeenCalled();
  });
});
