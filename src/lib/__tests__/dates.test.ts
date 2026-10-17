import { describe, expect, it } from "vitest";
import { datesPrompt, mentionsDate } from "@/lib/ai/dates";
import type { Email } from "@/lib/types";

const email = { id: "e", from: { name: "Jen", address: "jen@x.com" }, subject: "Slides", text: "Can you send the slides by Friday?", date: "2026-10-07T15:00:00Z" } as unknown as Email;

describe("mentionsDate", () => {
  it.each(["Thursday, Dec 12 at 6:30 PM", "Payment due 10/18", "due October 18", "tomorrow", "2026-12-12", "12 December", "December 12th", "at 6pm", "18:30", "12-12-2026", "please review before the 15th", "by the 2nd", "need it by EOD", "end of day", "by end of the week", "end of month", "this week", "this month", "next week", "next month", "in 3 days", "in two weeks"])("true: %s", (t) => expect(mentionsDate(t)).toBe(true));
  it.each(["Version 1.2.3 released", "Thanks for your order.", "Call 406-243-1234", "A week of days in the month"])("false: %s", (t) => expect(mentionsDate(t)).toBe(false));
  it("documents that 'today' counts", () => expect(mentionsDate("Only $12.99 today")).toBe(true));
  it("prices alone are not dates", () => expect(mentionsDate("Only $12.99")).toBe(false));
});

describe("datesPrompt", () => {
  const today = new Date(2026, 9, 11);
  it("has no section line without a section, and ignores marketing", () => {
    const p = datesPrompt(email, undefined, today);
    expect(p).not.toContain("section");
    expect(p).toContain("Prime Day");
    expect(p).toContain("When unsure whether a date is marketing, leave it out.");
  });
  it("names the section when given", () => {
    expect(datesPrompt(email, "Bills", today)).toContain('in the user\'s "Bills" section');
  });
  it("keeps asks from people and resolves relative dates against the sent date", () => {
    const p = datesPrompt(email, undefined, today);
    expect(p).toContain("can you send the slides by Friday?");
    expect(p).toContain("against the email's sent date");
    expect(p).toContain("Sent: 2026-10-07T15:00:00Z");
    expect(p).toContain("Today is Sunday, 2026-10-11");
  });
});
