// Which drafts zMail saved itself, and the signature block it wrote into each. Reopening a draft
// gives its block back as the user's signature only when this record vouches for it: a mark in
// the HTML can't, since every email the user sends carries the same block to people who could
// copy it into a message the user later replies to from another app.

import { signatureFingerprint, splitSavedSignature } from "@/lib/signature";
import type { DraftSignature } from "./types";

/** Drafts remembered, newest kept. A draft past this reopens with its signature in the body, as from any other app. */
export const DRAFT_SIGNATURES_CAP = 500;

/** The fingerprint of the signature block in HTML zMail is about to save as a draft, or null when it has none. */
export function draftBlockFingerprint(html: string | undefined): string | null {
  const split = html ? splitSavedSignature(html) : null;
  return split ? signatureFingerprint(split.signature) : null;
}

const same = (r: DraftSignature, accountId: string, ids: Set<string>) => r.accountId === accountId && (ids.has(r.draftId) || ids.has(r.messageId));

/** Drop what's remembered for these drafts (by draft or message id): deleted, sent, or saved without a block. */
export function forgetDraftSignatures(list: DraftSignature[], accountId: string, ids: (string | undefined)[]): DraftSignature[] {
  const gone = new Set(ids.filter((id): id is string => !!id));
  return list.some((r) => same(r, accountId, gone)) ? list.filter((r) => !same(r, accountId, gone)) : list;
}

/** Remember a draft zMail just saved (replacing the draft it saved over, if the provider gave it a new id), newest last. */
export function rememberDraftSignature(list: DraftSignature[], entry: DraftSignature, savedOver?: string): DraftSignature[] {
  const rest = forgetDraftSignatures(list, entry.accountId, [entry.draftId, entry.messageId, savedOver]);
  return [...rest, entry].slice(-DRAFT_SIGNATURES_CAP);
}

/** Whether `blockHtml`, found in a draft being reopened, is the block zMail saved in that draft. */
export function isOwnDraftSignature(list: DraftSignature[], accountId: string, ids: string[], blockHtml: string): boolean {
  const wanted = new Set(ids);
  const r = list.find((x) => same(x, accountId, wanted));
  return !!r && r.fingerprint === signatureFingerprint(blockHtml);
}

/** A saved record read back from disk: only well-formed entries, at most the cap. */
export function validDraftSignatures(raw: unknown): DraftSignature[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
  const out: DraftSignature[] = [];
  for (const r of raw.slice(-DRAFT_SIGNATURES_CAP)) {
    const { accountId, draftId, messageId, fingerprint } = (r ?? {}) as Partial<Record<keyof DraftSignature, unknown>>;
    if (str(accountId) && str(draftId) && str(messageId) && typeof fingerprint === "string" && /^[0-9a-f]{64}$/.test(fingerprint))
      out.push({ accountId, draftId, messageId, fingerprint });
  }
  return out;
}
