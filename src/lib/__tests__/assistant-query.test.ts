// src/lib/__tests__/assistant-query.test.ts
import { describe, expect, it } from "vitest";
import type { Email, Folder } from "@/lib/types";
import { cleanQuery, describeQuery, gmailQuery, graphQuery, matchesLocal, resolveFolder } from "@/lib/ai/assistant/query";

const folders: Folder[] = [
  { id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" },
  { id: "g:ARCHIVE", accountId: "g", name: "All Mail", system: "archive" },
  { id: "g:path:Finance", accountId: "g", name: "Finance" },
  { id: "g:Label_7", accountId: "g", name: "Taxes 2025", parentId: "g:path:Finance" },
];
const mail = (over: Partial<Email> = {}): Email =>
  ({ id: "e1", accountId: "g", threadId: "e1", folderId: "g:INBOX", from: { name: "Amazon.com", address: "shipment-tracking@amazon.com" }, to: [{ name: "Z", address: "z@x.com" }], subject: "Your package was delivered", snippet: "", text: "Delivered to your porch.", date: "2025-03-04T10:00:00Z", unread: true, starred: false, labels: [], ...over }) as Email;

describe("cleanQuery", () => {
  it("keeps known fields, trims, and drops unknown ones", () => {
    expect(cleanQuery({ from: " amazon.com ", unread: true, color: "red", after: "2024-01-01" })).toEqual({ from: "amazon.com", unread: true, after: "2024-01-01" });
  });
  it("rejects malformed dates and wrong types", () => {
    expect(() => cleanQuery({ after: "last week" })).toThrow(/bad_query/);
    expect(() => cleanQuery({ unread: "yes" })).toThrow(/bad_query/);
    expect(() => cleanQuery("amazon")).toThrow(/bad_query/);
  });
});

describe("Gmail q", () => {
  it("builds sender, words, dates and flags", () => {
    const q = cleanQuery({ from: "amazon.com", words: "order", after: "2024-01-01", before: "2025-01-01", unread: true, hasAttachment: true });
    expect(gmailQuery(q, undefined, folders)).toBe("from:amazon.com order after:2024/01/01 before:2025/01/01 is:unread has:attachment");
  });
  it("maps folders to in: terms and nested labels to their full name", () => {
    expect(gmailQuery({ folder: "inbox" }, resolveFolder({ folder: "inbox" }, "g", folders), folders)).toBe("in:inbox");
    expect(gmailQuery({ folder: "g:Label_7" }, resolveFolder({ folder: "g:Label_7" }, "g", folders), folders)).toBe("label:finance-taxes-2025");
  });
  it("quotes and apostrophes don't break the query", () => {
    expect(gmailQuery({ from: "O'Reilly Media", subject: 'the "budget" (final)' }, undefined, folders)).toBe(`from:"O'Reilly Media" subject:(the budget final)`);
  });
});

describe("Graph query", () => {
  it("uses KQL $search when there are sender/word terms, and filters flags locally", () => {
    const g = graphQuery({ from: "amazon.com", words: "order", after: "2024-01-01", unread: true });
    expect(g.search).toBe("from:amazon.com order received>=2024-01-01");
    expect(g.filter).toBeUndefined();
    expect(g.local(mail({ unread: true }))).toBe(true);
    expect(g.local(mail({ unread: false }))).toBe(false);
  });
  it("uses $filter with a receivedDateTime lead when there are no search terms", () => {
    const g = graphQuery({ unread: true, starred: true, before: "2025-01-01" });
    expect(g.search).toBeUndefined();
    expect(g.filter).toBe("receivedDateTime ge 1900-01-01T00:00:00Z and receivedDateTime lt 2025-01-01T00:00:00Z and isRead eq false and flag/flagStatus eq 'flagged'");
  });
  it("strips quotes from KQL values", () => {
    expect(graphQuery({ subject: 'say "hi"' }).search).toBe("subject:say subject:hi");
  });
});

describe("matchesLocal", () => {
  const ctx = { folderId: undefined, categoryOf: () => "transactions" as const, sectionOf: () => undefined };
  it("matches domain senders, subject words, dates and zMail fields", () => {
    expect(matchesLocal(mail(), { from: "amazon.com" }, ctx)).toBe(true);
    expect(matchesLocal(mail(), { from: "ebay.com" }, ctx)).toBe(false);
    expect(matchesLocal(mail(), { subject: "package delivered" }, ctx)).toBe(true);
    expect(matchesLocal(mail(), { after: "2025-03-05" }, ctx)).toBe(false);
    expect(matchesLocal(mail(), { category: "transactions" }, ctx)).toBe(true);
    expect(matchesLocal(mail(), { category: "promotions" }, ctx)).toBe(false);
  });
});

describe("describeQuery", () => {
  it("reads like a label", () => {
    expect(describeQuery({ from: "amazon.com", unread: true, after: "2024-01-01" })).toBe("From amazon.com · unread · since Jan 1, 2024");
    expect(describeQuery({})).toBe("All mail");
  });
});

describe("fix round 1: sanitizing and empty terms", () => {
  it("rejects a field that is empty after sanitizing instead of widening the search", () => {
    expect(() => graphQuery({ words: '"' })).toThrow("bad_query: words has no searchable words");
    expect(() => gmailQuery({ subject: "()" }, undefined, [])).toThrow("bad_query: subject has no searchable words");
  });
  it("Graph emits one from: term per word of a multi-word name", () => {
    expect(graphQuery({ from: "O'Reilly Media" }).search).toBe("from:O'Reilly from:Media");
  });
  it("Graph KQL strips operator characters from subject words", () => {
    expect(graphQuery({ subject: "fix (urgent" }).search).toBe("subject:fix subject:urgent");
  });
  it("local matching tokenizes subject words the same way the providers do", () => {
    const ctx = { folderId: undefined, categoryOf: () => undefined, sectionOf: () => undefined };
    expect(matchesLocal(mail({ subject: "The budget final review" }), { subject: 'the "budget" (final)' }, ctx)).toBe(true);
  });
  it("Gmail neutralizes operators in free text per token", () => {
    expect(gmailQuery({ words: "in:anywhere -is:unread OR {a b}" }, undefined, [])).toBe("inanywhere isunread or a b");
  });
  it("cleanQuery rejects dates that do not exist on the calendar", () => {
    expect(() => cleanQuery({ after: "2025-13-45" })).toThrow(/bad_query/);
  });
});

describe("final fixes: empty fields, KQL operators, describe", () => {
  it("cleanQuery rejects from/to/subject/words that sanitize to nothing", () => {
    expect(() => cleanQuery({ from: '"()"' })).toThrow("bad_query: from has no searchable words");
    expect(() => cleanQuery({ to: "--" })).toThrow("bad_query: to has no searchable words");
    expect(() => cleanQuery({ subject: "::" })).toThrow("bad_query: subject has no searchable words");
    expect(() => cleanQuery({ words: "{}" })).toThrow("bad_query: words has no searchable words");
    expect(cleanQuery({ from: "amazon.com", words: "order" })).toEqual({ from: "amazon.com", words: "order" });
  });
  it("lowercases bare NOT and NEAR like OR and AND", () => {
    expect(graphQuery({ words: "budget NOT draft NEAR final" }).search).toBe("budget not draft near final");
    expect(gmailQuery({ words: "a NOT b" }, undefined, [])).toBe("a not b");
  });
  it("describes unread: false and starred: false", () => {
    expect(describeQuery({ unread: false })).toBe("Read");
    expect(describeQuery({ from: "x.com", starred: false })).toBe("From x.com · not starred");
  });
});

describe("hasAttachment: false", () => {
  it("excludes attachment mail in every translation and says so in the label", () => {
    expect(gmailQuery({ from: "x.com", hasAttachment: false }, undefined, [])).toBe("from:x.com -has:attachment");
    expect(graphQuery({ from: "x.com", hasAttachment: false }).search).toBe("from:x.com hasattachments:false");
    expect(graphQuery({ hasAttachment: false }).filter).toBe("receivedDateTime ge 1900-01-01T00:00:00Z and hasAttachments eq false");
    const file = { id: "a1", filename: "a.pdf", mimeType: "application/pdf", size: 1 };
    const ctx = { folderId: undefined, categoryOf: () => undefined, sectionOf: () => undefined };
    expect(matchesLocal(mail({ attachments: [file] }), { hasAttachment: false }, ctx)).toBe(false);
    expect(matchesLocal(mail(), { hasAttachment: false }, ctx)).toBe(true);
    expect(describeQuery({ from: "x.com", hasAttachment: false })).toBe("From x.com · without attachments");
  });
});
