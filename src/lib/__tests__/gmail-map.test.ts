// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  buildMime,
  decodeBase64Url,
  encodeBase64Url,
  labelChangesForMove,
  labelsToFolders,
  messageToEmail,
  parseAddressList,
} from "@/lib/google/gmail-map";
import { HTML_ONLY_ARCHIVED, LABELS, MULTIPART } from "./fixtures/gmail";

const A = "g1";

describe("labelsToFolders", () => {
  const folders = labelsToFolders(A, LABELS);
  const byName = (n: string) => folders.find((f) => f.name === n)!;

  it("maps system labels and adds All Mail; hides category/flag labels", () => {
    expect(byName("Inbox")).toMatchObject({ id: "g1:INBOX", system: "inbox", unread: 7 });
    expect(byName("All Mail")).toMatchObject({ id: "g1:ARCHIVE", system: "archive" });
    expect(folders.some((f) => /UNREAD|STARRED|CATEGORY/.test(f.id))).toBe(false);
  });

  it("nests slash labels and creates missing parents", () => {
    expect(byName("Taxes").parentId).toBe(byName("Finance").id);
    expect(byName("Finance")).toMatchObject({ id: "g1:Label_1", unread: 2 });
    const tuesday = byName("Tuesday");
    const leagues = folders.find((f) => f.id === tuesday.parentId)!;
    expect(leagues.name).toBe("Leagues");
    expect(folders.find((f) => f.id === leagues.parentId)!.name).toBe("Golf");
    expect(tuesday.id).toBe("g1:Label_3");
  });
});

describe("messageToEmail", () => {
  const userLabel = (id: string) => (id.startsWith("Label_") ? `${A}:${id}` : undefined);

  it("maps a multipart message with attachments and threading headers", () => {
    const e = messageToEmail(A, MULTIPART, userLabel);
    expect(e).toMatchObject({
      id: "18c1",
      threadId: "18c0",
      folderId: "g1:INBOX",
      unread: true,
      starred: false,
      subject: "Your statement is ready",
      from: { name: "Chase Bank", address: "no-reply@chase.com" },
      text: "Statement ready — balance $12.34",
      snippet: "Your statement is ready & waiting",
      rfc: { messageId: "<abc@chase.com>" },
    });
    expect(e.html).toContain("<b>ready</b>");
    expect(e.to.map((c) => c.address)).toEqual(["alex.rivera@example.com", "jane@x.com"]);
    expect(e.attachments).toEqual([{ id: "ANGjdJ8", filename: "statement.pdf", mimeType: "application/pdf", size: 48211, inline: false }]);
    expect(e.date).toBe(new Date(1791590400000).toISOString());
  });

  it("files archived mail by its user label and derives text from html", () => {
    const e = messageToEmail(A, HTML_ONLY_ARCHIVED, userLabel);
    expect(e.folderId).toBe("g1:Label_2");
    expect(e.starred).toBe(true);
    expect(e.text).toBe("Your 1099 is attached.");
    expect(e.subject).toBe("Your 1099"); // RFC 2047 decoded
  });

  it("maps List-Unsubscribe headers", () => {
    const headers = [...MULTIPART.payload.headers!, { name: "list-unsubscribe", value: "<mailto:u@chase.com>, <https://chase.com/u?x=1>" }, { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" }];
    const e = messageToEmail(A, { ...MULTIPART, payload: { ...MULTIPART.payload, headers } }, userLabel);
    expect(e.unsubscribe).toEqual({ http: "https://chase.com/u?x=1", mailto: "mailto:u@chase.com", oneClick: true });
    expect(messageToEmail(A, MULTIPART, userLabel).unsubscribe).toBeUndefined();
  });
});

describe("helpers", () => {
  it("round-trips base64url with unicode", () => {
    expect(decodeBase64Url(encodeBase64Url("héllo — 👋"))).toBe("héllo — 👋");
  });

  it("decodes parts in their declared charset", () => {
    const latin1 = btoa(String.fromCharCode(0x63, 0x61, 0x66, 0xe9)).replace(/=+$/, ""); // "café" in ISO-8859-1
    expect(decodeBase64Url(latin1, "iso-8859-1")).toBe("café");
    expect(decodeBase64Url(latin1, "x-not-a-charset")).not.toBe(""); // falls back without throwing
  });

  it("parses quoted names with commas", () => {
    expect(parseAddressList('"Doe, Jane" <Jane@X.com>, bob@y.com')).toEqual([
      { name: "Doe, Jane", address: "jane@x.com" },
      { name: "bob@y.com", address: "bob@y.com" },
    ]);
  });

  it("computes label edits for moves", () => {
    expect(labelChangesForMove(A, ["INBOX"], "g1:ARCHIVE")).toEqual({ add: [], remove: ["INBOX", "TRASH", "SPAM"] });
    expect(labelChangesForMove(A, ["INBOX", "Label_1"], "g1:Label_2")).toEqual({ add: ["Label_2"], remove: ["INBOX", "TRASH", "SPAM", "Label_1"] });
    expect(labelChangesForMove(A, [], "g1:INBOX")).toEqual({ add: ["INBOX"], remove: ["SPAM", "TRASH"] });
    // Undo after Delete on an archived message must leave Trash.
    expect(labelChangesForMove(A, ["TRASH"], "g1:ARCHIVE").remove).toContain("TRASH");
    expect(() => labelChangesForMove(A, [], "g1:path:Golf")).toThrow(/grouping/);
  });

  it("writes a Bcc header only when there are Bcc recipients", () => {
    const base = { from: "me@x.com", to: ["a@b.com"], subject: "S", text: "t" };
    expect(buildMime({ ...base, bcc: ["h@x.com", "i@x.com"] }, "B")).toMatch(/^Bcc: h@x\.com, i@x\.com\r?$/m);
    expect(buildMime({ ...base, bcc: [] }, "B")).not.toMatch(/^Bcc:/m);
    expect(buildMime(base, "B")).not.toMatch(/^Bcc:/m);
  });

  it("parses the Bcc header of drafts and sent mail", () => {
    const withBcc = { ...MULTIPART, payload: { ...MULTIPART.payload, headers: [...(MULTIPART.payload?.headers ?? []), { name: "Bcc", value: "Hidden <h@x.com>" }] } };
    expect(messageToEmail(A, withBcc as typeof MULTIPART, (id) => (id.startsWith("Label_") ? `${A}:${id}` : undefined)).bcc).toEqual([{ name: "Hidden", address: "h@x.com" }]);
    expect(messageToEmail(A, MULTIPART, () => undefined).bcc).toEqual([]);
  });

  it("builds MIME with threading headers and attachments", () => {
    const mime = buildMime(
      {
        from: "me@x.com",
        to: ["a@b.com"],
        subject: "Re: Héllo",
        text: "Thanks",
        inReplyTo: "<abc@x>",
        attachments: [{ filename: "a.txt", mimeType: "text/plain", base64: btoa("hi") }],
      },
      "B",
    );
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain("In-Reply-To: <abc@x>");
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="B"');
    expect(mime).toContain('Content-Disposition: attachment; filename="a.txt"');
    expect(mime.trim().endsWith("--B--")).toBe(true);
  });

  it("quotes or RFC 2231-encodes attachment and inline filenames, so a name can't break out of its header", () => {
    const att = (filename: string, mimeType = "text/plain") => ({ filename, mimeType, base64: btoa("hi") });
    const mime = buildMime(
      {
        from: "me@x.com",
        to: ["a@b.com"],
        subject: "S",
        text: "t",
        html: "<p>t</p>",
        inline: [{ cid: "c1", filename: 'sig"\r\nBcc: e@x.com.png', mimeType: "image/png", base64: btoa("x") }],
        attachments: [att('a "b".txt'), att("résumé.pdf", "application/pdf\r\nBcc: e2@x.com")],
      },
      "B",
    );
    expect(mime).not.toMatch(/^Bcc:/im);
    expect(mime).toContain('Content-Disposition: attachment; filename="a \\"b\\".txt"');
    expect(mime).toContain("Content-Type: application/octet-stream; name*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    expect(mime).toContain("Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    expect(mime).toContain('Content-Disposition: inline; filename="sig\\"Bcc: e@x.com.png"');
  });

  it("refuses a recipient with a line break, and keeps only well-formed message ids for threading", () => {
    const base = { from: "me@x.com", to: ["a@b.com"], subject: "S", text: "t" };
    expect(() => buildMime({ ...base, cc: ["c@x.com\r\nBcc: e@x.com"] }, "B")).toThrow(/line break/);
    const mime = buildMime({ ...base, inReplyTo: "<a@b> junk", references: "<r1@x> <bad <r2@x>\nX: y" }, "B");
    expect(mime).toMatch(/^In-Reply-To: <a@b>$/m);
    expect(mime).toMatch(/^References: <r1@x> <r2@x> <a@b>$/m);
    expect(mime).not.toMatch(/^X:/m);
  });
});
