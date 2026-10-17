// The store's state shape and the types its callers share.

import type { AutoRule, RuleAction } from "@/lib/rules";
import type { Account, Bucket, CalEvent, CalSuggestion, CalendarInfo, Category, Email, Folder, SenderHabit, Triage } from "@/lib/types";
import type { SendRequest } from "@/lib/mail/provider";
import type { BulkOp, BulkOptions, BulkResult, UndoEntry } from "@/lib/mail/bulk";
import type { NewEvent, Rsvp } from "@/lib/calendar/provider";
import type { AutoReply } from "@/lib/mail/auto-replies";
import type { ME } from "@/lib/mail/mock-data";
import type { DateFind } from "@/lib/ai/dates";
import type { MailSection } from "@/lib/sections";
import type { MailSignature, SignatureDefaults } from "@/lib/signature";
import type { ScheduledSend } from "@/lib/mail/scheduled";
import type { Lesson } from "./learning";

export type View =
  | { kind: "brief" }
  | { kind: "triage" }
  | { kind: "calendar" }
  | { kind: "inbox" }
  | { kind: "starred" }
  | { kind: "snoozed" }
  | { kind: "scheduled" }
  | { kind: "folder"; folderId: string };

/** What a mail action did: `done` changed on the server, `failed` were put back. Emails already there or already on their way are in neither. */
/** What the open composer shows, for the assistant (body as plain text). */
export interface ComposeEditPatch {
  subject?: string;
  body?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  addFiles?: { filename: string; mimeType: string; base64: string; size: number }[];
}
/** `session` is the compose session it was made for; the composer ignores edits for another one. */
export type ComposeEdit = ComposeEditPatch & { seq: number; session: number };

export type ComposeOpened = "opened" | "kept" | "replaced";
export interface ComposeView { fromAccountId?: string; to: string; cc: string; bcc: string; subject: string; body: string }

export interface ActionResult {
  done: string[];
  failed: string[];
  error?: string;
}

export type Compose = {
  mode: "blank" | "ai";
  replyTo?: string;
  forward?: boolean;
  /** Reply to everyone on the email (with replyTo). */
  all?: boolean;
  /** Fields filled in up front (the assistant's drafts). */
  prefill?: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string; /** `body` is already HTML (a reopened draft), not Markdown. */ bodyIsHtml?: boolean };
  /** An existing saved draft this compose session edits. */
  draft?: { id: string; emailId?: string };
  /** Files to start the draft with. */
  attachments?: { filename: string; mimeType: string; base64: string; size: number }[];
  /** The account to send from, when the user picked one before the draft existed. */
  fromAccountId?: string;
  /** Reopened from Scheduled: keep this time. */
  scheduledAt?: number;
  /** A reopened draft's own signature (images as data: URIs); the composer uses it instead of the default one. */
  signatureHtml?: string;
};

export type BackfillState = { loaded: number; total?: number; running: boolean; error?: string };

/** Search across all mail: "all" is every folder but Spam and Trash, "here" the view the search was started from. */
export type SearchScope = "all" | "here";

/** The answer a search shows: the latest one that arrived for the current query, scope and account. */
export interface SearchResults {
  /** The query, scope and account it answers (see searchKey). */
  key: string;
  /** The query it answers, trimmed. In-memory mail is matched against this too. */
  query: string;
  /** Keyword index hits, newest first (none for a one-letter query). */
  ids: string[];
  /** Best matches by keywords and meaning, best first; empty without meaning-based search. */
  best: string[];
  /** Hits (and best matches) that weren't loaded when they arrived: slim cached rows, by id. Put into `emails` by adoptResults. */
  rows: Record<string, Email>;
  /** The keyword index is still being built, so some older mail may be missing. */
  indexing: boolean;
  /** The index had more hits than it returned. */
  capped: boolean;
}

/** Search mode: on while the search box has text in a mail view. Never persisted. */
export interface SearchState {
  scope: SearchScope;
  /** Where the search started; clearing it goes back there. */
  origin: { selectedId: string | null; checked: Set<string>; todayKept: Set<string> };
  /** Null until the first answer arrives; an answer stays until the next one lands. */
  results: SearchResults | null;
}

/** Why an email left Needs you for good without leaving the inbox: Done, aged out, or you replied. */
export type Resolution = { at: number; why: "done" | "aged" | "replied" };

export interface MailState {
  me: typeof ME;
  accounts: Account[];
  folders: Folder[];
  emails: Email[];
  triage: Record<string, Triage>;
  /** Bucket corrections from the user (drag between lanes, "Teach zMail"). */
  overrides: Record<string, Bucket>;
  /** Emails whose override came from a lane rule, not from the user. */
  laneRuled: Record<string, Bucket>;
  /** Category corrections ("Teach zMail: this is Promos"); also hints for the sender's future mail. */
  categoryOverrides: Record<string, Category>;
  /** "Always file sender in…" rules: sender address → folder id. */
  rules: Record<string, string>;
  /** Automatic rules: sender/subject rules that act on new inbox mail without asking. */
  autoRules: AutoRule[];
  /** Ids an automatic rule already acted on; stops Undo from being re-applied. */
  autoHandled: Record<string, true>;
  habits: Map<string, SenderHabit>;
  /** Email ids whose folder suggestion the user dismissed. */
  dismissed: Set<string>;
  snoozed: Record<string, number>;
  /** Emails waiting to be sent later (saved as drafts until then). */
  scheduled: ScheduledSend[];
  /** Senders whose remote images load automatically. */
  imageSenders: Set<string>;
  /** Named HTML signatures. */
  signatures: MailSignature[];
  /** Per account: which signature goes on new mail and on replies/forwards. */
  signatureDefaults: Record<string, SignatureDefaults>;
  /** Your own sections (Bills, School…), sorted alongside the buckets. */
  sections: MailSection[];
  /** Section corrections: email id → section id, or null for "not in a section". */
  sectionOverrides: Record<string, string | null>;
  /** Emails out of Needs you for good (Done, aged out, replied to); a re-sort doesn't bring them back. */
  resolved: Record<string, Resolution>;
  /**
   * What your corrections teach the model, saved with the sender and subject so
   * they keep working after the email itself is deleted or ages out.
   */
  lessons: Lesson[];
  /** Dates the writing model found in section mail (empty = looked, found none). */
  dateFinds: Record<string, DateFind[]>;
  /** Sender addresses (lowercase) the user has turned date suggestions off for. */
  noDateSenders: Record<string, true>;
  /** "Not now" taps on date suggestions per sender; two turn that sender off. */
  dateDismissals: Record<string, string[]>;
  view: View;
  selectedId: string | null;
  /** Inbox emails opened during this Today visit: they hold their place in Today's order so K can go back. Not persisted. */
  todayKept: Set<string>;
  /** Account shown on Today, Triage and Calendar; null = all accounts. */
  accountFilter: string | null;
  /** Emails ticked for bulk actions (separate from the one open in the reader). */
  checked: Set<string>;
  /** Last ticked row, the start of a ⇧-click range. */
  checkAnchor: string | null;
  /** The bulk bar's snooze menu (opened by S while selecting). */
  bulkSnoozeOpen: boolean;
  compose: Compose | null;
  /** Which compose session is open: changes each time openCompose opens a different one, so async work can tell it still owns the composer. */
  composeSession: number;
  /** Email ids awaiting a destination in the folder picker. */
  movePicker: { ids: string[]; mode: "move" | "rule" } | null;
  query: string;
  /** error: the whole sort failed. failed: some emails couldn't be sorted (the rest were), with the last reason. */
  sorting: { running: boolean; done: number; total: number; at?: number; model?: string; error?: string; failed?: { count: number; error: string } };
  /** Background Inbox backfill per account (not persisted): Inbox mail zMail has, of about `total`. */
  backfill: Record<string, BackfillState>;
  calendars: CalendarInfo[];
  hiddenCalendars: Set<string>;
  events: CalEvent[];
  calSuggestions: CalSuggestion[];
  /** User calendar edits on top of synced/seeded data (persisted). */
  calChanges: { added: CalEvent[]; deleted: string[]; resolved: string[] };
  /** Per-account sync status (errors surface in the sidebar). */
  accountStatus: Record<string, { state: "syncing" | "ok" | "error"; error?: string; at?: number }>;

  load: () => Promise<void>;
  /**
   * Triage the inbox. `onlyNew` skips emails that already have a saved result;
   * `staleSections` re-sorts only those sorted before the current sections.
   */
  sort: (opts?: { onlyNew?: boolean; staleSections?: boolean; ids?: string[]; skip?: Set<string> }) => Promise<void>;
  /**
   * After a correction: re-sort the same senders' other inbox mail (newest few each) with what you
   * just taught, a moment later so several quick corrections share one sort. Returns how many it will re-sort.
   */
  resortSendersOf: (ids: string[]) => number;
  setView: (v: View) => void;
  select: (id: string | null) => void;
  setAccountFilter: (id: string | null) => void;
  /** Rename, recolor or set the icon of an account. */
  updateAccount: (id: string, patch: Partial<Pick<Account, "label" | "icon" | "color">>) => Promise<void>;
  toggleCheck: (id: string) => void;
  /** Tick every row between the anchor and `id` in `order`. */
  checkRange: (id: string, order: string[]) => void;
  setChecked: (ids: string[]) => void;
  clearChecked: () => void;
  setBulkSnoozeOpen: (open: boolean) => void;
  /**
   * Open a compose session (null closes it). Over a message with unsaved changes it asks Save / Discard / Keep editing
   * first. Resolves "opened", "kept" (the user kept editing the unsaved one) or "replaced" (another open won first).
   */
  openCompose: (c: Compose | null) => Promise<ComposeOpened>;
  /** Open an email from a Drafts folder in the composer; false (after a toast) when it couldn't. `draftId` skips the provider lookup. */
  openDraft: (emailId: string, opts?: { scheduledAt?: number; draftId?: string }) => Promise<boolean>;
  /** The composer reports whether it has unsaved changes. */
  composeDirty: boolean;
  setComposeDirty: (dirty: boolean) => void;
  /** What the open composer shows, for the assistant. */
  composeView: ComposeView | null;
  setComposeView: (v: ComposeView | null) => void;
  /** The assistant's latest change to the open draft; the composer applies it when `seq` changes. */
  composeEdit: ComposeEdit | null;
  editCompose: (patch: ComposeEditPatch, session?: number) => void; // body is Markdown; to/cc/bcc replace the field; session defaults to the open one
  /** Set while the composer is asking "Save this draft?"; `then` runs after Save or Discard, `cancel` when it ends any other way (Keep editing). */
  composeCloseAsk: { then: () => void; cancel?: () => void } | null;
  setComposeCloseAsk: (ask: { then: () => void; cancel?: () => void } | null) => void;
  /** Close the composer, asking first when it has unsaved changes. */
  closeCompose: (then?: () => void, cancel?: () => void) => void;
  openMovePicker: (p: { ids: string[]; mode: "move" | "rule" } | null) => void;
  /** Search box text. Non-empty in a mail view (not Calendar or Scheduled) turns on search mode; empty again goes back where the search started. */
  setQuery: (q: string) => void;
  /** Search mode, or null. */
  search: SearchState | null;
  setSearchScope: (scope: SearchScope) => void;
  /**
   * Put these search results into `emails` if they aren't loaded, so they can be opened and acted on like any
   * email. They're held (see store/held.ts): counts, lists, triage and saving leave them out, and they're
   * dropped again when the search ends.
   */
  adoptResults: (ids: Iterable<string>) => void;
  /**
   * Mail actions change the screen at once and put back whatever the server refuses.
   * They resolve with what happened instead of throwing.
   */
  move: (ids: string[], folderId: string, opts?: { learn?: boolean }) => Promise<ActionResult>;
  /** Create a folder by path ("Kids/Sam"), and any missing parents, on the account's server. Resolves with the deepest folder. */
  createFolder: (accountId: string, path: string) => Promise<Folder>;
  /** A Gmail grouping (a label prefix like "Bills" in "Bills/Visa") made into a real label so mail can be filed there; other folders come back as they are. */
  realizeFolder: (folderId: string) => Promise<Folder>;
  archive: (ids: string[]) => Promise<ActionResult>;
  trash: (ids: string[]) => Promise<ActionResult>;
  spam: (ids: string[]) => Promise<ActionResult>;
  snooze: (ids: string[], until: number) => void;
  unsnooze: (ids: string[]) => void;
  toggleStar: (id: string) => Promise<ActionResult>;
  setRead: (ids: string[], read: boolean) => Promise<ActionResult>;
  acceptSuggestion: (ids: string[]) => Promise<ActionResult>;
  dismissSuggestion: (ids: string[]) => void;
  setBucket: (ids: string[], bucket: Bucket) => void;
  /** Take emails out of Needs you without moving them (Done also marks them read). Teaches nothing. */
  resolve: (ids: string[], why: Resolution["why"]) => void;
  unresolve: (ids: string[]) => void;
  /** Your correction: it also teaches the sorting model, unless learn is false (display only). */
  setCategory: (ids: string[], category: Category, opts?: { learn?: boolean }) => void;
  addRule: (sender: string, folderId: string) => void;
  removeRule: (sender: string) => void;
  addAutoRule: (input: { from: string; subjectAny?: string[]; action: RuleAction }) => AutoRule;
  setAutoRuleEnabled: (id: string, on: boolean) => void;
  removeAutoRule: (id: string) => void;
  /** Re-pin inbox mail to lane rules' lanes; returns how many emails changed lane. */
  applyLaneRules: () => number;
  allowImagesFrom: (sender: string) => void;
  addSignature: (name: string, html?: string) => string;
  updateSignature: (id: string, patch: Partial<Omit<MailSignature, "id">>) => void;
  removeSignature: (id: string) => void;
  setSignatureDefault: (accountId: string, which: keyof SignatureDefaults, id: string | null) => void;
  clearOverrides: () => void;
  addSection: (input: Omit<MailSection, "id">) => string;
  updateSection: (id: string, patch: Partial<Omit<MailSection, "id">>) => void;
  removeSection: (id: string) => void;
  /** Put emails in a section (null = take them out of any section). */
  setSection: (ids: string[], sectionId: string | null) => void;
  toggleCalendar: (id: string) => void;
  /** Add a suggestion to a calendar (real calendars get a real event). */
  acceptCalSuggestion: (id: string, response?: "yes" | "maybe", calendarId?: string) => Promise<void>;
  dismissCalSuggestion: (id: string) => void;
  /** Allow date suggestions from a sender again. */
  removeNoDateSender: (address: string) => void;
  /** Gone from the calendar at once; back again (and rejects) if the server refuses. */
  deleteEvent: (id: string) => Promise<void>;
  /**
   * Delete behind an Undo: gone from the calendar at once, the server delete waits `ms` (5 s). undo() in that time puts
   * it back and nothing reaches the server. `done` is true once deleted, false if undone, and rejects (event back) if the
   * server refused. Null when there's no such event or its delete is already held.
   */
  holdDeleteEvent: (id: string, ms?: number) => { undo: () => void; done: Promise<boolean> } | null;
  addAccount: (account: Account) => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
  /** Pull new mail and calendar changes from every connected account. */
  refresh: () => Promise<void>;
  send: (accountId: string, msg: SendRequest) => Promise<void>;
  saveDraft: (accountId: string, msg: SendRequest, draftId?: string) => Promise<{ draftId: string; messageId: string }>;
  sendDraft: (accountId: string, msg: SendRequest, draftId: string) => Promise<void>;
  deleteDraft: (accountId: string, draftId: string, messageId?: string) => Promise<void>;
  /** Save `msg` as a draft and send it at `sendAt` (zMail sends it then; Outlook's server when OUTLOOK_SERVER_HOLD). */
  scheduleMessage: (accountId: string, msg: SendRequest, sendAt: number, draft?: { id: string; emailId?: string }) => Promise<ScheduledSend>;
  /** Stop a scheduled send; the email stays in Drafts. */
  cancelScheduled: (id: string) => Promise<void>;
  sendScheduledNow: (id: string) => Promise<void>;
  /** Unschedule and reopen it in the composer, keeping its time. */
  editScheduled: (id: string) => Promise<void>;
  /** Send whatever local scheduled mail is due (one run at a time). */
  runDueScheduled: () => Promise<void>;
  /** Attachment bytes (standard base64) from the email's provider. */
  attachmentData: (emailId: string, attachmentId: string) => Promise<string>;
  /** The email's cid: images by cid; empty when the provider can't fetch them. */
  inlineImages: (emailId: string) => Promise<Map<string, string>>;
  /** Create an event; Zoom links are generated first and added to the invite. */
  createEvent: (e: NewEvent) => Promise<CalEvent>;
  respondEvent: (e: CalEvent, response: Rsvp) => Promise<void>;
  /** The app-level "new event" sheet (prefilled from a time slot or an email). */
  newEvent: Partial<NewEvent> | null;
  openNewEvent: (prefill: Partial<NewEvent> | null) => void;
  /** An email in full: the one in the store, or fetched when only its header is known. */
  ensureEmail: (ref: { id: string; accountId: string }) => Promise<Email>;
  /**
   * The full body (html and untrimmed text) of a listed email: list rows from the cache are
   * slim (`bodyTrimmed`). Reads the cached row, else the provider. Anything that needs the
   * whole body must call this first.
   */
  ensureBody: (id: string) => Promise<Email | undefined>;
  /** Apply one action to many emails in provider-sized batches; stops at the first failure. */
  bulkApply: (emails: Email[], op: BulkOp, opts?: BulkOptions) => Promise<BulkResult>;
  /** Put emails back the way `bulkApply` found them. */
  bulkUndo: (undo: UndoEntry[], op: BulkOp) => Promise<BulkResult>;

  /** Automatic replies (out of office) by account id; reloaded each launch, never persisted. */
  autoReplies: Record<string, AutoReply | "needs-permission" | "error">;
  /** Read the account's automatic replies from the server (nothing when the provider can't). */
  loadAutoReply: (accountId: string) => Promise<void>;
  /** Write them, then read them back. Rethrows; NeedsPermissionError also marks the account. */
  saveAutoReply: (accountId: string, r: AutoReply) => Promise<void>;
}
