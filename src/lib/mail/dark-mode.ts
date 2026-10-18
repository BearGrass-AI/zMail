// Whether and how an email body renders dark, decided on its sanitized HTML. The
// sanitize cache lives here too, so prepareHtml and the dark checks sanitize each
// body once.

import DOMPurify from "dompurify";
import type { MessageBackground } from "@/lib/settings";
import { adaptEmail, dependsOnImages } from "./dark-adapt";

const DARK_RULE = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i;

function sanitize(html: string) {
  return DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "meta", "link", "base"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "srcset"],
    ADD_ATTR: ["target"],
  });
}

/** Tiny LRU keyed by the exact input string (Map keeps insertion order). */
function createLru<V>(capacity: number) {
  const m = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      if (!m.has(key)) return undefined;
      const v = m.get(key) as V;
      m.delete(key);
      m.set(key, v);
      return v;
    },
    set(key: string, v: V) {
      m.delete(key);
      m.set(key, v);
      if (m.size > capacity) m.delete(m.keys().next().value as string);
    },
    has: (key: string) => m.has(key),
    get size() {
      return m.size;
    },
  };
}

/**
 * How an email renders in dark mode:
 * - own: it ships its own prefers-color-scheme dark rules, which apply.
 * - simple: it sets no colors (not even on links), so it takes the dark card's.
 * - adapt: its light colors are remapped for the dark card (see dark-adapt.ts).
 * - light: it keeps the light card (its layout depends on background images, or
 *   it's too large or odd to adapt safely).
 */
export type DarkKind = "own" | "simple" | "adapt" | "light";

const sanitizeCache = createLru<string>(30);
const darkCache = createLru<DarkKind>(30);
// Adapted HTML per sanitized body, one cache per remote-images setting (images that
// load change which text keeps its authored colors). null: adapting failed.
const adaptWithImages = createLru<string | null>(30);
const adaptNoImages = createLru<string | null>(30);

/** Memoized sanitize: same input string, same output (the sanitizer config is constant). */
export function sanitizedFor(raw: string) {
  const hit = sanitizeCache.get(raw);
  if (hit !== undefined) return hit;
  const clean = sanitize(raw);
  sanitizeCache.set(raw, clean);
  return clean;
}

/** Memoized dark-mode kind for sanitized content. */
export function darkKindFor(clean: string): DarkKind {
  const hit = darkCache.get(clean);
  if (hit !== undefined) return hit;
  const d = decideDark(clean);
  darkCache.set(clean, d);
  return d;
}

export function darkFor(clean: string) {
  return darkKindFor(clean) !== "light";
}

function runAdapt(clean: string, allowImages: boolean) {
  try {
    return adaptEmail(clean, allowImages);
  } catch {
    return null;
  }
}

/**
 * Memoized adapted HTML for the dark card, or null when it can't be adapted. Only
 * the rendered frame uses it; the stored email (and what's quoted from it) is untouched.
 */
export function adaptedFor(clean: string, allowImages: boolean): string | null {
  const cache = allowImages ? adaptWithImages : adaptNoImages;
  const hit = cache.get(clean);
  if (hit !== undefined) return hit;
  const html = runAdapt(clean, allowImages)?.html ?? null;
  cache.set(clean, html);
  return html;
}

function hasDarkRules(clean: string) {
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, "text/html");
  return [...doc.querySelectorAll("style")].some((st) => DARK_RULE.test(st.textContent ?? ""));
}

/**
 * True when the email ships its own dark design: an active prefers-color-scheme
 * dark media rule that survives sanitizing. A bare color-scheme meta or
 * declaration is not enough, since the email's inline colors may assume light.
 */
export function emailSupportsDark(raw: string) {
  return hasDarkRules(sanitizedFor(raw));
}

const COLOR_DECL = /(?:^|[;{\s"'])(?:background(?:-color)?|color)\s*:/i;

/** True when the email sets no colors of its own (link color ignored), so it can take the app's dark colors. */
export function isSimpleHtml(raw: string) {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  if (doc.querySelector("[bgcolor], [background], font[color], [text]")) return false;
  for (const el of doc.querySelectorAll("[style]")) {
    if (el.tagName === "A") continue;
    if (COLOR_DECL.test(el.getAttribute("style") ?? "")) return false;
  }
  for (const st of doc.querySelectorAll("style")) {
    // Ignore rules that only style links.
    const css = (st.textContent ?? "").replace(/(^|\})\s*a(?::[\w-]+)?\s*\{[^}]*\}/gi, "$1");
    if (COLOR_DECL.test(css)) return false;
  }
  return true;
}

/**
 * True when a link sets its own color: inline, or in a style block. Used only on
 * simple HTML, whose style blocks color nothing but links.
 */
function hasLinkColors(clean: string) {
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, "text/html");
  for (const a of doc.querySelectorAll("a[style]")) if (COLOR_DECL.test(a.getAttribute("style") ?? "")) return true;
  return [...doc.querySelectorAll("style")].some((st) => COLOR_DECL.test(st.textContent ?? ""));
}

/** Would this HTML render dark in dark mode (its own dark design, no colors of its own, or adapted)? */
export function canRenderDark(raw: string) {
  return darkFor(sanitizedFor(raw));
}

/**
 * Warm what showing an email not yet opened will need. The dark decision runs the
 * adapter, the costliest step on hostile mail, so it's only made when the email would
 * show dark: the app is dark and messages follow the theme.
 */
export function warmRender(raw: string, appDark: boolean, background: MessageBackground) {
  const clean = sanitizedFor(raw);
  if (appDark && background === "theme") darkKindFor(clean);
}

/**
 * Decide on sanitized content, i.e. what the iframe will actually contain. The
 * background-image check assumes images load, so the answer doesn't change when
 * the user loads them.
 */
function decideDark(clean: string): DarkKind {
  if (hasDarkRules(clean)) return "own";
  // Colors only on links still need adapting: an authored #00f link can't stay dark blue on the dark card.
  if (isSimpleHtml(clean) && !hasLinkColors(clean)) return "simple";
  const r = runAdapt(clean, true);
  if (!r || dependsOnImages(r)) return "light";
  adaptWithImages.set(clean, r.html);
  return "adapt";
}
