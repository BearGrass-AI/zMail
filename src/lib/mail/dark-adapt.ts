// Adapting a light-designed email to the dark card, as Apple Mail and Outlook do:
// light backgrounds turn dark, text and borders turn light enough to read on what
// ends up behind them, hues stay. Only the rendered copy changes; the stored email
// and anything quoted from it keep the original.
//
// Every input here is hostile: values are parsed defensively, work is bounded, and
// the caller treats a throw as "keep the light card".

import {
  CARD_RGBA,
  DARK_LINK,
  LIGHT_LINK,
  LIGHT_TEXT,
  MIN_CONTRAST,
  TEXT_RGBA,
  WHITE_RGBA,
  adaptBackground,
  adaptBorder,
  adaptForeground,
  contrast,
  formatColor,
  over,
  parseColor,
  type Rgba,
} from "./color";

/** Past these sizes an email keeps the light card rather than risk a slow render. */
const MAX_ADAPT_CHARS = 1_500_000;
const MAX_ADAPT_ELEMENTS = 20_000;
const MAX_VALUE = 4_000;
const MAX_SELECTORS = 3_000;
const MAX_MATCH_WORK = 4_000_000;
/** Share of the email's text sitting on background images past which it stays light. */
const IMAGE_TEXT_SHARE = 0.4;

const LIGHT_TEXT_RGBA = parseColor(LIGHT_TEXT) as Rgba;
const LIGHT_LINK_RGBA = parseColor(LIGHT_LINK) as Rgba;
const DARK_LINK_RGBA = parseColor(DARK_LINK) as Rgba;

type Role = "bg" | "fg" | "border";

const BORDER_PROP = /^(?:border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|column-rule(?:-color)?)$/;
const FG_PROP = /^(?:color|-webkit-text-fill-color|caret-color|text-decoration(?:-color)?)$/;

/** How a declaration's colors map. Text decorations follow their text; an <hr>'s colors are its line. */
function roleOf(prop: string, hr = false): Role | null {
  if (hr && (prop === "color" || prop === "background" || prop === "background-color")) return "border";
  if (prop === "background" || prop === "background-color") return "bg";
  if (FG_PROP.test(prop)) return "fg";
  if (BORDER_PROP.test(prop)) return "border";
  return null;
}

// ---- Values ----

const URL_PART = /(url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\))/i;
const COLOR_TOKEN = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^()]{0,100}\)|\b[a-z]{3,20}\b/gi;

/** The first color in a CSS value (outside url()), or null. */
function firstColor(value: string): Rgba | null {
  for (const [i, part] of value.split(URL_PART).entries()) {
    if (i % 2 === 1) continue;
    for (const m of part.matchAll(COLOR_TOKEN)) {
      const c = parseColor(m[0]);
      if (c) return c;
    }
  }
  return null;
}

/** Rewrite each color in `value` (url() untouched). Returns the value as is when nothing parses. */
function mapValue(value: string, map: (c: Rgba) => Rgba): string {
  if (value.length > MAX_VALUE) return value;
  return value
    .split(URL_PART)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(COLOR_TOKEN, (tok) => {
            const c = parseColor(tok);
            return c ? formatColor(map(c)) : tok;
          }),
    )
    .join("");
}

const hasUrl = (value: string) => /url\(/i.test(value);
// prepareHtml blanks every inline url() when remote images are off; style blocks keep data: URLs.
const urlLoads = (value: string, allowImages: boolean, inline: boolean) => {
  const m = /url\(\s*["']?\s*([^"')\s]*)/i.exec(value);
  if (!m) return false;
  if (inline) return allowImages && /^(https?:|data:|\/\/)/i.test(m[1]);
  return /^data:/i.test(m[1]) || (allowImages && /^(https?:|\/\/)/i.test(m[1]));
};

// ---- Declarations ----

type Decl = { raw: string; prop: string; value: string; important: boolean };

/** Split a declaration list on `;` outside strings and parentheses (data: URLs contain `;`). */
function splitDecls(text: string): Decl[] {
  const out: Decl[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const colon = raw.indexOf(":");
    if (colon > 0) {
      let value = raw.slice(colon + 1);
      const imp = /!\s*important\s*$/i.exec(value);
      if (imp) value = value.slice(0, imp.index);
      out.push({ raw, prop: raw.slice(0, colon).trim().toLowerCase(), value: value.trim(), important: !!imp });
    } else out.push({ raw, prop: "", value: "", important: false });
    start = end + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) push(i);
  }
  push(text.length);
  return out;
}

function joinDecls(decls: Decl[]) {
  return decls.map((d) => d.raw).join(";");
}

/** Replace a declaration's value, keeping its property text and !important. */
function setValue(d: Decl, value: string) {
  if (value === d.value) return;
  const colon = d.raw.indexOf(":");
  d.raw = `${d.raw.slice(0, colon)}: ${value}${d.important ? " !important" : ""}`;
  d.value = value;
}

/** What a declaration list says about an element's colors, last declaration winning per property. */
type Sets = {
  fg?: { orig: Rgba | null; shown: Rgba | null; important: boolean };
  bg?: { orig: Rgba | null; important: boolean };
  img?: { url: boolean; loads: boolean; important: boolean };
};

function summarize(decls: Decl[], allowImages: boolean, inline: boolean): Sets {
  const s: Sets = {};
  // Within one list an !important declaration beats a later normal one.
  const take = <K extends keyof Sets>(k: K, v: NonNullable<Sets[K]>) => {
    const cur = s[k];
    if (!cur || v.important || !cur.important) s[k] = v;
  };
  for (const d of decls) {
    if (d.prop === "color") {
      const c = parseColor(d.value);
      take("fg", { orig: c, shown: c, important: d.important });
    } else if (d.prop === "background-color") {
      take("bg", { orig: parseColor(d.value), important: d.important });
    } else if (d.prop === "background") {
      take("bg", { orig: d.value.length > MAX_VALUE ? null : firstColor(d.value), important: d.important });
      take("img", { url: hasUrl(d.value), loads: urlLoads(d.value, allowImages, inline), important: d.important });
    } else if (d.prop === "background-image") {
      take("img", { url: hasUrl(d.value), loads: urlLoads(d.value, allowImages, inline), important: d.important });
    }
  }
  return s;
}

/**
 * Rewrite every color declaration in a list for a known background, dark (`bg`) and
 * as authored (`authoredBg`). Style blocks use the plain dark card and the white card.
 */
function adaptDecls(decls: Decl[], bg: Rgba, authoredBg: Rgba, hr = false) {
  for (const d of decls) {
    const role = roleOf(d.prop, hr);
    if (!role || !d.value) continue;
    const map =
      role === "bg" ? adaptBackground : role === "border" ? (c: Rgba) => adaptBorder(c, bg, authoredBg) : (c: Rgba) => adaptForeground(c, bg);
    setValue(d, mapValue(d.value, map));
  }
}

// ---- Style blocks ----

type CssNode =
  | { kind: "raw"; text: string }
  | { kind: "rule"; selector: string; decls: Decl[] }
  | { kind: "block"; prelude: string; children: CssNode[] };

const NESTING_AT = /^@(?:media|supports|document|container|layer)\b/i;

/** A forgiving, linear-time CSS splitter: rules, nesting at-rules, and everything else kept raw. */
function parseCss(css: string, depth: number): CssNode[] {
  const out: CssNode[] = [];
  const n = css.length;
  let i = 0;
  while (i < n) {
    let j = i;
    let quote = "";
    for (; j < n; j++) {
      const ch = css[j];
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{" || ch === ";" || ch === "}") break;
    }
    const prelude = css.slice(i, j);
    if (j >= n) {
      out.push({ kind: "raw", text: prelude });
      break;
    }
    if (css[j] !== "{") {
      out.push({ kind: "raw", text: prelude + css[j] });
      i = j + 1;
      continue;
    }
    let k = j + 1;
    let d = 1;
    quote = "";
    for (; k < n && d > 0; k++) {
      const ch = css[k];
      if (quote) {
        if (ch === "\\") k++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") d++;
      else if (ch === "}") d--;
    }
    const inner = css.slice(j + 1, d === 0 ? k - 1 : n);
    const p = prelude.trim();
    if (NESTING_AT.test(p) && depth < 4) out.push({ kind: "block", prelude, children: parseCss(inner, depth + 1) });
    else if (p.startsWith("@")) out.push({ kind: "raw", text: `${prelude}{${inner}}` });
    else out.push({ kind: "rule", selector: prelude, decls: splitDecls(inner) });
    i = k;
  }
  return out;
}

function printCss(nodes: CssNode[]): string {
  return nodes
    .map((nd) =>
      nd.kind === "raw" ? nd.text : nd.kind === "rule" ? `${nd.selector}{${joinDecls(nd.decls)}}` : `${nd.prelude}{${printCss(nd.children)}}`,
    )
    .join("");
}

type Rule = { selector: string; order: number; sets: Sets };

/** Style rules that touch colors, in source order, rewritten for the card. */
function adaptStyleBlocks(doc: Document, allowImages: boolean): Rule[] {
  const rules: Rule[] = [];
  const visit = (nodes: CssNode[]) => {
    for (const nd of nodes) {
      if (nd.kind === "block") visit(nd.children);
      if (nd.kind !== "rule") continue;
      const sets = summarize(nd.decls, allowImages, false);
      adaptDecls(nd.decls, CARD_RGBA, WHITE_RGBA);
      // What the rewritten rule now shows, for the contrast check against each element's background.
      if (sets.fg?.orig) sets.fg.shown = parseColor(formatColor(adaptForeground(sets.fg.orig, CARD_RGBA)));
      if (sets.fg || sets.bg || sets.img) rules.push({ selector: nd.selector, order: rules.length, sets });
    }
  };
  for (const style of doc.querySelectorAll("style")) {
    // CDO/CDC (<!-- -->) are ignorable in CSS; drop them with comments so selectors stay clean.
    const css = (style.textContent ?? "").replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "").replace(/<!--|-->/g, "");
    const nodes = parseCss(css, 0);
    visit(nodes);
    // Dropping comments can join "</" and "style" into an end tag the sanitizer never saw;
    // "<\/" means the same in CSS and can't close the element.
    style.textContent = printCss(nodes).replace(/<\//g, "<\\/");
  }
  return rules;
}

/** Split a selector list on top-level commas. */
function splitSelectors(sel: string) {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(sel.slice(start, i));
      start = i + 1;
    }
  }
  out.push(sel.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function specificity(sel: string) {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length;
  const classes = (sel.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (sel.match(/(?:^|[\s>+~(])[a-z][\w-]*/gi) ?? []).length;
  return ids * 1e6 + classes * 1e3 + types;
}

type Match = { spec: number; order: number; sets: Sets };

/** Which color rules apply to which elements. Skipped (empty) when matching would be too much work. */
function matchRules(doc: Document, rules: Rule[], elementCount: number) {
  const byEl = new Map<Element, Match[]>();
  const sels = rules.flatMap((r) => splitSelectors(r.selector).map((s) => ({ s, r })));
  if (sels.length > MAX_SELECTORS || sels.length * elementCount > MAX_MATCH_WORK) return byEl;
  for (const { s, r } of sels) {
    // Pseudo-elements never hold the text nodes we check.
    if (/::|:(?:before|after|first-line|first-letter)\b/i.test(s)) continue;
    let found: NodeListOf<Element>;
    try {
      found = doc.querySelectorAll(s);
    } catch {
      continue;
    }
    const spec = specificity(s);
    for (const el of found) {
      const list = byEl.get(el);
      const m = { spec, order: r.order, sets: r.sets };
      if (list) list.push(m);
      else byEl.set(el, [m]);
    }
  }
  return byEl;
}

// ---- The walk ----

type Source = "inline" | "rule" | "attr";
type Win<T> = { v: T; source: Source };

/** Cascade one property: inline !important, rule !important, inline, rule (by specificity, order), then HTML attributes. */
function winner<K extends keyof Sets>(k: K, inline: Sets, matches: Match[] | undefined, attr: Sets[K] | undefined): Win<NonNullable<Sets[K]>> | null {
  const inl = inline[k];
  if (inl?.important) return { v: inl as NonNullable<Sets[K]>, source: "inline" };
  let best: { m: Match; v: NonNullable<Sets[K]> } | null = null;
  for (const m of matches ?? []) {
    const v = m.sets[k];
    if (!v) continue;
    const better =
      !best ||
      (v.important && !best.v.important) ||
      (v.important === best.v.important && (m.spec > best.m.spec || (m.spec === best.m.spec && m.order > best.m.order)));
    if (better) best = { m, v: v as NonNullable<Sets[K]> };
  }
  if (best?.v.important) return { v: best.v, source: "rule" };
  if (inl) return { v: inl as NonNullable<Sets[K]>, source: "inline" };
  if (best) return { v: best.v, source: "rule" };
  if (attr) return { v: attr as NonNullable<Sets[K]>, source: "attr" };
  return null;
}

type Ctx = {
  /** Opaque background behind this element as rendered dark, and as authored. */
  bg: Rgba;
  authoredBg: Rgba;
  /** Text color as authored and as it shows now. */
  fgOrig: Rgba;
  fgShown: Rgba;
  /** Inside an element whose background image renders: colors stay as authored. */
  image: boolean;
};

const ROOT: Ctx = { bg: CARD_RGBA, authoredBg: WHITE_RGBA, fgOrig: LIGHT_TEXT_RGBA, fgShown: TEXT_RGBA, image: false };
const same = (a: Rgba, b: Rgba) => formatColor(a) === formatColor(b);
const reads = (fg: Rgba, bg: Rgba) => contrast(over(fg, bg), bg) >= MIN_CONTRAST;

function attrSets(el: Element, allowImages: boolean): Sets {
  const s: Sets = {};
  const bgcolor = el.getAttribute("bgcolor");
  if (bgcolor !== null) s.bg = { orig: parseColor(bgcolor, true), important: false };
  const background = el.getAttribute("background");
  if (background?.trim()) {
    const v = background.trim();
    s.img = { url: true, loads: /^data:/i.test(v) || (allowImages && /^(https?:|\/\/)/i.test(v)), important: false };
  }
  const color = el.tagName === "FONT" ? el.getAttribute("color") : el.tagName === "BODY" ? el.getAttribute("text") : null;
  if (color !== null) {
    const c = parseColor(color, true);
    s.fg = { orig: c, shown: c, important: false };
  }
  return s;
}

export type AdaptResult = { html: string; textChars: number; imageTextChars: number };

/**
 * Rewrite a sanitized email's colors for the dark card. `allowImages` says whether
 * remote background images will load (text on a loading image keeps its authored
 * colors; on one that won't load it is adapted like any other).
 */
export function adaptEmail(clean: string, allowImages: boolean): AdaptResult {
  if (clean.length > MAX_ADAPT_CHARS) throw new Error("too large to adapt");
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, "text/html");
  const all = doc.getElementsByTagName("*");
  if (all.length > MAX_ADAPT_ELEMENTS) throw new Error("too large to adapt");
  const rules = adaptStyleBlocks(doc, allowImages);
  const matches = matchRules(doc, rules, all.length);
  let textChars = 0;
  let imageTextChars = 0;
  // <html>/<body> attributes don't survive into the frame, so their fixes go in a style block.
  const rootFixes: string[] = [];

  const stack: Array<{ el: Element; parent: Ctx }> = [{ el: doc.documentElement, parent: ROOT }];
  while (stack.length) {
    const { el, parent } = stack.pop() as { el: Element; parent: Ctx };
    const tag = el.tagName;
    if (tag === "STYLE" || tag === "SCRIPT" || tag === "TEMPLATE") continue;
    const styleAttr = el.getAttribute("style");
    const decls = styleAttr ? splitDecls(styleAttr) : [];
    const inline = summarize(decls, allowImages, true);
    const attrs = attrSets(el, allowImages);
    const m = matches.get(el);
    const img = winner("img", inline, m, attrs.img);
    const bgW = winner("bg", inline, m, attrs.bg);
    const fgW = winner("fg", inline, m, attrs.fg);
    const overrides: string[] = [];
    const isLink = tag === "A";
    const ctx: Ctx = { ...parent };

    ctx.image = parent.image || (!!img?.v.url && img.v.loads);
    if (ctx.image) {
      // On a background image: everything as authored. Undo the style-block rewrite here.
      if (bgW?.source === "rule" && bgW.v.orig) overrides.push(`background-color: ${formatColor(bgW.v.orig)} !important`);
      const orig = fgW?.v.orig ?? (isLink ? LIGHT_LINK_RGBA : parent.fgOrig);
      const shownNow = fgW?.v.orig ? (fgW.source === "rule" ? (fgW.v.shown ?? orig) : orig) : isLink ? DARK_LINK_RGBA : parent.fgShown;
      if (!same(shownNow, orig)) overrides.push(`color: ${formatColor(orig)} !important`);
      ctx.fgOrig = orig;
      ctx.fgShown = orig;
    } else {
      const ownBg = bgW?.v.orig;
      if (ownBg && tag !== "HR") {
        ctx.bg = over(adaptBackground(ownBg), parent.bg);
        ctx.authoredBg = over(ownBg, parent.authoredBg);
      }
      // Inline and attribute colors are rewritten against this element's background.
      adaptDecls(decls, ctx.bg, ctx.authoredBg, tag === "HR");
      if (attrs.bg?.orig) el.setAttribute("bgcolor", formatColor(adaptBackground(attrs.bg.orig)));
      const orig = fgW?.v.orig;
      if (tag === "HR") {
        // A rule has no text; its color is its line.
        const line = parseColor(el.getAttribute("color") ?? "", true);
        if (line) el.setAttribute("color", formatColor(adaptBorder(line, ctx.bg, ctx.authoredBg)));
      } else if (orig && fgW.source !== "rule") {
        const shown = adaptForeground(orig, ctx.bg);
        if (fgW.source === "attr") el.setAttribute(tag === "BODY" ? "text" : "color", formatColor(shown));
        ctx.fgOrig = orig;
        ctx.fgShown = shown;
      } else {
        // From a style rule (rewritten for the plain card) or inherited: keep it if it reads here.
        const fgOrig = orig ?? (isLink ? LIGHT_LINK_RGBA : parent.fgOrig);
        const shown = orig ? (fgW?.v.shown ?? orig) : isLink ? DARK_LINK_RGBA : parent.fgShown;
        ctx.fgOrig = fgOrig;
        ctx.fgShown = shown;
        if (!reads(shown, ctx.bg)) {
          ctx.fgShown = adaptForeground(fgOrig, ctx.bg);
          overrides.push(`color: ${formatColor(ctx.fgShown)} !important`);
        }
      }
    }

    if ((tag === "BODY" || tag === "HTML") && overrides.length) rootFixes.push(`${tag.toLowerCase()}{${overrides.join(";")}}`);
    else if (styleAttr !== null || overrides.length) {
      const text = [joinDecls(decls), ...overrides].filter((s) => s.trim()).join("; ");
      if (text !== styleAttr) el.setAttribute("style", text);
    }
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const len = (child.textContent ?? "").trim().length;
        textChars += len;
        if (ctx.image) imageTextChars += len;
      }
    }
    const kids = el.children;
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ el: kids[i], parent: ctx });
  }
  const fixes = rootFixes.length ? `<style>${rootFixes.join("")}</style>` : "";
  return { html: fixes + doc.body.innerHTML, textChars, imageTextChars };
}

/** Whether an adapted email still mostly sits on background images (then it keeps the light card). */
export function dependsOnImages(r: AdaptResult) {
  return r.textChars > 0 && r.imageTextChars / r.textChars >= IMAGE_TEXT_SHARE;
}
