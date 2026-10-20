// Hosted RopeLine verdict. Off unless the user asks and the Terms and Privacy pages exist.
// The request is a fingerprint and signal names. It does not carry the message.

import { request } from "@/lib/transport";
import type { RopeLineFlag, RopeLineSignal } from "@/lib/ropeline";
import { ropeLineKey } from "@/lib/ropeline";
import type { Email } from "@/lib/types";

/** Flip only when the Terms and Privacy pages say a fingerprint may leave the Mac. */
export const ROPELINE_TERMS_READY = false;

export type RopeLineVerdict = "good" | "unsure" | "spam";

export function hostedCallAllowed(settings: { ropeLineHosted?: boolean; ropeLineHostedUrl?: string }, termsReady = ROPELINE_TERMS_READY): boolean {
  return termsReady && settings.ropeLineHosted === true && (settings.ropeLineHostedUrl ?? "").trim().length > 0;
}

/** The only object that may be posted. */
export function hostedBody(flag: Pick<RopeLineFlag, "fingerprint" | "signals">): { fingerprint: string | null; signals: RopeLineSignal[] } {
  return {
    fingerprint: flag.fingerprint,
    signals: flag.signals.map((s) => ({ kind: s.kind, value: s.value })),
  };
}

function verdictOf(raw: unknown): RopeLineVerdict | null {
  const word = raw && typeof raw === "object" ? (raw as { verdict?: unknown }).verdict : undefined;
  return word === "good" || word === "unsure" || word === "spam" ? word : null;
}

export async function askHosted(opts: {
  enabled: boolean;
  termsReady: boolean;
  baseUrl: string;
  flag: Pick<RopeLineFlag, "fingerprint" | "signals">;
  post?: (url: string, body: { fingerprint: string | null; signals: RopeLineSignal[] }) => Promise<unknown>;
}): Promise<RopeLineVerdict | null> {
  if (!hostedCallAllowed({ ropeLineHosted: opts.enabled, ropeLineHostedUrl: opts.baseUrl }, opts.termsReady)) return null;
  if (!opts.flag.fingerprint && !opts.flag.signals.length) return null;
  const body = hostedBody(opts.flag);
  const url = opts.baseUrl.trim().replace(/\/+$/, "") + "/v1/verdict";
  try {
    const res = opts.post ? await opts.post(url, body) : await request<unknown>("POST", url, { body });
    return verdictOf(res);
  } catch (err) {
    console.error("[ropeline]", err);
    return null;
  }
}

/** Ask for inbox mail that has a fingerprint or a signal and no verdict for this text yet. */
export async function attachVerdicts(
  flags: Record<string, RopeLineFlag>,
  emails: Pick<Email, "id" | "from" | "subject" | "text">[],
  settings: { ropeLineHosted?: boolean; ropeLineHostedUrl?: string },
  post?: (url: string, body: { fingerprint: string | null; signals: RopeLineSignal[] }) => Promise<unknown>,
  termsReady = ROPELINE_TERMS_READY,
): Promise<Record<string, RopeLineFlag> | null> {
  if (!hostedCallAllowed(settings, termsReady)) return null;
  const url = settings.ropeLineHostedUrl ?? "";
  const todo = emails.filter((e) => {
    const f = flags[e.id];
    return f && f.key === ropeLineKey(e) && !f.verdict && (f.fingerprint || f.signals.length);
  });
  if (!todo.length) return null;
  const next = { ...flags };
  for (const email of todo) {
    const prev = next[email.id];
    const verdict = await askHosted({ enabled: true, termsReady, baseUrl: url, flag: prev, post });
    if (verdict && next[email.id]) next[email.id] = { ...next[email.id], verdict };
  }
  return next;
}
