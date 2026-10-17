// @vitest-environment jsdom
// Pins that parsing a hostile email takes time linear in its size: the tracker count in
// prepareHtml, the Gmail address and Content-ID parsers, and htmlToText each used a regex
// that backtracked over long whitespace runs and could freeze the window. Linearity is
// proven by size (200 KB inputs finish well inside a generous bound where the old
// patterns took seconds to forever), and the normal inputs keep their exact output.
import { describe, expect, it } from "vitest";
import { prepareHtml } from "@/components/mail/email-body";
import { encodeBase64Url, inlineParts, messageToEmail, parseAddressList, type GMessage } from "@/lib/google/gmail-map";

const RUN = " ".repeat(200_000);
const BOUND_MS = 200;

const timed = <T,>(f: () => T): { out: T; ms: number } => {
  const start = performance.now();
  const out = f();
  return { out, ms: performance.now() - start };
};

const htmlOnly = (html: string): GMessage => ({
  id: "m1",
  threadId: "t1",
  internalDate: "1791504000000",
  payload: { mimeType: "text/html", headers: [{ name: "From", value: "jane@example.com" }], body: { size: html.length, data: encodeBase64Url(html) } },
});

describe("prepareHtml tracker count", () => {
  it("counts a style block with @import and a long whitespace run in linear time", () => {
    const { out, ms } = timed(() => prepareHtml(`<div class="pre"></div><style>@import${RUN}x</style><p>Hi</p>`, false, "light"));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(out.blocked).toBe(0);
  });

  it("counts a style block with url( and a long whitespace run in linear time", () => {
    const { out, ms } = timed(() => prepareHtml(`<div class="pre"></div><style>p { background: url(${RUN}x) }</style><p>Hi</p>`, false, "light"));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(out.blocked).toBe(0);
  });

  it("still counts every spelling the old patterns counted", () => {
    const css = [
      `a { background: url(https://t.example.com/a.png) }`,
      `b { background: url( "  https://t.example.com/b.png") }`,
      `c { background: URL('http://t.example.com/c.png') }`,
      `@import "https://fonts.example.com/a.css";`,
      `@import   url(  ' https://fonts.example.com/b.css');`,
      `d { background: url(data:image/png;base64,AAAA) }`,
      `@import "local.css";`,
    ].join("\n");
    // Three url(), one quoted @import, and the url() @import counted by both patterns.
    expect(prepareHtml(`<div class="pre"></div><style>${css}</style><p>x</p>`, false, "light").blocked).toBe(6);
    expect(prepareHtml(`<div class="pre"></div><style>${css}</style><p>x</p>`, true, "light").blocked).toBe(0);
  });

  it("stops counting past the size bound but still offers Load images", () => {
    const huge = `<div class="pre"></div><style>p { color: red }${" ".repeat(1_600_000)}</style><p>Hi</p>`;
    const { out, ms } = timed(() => prepareHtml(huge, false, "light"));
    expect(out.blocked).toBeGreaterThanOrEqual(1);
    expect(ms).toBeLessThan(5_000);
    expect(prepareHtml(huge, true, "light").blocked).toBe(0);
  });
});

describe("Gmail header parsing", () => {
  it("parses an address header with a long whitespace run in linear time", () => {
    const { out, ms } = timed(() => parseAddressList(`x${RUN}y`));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe("");
  });

  it("parses normal address headers exactly as before", () => {
    expect(parseAddressList('"Jane Appleseed" <Jane@Example.com>')).toEqual([{ name: "Jane Appleseed", address: "jane@example.com" }]);
    expect(parseAddressList("Jane Appleseed <jane@example.com>")).toEqual([{ name: "Jane Appleseed", address: "jane@example.com" }]);
    expect(parseAddressList('"Appleseed, Jane" <jane@example.com>, ann@example.org')).toEqual([
      { name: "Appleseed, Jane", address: "jane@example.com" },
      { name: "ann@example.org", address: "ann@example.org" },
    ]);
    expect(parseAddressList("<jane@example.com>")).toEqual([{ name: "jane@example.com", address: "jane@example.com" }]);
    expect(parseAddressList("  ann@example.org  ")).toEqual([{ name: "ann@example.org", address: "ann@example.org" }]);
    expect(parseAddressList("=?UTF-8?B?SsOpcsO0bWU=?= <j@example.com>")).toEqual([{ name: "Jérôme", address: "j@example.com" }]);
    expect(parseAddressList('"Jane"<jane@example.com>')).toEqual([{ name: "Jane", address: "jane@example.com" }]);
  });

  it("trims a Content-ID with a long whitespace run in linear time", () => {
    const part = (cid: string) => ({ mimeType: "image/png", headers: [{ name: "Content-ID", value: cid }], body: { size: 1, data: "AAAA" } });
    const { out, ms } = timed(() => inlineParts(part(`<a${RUN}b>`)));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(out).toHaveLength(1);
    expect(inlineParts(part("<logo@example.com>"))[0].cid).toBe("logo@example.com");
    expect(inlineParts(part("  < logo@example.com >  "))[0].cid).toBe("logo@example.com");
    expect(inlineParts(part("logo@example.com"))[0].cid).toBe("logo@example.com");
    expect(inlineParts(part("<>"))).toEqual([]);
  });

  it("derives text from an HTML-only body with a long whitespace run in linear time", () => {
    const { out, ms } = timed(() => messageToEmail("g1", htmlOnly(`<pre>a${RUN}b</pre>`), () => undefined));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(out.text).toBe(`a${RUN}b`);
  });

  it("derives text from normal HTML exactly as before", () => {
    const text = (html: string) => messageToEmail("g1", htmlOnly(html), () => undefined).text;
    expect(text("<p>Hi Jane,</p>  \n  <p>See you.</p>")).toBe("Hi Jane,\n  See you.");
    expect(text("<pre>one \t\n \n\n\n two  \n</pre>")).toBe("one\n two");
    expect(text("<div>a</div>\n\n\n\n<div>b</div>")).toBe("a\nb");
  });
});
