// @vitest-environment jsdom
// Calendar suggestions from mail don't keep coming back: answered once per thread, past times
// dropped, older proposals superseded, and anything already on the calendar left out.
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

import { inboxSuggestions, type SuggestionSel } from "@/lib/store";
import type { CalEvent, Email } from "@/lib/types";
import type { DateFind } from "@/lib/ai/dates";

const NOW = new Date(2026, 9, 13, 21, 0); // Tue Oct 13, 9 PM
const mail = (id: string, thread: string, date: string): Email =>
  ({ id, accountId: "a", threadId: thread, folderId: "a:INBOX", from: { name: "Ravi", address: "r@x.com" }, to: [], subject: "Migration", snippet: "", text: "", date, unread: true, starred: false }) as unknown as Email;
const find = (title: string, date: string, time?: string): DateFind => ({ title, date, ...(time ? { time } : {}), kind: "event", quote: "" });

function base(over: Partial<SuggestionSel> = {}): SuggestionSel {
  return {
    calSuggestions: [],
    dateFinds: {},
    noDateSenders: {},
    emails: [],
    folders: [{ id: "a:INBOX", accountId: "a", name: "Inbox", system: "inbox" }],
    triage: {},
    categoryOverrides: {},
    sections: [],
    sectionOverrides: {},
    calChanges: { added: [], deleted: [], resolved: [] },
    calendars: [{ id: "a:cal", accountId: "a", name: "Calendar", source: "google", hue: 1, primary: true }],
    hiddenCalendars: new Set(),
    accounts: [{ id: "a", kind: "gmail", name: "G", address: "me@x.com" }],
    events: [],
    ...over,
  } as SuggestionSel;
}

describe("inboxSuggestions", () => {
  const older = mail("m1", "t1", "2026-10-12T15:00:00Z");
  const newer = mail("m2", "t1", "2026-10-12T18:00:00Z");
  const titles = (s: SuggestionSel) => inboxSuggestions(s, true, NOW).map((x) => x.title);

  it("drops a time that has already passed today", () => {
    expect(titles(base({ emails: [newer], dateFinds: { m2: [find("Call", "2026-10-13", "11:00")] } }))).toEqual([]);
    expect(titles(base({ emails: [newer], dateFinds: { m2: [find("Call", "2026-10-14", "11:00")] } }))).toEqual(["Call"]);
  });

  it("answering one copy in a thread covers the others on that date", () => {
    const s = base({
      emails: [older, newer],
      dateFinds: { m1: [find("Meeting with Alex", "2026-10-15", "11:00")], m2: [find("Meeting with Ravi", "2026-10-15", "11:00")] },
    });
    const ids = inboxSuggestions(s, true, NOW).map((x) => x.id);
    expect(ids).toHaveLength(2);
    const resolved = [ids.find((id) => id.includes("m2"))!];
    expect(titles({ ...s, calChanges: { added: [], deleted: [], resolved } })).toEqual([]);
  });

  it("an older proposal in a thread you already answered stops showing", () => {
    const s = base({
      emails: [older, newer],
      dateFinds: { m1: [find("Meet tomorrow at 9", "2026-10-16", "09:00")], m2: [find("Meeting", "2026-10-15", "11:00")] },
    });
    const id = inboxSuggestions(s, true, NOW).find((x) => x.emailId === "m2")!.id;
    expect(titles({ ...s, calChanges: { added: [], deleted: [], resolved: [id] } })).toEqual([]);
  });

  it("leaves out what's already on the calendar at that time with a shared word", () => {
    const ev = { id: "e", calendarId: "a:cal", title: "TRAIL workshop", start: new Date(2026, 9, 15, 13, 5).toISOString(), end: new Date(2026, 9, 15, 14).toISOString(), attendees: [] } as CalEvent;
    const s = base({ emails: [newer], events: [ev], dateFinds: { m2: [find("TRAIL Workshop (Room 232)", "2026-10-15", "13:00"), find("Dentist", "2026-10-15", "13:00")] } });
    expect(titles(s)).toEqual(["Dentist"]);
  });
});
