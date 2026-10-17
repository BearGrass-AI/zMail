// One-line summaries go through a small queue: a few at a time, retried when the provider is rate
// limited, and a failure isn't remembered, so a long Needs-you list doesn't fall back to snippets.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: 0, running: 0, peak: 0, plan: [] as (() => Promise<string>)[] }));
vi.mock("@/lib/ai/providers", () => ({ generativeProvider: () => ({}) }));
vi.mock("@/lib/ai/generative", () => ({
  oneLiner: async () => {
    h.calls++;
    h.running++;
    h.peak = Math.max(h.peak, h.running);
    try {
      const next = h.plan.shift();
      return next ? await next() : "Wants a reply by Friday.";
    } finally {
      h.running--;
    }
  },
}));

import { HttpError } from "@/lib/transport";
import { cachedSummary, resetSummaries, summarize } from "@/lib/ai/summaries";
import type { Email } from "@/lib/types";

const mail = (id: string) => ({ id, from: { name: "A", address: "a@example.com" }, subject: "s", text: "t" }) as Email;

beforeEach(() => {
  resetSummaries();
  Object.assign(h, { calls: 0, running: 0, peak: 0, plan: [] });
});
afterEach(() => vi.useRealTimers());

describe("summaries", () => {
  it("asks for at most three at once", async () => {
    h.plan = Array.from({ length: 10 }, () => () => new Promise<string>((r) => setTimeout(() => r("ok"), 5)));
    await Promise.all(Array.from({ length: 10 }, (_, i) => summarize(mail(`m${i}`))));
    expect(h.peak).toBe(3);
    expect(h.calls).toBe(10);
  });

  it("retries after a rate limit, waiting as long as the provider asked", async () => {
    vi.useFakeTimers();
    h.plan = [() => Promise.reject(new HttpError(429, "slow down", 2))];
    const p = summarize(mail("a"));
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe("Wants a reply by Friday.");
    expect(h.calls).toBe(2);
  });

  it("doesn't keep a failure, so the next ask tries again", async () => {
    h.plan = [() => Promise.reject(new HttpError(401, "bad key"))];
    await expect(summarize(mail("a"))).rejects.toThrow();
    expect(cachedSummary("a")).toBeUndefined();
    await expect(summarize(mail("a"))).resolves.toBe("Wants a reply by Friday.");
  });

  it("shares one request when the same email is asked for twice", async () => {
    await Promise.all([summarize(mail("a")), summarize(mail("a"))]);
    expect(h.calls).toBe(1);
    expect(cachedSummary("a")).toBe("Wants a reply by Friday.");
  });
});
