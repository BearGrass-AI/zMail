// Gmail API response shapes (users.labels.list / users.messages.get format=full).
import type { GLabel, GMessage } from "@/lib/google/gmail-map";

const b64u = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const LABELS: GLabel[] = [
  { id: "INBOX", name: "INBOX", type: "system", messagesUnread: 7 },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "SPAM", name: "SPAM", type: "system" },
  { id: "TRASH", name: "TRASH", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
  { id: "Label_1", name: "Finance", type: "user", messagesUnread: 2 },
  { id: "Label_2", name: "Finance/Taxes", type: "user" },
  { id: "Label_3", name: "Golf/Leagues/Tuesday", type: "user" }, // parents "Golf" and "Golf/Leagues" don't exist as labels
];

export const MULTIPART: GMessage = {
  id: "18c1",
  threadId: "18c0",
  labelIds: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
  snippet: "Your statement is ready &amp; waiting",
  internalDate: "1791590400000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: '"Chase Bank" <No-Reply@Chase.com>' },
      { name: "To", value: "Alex <alex.rivera@example.com>, \"Doe, Jane\" <jane@x.com>" },
      { name: "Subject", value: "Your statement is ready" },
      { name: "Message-ID", value: "<abc@chase.com>" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { partId: "0.0", mimeType: "text/plain", body: { size: 30, data: b64u("Statement ready — balance $12.34") } },
          { partId: "0.1", mimeType: "text/html", body: { size: 60, data: b64u("<p>Statement <b>ready</b> — balance $12.34</p>") } },
        ],
      },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "statement.pdf",
        headers: [{ name: "Content-Disposition", value: 'attachment; filename="statement.pdf"' }],
        body: { size: 48211, attachmentId: "ANGjdJ8" },
      },
      {
        partId: "2",
        mimeType: "image/png",
        filename: "logo.png",
        headers: [
          { name: "Content-Disposition", value: "inline" },
          { name: "Content-ID", value: "<logo>" },
        ],
        body: { size: 1200, attachmentId: "ANGjdJ9" },
      },
    ],
  },
};

export const HTML_ONLY_ARCHIVED: GMessage = {
  id: "18c2",
  threadId: "18c2",
  labelIds: ["Label_2", "STARRED"],
  snippet: "Your 1099",
  internalDate: "1791504000000",
  payload: {
    mimeType: "text/html",
    headers: [
      { name: "From", value: "irs@example.gov" },
      { name: "Subject", value: "=?UTF-8?B?WW91ciAxMDk5?=" },
    ],
    body: { size: 40, data: b64u("<style>p{color:red}</style><p>Your 1099 is attached.</p>") },
  },
};
