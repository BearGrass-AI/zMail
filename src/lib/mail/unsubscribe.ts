// src/lib/mail/unsubscribe.ts
// List-Unsubscribe (RFC 2369) and one-click unsubscribe (RFC 8058). Header values
// come from senders and are untrusted: only https URLs with a public-looking host
// are ever fetched or opened, and a mailto is only used for its address and subject.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Email } from "@/lib/types";
import { HttpError, requestText } from "@/lib/transport";

export type Unsubscribe = NonNullable<Email["unsubscribe"]>;
export type UnsubMethod = "one_click" | "email" | "link" | "none";

const MAX_URL = 2048;
const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * The URL, normalized, if it is https with no credentials and a host that isn't
 * local (localhost, *.local, a single label or an IP literal). Otherwise null.
 */
export function safeHttps(url: string): string | null {
  if (url.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  // WHATWG keeps a trailing dot ("localhost."), which still resolves to the same host.
  const h = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!h.includes(".") || h.startsWith("[") || /^[\d.]+$/.test(h)) return null;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return null;
  return u.href;
}

/** The address and subject of a mailto: URL; the body and other fields are ignored. */
export function parseMailto(mailto: string): { to: string; subject: string } | null {
  if (mailto.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(mailto);
  } catch {
    return null;
  }
  if (u.protocol !== "mailto:") return null;
  let to: string;
  try {
    to = decodeURIComponent(u.pathname).trim();
  } catch {
    return null;
  }
  if (!ADDRESS.test(to)) return null;
  // Control characters (CR/LF) never reach an outgoing header.
  const subject = (u.searchParams.get("subject") ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return { to, subject: subject || "unsubscribe" };
}

/** Parse List-Unsubscribe (+ List-Unsubscribe-Post). Undefined when there's no usable https or mailto URL. */
export function parseListUnsubscribe(listUnsubscribe?: string, listUnsubscribePost?: string): Email["unsubscribe"] | undefined {
  if (!listUnsubscribe) return undefined;
  let http: string | undefined;
  let mailto: string | undefined;
  // Each URL is in <…>; commas between them sit outside the brackets. Folding whitespace inside one is ignored.
  for (const m of listUnsubscribe.matchAll(/<([^<>]*)>/g)) {
    const raw = m[1].replace(/\s+/g, "");
    const scheme = raw.slice(0, raw.indexOf(":") + 1).toLowerCase();
    if (scheme === "https:" && !http) http = safeHttps(raw) ?? undefined;
    else if (scheme === "mailto:" && !mailto && parseMailto(raw)) mailto = raw;
  }
  if (!http && !mailto) return undefined;
  const oneClick = !!http && (listUnsubscribePost ?? "").trim().toLowerCase() === "list-unsubscribe=one-click";
  return { ...(http ? { http } : {}), ...(mailto ? { mailto } : {}), oneClick };
}

export function unsubMethod(u?: Email["unsubscribe"]): UnsubMethod {
  if (u?.oneClick && u.http) return "one_click";
  if (u?.mailto) return "email";
  if (u?.http) return "link";
  return "none";
}

export const REDIRECT_ERROR = "The sender redirected the unsubscribe request somewhere else, so zMail stopped. Try the unsubscribe page instead.";

/**
 * RFC 8058 one-click POST. Throws for anything but https, and on a non-2xx answer. Redirects are
 * never followed (they could lead to http: or a local address); a 3xx throws REDIRECT_ERROR.
 * In the app, Rust sends it and also checks that the host resolves only to public addresses.
 */
export async function oneClickUnsubscribe(url: string): Promise<void> {
  const safe = safeHttps(url);
  if (!safe) throw new Error("Only secure (https) unsubscribe links are used.");
  if (isTauri()) {
    const status = await invoke<number>("unsubscribe_post", { url: safe });
    if (status >= 300 && status < 400) throw new Error(REDIRECT_ERROR);
    if (status < 200 || status >= 300) throw new HttpError(status, "");
    return;
  }
  try {
    await requestText("POST", safe, { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", noRedirect: true });
  } catch (err) {
    if (err instanceof HttpError && err.status >= 300 && err.status < 400) throw new Error(REDIRECT_ERROR);
    throw err;
  }
}

/** "news.example.com" from an https URL, for card text. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
