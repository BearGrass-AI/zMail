// HTTP transport for model providers. Inside Tauri, requests go through the
// Rust `http_request` command (no CORS; reaches localhost/tailnet hosts). In a
// plain browser (vite preview) we fall back to fetch.

import { invoke, isTauri } from "@tauri-apps/api/core";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    /** Seconds the server asked us to wait (Retry-After), when it said. */
    readonly retryAfter?: number,
  ) {
    super(`${status}: ${body.slice(0, 300) || "no response body"}`);
  }
}

/**
 * A Retry-After header in whole seconds: delta-seconds, or an HTTP date turned into seconds from now.
 * Anything else, and 0 or less, is undefined so callers fall back to their own backoff.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  // Numeric-looking values ("-1", "1.5") are never dates; only whole positive seconds count.
  if (/^[-+]?[\d.]+$/.test(v)) return /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : undefined;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  const secs = Math.ceil((at - now) / 1000);
  return secs > 0 ? secs : undefined;
}

type Sent = { status: number; text: string; retryAfter?: number };

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** noRedirect: a 3xx comes back as the response instead of being followed (for untrusted URLs). */
async function send(method: Method, url: string, headers: Record<string, string>, body?: string, noRedirect = false): Promise<Sent> {
  if (isTauri()) {
    const res = await invoke<{ status: number; body: string; retry_after?: number | null }>("http_request", { method, url, headers, body: body ?? null, ...(noRedirect ? { followRedirects: false } : {}) });
    return { status: res.status, text: res.body, ...(res.retry_after != null ? { retryAfter: res.retry_after } : {}) };
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, ...(noRedirect ? { redirect: "manual" as const } : {}) });
    // A manual redirect is an opaque response with status 0; report it as a redirect.
    if (noRedirect && res.type === "opaqueredirect") return { status: 302, text: "" };
  } catch {
    throw new Error("The browser preview can't reach model providers (CORS). Use the zMail app — it sends requests from Rust.");
  }
  const retryAfter = parseRetryAfter(res.headers?.get("Retry-After"));
  return { status: res.status, text: await res.text(), ...(retryAfter !== undefined ? { retryAfter } : {}) };
}

export async function request<T>(
  method: Method,
  url: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...opts.headers };
  const { status, text, retryAfter } = await send(method, url, headers, opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  if (status < 200 || status >= 300) throw new HttpError(status, text, retryAfter);
  // 204 No Content (DELETE, some PATCH/POST actions).
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
  }
}

/** A raw request (e.g. a multipart batch); returns the body text. noRedirect: a 3xx is not followed, so it throws HttpError. */
export async function requestText(method: Method, url: string, opts: { headers?: Record<string, string>; body?: string; noRedirect?: boolean } = {}): Promise<string> {
  const { status, text, retryAfter } = await send(method, url, opts.headers ?? {}, opts.body, opts.noRedirect);
  if (status < 200 || status >= 300) throw new HttpError(status, text, retryAfter);
  return text;
}

/** Strip trailing slashes and a trailing /v1 so paths can be appended uniformly. */
export function normalizeBase(url: string) {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}
