// The assistant's one folder resolver: by id, full path or unique name, preferring the target account,
// ignoring case and dash/space differences. A miss lists the closest existing folders and points at
// create_folder; a folder still waiting on a create card says so instead of failing.

import type { Folder } from "@/lib/types";
import { folderKey, folderPath, splitFolderPath } from "@/lib/store";
import { useAssistant } from "./state";

const HINT_MAX = 15;
export const CREATE_HINT = "To make a new folder, call create_folder first; the user confirms it on a card.";

/** What a create_folder card carries: the account, the full path, and the paths it will create (parents first). */
export interface CreateFolderPayload {
  accountId: string;
  path: string;
  create: string[];
}

/** Thrown when the folder is on a create_folder card the user hasn't confirmed; executeTool returns `result`. */
export class FolderPending extends Error {
  readonly result = {
    status: "waiting_for_folder",
    note: "That folder is on a create card the user hasn't confirmed yet. After they confirm, call this again.",
  };
  constructor(path: string) {
    super(`waiting_for_folder "${path}"`);
  }
}

/** A folder's path with "/" between levels, as create_folder takes it. */
export function pathOf(folders: Folder[], f: Folder): string {
  return splitFolderPath(folderPath(folders, f.id) || f.name).join("/");
}

/** The create_folder card (pending or running) that will make this folder, matched by full path or its last name. */
export function pendingFolderCard(q: string, accountId?: string): CreateFolderPayload | undefined {
  const key = folderKey(q);
  if (!key) return undefined;
  for (const i of useAssistant.getState().items) {
    if (i.kind !== "card" || i.card.type !== "confirm" || i.card.module !== "organize" || i.card.action !== "create_folder") continue;
    if (i.card.status !== "pending" && i.card.status !== "running") continue;
    const p = i.card.payload as CreateFolderPayload;
    if (accountId && p.accountId !== accountId) continue;
    const made = p.create ?? [p.path];
    if (made.some((path) => folderKey(path) === key || folderKey(splitFolderPath(path).at(-1) ?? "") === key)) return p;
  }
  return undefined;
}

const words = (s: string) => new Set(folderKey(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/** Up to HINT_MAX user folder paths, closest to `q` first: most shared words, then the longest shared prefix. */
export function closestFolders(folders: Folder[], q: string, accountId?: string): string[] {
  const user = folders.filter((f) => !f.system);
  const own = accountId ? user.filter((f) => f.accountId === accountId) : [];
  const pool = own.length ? own : user;
  const want = words(q);
  const key = folderKey(q);
  const prefix = (k: string) => {
    let n = 0;
    while (n < k.length && n < key.length && k[n] === key[n]) n++;
    return n;
  };
  return [...new Set(pool.map((f) => pathOf(folders, f)))]
    .map((path) => {
      const k = folderKey(path);
      return { path, shared: [...words(path)].filter((w) => want.has(w)).length, prefix: prefix(k) };
    })
    .sort((a, b) => b.shared - a.shared || b.prefix - a.prefix || a.path.localeCompare(b.path))
    .slice(0, HINT_MAX)
    .map((x) => x.path);
}

/**
 * A folder by id, full path ("Kids/Sam" or "Kids › Sam") or unique name. With `accountId`, that
 * account's folders win. Ambiguity is a bad_query; a miss is a plain error listing the closest folders.
 */
export function resolveFolder(folders: Folder[], arg: unknown, opts: { accountId?: string; userOnly?: boolean } = {}): Folder {
  const q = typeof arg === "string" ? arg.trim() : "";
  if (!q) throw new Error("bad_query: folder is required");
  const pool = opts.userOnly ? folders.filter((f) => !f.system) : folders;
  const byId = pool.find((f) => f.id === q);
  if (byId) return byId;
  const key = folderKey(q);
  const prefer = (hits: Folder[]) => {
    const own = opts.accountId ? hits.filter((f) => f.accountId === opts.accountId) : [];
    return own.length ? own : hits;
  };
  for (const tier of [pool.filter((f) => folderKey(pathOf(folders, f)) === key), pool.filter((f) => folderKey(f.name) === key)]) {
    const hits = prefer(tier);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const list = hits.slice(0, 5).map((f) => `${pathOf(folders, f)} = ${f.id}`).join("; ");
      throw new Error(`bad_query: "${q}" matches ${hits.length} folders (${list}); use an id`);
    }
  }
  if (pendingFolderCard(q, opts.accountId)) throw new FolderPending(q);
  const near = closestFolders(folders, q, opts.accountId);
  const list = near.length ? ` Existing folders: ${near.map((p) => `"${p}"`).join(", ")}.` : "";
  throw new Error(`unknown folder "${q}".${list} ${CREATE_HINT}`);
}
