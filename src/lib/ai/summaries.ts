// One-line summaries for mail rows ("what this email wants and any deadline"). A long Needs-you
// list asks for many at once, and providers turn a burst away with 429 (or 529, "overloaded"), so
// requests go through a small queue: a few at a time, each retried after the wait the provider
// asked for. A summary that still fails isn't remembered, so the row asks again next time.

import { HttpError } from "@/lib/transport";
import type { Email } from "@/lib/types";
import { oneLiner } from "./generative";
import { generativeProvider } from "./providers";

/** Requests in flight at once. */
const CONCURRENCY = 3;
/** Retries after the first try, for rate limits and server errors. */
const RETRIES = 3;
/** Summaries kept for this session. */
const MAX_CACHED = 2000;

const done = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const waiting: (() => void)[] = [];
let running = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await run();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Worth another try: rate limited, overloaded, or a server error. */
function retryable(err: unknown) {
  return err instanceof HttpError && (err.status === 429 || err.status === 529 || err.status >= 500);
}

async function attempt(email: Email): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await slot(() => oneLiner(generativeProvider(), email));
    } catch (err) {
      if (i >= RETRIES || !retryable(err)) throw err;
      const asked = err instanceof HttpError ? err.retryAfter : undefined;
      await sleep(Math.min(30, asked ?? 2 ** (i + 1)) * 1000);
    }
  }
}

/** The summary already made for this email in this session, if any. */
export function cachedSummary(id: string): string | undefined {
  return done.get(id);
}

/** This email's one-line summary; concurrent asks for the same email share one request. */
export function summarize(email: Email): Promise<string> {
  const known = done.get(email.id);
  if (known !== undefined) return Promise.resolve(known);
  let p = pending.get(email.id);
  if (!p) {
    p = attempt(email)
      .then((line) => {
        if (done.size >= MAX_CACHED) done.delete(done.keys().next().value as string);
        done.set(email.id, line);
        return line;
      })
      .catch((err: unknown) => {
        console.warn("[summaries] couldn't summarize", email.id, err instanceof HttpError ? err.status : err);
        throw err;
      })
      .finally(() => pending.delete(email.id));
    pending.set(email.id, p);
  }
  return p;
}

/** For tests. */
export function resetSummaries() {
  done.clear();
  pending.clear();
  waiting.length = 0;
  running = 0;
}
