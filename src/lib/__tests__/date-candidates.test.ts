import { describe, expect, it } from "vitest";
import { isDateCandidate } from "@/lib/date-candidates";
import type { Email } from "@/lib/types";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const mail = (o: Partial<Email> = {}): Email =>
  ({ id: "e", accountId: "a", threadId: "e", folderId: "f", from: { name: "A", address: "Bills@Bank.com" }, to: [], subject: "Statement", snippet: "", text: "Payment due October 18", date: "2026-10-09T00:00:00Z", unread: false, starred: false, labels: [], ...o }) as Email;
const ctx = (o = {}) => ({ inbox: true, category: "transactions" as const, section: null, noDateSenders: {}, everywhere: true, now: NOW, ...o });

describe("isDateCandidate", () => {
  it("accepts recent inbox mail that mentions a date", () => {
    expect(isDateCandidate(mail(), ctx())).toBe(true);
  });
  it("waits for mail that isn't sorted yet", () => {
    expect(isDateCandidate(mail(), ctx({ category: undefined }))).toBe(false);
  });
  it("skips promotions and newsletters", () => {
    expect(isDateCandidate(mail(), ctx({ category: "promotions" }))).toBe(false);
    expect(isDateCandidate(mail(), ctx({ category: "newsletters" }))).toBe(false);
  });
  it("skips senders the user turned off (case-insensitive, own keys only)", () => {
    expect(isDateCandidate(mail(), ctx({ noDateSenders: { "bills@bank.com": true } }))).toBe(false);
    expect(isDateCandidate(mail({ from: { name: "A", address: "constructor" } }), ctx())).toBe(true);
  });
  it("skips old mail, mail with no date, non-inbox, partial, and everywhere off", () => {
    expect(isDateCandidate(mail({ date: "2026-08-01T00:00:00Z" }), ctx())).toBe(false);
    expect(isDateCandidate(mail({ text: "Thanks for being a customer." }), ctx())).toBe(false);
    expect(isDateCandidate(mail(), ctx({ inbox: false }))).toBe(false);
    expect(isDateCandidate(mail({ partial: true }), ctx())).toBe(false);
    expect(isDateCandidate(mail(), ctx({ everywhere: false }))).toBe(false);
  });
  it("includes section mail with dates on up to 90 days old, even with no mention, and never dates off", () => {
    const older = mail({ date: "2026-08-01T00:00:00Z", text: "Hello" }); // 71 days: past 30, inside 90
    expect(isDateCandidate(older, ctx({ section: { dates: true }, everywhere: false, category: "promotions" }))).toBe(true);
    expect(isDateCandidate(older, ctx({ section: { dates: true }, everywhere: false, category: undefined }))).toBe(true);
    expect(isDateCandidate(mail(), ctx({ section: { dates: false } }))).toBe(false);
    expect(isDateCandidate(mail(), ctx({ section: {} }))).toBe(false);
    expect(isDateCandidate(mail({ partial: true }), ctx({ section: { dates: true } }))).toBe(false);
  });
  it("caps section mail at 90 days and skips it when the date is unparsable", () => {
    const sec = ctx({ section: { dates: true }, everywhere: false });
    expect(isDateCandidate(mail({ date: "2026-07-01T00:00:00Z" }), sec)).toBe(false); // 102 days
    expect(isDateCandidate(mail({ date: "not a date" }), sec)).toBe(false);
  });
  it("skips section mail from senders the user turned off", () => {
    const sec = ctx({ section: { dates: true }, noDateSenders: { "bills@bank.com": true } });
    expect(isDateCandidate(mail(), sec)).toBe(false);
    expect(isDateCandidate(mail({ from: { name: "A", address: "constructor" } }), ctx({ section: { dates: true } }))).toBe(true);
  });
});
