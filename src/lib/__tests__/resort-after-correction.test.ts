// @vitest-environment jsdom
// A correction re-sorts the same sender's other inbox mail, so what you taught shows at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

import type { Email, Folder } from "@/lib/types";
import { useMail } from "@/lib/store";

const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:ARCHIVE", accountId: "g", name: "All Mail", system: "archive" },
];
const mail = (id: string, from: string, day: number, folderId = "g:INBOX") =>
  ({ id, accountId: "g", threadId: id, folderId, from: { name: "News Desk", address: from }, to: [], subject: id, snippet: "", text: "", date: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`, unread: true, starred: false, labels: [] }) as Email;

const sort = vi.fn(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
  sort.mockClear();
  useMail.setState({
    folders,
    emails: [mail("a1", "news@x.com", 1), mail("a2", "News@X.com", 2), mail("a3", "news@x.com", 3), mail("old", "news@x.com", 4, "g:ARCHIVE"), mail("b1", "b@y.com", 5)],
    sort,
  });
});
afterEach(() => vi.useRealTimers());

describe("re-sorting after a correction", () => {
  it("re-sorts the sender's other inbox mail, newest first, once the corrections settle", () => {
    expect(useMail.getState().resortSendersOf(["a1"])).toBe(2);
    expect(sort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1200);
    expect(sort).toHaveBeenCalledExactlyOnceWith({ ids: ["a3", "a2"] });
  });

  it("folds quick corrections into one sort and leaves every corrected email out", () => {
    useMail.getState().resortSendersOf(["a1"]);
    vi.advanceTimersByTime(600);
    useMail.getState().resortSendersOf(["a2"]);
    vi.advanceTimersByTime(1200);
    expect(sort).toHaveBeenCalledExactlyOnceWith({ ids: ["a3"] });
  });

  it("skips mail that left the inbox while it waited", () => {
    useMail.getState().resortSendersOf(["a1"]);
    useMail.setState((s) => ({ emails: s.emails.map((e) => (e.id === "a3" ? { ...e, folderId: "g:ARCHIVE" } : e)) }));
    vi.advanceTimersByTime(1200);
    expect(sort).toHaveBeenCalledExactlyOnceWith({ ids: ["a2"] });
  });

  it("does nothing when the sender has no other inbox mail", () => {
    expect(useMail.getState().resortSendersOf(["b1"])).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(sort).not.toHaveBeenCalled();
  });

  it("re-sorts at most the newest 25 per sender", () => {
    useMail.setState({ emails: Array.from({ length: 40 }, (_, i) => mail(`n${i}`, "news@x.com", 1 + (i % 28))) });
    expect(useMail.getState().resortSendersOf(["n0"])).toBe(25);
  });
});
