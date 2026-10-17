// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bodyIsEmpty, cleanBodyHtml, composeRichHtml, composeRichText, markdownToBodyHtml } from "@/lib/mail/compose-html";
import { composeHtml } from "@/lib/signature";

describe("markdownToBodyHtml", () => {
  it("turns the assistant's Markdown into formatting", () => {
    const html = markdownToBodyHtml("**Anne:**\n* one\n* two\n\nThanks,\nAlex");
    expect(html).toContain("<strong>Anne:</strong>");
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain("<ul>");
    expect(html).toContain("Thanks,<br>Alex");
    expect(html).not.toContain("**");
    expect(html).not.toContain("* ");
  });
});

describe("cleanBodyHtml", () => {
  it("removes active and styled content, keeps the allowed tags", () => {
    const html = cleanBodyHtml(
      '<script>alert(1)</script><p class="x" style="color:red" onclick="a()">Hi <b>there</b></p><img src="x.png"><ul><li>a</li></ul><a href="javascript:alert(1)">bad</a> <a href="https://example.org">ok</a>',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("style");
    expect(html).not.toContain("class");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<b>there</b>");
    expect(html).toContain("<ul><li>a</li></ul>");
    expect(html).toContain('<a href="https://example.org">ok</a>');
  });
});

describe("composeRichHtml", () => {
  it("has the same wrapper and signature block as composeHtml", () => {
    const rich = composeRichHtml("<p>Hi</p>", "<p>Sig</p>");
    expect(rich.startsWith('<div style="font-family: Aptos')).toBe(true);
    const sigBlock = (h: string) => h.slice(h.indexOf("<br><div data-zmail-signature"));
    expect(sigBlock(rich)).toBe(sigBlock(composeHtml("Hi", "<p>Sig</p>")));
  });
});

describe("composeRichText", () => {
  it("writes lists as dashes", () => {
    expect(composeRichText("<p>Hi</p><ul><li>a</li><li>b</li></ul>").trim()).toBe("Hi\n- a\n- b");
  });
});

describe("bodyIsEmpty", () => {
  it("is true only without visible text", () => {
    expect(bodyIsEmpty("<p><br></p>")).toBe(true);
    expect(bodyIsEmpty("<p>x</p>")).toBe(false);
  });
});
