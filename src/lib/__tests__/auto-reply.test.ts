import { describe, expect, it } from "vitest";
import { isAutoReply } from "@/lib/mail/auto-reply";

describe("isAutoReply", () => {
  it("trusts the header flag", () => expect(isAutoReply({ autoReply: true, subject: "Hello" })).toBe(true));
  it.each([
    "Automatic reply: Getting the most out of…",
    "Out of Office: x",
    "Réponse automatique : x",
    "AutoReply: x",
    "Auto-Reply: x",
    "Automatische Antwort: x",
  ])("matches %s", (subject) => expect(isAutoReply({ subject })).toBe(true));
  it.each(["Re: Automatic reply settings question", "Auto loan offer", "Automatic payments: due"])("does not match %s", (subject) =>
    expect(isAutoReply({ subject })).toBe(false),
  );
});
