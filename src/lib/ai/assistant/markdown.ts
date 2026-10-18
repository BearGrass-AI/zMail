// src/lib/ai/assistant/markdown.ts
// Model replies are Markdown. Render with marked (GFM), then sanitize hard:
// only the tags below survive, so no raw HTML from the model gets through.

import { marked } from "marked";
import DOMPurify from "dompurify";
import type { RefInfo } from "./state";

const TAGS = ["p", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "a", "blockquote", "h3", "h4"];

// An isolated instance: hooks on the shared default would leak into email bodies.
const purify = DOMPurify(window);

purify.addHook("afterSanitizeAttributes", (node) => {
  if (node.hasAttribute("class") && node.getAttribute("class") !== "num") node.removeAttribute("class");
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer");
  }
});

const NUM_HEADERS = /^(count|#|emails?)$/i;
const CITE = /\[(m\d+)\]/;
const CITE_G = /\[(m\d+)\]/g;
const NUMERIC = /^[+-]?[\d,.]+%?$/;

/** The host a link's text reads as, when it is one URL or bare domain ("www.example.com"); else null. */
function hostIn(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  try {
    const u = new URL(/^[a-z][a-z\d+.-]*:/i.test(t) ? t : `https://${t}`);
    // "bank.example@attacker.example" names a host it doesn't go to.
    return u.username || u.password ? null : u.hostname;
  } catch {
    return null;
  }
}

/**
 * A reply's links are model-written, and an email the model read can steer both the text and the
 * URL (which may carry mail content in its query). So each http(s) link shows its real host after
 * the text, unless the text already reads as that host (a bare URL isn't doubled), and the full URL
 * on hover. A look-alike (punycode) host is always shown in its plain form.
 */
function showDestination(a: Element, href: string) {
  let host: string;
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
    host = u.hostname;
  } catch {
    return;
  }
  a.setAttribute("title", href);
  const text = a.textContent ?? "";
  if (!host.includes("xn--") && hostIn(text) === host) return;
  a.append(a.ownerDocument.createTextNode(text.trim() ? ` (${host})` : host));
}

/** Tag numeric table columns, show link destinations and unwrap mailto links on the sanitized DOM (no re-parse). */
function polish(root: HTMLElement, refs?: Record<string, RefInfo>): { html: string; cited: string[] } {
  const cited: string[] = [];
  const doc = root.ownerDocument;
  // Citations: [mN] becomes a numbered button; unknown or unsupported tokens are dropped. Skips code.
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.parentElement?.closest("code, pre")) && CITE.test(n.nodeValue ?? "")) texts.push(n as Text);
    CITE.lastIndex = 0;
  }
  for (const node of texts) {
    const frag = doc.createDocumentFragment();
    const value = node.nodeValue ?? "";
    let last = 0;
    for (const m of value.matchAll(CITE_G)) {
      frag.append(value.slice(last, m.index));
      last = m.index + m[0].length;
      if (!refs || !Object.hasOwn(refs, m[1])) continue;
      let n = cited.indexOf(m[1]) + 1;
      if (!n) n = cited.push(m[1]);
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "cite";
      b.setAttribute("data-ref", m[1]);
      b.textContent = String(n);
      frag.append(b);
    }
    frag.append(value.slice(last));
    node.replaceWith(frag);
  }
  for (const a of Array.from(root.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (!/^mailto:/i.test(href)) {
      showDestination(a, href);
      continue;
    }
    let addr = href.replace(/^mailto:/i, "").split("?")[0];
    try {
      addr = decodeURIComponent(addr);
    } catch {
      /* keep raw */
    }
    const text = a.textContent ?? "";
    a.replaceWith(root.ownerDocument.createTextNode(!text || text.trim() === addr ? addr || text : `${text} (${addr})`));
  }
  for (const table of Array.from(root.querySelectorAll("table"))) {
    const head = Array.from(table.querySelectorAll("thead th"));
    const body = Array.from(table.querySelectorAll("tbody tr"));
    head.forEach((th, i) => {
      const cells = body.map((r) => r.children[i]).filter(Boolean);
      const numeric =
        NUM_HEADERS.test((th.textContent ?? "").trim()) ||
        (cells.length > 0 && cells.every((c) => NUMERIC.test((c.textContent ?? "").trim()) && /\d/.test(c.textContent ?? "")));
      if (!numeric) return;
      th.classList.add("num");
      for (const c of cells) c.classList.add("num");
    });
    // Wrap after sanitizing, so the class is ours and the allowlist stays "num" only.
    const wrap = root.ownerDocument.createElement("div");
    wrap.className = "md-table";
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
  return { html: root.innerHTML, cited };
}

export function renderMarkdown(text: string, refs?: Record<string, RefInfo>): { html: string; cited: string[] } {
  const raw = marked.parse(text, { gfm: true, async: false }) as string;
  return polish(purify.sanitize(raw, { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ["href", "align", "target", "rel", "class"], ALLOW_DATA_ATTR: false, RETURN_DOM: true }) as unknown as HTMLElement, refs);
}
