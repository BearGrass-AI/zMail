// Core domain types shared by mail providers, the AI layer and the UI.

export type AccountKind = "gmail" | "m365" | "mock";

export interface Account {
  id: string;
  kind: AccountKind;
  name: string;
  address: string;
  /** Your name for it ("Personal", "Work"); falls back to the provider. */
  label?: string;
  /** Small square image (data: URL) shown instead of the letter tile. */
  icon?: string;
  /** CSS color for the letter tile and account dots. */
  color?: string;
}

export type SystemFolder = "inbox" | "drafts" | "sent" | "archive" | "spam" | "trash" | "snoozed" | "clutter" | "history";

export interface Folder {
  id: string;
  accountId: string;
  name: string;
  /** Parent folder id for nested folders (Outlook subfolders, Gmail "a/b" labels). */
  parentId?: string;
  /** System folders are not offered as "move to" targets. */
  system?: SystemFolder;
  /** Server-reported unread count (Graph unreadItemCount / Gmail messagesUnread). */
  unread?: number;
}

export interface Contact {
  name: string;
  address: string;
}

export interface Attachment {
  /** Provider attachment id (Gmail attachmentId / Graph attachment id). */
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Inline parts (cid: images) aren't listed as attachments in the UI. */
  inline?: boolean;
}

export interface Email {
  id: string;
  accountId: string;
  threadId: string;
  folderId: string;
  from: Contact;
  to: Contact[];
  cc?: Contact[];
  bcc?: Contact[];
  attachments?: Attachment[];
  /** RFC 5322 headers used to thread replies. */
  rfc?: { messageId?: string; references?: string };
  subject: string;
  snippet: string;
  /** Plain-text body used for AI state. */
  text: string;
  /** Optional sanitized HTML body for rendering. */
  html?: string;
  date: string; // ISO
  unread: boolean;
  starred: boolean;
  labels: string[];
  /** Header row from an assistant search: no body yet. Open it with ensureEmail. */
  partial?: boolean;
  /** List rows omit html and cap text; load the full email with ensureBody. */
  bodyTrimmed?: boolean;
  /** From the sender's List-Unsubscribe headers (untrusted): an https URL, a mailto, and whether RFC 8058 one-click applies. */
  unsubscribe?: { http?: string; mailto?: string; oneClick: boolean };
  /** An automatic reply (out of office), from headers. */
  autoReply?: boolean;
}

/** Where the user historically filed mail from a sender. */
export interface SenderHabit {
  sender: string; // lowercased address
  total: number;
  byFolder: Record<string, number>; // folderId -> count
}

// ---- Triage output ---------------------------------------------------------

export const BUCKETS = ["needs_you", "worth_skim", "ready_archive"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const CATEGORIES = [
  "primary",
  "transactions",
  "updates",
  "promotions",
  "social",
  "newsletters",
  "security",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface FolderSuggestion {
  folderId: string;
  probability: number;
  /** Supporting evidence from history, e.g. 12 of 13 past emails. */
  evidence?: { filed: number; total: number };
}

export interface Triage {
  emailId: string;
  bucket: Bucket;
  bucketProbs: Record<Bucket, number>;
  category: Category;
  /** 0..1 probability-weighted urgency. */
  urgency: number;
  needsReply: number;
  folder?: FolderSuggestion;
  /** One of your sections (MailSection id), if the email fits one. */
  section?: string;
  /** Which sections it was sorted against (see sectionsKey). */
  sectionsKey?: string;
  model: string;
}

// ---- Calendar ----------------------------------------------------------------

export interface CalendarInfo {
  id: string;
  accountId: string;
  name: string;
  source: "google" | "outlook" | "mock";
  hue: number;
  /** The account's main calendar (Google "primary", Outlook "default"). */
  primary?: boolean;
}

export interface CalEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string; // ISO
  end: string; // ISO
  location?: string;
  video?: boolean;
  /** Teams / Meet / Zoom link, when known. */
  joinUrl?: string;
  allDay?: boolean;
  attendees: Contact[];
  /** Optional color override (hue) for this event. */
  hue?: number;
  /** Link to an email thread: matched by sender address and/or subject text. */
  related?: { from?: string; subject?: string };
}

/** Calendar items zMail found in email: invites, extracted bookings, AI suggestions. */
export interface CalSuggestion {
  id: string;
  kind: "invite" | "extracted" | "block";
  title: string;
  detail: string;
  start: string;
  end: string;
  calendarId: string;
  emailSubject?: string;
  allDay?: boolean;
  /** Found by reading an email in one of your sections. */
  emailId?: string;
  sectionId?: string;
  /** "payment due", "event", "deadline" */
  label?: string;
  /** The line in the email the date came from. */
  quote?: string;
}
