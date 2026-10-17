// @vitest-environment jsdom
// Email text capped before it's cached is cut by UTF-16 unit. A cut through an emoji's surrogate
// pair would cache half of it, which SQLite then hands back as bytes that aren't UTF-8. These pin
// that every cut written to the cache (slim rows, Graph and Gmail snippets) stays well-formed.
import { describe, expect, it } from "vitest";
import { clipText } from "@/lib/mail/clip-text";
import { slimRow } from "@/lib/store";
import { messageToEmail as graphToEmail } from "@/lib/microsoft/graph-map";
import { encodeBase64Url, messageToEmail as gmailToEmail } from "@/lib/google/gmail-map";
import type { Email } from "@/lib/types";

const EMOJI = "\u{1F600}"; // two UTF-16 units
/** A surrogate without its partner. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** `n` ASCII characters then an emoji, so the emoji's first half sits at index `n`. */
const straddle = (n: number) => `${"a".repeat(n)}${EMOJI} and more`;

describe("clipText", () => {
  it("backs off rather than split a surrogate pair", () => {
    expect(clipText(straddle(7999), 8000)).toBe("a".repeat(7999));
    expect(clipText(straddle(7998), 8000)).toBe(`${"a".repeat(7998)}${EMOJI}`);
    expect(clipText(straddle(8000), 8000)).toBe("a".repeat(8000));
    expect(clipText("short", 8000)).toBe("short");
    expect(clipText("", 10)).toBe("");
  });
});

describe("persisted cuts", () => {
  it("a slim row's text is well-formed when an emoji straddles the cap", () => {
    const e = { id: "1", subject: "Hi", text: straddle(7999), html: "<p>x</p>" } as Email;
    const slim = slimRow(e);
    expect(slim.text).toBe("a".repeat(7999));
    expect(LONE.test(slim.text)).toBe(false);
    expect(JSON.stringify(slim)).not.toMatch(/\\ud8/i);
  });

  it("a Graph snippet is well-formed when an emoji straddles its cap", () => {
    const e = graphToEmail("m1", {
      id: "AA1",
      subject: "Hi",
      from: { emailAddress: { name: "Jane Appleseed", address: "jane@example.com" } },
      receivedDateTime: "2026-10-09T17:21:00Z",
      bodyPreview: straddle(159),
      body: { contentType: "text", content: "body" },
      parentFolderId: "INBOXID",
    });
    expect(e.snippet).toBe("a".repeat(159));
    expect(LONE.test(e.snippet)).toBe(false);
  });

  it("a Gmail snippet taken from the body is well-formed when an emoji straddles its cap", () => {
    const text = straddle(139);
    const e = gmailToEmail(
      "g",
      {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX"],
        internalDate: "1791590400000",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Jane Appleseed <jane@example.com>" },
            { name: "Subject", value: "Hi" },
          ],
          body: { size: text.length, data: encodeBase64Url(text) },
        },
      },
      () => undefined,
    );
    expect(e.snippet).toBe("a".repeat(139));
    expect(LONE.test(e.snippet)).toBe(false);
  });
});
