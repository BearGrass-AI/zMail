// Pure Microsoft Graph ↔ zMail mapping (mail folders, messages, calendar).

import type { Attachment, CalEvent, CalendarInfo, Contact, Email, Folder, SystemFolder } from "@/lib/types";
import { parseListUnsubscribe } from "@/lib/mail/unsubscribe";

// ---- API shapes (subset) ---------------------------------------------------------

export interface GMailFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount?: number;
  unreadItemCount?: number;
  totalItemCount?: number;
}

export interface GRecipient {
  emailAddress: { name?: string; address?: string };
}

export interface GMsg {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: GRecipient;
  toRecipients?: GRecipient[];
  ccRecipients?: GRecipient[];
  bccRecipients?: GRecipient[];
  receivedDateTime: string;
  isRead?: boolean;
  flag?: { flagStatus: "notFlagged" | "flagged" | "complete" };
  bodyPreview?: string;
  body?: { contentType: "html" | "text"; content: string };
  parentFolderId: string;
  hasAttachments?: boolean;
  internetMessageId?: string;
  categories?: string[];
  /** Only requested by getMessage (single message). */
  internetMessageHeaders?: { name: string; value: string }[];
}

export interface GAttachment {
  id: string;
  name: string;
  contentType?: string;
  size: number;
  isInline?: boolean;
  contentBytes?: string;
}

export interface GCalendarInfo {
  id: string;
  name: string;
  hexColor?: string;
  isDefaultCalendar?: boolean;
}

export interface GCalEvent {
  id: string;
  subject?: string;
  isCancelled?: boolean;
  isAllDay?: boolean;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  location?: { displayName?: string };
  attendees?: { emailAddress: { name?: string; address?: string }; type?: string }[];
  organizer?: { emailAddress: { name?: string; address?: string } };
  isOrganizer?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeeting?: { joinUrl?: string } | null;
}

/** Graph well-known folder names → zMail system folders. */
export const WELL_KNOWN: Record<string, SystemFolder> = {
  inbox: "inbox",
  drafts: "drafts",
  sentitems: "sent",
  deleteditems: "trash",
  junkemail: "spam",
  archive: "archive",
  conversationhistory: "history",
};

const SYSTEM_ORDER: SystemFolder[] = ["inbox", "drafts", "sent", "archive", "trash", "spam", "history"];

/**
 * Graph folders (flattened, with parentFolderId) → zMail folders. `systemIds`
 * maps the real ids of well-known folders. Top-level folders hang under the
 * mailbox root, which Graph reports as their parent; we drop that link.
 */
export function foldersToTree(accountId: string, folders: GMailFolder[], systemIds: Record<string, SystemFolder>): Folder[] {
  const known = new Set(folders.map((f) => f.id));
  const fid = (id: string) => `${accountId}:${id}`;
  const out = folders.map<Folder>((f) => ({
    id: fid(f.id),
    accountId,
    name: f.displayName,
    parentId: f.parentFolderId && known.has(f.parentFolderId) ? fid(f.parentFolderId) : undefined,
    system: systemIds[f.id],
    unread: f.unreadItemCount,
  }));
  // System folders are never nested in practice; keep them first and ordered.
  return out.sort((a, b) => {
    const ra = a.system ? SYSTEM_ORDER.indexOf(a.system) : 99;
    const rb = b.system ? SYSTEM_ORDER.indexOf(b.system) : 99;
    return ra - rb || a.name.localeCompare(b.name);
  });
}

const contact = (r?: GRecipient): Contact => ({
  name: r?.emailAddress.name || r?.emailAddress.address || "Unknown",
  address: (r?.emailAddress.address ?? "").toLowerCase(),
});

function htmlToText(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style,script").forEach((n) => n.remove());
  return (doc.body.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function messageToEmail(accountId: string, m: GMsg, attachments: GAttachment[] = []): Email {
  const html = m.body?.contentType === "html" ? m.body.content : undefined;
  const text = m.body?.contentType === "text" ? m.body.content : html ? htmlToText(html) : m.bodyPreview ?? "";
  const hdr = (name: string) => m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
  const unsubscribe = parseListUnsubscribe(hdr("list-unsubscribe"), hdr("list-unsubscribe-post"));
  const autoSubmitted = hdr("auto-submitted");
  const autoReply =
    (autoSubmitted !== undefined && autoSubmitted.trim().toLowerCase() !== "no") || hdr("x-autoreply") !== undefined || hdr("x-autorespond") !== undefined;
  return {
    id: m.id,
    accountId,
    threadId: m.conversationId ?? m.id,
    folderId: `${accountId}:${m.parentFolderId}`,
    from: contact(m.from),
    to: (m.toRecipients ?? []).map(contact),
    cc: (m.ccRecipients ?? []).map(contact),
    bcc: (m.bccRecipients ?? []).map(contact),
    subject: m.subject || "(no subject)",
    snippet: (m.bodyPreview ?? text).slice(0, 160),
    text,
    html,
    date: m.receivedDateTime,
    unread: m.isRead === false,
    starred: m.flag?.flagStatus === "flagged",
    labels: m.categories ?? [],
    attachments: attachments
      .filter((a) => !a.isInline)
      .map<Attachment>((a) => ({ id: a.id, filename: a.name, mimeType: a.contentType ?? "application/octet-stream", size: a.size })),
    rfc: { messageId: m.internetMessageId },
    ...(unsubscribe ? { unsubscribe } : {}),
    ...(autoReply ? { autoReply } : {}),
  };
}

// ---- calendar ---------------------------------------------------------------------------

/** Graph color names / hex → hue. */
export function graphHue(hex?: string, fallback = 255): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
  if (!m) return fallback;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return fallback;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

export function calendarToInfo(accountId: string, c: GCalendarInfo): CalendarInfo {
  return { id: `${accountId}:${c.id}`, accountId, name: c.name, source: "outlook", hue: graphHue(c.hexColor, 255), ...(c.isDefaultCalendar ? { primary: true } : {}) };
}

/** calendarView is requested with Prefer: outlook.timezone="UTC", so times carry no offset. */
const utc = (dt: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(dt) ? dt : `${dt}Z`).toISOString();

const localMidnight = (dt: string) => new Date(`${dt.slice(0, 10)}T00:00:00`).toISOString();

export function eventToCal(calendarId: string, e: GCalEvent): CalEvent | null {
  if (e.isCancelled) return null;
  const organizer = !e.isOrganizer ? e.organizer?.emailAddress.address?.toLowerCase() : undefined;
  return {
    id: `${calendarId}:${e.id}`,
    calendarId,
    title: e.subject || "(no title)",
    // All-day events are dates, not instants: anchor them to local midnight.
    start: e.isAllDay ? localMidnight(e.start.dateTime) : utc(e.start.dateTime),
    end: e.isAllDay ? localMidnight(e.end.dateTime) : utc(e.end.dateTime),
    location: e.location?.displayName || undefined,
    video: !!e.isOnlineMeeting,
    joinUrl: e.onlineMeeting?.joinUrl,
    allDay: !!e.isAllDay,
    attendees: (e.attendees ?? [])
      .map((a) => ({ name: a.emailAddress.name || a.emailAddress.address || "", address: (a.emailAddress.address ?? "").toLowerCase() }))
      .filter((a) => a.address && a.address !== organizer),
    related: organizer ? { from: organizer } : undefined,
  };
}

/** A file sent with a message; an inline image carries the contentId its cid: reference names. */
export interface GFileAttachment {
  "@odata.type": string;
  name: string;
  contentType: string;
  contentBytes: string;
  isInline?: boolean;
  contentId?: string;
}

/** Graph sendMail payload. */
export function toGraphMessage(msg: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inline?: { cid: string; filename: string; mimeType: string; base64: string }[];
  attachments?: { filename: string; mimeType: string; base64: string }[];
}) {
  const rcpt = (addrs: string[] = []) => addrs.map((address) => ({ emailAddress: { address } }));
  return {
    subject: msg.subject,
    body: msg.html ? { contentType: "HTML", content: msg.html } : { contentType: "Text", content: msg.text },
    toRecipients: rcpt(msg.to),
    ccRecipients: rcpt(msg.cc),
    bccRecipients: rcpt(msg.bcc),
    attachments: [
      ...(msg.attachments ?? []).map<GFileAttachment>((a) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.filename,
        contentType: a.mimeType,
        contentBytes: a.base64,
      })),
      ...(msg.inline ?? []).map<GFileAttachment>((i) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: i.filename,
        contentType: i.mimeType,
        contentBytes: i.base64,
        isInline: true,
        contentId: i.cid,
      })),
    ],
  };
}

/** Put our reply above the quoted original Outlook generated with createReply. */
export function spliceReply(draftHtml: string | undefined, ours: string): string {
  if (!draftHtml) return ours;
  return /<body[^>]*>/i.test(draftHtml) ? draftHtml.replace(/<body[^>]*>/i, (m) => `${m}${ours}`) : `${ours}${draftHtml}`;
}
