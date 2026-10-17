// @vitest-environment jsdom
// Telling marketing apart from real notifications, and learning from corrections.
import { describe, expect, it } from "vitest";
import type { Email } from "@/lib/types";
import { buildRequest, triageEmail } from "@/lib/ai/triage";
import { MockDecisionProvider } from "@/lib/ai/mock-decision";
import { LESSONS_PER_SENDER, learn, lessonsFromOverrides, senderExamples } from "@/lib/store";
import type { MailSection } from "@/lib/sections";

const me = { name: "Alex", address: "z@gmail.com" };
const mail = (id: string, from: string, subject: string, text: string): Email =>
  ({ id, accountId: "p", threadId: id, folderId: "p:INBOX", from: { name: from.split("@")[0], address: from }, to: [], subject, snippet: "", text, date: new Date().toISOString(), unread: true, starred: false, labels: [] }) as unknown as Email;

describe("categories", () => {
  it("describes engagement nudges as promos and has a Social option", () => {
    const req = buildRequest(mail("a", "noreply@x.ai", "Ask Grok", "hi"), me, [], undefined);
    const c = req.questions.category.criteria as Record<string, string>;
    expect(c.promotions).toMatch(/notifications waiting/);
    expect(c.updates).toMatch(/Not anything trying to get the user to buy/);
    expect(c.social).toMatch(/TikTok/);
  });

  it("passes the user's corrections for this sender to the model as examples, not a rule", () => {
    const req = buildRequest(mail("a", "noreply@x.ai", "Ask Grok", "hi"), me, [], undefined, 255, [], {
      categories: [{ subject: "Ask Grok anything", category: "promotions" }],
    });
    const hint = req.state.user_corrected_category as { note: string; examples: unknown[] };
    expect(hint.examples).toEqual([{ subject: "Ask Grok anything", corrected_to: "promotions" }]);
    expect(hint.note).toMatch(/judge it on its own content/);
    expect(buildRequest(mail("a", "noreply@x.ai", "s", "t"), me, [], undefined).state.user_corrected_category).toBeUndefined();
  });

  it("collects each sender's newest corrections and section examples", () => {
    const at = (e: Email, d: string) => ({ ...e, date: d }) as Email;
    const emails = [
      at(mail("a", "Alerts@CapitalOne.com", "Your statement is ready", "t"), "2026-10-01"),
      at(mail("b", "alerts@capitalone.com", "Get 5% back on dining", "t"), "2026-10-05"),
      at({ ...mail("c", "alerts@capitalone.com", "Payment received", "t"), folderId: "p:Label_bills" } as Email, "2026-09-01"),
      mail("d", "news@tiktok.com", "Sara posted", "t"),
    ];
    const bills = { id: "sec-bills", folderId: "p:Label_bills" } as MailSection;
    let lessons = learn([], emails, ["a"], { category: "transactions" });
    lessons = learn(lessons, emails, ["b"], { category: "promotions" }).map((l) => (l.emailId === "b" ? { ...l, at: l.at + 1 } : l));
    lessons = learn(lessons, emails, ["d", "gone"], { category: "social" });
    const m = senderExamples(emails, lessons, [bills]);
    expect(m.get("alerts@capitalone.com")).toEqual({
      categories: [
        { subject: "Get 5% back on dining", category: "promotions" },
        { subject: "Your statement is ready", category: "transactions" },
      ],
      sections: { "sec-bills": ["Payment received"] },
    });
    expect(m.get("news@tiktok.com")).toEqual({ categories: [{ subject: "Sara posted", category: "social" }] });
  });

  it("offline: engagement bait is a promo, social activity is social, and a correction wins", async () => {
    const p = new MockDecisionProvider();
    const grok = mail("g", "noreply@x.ai", "Ask Grok what's happening now", "See what's new on Grok. New notifications are waiting for you.");
    const tiktok = mail("t", "no-reply@tiktok.com", "Sara Winter posted: baby blues", "Sara Winter posted a new video.");
    expect((await triageEmail(p, grok, me, [], undefined)).category).toBe("promotions");
    expect((await triageEmail(p, tiktok, me, [], undefined)).category).toBe("social");
    const lunch = mail("l", "noreply@school.org", "Lunch balance notification", "Your student's lunch balance is low.");
    const taught = { categories: [{ subject: "Lunch balance notification", category: "transactions" as const }] };
    expect((await triageEmail(p, lunch, me, [], undefined, [], taught)).category).toBe("transactions");
  });

  it("offline: one sender taught both ways sorts each email by what it resembles", async () => {
    const p = new MockDecisionProvider();
    const capOne = {
      categories: [
        { subject: "Your Capital One statement is ready", category: "transactions" as const },
        { subject: "Earn 5% cash back on dining", category: "promotions" as const },
      ],
    };
    const statement = mail("s", "alerts@capitalone.com", "Your October statement is ready", "View your statement online.");
    const offer = mail("o", "alerts@capitalone.com", "Cash back on groceries this week", "Activate your offer.");
    expect((await triageEmail(p, statement, me, [], undefined, [], capOne)).category).toBe("transactions");
    expect((await triageEmail(p, offer, me, [], undefined, [], capOne)).category).toBe("promotions");
  });

  it("a correction keeps teaching after the email is gone", () => {
    const emails = [mail("a", "alerts@capitalone.com", "Earn 5% cash back", "t")];
    const lessons = learn([], emails, ["a"], { category: "promotions" });
    expect(senderExamples([], lessons).get("alerts@capitalone.com")).toEqual({
      categories: [{ subject: "Earn 5% cash back", category: "promotions" }],
    });
  });

  it("keeps the newest few per sender and replaces a re-corrected email", () => {
    const emails = Array.from({ length: 8 }, (_, i) => mail(`m${i}`, "promo@shop.com", `Sale ${i}`, "t"));
    let lessons = learn([], emails, emails.map((e) => e.id), { category: "promotions" });
    expect(lessons).toHaveLength(LESSONS_PER_SENDER);
    lessons = learn(lessons, emails, [lessons[0].emailId], { category: "updates" });
    expect(lessons.filter((l) => l.emailId === lessons[0].emailId)).toEqual([expect.objectContaining({ category: "updates" })]);
    // Section corrections are counted separately from kinds of email.
    lessons = learn(lessons, emails, ["m0"], { section: null });
    expect(lessons.filter((l) => "section" in l)).toHaveLength(1);
    expect(senderExamples([], lessons).get("promo@shop.com")!.sections).toEqual({ none: ["Sale 0"] });
  });

  it("upgrades corrections saved before lessons existed", () => {
    const emails = [mail("a", "A@x.com", "Hello", "t"), mail("b", "b@x.com", "Hi", "t")];
    const lessons = lessonsFromOverrides(emails, { a: "promotions", gone: "social" }, { b: "sec-1" });
    expect(lessons.map((l) => [l.sender, l.subject, l.category ?? l.section])).toEqual(
      expect.arrayContaining([
        ["a@x.com", "Hello", "promotions"],
        ["b@x.com", "Hi", "sec-1"],
      ]),
    );
    expect(lessons).toHaveLength(2);
  });
});
