// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { allInboxesUnread } from "@/lib/store";
import type { Account, Email, Folder } from "@/lib/types";

const acct = (id: string) => ({ id, kind: "gmail", name: id, address: `${id}@x.com` }) as Account;
const inbox = (accountId: string, unread?: number): Folder => ({ id: `${accountId}:inbox`, accountId, name: "Inbox", system: "inbox", unread });
const mail = (id: string, accountId: string, over: Partial<Email> = {}) =>
  ({ id, accountId, folderId: `${accountId}:inbox`, unread: true, ...over }) as Email;

describe("allInboxesUnread", () => {
  it("uses the server count when it exceeds the cached unread", () => {
    const emails = [mail("1", "g"), mail("2", "g"), mail("3", "g")];
    expect(allInboxesUnread({ emails, folders: [inbox("g", 665)], accounts: [acct("g")], snoozed: {} })).toBe(665);
  });

  it("sums accounts", () => {
    const emails = [mail("1", "o"), mail("2", "o")];
    const s = { emails, folders: [inbox("g", 665), inbox("o", 1)], accounts: [acct("g"), acct("o")], snoozed: {} };
    expect(allInboxesUnread(s)).toBe(667);
  });

  it("falls back to live unread when an account has no inbox folder of its own", () => {
    // The inbox folder row isn't attributed to account h, so h uses its live unread inbox mail.
    const f = inbox("x", 9);
    const emails = [mail("1", "h", { folderId: "x:inbox" }), mail("2", "h", { folderId: "x:inbox" }), mail("3", "h", { folderId: "x:inbox", unread: false })];
    expect(allInboxesUnread({ emails, folders: [f], accounts: [acct("h")], snoozed: {} })).toBe(2);
    expect(allInboxesUnread({ emails, folders: [f], accounts: [acct("h")], snoozed: { "1": Date.now() + 1e6 } })).toBe(1);
  });

  it("follows an instant local count adjustment", () => {
    const base = { emails: [] as Email[], accounts: [acct("g")], snoozed: {} };
    expect(allInboxesUnread({ ...base, folders: [inbox("g", 665)] })).toBe(665);
    expect(allInboxesUnread({ ...base, folders: [inbox("g", 664)] })).toBe(664);
  });
});
