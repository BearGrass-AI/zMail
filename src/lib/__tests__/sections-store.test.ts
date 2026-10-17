// @vitest-environment jsdom
// Sections in the store: what gets sent to which model, archiving into the
// section's label, and adding found dates to a real calendar.
import { describe, expect, it, vi } from "vitest";
import type { CalEvent, Email, Folder, Triage } from "@/lib/types";
import type { NewEvent } from "@/lib/calendar/provider";
import { localDate } from "@/lib/ai/dates";

const acct = { id: "p", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const inbox: Folder = { id: "p:INBOX", accountId: "p", name: "Inbox", system: "inbox" };
const archive: Folder = { id: "p:ARCHIVE", accountId: "p", name: "All Mail", system: "archive" };
const billsLabel: Folder = { id: "p:Label_1", accountId: "p", name: "Bills" };
const mail = (id: string, text = ""): Email =>
  ({ id, accountId: "p", threadId: id, folderId: inbox.id, from: { name: "A", address: `${id}@x.com` }, to: [], subject: id, snippet: "", text, date: "2026-10-09T00:00:00Z", unread: false, starred: false, labels: [] }) as unknown as Email;

const moves: [string, string][] = [];
const sentToDecision: string[][] = [];
const hints: unknown[] = [];
const sentToWriter: string[] = [];
const created: NewEvent[] = [];

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [acct],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({
    accountId: "p",
    nativeVideo: [],
    listCalendars: async () => [{ id: "p:primary", accountId: "p", name: "z@gmail.com", source: "google", hue: 200 }],
    listEvents: async () => [],
    createEvent: async (e: NewEvent): Promise<CalEvent> => {
      created.push(e);
      return { id: "ev1", calendarId: e.calendarId, title: e.title, start: e.start, end: e.end, allDay: e.allDay, attendees: [] };
    },
  }),
  mailProviderFor: () => ({
    account: acct,
    listFolders: async () => [inbox, archive, billsLabel],
    listMessages: async () => [mail("bill", "Payment due soon."), mail("note")],
    batchSize: 100,
    batchMove: async (es: Email[], folderId: string) => {
      for (const e of es) moves.push([e.id, folderId]);
      return { skipped: [], failed: [] };
    },
  }),
}));
vi.mock("@/lib/db", () => ({
  kvGet: async () => null,
  kvSet: async () => {},
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({
  triageAll: async (_p: unknown, emails: Email[], ctx: { sections?: { id: string }[]; examples?: Map<string, unknown> }, onResult: (t: Triage) => void) => {
    sentToDecision.push(emails.map((e) => e.id));
    hints.push(ctx.examples && Object.fromEntries(ctx.examples));
    const { sectionsKey } = await import("@/lib/sections");
    for (const e of emails)
      onResult({
        emailId: e.id,
        bucket: "worth_skim",
        category: "updates",
        urgency: 0,
        section: e.id === "bill" ? ctx.sections?.[0]?.id : undefined,
        sectionsKey: sectionsKey((ctx.sections ?? []) as never, e.accountId) || undefined,
        model: "jev",
      } as unknown as Triage);
    return { done: emails.length, failed: 0 };
  },
}));
vi.mock("@/lib/ai/dates", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/dates")>()),
  extractDates: async (_p: unknown, e: Email) => {
    sentToWriter.push(e.id);
    return [{ title: "Payment due", date: localDate(new Date(Date.now() + 7 * 864e5)), kind: "due", quote: "Payment due soon." }];
  },
}));

const { useMail, inboxSuggestions } = await import("@/lib/store");

describe("sections in the store", () => {
  it("launch sorts without sections and reads no dates", async () => {
    await useMail.getState().load();
    expect(sentToDecision.map((x) => [...x].sort())).toEqual([["bill", "note"]]);
    expect(sentToWriter).toEqual([]);
  });

  it("a new section re-sorts only mail sorted before it, then reads its mail for dates once", async () => {
    const s = useMail.getState();
    s.addSection({ name: "Bills", description: "Bills", icon: "credit-card", hue: 150, folderId: billsLabel.id, accountIds: [], dates: true });
    await s.sort({ onlyNew: true });
    expect(sentToDecision.at(-1)).toEqual([]);

    await s.sort({ staleSections: true });
    expect([...sentToDecision.at(-1)!].sort()).toEqual(["bill", "note"]);
    await vi.waitFor(() => expect(sentToWriter).toEqual(["bill"]));

    await s.sort({ staleSections: true });
    expect(sentToDecision.at(-1)).toEqual([]);
    expect(sentToWriter).toEqual(["bill"]);
  });

  it("adds a found date to the real calendar as an all-day event", async () => {
    await vi.waitFor(() => expect(useMail.getState().calendars).toHaveLength(1));
    const [sug] = inboxSuggestions(useMail.getState());
    expect(sug.calendarId).toBe("p:primary");
    await useMail.getState().acceptCalSuggestion(sug.id);
    expect(created).toEqual([expect.objectContaining({ calendarId: "p:primary", title: "Payment due", allDay: true })]);
    expect(inboxSuggestions(useMail.getState())).toEqual([]);
  });

  it("re-sorts only the emails asked for, with the sender's category corrections", async () => {
    useMail.getState().setCategory(["note"], "promotions");
    await useMail.getState().sort({ ids: ["note"] });
    expect(sentToDecision.at(-1)).toEqual(["note"]);
    expect(hints.at(-1)).toEqual({ "note@x.com": { categories: [{ subject: "note", category: "promotions" }] } });
  });
  it("archiving section mail files it in the section's label; other mail archives normally", async () => {
    await useMail.getState().archive(["bill", "note"]);
    expect(moves).toEqual([
      ["bill", billsLabel.id],
      ["note", archive.id],
    ]);
  });

});
