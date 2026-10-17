// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { forwardKeys, frameCsp, frameSrcDoc } from "@/lib/mail/email-frame";
import { prepareHtml } from "@/components/mail/email-body";
import tauriConf from "../../../src-tauri/tauri.conf.json";

describe("frameSrcDoc", () => {
  it("puts the CSP meta first in the head", () => {
    const out = frameSrcDoc("p{}", "<p>x</p>");
    const csp = out.indexOf('http-equiv="Content-Security-Policy"');
    expect(csp).toBeGreaterThan(-1);
    expect(csp).toBeLessThan(out.indexOf("<style>"));
    expect(csp).toBeLessThan(out.indexOf("<body>"));
    expect(out).toContain("<head><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'");
    expect(out).toContain("object-src 'none'");
  });

  it("blocks every remote load by default", () => {
    expect(frameCsp()).toBe(
      "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:",
    );
    expect(frameSrcDoc("p{}", "<p>x</p>")).toContain(`content="${frameCsp(false)}"`);
  });

  it("allows remote images, media, styles and fonts when remote content is allowed", () => {
    expect(frameCsp(true)).toBe(
      "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; default-src 'none'; img-src data: blob: https: http:; media-src data: blob: https:; style-src 'unsafe-inline' https:; font-src data: https:",
    );
    const out = frameSrcDoc("p{}", "<p>x</p>", true);
    expect(out).toContain(`content="${frameCsp(true)}"`);
    expect(out.indexOf("<head><meta http-equiv=\"Content-Security-Policy\"")).toBeGreaterThan(-1);
  });

  it("places html in the body and css in the style", () => {
    const out = frameSrcDoc("p{color:red}", "<p>hello</p>");
    expect(out).toContain("<style>p{color:red}</style>");
    expect(out).toContain("<body><p>hello</p></body>");
  });

  it("sanitized email cannot inject its own meta", () => {
    const out = prepareHtml('<meta http-equiv="Content-Security-Policy" content="script-src *"><p>x</p>', false, "light");
    expect(out.html).not.toContain("<meta");
  });
});

// The srcdoc frame inherits the app's CSP on top of its own meta policy, so the app CSP
// must allow everything the frame allows with remote content on, or remote images break.
describe("app CSP (tauri.conf.json)", () => {
  const security = tauriConf.app.security as { csp: Record<string, string>; devCsp: Record<string, string> };
  const parse = (policy: string) =>
    Object.fromEntries(
      policy.split(";").map((d) => {
        const [name, ...sources] = d.trim().split(/\s+/);
        return [name, sources];
      }),
    );

  it.each(["csp", "devCsp"] as const)("%s keeps scripts to the app and covers the email frame's remote sources", (key) => {
    const app = security[key];
    expect(app["default-src"]).toBe("'self'");
    expect(app["script-src"]).not.toMatch(/https?:|\*|data:|blob:/);
    if (key === "csp") expect(app["script-src"]).toBe("'self'");
    for (const [directive, sources] of Object.entries(parse(frameCsp(true)))) {
      if (!directive.endsWith("-src") || directive === "default-src" || sources.includes("'none'")) continue;
      for (const s of sources) expect(app[directive]?.split(" "), `${key} ${directive} ${s}`).toContain(s);
    }
  });

  it("frame CSP still blocks script in both modes", () => {
    expect(parse(frameCsp(false))["script-src"]).toEqual(["'none'"]);
    expect(parse(frameCsp(true))["script-src"]).toEqual(["'none'"]);
  });
});

describe("forwardKeys", () => {
  let cleanups: (() => void)[] = [];
  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups = [];
    document.body.innerHTML = "";
  });

  function setup(inner = "<p id='p'>hi</p>") {
    const doc = document.implementation.createHTMLDocument("email");
    doc.body.innerHTML = inner;
    const host = document.createElement("iframe");
    document.body.appendChild(host);
    const stop = forwardKeys(doc, host);
    cleanups.push(stop);
    const seen: KeyboardEvent[] = [];
    const listener = (e: Event) => seen.push(e as KeyboardEvent);
    window.addEventListener("keydown", listener);
    cleanups.push(() => window.removeEventListener("keydown", listener));
    const press = (init: KeyboardEventInit, selector = "#p") => {
      const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      doc.querySelector(selector)!.dispatchEvent(ev);
      return ev;
    };
    return { doc, host, seen, press, stop };
  }

  it("forwards a key to the window with the host as target", () => {
    const { host, seen, press } = setup();
    press({ key: "j" });
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe("j");
    expect(seen[0].target).toBe(host);
  });

  it("copies modifiers and code", () => {
    const { seen, press } = setup();
    press({ key: "k", code: "KeyK", metaKey: true });
    expect(seen[0].metaKey).toBe(true);
    expect(seen[0].code).toBe("KeyK");
  });

  it("does not forward mod+A or mod+C", () => {
    const { seen, press } = setup();
    press({ key: "a", metaKey: true });
    press({ key: "c", metaKey: true });
    press({ key: "c", ctrlKey: true });
    expect(seen).toHaveLength(0);
  });

  it("does not forward keys from editable elements", () => {
    const { seen, press } = setup("<div contenteditable='true'><span id='e'>x</span></div>");
    press({ key: "j" }, "#e");
    expect(seen).toHaveLength(0);
  });

  it("propagates preventDefault back to the email event", () => {
    const { press } = setup();
    const handler = (e: Event) => e.preventDefault();
    window.addEventListener("keydown", handler);
    cleanups.push(() => window.removeEventListener("keydown", handler));
    expect(press({ key: "e" }).defaultPrevented).toBe(true);
  });

  it("leaves default alone when the app does not handle it", () => {
    const { press } = setup();
    expect(press({ key: "e" }).defaultPrevented).toBe(false);
  });

  it("stops forwarding after cleanup", () => {
    const { seen, press, stop } = setup();
    stop();
    press({ key: "j" });
    expect(seen).toHaveLength(0);
  });

  it("ignores composing events", () => {
    const { seen, press } = setup();
    press({ key: "j", isComposing: true });
    expect(seen).toHaveLength(0);
  });
});
