import { describe, expect, it } from "vitest";
import { draft, parseDraft, type ChatMessage, type GenerativeProvider } from "@/lib/ai/generative";
import { MockGenerativeProvider } from "@/lib/ai/mock-generative";
import type { Email } from "@/lib/types";

const fixed = (out: string): GenerativeProvider & { prompts: ChatMessage[][] } => {
  const prompts: ChatMessage[][] = [];
  return { name: "fixed", prompts, complete: async (m) => (prompts.push(m), out), chat: async () => ({ text: "", toolCalls: [] }) };
};

describe("parseDraft", () => {
  it("splits a subject line from the body", () => {
    expect(parseDraft("Subject: Notice of termination\n\nScott,\n\nThis email…\n\nAlex")).toEqual({
      subject: "Notice of termination",
      body: "Scott,\n\nThis email…\n\nAlex",
    });
  });

  it("handles bolded or quoted subjects", () => {
    expect(parseDraft('**Subject:** "Trustees slides"\n\nHi Jen,').subject).toBe("Trustees slides");
  });

  it("leaves a body without a subject line alone", () => {
    expect(parseDraft("Hi Jen,\n\nThanks")).toEqual({ body: "Hi Jen,\n\nThanks" });
  });
});

describe("draft", () => {
  it("asks for a real subject on new mail and never echoes the instruction", async () => {
    const p = fixed("Subject: Notice of termination\n\nScott,\n\nAlex");
    const out = await draft(p, "Draft an email firing scott.", { name: "Alex Rivera" });
    expect(out.subject).toBe("Notice of termination");
    expect(p.prompts[0][1].content).toContain('"Subject: <a short subject');
  });

  it("replies don't ask for a subject and drop one if the model adds it", async () => {
    const replyTo = { from: { name: "Jen" }, subject: "Slides", text: "Can you send them?" } as Email;
    const p = fixed("Subject: Re: Slides\n\nHi Jen,\n\nAttached.\n\nAlex");
    const out = await draft(p, "send them", { name: "Alex Rivera" }, replyTo);
    expect(out).toEqual({ body: "Hi Jen,\n\nAttached.\n\nAlex" });
    expect(p.prompts[0][1].content).not.toContain("Subject: <");
  });

  it("the offline writer produces a subject too", async () => {
    const out = await draft(new MockGenerativeProvider(), "Ask Jen for the Trustees slides by Monday", { name: "Alex Rivera" });
    expect(out.subject).toBe("Trustees slides");
    expect(out.body.startsWith("Hi Jen,")).toBe(true);
  });
});
