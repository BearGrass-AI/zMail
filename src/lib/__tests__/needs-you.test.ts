// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Bucket, Category, Email } from "@/lib/types";
import { buildRequest, consistentBucket, triageEmail } from "@/lib/ai/triage";
import type { DecisionProvider, DecisionRequest } from "@/lib/ai/decision";
import { isRefusal } from "@/lib/ai/generative";
import { prepareHtml } from "@/components/mail/email-body";
import { learn, lessonsFromOverrides, senderExamples, useMail } from "@/lib/store";

const mail = (id: string, from: string, subject: string, over: Partial<Email> = {}) =>
  ({ id, accountId: "p", threadId: id, folderId: "p:INBOX", from: { name: from, address: from }, to: [], subject, snippet: "", text: "body", date: new Date().toISOString(), unread: true, starred: false, labels: [], ...over }) as Email;

const probs = (needs: number, skim: number, archive: number) => ({ needs_you: needs, worth_skim: skim, ready_archive: archive });

/** A decision model that always answers with the given bucket and category. */
function scripted(bucket: Bucket, category: Category, p = probs(0.5, 0.3, 0.2)): DecisionProvider & { last?: DecisionRequest } {
  const provider = {
    name: "test",
    maxChoiceOptions: 255,
    async decide(req: DecisionRequest) {
      provider.last = req;
      return {
        model: "test",
        answers: {
          bucket: { type: "choice", choice: bucket, confidence: p[bucket], probabilities: p },
          category: { type: "choice", choice: category, confidence: 0.9, probabilities: { [category]: 0.9 } },
          urgency: { type: "score", score: 1, confidence: 0.9, probabilities: {} },
          needs_reply: { type: "noul", noul: 0.2 },
        },
      };
    },
  } as unknown as DecisionProvider & { last?: DecisionRequest };
  return provider;
}

const me = { name: "Alex", address: "alex@example.org" };

describe("Needs you is for people and real deadlines", () => {
  it("sends mail the model calls a promotion, social or newsletter to Ready to archive", () => {
    for (const category of ["promotions", "social", "newsletters"] as const)
      for (const bucket of ["needs_you", "worth_skim", "ready_archive"] as const)
        expect(consistentBucket({ bucket, category })).toBe("ready_archive");
  });

  it("leaves people and real notices alone", () => {
    for (const category of ["primary", "transactions", "updates", "security"] as const) {
      expect(consistentBucket({ bucket: "needs_you", category })).toBe("needs_you");
      expect(consistentBucket({ bucket: "worth_skim", category })).toBe("worth_skim");
    }
  });

  it("applies the rule to fresh sorts and keeps the model's probabilities", async () => {
    const t = await triageEmail(scripted("worth_skim", "newsletters", probs(0.2, 0.5, 0.3)), mail("a", "news@emails.educause.edu", "This week in higher ed IT"), me, [], undefined);
    expect(t.bucket).toBe("ready_archive");
    expect(t.bucketProbs.worth_skim).toBe(0.5);
    const promo = await triageEmail(scripted("needs_you", "promotions", probs(0.5, 0.3, 0.2)), mail("b", "educause@emails.educause.edu", "Alex, You're Invited"), me, [], undefined);
    expect(promo.bucket).toBe("ready_archive");
    expect(promo.bucketProbs.needs_you).toBe(0.5);
  });

  it("tells the model what does not count, and shows it who is cc'd", () => {
    const req = buildRequest(mail("a", "x@y.com", "Re: plan", { cc: [me] }), me, [], undefined);
    const criteria = (req.questions.bucket as { criteria: Record<string, string> }).criteria;
    expect(criteria.needs_you).toMatch(/only cc'd/);
    expect(criteria.needs_you).not.toMatch(/important process/);
    expect(criteria.worth_skim).toMatch(/statements/);
    expect(criteria.worth_skim).toMatch(/Never marketing, promotions, newsletters/);
    expect((req.state.email as { cc: unknown }).cc).toEqual([me]);
  });
});

describe("bucket corrections teach the model", () => {
  const emails = [mail("a", "alerts@chase.com", "Your statement is available"), mail("b", "alerts@chase.com", "Payment due Oct 18")];

  it("records a move as a lesson and sends it as an example for that sender", () => {
    const lessons = learn([], emails, ["a"], { bucket: "worth_skim" });
    const ex = senderExamples([], lessons).get("alerts@chase.com")!;
    expect(ex.buckets).toEqual([{ subject: "Your statement is available", bucket: "worth_skim" }]);
    const req = buildRequest(emails[1], me, [], undefined, 255, [], ex);
    expect(req.state.user_corrected_bucket).toEqual({
      note: expect.stringContaining("different bucket"),
      examples: [{ subject: "Your statement is available", moved_to: "worth_skim" }],
    });
  });

  it("keeps a bucket move and a category fix for the same email side by side", () => {
    let lessons = learn([], emails, ["a"], { category: "transactions" });
    lessons = learn(lessons, emails, ["a"], { bucket: "worth_skim" });
    lessons = learn(lessons, emails, ["a"], { bucket: "ready_archive" });
    expect(lessons.map((l) => l.category ?? l.bucket).sort()).toEqual(["ready_archive", "transactions"]);
  });

  it("captures moves made before they were kept as lessons", () => {
    const lessons = lessonsFromOverrides(emails, {}, {}, { b: "needs_you" });
    expect(lessons).toEqual([expect.objectContaining({ emailId: "b", bucket: "needs_you" })]);
  });

  it("setBucket records the lesson", () => {
    useMail.setState({ emails, lessons: [], overrides: {} });
    useMail.getState().setBucket(["a"], "ready_archive");
    expect(useMail.getState().overrides).toEqual({ a: "ready_archive" });
    expect(useMail.getState().lessons).toEqual([expect.objectContaining({ emailId: "a", bucket: "ready_archive" })]);
  });
});

describe("one-line summaries", () => {
  it("drops refusals so they aren't shown as a summary", () => {
    for (const t of ["I can't help you with that.", "I can’t help with that.", "I cannot assist with this request.", "I’m sorry, but I can't", "I am unable to summarize this."])
      expect(isRefusal(t)).toBe(true);
    for (const t of ["Submit the final report on Research.gov by Oct 18.", "Sorry, the meeting moved: confirm the new time.", "Approve the hiring form."])
      expect(isRefusal(t)).toBe(false);
  });
});

describe("links in emails", () => {
  it("every link asks for a new window instead of navigating the email frame", () => {
    const { html } = prepareHtml('<a href="https://info.example.org/x">Share Your Thoughts</a><a href="mailto:a@b.com" target="_self">mail</a>', true);
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const a of doc.querySelectorAll("a")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("so does every image-map area", () => {
    const { html } = prepareHtml('<img usemap="#m" src="data:image/png;base64,AAAA"><map name="m"><area href="/" shape="rect" coords="0,0,10,10"><area href="https://info.example.org/a" target="_self"></map>', true);
    const areas = new DOMParser().parseFromString(html, "text/html").querySelectorAll("area");
    expect(areas).toHaveLength(2);
    for (const a of areas) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });
});
