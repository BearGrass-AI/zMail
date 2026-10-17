// The composer's body is HTML. These helpers turn the assistant's Markdown and
// plain text into it, keep pasted or stored HTML to a small safe set of tags,
// and build the outgoing HTML and plain-text parts.

import { marked } from "marked";
import DOMPurify from "dompurify";
import { BODY_STYLE, composeText, htmlToText, textToHtml, withSignature } from "@/lib/signature";

/** Tags a draft body may contain; everything else is removed (content kept). */
export const BODY_TAGS = ["p", "div", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li", "a", "blockquote"];

// An isolated instance so these hooks don't touch the shared default.
const purify = DOMPurify(window);

purify.addHook("afterSanitizeAttributes", (node) => {
  if (node.hasAttribute("href") && !/^(https?:|mailto:)/i.test((node.getAttribute("href") ?? "").trim())) node.removeAttribute("href");
});

/** Clean any HTML for the editor: allowlisted tags only, only href on links (http/https/mailto), no styles or classes. */
export function cleanBodyHtml(html: string): string {
  return purify.sanitize(html, { ALLOWED_TAGS: BODY_TAGS, ALLOWED_ATTR: ["href"] });
}

/** The assistant's Markdown (or plain text) as body HTML: GFM, single newlines kept as <br>. */
export function markdownToBodyHtml(md: string): string {
  return cleanBodyHtml(marked.parse(md, { gfm: true, breaks: true, async: false }));
}

/** Plain text (forward quotes, Drive link blocks) as body HTML. */
export function textToBodyHtml(text: string): string {
  return cleanBodyHtml(textToHtml(text));
}

/** True when the body has no visible text. */
export function bodyIsEmpty(html: string): boolean {
  return !new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body.textContent?.trim();
}

/** The outgoing HTML for a rich body plus optional signature (same structure as composeHtml). */
export function composeRichHtml(bodyHtml: string, signatureHtml?: string): string {
  const doc = new DOMParser().parseFromString(`<body>${cleanBodyHtml(bodyHtml)}</body>`, "text/html");
  // Outlook collapses paragraphs without explicit margins.
  for (const p of doc.body.querySelectorAll("p")) p.setAttribute("style", "margin:0 0 1em");
  return withSignature(`<div style="${BODY_STYLE}">${doc.body.innerHTML.trim()}</div>`, signatureHtml);
}

/** The outgoing plain-text alternative. */
export function composeRichText(bodyHtml: string, signatureHtml?: string): string {
  return composeText(htmlToText(bodyHtml), signatureHtml);
}
