// Microsoft Graph throttling. Outlook allows about 4 concurrent requests per
// mailbox and answers overload with 429/503 (sometimes 504) plus Retry-After.
// Every Graph call runs through one limiter per account (at most 4 in flight),
// and throttled calls wait (Retry-After, else exponential backoff) and retry.
// A 429 means Graph didn't process the request, so any call may retry it; a
// 503/504 may come after the work was done, so only idempotent calls retry
// those (never a send). A Retry-After pauses the whole account.

import { HttpError } from "@/lib/transport";

export const MAX_IN_FLIGHT = 4;
export const MAX_RETRIES = 4;
export const MAX_WAIT_MS = 30_000;
/** Resend rounds for throttled items inside a $batch, after the first send. */
export const BATCH_ROUNDS = 3;

const THROTTLE_STATUSES = new Set([429, 503, 504]);

export const isThrottledStatus = (status: number) => THROTTLE_STATUSES.has(status);

export function isThrottled(err: unknown): err is HttpError {
  return err instanceof HttpError && isThrottledStatus(err.status);
}

/** Whether a failed call may be sent again: 429 always; 503/504 only when repeating it is harmless. */
export function isRetryable(err: unknown, idempotent: boolean): err is HttpError {
  return isThrottled(err) && (err.status === 429 || idempotent);
}

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Retry-After (seconds) worth honoring: given and above 0. */
const usable = (retryAfterSec?: number): retryAfterSec is number => retryAfterSec !== undefined && retryAfterSec > 0;

/**
 * The wait before retry `attempt` (0-based): Retry-After if given and above 0, else 1s, 2s, 4s, 8s
 * plus up to 25% jitter (so never under a second). Capped at 30 s.
 */
export function backoffMs(attempt: number, retryAfterSec?: number, random: () => number = Math.random): number {
  const ms = usable(retryAfterSec) ? retryAfterSec * 1000 : 1000 * 2 ** attempt * (1 + 0.25 * random());
  return Math.min(MAX_WAIT_MS, ms);
}

/** Retry-After (seconds) from a $batch item's `headers` object; header names are matched case-insensitively. */
export function retryAfterFromHeaders(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "retry-after") continue;
    const s = String(v).trim();
    return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : undefined;
  }
  return undefined;
}

/** How long to wait before resending throttled $batch items: the largest per-item Retry-After, or backoff. */
export function batchDelayMs(items: { headers?: Record<string, string> }[], round: number, random: () => number = Math.random): number {
  const waits = items.map((i) => retryAfterFromHeaders(i.headers)).filter((s): s is number => s !== undefined);
  return backoffMs(round, waits.length ? Math.max(...waits) : undefined, random);
}

/** A counting semaphore: acquire() waits for a free slot, release() hands it to the next waiter. */
class Semaphore {
  private free: number;
  private waiters: (() => void)[] = [];

  constructor(size: number) {
    this.free = size;
  }

  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise((r) => this.waiters.push(r));
  }

  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}

export class GraphThrottle {
  private slots = new Map<string, Semaphore>();
  /** Per account: clock time until which no request is sent (set from Retry-After). */
  private pausedUntil = new Map<string, number>();

  constructor(
    public clock: Clock = realClock,
    private readonly maxInFlight = MAX_IN_FLIGHT,
    private readonly retries = MAX_RETRIES,
  ) {}

  sleep(ms: number) {
    return this.clock.sleep(ms);
  }

  private slot(accountId: string) {
    let s = this.slots.get(accountId);
    if (!s) this.slots.set(accountId, (s = new Semaphore(this.maxInFlight)));
    return s;
  }

  /** Hold every request for this account for `ms` (Graph said Retry-After). Never shortens a longer pause. */
  pause(accountId: string, ms: number) {
    const until = this.clock.now() + ms;
    if (until > (this.pausedUntil.get(accountId) ?? 0)) this.pausedUntil.set(accountId, until);
  }

  private pausedFor(accountId: string) {
    return (this.pausedUntil.get(accountId) ?? 0) - this.clock.now();
  }

  /** Wait out the account's pause, then take a slot; if a pause began while queued, give the slot back and wait again. */
  private async enter(accountId: string, slot: Semaphore) {
    for (;;) {
      for (let ms = this.pausedFor(accountId); ms > 0; ms = this.pausedFor(accountId)) await this.clock.sleep(ms);
      await slot.acquire();
      if (this.pausedFor(accountId) <= 0) return;
      slot.release();
    }
  }

  /**
   * Run one Graph call inside the account's limit, retrying throttling errors. The slot is free while waiting.
   * `idempotent`: the call is safe to repeat, so 503/504 retry too; otherwise only 429 does.
   */
  async run<T>(accountId: string, call: () => Promise<T>, opts: { idempotent?: boolean } = {}): Promise<T> {
    const slot = this.slot(accountId);
    for (let attempt = 0; ; attempt++) {
      let wait: number;
      let paused = false;
      await this.enter(accountId, slot);
      try {
        return await call();
      } catch (err) {
        if (!isRetryable(err, opts.idempotent ?? false) || attempt >= this.retries) throw err;
        wait = backoffMs(attempt, err.retryAfter);
        // Graph named a wait: the whole mailbox holds off, not just this request.
        if (usable(err.retryAfter)) {
          this.pause(accountId, wait);
          paused = true;
        }
      } finally {
        slot.release();
      }
      // A pause is waited out by enter() on the next attempt.
      if (!paused) await this.clock.sleep(wait);
    }
  }
}

/** Shared by every Graph caller (mail, calendar, drive, contacts). */
export const graphThrottle = new GraphThrottle();
