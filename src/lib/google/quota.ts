// Gmail enforces a per-user budget of "quota units" per minute, and Google's
// published numbers disagree (6,000–15,000 units/min; a message read costs
// 5–20). We pace against the low end, and when Google still says slow down
// (403 rateLimitExceeded / 429) we back off and retry instead of failing.

import { HttpError } from "@/lib/transport";

/** Stay under the lowest published per-user limit with some headroom. */
export const UNITS_PER_MINUTE = 5_000;

/** Worst-case unit cost of a Gmail API call. */
export function gmailCost(method: string, path: string): number {
  if (path.startsWith("/messages/batchModify")) return 50;
  if (path.startsWith("/messages/send") || path.startsWith("/drafts")) return 100;
  if (/^\/messages\/[^/?]+\/attachments\//.test(path)) return 20;
  if (method === "GET" && /^\/messages\/[^/?]+/.test(path)) return 20;
  if (path.startsWith("/messages")) return method === "GET" ? 5 : 10;
  if (path.startsWith("/history")) return 2;
  return 1;
}

export function isRateLimit(err: unknown): err is HttpError {
  return err instanceof HttpError && (err.status === 429 || (err.status === 403 && /rateLimitExceeded|Quota exceeded|RESOURCE_EXHAUSTED/i.test(err.body)));
}

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Sliding one-minute window of spent units. Shared by every caller for one account. */
export class QuotaLimiter {
  private spent: { at: number; units: number }[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly budget = UNITS_PER_MINUTE,
    private readonly clock: Clock = realClock,
  ) {}

  /** Wait until `units` fit in the last minute's budget, then record them. */
  take(units: number): Promise<void> {
    // Serialize reservations so concurrent callers don't all see the same headroom.
    const turn = this.queue.then(async () => {
      for (;;) {
        const now = this.clock.now();
        this.spent = this.spent.filter((s) => now - s.at < 60_000);
        const used = this.spent.reduce((n, s) => n + s.units, 0);
        if (used + units <= this.budget || !this.spent.length) {
          this.spent.push({ at: now, units });
          return;
        }
        await this.clock.sleep(60_000 - (now - this.spent[0].at) + 5);
      }
    });
    this.queue = turn.catch(() => {});
    return turn;
  }

  /** Google told us we're over: treat the whole window as spent. */
  exhaust() {
    this.spent.push({ at: this.clock.now(), units: this.budget });
  }
}

const limiters = new Map<string, QuotaLimiter>();
export const limiterFor = (accountId: string) => {
  let l = limiters.get(accountId);
  if (!l) limiters.set(accountId, (l = new QuotaLimiter()));
  return l;
};

/** Run a paced call, retrying rate-limit errors with backoff (Retry-After isn't exposed to us). */
export async function withQuota<T>(limiter: QuotaLimiter, units: number, call: () => Promise<T>, clock: Clock = realClock, retries = 5): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await limiter.take(units);
    try {
      return await call();
    } catch (err) {
      if (!isRateLimit(err) || attempt >= retries) throw err;
      limiter.exhaust();
      await clock.sleep(Math.min(60_000, 2_000 * 2 ** attempt) + Math.random() * 500);
    }
  }
}
