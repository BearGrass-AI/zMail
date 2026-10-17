// Sending mail actions to providers in batches: per account and chunk, read and star in order.

import type { Email } from "@/lib/types";
import type { BatchOutcome, MailProvider } from "@/lib/mail/provider";
import { chunk, type BulkOptions } from "@/lib/mail/bulk";
import { providerFor, providers } from "./providers";

export interface BulkJob {
  accountId: string;
  emails: Email[];
  run: (p: MailProvider, emails: Email[]) => Promise<BatchOutcome>;
}

/** Run jobs in order; stop at the first failure and hand back everything not done. */
export async function runBulk(jobs: BulkJob[], total: number, opts: BulkOptions, onDone: (e: Email) => void) {
  const res = { done: 0, skipped: 0, failed: [] as Email[], error: undefined as string | undefined };
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (opts.isCancelled?.()) {
      res.failed.push(...jobs.slice(i).flatMap((j) => j.emails));
      res.error = "Stopped.";
      break;
    }
    let o: BatchOutcome;
    try {
      o = await job.run(providerFor(job.accountId), job.emails);
    } catch (err) {
      res.failed.push(...jobs.slice(i).flatMap((j) => j.emails));
      res.error = err instanceof Error ? err.message : String(err);
      break;
    }
    const skipped = new Set(o.skipped);
    const failed = new Set(o.failed);
    for (const e of job.emails) {
      if (skipped.has(e.id)) res.skipped++;
      else if (failed.has(e.id)) res.failed.push(e);
      else {
        res.done++;
        onDone(e);
      }
    }
    opts.onProgress?.(res.done + res.skipped, total);
    if (failed.size) {
      res.failed.push(...jobs.slice(i + 1).flatMap((j) => j.emails));
      res.error = `${failed.size} couldn't be changed.`;
      break;
    }
  }
  return res;
}

export const groupBy = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
};

/** Read and star changes reach the server one at a time, in order, so the last press is what sticks. */
const flagLanes = new Map<string, Promise<unknown>>();
export function inLane<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (flagLanes.get(key) ?? Promise.resolve()).then(run, run);
  flagLanes.set(key, next);
  const clear = () => void (flagLanes.get(key) === next && flagLanes.delete(key));
  next.then(clear, clear);
  return next;
}

/** Emails with a read or star change still on its way to the server (a count per email: presses can queue). */
export const flagging = { unread: new Map<string, number>(), starred: new Map<string, number>() };
export function hold(counts: Map<string, number>, ids: string[], by: 1 | -1) {
  for (const id of ids) {
    const n = (counts.get(id) ?? 0) + by;
    if (n > 0) counts.set(id, n);
    else counts.delete(id);
  }
}

/** One batch call per account and chunk. A failed call fails only its own emails; the rest still run. */
export async function batched(emails: Email[], call: (p: MailProvider, part: Email[]) => Promise<BatchOutcome>) {
  const failed = new Set<string>();
  let error: string | undefined;
  await Promise.all(
    [...groupBy(emails, (e) => e.accountId)].map(async ([accountId, list]) => {
      const p = providers.get(accountId);
      if (!p) {
        for (const e of list) failed.add(e.id);
        error ??= "That account isn't connected.";
        return;
      }
      for (const part of chunk(list, p.batchSize)) {
        try {
          const o = await call(p, part);
          for (const id of o.failed) failed.add(id);
        } catch (err) {
          for (const e of part) failed.add(e.id);
          error ??= err instanceof Error ? err.message : String(err);
        }
      }
    }),
  );
  return { failed, error };
}
