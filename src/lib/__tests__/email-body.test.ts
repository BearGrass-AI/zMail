// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import DOMPurify from "dompurify";
import { prepareHtml } from "@/components/mail/email-body";
import { canRenderDark, emailSupportsDark, isSimpleHtml } from "@/lib/mail/dark-mode";

describe("prepareHtml", () => {
  const cidHtml = `<img src="cid:logo@x"><img src="cid:image001.png@01DC">`;
  const map = new Map([["logo@x", "data:image/png;base64,AAAA"], ["image001.png@zzz", "data:image/png;base64,BBBB"]]);

  it("shows a fetched cid: image and does not count it as blocked", () => {
    const out = prepareHtml(cidHtml, false, "light", map);
    expect(out.html).toContain('src="data:image/png;base64,AAAA"');
    expect(out.blocked).toBe(0);
  });

  it("leaves a cid: image without a source as a placeholder", () => {
    const out = prepareHtml(cidHtml, false, "light");
    expect(out.html).not.toContain("src=");
    expect(out.blocked).toBe(0);
  });

  it("matches a cid: by the part before the @", () => {
    expect(prepareHtml(cidHtml, false, "light", map).html).toContain('src="data:image/png;base64,BBBB"');
  });

  const html = `<p onclick="x()">Hi</p><script>alert(1)</script><img src="https://t.example.com/p.gif"><img src="data:image/png;base64,AAAA"><a href="https://x.com">x</a><div style="background:url(https://t.example.com/bg.png)">bg</div>`;

  it("strips scripts and event handlers", () => {
    const { html: out } = prepareHtml(html, false, "light");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).toContain('href="https://x.com"');
  });

  it("blocks remote images and background images unless allowed", () => {
    const blocked = prepareHtml(html, false, "light");
    expect(blocked.blocked).toBe(2);
    expect(blocked.html).toContain('data-zmail-src="https://t.example.com/p.gif"');
    expect(blocked.html).not.toMatch(/\ssrc="https:\/\/t\.example\.com\/p\.gif"/);
    expect(blocked.html).toContain("data:image/png;base64,AAAA");

    const allowed = prepareHtml(html, true, "light");
    expect(allowed.blocked).toBe(0);
    expect(allowed.html).toMatch(/\ssrc="https:\/\/t\.example\.com\/p\.gif"/);
  });

  it("counts an uppercase URL( background as blocked", () => {
    const out = prepareHtml(`<div style="background:URL(https://t.example.com/up.png)">x</div>`, false, "light");
    expect(out.blocked).toBe(1);
    expect(prepareHtml(`<div style="background:URL(https://t.example.com/up.png)">x</div>`, true, "light").blocked).toBe(0);
  });

  it("blocks a remote background attribute unless allowed", () => {
    const h = `<table background="https://t.example.com/bg.gif"><tr><td>x</td></tr></table>`;
    const out = prepareHtml(h, false, "light");
    expect(out.blocked).toBe(1);
    expect(out.html).not.toMatch(/\sbackground="https:/);
    expect(out.html).toContain('data-zmail-background="https://t.example.com/bg.gif"');
    const allowed = prepareHtml(h, true, "light");
    expect(allowed.blocked).toBe(0);
    expect(allowed.html).toMatch(/\sbackground="https:\/\/t\.example\.com\/bg\.gif"/);
  });

  it("blocks a remote video poster unless allowed", () => {
    const h = `<video poster="https://t.example.com/poster.jpg"></video>`;
    const out = prepareHtml(h, false, "light");
    expect(out.blocked).toBe(1);
    expect(out.html).not.toMatch(/\sposter="https:/);
    expect(prepareHtml(h, true, "light").blocked).toBe(0);
  });

  it("counts a remote url() in a style block as blocked", () => {
    const h = `<div class="pre"></div><style>.hero { background: url("https://t.example.com/hero.png") }</style><div class="hero">x</div>`;
    expect(prepareHtml(h, false, "light").blocked).toBeGreaterThan(0);
    expect(prepareHtml(h, true, "light").blocked).toBe(0);
  });

  it("counts a remote @import in a style block as blocked", () => {
    const h = `<div class="pre"></div><style>@import 'https://fonts.example.com/css?family=X'; p { font-family: X }</style><p>x</p>`;
    expect(prepareHtml(h, false, "light").blocked).toBeGreaterThan(0);
    expect(prepareHtml(h, true, "light").blocked).toBe(0);
  });

  it("keeps the email in its light design even when the Mac is in dark mode", () => {
    // Coinbase-style email: its dark-mode rules turn text white for a dark card,
    // but zMail always shows email on white, so they must never apply.
    const styled = `<div class="preheader"></div><style>
      @media (prefers-color-scheme: light) { .border { border-color: #d9dbde !important; } }
      @media screen and (prefers-color-scheme:dark) { p.foreground { color: #ffffff !important; } }
    </style><p class="foreground" style="color:#0a0b0d">We've verified your ID</p>`;
    const { html: out } = prepareHtml(styled, false, "light");
    expect(out).toContain("We've verified your ID");
    expect(out).not.toMatch(/prefers-color-scheme\s*:\s*dark/);
    expect(out).toContain("@media screen and (max-width: 0px)");
    expect(out).toContain("@media (min-width: 0px)");
  });
});

const COINBASE = `<div class="pre"></div><style>
  @media (prefers-color-scheme: light) { .border { border-color: #d9dbde !important; } }
  @media screen and (prefers-color-scheme:dark) { p.foreground { color: #ffffff !important; } }
</style><p class="foreground" style="color:#0a0b0d">Verified</p>`;
const DESIGNED = `<style>.x{color:#333}</style><table bgcolor="#f4f4f4"><tr><td class="x">Sale</td></tr></table>`;

describe("emailSupportsDark", () => {
  it("detects prefers-color-scheme dark and color-scheme metas", () => {
    expect(emailSupportsDark(COINBASE)).toBe(true);
  });
  it("does not trust a bare color-scheme meta or declaration", () => {
    expect(emailSupportsDark(`<meta name="supported-color-schemes" content="light dark"><p>x</p>`)).toBe(false);
    expect(emailSupportsDark(`<style>:root{color-scheme: light dark}</style><p>x</p>`)).toBe(false);
  });
  it("is false for designed light-only mail", () => {
    expect(emailSupportsDark(DESIGNED)).toBe(false);
    expect(emailSupportsDark(`<meta name="color-scheme" content="light"><p>x</p>`)).toBe(false);
  });
});

describe("isSimpleHtml", () => {
  it("accepts plain markup", () => expect(isSimpleHtml("<p>Hi <b>Alex</b> <a style=\"color:#00f\" href=\"https://x.com\">l</a></p>")).toBe(true));
  it("rejects own colors", () => {
    expect(isSimpleHtml('<table bgcolor="#fff"><tr><td>x</td></tr></table>')).toBe(false);
    expect(isSimpleHtml('<p style="color:#333">x</p>')).toBe(false);
    expect(isSimpleHtml('<div style="background-color:red">x</div>')).toBe(false);
    expect(isSimpleHtml('<font color="red">x</font>')).toBe(false);
    expect(isSimpleHtml("<style>p{color:#333}</style><p>x</p>")).toBe(false);
  });
});

describe("prepareHtml modes", () => {
  it("renders a dark-capable email with its own dark rules in dark mode", () => {
    const r = prepareHtml(COINBASE, false, "dark");
    expect(r.dark).toBe(true);
    expect(r.html).toContain("screen and (min-width: 0px)");
    expect(r.html).toContain("(max-width: 0px)");
    expect(r.html).not.toMatch(/prefers-color-scheme/);
  });
  it("renders simple html dark", () => {
    expect(prepareHtml("<p>Hi</p>", false, "dark").dark).toBe(true);
  });
  it("adapts designed light-only mail for the dark card", () => {
    const r = prepareHtml(DESIGNED, false, "dark");
    expect(r.dark).toBe(true);
    expect(r.html).not.toContain('bgcolor="#f4f4f4"');
    expect(r.html).not.toContain("color:#333");
    expect(DESIGNED).toContain('bgcolor="#f4f4f4"');
  });
  it("designed email with dark rules neutralized when forced light", () => {
    const r = prepareHtml(COINBASE, false, "light");
    expect(r.dark).toBe(false);
    expect(r.html).toContain("screen and (max-width: 0px)");
  });
  it("adapts, rather than trusting, dark rules in a head style that sanitizing strips", () => {
    const h = `<head><style>@media (prefers-color-scheme: dark){p{color:#fff}}</style></head><body><p style="color:#333">x</p></body>`;
    const r = prepareHtml(h, false, "dark");
    expect(r.dark).toBe(true);
    expect(r.html).not.toContain("color:#333");
  });
  it("a color-scheme meta alone doesn't count as a dark design: colored mail is adapted", () => {
    const r = prepareHtml(`<meta name="color-scheme" content="light dark"><p style="color:#333">x</p>`, false, "dark");
    expect(r.dark).toBe(true);
    expect(r.html).not.toContain("color:#333");
  });
  it("a color-scheme meta with plain markup renders dark", () => {
    expect(prepareHtml(`<meta name="color-scheme" content="light dark"><p>Hi</p>`, false, "dark").dark).toBe(true);
  });
  it("light mode never renders dark", () => expect(prepareHtml("<p>Hi</p>", false, "light").dark).toBe(false));
});

describe("sanitize cache", () => {
  const page = (n: number | string) => `<p style="color:#123">cache test ${n}</p><script>alert(${n})</script>`;
  const flood = () => {
    for (let i = 0; i < 31; i++) prepareHtml(page(`flood-${i}-${Math.random()}`), false, "light");
  };

  it("returns the same output cached as uncached", () => {
    const x = page("same") + "<style>@media (prefers-color-scheme: dark){p{color:#fff}}</style>";
    const first = prepareHtml(x, false, "dark");
    const cached = prepareHtml(x, false, "dark");
    flood(); // evict x
    const fresh = prepareHtml(x, false, "dark");
    expect(cached).toEqual(first);
    expect(fresh).toEqual(first);
  });

  it("sanitizes once across canRenderDark, prepareHtml and emailSupportsDark", () => {
    const spy = vi.spyOn(DOMPurify, "sanitize");
    try {
      const x = page("once-" + Math.random());
      canRenderDark(x);
      canRenderDark(x);
      prepareHtml(x, false, "dark");
      emailSupportsDark(x);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("evicts the oldest entry after 30", () => {
    const x = page("evict-" + Math.random());
    prepareHtml(x, false, "light");
    const spy = vi.spyOn(DOMPurify, "sanitize");
    try {
      prepareHtml(x, false, "light");
      expect(spy).toHaveBeenCalledTimes(0);
      flood();
      spy.mockClear();
      prepareHtml(x, false, "light");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not mix up empty and different inputs", () => {
    expect(prepareHtml("", false, "light").html).toBe("");
    expect(prepareHtml("<b>a</b>", false, "light").html).toBe("<b>a</b>");
    expect(prepareHtml("", false, "light").html).toBe("");
  });

  it("still strips script tags, cached or not", () => {
    const x = page("sec");
    for (let i = 0; i < 2; i++) {
      const { html } = prepareHtml(x, false, "light");
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain("cache test sec");
    }
  });
});
