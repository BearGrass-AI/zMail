import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: { method: string; url: string; opts: { headers?: Record<string, string>; body?: string } }[] = [];
let status = 200;
const tauri = vi.hoisted(() => ({ on: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => tauri.on, invoke: tauri.invoke }));
vi.mock("@/lib/transport", async (orig) => {
  const real = await orig<typeof import("@/lib/transport")>();
  return {
    ...real,
    requestText: async (method: string, url: string, opts: { headers?: Record<string, string>; body?: string; noRedirect?: boolean } = {}) => {
      sent.push({ method, url, opts });
      if (status < 200 || status >= 300) throw new real.HttpError(status, "nope");
      return "";
    },
  };
});

const { REDIRECT_ERROR, oneClickUnsubscribe, parseListUnsubscribe, parseMailto, safeHttps, unsubMethod } = await import("@/lib/mail/unsubscribe");

const POST = "List-Unsubscribe=One-Click";

describe("parseListUnsubscribe", () => {
  it("reads https and mailto, one-click with the Post header", () => {
    expect(parseListUnsubscribe("<https://a.com/u?x=1>, <mailto:u@a.com?subject=stop>", POST)).toEqual({
      http: "https://a.com/u?x=1",
      mailto: "mailto:u@a.com?subject=stop",
      oneClick: true,
    });
  });

  it("ignores plain http", () => {
    expect(parseListUnsubscribe("<http://a.com/u>", POST)).toBeUndefined();
  });

  it("ignores javascript: and other schemes", () => {
    expect(parseListUnsubscribe("<javascript:alert(1)>, <https://a.com/u>")).toEqual({ http: "https://a.com/u", oneClick: false });
    expect(parseListUnsubscribe("<javascript:alert(1)>, <ftp://a.com/u>, <data:text/html,hi>")).toBeUndefined();
  });

  it("handles folded whitespace", () => {
    expect(parseListUnsubscribe("<mailto:u@a.com>,\r\n\t<https://a.com/\r\n u?x=1>", " list-unsubscribe=one-click ")).toEqual({
      http: "https://a.com/u?x=1",
      mailto: "mailto:u@a.com",
      oneClick: true,
    });
  });

  it("is not one-click without https", () => {
    expect(parseListUnsubscribe("<mailto:u@a.com>", POST)).toEqual({ mailto: "mailto:u@a.com", oneClick: false });
  });

  it("is not one-click when the Post header says something else", () => {
    expect(parseListUnsubscribe("<https://a.com/u>", "List-Unsubscribe=Yes")?.oneClick).toBe(false);
    expect(parseListUnsubscribe("<https://a.com/u>")?.oneClick).toBe(false);
  });

  it("takes the first https url and ignores a comma inside one", () => {
    expect(parseListUnsubscribe("<https://a.com/u?a=1,2>, <https://b.com/u>")?.http).toBe("https://a.com/u?a=1,2");
  });

  it("skips urls with credentials or local hosts", () => {
    expect(parseListUnsubscribe("<https://user:pw@a.com/u>")).toBeUndefined();
    for (const h of ["localhost", "127.0.0.1", "[::1]", "router", "printer.local", "10.0.0.5"]) expect(parseListUnsubscribe(`<https://${h}/u>`), h).toBeUndefined();
  });

  it("skips a mailto it couldn't send to", () => {
    expect(parseListUnsubscribe("<mailto:not-an-address>")).toBeUndefined();
    expect(parseListUnsubscribe("<mailto:a@b.com,c@d.com>")).toBeUndefined();
  });

  it("rejects local hosts written with a trailing dot", () => {
    for (const h of ["localhost.", "foo.localhost.", "printer.local.", "router.", "localhost.."]) expect(parseListUnsubscribe(`<https://${h}/u>`), h).toBeUndefined();
  });

  it("rejects IP literals in any spelling", () => {
    for (const h of ["0x7f000001", "2130706433", "0177.0.0.1", "127.1", "[::ffff:127.0.0.1]", "[::1]", "192.168.1.10"]) expect(parseListUnsubscribe(`<https://${h}/u>`), h).toBeUndefined();
  });

  it("accepts an uppercase scheme and ignores an encoded one", () => {
    expect(parseListUnsubscribe("<HTTPS://A.com/u>")).toEqual({ http: "https://a.com/u", oneClick: false });
    expect(parseListUnsubscribe("<%68ttps://a.com/u>")).toBeUndefined();
  });

  it("keeps the first valid mailto", () => {
    expect(parseListUnsubscribe("<mailto:bad>, <mailto:first@a.com>, <mailto:second@a.com>")?.mailto).toBe("mailto:first@a.com");
  });

  it("ignores a url over 2,048 characters", () => {
    const long = `https://a.com/${"x".repeat(2048)}`;
    expect(parseListUnsubscribe(`<${long}>`)).toBeUndefined();
    expect(parseListUnsubscribe(`<${long}>, <https://b.com/u>`)?.http).toBe("https://b.com/u");
    expect(parseMailto(`mailto:a@b.com?subject=${"x".repeat(2048)}`)).toBeNull();
  });

  it("returns undefined for nothing", () => {
    expect(parseListUnsubscribe(undefined)).toBeUndefined();
    expect(parseListUnsubscribe("")).toBeUndefined();
    expect(parseListUnsubscribe("https://a.com/u")).toBeUndefined();
  });
});

describe("unsubMethod", () => {
  it("covers every branch", () => {
    expect(unsubMethod({ http: "https://a.com/u", mailto: "mailto:u@a.com", oneClick: true })).toBe("one_click");
    expect(unsubMethod({ http: "https://a.com/u", mailto: "mailto:u@a.com", oneClick: false })).toBe("email");
    expect(unsubMethod({ mailto: "mailto:u@a.com", oneClick: false })).toBe("email");
    expect(unsubMethod({ http: "https://a.com/u", oneClick: false })).toBe("link");
    expect(unsubMethod({ oneClick: true })).toBe("none");
    expect(unsubMethod(undefined)).toBe("none");
  });
});

describe("parseMailto", () => {
  it("reads the address and subject", () => {
    expect(parseMailto("mailto:u@a.com?subject=Stop%20please")).toEqual({ to: "u@a.com", subject: "Stop please" });
  });
  it("defaults the subject", () => {
    expect(parseMailto("mailto:u@a.com")).toEqual({ to: "u@a.com", subject: "unsubscribe" });
    expect(parseMailto("mailto:u@a.com?subject=%20")).toEqual({ to: "u@a.com", subject: "unsubscribe" });
  });
  it("decodes the address", () => {
    expect(parseMailto("mailto:list%2Bunsub@a.com")).toEqual({ to: "list+unsub@a.com", subject: "unsubscribe" });
  });
  it("rejects a bad address", () => {
    for (const m of ["mailto:nope", "mailto:", "mailto:a@b.com,c@d.com", "mailto:a b@c.com", "mailto:%0d%0aBcc:x@y.com", "https://a.com", "mailto:?to=a@b.com"]) expect(parseMailto(m), m).toBeNull();
  });
  it("ignores the body and other fields", () => {
    expect(parseMailto("mailto:u@a.com?subject=s&body=ignore%20me&cc=x@y.com")).toEqual({ to: "u@a.com", subject: "s" });
  });
  it("strips line breaks from the subject", () => {
    expect(parseMailto("mailto:u@a.com?subject=a%0d%0aBcc:%20x@y.com")?.subject).toBe("a Bcc: x@y.com");
  });
});

describe("safeHttps", () => {
  it("allows only https with a public-looking host", () => {
    expect(safeHttps("https://unsubscribe.example/x")).toBe("https://unsubscribe.example/x");
    expect(safeHttps("http://a.com/")).toBeNull();
    expect(safeHttps("javascript:alert(1)")).toBeNull();
    expect(safeHttps("not a url")).toBeNull();
  });
});

describe("oneClickUnsubscribe", () => {
  beforeEach(() => {
    sent.length = 0;
    status = 200;
  });

  it("rejects non-https without touching the network", async () => {
    await expect(oneClickUnsubscribe("http://a.com/u")).rejects.toThrow();
    await expect(oneClickUnsubscribe("javascript:alert(1)")).rejects.toThrow();
    await expect(oneClickUnsubscribe("https://localhost/u")).rejects.toThrow();
    await expect(oneClickUnsubscribe("https://localhost./u")).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  it("posts the RFC 8058 body", async () => {
    await oneClickUnsubscribe("https://a.com/u?x=1");
    expect(sent).toEqual([
      { method: "POST", url: "https://a.com/u?x=1", opts: { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", noRedirect: true } },
    ]);
  });

  it("treats a redirect as failure", async () => {
    for (const s of [301, 302, 303, 307, 308]) {
      status = s;
      await expect(oneClickUnsubscribe("https://a.com/u")).rejects.toThrow(REDIRECT_ERROR);
    }
    expect(REDIRECT_ERROR).toMatch(/redirect/);
  });

  it("throws on a non-2xx answer", async () => {
    status = 500;
    await expect(oneClickUnsubscribe("https://a.com/u")).rejects.toMatchObject({ status: 500 });
  });
});

describe("oneClickUnsubscribe in the app", () => {
  beforeEach(() => {
    sent.length = 0;
    tauri.on = true;
    tauri.invoke.mockReset();
  });
  afterEach(() => {
    tauri.on = false;
  });

  it("sends through the Rust command, not the general proxy", async () => {
    tauri.invoke.mockResolvedValue(200);
    await oneClickUnsubscribe("https://A.com/u?x=1");
    expect(tauri.invoke).toHaveBeenCalledWith("unsubscribe_post", { url: "https://a.com/u?x=1" });
    expect(sent).toEqual([]);
  });

  it("treats any 2xx as success", async () => {
    for (const s of [200, 202, 204]) {
      tauri.invoke.mockResolvedValue(s);
      await expect(oneClickUnsubscribe("https://a.com/u")).resolves.toBeUndefined();
    }
  });

  it("treats a redirect or an error status as failure", async () => {
    tauri.invoke.mockResolvedValue(302);
    await expect(oneClickUnsubscribe("https://a.com/u")).rejects.toThrow(REDIRECT_ERROR);
    tauri.invoke.mockResolvedValue(404);
    await expect(oneClickUnsubscribe("https://a.com/u")).rejects.toMatchObject({ status: 404 });
  });

  it("passes on Rust's refusal and checks the URL first", async () => {
    tauri.invoke.mockRejectedValue("That unsubscribe link doesn't point to a public address, so zMail won't use it.");
    await expect(oneClickUnsubscribe("https://a.com/u")).rejects.toMatch(/public address/);
    tauri.invoke.mockReset();
    await expect(oneClickUnsubscribe("http://a.com/u")).rejects.toThrow();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
