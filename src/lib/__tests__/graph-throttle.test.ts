import { describe, expect, it } from "vitest";
import { HttpError } from "@/lib/transport";
import { GraphThrottle, backoffMs, batchDelayMs, isThrottled, retryAfterFromHeaders } from "@/lib/microsoft/throttle";

/** A fake clock: sleeping advances time instantly. */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (slept.push(ms), (t += ms)), slept };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

/** A clock whose sleeps only end when the test advances time. */
function manualClock() {
  let t = 0;
  const timers: { at: number; wake: () => void }[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((wake) => void timers.push({ at: t + ms, wake })),
    advance(ms: number) {
      t += ms;
      for (const x of timers.filter((x) => x.at <= t)) {
        timers.splice(timers.indexOf(x), 1);
        x.wake();
      }
    },
  };
}

/** A call that tracks how many run at once and finishes on the next macrotask. */
function tracker() {
  const t = { now: 0, max: 0, done: 0 };
  const call = async () => {
    t.max = Math.max(t.max, ++t.now);
    await tick();
    t.now--;
    t.done++;
    return "ok";
  };
  return { t, call };
}

describe("graph throttle: limiter", () => {
  it("never runs more than 4 requests at once for one account", async () => {
    const g = new GraphThrottle(fakeClock());
    const { t, call } = tracker();
    await Promise.all(Array.from({ length: 20 }, () => g.run("m1", call)));
    expect(t.max).toBe(4);
    expect(t.done).toBe(20);
  });

  it("keeps two accounts independent", async () => {
    const g = new GraphThrottle(fakeClock());
    const a = tracker();
    const b = tracker();
    await Promise.all([...Array.from({ length: 10 }, () => g.run("m1", a.call)), ...Array.from({ length: 10 }, () => g.run("m2", b.call))]);
    expect(a.t.max).toBe(4);
    expect(b.t.max).toBe(4);
    // One account at full width doesn't hold the other back: 8 run at once across the two.
    const shared = tracker();
    await Promise.all([...Array.from({ length: 4 }, () => g.run("m1", shared.call)), ...Array.from({ length: 4 }, () => g.run("m2", shared.call))]);
    expect(shared.t.max).toBe(8);
  });

  it("releases the slot when a call throws", async () => {
    const g = new GraphThrottle(fakeClock());
    await Promise.all(Array.from({ length: 4 }, () => g.run("m1", async () => Promise.reject(new HttpError(400, "bad"))).catch(() => {})));
    const { t, call } = tracker();
    await g.run("m1", call);
    expect(t.done).toBe(1);
  });
});

describe("graph throttle: retry", () => {
  it("waits Retry-After seconds on a 429, then succeeds", async () => {
    const clock = fakeClock();
    const g = new GraphThrottle(clock);
    let calls = 0;
    const out = await g.run("m1", async () => (++calls === 1 ? Promise.reject(new HttpError(429, "slow down", 2)) : "ok"));
    expect(out).toBe("ok");
    expect(calls).toBe(2);
    expect(clock.slept).toEqual([2000]);
  });

  it("backs off 1s, 2s, 4s, 8s with jitter on a 503 without Retry-After, then throws", async () => {
    const clock = fakeClock();
    const g = new GraphThrottle(clock);
    let calls = 0;
    await expect(g.run("m1", async () => (calls++, Promise.reject(new HttpError(503, "busy"))), { idempotent: true })).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(5); // the first try plus 4 retries
    expect(clock.slept).toHaveLength(4);
    clock.slept.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(1000 * 2 ** i);
      expect(ms).toBeLessThan(1250 * 2 ** i);
    });
  });

  it("retries a 504 too", async () => {
    const clock = fakeClock();
    let calls = 0;
    const out = await new GraphThrottle(clock).run("m1", async () => (++calls === 1 ? Promise.reject(new HttpError(504, "gateway")) : "ok"), { idempotent: true });
    expect(out).toBe("ok");
  });

  it("retries a non-idempotent call only on 429, never on 503/504 (it may have run)", async () => {
    const clock = fakeClock();
    const g = new GraphThrottle(clock);
    for (const status of [503, 504]) {
      let calls = 0;
      await expect(g.run("m1", async () => (calls++, Promise.reject(new HttpError(status, "maybe sent"))))).rejects.toMatchObject({ status });
      expect(calls).toBe(1);
    }
    let calls = 0;
    await expect(g.run("m1", async () => (++calls === 1 ? Promise.reject(new HttpError(429, "not processed")) : "sent"))).resolves.toBe("sent");
    expect(calls).toBe(2);
  });

  it("treats a Retry-After of 0 as 'use backoff', so a retry isn't instant", async () => {
    const clock = fakeClock();
    let calls = 0;
    await new GraphThrottle(clock).run("m1", async () => (++calls === 1 ? Promise.reject(new HttpError(429, "", 0)) : "ok"));
    expect(clock.slept).toHaveLength(1);
    expect(clock.slept[0]).toBeGreaterThanOrEqual(1000);
  });

  it("caps any single wait at 30 seconds", async () => {
    const clock = fakeClock();
    let calls = 0;
    await new GraphThrottle(clock).run("m1", async () => (++calls === 1 ? Promise.reject(new HttpError(429, "", 600)) : "ok"));
    expect(clock.slept).toEqual([30_000]);
  });

  it("doesn't retry other statuses", async () => {
    const clock = fakeClock();
    const g = new GraphThrottle(clock);
    for (const status of [400, 401, 403, 404, 500]) {
      let calls = 0;
      await expect(g.run("m1", async () => (calls++, Promise.reject(new HttpError(status, "no"))))).rejects.toMatchObject({ status });
      expect(calls).toBe(1);
    }
    let calls = 0;
    await expect(g.run("m1", async () => (calls++, Promise.reject(new Error("network down"))))).rejects.toThrow("network down");
    expect(calls).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  it("frees the slot while backing off so other requests proceed", async () => {
    let wake!: () => void;
    const asleep = new Promise<void>((r) => (wake = r));
    let sleeping = 0;
    const clock = { now: () => 0, sleep: async () => void (sleeping++, await asleep) };
    const g = new GraphThrottle(clock);
    // Fill all 4 slots with requests that get a 503 (no Retry-After) once.
    const tries = new Map<number, number>();
    const throttledOnce = (i: number) =>
      g.run(
        "m1",
        async () => {
          tries.set(i, (tries.get(i) ?? 0) + 1);
          if (tries.get(i) === 1) throw new HttpError(503, "");
          return i;
        },
        { idempotent: true },
      );
    const first = [0, 1, 2, 3].map(throttledOnce);
    while (sleeping < 4) await tick();
    // All four are backing off; a fifth request must not queue behind them.
    await expect(g.run("m1", async () => "fifth")).resolves.toBe("fifth");
    wake();
    await expect(Promise.all(first)).resolves.toEqual([0, 1, 2, 3]);
  });
});

describe("graph throttle: shared pause", () => {
  it("holds other requests for the account until a Retry-After ends; other accounts carry on", async () => {
    const clock = manualClock();
    const g = new GraphThrottle(clock);
    const sent: string[] = [];
    let aTries = 0;
    const a = g.run("m1", async () => {
      sent.push(`a@${clock.now()}`);
      if (++aTries === 1) throw new HttpError(429, "slow down", 5);
      return "a";
    });
    await settle();
    const b = g.run("m1", async () => (sent.push(`b@${clock.now()}`), "b"));
    const c = g.run("m2", async () => (sent.push(`c@${clock.now()}`), "c"));
    await settle();
    expect(sent).toEqual(["a@0", "c@0"]); // b waits out m1's pause; c is unaffected
    clock.advance(4_999);
    await settle();
    expect(sent).toEqual(["a@0", "c@0"]);
    clock.advance(1);
    await settle();
    await expect(Promise.all([a, b, c])).resolves.toEqual(["a", "b", "c"]);
    expect(sent.slice(2).sort()).toEqual(["a@5000", "b@5000"]);
  });
});

describe("graph throttle: helpers", () => {
  it("recognizes throttling statuses", () => {
    expect(isThrottled(new HttpError(429, ""))).toBe(true);
    expect(isThrottled(new HttpError(503, ""))).toBe(true);
    expect(isThrottled(new HttpError(504, ""))).toBe(true);
    expect(isThrottled(new HttpError(500, ""))).toBe(false);
    expect(isThrottled(new Error("429"))).toBe(false);
  });

  it("computes the wait from Retry-After or backoff", () => {
    expect(backoffMs(0, 3)).toBe(3000);
    // 0 or less means "use backoff", which never waits under a second.
    expect(backoffMs(3, 0, () => 0)).toBe(8000);
    expect(backoffMs(0, -1, () => 0)).toBe(1000);
    expect(backoffMs(0, 99)).toBe(30_000);
    expect(backoffMs(2, undefined, () => 0)).toBe(4000);
    expect(backoffMs(3, undefined, () => 0.999)).toBeLessThan(10_000);
    expect(backoffMs(10, undefined, () => 0)).toBe(30_000);
  });

  it("reads Retry-After from a $batch item's headers case-insensitively", () => {
    expect(retryAfterFromHeaders({ "Retry-After": "4" })).toBe(4);
    expect(retryAfterFromHeaders({ "retry-after": "2" })).toBe(2);
    expect(retryAfterFromHeaders({ "RETRY-AFTER": 9 as unknown as string })).toBe(9);
    expect(retryAfterFromHeaders({ "Content-Type": "application/json" })).toBeUndefined();
    expect(retryAfterFromHeaders(undefined)).toBeUndefined();
    expect(retryAfterFromHeaders({ "Retry-After": "soon" })).toBeUndefined();
    expect(retryAfterFromHeaders({ "Retry-After": "0" })).toBeUndefined();
  });

  it("waits for the largest per-item Retry-After in a $batch, or backs off", () => {
    expect(batchDelayMs([{ headers: { "Retry-After": "1" } }, { headers: { "retry-after": "3" } }, {}], 0)).toBe(3000);
    expect(batchDelayMs([{}, { headers: {} }], 1, () => 0)).toBe(2000);
  });
});
