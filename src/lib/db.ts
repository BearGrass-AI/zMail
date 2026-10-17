// Local database access (SQLite via Rust). The browser preview falls back to
// localStorage so the UI still behaves the same there.

import { invoke, isTauri } from "@tauri-apps/api/core";

export interface CachedMessage {
  id: string;
  folder_id: string;
  date: string;
  json: string;
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const raw = isTauri() ? await invoke<string | null>("kv_get", { key }) : localStorage.getItem(`zmail.kv.${key}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const raw = JSON.stringify(value);
  if (isTauri()) await invoke("kv_set", { key, value: raw });
  else localStorage.setItem(`zmail.kv.${key}`, raw);
}

export async function cachePutMessages(accountId: string, messages: CachedMessage[]) {
  if (isTauri()) await invoke("cache_put_messages", { accountId, messages });
}

export async function cacheListMessages(accountId: string, limit = 2000, folders?: string[]): Promise<CachedMessage[]> {
  return isTauri() ? invoke<CachedMessage[]>("cache_list_messages", { accountId, limit, folders }) : [];
}

/** One full cached row (with `html` and the whole `text`); list rows are slim. */
export async function cacheGetMessage(id: string): Promise<CachedMessage | null> {
  return isTauri() ? invoke<CachedMessage | null>("cache_get_message", { id }) : null;
}

/** Ids only (same rows as cacheListMessages): newest `limit`, plus every row in `folders`. */
export async function cacheListIds(accountId: string, folders?: string[], limit = 2000): Promise<string[]> {
  return isTauri() ? invoke<string[]>("cache_list_ids", { accountId, limit, folders }) : [];
}

export async function cacheDeleteMessages(ids: string[]) {
  if (isTauri()) await invoke("cache_delete_messages", { ids });
}

/** Delete everything cached for a removed account (mail, folders, sync cursors); resolves to the deleted message ids. */
export async function cacheDeleteAccount(accountId: string): Promise<string[]> {
  return isTauri() ? invoke<string[]>("cache_delete_account", { accountId }) : [];
}

export async function cachePutFolders(accountId: string, folders: [string, string][]) {
  if (isTauri()) await invoke("cache_put_folders", { accountId, folders });
}

export async function cacheListFolders(accountId: string): Promise<string[]> {
  return isTauri() ? invoke<string[]>("cache_list_folders", { accountId }) : [];
}

/** One full-text hit from the local cache. `rank` is bm25: lower (more negative) is better. */
export interface CacheSearchHit {
  id: string;
  account_id: string;
  folder_id: string;
  date: string;
  rank: number;
}

export interface CacheSearchResult {
  /** Best match first and newest first among equal matches; with `order: "date"`, newest first. */
  hits: CacheSearchHit[];
  /** The index is still being built for older cached mail, so some may be missing from `hits`. */
  indexing: boolean;
}

export interface CacheSearchOptions {
  /** Only these accounts (an empty list matches nothing); all accounts when omitted. */
  accountIds?: string[];
  /** Only these folder ids (an empty list matches nothing); all folders when omitted. */
  folderIds?: string[];
  /** Leave out these folder ids (e.g. Spam and Trash). */
  excludeFolderIds?: string[];
  /** Starred mail only. */
  starred?: boolean;
  /** "rank" (default): best match first. "date": newest first over every match, so the limit keeps the newest. */
  order?: "rank" | "date";
  /** At most this many hits, clamped to 1–500 (default 50). */
  limit?: number;
}

/**
 * Keyword search over cached mail (sender name and address, subject, body). Every word must
 * match; the last one also matches as a prefix, for search-as-you-type. The text is taken
 * literally: quotes, `*`, `-`, `OR`, `subject:` and the like are words, not operators.
 */
export async function cacheSearch(query: string, opts: CacheSearchOptions = {}): Promise<CacheSearchResult> {
  if (!isTauri()) return { hits: [], indexing: false };
  // The command clamps too, but NaN/±Infinity serialize as null and huge values overflow its i64.
  const limit = Math.trunc(opts.limit ?? 50);
  return invoke<CacheSearchResult>("cache_search", {
    query,
    accountIds: opts.accountIds ?? null,
    folderIds: opts.folderIds ?? null,
    excludeFolderIds: opts.excludeFolderIds ?? null,
    starred: opts.starred ?? false,
    order: opts.order === "date" ? "date" : "rank",
    limit: Number.isNaN(limit) ? 50 : Math.min(500, Math.max(1, limit)),
  });
}

/** Most rows cacheGetRows reads per call (the command reads no more than this either). */
export const CACHE_ROWS_MAX = 500;

/** Slim cached rows (as cacheListMessages returns them) for these ids, newest first; ids not cached are left out. */
export async function cacheGetRows(ids: string[]): Promise<CachedMessage[]> {
  if (!isTauri() || !ids.length) return [];
  return invoke<CachedMessage[]>("cache_get_rows", { ids: ids.slice(0, CACHE_ROWS_MAX) });
}

export async function syncGet(accountId: string): Promise<string | null> {
  return isTauri() ? invoke<string | null>("sync_get", { accountId }) : null;
}

export async function syncSet(accountId: string, cursor: string) {
  if (isTauri()) await invoke("sync_set", { accountId, cursor });
}
