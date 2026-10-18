// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/lib/ai/assistant/markdown";
import { prepareHtml } from "@/components/mail/email-body";
import { systemPrompt } from "@/lib/ai/assistant/prompts";
const rm = (t: string) => renderMarkdown(t).html;

describe("renderMarkdown", () => {
  it("renders GFM tables, lists, bold and code", () => {
    const html = rm("| Group | Count |\n|---|---:|\n| Orders | 15 |\n\n- **a**\n- `b`\n\n1. x");
    expect(html).toContain("<table>");
    expect(html).toContain("<th");
    expect(html).toContain("<strong>a</strong>");
    expect(html).toContain("<code>b</code>");
    expect(html).toContain("<ol>");
  });
  it("removes scripts, event handlers, images and raw HTML", () => {
    const html = rm('hi <script>alert(1)</script> <img src=x onerror="alert(1)"> <b onclick="x()">b</b> <iframe src="//e"></iframe>');
    expect(html).not.toMatch(/script|onerror|onclick|<img|iframe/i);
  });
  it("opens links in a new window and drops javascript: urls", () => {
    const html = rm("[a](https://example.com) [b](javascript:alert(1))");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).not.toContain("javascript:");
  });
});

describe("table and link formatting", () => {
  const table = "| Group | Count | Note |\n|---|---|---|\n| Orders | 1,204 | x |\n| Bills | 15 | y |";
  it("marks numeric columns with class num", () => {
    const doc = new DOMParser().parseFromString(rm(table), "text/html");
    const rows = [...doc.querySelectorAll("tr")].map((r) => [...r.children].map((c) => c.className));
    for (const r of rows) expect(r).toEqual(["", "num", ""]);
  });
  it("detects columns whose cells are all numbers", () => {
    const doc = new DOMParser().parseFromString(rm("| A | B |\n|---|---|\n| x | 12% |\n| y | +3 |"), "text/html");
    expect([...doc.querySelectorAll("td")].map((c) => c.className)).toEqual(["", "num", "", "num"]);
  });
  it("strips any other class value", () => {
    const html = rm('<p class="evil">a</p> <span class="num">b</span>');
    expect(html).not.toContain("evil");
  });
  it("keeps the address when mailto link text differs, case-insensitively", () => {
    const html = rm("[Bob](MAILTO:bob@example.com)");
    expect(html).not.toContain("<a");
    expect(html).toContain("Bob (bob@example.com)");
  });
  it("does not link bare emails but still links http urls", () => {
    expect(rm("mail bob@example.com now")).not.toContain("<a");
    expect(rm("mail bob@example.com now")).toContain("bob@example.com");
    expect(rm("| E | Count |\n|---|---|\n| bob@example.com | 3 |")).not.toContain("<a");
    expect(rm("see https://example.com/x")).toContain('href="https://example.com/x"');
  });
});

// A reply is model output that an email it read may have steered, so a link's text can't hide where it goes.
describe("link destinations", () => {
  const link = (md: string) => new DOMParser().parseFromString(rm(md), "text/html").querySelector("a")!;
  it("shows the real host after link text that doesn't name it, and the full URL on hover", () => {
    const a = link("[View the full report](https://attacker.example/x?d=secret)");
    expect(a.textContent).toBe("View the full report (attacker.example)");
    expect(a.getAttribute("title")).toBe("https://attacker.example/x?d=secret");
    expect(a.getAttribute("href")).toBe("https://attacker.example/x?d=secret");
  });
  it("doesn't double a bare URL or text that already names the host", () => {
    expect(link("see https://example.com/x").textContent).toBe("https://example.com/x");
    expect(link("see www.example.com").textContent).toBe("www.example.com");
    expect(link("[Example.org](https://example.org/docs)").textContent).toBe("Example.org");
  });
  it("names the real host when the text looks like another address", () => {
    expect(link("[https://bank.example](https://attacker.example/)").textContent).toBe("https://bank.example (attacker.example)");
    expect(link("[https://bank.example@attacker.example](https://bank.example@attacker.example/)").textContent).toBe("https://bank.example@attacker.example (attacker.example)");
    expect(link("[b\u0430nk.example](https://b\u0430nk.example/)").textContent).toMatch(/^b\u0430nk\.example \(xn--/);
  });
  it("gives an empty link its host as text", () => {
    expect(link("[](https://example.com/x)").textContent).toBe("example.com");
  });
});

describe("sanitizer isolation", () => {
  it("the assistant's link hook doesn't touch email bodies", () => {
    rm("[a](https://x.com)");
    // The hook strips classes from links; email bodies keep theirs.
    expect(prepareHtml('<a class="btn" href="https://x.com">x</a>', false).html).toContain('class="btn"');
  });
});

describe("system prompt", () => {
  it("asks for a Markdown table and for addresses on shared names", () => {
    const p = systemPrompt({ name: "Z", today: "2026-01-01", accounts: [] });
    expect(p).toContain("| Group | Count | What's in it |");
    expect(p).toContain("use their address");
    expect(p).toContain("Don't repeat the table as a list");
  });
});

describe("table wrapping", () => {
  const md = "| A | B | C |\n|---|---|---|\n| x | y | $1 |";
  it("puts every table inside div.md-table", () => {
    const d = document.createElement("div");
    d.innerHTML = rm(`${md}\n\ntext\n\n${md}`);
    const tables = d.querySelectorAll("table");
    expect(tables).toHaveLength(2);
    for (const t of Array.from(tables)) expect(t.parentElement?.matches("div.md-table")).toBe(true);
  });
  it("does not let the model supply md-table or other classes", () => {
    const d = document.createElement("div");
    d.innerHTML = rm('<p class="md-table evil">hi</p>');
    expect(d.querySelector("[class]")).toBeNull();
  });
});

describe("renderMarkdown citations", () => {
  const info = (id: string) => ({ id: `e${id}`, accountId: "g", from: "A", subject: "S", date: "2025-10-03" });
  const refs = { m2: info("2"), m4: info("4") };
  const cites = (html: string) => Array.from(new DOMParser().parseFromString(html, "text/html").querySelectorAll("button.cite"));
  it("numbers known refs by first appearance", () => {
    const { html, cited } = renderMarkdown("a [m4] b [m2] c [m4]", refs);
    expect(cited).toEqual(["m4", "m2"]);
    expect(cites(html).map((b) => [b.textContent, b.getAttribute("data-ref"), b.getAttribute("type")])).toEqual([["1", "m4", "button"], ["2", "m2", "button"], ["1", "m4", "button"]]);
  });
  it("removes unknown refs", () => {
    const { html, cited } = renderMarkdown("x [m9] y", refs);
    expect(cited).toEqual([]);
    expect(html).not.toContain("m9");
    expect(cites(html)).toHaveLength(0);
  });
  it("leaves tokens inside code alone", () => {
    const { html, cited } = renderMarkdown("`[m4]` and\n\n```\n[m2]\n```", refs);
    expect(cited).toEqual([]);
    expect(html).toContain("[m4]");
    expect(html).toContain("[m2]");
  });
  it("without refs there are no citations and tokens are dropped", () => {
    const { html, cited } = renderMarkdown("hi [m1] there");
    expect(cited).toEqual([]);
    expect(cites(html)).toHaveLength(0);
    expect(html).not.toContain("[m1]");
  });
  it("does not match prototype names", () => {
    const { html, cited } = renderMarkdown("x [m__proto__] [constructor]", refs);
    expect(cited).toEqual([]);
    expect(cites(html)).toHaveLength(0);
  });
  it("a model-written cite button cannot keep its class", () => {
    expect(rm('<button class="cite" data-ref="m1">1</button>')).not.toContain("cite");
  });
});
