// The seam between zMail and a mailbox backend. Gmail (labels) and Microsoft
// Graph (folders) both implement this; the mock implements it in memory.

import type { Account, Email, Folder } from "@/lib/types";
import type { OutgoingAttachment } from "@/lib/google/gmail-map";
import type { InlineImage } from "@/lib/signature";
import type { MailQuery } from "@/lib/ai/assistant/query";
import type { AutoReply } from "@/lib/mail/auto-replies";

export interface SearchPage {
  ids: string[];
  /** Header rows when the backend returns them with the search (Graph, mock). */
  headers?: Email[];
  next?: string;
  /** Server's total estimate, when it gives one (Gmail). */
  estimate?: number;
  /** Most results the server returns for this query in all (Outlook $search: 1,000). */
  limit?: number;
  /** Rows the server returned on this page before local filtering, when that differs from ids. */
  scanned?: number;
}

/** Per-batch result: ids that no longer exist, and ids the server refused. */
export interface BatchOutcome {
  skipped: string[];
  failed: string[];
}

export interface SendRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Plain-text body (also the text/plain alternative when html is set). */
  text: string;
  /** HTML body, e.g. with an HTML signature. */
  html?: string;
  /** Images the HTML references by cid:. */
  inline?: InlineImage[];
  /** Email being replied to (for threading). */
  replyTo?: Email;
  attachments?: OutgoingAttachment[];
}

/** What changed since the last sync. `full`: the provider re-synced from scratch; read the cache instead. */
export type SyncChanges = { full: true } | { full: false; changed: Email[]; removed: string[] };

export interface MailProvider {
  /** Server-side search across the whole mailbox (spam and trash only when the query names them). */
  search(q: MailQuery, folders: Folder[], page?: string): Promise<SearchPage>;
  /** Light rows (partial: true, no body) for up to 100 ids. Missing ids are left out. */
  headers(ids: string[]): Promise<Email[]>;
  /** One message in full; also cached locally. */
  getMessage(id: string): Promise<Email>;
  /** Most ids one batch call can take. */
  readonly batchSize: number;
  batchMove(emails: Email[], folderId: string): Promise<BatchOutcome>;
  /**
   * Put each email's folder labels back exactly as recorded (undo of a move). Optional:
   * providers where a plain move back is already exact leave it out. Never throws for
   * per-request failures; reports them in `failed`.
   */
  restoreLabels?(entries: { id: string; labels: string[] }[]): Promise<BatchOutcome>;
  batchSetRead(ids: string[], read: boolean): Promise<BatchOutcome>;
  batchSetStarred(ids: string[], starred: boolean): Promise<BatchOutcome>;

  readonly account: Account;
  listFolders(): Promise<Folder[]>;
  /**
   * Create one folder named `name` under `parentId` (top level without it). A folder that already
   * exists there is returned instead of failing.
   */
  createFolder?(name: string, parentId?: string): Promise<Folder>;
  /**
   * Re-read the unread counts of a few folders (at most 5) without a full folder
   * sync. Returns folder id → unread and updates the provider's folder cache.
   */
  refreshCounts?(folderIds: string[]): Promise<Record<string, number>>;
  /** Recent messages across folders, newest first. */
  listMessages(opts?: { folderId?: string; limit?: number }): Promise<Email[]>;
  /** Sync with the server and return only what changed (new or modified mail, removed ids). */
  syncChanges?(): Promise<SyncChanges>;
  /**
   * Fetch one page of Inbox mail not yet cached (newest first), caching it.
   * Pass the previous `next` as the cursor; no `next` means the Inbox is exhausted.
   * `failed` counts mail on the page that was returned but couldn't be cached whole
   * (e.g. its attachment list failed), so this page should be listed again later.
   */
  backfillInbox?(cursor?: string): Promise<{ emails: Email[]; next?: string; total?: number; failed?: number }>;
  move(emailId: string, folderId: string): Promise<void>;
  setRead(emailId: string, read: boolean): Promise<void>;
  setStarred(emailId: string, starred: boolean): Promise<void>;
  send(msg: SendRequest): Promise<void>;
  /** Create (no draftId) or replace (draftId) a draft in the account's Drafts. Returns the draft id to pass back next time. */
  saveDraft?(msg: SendRequest, draftId?: string): Promise<{ draftId: string; messageId: string }>;
  /** Update the saved draft with `msg`, then send it. */
  sendDraft?(msg: SendRequest, draftId: string): Promise<void>;
  deleteDraft?(draftId: string): Promise<void>;
  /** Send a draft exactly as saved on the server. */
  sendSavedDraft?(draftId: string): Promise<void>;
  /** Outlook: save `msg` into the draft with a deferred-send time and submit it; the server sends it at `sendAt`. */
  holdOnServer?(msg: SendRequest, draftId: string, sendAt: number): Promise<void>;
  /** Outlook: take a held message back to Drafts (cancel). */
  releaseFromServer?(messageId: string): Promise<void>;
  /** Drop any quote remembered for a draft that is being reopened from the server (its body already contains it). */
  forgetDraftQuote?(draftId: string): void;
  /** A reopened reply draft's quoted original (what follows zMail's signature), for saves to put back under our text. */
  keepDraftQuote?(draftId: string, quote: string): void;
  /** The draft id for an email in the Drafts folder (Gmail ids differ; Outlook's are the same). */
  draftIdFor?(messageId: string): Promise<string | undefined>;
  /** Attachment bytes as standard base64. */
  getAttachment?(emailId: string, attachmentId: string): Promise<string>;
  /** The email's cid: images. Optional; providers without it show placeholders. */
  inlineImages?(emailId: string): Promise<EmbeddedImage[]>;

  /** Automatic replies (out of office). Throws NeedsPermissionError when the account must sign in again. */
  getAutoReply?(): Promise<AutoReply>;
  setAutoReply?(r: AutoReply): Promise<void>;
}

/** An image an email's HTML references by cid:, as standard base64. */
export interface EmbeddedImage {
  cid: string;
  mimeType: string;
  base64: string;
}
