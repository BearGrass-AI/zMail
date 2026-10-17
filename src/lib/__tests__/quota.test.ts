import { describe, expect, it } from "vitest";
import { HttpError } from "@/lib/transport";
import { QuotaLimiter, gmailCost, isRateLimit, withQuota } from "@/lib/google/quota";

/** A fake clock: sleeping advances time instantly. */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (slept.push(ms), (t += ms)), slept, advance: (ms: number) => (t += ms) };
}

const QUOTA_403 = new HttpError(403, `{"error":{"code":403,"message":"Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'","errors":[{"reason":"rateLimitExceeded"}]}}`);

describe("gmail quota", () => {
  it("prices calls at the worst published cost", () => {
    expect(gmailCost("GET", "/messages/abc?format=full")).toBe(20);
    expect(gmailCost("GET", "/messages?maxResults=100")).toBe(5);
    expect(gmailCost("GET", "/messages/abc/attachments/x")).toBe(20);
    expect(gmailCost("POST", "/messages/send")).toBe(100);
    expect(gmailCost("POST", "/messages/abc/modify")).toBe(10);
    expect(gmailCost("GET", "/history?startHistoryId=1")).toBe(2);
    expect(gmailCost("GET", "/labels")).toBe(1);
  });

  it("recognizes Google's rate-limit errors but not real permission errors", () => {
    expect(isRateLimit(QUOTA_403)).toBe(true);
    expect(isRateLimit(new HttpError(429, ""))).toBe(true);
    expect(isRateLimit(new HttpError(403, '{"error":{"message":"Request had insufficient authentication scopes."}}'))).toBe(false);
  });

  it("paces a 300-message first sync into the per-minute budget instead of bursting", async () => {
    const clock = fakeClock();
    const l = new QuotaLimiter(5_000, clock);
    for (let i = 0; i < 300; i++) await l.take(20);
    // 6,000 units at 5,000/min: the last 50 reads wait for the first minute to roll over.
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
    expect(clock.now()).toBeLessThan(61_000);
  });

  it("concurrent callers share one budget", async () => {
    const clock = fakeClock();
    const l = new QuotaLimiter(100, clock);
    await Promise.all(Array.from({ length: 10 }, () => l.take(20)));
    // 200 units at 100/min needs a second window.
    expect(clock.slept.length).toBeGreaterThan(0);
  });

  it("retries a rate-limited call after backing off, then succeeds", async () => {
    const clock = fakeClock();
    const l = new QuotaLimiter(5_000, clock);
    let calls = 0;
    const out = await withQuota(l, 20, async () => (++calls < 3 ? Promise.reject(QUOTA_403) : "ok"), clock);
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    // Waited out at least one full window after being told to slow down.
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
  });

  it("doesn't retry other errors", async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(withQuota(new QuotaLimiter(5_000, clock), 1, async () => (calls++, Promise.reject(new HttpError(401, "bad token"))), clock)).rejects.toThrow("401");
    expect(calls).toBe(1);
  });
});
