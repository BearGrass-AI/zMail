// Pure Gmail API ↔ zMail mapping. No I/O, so it can be tested against
// recorded API responses.

import type { Attachment, Contact, Email, Folder } from "@/lib/types";
import type { InlineImage } from "@/lib/signature";
import { parseListUnsubscribe } from "@/lib/mail/unsubscribe";

// ---- API shapes (subset) ---------------------------------------------------------

export interface GLabel {
  id: string;
  name: string;
  type: "system" | "user";
  messagesUnread?: number;
}

export interface GPart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size: number; data?: string; attachmentId?: string };
  parts?: GPart[];
}

export interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string; // ms since epoch, as a string
  payload: GPart;
}

// ---- labels → folder tree ------------------------------------------------------------

const SYSTEM: Record<string, Folder["system"]> = {
  INBOX: "inbox",
  DRAFT: "drafts",
  SENT: "sent",
  SPAM: "spam",
  TRASH: "trash",
};

/** Folder id for a Gmail label within an account. */
export const labelFolderId = (accountId: string, labelId: string) => `${accountId}:${labelId}`;
/** Gmail has no Archive label: archived mail is simply "not in Inbox". */
export const archiveFolderId = (accountId: string) => `${accountId}:ARCHIVE`;

/**
 * Gmail labels become a folder tree: "Finance/Taxes" nests Taxes under
 * Finance (creating a parent if Gmail has no label for it). Category, IMPORTANT,
 * STARRED and UNREAD labels are not folders.
 */
export function labelsToFolders(accountId: string, labels: GLabel[]): Folder[] {
  const out: Folder[] = [];
  for (const l of labels) {
    const system = SYSTEM[l.id];
    if (l.type === "system" && system) {
      out.push({ id: labelFolderId(accountId, l.id), accountId, name: titleCase(l.name), system, unread: l.messagesUnread });
    }
  }
  out.push({ id: archiveFolderId(accountId), accountId, name: "All Mail", system: "archive" });

  const users = labels.filter((l) => l.type === "user").sort((a, b) => a.name.localeCompare(b.name));
  const byPath = new Map<string, string>(); // "Finance/Taxes" → folder id
  for (const l of users) byPath.set(l.name, labelFolderId(accountId, l.id));
  const ensure = (path: string): string => {
    const existing = byPath.get(path);
    if (existing && out.some((f) => f.id === existing)) return existing;
    const parts = path.split("/");
    const name = parts[parts.length - 1];
    const parentId = parts.length > 1 ? ensure(parts.slice(0, -1).join("/")) : undefined;
    const label = users.find((u) => u.name === path);
    const id = existing ?? `${accountId}:path:${path}`;
    out.push({ id, accountId, name, parentId, unread: label?.messagesUnread });
    byPath.set(path, id);
    return id;
  };
  for (const l of users) ensure(l.name);
  return out;
}

function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

// ---- messages ---------------------------------------------------------------------------

export function decodeBase64Url(data: string, charset = "utf-8"): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes); // unknown charset label
  }
}

/** charset parameter of a part's Content-Type header (defaults to UTF-8). */
function partCharset(p: GPart) {
  const ct = p.headers?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
  return /charset="?([^";\s]+)"?/i.exec(ct)?.[1] ?? "utf-8";
}

export function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const CONTROL = /\p{Cc}+/gu;

/**
 * Parse `"Name" <addr>, other@x` into contacts. Takes the raw header: only display names are
 * RFC 2047-decoded (after parsing), so an encoded-word can't smuggle in an address, comma or line break.
 */
export function parseAddressList(value: string | undefined): Contact[] {
  if (!value) return [];
  const out: Contact[] = [];
  // Split on commas that are not inside quotes.
  for (const raw of value.match(/(?:"[^"]*"|[^,])+/g) ?? []) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(part);
    const address = (m ? m[2] : part).replace(CONTROL, "").trim().toLowerCase();
    const name = decodeMimeWords(m?.[1] || (m ? m[2] : part)).replace(CONTROL, " ").trim();
    out.push({ name, address });
  }
  return out;
}

/** Decode RFC 2047 encoded-words (=?UTF-8?B?...?= / =?UTF-8?Q?...?=). */
export function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, enc: string, data: string) => {
    try {
      const bytes =
        enc.toUpperCase() === "B"
          ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
          : Uint8Array.from(
              data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
              (c) => c.charCodeAt(0),
            );
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return data;
    }
  });
}

/** A header's value exactly as received; for addresses and message ids, which never carry encoded-words. */
function rawHeader(p: GPart, name: string) {
  return p.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function header(p: GPart, name: string) {
  const v = rawHeader(p, name);
  return v === undefined ? undefined : decodeMimeWords(v);
}

/** Image parts with a Content-ID ("<a@b>" -> "a@b"); data is inline base64url or fetched by attachmentId. */
export function inlineParts(root: GPart): { cid: string; mimeType: string; data?: string; attachmentId?: string }[] {
  const out: { cid: string; mimeType: string; data?: string; attachmentId?: string }[] = [];
  const walk = (p: GPart) => {
    const cid = (header(p, "Content-ID") ?? "").replace(/^[\s<]+|[>\s]+$/g, "");
    if (cid && p.mimeType.toLowerCase().startsWith("image/") && (p.body?.data || p.body?.attachmentId)) {
      out.push({ cid, mimeType: p.mimeType, data: p.body.data, attachmentId: p.body.attachmentId });
    }
    p.parts?.forEach(walk);
  };
  walk(root);
  return out;
}

/** Walk the MIME tree collecting text, html and attachments. */
export function extractBodies(root: GPart) {
  let text = "";
  let html = "";
  const attachments: Attachment[] = [];
  const walk = (p: GPart) => {
    const disposition = header(p, "Content-Disposition") ?? "";
    if (p.filename && p.body?.attachmentId) {
      attachments.push({
        id: p.body.attachmentId,
        filename: p.filename,
        mimeType: p.mimeType,
        size: p.body.size,
        inline: /inline/i.test(disposition) && !!header(p, "Content-ID"),
      });
    } else if (p.mimeType === "text/plain" && p.body?.data && !text) {
      text = decodeBase64Url(p.body.data, partCharset(p));
    } else if (p.mimeType === "text/html" && p.body?.data && !html) {
      html = decodeBase64Url(p.body.data, partCharset(p));
    }
    p.parts?.forEach(walk);
  };
  walk(root);
  return { text, html, attachments };
}

function htmlToText(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style,script").forEach((n) => n.remove());
  return (doc.body.textContent ?? "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Which zMail folder a message lives in, from its labels. */
export function folderForLabels(accountId: string, labelIds: string[], userLabelFolder: (id: string) => string | undefined) {
  if (labelIds.includes("TRASH")) return labelFolderId(accountId, "TRASH");
  if (labelIds.includes("SPAM")) return labelFolderId(accountId, "SPAM");
  if (labelIds.includes("INBOX")) return labelFolderId(accountId, "INBOX");
  if (labelIds.includes("DRAFT")) return labelFolderId(accountId, "DRAFT");
  for (const id of labelIds) {
    const f = userLabelFolder(id);
    if (f) return f;
  }
  if (labelIds.includes("SENT")) return labelFolderId(accountId, "SENT");
  return archiveFolderId(accountId);
}

export function messageToEmail(accountId: string, m: GMessage, userLabelFolder: (id: string) => string | undefined): Email {
  const labels = m.labelIds ?? [];
  const { text, html, attachments } = extractBodies(m.payload);
  const from = parseAddressList(rawHeader(m.payload, "From"))[0] ?? { name: "Unknown", address: "" };
  const date = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date(header(m.payload, "Date") ?? Date.now()).toISOString();
  const plain = text || (html ? htmlToText(html) : m.snippet ?? "");
  const unsubscribe = parseListUnsubscribe(header(m.payload, "List-Unsubscribe"), header(m.payload, "List-Unsubscribe-Post"));
  const autoSubmitted = header(m.payload, "Auto-Submitted");
  const autoReply =
    (autoSubmitted !== undefined && autoSubmitted.trim().toLowerCase() !== "no") ||
    header(m.payload, "X-Autoreply") !== undefined ||
    header(m.payload, "X-Autorespond") !== undefined;
  return {
    id: m.id,
    accountId,
    threadId: m.threadId,
    folderId: folderForLabels(accountId, labels, userLabelFolder),
    from,
    to: parseAddressList(rawHeader(m.payload, "To")),
    cc: parseAddressList(rawHeader(m.payload, "Cc")),
    bcc: parseAddressList(rawHeader(m.payload, "Bcc")),
    subject: header(m.payload, "Subject") ?? "(no subject)",
    snippet: decodeEntities(m.snippet ?? plain.slice(0, 140)),
    text: plain,
    html: html || undefined,
    date,
    unread: labels.includes("UNREAD"),
    starred: labels.includes("STARRED"),
    labels,
    attachments: attachments.filter((a) => !a.inline),
    rfc: { messageId: rawHeader(m.payload, "Message-ID"), references: rawHeader(m.payload, "References") },
    ...(unsubscribe ? { unsubscribe } : {}),
    ...(autoReply ? { autoReply } : {}),
  };
}

function decodeEntities(s: string) {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// ---- actions → label changes -----------------------------------------------------------

/** Label edits that move a message into `folderId` (Gmail's version of "move"). */
export function labelChangesForMove(accountId: string, labels: string[], folderId: string) {
  const prefix = `${accountId}:`;
  const target = folderId.startsWith(prefix) ? folderId.slice(prefix.length) : folderId;
  const userLabels = labels.filter((l) => l.startsWith("Label_"));
  if (target.startsWith("path:")) throw new Error("That folder is only a grouping in Gmail; choose one of its labels.");
  if (target === "SPAM") return { add: ["SPAM"], remove: ["INBOX"] };
  if (target === "TRASH") return { add: ["TRASH"], remove: ["INBOX"] };
  // Every other move also restores mail out of Trash/Spam (e.g. Undo after Delete).
  if (target === "ARCHIVE") return { add: [], remove: ["INBOX", "TRASH", "SPAM"] };
  if (target === "INBOX") return { add: ["INBOX"], remove: ["SPAM", "TRASH"] };
  // Filing into a label: add it, leave Inbox, drop other user labels (folder semantics).
  return { add: [target], remove: ["INBOX", "TRASH", "SPAM", ...userLabels.filter((l) => l !== target)] };
}

// ---- outgoing mail ----------------------------------------------------------------------------

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  /** Standard base64 (not url-safe). */
  base64: string;
}

export interface Outgoing {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  /** HTML body; sent as multipart/alternative alongside the text. */
  html?: string;
  /** Images the HTML references by cid:. */
  inline?: InlineImage[];
  inReplyTo?: string;
  references?: string;
  attachments?: OutgoingAttachment[];
}

const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(v)))}?=`);

const wrap76 = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");

/** Addresses go into headers verbatim; one with a line break would start a new header, so it's refused. */
function addressList(list: string[]) {
  if (list.some((a) => /[\r\n]/.test(a))) throw new Error("A recipient address contains a line break.");
  return list.join(", ");
}

/** Only well-formed `<id>` tokens of In-Reply-To / References; anything else is dropped. */
const messageIds = (v?: string) => v?.match(/<[^<>\s]+>/g) ?? [];

/** A MIME type from untrusted input (e.g. a forwarded attachment), or a safe default. */
const safeMimeType = (t: string) => (/^[\w.+-]+\/[\w.+-]+$/.test(t) ? t : "application/octet-stream");

/** `filename="…"` with quotes escaped, or RFC 2231 `filename*=UTF-8''…` for non-ASCII names. */
function fileParam(key: "name" | "filename", value: string) {
  const v = value.replace(CONTROL, "");
  if (/^[\x20-\x7e]*$/.test(v)) return `${key}="${v.replace(/["\\]/g, "\\$&")}"`;
  const pct = encodeURIComponent(v).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${key}*=UTF-8''${pct}`;
}

function utf8Base64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * RFC 5322 message. Structure, outermost first:
 * multipart/mixed (attachments) > multipart/alternative (text + html) > multipart/related (html + inline images).
 */
export function buildMime(msg: Outgoing, boundary = `zmail-${Math.random().toString(36).slice(2)}`): string {
  // In-Reply-To / References come from incoming mail: keep only well-formed ids.
  const inReplyTo = messageIds(msg.inReplyTo)[0];
  const references = [...messageIds(msg.references), ...(inReplyTo ? [inReplyTo] : [])];
  const headers = [
    `From: ${addressList([msg.from])}`,
    `To: ${addressList(msg.to)}`,
    ...(msg.cc?.length ? [`Cc: ${addressList(msg.cc)}`] : []),
    ...(msg.bcc?.length ? [`Bcc: ${addressList(msg.bcc)}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    "MIME-Version: 1.0",
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references.length ? [`References: ${references.join(" ")}`] : []),
  ];
  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", msg.text];
  let body = textPart;
  if (msg.html) {
    // Nested boundaries must not be prefixes of each other.
    const alt = `alt-${boundary}`;
    const rel = `rel-${boundary}`;
    const htmlPart = ["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(utf8Base64(msg.html))];
    const htmlBody = msg.inline?.length
      ? [
          `Content-Type: multipart/related; boundary="${rel}"`,
          "",
          `--${rel}`,
          ...htmlPart,
          ...msg.inline.flatMap((i) => [
            `--${rel}`,
            `Content-Type: ${safeMimeType(i.mimeType)}; ${fileParam("name", i.filename)}`,
            `Content-Disposition: inline; ${fileParam("filename", i.filename)}`,
            `Content-ID: <${i.cid.replace(/[\p{Cc}\s<>]/gu, "")}>`,
            "Content-Transfer-Encoding: base64",
            "",
            wrap76(i.base64),
          ]),
          `--${rel}--`,
        ]
      : htmlPart;
    body = [`Content-Type: multipart/alternative; boundary="${alt}"`, "", `--${alt}`, ...textPart, `--${alt}`, ...htmlBody, `--${alt}--`];
  }
  if (!msg.attachments?.length) return [...headers, ...body].join("\r\n");
  const parts = [
    `--${boundary}`,
    ...body,
    ...msg.attachments.flatMap((a) => [
      `--${boundary}`,
      `Content-Type: ${safeMimeType(a.mimeType)}; ${fileParam("name", a.filename)}`,
      `Content-Disposition: attachment; ${fileParam("filename", a.filename)}`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(a.base64),
    ]),
    `--${boundary}--`,
  ];
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n");
}

/** Split a Gmail batch response (multipart/mixed of HTTP responses) into status + JSON body per part, in order. */
export function parseBatchResponse<T>(text: string): { status: number; body?: T; index?: number }[] {
  const boundary = /^--([^\r\n]+)/m.exec(text)?.[1];
  if (!boundary) return [];
  return text
    .split(`--${boundary}`)
    .slice(1)
    .filter((p) => !p.startsWith("--"))
    .map((part) => {
      const status = Number(/HTTP\/[\d.]+ (\d{3})/.exec(part)?.[1] ?? 0);
      const start = part.indexOf("{");
      const end = part.lastIndexOf("}");
      let body: T | undefined;
      if (start >= 0 && end > start) {
        try {
          body = JSON.parse(part.slice(start, end + 1)) as T;
        } catch {
          body = undefined;
        }
      }
      const index = /Content-ID:\s*<response-m(\d+)>/i.exec(part)?.[1];
      return { status, body, index: index === undefined ? undefined : Number(index) };
    });
}
