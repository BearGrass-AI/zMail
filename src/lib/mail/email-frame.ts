// The email iframe's document: a CSP that blocks script (and remote loads unless
// allowed), and key presses forwarded to the app so shortcuts keep working while
// focus is inside an email.

import { DARK_CARD, DARK_LINK, DARK_TEXT, LIGHT_LINK, LIGHT_TEXT } from "./color";

/**
 * Blocks every script in the email frame. The frame needs allow-scripts so WebKit
 * runs zMail's own listeners on its document; this policy keeps the email itself
 * from running anything. The sanitizer strips <meta>, so an email can't add or
 * override a policy.
 *
 * Unless remote content is allowed it also blocks every network load (images,
 * media, fonts, @import, CSS url()), so trackers can't fire from rules the DOM
 * rewrite misses. Inline cid: images are data: URLs by render time.
 */
export function frameCsp(allowRemote = false) {
  const img = allowRemote ? "img-src data: blob: https: http:" : "img-src data: blob:";
  const media = allowRemote ? "media-src data: blob: https:" : "media-src data: blob:";
  const style = allowRemote ? "style-src 'unsafe-inline' https:" : "style-src 'unsafe-inline'";
  const font = allowRemote ? "font-src data: https:" : "font-src data:";
  return `script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; default-src 'none'; ${img}; ${media}; ${style}; ${font}`;
}

const frameCss = (c: { scheme: string; bg: string; fg: string; imgBg: string; link: string }) => `
  :root { color-scheme: only ${c.scheme} !important; }
  html, body { margin: 0; padding: 0; background: ${c.bg}; color: ${c.fg}; }
  body { font: 14.5px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; padding: 20px 22px; overflow-wrap: break-word; }
  img { max-width: 100%; height: auto; }
  img:not([src]) { display: inline-block; min-height: 12px; background: ${c.imgBg}; }
  table { max-width: 100% !important; }
  a { color: ${c.link}; }
  pre, code { white-space: pre-wrap; }
`;
/** The frame's own styles on the light and dark cards (colors match lib/mail/color.ts). */
export const LIGHT_CSS = frameCss({ scheme: "light", bg: "#fff", fg: LIGHT_TEXT, imgBg: "#f1f1f4", link: LIGHT_LINK });
export const DARK_CSS = frameCss({ scheme: "dark", bg: DARK_CARD, fg: DARK_TEXT, imgBg: "#262a31", link: DARK_LINK });

/** The iframe srcdoc. The CSP meta must come first, before any content. */
export function frameSrcDoc(css: string, html: string, allowRemote = false) {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${frameCsp(allowRemote)}"><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`;
}

const EDITABLE = "input, textarea, select, [contenteditable]";
// Native inside the email: select all text, copy.
const NATIVE_MOD = new Set(["a", "c"]);

/**
 * Re-dispatches key presses from the email document on `host` (the iframe element) so
 * they bubble to the app's window shortcut handler, which expects an Element target.
 * ⌘A/⌘C stay native, keys typed in an editable field are left alone, and if the app
 * handles a key its default is prevented in the email too. Returns a cleanup.
 */
export function forwardKeys(doc: Document, host: HTMLElement): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const t = e.target as Element | null;
    if (t && typeof t.closest === "function" && t.closest(EDITABLE)) return;
    if ((e.metaKey || e.ctrlKey) && NATIVE_MOD.has(e.key.toLowerCase())) return;
    const copy = new KeyboardEvent("keydown", {
      key: e.key,
      code: e.code,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      repeat: e.repeat,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(copy);
    if (copy.defaultPrevented) e.preventDefault();
  };
  doc.addEventListener("keydown", onKey);
  return () => doc.removeEventListener("keydown", onKey);
}
