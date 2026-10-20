// The spam questions advise. They do not change where the mail sits.
import { describe, expect, it } from "vitest";
import { HttpDecisionProvider, type DecisionRequest, type DecisionResponse } from "@/lib/ai/decision";
import { MockDecisionProvider } from "@/lib/ai/mock-decision";
import { adviceFrom, adviseInbox, isSavedDecision, spamRequest, YES_AT } from "@/lib/ropeline-questions";
import { flagFor, validRopeLineFlags, type RopeLineFlag } from "@/lib/ropeline";
import type { Email } from "@/lib/types";

const mail = (): Email =>
  ({
    id: "e1",
    accountId: "g",
    threadId: "e1",
    folderId: "g:INBOX",
    from: { name: "Pat Example", address: "pat@example.com" },
    to: [],
    subject: "Please sign in",
    snippet: "",
    text: "Open the page and enter your password. ".repeat(80),
    date: "2026-10-01T00:00:00Z",
    unread: true,
    starred: false,
    labels: [],
  }) as Email;

function provider(decide: (req: DecisionRequest) => Promise<DecisionResponse>) {
  const http = new HttpDecisionProvider({ baseUrl: "http://127.0.0.1:9", model: "local" });
  http.decide = decide;
  return http;
}

describe("spam questions", () => {
  it("asks the saved decision provider once and does not ask the offline stand-in", async () => {
    const seen: DecisionRequest[] = [];
    const http = provider(async (req) => {
      seen.push(req);
      return {
        model: "local",
        answers: {
          asks_sign_in: { type: "noul", noul: 0.95 },
          attack_family: { type: "choice", choice: "phishing", confidence: 0.7, probabilities: { phishing: 0.7, none: 0.3 } },
        },
      };
    });
    const email = mail();
    const flags = { e1: flagFor(email, []) };
    expect(isSavedDecision(new MockDecisionProvider())).toBe(false);
    expect(await adviseInbox(new MockDecisionProvider(), [email], flags)).toBeNull();
    const next = await adviseInbox(http, [email], flags);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0].state)).not.toMatch(/folderId/);
    expect((seen[0].state.email as { body: string }).body.length).toBeLessThanOrEqual(2400);
    expect(seen[0].questions.asks_sign_in.type).toBe("noul");
    expect(seen[0].questions.attack_family.type).toBe("choice");
    expect(next?.e1.advice?.advised).toBe(true);
    expect(next?.e1.advice?.family).toBe("phishing");
    expect(next?.e1.flagged).toBe(flags.e1.flagged);
    const again = await adviseInbox(http, [email], next as Record<string, RopeLineFlag>);
    expect(again).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("advises only on a clear yes", () => {
    expect(YES_AT).toBe(0.8);
    const mild = adviceFrom({ model: "m", answers: { asks_payment: { type: "noul", noul: 0.6 }, attack_family: { type: "choice", choice: "none", confidence: 0.9, probabilities: { none: 0.9 } } } });
    expect(mild.advised).toBe(false);
    const firm = adviceFrom({ model: "m", answers: { legal_threat: { type: "noul", noul: 0.8 } } });
    expect(firm.advised).toBe(true);
    const kept = validRopeLineFlags({ e1: { ...flagFor(mail(), []), advice: firm } });
    expect(kept.e1.advice?.advised).toBe(true);
  });

  it("builds a request from the subject and a slice of the body", () => {
    const req = spamRequest(mail());
    expect(req.questions.asks_open_file).toBeDefined();
    expect(Object.keys(req.questions)).toHaveLength(14);
  });
});
