// index.css rules for macOS display settings: light/dark native controls, frosted menus, Reduce
// transparency and Increase contrast. Checked as text, since jsdom doesn't apply stylesheets.
import { describe, expect, it } from "vitest";

// Read from disk: Vitest hands CSS imports to tests empty, even with ?raw. Node's fs is fetched at
// run time so its types don't spread to the app's code.
type Fs = { readFileSync(path: URL, encoding: "utf8"): string };
const fs = (globalThis as unknown as { process: { getBuiltinModule(id: "node:fs"): Fs } }).process.getBuiltinModule("node:fs");
const css = fs.readFileSync(new URL("../../index.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** The app's source files (not tests), as text. */
const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/__tests__/**"], { query: "?raw", import: "default", eager: true });

/** Every flat rule as [selectors, body], nested ones included. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].split(",").map((s) => s.trim().replace(/\s+/g, " ")),
  body: m[2],
}));

/** The text inside the braces of the first block whose head matches ("" when there's none). */
function blockAfter(head: RegExp, from = css): string {
  const m = head.exec(from);
  if (!m) return "";
  const open = from.indexOf("{", m.index);
  let depth = 0;
  for (let i = open; i < from.length; i++) {
    if (from[i] === "{") depth++;
    else if (from[i] === "}" && --depth === 0) return from.slice(open + 1, i);
  }
  throw new Error("unbalanced braces");
}

const decl = (body: string, prop: string) => new RegExp(`(^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(body)?.[2].trim();

describe("native controls", () => {
  it("follow the app's light or dark theme, not only the OS", () => {
    const root = rules.find((r) => r.selectors.includes(":root") && decl(r.body, "color-scheme"));
    const dark = rules.find((r) => r.selectors.includes(":root.dark") && decl(r.body, "color-scheme"));
    expect(decl(root!.body, "color-scheme")).toBe("light");
    expect(decl(dark!.body, "color-scheme")).toBe("dark");
  });
});

describe("Translucent theme menus", () => {
  const frosted = rules.find((r) => decl(r.body, "backdrop-filter")?.startsWith("blur("))!;

  it("frost right-click menus and select popups like the other menus", () => {
    for (const slot of ["popover-content", "dropdown-menu-content", "dropdown-menu-sub-content", "context-menu-content", "context-menu-sub-content", "select-content", "dialog-content"]) {
      expect(frosted.selectors).toContain(`.translucent [data-slot="${slot}"]`);
    }
  });

  it("lose every blur under Reduce transparency", () => {
    const cleared = rules.filter((r) => decl(r.body, "backdrop-filter") === "none").flatMap((r) => r.selectors);
    for (const sel of frosted.selectors) expect(cleared).toContain(sel.replace(/^\.translucent /, ".reduce-transparency "));
    expect(cleared).toContain('.reduce-transparency [data-slot="dialog-overlay"]');
  });
});

describe("Reduce transparency", () => {
  it("makes the Translucent theme's surfaces opaque in light and dark", () => {
    for (const sel of [".reduce-transparency.translucent", ".reduce-transparency.translucent.dark"]) {
      const r = rules.find((x) => x.selectors.includes(sel))!;
      for (const token of ["--shell", "--pane", "--pane-2", "--popover"]) {
        const v = decl(r.body, token);
        expect(v, `${sel} ${token}`).toMatch(/^oklch\(/);
        expect(v, `${sel} ${token}`).not.toContain("/");
      }
    }
  });

  it("paints the window background instead of letting vibrancy through", () => {
    const r = rules.find((x) => x.selectors.includes("html.reduce-transparency.translucent body"))!;
    expect(decl(r.body, "background")).toBe("var(--shell)");
  });
});

describe("Increase contrast", () => {
  const tokens = blockAfter(/@media \(prefers-contrast: more\)/);
  const utilities = blockAfter(/@media \(prefers-contrast: more\)/, blockAfter(/@layer utilities/));

  it("draws defined edges", () => {
    expect(tokens).toMatch(/--hairline:\s*oklch\([^)]*\/ 32%\)/);
    expect(tokens).toMatch(/:root\.dark\s*\{[^}]*--hairline/);
  });

  it("raises every faint secondary text color used in the app to 65% or more", () => {
    const faint = new Set<string>();
    for (const text of Object.values(sources)) {
      for (const m of text.matchAll(/(?<![\w:-])((?:placeholder:)?text-foreground\/(\d+))(?![\w.])/g)) {
        if (Number(m[2]) < 70) faint.add(m[1]);
      }
    }
    expect(faint.size).toBeGreaterThan(5);
    for (const t of faint) {
      const sel = t.startsWith("placeholder:") ? `[class~="${t}"]::placeholder` : `[class~="${t}"]`;
      const r = [...utilities.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].split(",").map((s) => s.trim()).includes(sel));
      expect(r, sel).toBeTruthy();
      const pct = Number(/var\(--foreground\) (\d+)%/.exec(r![2])?.[1]);
      expect(pct, sel).toBeGreaterThanOrEqual(65);
    }
  });
});
