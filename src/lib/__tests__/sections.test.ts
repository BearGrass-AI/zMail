// @vitest-environment jsdom
// Your own sections: how they enter the sorting request, how answers map back,
// how Today groups mail, and how dates found in mail become suggestions.
import { describe, expect, it } from "vitest";
import type { Email, Folder, Triage } from "@/lib/types";
import type { MailSection } from "@/lib/sections";
import { sectionsKey } from "@/lib/sections";
import { buildRequest, triageEmail } from "@/lib/ai/triage";
import { MockDecisionProvider } from "@/lib/ai/mock-decision";
import { MockGenerativeProvider } from "@/lib/ai/mock-generative";
import { extractDates, findToSuggestion, localDate, parseDates } from "@/lib/ai/dates";
import { homeGroups, inboxSuggestions } from "@/lib/store";

const inbox: Folder = { id: "p:INBOX", accountId: "p", name: "Inbox", system: "inbox" };
const billsLabel: Folder = { id: "p:Label_bills", accountId: "p", name: "Bills" };
const bills: MailSection = {
  id: "sec-bills",
  name: "Bills",
  description: "Credit card statements, utility bills, anything saying a payment is due.",
  icon: "credit-card",
  hue: 150,
  folderId: billsLabel.id,
  accountIds: ["p"],
  dates: true,
};
const school: MailSection = { ...bills, id: "sec-school", name: "School", description: "Email from my son's teacher or school.", folderId: undefined, accountIds: [] };
const me = { name: "Alex", address: "z@gmail.com" };

const mail = (id: string, over: Partial<Email> = {}): Email =>
  ({
    id,
    accountId: "p",
    threadId: id,
    folderId: inbox.id,
    from: { name: "Chase", address: "no-reply@chase.com" },
    to: [],
    subject: "Your statement is ready",
    snippet: "",
    text: "Your credit card statement is ready. Minimum payment due October 24.",
    date: new Date().toISOString(),
    unread: true,
    starred: false,
    labels: [],
    ...over,
  }) as unknown as Email;

describe("sorting request", () => {
  it("asks which section, with your descriptions, only for sections that cover the account", () => {
    const req = buildRequest(mail("e1"), me, [inbox, billsLabel], undefined, 255, [bills, school]);
    expect(Object.keys(req.questions.section!.criteria)).toEqual(["none", "sec-bills", "sec-school"]);
    expect((req.questions.section!.criteria as Record<string, string>)["sec-bills"]).toContain("payment is due");

    const work = buildRequest(mail("e2", { accountId: "um" }), me, [], undefined, 255, [bills]);
    expect(work.questions.section).toBeUndefined();
  });

  it("tells the model how much of the sender's mail is already in the section's label", () => {
    const habit = { sender: "no-reply@chase.com", total: 9, byFolder: { [billsLabel.id]: 9 } };
    const req = buildRequest(mail("e1"), me, [inbox, billsLabel], habit, 255, [bills], { sections: { "sec-bills": ["Your statement is ready"] } });
    expect(req.state.section_history).toEqual([
      { section: "Bills", section_id: "sec-bills", sender_emails_in_it: 9, example_subjects: ["Your statement is ready"] },
    ]);
  });

  it("one sender, both ways: statements go to Bills, offers you took out stay out", async () => {
    const habit = { sender: "no-reply@chase.com", total: 4, byFolder: { [billsLabel.id]: 4 } };
    const examples = { sections: { "sec-bills": ["Your statement is ready"], none: ["Earn 5x points on travel this month"] } };
    const req = buildRequest(mail("e1"), me, [inbox, billsLabel], habit, 255, [bills], examples);
    expect(req.state.section_history).toEqual([
      { section: "Bills", section_id: "sec-bills", sender_emails_in_it: 4, example_subjects: ["Your statement is ready"] },
      { section: "none of these", section_id: "none", example_subjects: ["Earn 5x points on travel this month"] },
    ]);
    const offer = mail("e9", { subject: "Earn 5x points on dining this month", text: "Limited time offer for cardmembers." });
    expect((await triageEmail(new MockDecisionProvider(), offer, me, [inbox, billsLabel], habit, [bills], examples)).section).toBeUndefined();
    expect((await triageEmail(new MockDecisionProvider(), mail("e1"), me, [inbox, billsLabel], habit, [bills], examples)).section).toBe("sec-bills");
  });

  it("stays within small providers' option limits", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...school, id: `s${i}` }));
    const req = buildRequest(mail("e1"), me, [], undefined, 26, many);
    expect(Object.keys(req.questions.section!.criteria)).toHaveLength(26);
  });

  it("maps the answer back, with the sections it was sorted against", async () => {
    const t = await triageEmail(new MockDecisionProvider(), mail("e1"), me, [inbox, billsLabel], undefined, [bills, school]);
    expect(t.section).toBe("sec-bills");
    expect(t.sectionsKey).toBe(sectionsKey([bills, school], "p"));

    const lunch = mail("e3", { from: { name: "Jen", address: "jen@gmail.com" }, subject: "Lunch?", text: "Want to grab lunch Saturday?" });
    expect((await triageEmail(new MockDecisionProvider(), lunch, me, [inbox], undefined, [bills, school])).section).toBeUndefined();
  });
});

describe("Today grouping", () => {
  const state = (triage: Record<string, Partial<Triage>>, emails: Email[], extra: object = {}) =>
    ({
      folders: [inbox, billsLabel],
      triage: triage as Record<string, Triage>,
      overrides: {},
      rules: {},
      dismissed: new Set<string>(),
      snoozed: {},
      emails,
      query: "",
      view: { kind: "brief" as const },
      accountFilter: null,
      sections: [bills, school],
      sectionOverrides: {},
      resolved: {},
      ...extra,
    }) as Parameters<typeof homeGroups>[0];
  const sorted = {
    a: { bucket: "worth_skim", section: "sec-bills" },
    b: { bucket: "ready_archive", section: "sec-bills" },
    c: { bucket: "needs_you", section: "sec-bills", urgency: 0.9 },
    d: { bucket: "worth_skim" },
  } as const;
  const four = () => [mail("a"), mail("b"), mail("c"), mail("d")];
  const block = (g: ReturnType<typeof homeGroups>, id: string) => g.sections.find((x) => x.section.id === id)!;

  it("moves section mail out of skim and Can go; urgent mail heads its section, flagged", () => {
    const g = homeGroups(state(sorted, four()));
    expect(g.needs).toEqual([]);
    expect(block(g, "sec-bills").emails.map((e) => e.id)).toEqual(["c", "a", "b"]);
    expect([...block(g, "sec-bills").flagged]).toEqual(["c"]);
    expect(g.skim.map((e) => e.id)).toEqual(["d"]);
    expect(g.canGo).toEqual([]);
  });

  it("with the section's switch on, its urgent mail stays in Needs you", () => {
    const g = homeGroups(state(sorted, four(), { sections: [{ ...bills, urgentInNeedsYou: true }, school] }));
    expect(g.needs.map((e) => e.id)).toEqual(["c"]);
    expect(block(g, "sec-bills").emails.map((e) => e.id)).toEqual(["a", "b"]);
    expect(block(g, "sec-bills").flagged.size).toBe(0);
  });

  it("done mail leaves Needs you for its section (unflagged), or Worth a skim without one", () => {
    const g = homeGroups(
      state({ ...sorted, e: { bucket: "needs_you" } }, [...four(), mail("e")], {
        sections: [{ ...bills, urgentInNeedsYou: true }, school],
        resolved: { c: { at: 1, why: "done" }, e: { at: 1, why: "aged" } },
      }),
    );
    expect(g.needs).toEqual([]);
    expect(block(g, "sec-bills").emails.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(block(g, "sec-bills").flagged.size).toBe(0);
    expect(g.skim.map((e) => e.id)).toEqual(["d", "e"]);
  });

  it("your correction wins over the model, including 'not in a section'", () => {
    const g = homeGroups(
      state({ a: { bucket: "worth_skim", section: "sec-bills" }, d: { bucket: "worth_skim" } }, [mail("a"), mail("d")], {
        sectionOverrides: { a: null, d: "sec-school" },
      }),
    );
    expect(g.skim.map((e) => e.id)).toEqual(["a"]);
    expect(g.sections.find((x) => x.section.id === "sec-school")!.emails.map((e) => e.id)).toEqual(["d"]);
  });

  it("a deleted section's mail falls back to its bucket", () => {
    const g = homeGroups(state({ a: { bucket: "worth_skim", section: "sec-gone" } }, [mail("a")]));
    expect(g.skim.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("dates in section mail", () => {
  const today = new Date(2026, 9, 10);

  it("keeps well-formed upcoming dates and drops the rest", () => {
    const raw = "```json\n" +
      JSON.stringify([
        { title: "Chase payment due", date: "2026-10-24", time: null, kind: "due", quote: "due October 24" },
        { title: "Chase payment due", date: "2026-10-24", time: null, kind: "due", quote: "dup" },
        { title: "Field trip", date: "2026-10-18", time: "8:15", kind: "event", quote: "bus leaves at 8:15" },
        { title: "Old", date: "2026-10-01", kind: "due" },
        { title: "Bad", date: "2026-02-31", kind: "due" },
        { title: "", date: "2026-11-01", kind: "due" },
      ]) +
      "\n```";
    const finds = parseDates(raw, today);
    expect(finds.map((f) => [f.title, f.date, f.time ?? null])).toEqual([
      ["Chase payment due", "2026-10-24", null],
      ["Field trip", "2026-10-18", "08:15"],
    ]);
    expect(parseDates("I couldn't find any dates.", today)).toEqual([]);
  });

  it("becomes an all-day suggestion, or a one-hour event when there's a time", () => {
    const e = mail("e1");
    const allDay = findToSuggestion({ title: "Due", date: "2026-10-24", kind: "due", quote: "" }, e, "sec-bills", "cal");
    expect(allDay.allDay).toBe(true);
    expect(localDate(new Date(allDay.start))).toBe("2026-10-24");
    expect(localDate(new Date(allDay.end))).toBe("2026-10-25");
    expect(allDay.label).toBe("payment due");

    const timed = findToSuggestion({ title: "Trip", date: "2026-10-18", time: "08:15", kind: "event", quote: "" }, e, "sec-bills", "cal");
    expect(timed.allDay).toBe(false);
    expect(new Date(timed.start).getHours()).toBe(8);
    expect(Date.parse(timed.end) - Date.parse(timed.start)).toBe(36e5);
  });

  it("works offline with the mock writing model", async () => {
    const soon = new Date(Date.now() + 14 * 864e5);
    const month = soon.toLocaleDateString("en-US", { month: "long" });
    const text = `Minimum payment due ${month} ${soon.getDate()}, ${soon.getFullYear()}.`;
    const finds = await extractDates(new MockGenerativeProvider(), mail("e1", { text }), "Bills");
    expect(finds).toEqual([expect.objectContaining({ date: localDate(soon), kind: "due" })]);
  });

  it("shows found dates as suggestions until added or dismissed", () => {
    const due = localDate(new Date(Date.now() + 14 * 864e5));
    const base = {
      calSuggestions: [],
      emails: [mail("e1")],
      folders: [inbox],
      triage: { e1: { bucket: "worth_skim", section: "sec-bills" } as Triage },
      sections: [bills],
      sectionOverrides: {},
      categoryOverrides: {},
      calendars: [{ id: "p:primary", accountId: "p", name: "z@gmail.com", source: "google" as const, hue: 200 }],
      hiddenCalendars: new Set<string>(),
      accounts: [{ id: "p", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" }],
      dateFinds: {
        e1: [
          { title: "Payment due", date: due, kind: "due" as const, quote: "" },
          { title: "Past", date: "2020-01-01", kind: "due" as const, quote: "" },
        ],
      },
      calChanges: { added: [], deleted: [], resolved: [] as string[] },
      noDateSenders: {} as Record<string, true>,
      events: [],
    };
    const list = inboxSuggestions(base);
    expect(list.map((x) => [x.title, x.calendarId])).toEqual([["Payment due", "p:primary"]]);
    expect(inboxSuggestions({ ...base, calChanges: { ...base.calChanges, resolved: [list[0].id] } })).toEqual([]);
  });
});
