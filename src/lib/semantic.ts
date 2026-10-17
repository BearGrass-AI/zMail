// Meaning-based search: a local embedding model (downloaded once, on request) and a vector index of
// the mail cache, both in Rust. Everything runs on this Mac. Without the model, or outside Tauri (the
// browser preview), every call answers "not ready" and search works as it always has.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CacheSearchHit } from "@/lib/db";

export interface SemanticStatus {
  enabled: boolean;
  /** "partial": a download stopped part way, ready to resume. */
  model: "missing" | "partial" | "downloading" | "verifying" | "ready";
  /** Bytes of the model downloaded so far, and its size. */
  downloaded: number;
  size: number;
  error: string | null;
  /** Emails with vectors, of all cached emails. */
  indexed: number;
  total: number;
  indexing: boolean;
}

const OFF: SemanticStatus = { enabled: false, model: "missing", downloaded: 0, size: 309_855_456, error: null, indexed: 0, total: 0, indexing: false };

export async function semanticStatus(): Promise<SemanticStatus> {
  return isTauri() ? invoke<SemanticStatus>("semantic_status") : OFF;
}

/** Turn it on: downloads the model (or resumes the download) if it isn't here, then indexes. */
export async function semanticEnable(): Promise<SemanticStatus> {
  return isTauri() ? invoke<SemanticStatus>("semantic_enable") : OFF;
}

/** Stop the download; what arrived is kept for a resume. */
export async function semanticCancelDownload(): Promise<SemanticStatus> {
  return isTauri() ? invoke<SemanticStatus>("semantic_cancel_download") : OFF;
}

/** Turn it off; `deleteData` also deletes the model and its index (resolves once they're gone). */
export async function semanticDisable(deleteData: boolean): Promise<SemanticStatus> {
  return isTauri() ? invoke<SemanticStatus>("semantic_disable", { delete: deleteData }) : OFF;
}

/** Which mail a meaning-based search covers (as cacheSearch's options name them). */
export interface SemanticScope {
  accountIds?: string[];
  folderIds?: string[];
  excludeFolderIds?: string[];
  starred?: boolean;
}

export interface SemanticResult<T> {
  /** False: off, no model, or nothing indexed yet. `hits` is empty then. */
  ready: boolean;
  hits: T[];
}

const scopeArg = (s: SemanticScope) => ({
  accountIds: s.accountIds ?? null,
  folderIds: s.folderIds ?? null,
  excludeFolderIds: s.excludeFolderIds ?? null,
  starred: s.starred ?? false,
});

/** The best few emails for a query by keywords and meaning (Rust caps `limit` at 20). */
export async function semanticSearch(query: string, scope: SemanticScope, limit: number): Promise<SemanticResult<CacheSearchHit>> {
  if (!isTauri()) return { ready: false, hits: [] };
  return invoke<SemanticResult<CacheSearchHit>>("semantic_search", { query, scope: scopeArg(scope), limit });
}

/** A hit with the passage (at most 300 characters) that best matches the query. */
export interface PassageHit {
  id: string;
  account_id: string;
  folder_id: string;
  date: string;
  from_name: string;
  from_address: string;
  subject: string;
  passage: string;
}

/** The best emails for a question, each with its best-matching passage (Rust caps `limit` at 5). */
export async function semanticPassages(query: string, scope: SemanticScope, limit = 5): Promise<SemanticResult<PassageHit>> {
  if (!isTauri()) return { ready: false, hits: [] };
  return invoke<SemanticResult<PassageHit>>("semantic_passages", { query, scope: scopeArg(scope), limit });
}

/** Whether search can use meaning now: on, the model in place, and something indexed. */
export function semanticReady(s: SemanticStatus): boolean {
  return s.enabled && s.model === "ready" && s.indexed > 0;
}
