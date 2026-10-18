// Microsoft Graph mail provider. Uses immutable ids (so a message keeps its id
// when moved), a recursive folder walk, and incremental sync by
// lastModifiedDateTime, cached in local SQLite.

import type { Account, Email, Folder, SystemFolder } from "@/lib/types";
import type { BatchOutcome, EmbeddedImage, MailProvider, SearchPage, SendRequest, SyncChanges } from "@/lib/mail/provider";
import { HttpError, request, type Method } from "@/lib/transport";
import { accessToken } from "@/lib/oauth";
import { cacheDeleteMessages, cacheGetMessage, cacheListIds, cacheListMessages, cachePutFolders, cachePutMessages, syncGet, syncSet } from "@/lib/db";
import { graphQuery, resolveFolder, type MailQuery } from "@/lib/ai/assistant/query";
import { pool } from "@/lib/google/gmail";
import { BATCH_ROUNDS, batchDelayMs, graphThrottle, isThrottledStatus, retryAfterFromHeaders } from "./throttle";
import { NeedsPermissionError, fromGraphSetting, isPermissionError, toGraphSetting, type AutoReply, type GraphAutoReplySetting } from "@/lib/mail/auto-replies";
import { WELL_KNOWN, foldersToTree, messageToEmail, spliceReply, toGraphMessage, type GAttachment, type GReplyBody, type GFileAttachment, type GMailFolder, type GMsg } from "./graph-map";

export const GRAPH = "https://graph.microsoft.com/v1.0";

const HEADER_FIELDS = "id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,flag,bodyPreview,parentFolderId,hasAttachments,categories";

const MSG_FIELDS =
  "id,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,flag,bodyPreview,body,parentFolderId,hasAttachments,internetMessageId,categories,lastModifiedDateTime";

const ATTACHMENT_FIELDS = "id,name,contentType,size,isInline";

/** A message as Graph returns it for MSG_FIELDS; `attachments` is present only when the fetch used $expand. */
type FullMsg = GMsg & { lastModifiedDateTime?: string; attachments?: GAttachment[] };

/** A cached email also remembers the server's lastModifiedDateTime, so sync can skip rows that haven't changed. */
type StoredEmail = Email & { lastModified?: string };

/**
 * Every Graph call: at most 4 in flight per mailbox, and throttled calls wait and retry (see throttle.ts).
 * `idempotent` (default: every method but POST) lets 503/504 retry too; a plain POST (send, create)
 * retries only on 429, because a 503/504 may come after Graph already did the work.
 */
export async function graph<T>(
  accountId: string,
  method: Method,
  pathOrUrl: string,
  body?: unknown,
  extra: Record<string, string> = {},
  opts: { idempotent?: boolean } = {},
): Promise<T> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  const idempotent = opts.idempotent ?? method !== "POST";
  return graphThrottle.run(accountId, async () => {
    // Fetched per attempt so a retry after a long wait uses a fresh token.
    const token = await accessToken(accountId);
    return request<T>(method, url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId"', ...extra },
      body,
    });
  }, { idempotent });
}

type BatchResponse = { id: string; status: number; headers?: Record<string, string>; body?: unknown };

interface Page<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

/** Graph's $search returns at most this many messages in all. */
export const GRAPH_SEARCH_LIMIT = 1000;

/** How often listMessages checks cached Inbox mail against the server (hard deletes are never reported). */
export const RECONCILE_EVERY_MS = 15 * 60_000;

/** Most changes one incremental sync lists; the rest wait for the next sync. */
export const SYNC_CAP = 2000;

/** Incremental syncs re-list this much before the cursor, for clock skew between this Mac and Exchange. */
const SKEW_MS = 5 * 60_000;

/** Most message headers GraphProvider remembers. */
const HEADER_CACHE_MAX = 2000;

/** Syncs a changed message's attachment list may fail before it's cached without them. */
const ATTACHMENT_TRIES = 3;

/** Most drafts whose uploaded files GraphProvider remembers. */
const DRAFT_FILES_MAX = 50;

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class GraphProvider implements MailProvider {
  readonly batchSize = 20;
  private headerCache = new Map<string, Email>();
  /** Insert-ordered and capped, so a long session can't grow it without bound. */
  private cacheHeader(id: string, row: Email) {
    this.headerCache.delete(id);
    this.headerCache.set(id, row);
    if (this.headerCache.size > HEADER_CACHE_MAX) this.headerCache.delete(this.headerCache.keys().next().value!);
  }

  async search(q: MailQuery, folders: Folder[], page?: string): Promise<SearchPage> {
    const folder = resolveFolder(q, this.account.id, folders);
    // A folder that doesn't resolve must not widen the search to the whole mailbox.
    if (q.folder && !folder && !page) return { ids: [] };
    const base = folder ? `/me/mailFolders/${folder.id.slice(this.account.id.length + 1)}/messages` : "/me/messages";
    const { search, filter, local } = graphQuery(q);
    const url =
      page ??
      (search
        ? `${base}?$search=${encodeURIComponent(`"${search}"`)}&$select=${HEADER_FIELDS}&$top=250`
        : `${base}?$filter=${encodeURIComponent(filter!)}&$orderby=receivedDateTime desc&$select=${HEADER_FIELDS}&$top=250`);
    const res = await this.api<Page<GMsg>>("GET", url);
    // Without a folder, /me/messages includes Deleted Items, Junk and Drafts; leave them out like Gmail does.
    // Derived from the folders passed in, so it works before fetchFolders() has run on this instance.
    const hidden = new Set<string>(
      folder ? [] : folders.filter((f) => f.accountId === this.account.id && (f.system === "trash" || f.system === "spam" || f.system === "drafts")).map((f) => f.id),
    );
    const rows = res.value
      .map((m) => ({ ...messageToEmail(this.account.id, m), partial: true }))
      .filter((e) => local(e) && !hidden.has(e.folderId));
    for (const r of rows) this.cacheHeader(r.id, r);
    // $search stops at 1,000 results (Microsoft docs); count server rows so the caller can tell it hit that.
    const capInfo = search ? { limit: GRAPH_SEARCH_LIMIT, scanned: res.value.length } : {};
    return { ids: rows.map((r) => r.id), headers: rows, next: res["@odata.nextLink"], ...capInfo };
  }

  async headers(ids: string[]): Promise<Email[]> {
    const fetched = new Map<string, Email>();
    for (const id of ids) {
      const hit = this.headerCache.get(id);
      if (hit) fetched.set(id, hit);
    }
    const missing = ids.filter((id) => !this.headerCache.has(id));
    for (let i = 0; i < missing.length; i += 20) {
      const part = missing.slice(i, i + 20);
      const res = await this.batch(part.map((id) => ({ method: "GET", url: `/me/messages/${id}?$select=${HEADER_FIELDS}` })));
      for (const r of res) {
        if (r.status === 200 && r.body) {
          const row = { ...messageToEmail(this.account.id, r.body as GMsg), partial: true };
          this.cacheHeader(row.id, row);
          fetched.set(row.id, row);
        } else if (r.status >= 400 && r.status !== 404) {
          // Deleted mail (404) is left out; anything else would silently lose a row.
          throw new HttpError(r.status, "Microsoft Graph could not return every message header.");
        }
      }
    }
    // Rows come back in the order of the requested ids.
    return ids.map((id) => fetched.get(id)).filter((e): e is Email => !!e);
  }

  async getMessage(id: string): Promise<Email> {
    const m = await this.api<FullMsg>("GET", `/me/messages/${id}?$select=${MSG_FIELDS},internetMessageHeaders`);
    const [e] = await this.toEmails([m]);
    await cachePutMessages(this.account.id, [{ id: e.id, folder_id: e.folderId, date: e.date, json: JSON.stringify(e) }]);
    return e;
  }

  /**
   * One $batch. Items Graph throttled (429/503/504) are resent on their own, with their
   * original ids, after the largest per-item Retry-After; up to 3 rounds, then they stand as failed.
   */
  private async batch(reqs: { method: string; url: string; body?: unknown }[]) {
    const results = new Map<string, BatchResponse>();
    let pending = reqs.map((r, i) => ({ ...r, id: String(i) }));
    for (let round = 0; ; round++) {
      let res: { responses: BatchResponse[] };
      try {
        // Batches hold only GETs, PATCHes and moves, which are safe to repeat.
        res = await this.api<{ responses: BatchResponse[] }>(
          "POST",
          "/$batch",
          {
            requests: pending.map((r) => ({
              id: r.id,
              method: r.method,
              url: r.url,
              headers: { "Content-Type": "application/json", Prefer: 'IdType="ImmutableId"' },
              ...(r.body !== undefined ? { body: r.body } : {}),
            })),
          },
          undefined,
          { idempotent: true },
        );
      } catch (err) {
        // A failed resend leaves the earlier results standing (the throttled items stay failed).
        if (round === 0) throw err;
        break;
      }
      for (const r of res.responses) results.set(r.id, r);
      const throttled = res.responses.filter((r) => isThrottledStatus(r.status));
      if (!throttled.length || round >= BATCH_ROUNDS) break;
      const wait = batchDelayMs(throttled, round);
      // A per-item Retry-After pauses the whole account (the resend waits it out in graph()); otherwise just back off.
      if (throttled.some((r) => retryAfterFromHeaders(r.headers) !== undefined)) graphThrottle.pause(this.account.id, wait);
      else await graphThrottle.sleep(wait);
      const again = new Set(throttled.map((r) => r.id));
      pending = pending.filter((r) => again.has(r.id));
    }
    return [...results.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }

  private outcome(ids: string[], responses: { id: string; status: number }[]): BatchOutcome {
    const skipped: string[] = [];
    const failed: string[] = [];
    const seen = new Set<number>();
    for (const r of responses) {
      seen.add(Number(r.id));
      if (r.status === 404) skipped.push(ids[Number(r.id)]);
      else if (r.status >= 400) failed.push(ids[Number(r.id)]);
    }
    // A response that never came back is not a success.
    ids.forEach((id, i) => {
      if (!seen.has(i)) failed.push(id);
    });
    return { skipped, failed };
  }

  // Edits never throw for HTTP failures: if the whole $batch call fails, every id in it is reported failed.
  private async edit(ids: string[], reqs: { method: string; url: string; body?: unknown }[], patch?: (row: Email) => Email): Promise<BatchOutcome> {
    if (!ids.length) return { skipped: [], failed: [] };
    let out: BatchOutcome;
    try {
      out = this.outcome(ids, await this.batch(reqs));
    } catch {
      return { skipped: [], failed: ids };
    }
    // Keep cached header rows in step with what the server now holds.
    const bad = new Set([...out.skipped, ...out.failed]);
    for (const id of ids) {
      const row = this.headerCache.get(id);
      if (!row) continue;
      if (out.skipped.includes(id)) this.headerCache.delete(id);
      else if (!bad.has(id) && patch) this.cacheHeader(id, patch(row));
    }
    return out;
  }

  async batchMove(emails: Email[], folderId: string): Promise<BatchOutcome> {
    const dest = folderId.slice(this.account.id.length + 1);
    const ids = emails.map((e) => e.id);
    return this.edit(ids, ids.map((id) => ({ method: "POST", url: `/me/messages/${id}/move`, body: { destinationId: dest } })), (r) => ({ ...r, folderId }));
  }

  async batchSetRead(ids: string[], read: boolean): Promise<BatchOutcome> {
    return this.edit(ids, ids.map((id) => ({ method: "PATCH", url: `/me/messages/${id}`, body: { isRead: read } })), (r) => ({ ...r, unread: !read }));
  }

  async batchSetStarred(ids: string[], starred: boolean): Promise<BatchOutcome> {
    const flag = { flagStatus: starred ? "flagged" : "notFlagged" };
    return this.edit(ids, ids.map((id) => ({ method: "PATCH", url: `/me/messages/${id}`, body: { flag } })), (r) => ({ ...r, starred }));
  }

  private systemIds: Record<string, SystemFolder> = {};
  private folderIdByKind = new Map<SystemFolder, string>();

  /** Tests pass a small `syncCap` so the cap test needs hundreds of fake messages, not thousands. */
  constructor(
    readonly account: Account,
    private readonly syncCap = SYNC_CAP,
  ) {}

  private api<T>(method: Method, path: string, body?: unknown, extra?: Record<string, string>, opts?: { idempotent?: boolean }) {
    return graph<T>(this.account.id, method, path, body, extra, opts);
  }

  private async all<T>(path: string, cap = 2000): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    while (next && out.length < cap) {
      const page: Page<T> = await this.api<Page<T>>("GET", next);
      out.push(...page.value);
      next = page["@odata.nextLink"];
    }
    return out;
  }

  private folderCache?: { at: number; folders: Folder[] };

  /** Folder tree, re-fetched at most every 10 minutes (counts change slowly; refresh runs every 2). */
  async listFolders(force = false): Promise<Folder[]> {
    if (!force && this.folderCache && Date.now() - this.folderCache.at < 10 * 60_000) return this.folderCache.folders;
    const folders = await this.fetchFolders();
    this.folderCache = { at: Date.now(), folders };
    return folders;
  }

  /** One new folder at the top level or under `parentId`; a name that's already there returns that folder (Graph answers 409). */
  async createFolder(name: string, parentId?: string): Promise<Folder> {
    const prefix = `${this.account.id}:`;
    if (parentId && !parentId.startsWith(prefix)) throw new Error("That parent folder belongs to another account.");
    const base = parentId ? `/me/mailFolders/${parentId.slice(prefix.length)}/childFolders` : "/me/mailFolders";
    let made: GMailFolder;
    try {
      made = await this.api<GMailFolder>("POST", base, { displayName: name });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      const lc = name.toLowerCase();
      const there = (await this.all<GMailFolder>(`${base}?$select=id,displayName,parentFolderId,unreadItemCount&$top=250`)).find((f) => f.displayName.toLowerCase() === lc);
      if (!there) throw err;
      made = there;
    }
    // Mapped like a folder sync maps it; the parent is the one asked for (a top-level parent is the hidden root).
    const folder: Folder = { ...foldersToTree(this.account.id, [made], this.systemIds)[0], parentId };
    if (this.folderCache) this.folderCache.folders = [...this.folderCache.folders.filter((f) => f.id !== folder.id), folder];
    return folder;
  }

  /** Cheap count refresh: one small GET per folder, at most 5. */
  async refreshCounts(folderIds: string[]): Promise<Record<string, number>> {
    const prefix = `${this.account.id}:`;
    const out: Record<string, number> = {};
    for (const id of folderIds.filter((x) => x.startsWith(prefix)).slice(0, 5)) {
      const f = await this.api<{ unreadItemCount?: number }>("GET", `/me/mailFolders/${id.slice(prefix.length)}?$select=unreadItemCount`);
      if (typeof f.unreadItemCount === "number") out[id] = f.unreadItemCount;
    }
    if (this.folderCache) {
      this.folderCache.folders = this.folderCache.folders.map((f) => (f.id in out ? { ...f, unread: out[f.id] } : f));
    }
    return out;
  }

  private async fetchFolders(): Promise<Folder[]> {
    // Resolve the real ids of well-known folders.
    const known = await pool(Object.keys(WELL_KNOWN), 4, async (name) => {
      try {
        const f = await this.api<GMailFolder>("GET", `/me/mailFolders/${name}?$select=id`);
        return [f.id, WELL_KNOWN[name]] as const;
      } catch {
        return null; // e.g. no Archive folder provisioned
      }
    });
    this.systemIds = Object.fromEntries(known.filter((k): k is readonly [string, SystemFolder] => !!k));
    this.folderIdByKind = new Map(Object.entries(this.systemIds).map(([id, kind]) => [kind, id]));

    const select = "$select=id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount&$top=250";
    const top = await this.all<GMailFolder>(`/me/mailFolders?${select}`);
    const flat: GMailFolder[] = [...top];
    let frontier = top.filter((f) => (f.childFolderCount ?? 0) > 0);
    while (frontier.length) {
      const kids = (await pool(frontier, 4, (f) => this.all<GMailFolder>(`/me/mailFolders/${f.id}/childFolders?${select}`))).flat();
      flat.push(...kids);
      frontier = kids.filter((f) => (f.childFolderCount ?? 0) > 0);
    }
    const folders = foldersToTree(this.account.id, flat, this.systemIds);
    void cachePutFolders(this.account.id, folders.map((f) => [f.id, JSON.stringify(f)]));
    return folders;
  }

  /** `failed`, when given, collects ids whose attachment list couldn't be read (so callers can avoid caching them). */
  private async toEmails(msgs: FullMsg[], failed?: Set<string>): Promise<StoredEmail[]> {
    // Graph allows about 4 concurrent requests per mailbox.
    return pool(msgs, 4, async (m) => {
      // Attachments that came back with the message ($expand) need no request of their own.
      const atts =
        m.attachments ??
        (m.hasAttachments
          ? await this.api<Page<GAttachment>>("GET", `/me/messages/${m.id}/attachments?$select=${ATTACHMENT_FIELDS}`)
              .then((p) => p.value)
              .catch(() => {
                failed?.add(m.id);
                return [];
              })
          : []);
      return { ...messageToEmail(this.account.id, m, atts), ...(m.lastModifiedDateTime ? { lastModified: m.lastModifiedDateTime } : {}) };
    });
  }

  /**
   * Full messages for `ids`, 20 per $batch with their attachment lists expanded in the same
   * request. A message deleted since it was listed (404) is left out (and added to `opts.gone`). Any other failure throws,
   * so the sync cursor doesn't advance. If Graph rejects the $expand (400), those messages are
   * fetched plainly and their attachments read one request each, as before.
   */
  private async fetchFull(ids: string[], opts?: { gone?: string[]; failed?: Set<string> }): Promise<StoredEmail[]> {
    const out: StoredEmail[] = [];
    const expand = `$expand=attachments($select=${ATTACHMENT_FIELDS})`;
    const plain: string[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const part = ids.slice(i, i + 20);
      const res = await this.batch(part.map((id) => ({ method: "GET", url: `/me/messages/${id}?$select=${MSG_FIELDS}&${expand}` })));
      const msgs: FullMsg[] = [];
      for (const r of res) {
        const id = part[Number(r.id)];
        if (r.status === 200 && r.body) msgs.push(r.body as FullMsg);
        else if (r.status === 400) plain.push(id);
        else if (r.status === 404) opts?.gone?.push(id);
        else throw new HttpError(r.status, "Microsoft Graph could not return every changed message.");
      }
      out.push(...(await this.toEmails(msgs, opts?.failed)));
    }
    for (let i = 0; i < plain.length; i += 20) {
      const part = plain.slice(i, i + 20);
      const res = await this.batch(part.map((id) => ({ method: "GET", url: `/me/messages/${id}?$select=${MSG_FIELDS}` })));
      const msgs: FullMsg[] = [];
      for (const r of res) {
        if (r.status === 200 && r.body) msgs.push(r.body as FullMsg);
        else if (r.status === 404) opts?.gone?.push(part[Number(r.id)]);
        else throw new HttpError(r.status, "Microsoft Graph could not return every changed message.");
      }
      out.push(...(await this.toEmails(msgs, opts?.failed)));
    }
    return out;
  }

  async listMessages(opts?: { folderId?: string; limit?: number }): Promise<Email[]> {
    const { inbox } = await this.syncSince(opts?.limit);
    const cached = (await cacheListMessages(this.account.id, undefined, inbox)).map((c) => JSON.parse(c.json) as Email);
    return cached.filter((e) => !opts?.folderId || e.folderId === opts.folderId);
  }

  async syncChanges(): Promise<SyncChanges> {
    const { first, changed, removed } = await this.syncSince();
    return first ? { full: true } : { full: false, changed, removed };
  }

  /**
   * Fetch and cache what changed since the last sync (or the last 90 days on the first run),
   * then reconcile the Inbox when due. Returns what was written to the cache: saved emails and
   * deleted ids. `first` is true when there was no previous sync.
   */
  private async syncSince(limit?: number): Promise<{ first: boolean; changed: Email[]; removed: string[]; inbox: string[] | undefined }> {
    const last = await syncGet(this.account.id);
    // Overlap 5 minutes to absorb clock skew between this Mac and Exchange.
    const since = last ? new Date(Date.parse(last) - SKEW_MS).toISOString() : null;
    const started = new Date().toISOString();
    // List only ids and timestamps; full messages are fetched just for mail that is new or changed.
    // Changes are listed oldest first, so a sync that hits the cap can stop at a point and resume there.
    const select = "$select=id,lastModifiedDateTime";
    const path = since
      ? `/me/messages?${select}&$filter=lastModifiedDateTime ge ${since}&$orderby=lastModifiedDateTime asc&$top=100`
      : `/me/messages?${select}&$filter=receivedDateTime ge ${new Date(Date.now() - 90 * 864e5).toISOString()}&$orderby=receivedDateTime desc&$top=100`;
    let listed = await this.all<{ id: string; lastModifiedDateTime?: string }>(path, since ? this.syncCap : limit ?? 400);
    let cursor = started;
    if (since && listed.length >= this.syncCap) {
      const oldest = listed[0].lastModifiedDateTime;
      const newest = listed[listed.length - 1].lastModifiedDateTime;
      // More changed than one sync takes: the next sync continues from the newest listed change, not from now.
      // That timestamp is Exchange's own, so add back the skew overlap the next sync subtracts; otherwise
      // more than 5 minutes' worth of changes would re-list the same page every time.
      if (newest && newest !== oldest) cursor = new Date(Date.parse(newest) + SKEW_MS).toISOString();
      // A single timestamp fills the cap: take it all rather than never get past it.
      else listed = await this.all<{ id: string; lastModifiedDateTime?: string }>(path, Number.POSITIVE_INFINITY);
    }
    // The listing is small (filtered by lastModifiedDateTime), so read each listed id's own full row.
    const known = new Map<string, string | undefined>();
    await pool(listed, 8, async (m) => {
      const c = await cacheGetMessage(m.id);
      if (c) known.set(m.id, (JSON.parse(c.json) as StoredEmail).lastModified);
    });
    const stale = listed.filter((m) => !m.lastModifiedDateTime || known.get(m.id) !== m.lastModifiedDateTime).map((m) => m.id);
    const failed = new Set<string>();
    const fetched = await this.fetchFull(stale, { failed });
    // Mail whose attachments couldn't be read keeps its old row and holds the cursor, so the next sync tries again.
    // After ATTACHMENT_TRIES syncs in a row it's cached without them, so one bad message can't stall sync.
    const tries = new Map([...failed].map((id) => [id, (this.attachmentTries.get(id) ?? 0) + 1]));
    this.attachmentTries = new Map([...tries].filter(([, n]) => n < ATTACHMENT_TRIES));
    if (tries.size > this.attachmentTries.size) console.error("Outlook: cached mail without its attachment list after repeated failures");
    const emails = fetched.filter((e) => !this.attachmentTries.has(e.id));
    await cachePutMessages(this.account.id, emails.map((e) => ({ id: e.id, folder_id: e.folderId, date: e.date, json: JSON.stringify(e) })));
    if (!this.attachmentTries.size) await syncSet(this.account.id, cursor);
    const inbox = this.inboxFolders();
    const at = graphThrottle.clock.now();
    // Filled chunk by chunk, so a reconcile that fails part-way still reports what it already wrote to the cache.
    const rec: { moved: Email[]; gone: string[] } = { moved: [], gone: [] };
    if (inbox && (this.reconciledAt === undefined || at - this.reconciledAt >= RECONCILE_EVERY_MS)) {
      // Stamped before running, so a failure waits the full interval before the next try.
      this.reconciledAt = at;
      await this.reconcileInbox(inbox, rec).catch((err) => console.error("Outlook Inbox reconcile failed", err));
    }
    const removed = new Set(rec.gone);
    const changed = new Map<string, Email>();
    for (const e of [...emails, ...rec.moved]) if (!removed.has(e.id)) changed.set(e.id, e);
    return { first: !last, changed: [...changed.values()], removed: [...removed], inbox };
  }

  private reconciledAt?: number;

  /** Syncs in a row each message's attachment list has failed (only ids failing right now). */
  private attachmentTries = new Map<string, number>();

  /**
   * Sync by lastModifiedDateTime never sees hard deletes (Shift+Delete, emptied Deleted Items,
   * retention purges). List the Inbox's ids now and refetch every cached Inbox row that isn't
   * there: 404 leaves the cache, the rest are saved with their new folder. Any other error
   * stops the reconcile without deleting anything from the failing chunk. Each finished chunk's
   * re-saved emails and deleted ids are added to `out`, which is also returned.
   */
  private async reconcileInbox(inbox: string[], out: { moved: Email[]; gone: string[] } = { moved: [], gone: [] }): Promise<{ moved: Email[]; gone: string[] }> {
    const now = new Set((await this.all<{ id: string }>("/me/mailFolders/inbox/messages?$select=id&$top=1000", Number.POSITIVE_INFINITY)).map((m) => m.id));
    const stale = (await cacheListIds(this.account.id, inbox, 0)).filter((id) => !now.has(id));
    for (let i = 0; i < stale.length; i += 20) {
      const gone: string[] = [];
      const failed = new Set<string>();
      // One $batch per chunk; it throws on anything but 404, before this chunk deletes anything.
      const emails = (await this.fetchFull(stale.slice(i, i + 20), { gone, failed })).filter((e) => !failed.has(e.id));
      if (gone.length) await cacheDeleteMessages(gone);
      // Mail whose attachments couldn't be read keeps its old row; the next reconcile tries again.
      await cachePutMessages(this.account.id, emails.map((e) => ({ id: e.id, folder_id: e.folderId, date: e.date, json: JSON.stringify(e) })));
      out.gone.push(...gone);
      out.moved.push(...emails);
    }
    return out;
  }

  /** One page (100) of Inbox mail not yet cached; the cursor is the previous page's nextLink. */
  async backfillInbox(cursor?: string): Promise<{ emails: Email[]; next?: string; total?: number; failed: number }> {
    const path = cursor ?? `/me/mailFolders/inbox/messages?$select=${MSG_FIELDS}&$orderby=receivedDateTime desc&$top=100`;
    const page = await this.api<Page<FullMsg>>("GET", path);
    let total: number | undefined;
    if (!cursor) {
      total = await this.api<{ totalItemCount?: number }>("GET", "/me/mailFolders/inbox?$select=totalItemCount")
        .then((f) => f.totalItemCount)
        .catch(() => undefined);
    }
    const have = new Set(await cacheListIds(this.account.id, this.inboxFolders()));
    const failed = new Set<string>();
    const emails = await this.toEmails(page.value.filter((m) => !have.has(m.id)), failed);
    // Mail whose attachments couldn't be read is returned but not cached, so a later pass refetches it.
    await cachePutMessages(this.account.id, emails.filter((e) => !failed.has(e.id)).map((e) => ({ id: e.id, folder_id: e.folderId, date: e.date, json: JSON.stringify(e) })));
    return { emails, next: page["@odata.nextLink"], total, failed: failed.size };
  }

  async move(emailId: string, folderId: string) {
    const dest = folderId.slice(this.account.id.length + 1);
    // Moving again to the same folder changes nothing, so a 503/504 may retry it.
    await this.api("POST", `/me/messages/${emailId}/move`, { destinationId: dest }, undefined, { idempotent: true });
  }

  async setRead(emailId: string, read: boolean) {
    await this.api("PATCH", `/me/messages/${emailId}`, { isRead: read });
  }

  async setStarred(emailId: string, starred: boolean) {
    await this.api("PATCH", `/me/messages/${emailId}`, { flag: { flagStatus: starred ? "flagged" : "notFlagged" } });
  }

  /** The email being replied to, if it's in this mailbox; a reply to another account's mail can't use its id here, so it goes out as a new message. */
  private ownReplyTo(msg: SendRequest) {
    return msg.replyTo?.accountId === this.account.id ? msg.replyTo : undefined;
  }

  async send(msg: SendRequest) {
    const message = toGraphMessage(msg);
    const replyTo = this.ownReplyTo(msg);
    if (replyTo && !msg.html && !message.attachments.length) {
      // /reply keeps the conversation threaded in Outlook.
      await this.api("POST", `/me/messages/${replyTo.id}/reply`, {
        message: { toRecipients: message.toRecipients, ccRecipients: message.ccRecipients, bccRecipients: message.bccRecipients },
        comment: msg.text,
      });
      return;
    }
    if (replyTo) return this.sendReplyDraft(replyTo.id, message);
    await this.api("POST", "/me/sendMail", { message, saveToSentItems: true });
  }

  /**
   * HTML replies and replies with attachments: createReply gives a threaded draft
   * with Outlook's quoted original; our HTML goes above it, then attachments, then send.
   */
  private async sendReplyDraft(replyToId: string, message: ReturnType<typeof toGraphMessage>) {
    const draft = await this.api<{ id: string; body?: GReplyBody }>("POST", `/me/messages/${replyToId}/createReply`);
    try {
      const ours = message.body.contentType === "HTML" ? message.body.content : `<div>${message.body.content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</div>`;
      await this.api("PATCH", `/me/messages/${draft.id}`, {
        toRecipients: message.toRecipients,
        ccRecipients: message.ccRecipients,
        bccRecipients: message.bccRecipients,
        body: { contentType: "HTML", content: spliceReply(draft.body, ours) },
      });
      for (const a of message.attachments) await this.api("POST", `/me/messages/${draft.id}/attachments`, a);
      await this.api("POST", `/me/messages/${draft.id}/send`);
    } catch (err) {
      // Don't leave a half-built reply sitting in Drafts.
      await this.api("DELETE", `/me/messages/${draft.id}`).catch(() => {});
      throw err;
    }
  }

  /** Quoted original Outlook generated for each reply draft this session, with its format, so re-saves keep it under our text. */
  private draftQuotes = new Map<string, GReplyBody>();

  async saveDraft(msg: SendRequest, draftId?: string): Promise<{ draftId: string; messageId: string }> {
    const message = toGraphMessage(msg);
    const ours = message.body.contentType === "HTML" ? message.body.content : `<div>${message.body.content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</div>`;
    const replyTo = this.ownReplyTo(msg);
    let id = draftId;
    const first = !id;
    if (!id) {
      if (replyTo) {
        const created = await this.api<{ id: string; body?: GReplyBody }>("POST", `/me/messages/${replyTo.id}/createReply`);
        id = created.id;
        if (created.body?.content) this.draftQuotes.set(id, { contentType: created.body.contentType, content: created.body.content });
      } else {
        const { attachments: _a, ...rest } = message;
        const created = await this.api<{ id: string }>("POST", "/me/messages", rest);
        id = created.id;
      }
    }
    try {
      if (draftId || replyTo) {
        await this.api("PATCH", `/me/messages/${id}`, {
          subject: message.subject,
          toRecipients: message.toRecipients,
          ccRecipients: message.ccRecipients,
          bccRecipients: message.bccRecipients,
          body: { contentType: "HTML", content: spliceReply(this.draftQuotes.get(id), ours) },
        });
      }
      await this.syncDraftAttachments(id, message);
    } catch (err) {
      // A draft we just created and couldn't finish shouldn't be left behind.
      if (first) await this.api("DELETE", `/me/messages/${id}`).catch(() => {});
      throw err;
    }
    return { draftId: id, messageId: id };
  }

  /**
   * Regular files on each draft, by Graph attachment id → name and SHA-256 of the bytes this session uploaded.
   * Graph's `size` isn't the file's length, so this is how a re-save tells a changed file from an unchanged one.
   */
  private draftFiles = new Map<string, Map<string, string>>();

  private forgetDraft(draftId: string) {
    this.draftQuotes.delete(draftId);
    this.draftFiles.delete(draftId);
  }

  /**
   * Make the draft's attachments match the request: an inline image stays only while the HTML still uses its cid,
   * a file only if this session uploaded the same bytes under the same name; everything else is replaced.
   */
  private async syncDraftAttachments(id: string, message: ReturnType<typeof toGraphMessage>) {
    const existing = await this.api<Page<{ id: string; name: string; isInline?: boolean; contentId?: string }>>(
      "GET",
      `/me/messages/${id}/attachments?$select=id,name,contentId,isInline`,
    );
    const inline = new Map<string, GFileAttachment>();
    const files: { a: GFileAttachment; key: string }[] = [];
    for (const a of message.attachments) {
      if (a.contentId !== undefined) inline.set(a.contentId, a);
      else files.push({ a, key: `${a.name}\0${await sha256(a.contentBytes)}` });
    }
    const known = this.draftFiles.get(id);
    const kept = new Map<string, string>();
    // Images Outlook copied from the original into a reply draft belong to its quoted original, which we keep as is.
    const quote = this.draftQuotes.get(id)?.content?.toLowerCase() ?? "";
    for (const e of existing.value) {
      if (e.isInline) {
        const cid = (e.contentId ?? "").replace(/^<|>$/g, "");
        // Every save tags our cids afresh, so a part whose cid neither our HTML nor the quote uses must go.
        if (inline.delete(cid) || (cid && quote.includes(`cid:${cid.toLowerCase()}`))) continue;
      } else {
        const key = known?.get(e.id);
        const i = key === undefined ? -1 : files.findIndex((f) => f.key === key);
        if (i >= 0) {
          kept.set(e.id, files[i].key);
          files.splice(i, 1);
          continue;
        }
      }
      await this.api("DELETE", `/me/messages/${id}/attachments/${e.id}`);
    }
    for (const f of files) {
      const made = await this.api<{ id: string }>("POST", `/me/messages/${id}/attachments`, f.a);
      kept.set(made.id, f.key);
    }
    for (const a of inline.values()) await this.api("POST", `/me/messages/${id}/attachments`, a);
    this.draftFiles.delete(id);
    this.draftFiles.set(id, kept);
    if (this.draftFiles.size > DRAFT_FILES_MAX) this.draftFiles.delete(this.draftFiles.keys().next().value!);
  }

  async sendDraft(msg: SendRequest, draftId: string) {
    await this.saveDraft(msg, draftId);
    await this.api("POST", `/me/messages/${draftId}/send`);
    this.forgetDraft(draftId);
  }

  /** Scheduled send (local hold): send the draft exactly as saved. */
  async sendSavedDraft(draftId: string) {
    await this.api("POST", `/me/messages/${draftId}/send`);
    this.forgetDraft(draftId);
  }

  /**
   * Scheduled send (server hold, behind OUTLOOK_SERVER_HOLD): set PidTagDeferredSendTime on the
   * draft, then submit it; Exchange sends it at `sendAt`.
   */
  async holdOnServer(msg: SendRequest, draftId: string, sendAt: number) {
    await this.saveDraft(msg, draftId);
    await this.api("PATCH", `/me/messages/${draftId}`, {
      singleValueExtendedProperties: [{ id: "SystemTime 0x3FEF", value: new Date(sendAt).toISOString().replace(/\.\d{3}Z$/, "Z") }],
    });
    await this.api("POST", `/me/messages/${draftId}/send`);
    this.forgetDraft(draftId);
  }

  /** Take a held message back to Drafts (cancel). Every call sends Prefer: IdType="ImmutableId", so the id survives the move. */
  async releaseFromServer(messageId: string) {
    await this.api("POST", `/me/messages/${messageId}/move`, { destinationId: "drafts" });
  }

  /** The draft's body already holds its quote once reopened from the server, so stop splicing it in again. */
  forgetDraftQuote(draftId: string) {
    this.draftQuotes.delete(draftId);
  }

  /** A reopened reply draft's quoted original, taken off its HTML body, so saves splice it back in as with createReply's. */
  keepDraftQuote(draftId: string, quote: string) {
    this.draftQuotes.set(draftId, { contentType: "html", content: quote });
  }

  async deleteDraft(draftId: string) {
    await this.api("DELETE", `/me/messages/${draftId}`);
    this.forgetDraft(draftId);
  }

  async draftIdFor(messageId: string): Promise<string | undefined> {
    return messageId;
  }

  async getAttachment(emailId: string, attachmentId: string): Promise<string> {
    const a = await this.api<GAttachment>("GET", `/me/messages/${emailId}/attachments/${attachmentId}`);
    if (!a.contentBytes) throw new HttpError(415, "This attachment type can't be downloaded (e.g. an attached item).");
    return a.contentBytes;
  }

  async inlineImages(emailId: string): Promise<EmbeddedImage[]> {
    type Att = GAttachment & { contentId?: string };
    const base = `/me/messages/${emailId}/attachments`;
    let page: Page<Att>;
    try {
      page = await this.api<Page<Att>>("GET", `${base}?$filter=isInline eq true`);
    } catch (err) {
      // Graph can reject the $filter on attachments; fetch all and filter isInline client-side.
      if (!(err instanceof HttpError) || err.status !== 400) throw err;
      page = await this.api<Page<Att>>("GET", base);
      page = { ...page, value: page.value.filter((a) => a.isInline) };
    }
    return page.value
      .filter((a) => a.contentBytes && (a.contentType ?? "").startsWith("image/"))
      .map((a) => ({ cid: (a.contentId ?? a.name).replace(/^<|>$/g, ""), mimeType: a.contentType!, base64: a.contentBytes! }));
  }

  async getAutoReply(): Promise<AutoReply> {
    try {
      return fromGraphSetting(await this.api<GraphAutoReplySetting>("GET", "/me/mailboxSettings/automaticRepliesSetting"));
    } catch (e) {
      if (isPermissionError(e)) throw new NeedsPermissionError();
      throw e;
    }
  }

  async setAutoReply(r: AutoReply): Promise<void> {
    try {
      await this.api("PATCH", "/me/mailboxSettings", { automaticRepliesSetting: toGraphSetting(r) });
    } catch (e) {
      if (isPermissionError(e)) throw new NeedsPermissionError();
      throw e;
    }
  }

  private inboxFolders() {
    const id = this.systemFolderId("inbox");
    return id ? [id] : undefined;
  }

  systemFolderId(kind: SystemFolder) {
    const id = this.folderIdByKind.get(kind);
    return id ? `${this.account.id}:${id}` : undefined;
  }
}
