// @vitest-environment jsdom
// A draft saved with a rich image signature comes back with that signature when reopened (Gmail and Outlook),
// and saving it again sends the image as an inline part. Drafts without zMail's signature marker open as before.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Email, Folder } from "@/lib/types";
import type { EmbeddedImage, MailProvider, SendRequest } from "@/lib/mail/provider";
import { buildMime, inlineParts, messageToEmail as gmailToEmail, type GMessage, type GPart } from "@/lib/google/gmail-map";
import { messageToEmail as graphToEmail, toGraphMessage, type GAttachment, type GFileAttachment } from "@/lib/microsoft/graph-map";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
document.queryCommandState = () => false;

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [],
  saveRegistry: async () => {},
  calendarProviderFor: () => undefined,
  mailProviderFor: () => undefined,
}));
vi.mock("@/lib/db", () => ({
  kvGet: async () => null,
  kvSet: async () => {},
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
  cachePutFolders: async () => {},
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {}, accessToken: async () => "tok" }));
/** Graph calls from a real GraphProvider go to the test's `graphServer`. */
let graphServer: (method: string, url: string, body: unknown) => unknown = () => undefined;
vi.mock("@/lib/transport", async (orig) => ({
  ...(await orig<typeof import("@/lib/transport")>()),
  request: async (method: string, url: string, opts: { body?: unknown } = {}) => graphServer(method, url, opts.body),
}));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => {} }));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("sonner", () => {
  const t = () => 1;
  t.error = t;
  t.success = t;
  return { toast: t };
});

const { useMail } = await import("@/lib/store");
const { providers } = await import("@/lib/store/providers");
const { Composer } = await import("@/components/mail/composer");
const { GraphProvider } = await import("@/lib/microsoft/graph");
const { HttpError } = await import("@/lib/transport");
const { browserImageTools, sanitizeSignature, withoutRemoteLoads } = await import("@/lib/signature");

const LOGO = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SIGNATURE = {
  id: "s1",
  name: "Work",
  html: `<table><tbody><tr><td><img src="data:image/png;base64,${LOGO}" width="40" height="20" alt="Logo"></td><td style="color: rgb(192, 0, 0);"><b>Alex Rivera</b><br>Chief Information Officer</td></tr></tbody></table>`,
};

// ---- provider stand-ins: the real request → provider shape → Email mapping, with storage in memory ----

/** A tiny parser for buildMime's output, giving the payload Gmail's API returns for it. */
function parsePart(raw: string): GPart {
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, split);
  const body = raw.slice(split + 4);
  const headers = head.split("\r\n").map((l) => ({ name: l.slice(0, l.indexOf(":")), value: l.slice(l.indexOf(":") + 1).trim() }));
  const type = headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "text/plain";
  const mimeType = type.split(";")[0].trim();
  const boundary = /boundary="([^"]+)"/.exec(type)?.[1];
  if (boundary) {
    const chunks = body.split(`--${boundary}`).slice(1, -1);
    return { mimeType, headers, parts: chunks.map((c) => parsePart(c.replace(/^\r\n/, "").replace(/\r\n$/, ""))) };
  }
  const base64 = /base64/i.test(headers.find((h) => h.name.toLowerCase() === "content-transfer-encoding")?.value ?? "")
    ? body.replace(/\s/g, "")
    : btoa(String.fromCharCode(...new TextEncoder().encode(body)));
  return { mimeType, headers, body: { size: base64.length, data: base64.replace(/\+/g, "-").replace(/\//g, "_") } };
}

/** Only what opening and saving a draft use. */
const fakeProvider = (p: Partial<MailProvider> & Pick<MailProvider, "account">): MailProvider =>
  ({ batchSize: 50, listFolders: async () => [], listMessages: async () => [], ...p }) as MailProvider;

function gmailFake(account: Account) {
  const store = new Map<string, GMessage>();
  const saved: SendRequest[] = [];
  let n = 0;
  const p = fakeProvider({
    account,
    getMessage: async (id) => gmailToEmail(account.id, store.get(id)!, () => undefined),
    saveDraft: async (msg, draftId) => {
      saved.push(msg);
      // Gmail gives each save a new message id.
      const id = `gm${++n}`;
      store.set(id, { id, threadId: id, labelIds: ["DRAFT"], internalDate: "1760000000000", payload: parsePart(buildMime({ ...msg, from: account.address })) });
      return { draftId: draftId ?? "gd1", messageId: id };
    },
    draftIdFor: async () => "gd1",
    inlineImages: async (id): Promise<EmbeddedImage[]> =>
      inlineParts(store.get(id)!.payload).map((i) => ({ cid: i.cid, mimeType: i.mimeType, base64: i.data!.replace(/-/g, "+").replace(/_/g, "/") })),
  });
  return { p, saved, messageId: () => `gm${n}` };
}

function graphFake(account: Account) {
  const saved: SendRequest[] = [];
  let html = "";
  let atts: (GAttachment & { contentId?: string })[] = [];
  const p = fakeProvider({
    account,
    getMessage: async (id) =>
      graphToEmail(account.id, { id, subject: "Budget", receivedDateTime: "2026-10-14T10:00:00Z", parentFolderId: "DRAFTS", toRecipients: [{ emailAddress: { name: "", address: "ann@example.com" } }], body: { contentType: "html", content: html } }, atts),
    saveDraft: async (msg, draftId) => {
      saved.push(msg);
      const m = toGraphMessage(msg);
      // Exchange stores the body in its own document (and doesn't promise to keep custom data- attributes).
      html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><style type="text/css" style="display:none">P {margin-top:0;margin-bottom:0;}</style></head><body dir="ltr">${m.body.content.replace(/\sdata-[\w-]+(="[^"]*")?/g, "")}</body></html>`;
      atts = m.attachments.map((a, i) => ({ id: `att${i}`, name: a.name, contentType: a.contentType, size: a.contentBytes.length, isInline: a.isInline, contentId: a.contentId, contentBytes: a.contentBytes }));
      return { draftId: draftId ?? "od1", messageId: draftId ?? "od1" };
    },
    draftIdFor: async (id) => id,
    forgetDraftQuote: () => {},
    inlineImages: async () => atts.filter((a) => a.isInline).map((a) => ({ cid: a.contentId!, mimeType: a.contentType!, base64: a.contentBytes! })),
  });
  return { p, saved, messageId: () => "od1" };
}

const gmail: Account = { id: "g", kind: "gmail", name: "Gmail", address: "z@gmail.com" };
const outlook: Account = { id: "o", kind: "m365", name: "Outlook", address: "z@example.org" };
const folders: Folder[] = [
  { id: "g:DRAFT", accountId: "g", name: "Drafts", system: "drafts" },
  { id: "o:DRAFTS", accountId: "o", name: "Drafts", system: "drafts" },
];

let root: Root | null = null;
async function mount() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(createElement(Composer)));
}
const saveButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Save draft"))!;
const preview = () => document.querySelector<HTMLElement>("[class*='max-h-[220px]']");
const count = (s: string, sub: string) => s.split(sub).length - 1;

beforeEach(() => {
  providers.clear();
  useMail.setState({
    accounts: [gmail, outlook],
    folders,
    emails: [],
    scheduled: [],
    compose: null,
    composeDirty: false,
    composeEdit: null,
    composeView: null,
    signatures: [SIGNATURE],
    signatureDefaults: { g: { new: "s1", reply: "s1" }, o: { new: "s1", reply: "s1" } },
  });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe.each([
  ["Gmail", gmail, gmailFake],
  ["Outlook", outlook, graphFake],
] as const)("reopening a %s draft saved with an image signature", (_name, account, fake) => {
  it("restores the rich signature with its image, and the next save sends the image inline", async () => {
    const f = fake(account);
    providers.set(account.id, f.p);
    useMail.getState().openCompose({ mode: "blank", fromAccountId: account.id, prefill: { to: "ann@example.com", subject: "Budget", body: "Numbers attached." } });
    await mount();
    await act(async () => saveButton().click());
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0].inline).toHaveLength(1);

    // Reopen it from Drafts, as the user would after closing it.
    await act(async () => useMail.getState().openCompose(null));
    const email: Email = await f.p.getMessage(f.messageId());
    useMail.setState({ emails: [email] });
    await act(async () => void (await useMail.getState().openDraft(email.id)));

    const c = useMail.getState().compose!;
    expect(c.draft).toBeTruthy();
    expect(c.prefill!.body).toContain("Numbers attached.");
    expect(c.prefill!.body).not.toContain("Alex Rivera");
    expect(c.signatureHtml).toContain("<table");
    expect(c.signatureHtml).toContain(`src="data:image/png;base64,${LOGO}"`);
    // The composer shows the draft's own signature, image and all.
    const img = preview()?.querySelector("img");
    expect(img?.getAttribute("src")).toBe(`data:image/png;base64,${LOGO}`);
    expect(preview()?.textContent).toContain("Chief Information Officer");

    await act(async () => saveButton().click());
    expect(f.saved).toHaveLength(2);
    const again = f.saved[1];
    expect(again.inline).toHaveLength(1);
    expect(again.inline![0].base64).toBe(LOGO);
    expect(again.html).toContain(`src="cid:${again.inline![0].cid}"`);
    expect(again.html).toContain("<table");
    expect(count(again.html!, "Alex Rivera")).toBe(1);
    expect(count(again.html!, "Numbers attached.")).toBe(1);
  });
});

/** Open a draft whose stored HTML is `html`, with a provider that has no inline parts. */
async function openStored(account: Account, html: string, extra: Partial<MailProvider> = {}) {
  const p = fakeProvider({ account, draftIdFor: async (id) => id, forgetDraftQuote: () => {}, inlineImages: vi.fn(async () => []), ...extra });
  providers.set(account.id, p);
  const email: Email = { id: "m1", accountId: account.id, threadId: "m1", folderId: folders.find((f) => f.accountId === account.id)!.id, from: { name: "", address: "" }, to: [], subject: "Hi", snippet: "", text: "", html, date: "2026-10-14T10:00:00Z", unread: false, starred: false, labels: [] };
  useMail.setState({ emails: [email] });
  await act(async () => void (await useMail.getState().openDraft("m1")));
  await mount();
  return { p, c: useMail.getState().compose! };
}

describe("drafts without zMail's signature marker", () => {
  it("open as before: the whole body in the editor, no signature added", async () => {
    const { p, c } = await openStored(gmail, `<div>Hello<br><br>--<br><table><tr><td><img src="cid:logo@x"></td><td>Someone Else</td></tr></table></div>`);
    expect(c.prefill!.body).toBe("<div>Hello<br><br>--<br>Someone Else</div>");
    expect(c.signatureHtml).toBeUndefined();
    expect(preview()).toBeNull();
    expect(p.inlineImages).not.toHaveBeenCalled();
  });
});

describe("a marked signature block from the server", () => {
  it("is sanitized: no script or handlers, and its remote images aren't loaded in the composer", async () => {
    const { c } = await openStored(
      gmail,
      `<div>Body text</div><br><div class="zmail-signature"><script>alert(1)</script>` +
        `<img src="x" onerror="alert(2)"><img src="https://tracker.example/p.png" width="1" height="1">` +
        `<div style="background-image: url(https://tracker.example/bg.png)">Alex</div><a href="javascript:alert(3)">link</a></div>`,
    );
    expect(c.prefill!.body).toBe("<div>Body text</div>");
    expect(c.signatureHtml).toContain("Alex");
    expect(c.signatureHtml).not.toMatch(/<script|onerror|javascript:|src="x"/i);
    // Kept for sending (it's the user's draft), but never fetched while composing.
    expect(c.signatureHtml).toContain("https://tracker.example/p.png");
    const shown = preview()!;
    expect(shown.innerHTML).not.toMatch(/https:\/\/tracker|<script|onerror/i);
    expect(shown.textContent).toContain("Alex");
  });

  it("loads none of its remote images when the draft is saved again", async () => {
    const saved: SendRequest[] = [];
    const measure = vi.spyOn(browserImageTools, "naturalSize").mockResolvedValue(null);
    try {
      await openStored(gmail, `<div>Body text</div><br><div class="zmail-signature"><img src="https://tracker.example/p.png"><b>Alex</b></div>`, {
        saveDraft: async (msg) => (saved.push(msg), { draftId: "d1", messageId: "m1" }),
      });
      await act(async () => saveButton().click());
      expect(saved).toHaveLength(1);
      expect(measure).not.toHaveBeenCalled();
    } finally {
      measure.mockRestore();
    }
  });

  it("opens its links in the browser, never in the app window", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      await openStored(gmail, `<div>Body text</div><br><div class="zmail-signature"><a href="https://phish.example/login"><b>Sign in</b></a></div>`);
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      await act(async () => void preview()!.querySelector("b")!.dispatchEvent(ev));
      expect(ev.defaultPrevented).toBe(true);
      expect(open).toHaveBeenCalledWith("https://phish.example/login", "_blank", "noopener");
    } finally {
      open.mockRestore();
    }
  });

  it("is not taken from the quoted original of a reply started in Outlook", async () => {
    const { c } = await openStored(
      outlook,
      `<html><body dir="ltr"><div>Sounds good.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg"><b>From:</b> Ann</div>` +
        `<div><div class="zmail-signature"><img src="https://tracker.example/p.png"><a href="https://phish.example/login">Ann</a></div>Earlier message</div></body></html>`,
      // Like Graph, which can keep a reply's quote under our text.
      { keepDraftQuote: () => {} },
    );
    expect(c.signatureHtml).toBeUndefined();
    expect(preview()).toBeNull();
    expect(c.prefill!.body).toContain("Sounds good.");
  });

  it("is left in the body when the draft goes on after it and the provider can't keep a reply's quote", async () => {
    const { c } = await openStored(gmail, `<div>Mine</div><br><div class="zmail-signature"><b>Alex</b></div><hr><div id="divRplyFwdMsg">From: Ann</div><div>Earlier message</div>`);
    expect(c.signatureHtml).toBeUndefined();
    expect(c.prefill!.body).toContain("Alex");
    expect(c.prefill!.body).toContain("Earlier message");
  });
});

// The browser decodes CSS escapes before it decides a function is url(), and image-set() loads
// without url(), so the preview filter must not rely on spotting the literal text "url(".
describe("CSS in a server signature that would load something remote", () => {
  const BEACONS = [
    "background:\\75rl(https://x.example/p.png)",
    "background-image:u\\72l(https://x.example/p.png)",
    "background-image: \\55 \\52 \\4c(https://x.example/p.png)",
    'background-image:image-set("https://x.example/p.png" 1x)',
    'BACKGROUND-IMAGE: -WEBKIT-IMAGE-SET( "https://x.example/p.png" 1X )',
    "background-image: URL (https://x.example/p.png)",
    "list-style: URL(  'https://x.example/p.png'  )",
    'background-image: image("https://x.example/p.png")',
    'background-image: src("https://x.example/p.png")',
  ];

  it.each(BEACONS)("keeps no remote reference: %s", (css) => {
    const out = withoutRemoteLoads(sanitizeSignature(`<div style="color: red; ${css}; font-weight: bold">Alex</div>`));
    expect(out).not.toMatch(/x\.example|\\|url|image|src\(/i);
    expect(out).toContain("Alex");
  });

  it("keeps the harmless styles around it", () => {
    const doc = new DOMParser().parseFromString(
      withoutRemoteLoads(`<div style="color: rgb(192, 0, 0); background:\\75rl(https://x.example/p.png); font-family: Arial, sans-serif; font-size: 11pt">Alex</div>`),
      "text/html",
    );
    const style = doc.querySelector("div")!.style;
    expect(style.color).toBe("rgb(192, 0, 0)");
    expect(style.fontFamily).toBe("Arial, sans-serif");
    expect(style.fontSize).toBe("11pt");
    expect(style.backgroundImage).toBe("");
  });

  it("leaves a plain signature's styles as they were", () => {
    const html = `<table><tbody><tr><td style="color: rgb(192, 0, 0); font: 11pt Aptos, sans-serif;"><b>Alex Rivera</b></td></tr></tbody></table>`;
    expect(withoutRemoteLoads(html)).toBe(html);
  });

  it("drops CSS that loads from SVG presentation attributes and style elements", () => {
    const out = withoutRemoteLoads(
      `<svg><style>rect{fill:url(https://x.example/a.svg#g)}</style><rect fill="u\\72l(https://x.example/a.svg#g)" filter="url(https://x.example/f.svg#f)" width="4" height="4"></rect></svg>` +
        `<style>@import "https://x.example/s.css";</style><b>Alex</b>`,
    );
    expect(out).not.toMatch(/x\.example|<style/i);
    expect(out).toContain('width="4"');
    expect(out).toContain("<b>Alex</b>");
  });

  it("has no style elements left after sanitizing, in HTML or SVG", () => {
    expect(sanitizeSignature(`<style>b{color:red}</style><svg><style>rect{fill:red}</style><rect></rect></svg><b>Alex</b>`)).not.toMatch(/<style/i);
  });

  it("isn't fetched by the composer preview of a reopened draft", async () => {
    const { c } = await openStored(
      gmail,
      `<div>Body text</div><br><div class="zmail-signature"><div style="background:\\75rl(https://x.example/p.png); color: navy">Alex</div>` +
        `<div style='background-image:image-set("https://x.example/q.png" 1x)'>Rivera</div></div>`,
    );
    // Kept for sending as the user saved it; only the preview is filtered.
    expect(c.signatureHtml).toContain("x.example");
    const shown = preview()!;
    expect(shown.innerHTML).not.toMatch(/x\.example|\\75rl|image-set/i);
    expect(shown.textContent).toContain("Alex");
    expect(shown.querySelector("div")!.style.color).toBe("navy");
  });
});

describe("reopening an Outlook reply draft in a later session", () => {
  // What createReply returns: Outlook's own document with the quoted original in its body.
  const QUOTED =
    `<div id="appendonsend"></div><hr style="display:inline-block;width:98%" tabindex="-1">` +
    `<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt" color="#000000"><b>From:</b> Ann &lt;ann@example.com&gt;<br><b>Subject:</b> Budget</font><div>&nbsp;</div></div>` +
    `<div><table><tbody><tr><td><img src="cid:chart@ann" width="200"></td><td>Earlier message</td></tr></tbody></table></div>`;
  const REPLY_DOC = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><style type="text/css" style="display:none">P {margin-top:0;margin-bottom:0;}</style></head><body dir="ltr">${QUOTED}</body></html>`;

  /** One reply draft on a Graph "server": createReply, PATCH and the draft's attachments. */
  function outlookServer() {
    const patches: string[] = [];
    let html = "";
    let atts: (GAttachment & { contentId?: string })[] = [];
    let n = 0;
    graphServer = (method, url, body) => {
      const path = url.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "");
      if (method === "POST" && path === "/me/messages/orig1/createReply") return { id: "R1", body: { contentType: "html", content: REPLY_DOC } };
      if (method === "PATCH" && path === "/me/messages/R1") {
        const content = (body as { body: { content: string } }).body.content;
        patches.push(content);
        // Exchange doesn't promise to keep custom data- attributes.
        html = content.replace(/\sdata-[\w-]+(="[^"]*")?/g, "");
        return { id: "R1" };
      }
      if (method === "GET" && path.startsWith("/me/messages/R1/attachments?")) return { value: atts };
      if (method === "POST" && path === "/me/messages/R1/attachments") {
        const a = body as GFileAttachment;
        atts.push({ id: `att${++n}`, name: a.name, contentType: a.contentType, size: a.contentBytes.length, isInline: a.isInline, contentId: a.contentId, contentBytes: a.contentBytes });
        return { id: `att${n}` };
      }
      if (method === "DELETE" && path.startsWith("/me/messages/R1/attachments/")) {
        atts = atts.filter((a) => a.id !== path.split("/").at(-1));
        return undefined;
      }
      throw new HttpError(404, `no route ${method} ${path}`);
    };
    const draft = (): Email =>
      graphToEmail(outlook.id, { id: "R1", subject: "Re: Budget", receivedDateTime: "2026-10-14T10:00:00Z", parentFolderId: "DRAFTS", toRecipients: [{ emailAddress: { name: "", address: "ann@example.com" } }], body: { contentType: "html", content: html } }, atts);
    const inline = () => atts.filter((a) => a.isInline).map((a) => ({ contentId: a.contentId, contentBytes: a.contentBytes }));
    return { patches, draft, inline };
  }

  it("keeps Outlook's quoted original out of the editor and puts it back once, under our text and rich signature", async () => {
    const server = outlookServer();
    providers.set(outlook.id, new GraphProvider(outlook));
    const orig: Email = { id: "orig1", accountId: outlook.id, threadId: "t1", folderId: "o:INBOX", from: { name: "Ann", address: "ann@example.com" }, to: [{ name: "", address: outlook.address }], subject: "Budget", snippet: "", text: "Earlier message", html: "<div>Earlier message</div>", date: "2026-10-14T09:00:00Z", unread: false, starred: false, labels: [] };
    useMail.setState({ emails: [orig] });
    useMail.getState().openCompose({ mode: "blank", replyTo: "orig1", prefill: { body: "Sounds good." } });
    await mount();
    await act(async () => saveButton().click());
    expect(server.patches).toHaveLength(1);
    expect(count(server.patches[0], "Earlier message")).toBe(1);

    // A later session: a new provider that never saw createReply's quote.
    await act(async () => useMail.getState().openCompose(null));
    providers.set(outlook.id, new GraphProvider(outlook));
    const email = server.draft();
    useMail.setState({ emails: [orig, email] });
    await act(async () => void (await useMail.getState().openDraft(email.id)));

    const c = useMail.getState().compose!;
    expect(c.prefill!.body).toContain("Sounds good.");
    expect(c.prefill!.body).not.toMatch(/Earlier message|From:|Alex Rivera/);
    expect(c.signatureHtml).toContain("<table");
    expect(c.signatureHtml).toContain(`src="data:image/png;base64,${LOGO}"`);
    expect(preview()?.querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${LOGO}`);
    // Like a fresh reply, the composer shows nothing of the quoted original.
    expect(document.body.textContent).not.toMatch(/Earlier message|Ann <ann@example.com>/);

    await act(async () => saveButton().click());
    expect(server.patches).toHaveLength(2);
    const again = server.patches[1];
    const [mine, sig, quote] = [again.indexOf("Sounds good."), again.indexOf("Alex Rivera"), again.indexOf('<hr style="display:inline-block;width:98%"')];
    expect(mine).toBeGreaterThan(0);
    expect(sig).toBeGreaterThan(mine);
    expect(quote).toBeGreaterThan(sig);
    expect(count(again, "Sounds good.")).toBe(1);
    expect(count(again, "Alex Rivera")).toBe(1);
    expect(count(again, "Earlier message")).toBe(1);
    // The quote goes back exactly as Outlook made it, in Outlook's document, after the signature block.
    expect(again).toMatch(/^<html><head><meta http-equiv="Content-Type" content="text\/html; charset=utf-8"><style type="text\/css" style="display:none">P \{margin-top:0;margin-bottom:0;\}<\/style><\/head><body dir="ltr">/);
    expect(again.endsWith(`</div>${QUOTED}</body></html>`)).toBe(true);
    // The signature's image is inline again.
    const cid = /<img[^>]*src="cid:([^"]+)"[^>]*alt="Logo"/.exec(again)?.[1];
    expect(cid).toBeTruthy();
    expect(server.inline()).toEqual([{ contentId: cid, contentBytes: LOGO }]);
  });
});

