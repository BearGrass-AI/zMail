// Newer Claude models think by default and thinking counts toward max_tokens, so a one-liner's short
// budget could end before any text. The row then showed the email's own words as its "summary".
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[], reply: {} as unknown }));
vi.mock("@/lib/transport", async (orig) => ({
  ...(await orig<typeof import("@/lib/transport")>()),
  request: async (_method: string, _url: string, init: { body: Record<string, unknown> }) => {
    h.bodies.push(init.body);
    return h.reply;
  },
}));

import { HttpGenerativeProvider, oneLiner } from "@/lib/ai/generative";
import type { Email } from "@/lib/types";

const claude = (model: string) => new HttpGenerativeProvider({ provider: "anthropic", baseUrl: "https://api.example.com", model, apiKey: "k" });
const mail = { id: "m", from: { name: "Ann", address: "ann@example.com" }, subject: "Budget", text: "Can you send the numbers by Friday?" } as Email;
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });

beforeEach(() => {
  h.bodies = [];
  h.reply = text("Wants the budget numbers by Friday.");
});

describe("Anthropic completions and thinking", () => {
  it("leaves room for thinking on top of the answer's budget", async () => {
    await oneLiner(claude("claude-haiku-5-5"), mail);
    expect(h.bodies[0].max_tokens).toBeGreaterThanOrEqual(50 + 1024);
  });

  it("asks a Claude 5 model for low effort on a one-liner", async () => {
    await oneLiner(claude("claude-haiku-5-5"), mail);
    expect(h.bodies[0].output_config).toEqual({ effort: "low" });
  });

  it("never sends effort to an older model, which may reject it", async () => {
    await oneLiner(claude("claude-haiku-4-5"), mail);
    expect(h.bodies[0]).not.toHaveProperty("output_config");
  });

  it("never turns thinking off, which some models refuse", async () => {
    await oneLiner(claude("claude-opus-5-5"), mail);
    expect(h.bodies[0]).not.toHaveProperty("thinking");
  });

  it("fails, instead of answering empty, when thinking used the whole budget", async () => {
    h.reply = { content: [{ type: "thinking", thinking: "" }], stop_reason: "max_tokens" };
    await expect(oneLiner(claude("claude-haiku-5-5"), mail)).rejects.toThrow(/token budget/);
  });

  it("reads the answer after a thinking block", async () => {
    h.reply = { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Wants the numbers by Friday." }], stop_reason: "end_turn" };
    await expect(oneLiner(claude("claude-haiku-5-5"), mail)).resolves.toBe("Wants the numbers by Friday.");
  });
});
