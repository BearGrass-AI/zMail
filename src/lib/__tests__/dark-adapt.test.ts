// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { prepareHtml } from "@/components/mail/email-body";
import { adaptEmail } from "@/lib/mail/dark-adapt";
import { canRenderDark, darkKindFor, sanitizedFor } from "@/lib/mail/dark-mode";
import { DARK_CSS, LIGHT_CSS } from "@/lib/mail/email-frame";
import {
  CARD_RGBA,
  DARK_CARD,
  DARK_TEXT,
  adaptBackground,
  adaptBorder,
  adaptForeground,
  contrast,
  formatColor,
  oklch,
  over,
  parseColor,
  type Rgba,
} from "@/lib/mail/color";
import { FIXTURES, GMAIL, HERO, IMAGE_LAYOUT, NEWSLETTER, OUTLOOK, OWN_DARK, PLAIN } from "./fixtures/dark-mail";

const c = (s: string) => {
  const v = parseColor(s, true);
  if (!v) throw new Error(`unparsed ${s}`);
  return v;
};
const hex = (x: Rgba) => formatColor(x);
const hueDeg = (x: Rgba) => ((oklch(x).h * 180) / Math.PI + 360) % 360;
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe("parseColor", () => {
  it("reads hex in 3, 4, 6 and 8 digits", () => {
    expect(parseColor("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
    expect(parseColor("#abcd")?.a).toBeCloseTo(0xdd / 255);
    expect(parseColor("#7A0019")).toEqual({ r: 0x7a, g: 0, b: 0x19, a: 1 });
    expect(parseColor("#ff000080")?.a).toBeCloseTo(128 / 255);
    expect(parseColor("#ggg")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
  });
  it("reads rgb() and rgba() in comma and space syntax, with percentages", () => {
    expect(parseColor("rgb(34, 34, 34)")).toEqual({ r: 34, g: 34, b: 34, a: 1 });
    expect(parseColor("rgba(0,0,0,.5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor("rgb(100%, 0%, 50%)")).toEqual({ r: 255, g: 0, b: 127.5, a: 1 });
    expect(parseColor("RGB( 1 , 2 , 3 )")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
  });
  it("reads hsl() and hsla() with hue units", () => {
    expect(hex(c("hsl(0, 100%, 50%)"))).toBe("#ff0000");
    expect(hex(c("hsl(120deg 100% 25%)"))).toBe("#008000");
    expect(hex(c("hsl(0.5turn, 100%, 50%)"))).toBe("#00ffff");
    expect(c("hsla(240, 100%, 50%, 0.25)").a).toBe(0.25);
  });
  it("reads named and system colors", () => {
    expect(hex(c("black"))).toBe("#000000");
    expect(hex(c("WindowText"))).toBe("#000000");
    expect(hex(c("gray"))).toBe("#808080");
    expect(hex(c("rebeccapurple"))).toBe("#663399");
    expect(hex(c("yellow"))).toBe("#ffff00");
  });
  it("reads bare hex only in legacy attribute mode", () => {
    expect(parseColor("ffffff")).toBeNull();
    expect(hex(c("ffffff"))).toBe("#ffffff");
  });
  it("leaves transparent, currentColor, inherit and friends alone", () => {
    for (const k of ["transparent", "currentColor", "inherit", "initial", "unset", "none", "var(--x)"]) expect(parseColor(k)).toBeNull();
  });
  it("never throws on hostile input", () => {
    const junk = ["rgb(", "rgb(1,2)", "rgb(1,2,3,4,5)", "hsl(x,y,z)", "rgb(1e999,0,0)", "#", "rgb(NaN,0,0)", "hsl(1/2/3)", "\u0000", "rgb(1 2 3 / 4 / 5)", "x".repeat(10_000), "rgb(" + "9".repeat(500) + ",0,0)"];
    for (const j of junk) expect(() => parseColor(j)).not.toThrow();
    for (let i = 0; i < 2000; i++) {
      const s = Array.from({ length: (i % 24) + 1 }, () => "#(),.%/ 0123456789abcdefrgbhsl"[Math.floor(Math.random() * 29)]).join("");
      const v = parseColor(s);
      if (v) for (const ch of [v.r, v.g, v.b, v.a]) expect(Number.isFinite(ch)).toBe(true);
    }
  });
});

const FGS = ["#000000", "#1d1d1f", "#333333", "#555555", "#777777", "#999999", "#cccccc", "#ffffff", "#7a0019", "#990033", "#1f497d", "#0563c1", "#174ea6", "#2e7d32", "#e4002b", "#ffd700", "#800080", "rgba(0,0,0,0.6)", "#3b2a14"];
const BGS = ["#ffffff", "#fefefe", "#f4f4f4", "#e8f0fe", "#fff3cd", "#ffff00", "#e4002b", "#0a66ff", "#999999", "#333333", "#002855", "#16181c", "#000000", "hsl(48,100%,90%)", "rgba(255,255,255,0.5)"];

describe("dark color mapping", () => {
  it("adapted text reads (4.5:1) on its adapted background, for every pair in the grid", () => {
    for (const bgs of BGS)
      for (const fgs of FGS) {
        const bg = over(adaptBackground(c(bgs)), CARD_RGBA);
        const fg = c(hex(adaptForeground(c(fgs), bg)));
        const ratio = contrast(over(fg, bg), bg);
        expect(ratio, `${fgs} on ${bgs} -> ${hex(fg)} on ${hex(bg)}`).toBeGreaterThanOrEqual(4.5);
      }
  });
  it("maps near-white backgrounds to the dark card", () => {
    for (const w of ["#ffffff", "#fefefe", "white", "rgb(255,255,255)", "#FFF"]) expect(hex(adaptBackground(c(w)))).toBe(DARK_CARD);
  });
  it("turns light tints into dark tints of the same hue", () => {
    for (const t of ["#e8f0fe", "#fff3cd", "#fde2e4", "#e6f4ea"]) {
      const out = adaptBackground(c(t));
      expect(oklch(out).l).toBeLessThan(0.3);
      expect(hueGap(hueDeg(out), hueDeg(c(t)))).toBeLessThan(12);
    }
  });
  it("leaves already-dark backgrounds as they are", () => {
    for (const d of ["#333333", "#002855", "#16181c", "#000000", "#4b0082"]) expect(hex(adaptBackground(c(d)))).toBe(d);
  });
  it("keeps a maroon signature red-hued and readable, not grey", () => {
    for (const m of ["#7a0019", "#990033", "maroon"]) {
      const out = adaptForeground(c(m), CARD_RGBA);
      expect(contrast(out, CARD_RGBA)).toBeGreaterThanOrEqual(4.5);
      expect(oklch(out).l).toBeGreaterThan(oklch(c(m)).l);
      expect(oklch(out).c).toBeGreaterThan(0.06);
      expect(hueGap(hueDeg(out), hueDeg(c(m)))).toBeLessThan(10);
    }
  });
  it("turns black and windowtext into the card's text color", () => {
    for (const b of ["#000", "black", "windowtext", "#111111"]) expect(hex(adaptForeground(c(b), CARD_RGBA))).toBe(DARK_TEXT);
  });
  it("leaves text that already reads", () => {
    for (const l of ["#ffffff", "#e6e7ea", "#cccccc", "#ffd700"]) expect(hex(adaptForeground(c(l), CARD_RGBA))).toBe(hex(c(l)));
  });
});

/** A separator on the dark card: lighter than what's behind it, visible but quiet (about 1.3 to 2:1). */
function expectQuietLine(line: Rgba, bg: Rgba) {
  const ratio = contrast(line, bg);
  expect(ratio, `${hex(line)} on ${hex(bg)}`).toBeGreaterThanOrEqual(1.3);
  expect(ratio, `${hex(line)} on ${hex(bg)}`).toBeLessThanOrEqual(2.05);
  expect(oklch(line).l).toBeGreaterThan(oklch(bg).l);
}

describe("border and separator mapping", () => {
  it("mirrors light separators into quiet dark lines, still visible on the card", () => {
    for (const b of ["#e1e1e1", "#cccccc", "#eeeeee", "#dddddd", "#999999", "#000000", "#e8f0fe"]) expectQuietLine(adaptBorder(c(b), CARD_RGBA), CARD_RGBA);
    // Fainter as authored stays fainter.
    expect(contrast(adaptBorder(c("#eeeeee"), CARD_RGBA), CARD_RGBA)).toBeLessThan(contrast(adaptBorder(c("#999999"), CARD_RGBA), CARD_RGBA));
  });
  it("keeps a grey separator in the card's tint and a tinted one in its hue", () => {
    const tinted = adaptBorder(c("#c6dafc"), CARD_RGBA);
    expect(hueGap(hueDeg(tinted), hueDeg(c("#c6dafc")))).toBeLessThan(12);
  });
  it("keeps strongly colored borders in their hue and clearly visible (3:1)", () => {
    for (const b of ["#d32f2f", "#e4002b", "#7a0019", "#1565c0", "#2e7d32", "#ff9800"]) {
      const out = adaptBorder(c(b), CARD_RGBA);
      expect(contrast(out, CARD_RGBA), `${b} -> ${hex(out)}`).toBeGreaterThanOrEqual(3);
      expect(hueGap(hueDeg(out), hueDeg(c(b)))).toBeLessThan(10);
    }
  });
  it("leaves lines on an area that was already dark as authored", () => {
    expect(hex(adaptBorder(c("#555555"), c("#333333"), c("#333333")))).toBe("#555555");
  });
  it("maps <hr> colors as lines, in attributes and inline styles", () => {
    const doc = new DOMParser().parseFromString(
      `<body>${adaptEmail(`<p>a</p><hr color="#cccccc"><hr style="border:none;border-top:1px solid #cccccc;background-color:#cccccc;color:#cccccc">`, false).html}</body>`,
      "text/html",
    );
    const [first, second] = [...doc.querySelectorAll("hr")];
    expectQuietLine(c(first.getAttribute("color") ?? "#fff"), CARD_RGBA);
    const style = second.getAttribute("style") ?? "";
    const colors = style.match(/#[0-9a-f]{6}/g) ?? [];
    expect(colors).toHaveLength(3);
    for (const col of colors) expectQuietLine(c(col), CARD_RGBA);
  });
  it("lets text decorations follow their text", () => {
    const { html } = adaptEmail(`<p><span style="color:#7a0019;text-decoration:underline #7a0019;text-decoration-color:#7a0019">sig</span></p>`, false);
    const cols = html.match(/#[0-9a-f]{6}/g) ?? [];
    expect(cols).toHaveLength(3);
    expect(new Set(cols).size).toBe(1);
    expect(contrast(c(cols[0] ?? "#000"), CARD_RGBA)).toBeGreaterThanOrEqual(4.5);
  });
  it("rewrites border colors in style blocks as lines", () => {
    const { html } = adaptEmail(`<p>a</p><style>.rule{border-top:1px solid #eeeeee}</style><p class="rule">b</p>`, false);
    expectQuietLine(c(/border-top: 1px solid (#[0-9a-f]{6})/.exec(html)?.[1] ?? "#fff"), CARD_RGBA);
  });
});

describe("adaptEmail", () => {
  it("leaves transparent, currentColor and inherit as written", () => {
    const { html } = adaptEmail(`<p style="color:currentColor;background:transparent;border-color:inherit">x</p>`, false);
    expect(html).toContain("color:currentColor");
    expect(html).toContain("background:transparent");
    expect(html).toContain("border-color:inherit");
  });
  it("rewrites colors in inline styles, attributes and style blocks", () => {
    const { html } = adaptEmail(`<style>.a{color:#000;background-color:#fff}</style><table bgcolor="#ffffff"><tr><td class="a"><font color="#7a0019">x</font></td></tr></table>`, false);
    expect(html).not.toContain('bgcolor="#ffffff"');
    expect(html).toContain(`bgcolor="${DARK_CARD}"`);
    expect(html).not.toMatch(/color="#7a0019"/i);
    expect(html).toMatch(/\.a\{color: #e6e7ea;background-color: #16181c\}/);
  });
  it("keeps url() untouched inside a background shorthand", () => {
    const { html } = adaptEmail(`<div style="background:#ffffff url('https://x.example.com/a.png#fff') no-repeat">x</div>`, false);
    expect(html).toContain("url('https://x.example.com/a.png#fff')");
  });
  it("fixes inherited text that a light background behind it would hide", () => {
    // Text color from a style rule, background from an inline style on a child: still reads.
    const doc = new DOMParser().parseFromString(
      `<body>${adaptEmail(`<style>.t{color:#555555}</style><div class="t"><p style="background:#0a66ff">on a blue band</p></div>`, false).html}</body>`,
      "text/html",
    );
    const p = doc.querySelector("p") as HTMLElement;
    expect(p.getAttribute("style")).toMatch(/color: #[0-9a-f]{6} !important/);
  });
  it("survives hostile CSS and markup without throwing", () => {
    const nasty = [
      `<style>}}}{{{ p { color: rgb( } .x{background:#fff</style><p>x</p>`,
      `<style>${"@media screen{".repeat(50)}p{color:#000}</style><p>x</p>`,
      `<p style="color:${"#000 ".repeat(5000)}">x</p>`,
      `<p style="color:rgb(1e400,0,0);background:hsl(nan,1%,1%)">x</p>`,
      `<style>p::before{color:#000} :not(:not(:not(p))){color:#000} [x="}"]{color:red} p:hover{color:#111}</style><p>x</p>`,
      `${"<div>".repeat(400)}deep${"</div>".repeat(400)}`,
      `<style>p{color:#000;background:url(data:image/png;base64,AA;AA)}</style><p>x</p>`,
    ];
    for (const n of nasty) expect(() => adaptEmail(sanitizedFor(n), false)).not.toThrow();
  });
  it("keeps the light card for an email too large to adapt", () => {
    const huge = `<p style="color:#333">${"<span style=\"color:#444\">x</span>".repeat(25_000)}</p>`;
    expect(canRenderDark(huge)).toBe(false);
    expect(prepareHtml(huge, false, "dark").dark).toBe(false);
  }, 30_000);
  it("never changes the stored email or the light rendering", () => {
    const raw = `${OUTLOOK}`;
    const clean = sanitizedFor(raw);
    const light = prepareHtml(raw, false, "light");
    prepareHtml(raw, false, "dark");
    prepareHtml(raw, true, "dark");
    expect(raw).toBe(OUTLOOK);
    expect(sanitizedFor(raw)).toBe(clean);
    expect(prepareHtml(raw, false, "light")).toEqual(light);
  });
});

// ---- Fixture checks, measured independently with jsdom's own cascade ----

const UA_LINK = "rgb(0, 0, 238)"; // jsdom lets its UA link color beat the frame's a{} rule
const DARK_LINK_SHOWN = "#7fb2ff";

/**
 * Lay the prepared HTML into the test document with the frame CSS and report each
 * text run's color against the background behind it. HTML color attributes go in as
 * zero-specificity rules, as browsers treat them. Text on a loading background image
 * is skipped (its colors are kept as authored, for the image).
 */
function textRuns(html: string, css: string, cardHex: string, skipImages: boolean) {
  const tmp = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const hints: string[] = [];
  let n = 0;
  for (const el of tmp.body.querySelectorAll("[bgcolor], font[color]")) {
    const parts: string[] = [];
    const bg = el.getAttribute("bgcolor");
    const fg = el.tagName === "FONT" ? el.getAttribute("color") : null;
    if (bg && parseColor(bg, true)) parts.push(`background-color:${hex(c(bg))}`);
    if (fg && parseColor(fg, true)) parts.push(`color:${hex(c(fg))}`);
    el.setAttribute("data-zt", String(n));
    hints.push(`:where([data-zt="${n++}"]){${parts.join(";")}}`);
  }
  document.head.innerHTML = `<style>${hints.join("")}</style><style>${css}</style>`;
  document.body.innerHTML = tmp.body.innerHTML;
  const runs: Array<{ text: string; fg: string; bg: string; ratio: number }> = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const text = (t.textContent ?? "").trim();
    const el = t.parentElement;
    if (!text || !el || el.closest("style")) continue;
    if (skipImages && el.closest('[background], [style*="url("]')) continue;
    const shown = getComputedStyle(el).color;
    const fg = shown === UA_LINK ? c(DARK_LINK_SHOWN) : c(shown);
    const layers: Rgba[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const b = parseColor(getComputedStyle(e).backgroundColor);
      if (b && b.a > 0) layers.push(b);
      if (b && b.a >= 1) break;
    }
    let bg = c(cardHex);
    for (const l of layers.reverse()) bg = over(l, bg);
    runs.push({ text, fg: hex(fg), bg: hex(bg), ratio: contrast(over(fg, bg), bg) });
  }
  return runs;
}

function expectAllRead(html: string, skipImages = false) {
  const runs = textRuns(html, DARK_CSS, DARK_CARD, skipImages);
  expect(runs.length).toBeGreaterThan(0);
  for (const r of runs) expect(r.ratio, `"${r.text}" ${r.fg} on ${r.bg}`).toBeGreaterThanOrEqual(4.5);
  return runs;
}

describe("dark rendering of real-world-shaped email", () => {
  it("adapts an Outlook message: black/windowtext, maroon signature, quoted header", () => {
    expect(darkKindFor(sanitizedFor(OUTLOOK))).toBe("adapt");
    for (const allow of [false, true]) {
      const r = prepareHtml(OUTLOOK, allow, "dark");
      expect(r.dark).toBe(true);
      const runs = expectAllRead(r.html);
      const sig = runs.find((x) => x.text === "Jordan Example");
      expect(sig).toBeDefined();
      const out = c(sig?.fg ?? "#000");
      expect(hueGap(hueDeg(out), hueDeg(c("#7a0019")))).toBeLessThan(10);
      expect(oklch(out).c).toBeGreaterThan(0.06);
      expect(runs.find((x) => x.text === "Hi team,")?.fg).toBe(DARK_TEXT);
    }
    // The quoted header's #E1E1E1 rule becomes a quiet dark line, still visible on the card.
    const rule = /border-top: solid (#[0-9a-f]{6}) 1\.0pt/.exec(prepareHtml(OUTLOOK, false, "dark").html);
    expectQuietLine(c(rule?.[1] ?? "#ffffff"), CARD_RGBA);
  });
  it("adapts a Gmail message", () => {
    expect(darkKindFor(sanitizedFor(GMAIL))).toBe("adapt");
    const html = prepareHtml(GMAIL, false, "dark").html;
    const runs = expectAllRead(html);
    const sig = c(runs.find((x) => x.text === "Alex Placeholder")?.fg ?? "#000");
    expect(hueGap(hueDeg(sig), hueDeg(c("rgb(80,0,80)")))).toBeLessThan(10);
    // The #ccc quote bar too.
    const bar = /border-left: 1px solid (#[0-9a-f]{6})/.exec(html);
    expectQuietLine(c(bar?.[1] ?? "#ffffff"), CARD_RGBA);
  });
  it("adapts a newsletter with nested bgcolor tables and a colored button", () => {
    expect(darkKindFor(sanitizedFor(NEWSLETTER))).toBe("adapt");
    const r = prepareHtml(NEWSLETTER, false, "dark");
    expect(r.dark).toBe(true);
    const runs = expectAllRead(r.html);
    const button = runs.find((x) => x.text === "Shop the sale");
    expect(button?.fg).toBe("#ffffff");
    // The red button stays red, darker.
    expect(hueGap(hueDeg(c(button?.bg ?? "#000")), hueDeg(c("#e4002b")))).toBeLessThan(12);
    expect(runs.find((x) => x.text === "Free returns for 30 days.")?.bg).toBe("#333333");
    // Its light-scheme rules still apply (adapted); there are no dark ones to apply.
    expect(r.html).toContain("@media (min-width: 0px)");
  });
  it("keeps an email's own dark design as it is", () => {
    expect(darkKindFor(sanitizedFor(OWN_DARK))).toBe("own");
    const r = prepareHtml(OWN_DARK, false, "dark");
    expect(r.dark).toBe(true);
    expect(r.html).toContain('style="background:#ffffff;padding:16px"');
    expect(r.html).toContain("screen and (min-width: 0px)");
  });
  it("renders a plain email on the dark card unchanged", () => {
    expect(darkKindFor(sanitizedFor(PLAIN))).toBe("simple");
    const r = prepareHtml(PLAIN, false, "dark");
    expect(r.dark).toBe(true);
    expect(r.html).toBe(prepareHtml(PLAIN, false, "light").html);
    expectAllRead(r.html);
  });
  it("adapts link colors in an otherwise plain email, so a #00f link reads on the dark card", () => {
    const inline = `<p>Hi, the <a href="https://x.example.com" style="color:#0000ff">agenda</a> is up.</p>`;
    const block = `<p>Hi,</p><style>a { color: blue; }</style><p>the <a href="https://x.example.com">agenda</a> is up.</p>`;
    for (const h of [inline, block]) {
      expect(darkKindFor(sanitizedFor(h))).toBe("adapt");
      const r = prepareHtml(h, false, "dark");
      expect(r.dark).toBe(true);
      expect(r.html).not.toMatch(/#0000ff|color: blue/i);
      const link = expectAllRead(r.html).find((x) => x.text === "agenda");
      expect(contrast(c(link?.fg ?? "#000"), CARD_RGBA)).toBeGreaterThanOrEqual(4.5);
      // Still blue.
      expect(hueGap(hueDeg(c(link?.fg ?? "#000")), hueDeg(c("#0000ff")))).toBeLessThan(10);
    }
  });
  it("adapts around a background-image hero, keeping the hero's own colors when images load", () => {
    expect(darkKindFor(sanitizedFor(HERO))).toBe("adapt");
    const loaded = prepareHtml(HERO, true, "dark");
    expect(loaded.dark).toBe(true);
    expect(loaded.html).toContain("color:#3b2a14");
    expect(loaded.html).toContain("background-color:#f0e6d2");
    expectAllRead(loaded.html, true);
    // Images off: the hero shows its (adapted) color, and its text reads on it.
    expectAllRead(prepareHtml(HERO, false, "dark").html);
  });
  it("keeps the light card for an email laid out on a background image", () => {
    expect(darkKindFor(sanitizedFor(IMAGE_LAYOUT))).toBe("light");
    expect(prepareHtml(IMAGE_LAYOUT, true, "dark").dark).toBe(false);
    expect(prepareHtml(IMAGE_LAYOUT, false, "dark").dark).toBe(false);
  });
  it("light rendering of every fixture is today's, untouched by the adaptation", () => {
    for (const f of Object.values(FIXTURES)) {
      const r = prepareHtml(f, false, "light");
      expect(r.dark).toBe(false);
      expect(textRuns(r.html, LIGHT_CSS, "#ffffff", false).length).toBeGreaterThan(0);
    }
  });
});

describe("style blocks stay closed", () => {
  // Rewriting a style block drops its comments; "<//**/style>" must not become a real end tag
  // that lets markup the sanitizer never saw (a meta refresh) out into the frame.
  const LIGHT = "<p style=\"color:#333\">Hi</p>";
  for (const css of [
    "p{color:#333}<//**/style><meta http-equiv=refresh content=0;url=https://evil.test>",
    "p{color:#333}</<!--style><meta http-equiv=refresh content=0;url=https://evil.test>",
  ]) {
    it(`keeps the style block's text inside it: ${css.slice(13, 28)}`, () => {
      const style = document.createElement("style");
      style.textContent = css;
      const { html } = adaptEmail(`${style.outerHTML}${LIGHT}`, false);
      const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
      expect(doc.querySelector("meta")).toBeNull();
      expect(doc.querySelectorAll("style")).toHaveLength(1);
    });
  }
});
