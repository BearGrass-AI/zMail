// HTML signatures: cleaning pasted Outlook/Word HTML, turning a plain-text body
// plus a signature into an HTML email, and pulling embedded images out so they
// travel as inline (cid:) parts instead of data: URIs that many clients block.

import DOMPurify from "dompurify";

export interface MailSignature {
  id: string;
  name: string;
  html: string;
}

/** Which signature each account uses; null means none. */
export interface SignatureDefaults {
  new: string | null;
  reply: string | null;
}

export interface InlineImage {
  cid: string;
  filename: string;
  mimeType: string;
  /** Standard base64. */
  base64: string;
}

/** Strip anything active but keep the tables and inline styles signatures depend on. */
export function sanitizeSignature(html: string): string {
  const stripped = html
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?o:p>/gi, "");
  const clean = DOMPurify.sanitize(stripped, {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "meta", "link", "base", "title"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "srcset", "id", "contenteditable"],
  });
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, "text/html");
  // Outlook relies on a stylesheet that gives MsoNormal paragraphs zero margins.
  for (const el of doc.body.querySelectorAll<HTMLElement>("[class]")) {
    if (/\bMso/i.test(el.getAttribute("class") ?? ""))
      for (const side of ["marginTop", "marginRight", "marginBottom", "marginLeft"] as const) if (!el.style[side]) el.style[side] = "0";
    el.removeAttribute("class");
  }
  return doc.body.innerHTML.trim();
}

/** Plain-text rendering of a signature or body, for the text/plain alternative. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const out: string[] = [];
  const block = /^(P|DIV|TR|LI|H[1-6]|TABLE|BLOCKQUOTE|UL|OL)$/;
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) return void out.push((n.textContent ?? "").replace(/\s+/g, " "));
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    if (el.tagName === "BR") return void out.push("\n");
    if (el.tagName === "TD" || el.tagName === "TH") out.push(" ");
    if (el.tagName === "LI") {
      const parent = el.parentElement;
      if (parent?.tagName === "OL") out.push(`${Array.prototype.indexOf.call(parent.children, el) + 1}. `);
      else if (parent?.tagName === "UL") out.push("- ");
    }
    el.childNodes.forEach(walk);
    if (block.test(el.tagName)) out.push("\n");
  };
  walk(doc.body);
  const lines = out
    .join("")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim());
  return lines
    .filter((l, i) => l || (i > 0 && lines[i - 1]))
    .join("\n")
    .trim();
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text to HTML: escaped, links clickable, line breaks kept. */
export function textToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\r?\n/g, "<br>");
}

export const BODY_STYLE = "font-family: Aptos, Calibri, Helvetica, Arial, sans-serif; font-size: 11pt;";

/** Marks the signature block so the send step only touches signature images; stripped before sending. */
const SIGNATURE_MARK = "data-zmail-signature";
const MARK_ATTR = new RegExp(`\\s${SIGNATURE_MARK}(?:=(?:""|''))?(?=[\\s>/])`, "g");
/** Stays on the saved signature block (a class, which Exchange keeps), so a reopened draft can get its signature back. */
export const SIGNATURE_CLASS = "zmail-signature";

/** The HTML email for a typed body and an optional signature. */
export function composeHtml(body: string, signatureHtml?: string): string {
  const main = `<div style="${BODY_STYLE}">${textToHtml(body.trimEnd())}</div>`;
  return withSignature(main, signatureHtml);
}

/** A body block followed by the marked signature block (when there is a signature). */
export function withSignature(main: string, signatureHtml?: string): string {
  // Marked even when empty, so a reopened draft finds our own block, not one in a quoted zMail message below it.
  if (!signatureHtml?.trim()) return `${main}<div class="${SIGNATURE_CLASS}"></div>`;
  return `${main}<br><div ${SIGNATURE_MARK}="" class="${SIGNATURE_CLASS}">${sanitizeSignature(signatureHtml)}</div>`;
}

/**
 * A saved draft split into the HTML before its marked signature block and that block's
 * contents. When the draft goes on after the block (Outlook's quoted original under a reply),
 * `quote` is the draft's document with only that rest in its body, to be kept as it is under
 * our text, since the composer can only put a signature last. Null when there's no block.
 */
export function splitSavedSignature(html: string): { body: string; signature: string; quote?: string } | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const block = doc.body.querySelector(`div.${SIGNATURE_CLASS}`);
  if (!block || block.closest("blockquote") || !doc.body.firstChild || !doc.body.lastChild) return null;
  const range = doc.createRange();
  range.setStartAfter(block);
  range.setEndAfter(doc.body.lastChild);
  const after = range.cloneContents();
  const rest = after.textContent?.trim() || after.querySelector("img, table") ? after : null;
  range.setStartBefore(doc.body.firstChild);
  range.setEndBefore(block);
  const before = doc.createElement("div");
  before.append(range.cloneContents());
  // Drop the <br> withSignature put above a signature; the next save adds it again.
  let last: Node | null = block.hasChildNodes() ? before : null;
  while (last instanceof Element && last.tagName !== "BR") {
    let c: ChildNode | null = last.lastChild;
    while (c && c.nodeType === Node.TEXT_NODE && !c.textContent?.trim()) c = c.previousSibling;
    last = c;
  }
  if (last instanceof Element) last.remove();
  const signature = block.innerHTML;
  if (!rest) return { body: before.innerHTML, signature };
  doc.body.replaceChildren(rest);
  return { body: before.innerHTML, signature, quote: doc.documentElement.outerHTML };
}

/**
 * A reopened draft's signature, kept to what the signature editor allows, with its
 * cid: images turned back into data: URIs from the draft's inline parts (so the next
 * save inlines them again). Images whose part is missing are dropped.
 */
export function restoreSignature(html: string, images: Pick<InlineImage, "cid" | "mimeType" | "base64">[]): string {
  const byCid = new Map(images.map((i) => [i.cid.replace(/^<|>$/g, "").toLowerCase(), i]));
  const doc = new DOMParser().parseFromString(`<body>${sanitizeSignature(html)}</body>`, "text/html");
  for (const img of doc.body.querySelectorAll("img")) {
    const src = (img.getAttribute("src") ?? "").trim();
    if (/^(data:image\/|https?:)/i.test(src)) continue;
    if (!/^cid:/i.test(src)) {
      img.remove();
      continue;
    }
    let ref = src.slice(4);
    try {
      ref = decodeURIComponent(ref);
    } catch {
      // keep the raw reference
    }
    const part = byCid.get(ref.trim().toLowerCase());
    if (part && /^image\/[\w.+-]+$/i.test(part.mimeType) && /^[A-Za-z0-9+/=\s]+$/.test(part.base64))
      img.setAttribute("src", `data:${part.mimeType};base64,${part.base64.replace(/\s/g, "")}`);
    else img.remove();
  }
  return doc.body.innerHTML.trim();
}

/** For showing signature HTML that came from a server: nothing in it loads from the network. */
export function withoutRemoteLoads(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const el of doc.body.querySelectorAll("*")) {
    for (const name of ["src", "background", "poster", "href", "xlink:href"]) {
      if (name === "href" && el.localName === "a") continue;
      const v = el.getAttribute(name);
      if (v !== null && !/^\s*(data:|#)/i.test(v)) el.removeAttribute(name);
    }
    const style = el.getAttribute("style");
    if (style && /url\s*\(/i.test(style)) el.setAttribute("style", style.replace(/url\s*\([^)]*\)/gi, "none"));
  }
  return doc.body.innerHTML;
}

export interface Size {
  width: number;
  height: number;
}

/** Widest a signature image goes when nothing else says how big it should be. */
const MAX_IMAGE_WIDTH = 200;
const PT_TO_PX = 4 / 3;

/** A CSS length in px: pt is ×4/3, px or unitless as is; anything else (%, em, auto) is unknown. */
export function cssLengthPx(v: string | null | undefined): number | null {
  const m = /^\s*(\d*\.?\d+)\s*(pt|px)?\s*$/i.exec(v ?? "");
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!(n > 0)) return null;
  return m[2]?.toLowerCase() === "pt" ? n * PT_TO_PX : n;
}

/** An SVG's intrinsic size from its root width/height, or its viewBox. */
export function svgIntrinsicSize(svg: string): Size | null {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  if (root?.localName !== "svg") return null;
  const w = cssLengthPx(root.getAttribute("width"));
  const h = cssLengthPx(root.getAttribute("height"));
  if (w && h) return { width: w, height: h };
  const vb = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const [vw, vh] = [vb[2], vb[3]];
  if (!(vb.length === 4 && vw > 0 && vh > 0)) return null;
  if (w) return { width: w, height: (w * vh) / vw };
  if (h) return { width: (h * vw) / vh, height: h };
  return { width: vw, height: vh };
}

/** The markup inside a data:image/svg+xml URI (base64 or URL-encoded). */
function svgFromDataUri(src: string): string | null {
  const m = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/is.exec(src);
  if (!m) return null;
  try {
    if (/;base64/i.test(m[1] ?? "")) return new TextDecoder().decode(Uint8Array.from(atob(m[2].replace(/\s/g, "")), (c) => c.charCodeAt(0)));
    return decodeURIComponent(m[2]);
  } catch {
    return null;
  }
}

/** A table cell's width in px, from its inline style or its width attribute. */
export function tdWidthPx(td: Element): number | null {
  return cssLengthPx((td as HTMLElement).style?.width) ?? cssLengthPx(td.getAttribute("width"));
}

/** A table cell's height in px, from its inline style or its height attribute. */
export function tdHeightPx(td: Element): number | null {
  return cssLengthPx((td as HTMLElement).style?.height) ?? cssLengthPx(td.getAttribute("height"));
}

/** Shrink a size to fit a width (and a height, if given), keeping its aspect ratio; never enlarge. */
export function fitBox(natural: Size, maxWidth: number, maxHeight?: number | null): Size {
  const scale = Math.min(1, maxWidth / natural.width, maxHeight ? maxHeight / natural.height : 1);
  return { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) };
}

/**
 * In the editor: pin every image lacking explicit width and height to the size it
 * renders at, so recipients get what the user saw instead of the intrinsic size.
 * Uses layout size (offsetWidth/Height), which dialog transform animations don't
 * skew. Only the missing attribute is filled in. Skipped: images not laid out yet
 * (still loading, or hidden), and images a narrow editor has shrunk with max-width,
 * whose rendered size isn't a size anyone chose. Returns whether anything changed.
 */
export function freezeImageSizes(root: ParentNode): boolean {
  let changed = false;
  for (const img of root.querySelectorAll("img")) {
    const hasW = img.hasAttribute("width");
    const hasH = img.hasAttribute("height");
    if (hasW && hasH) continue;
    const ow = img.offsetWidth;
    const oh = img.offsetHeight;
    if (!(Math.round(ow) > 0 && Math.round(oh) > 0)) continue;
    if (!hasW && !img.style.width && img.naturalWidth > ow) continue;
    if (hasW) {
      const w = cssLengthPx(img.getAttribute("width"));
      img.setAttribute("height", String(Math.max(1, Math.round(w ? (w * oh) / ow : oh))));
    } else if (hasH) {
      const h = cssLengthPx(img.getAttribute("height"));
      img.setAttribute("width", String(Math.max(1, Math.round(h ? (h * ow) / oh : ow))));
    } else {
      img.setAttribute("width", String(Math.round(ow)));
      img.setAttribute("height", String(Math.round(oh)));
    }
    changed = true;
  }
  return changed;
}

/** The browser work the send step needs, injectable because tests have no layout or canvas. */
export interface ImageTools {
  /** An image's natural size, or null when it can't be loaded. */
  naturalSize(src: string): Promise<Size | null>;
  /** The image drawn at width × height as a PNG data URI, or null on failure. */
  rasterize(src: string, width: number, height: number): Promise<string | null>;
}

function loadImage(src: string, timeoutMs = 5000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => (clearTimeout(timer), resolve(img));
    img.onerror = () => (clearTimeout(timer), resolve(null));
    img.src = src;
  });
}

export const browserImageTools: ImageTools = {
  async naturalSize(src) {
    const img = await loadImage(src);
    return img && img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null;
  },
  async rasterize(src, width, height) {
    try {
      const img = await loadImage(src);
      if (!img) return null;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, width, height);
      const out = canvas.toDataURL("image/png");
      return out.startsWith("data:image/png") ? out : null;
    } catch {
      return null;
    }
  },
};

/** The size a signature image should be sent at, or null when it can't be known. */
async function displaySize(img: HTMLImageElement, src: string, tools: ImageTools): Promise<Size | null> {
  const w = cssLengthPx(img.getAttribute("width")) ?? cssLengthPx(img.style.width);
  const h = cssLengthPx(img.getAttribute("height")) ?? cssLengthPx(img.style.height);
  if (w && h) return { width: Math.round(w), height: Math.round(h) };
  const svg = svgFromDataUri(src);
  const natural = (svg && svgIntrinsicSize(svg)) || (await tools.naturalSize(src).catch(() => null));
  if (!natural || !(natural.width > 0 && natural.height > 0)) return null;
  if (w) return { width: Math.round(w), height: Math.max(1, Math.round((w * natural.height) / natural.width)) };
  if (h) return { width: Math.max(1, Math.round((h * natural.width) / natural.height)), height: Math.round(h) };
  const td = img.closest("td");
  const boxWidth = td && tdWidthPx(td);
  return boxWidth ? fitBox(natural, boxWidth, tdHeightPx(td)) : fitBox(natural, MAX_IMAGE_WIDTH);
}

/**
 * Send-time safety net for signature images: give every one an explicit size (as
 * attributes for Outlook and inline style for everyone else) so none arrives at its
 * intrinsic size, and turn SVGs, which Gmail blocks, into PNGs at 2× for sharpness.
 * Only touches the block composeHtml marked as the signature, and strips the marker.
 */
export async function sizeSignatureImages(html: string, tools: ImageTools = browserImageTools): Promise<string> {
  if (!html.includes(SIGNATURE_MARK)) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const blocks = [...doc.body.querySelectorAll(`[${SIGNATURE_MARK}]`)];
  // Concurrently, so several slow images don't stack their load timeouts before a send.
  const imgs = blocks.flatMap((block) => [...block.querySelectorAll("img")]);
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      const sized = img.hasAttribute("width") && img.hasAttribute("height");
      const size = await displaySize(img, src, tools);
      if (size && !sized) {
        img.setAttribute("width", String(size.width));
        img.setAttribute("height", String(size.height));
        img.style.width = `${size.width}px`;
        img.style.height = `${size.height}px`;
      }
      if (size && /^data:image\/svg\+xml/i.test(src)) {
        const png = await tools.rasterize(src, size.width * 2, size.height * 2).catch(() => null);
        if (png) img.setAttribute("src", png);
      }
    }),
  );
  for (const block of blocks) block.removeAttribute(SIGNATURE_MARK);
  return doc.body.innerHTML;
}

/** Plain-text alternative: body, then the signature after the conventional "-- " line. */
export function composeText(body: string, signatureHtml?: string): string {
  const sig = signatureHtml ? htmlToText(signatureHtml) : "";
  return sig ? `${body.trimEnd()}\n\n-- \n${sig}` : body;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

/** Replace data: images with cid: references and return them as inline parts. */
export function inlineDataImages(html: string, tag = Math.random().toString(36).slice(2, 8)): { html: string; inline: InlineImage[] } {
  const inline: InlineImage[] = [];
  const seen = new Map<string, string>();
  const out = html.replace(MARK_ATTR, "").replace(/(<img\b[^>]*?\bsrc=)(["'])data:(image\/[\w.+-]+);base64,([^"']+)\2/gi, (_m, pre: string, q: string, mime: string, data: string) => {
    const base64 = data.replace(/\s/g, "");
    let cid = seen.get(base64);
    if (!cid) {
      const n = inline.length + 1;
      cid = `image${n}.${tag}@zmail`;
      seen.set(base64, cid);
      inline.push({ cid, filename: `image${n}.${EXT[mime.toLowerCase()] ?? "png"}`, mimeType: mime, base64 });
    }
    return `${pre}${q}cid:${cid}${q}`;
  });
  return { html: out, inline };
}

/** Old plain-text, per-account signatures become named HTML signatures. */
export function migrateTextSignatures(
  old: Record<string, string>,
  nameFor: (accountId: string) => string,
): { list: MailSignature[]; defaults: Record<string, SignatureDefaults> } {
  const list: MailSignature[] = [];
  const defaults: Record<string, SignatureDefaults> = {};
  for (const [accountId, text] of Object.entries(old)) {
    if (!text.trim()) continue;
    const id = `sig-${accountId}`;
    list.push({ id, name: nameFor(accountId), html: textToHtml(text.trim()) });
    defaults[accountId] = { new: id, reply: id };
  }
  return { list, defaults };
}
