// @vitest-environment jsdom
// Pins that one address from a header can never become several recipients. A sender could
// write `"Alice" <alice@example.com;   bob@example.org>`: the parsers used to keep the whole
// string as one address, and the composer's split on `,`/`;` then sent the reply to Bob
// too, with the padding hiding him in the single-line To field.
import { describe, expect, it } from "vitest";
import { encodeBase64Url, messageToEmail, type GMessage } from "@/lib/google/gmail-map";
import { messageToEmail as graphToEmail, type GMsg } from "@/lib/microsoft/graph-map";
import { replyRecipients } from "@/lib/mail/compose-text";
import { isSingleMailbox, splitRecipients } from "@/lib/mail/address";
import { mergePeople } from "@/lib/contacts";

const COMPOSITE = '"Alice" <alice@example.com;                                   bob@example.org>';
const mine = ["jane@example.com"];

const gmail = (headers: Record<string, string>): GMessage => ({
  id: "m1",
  threadId: "t1",
  internalDate: "1791504000000",
  payload: {
    mimeType: "text/plain",
    headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
    body: { size: 2, data: encodeBase64Url("Hi") },
  },
});

describe("addresses parsed from headers", () => {
  it("a Gmail From with a composite angle-addr gives no address, keeping the name", () => {
    const e = messageToEmail("g1", gmail({ From: COMPOSITE, To: "jane@example.com" }), () => undefined);
    expect(e.from).toEqual({ name: "Alice", address: "" });
  });

  it("replying to that From has no recipient from inside the brackets", () => {
    const e = messageToEmail("g1", gmail({ From: COMPOSITE, To: "jane@example.com, ann@example.org" }), () => undefined);
    for (const all of [false, true]) {
      const r = replyRecipients(e, mine, all);
      expect([...r.to, ...r.cc].join(",")).not.toMatch(/bob@example\.org|alice@example\.com/);
    }
    // A plain reply to a sender with no usable address goes to nobody, not to the other To recipients.
    expect(replyRecipients(e, mine, false)).toEqual({ to: [], cc: [] });
  });

  it("composite or malformed To and Cc entries give no address", () => {
    const e = messageToEmail(
      "g1",
      gmail({ From: "ann@example.org", To: "<alice@example.com bob@example.org>, jane@example.com", Cc: "<carol@example.com,dave@example.org>" }),
      () => undefined,
    );
    expect(e.to.map((c) => c.address)).toEqual(["", "jane@example.com"]);
    expect(e.cc?.map((c) => c.address)).toEqual(["", ""]);
    expect(replyRecipients(e, mine, true)).toEqual({ to: ["ann@example.org"], cc: [] });
  });

  it("a Graph emailAddress.address with a separator gives no address", () => {
    const msg: GMsg = {
      id: "AAMk1",
      receivedDateTime: "2026-10-09T17:21:00Z",
      parentFolderId: "INBOXID",
      from: { emailAddress: { name: "Alice", address: "alice@example.com;   bob@example.org" } },
      toRecipients: [{ emailAddress: { name: "Jane", address: "Jane@Example.com" } }, { emailAddress: { name: "", address: "a@example.com b@example.org" } }],
    };
    const e = graphToEmail("m1", msg);
    expect(e.from).toEqual({ name: "Alice", address: "" });
    expect(e.to.map((c) => c.address)).toEqual(["jane@example.com", ""]);
  });

  it("autocomplete never offers a composite address", () => {
    const people = mergePeople("ali", [[
      { name: "Alice", address: "alice@example.com;   bob@example.org", source: "mail" },
      { name: "Alice Appleseed", address: "alice@example.com", source: "mail" },
    ]]);
    expect(people.map((p) => p.address)).toEqual(["alice@example.com"]);
  });
});

describe("recipients at send", () => {
  it("accepts single addresses separated by commas or semicolons", () => {
    expect(splitRecipients(" jane@example.com; ann@example.org ,, ")).toEqual(["jane@example.com", "ann@example.org"]);
    expect(splitRecipients("")).toEqual([]);
  });

  it("sends a typed `Name <address>` to the address alone", () => {
    expect(splitRecipients("Jane Appleseed <jane@example.com>, ann@example.org")).toEqual(["jane@example.com", "ann@example.org"]);
  });

  it("refuses an entry that is not exactly one address", () => {
    expect(() => splitRecipients("alice@example.com                 bob@example.org")).toThrow(/isn't a single email address/);
    expect(() => splitRecipients("jane@example.com, <ann@example.org")).toThrow(/<ann@example\.org/);
    expect(() => splitRecipients("Jane <a@example.com> <b@example.org>")).toThrow();
    expect(() => splitRecipients("Jane Appleseed")).toThrow();
  });

  it("isSingleMailbox rejects whitespace, separators and angle brackets", () => {
    expect(isSingleMailbox("jane@example.com")).toBe(true);
    for (const bad of ["", "a@example.com b@example.org", "a@example.com;b@example.org", "a@example.com,b@example.org", "<a@example.com>", "a@example.com "]) {
      expect(isSingleMailbox(bad)).toBe(false);
    }
  });
});
