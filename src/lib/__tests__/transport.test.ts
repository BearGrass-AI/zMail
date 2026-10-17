import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ on: false, calls: [] as Record<string, unknown>[], status: 200, retryAfter: null as number | null }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => tauri.on,
  invoke: async (_cmd: string, args: Record<string, unknown>) => {
    tauri.calls.push(args);
    return { status: tauri.status, body: "", retry_after: tauri.retryAfter };
  },
}));

const { request, requestText, HttpError, parseRetryAfter } = await import("@/lib/transport");

beforeEach(() => {
  tauri.on = false;
  tauri.calls.length = 0;
  tauri.status = 200;
  tauri.retryAfter = null;
  vi.unstubAllGlobals();
});

describe("requestText noRedirect", () => {
  it("asks Rust not to follow redirects, and a 3xx throws", async () => {
    tauri.on = true;
    tauri.status = 302;
    await expect(requestText("POST", "https://a.com/u", { body: "x", noRedirect: true })).rejects.toBeInstanceOf(HttpError);
    expect(tauri.calls[0]).toMatchObject({ method: "POST", url: "https://a.com/u", followRedirects: false });
  });

  it("leaves other requests following redirects as before", async () => {
    tauri.on = true;
    await requestText("GET", "https://a.com/");
    expect(tauri.calls[0]).not.toHaveProperty("followRedirects");
  });

  it("uses redirect: manual in the browser and treats an opaque redirect as a 3xx", async () => {
    const fetch = vi.fn(async () => ({ type: "opaqueredirect", status: 0, text: async () => "" }));
    vi.stubGlobal("fetch", fetch);
    await expect(requestText("POST", "https://a.com/u", { noRedirect: true })).rejects.toMatchObject({ status: 302 });
    expect(fetch).toHaveBeenCalledWith("https://a.com/u", expect.objectContaining({ redirect: "manual" }));
  });
});

describe("Retry-After", () => {
  it("puts Rust's retry_after on HttpError from request() and requestText()", async () => {
    tauri.on = true;
    tauri.status = 429;
    tauri.retryAfter = 2;
    await expect(request("GET", "https://graph.microsoft.com/v1.0/me")).rejects.toMatchObject({ status: 429, retryAfter: 2 });
    await expect(requestText("GET", "https://graph.microsoft.com/v1.0/me")).rejects.toMatchObject({ status: 429, retryAfter: 2 });
  });

  it("leaves retryAfter unset when the response has none", async () => {
    tauri.on = true;
    tauri.status = 503;
    const err = await request<never>("GET", "https://a.com/").catch((e: InstanceType<typeof HttpError>) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.retryAfter).toBeUndefined();
  });

  it("reads the Retry-After header in the browser, in seconds or as an HTTP date", async () => {
    const respond = (v: string) => ({ type: "basic", status: 429, headers: new Headers({ "Retry-After": v }), text: async () => "" });
    vi.stubGlobal("fetch", vi.fn(async () => respond("7")));
    await expect(request("GET", "https://a.com/")).rejects.toMatchObject({ retryAfter: 7 });
    vi.stubGlobal("fetch", vi.fn(async () => respond(new Date(Date.now() + 10_000).toUTCString())));
    const err = await request<never>("GET", "https://a.com/").catch((e: InstanceType<typeof HttpError>) => e);
    expect(err.retryAfter).toBeGreaterThanOrEqual(8);
    expect(err.retryAfter).toBeLessThanOrEqual(10);
  });

  it("ignores numeric-looking values that aren't whole positive seconds, and past dates", () => {
    const now = Date.parse("2026-10-11T12:00:00Z");
    expect(parseRetryAfter("3", now)).toBe(3);
    for (const v of ["-1", "1.5", "0", "+2", "", "soon"]) expect(parseRetryAfter(v, now)).toBeUndefined();
    expect(parseRetryAfter("Sun, 11 Oct 2026 12:00:10 GMT", now)).toBe(10);
    expect(parseRetryAfter("Sun, 11 Oct 2026 11:00:00 GMT", now)).toBeUndefined();
  });

  it("keeps the two-argument HttpError constructor", () => {
    const e = new HttpError(400, "bad");
    expect(e.status).toBe(400);
    expect(e.retryAfter).toBeUndefined();
  });
});
