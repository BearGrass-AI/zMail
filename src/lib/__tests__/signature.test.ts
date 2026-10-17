// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  composeHtml,
  composeText,
  cssLengthPx,
  fitBox,
  freezeImageSizes,
  htmlToText,
  inlineDataImages,
  migrateTextSignatures,
  sanitizeSignature,
  splitSavedSignature,
  withSignature,
  sizeSignatureImages,
  svgIntrinsicSize,
  tdHeightPx,
  tdWidthPx,
  textToHtml,
  type ImageTools,
} from "@/lib/signature";
import { buildMime } from "@/lib/google/gmail-map";
import { toGraphMessage } from "@/lib/microsoft/graph-map";

// Shaped like what Outlook for Mac puts on the clipboard for a table signature.
const OUTLOOK = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{margin:0in;font-family:Aptos}</style>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]--></head>
<body><!--StartFragment--><table style="border-collapse:collapse"><tr>
<td style="border-right:solid #70002E 2.25pt;padding:0 12pt"><img width="120" src="data:image/png;base64,iVBORw0KGgo=" alt="Logo"></td>
<td><p class="MsoNormal"><b><i><span style="color:#E4A0C0;font-size:14pt">Alex Rivera, MBA</span></i></b><o:p></o:p></p>
<p class="MsoNormal" style="margin-top:4pt"><span style="color:#E4A0C0">Chief Information Officer</span></p>
<p class="MsoNormal"><a href="https://example.org/it">example.org/it</a> | <a href="mailto:z@example.org" onclick="steal()">z@example.org</a></p></td>
</tr></table><script>alert(1)</script><!--EndFragment--></body></html>`;

describe("sanitizeSignature", () => {
  const clean = sanitizeSignature(OUTLOOK);

  it("keeps the table layout, inline styles, links and embedded logo", () => {
    expect(clean).toContain("<table");
    expect(clean).toContain("border-right:solid #70002E 2.25pt");
    expect(clean).toContain("color:#E4A0C0");
    expect(clean).toContain('href="https://example.org/it"');
    expect(clean).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it("drops scripts, handlers, stylesheets, Office tags and comments", () => {
    expect(clean).not.toMatch(/script|onclick|<style|o:p|OfficeDocumentSettings|StartFragment|class=/i);
  });

  it("gives Outlook paragraphs the zero margins their stylesheet provided", () => {
    expect(clean).toMatch(/<p style="margin: 0px;">/);
    // An explicit margin wins.
    expect(clean).toMatch(/<p style="margin: 4pt 0px 0px;">/);
  });
});

describe("text conversions", () => {
  it("renders a signature as readable plain text", () => {
    expect(htmlToText(sanitizeSignature(OUTLOOK))).toBe("Alex Rivera, MBA\nChief Information Officer\nexample.org/it | z@example.org");
  });

  it("numbers ordered lists and dashes bulleted ones", () => {
    expect(htmlToText("<ol><li>a</li><li>b</li></ol>")).toBe("1. a\n2. b");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });

  it("escapes typed text and makes links clickable", () => {
    expect(textToHtml("a < b & c\nsee https://example.org/it?x=1&y=2")).toBe(
      'a &lt; b &amp; c<br>see <a href="https://example.org/it?x=1&amp;y=2">https://example.org/it?x=1&amp;y=2</a>',
    );
  });

  it("composes body + signature for both alternatives", () => {
    const html = composeHtml("Thanks,\nAlex", "<p>Z</p>");
    // The signature is marked so the send step can find it (and strips the marker); the class stays so a reopened draft can find it.
    expect(html).toMatch(/^<div style="[^"]+">Thanks,<br>Alex<\/div><br><div data-zmail-signature="" class="zmail-signature"><p>Z<\/p><\/div>$/);
    expect(composeText("Thanks", "<p>Alex</p><p>CIO</p>")).toBe("Thanks\n\n-- \nAlex\nCIO");
    expect(composeText("Thanks", "")).toBe("Thanks");
  });
});

describe("inlineDataImages", () => {
  it("swaps data: images for cid: parts and dedupes repeats", () => {
    const { html, inline } = inlineDataImages('<img src="data:image/png;base64,AAAA"><img alt="x" src=\'data:image/jpeg;base64,BB BB\'><img src="data:image/png;base64,AAAA">', "t");
    expect(html).toBe('<img src="cid:image1.t@zmail"><img alt="x" src=\'cid:image2.t@zmail\'><img src="cid:image1.t@zmail">');
    expect(inline).toEqual([
      { cid: "image1.t@zmail", filename: "image1.png", mimeType: "image/png", base64: "AAAA" },
      { cid: "image2.t@zmail", filename: "image2.jpg", mimeType: "image/jpeg", base64: "BBBB" },
    ]);
  });

  it("leaves hosted images alone", () => {
    expect(inlineDataImages('<img src="https://example.org/logo.png">').inline).toEqual([]);
  });
});

describe("signature image size math", () => {
  it("converts CSS lengths: pt is 4/3 px, px and unitless as is, others unknown", () => {
    expect(cssLengthPx("114.05pt")).toBeCloseTo(152.07, 2);
    expect(cssLengthPx("120px")).toBe(120);
    expect(cssLengthPx(" 80 ")).toBe(80);
    expect(cssLengthPx("50%")).toBeNull();
    expect(cssLengthPx("auto")).toBeNull();
    expect(cssLengthPx("0")).toBeNull();
    expect(cssLengthPx(null)).toBeNull();
  });

  it("reads an SVG's intrinsic size from its root width/height, in pt", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="794.252pt" height="553.522pt" viewBox="0 0 794.252 553.522"><rect/></svg>`;
    const s = svgIntrinsicSize(svg)!;
    expect(s.width).toBeCloseTo(1059.0, 1);
    expect(s.height).toBeCloseTo(738.03, 1);
  });

  it("reads px/unitless SVG sizes, and falls back to the viewBox", () => {
    expect(svgIntrinsicSize(`<svg xmlns="http://www.w3.org/2000/svg" width="120px" height="60"></svg>`)).toEqual({ width: 120, height: 60 });
    expect(svgIntrinsicSize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"></svg>`)).toEqual({ width: 400, height: 100 });
    // Percent sizes say nothing intrinsic; use the viewBox.
    expect(svgIntrinsicSize(`<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0,0,30,20"></svg>`)).toEqual({ width: 30, height: 20 });
    // One side given: the viewBox supplies the ratio.
    expect(svgIntrinsicSize(`<svg xmlns="http://www.w3.org/2000/svg" width="200" viewBox="0 0 400 100"></svg>`)).toEqual({ width: 200, height: 50 });
    expect(svgIntrinsicSize(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)).toBeNull();
    expect(svgIntrinsicSize("not svg")).toBeNull();
  });

  it("reads a td's width from its style (pt or px) or its width attribute", () => {
    const td = (html: string) => new DOMParser().parseFromString(`<table><tr>${html}</tr></table>`, "text/html").querySelector("td")!;
    expect(tdWidthPx(td(`<td style="padding:0; width: 114.05pt; height: 63.05pt;"></td>`))).toBeCloseTo(152.07, 2);
    expect(tdWidthPx(td(`<td style="width:90px"></td>`))).toBe(90);
    expect(tdWidthPx(td(`<td width="150"></td>`))).toBe(150);
    expect(tdWidthPx(td(`<td width="50%"></td>`))).toBeNull();
    expect(tdWidthPx(td(`<td></td>`))).toBeNull();
  });

  it("fits a natural size inside a width, keeping the aspect ratio and never enlarging", () => {
    expect(fitBox({ width: 1059, height: 738 }, 152)).toEqual({ width: 152, height: 106 });
    expect(fitBox({ width: 1059, height: 738 }, 200)).toEqual({ width: 200, height: 139 });
    expect(fitBox({ width: 120, height: 40 }, 200)).toEqual({ width: 120, height: 40 });
  });

  it("fits inside a height too when one is given", () => {
    expect(fitBox({ width: 1059, height: 738 }, 152, 84)).toEqual({ width: 121, height: 84 });
    expect(fitBox({ width: 120, height: 40 }, 200, 100)).toEqual({ width: 120, height: 40 });
  });

  it("reads a td's height from its style (pt or px) or its height attribute", () => {
    const td = (html: string) => new DOMParser().parseFromString(`<table><tr>${html}</tr></table>`, "text/html").querySelector("td")!;
    expect(tdHeightPx(td(`<td style="width: 114.05pt; height: 63.05pt;"></td>`))).toBeCloseTo(84.07, 2);
    expect(tdHeightPx(td(`<td height="40"></td>`))).toBe(40);
    expect(tdHeightPx(td(`<td style="width:90px"></td>`))).toBeNull();
  });
});

describe("sizeSignatureImages", () => {
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="794.252pt" height="553.522pt" viewBox="0 0 794.252 553.522"><rect width="10" height="10"/></svg>`;
  const svgSrc = `data:image/svg+xml;base64,${btoa(SVG)}`;
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const fake = (natural: { width: number; height: number } | null = { width: 400, height: 100 }, raster: string | null = "data:image/png;base64,UkFTVEVS") => {
    const calls: Array<[string, number, number]> = [];
    const tools: ImageTools = {
      naturalSize: async () => natural,
      rasterize: async (src, w, h) => (calls.push([src, w, h]), raster),
    };
    return { tools, calls };
  };
  const parse = (html: string) => new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;

  it("sizes the CIO logo (794.252×553.522pt SVG in a 114.05×63.05pt cell) to fit the cell, rasterizes at 2x, strips the marker", async () => {
    const { tools, calls } = fake();
    const html = composeHtml("Hi", `<table><tr><td style="width: 114.05pt; height: 63.05pt;"><img src="${svgSrc}" alt="Logo"></td></tr></table>`);
    const out = await sizeSignatureImages(html, tools);
    expect(out).not.toContain("data-zmail-signature");
    const img = parse(out).querySelector("img")!;
    expect(img.getAttribute("width")).toBe("121");
    expect(img.getAttribute("height")).toBe("84");
    expect(img.style.width).toBe("121px");
    expect(img.style.height).toBe("84px");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,UkFTVEVS");
    expect(calls).toEqual([[svgSrc, 242, 168]]);
  });

  it("fits to the td's width alone when it has no height", async () => {
    const { tools } = fake();
    const html = composeHtml("Hi", `<table><tr><td width="152"><img src="${svgSrc}"></td></tr></table>`);
    const img = parse(await sizeSignatureImages(html, tools)).querySelector("img")!;
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["152", "106"]);
  });

  it("sizes several images concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const tools: ImageTools = {
      naturalSize: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { width: 400, height: 100 };
      },
      rasterize: async () => null,
    };
    const out = await sizeSignatureImages(composeHtml("Hi", `<img src="${png}"><img src="${png}#2"><img src="${png}#3">`), tools);
    expect(peak).toBe(3);
    expect([...parse(out).querySelectorAll("img")].map((i) => i.getAttribute("width"))).toEqual(["200", "200", "200"]);
  });

  it("keeps the SVG (still sized) when rasterizing fails", async () => {
    const { tools } = fake(null, null);
    const out = await sizeSignatureImages(composeHtml("Hi", `<img src="${svgSrc}">`), tools);
    const img = parse(out).querySelector("img")!;
    expect(img.getAttribute("src")).toBe(svgSrc);
    // No td: capped at 200 px wide.
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["200", "139"]);
  });

  it("caps an unsized raster image at 200 px using its loaded natural size", async () => {
    const { tools, calls } = fake({ width: 800, height: 200 });
    const img = parse(await sizeSignatureImages(composeHtml("Hi", `<p><img src="${png}"></p>`), tools)).querySelector("img")!;
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["200", "50"]);
    expect(img.getAttribute("src")).toBe(png);
    expect(calls).toEqual([]);
  });

  it("uses the image's own inline style size first", async () => {
    const { tools } = fake({ width: 800, height: 200 });
    const img = parse(await sizeSignatureImages(composeHtml("Hi", `<table><tr><td style="width:300pt"><img style="width: 90pt" src="${png}"></td></tr></table>`), tools)).querySelector("img")!;
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["120", "30"]);
  });

  it("leaves an image that already has width and height alone (but still rasterizes an SVG at 2x)", async () => {
    const { tools, calls } = fake();
    const sig = `<img width="120" height="84" src="${png}"><img width="60" height="40" src="${svgSrc}">`;
    const out = await sizeSignatureImages(composeHtml("Hi", sig), tools);
    const [a, b] = parse(out).querySelectorAll("img");
    expect([a.getAttribute("width"), a.getAttribute("height"), a.getAttribute("src"), a.getAttribute("style")]).toEqual(["120", "84", png, null]);
    expect(b.getAttribute("style")).toBeNull();
    expect(calls).toEqual([[svgSrc, 120, 80]]);
  });

  it("leaves images in the typed body alone", async () => {
    const { tools } = fake();
    const body = `<img src="${png}">`;
    const html = `<div>${body}</div><br><div data-zmail-signature=""><img src="${png}"></div>`;
    const [first, second] = parse(await sizeSignatureImages(html, tools)).querySelectorAll("img");
    expect(first.hasAttribute("width")).toBe(false);
    expect(second.getAttribute("width")).toBe("200");
  });

  // A reopened draft's signature came from the server: nothing in it is fetched to measure it.
  it("measures only embedded images when remote loads are off", async () => {
    const seen: string[] = [];
    const tools: ImageTools = { naturalSize: async (src) => (seen.push(src), { width: 400, height: 100 }), rasterize: async () => null };
    const html = composeHtml("Hi", `<p><img src="https://tracker.example/p.png"><img src="${png}"></p>`);
    const [remote, local] = parse(await sizeSignatureImages(html, tools, { remote: false })).querySelectorAll("img");
    expect(seen).toEqual([png]);
    expect(remote.hasAttribute("width")).toBe(false);
    expect(local.getAttribute("width")).toBe("200");
  });

  it("returns mail without a signature unchanged", async () => {
    const html = composeHtml("a & b\nc");
    expect(await sizeSignatureImages(html, fake().tools)).toBe(html);
  });

  it("inlineDataImages also drops a stray marker", () => {
    expect(inlineDataImages('<div data-zmail-signature="">x</div>', "t").html).toBe("<div>x</div>");
  });
});

describe("freezeImageSizes (editor)", () => {
  const rendered = (img: HTMLImageElement, width: number, height: number, naturalWidth = width) => {
    Object.defineProperty(img, "offsetWidth", { value: width });
    Object.defineProperty(img, "offsetHeight", { value: height });
    Object.defineProperty(img, "naturalWidth", { value: naturalWidth });
  };

  it("fills in only the missing attribute, from the rendered aspect ratio", () => {
    const root = document.createElement("div");
    root.innerHTML = `<img width="60" src="a.png"><img height="30" src="b.png">`;
    const [a, b] = root.querySelectorAll("img");
    rendered(a, 50, 20);
    rendered(b, 90, 30);
    expect(freezeImageSizes(root)).toBe(true);
    expect([a.getAttribute("width"), a.getAttribute("height")]).toEqual(["60", "24"]);
    expect([b.getAttribute("width"), b.getAttribute("height")]).toEqual(["90", "30"]);
  });

  it("skips an image shrunk by max-width (no width attribute or style width)", () => {
    const root = document.createElement("div");
    root.innerHTML = `<img src="a.png"><img style="width: 152px" src="b.png">`;
    const [a, b] = root.querySelectorAll("img");
    rendered(a, 152, 106, 1059);
    rendered(b, 152, 106, 1059);
    expect(freezeImageSizes(root)).toBe(true);
    expect(a.hasAttribute("width")).toBe(false);
    expect([b.getAttribute("width"), b.getAttribute("height")]).toEqual(["152", "106"]);
  });

  it("pins unsized images to their rendered size, rounded", () => {
    const root = document.createElement("div");
    root.innerHTML = `<img src="a.png"><img width="50" src="b.png">`;
    const [a, b] = root.querySelectorAll("img");
    rendered(a, 152.4, 105.6);
    rendered(b, 50, 20);
    expect(freezeImageSizes(root)).toBe(true);
    expect([a.getAttribute("width"), a.getAttribute("height")]).toEqual(["152", "106"]);
    expect([b.getAttribute("width"), b.getAttribute("height")]).toEqual(["50", "20"]);
  });

  it("skips images that haven't loaded and leaves sized images alone", () => {
    const root = document.createElement("div");
    root.innerHTML = `<img src="a.png"><img width="120" height="84" src="b.png">`;
    const [a, b] = root.querySelectorAll("img");
    rendered(a, 0, 0);
    rendered(b, 300, 200);
    expect(freezeImageSizes(root)).toBe(false);
    expect(a.hasAttribute("width")).toBe(false);
    expect([b.getAttribute("width"), b.getAttribute("height")]).toEqual(["120", "84"]);
  });
});

describe("HTML sending", () => {
  const inline = [{ cid: "image1.t@zmail", filename: "image1.png", mimeType: "image/png", base64: "iVBO" }];

  it("nests mixed > alternative > related with distinct boundaries", () => {
    const mime = buildMime(
      {
        from: "me@x.com",
        to: ["a@b.com"],
        subject: "Hi",
        text: "Hello",
        html: '<p>Hello — ✓</p><img src="cid:image1.t@zmail">',
        inline,
        attachments: [{ filename: "a.txt", mimeType: "text/plain", base64: btoa("hi") }],
      },
      "B",
    );
    const order = [...mime.matchAll(/^(Content-Type: [^;\r]+|--[\w-]+)/gm)].map((m) => m[1]);
    expect(order).toEqual([
      "Content-Type: multipart/mixed",
      "--B",
      "Content-Type: multipart/alternative",
      "--alt-B",
      "Content-Type: text/plain",
      "--alt-B",
      "Content-Type: multipart/related",
      "--rel-B",
      "Content-Type: text/html",
      "--rel-B",
      "Content-Type: image/png",
      "--rel-B--",
      "--alt-B--",
      "--B",
      "Content-Type: text/plain",
      "--B--",
    ]);
    expect(mime).toContain("Content-ID: <image1.t@zmail>");
    // HTML travels base64-encoded UTF-8.
    const b64 = mime.split("Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, "");
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).toBe('<p>Hello — ✓</p><img src="cid:image1.t@zmail">');
  });

  it("without attachments the alternative is the top-level body", () => {
    const mime = buildMime({ from: "me@x.com", to: ["a@b.com"], subject: "Hi", text: "Hello", html: "<p>Hello</p>" }, "B");
    expect(mime).toContain('MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="alt-B"');
    expect(mime).not.toContain("multipart/related");
    expect(mime.trim().endsWith("--alt-B--")).toBe(true);
  });

  it("Graph gets an HTML body and inline attachments with content ids", () => {
    const m = toGraphMessage({ to: ["a@b.com"], subject: "Hi", text: "Hello", html: "<p>Hello</p>", inline });
    expect(m.body).toEqual({ contentType: "HTML", content: "<p>Hello</p>" });
    expect(m.attachments).toEqual([
      { "@odata.type": "#microsoft.graph.fileAttachment", name: "image1.png", contentType: "image/png", contentBytes: "iVBO", isInline: true, contentId: "image1.t@zmail" },
    ]);
  });
});

describe("migrateTextSignatures", () => {
  it("turns per-account text signatures into named defaults", () => {
    const { list, defaults } = migrateTextSignatures({ g1: "Alex\nCIO", m1: "  " }, () => "alex@gmail.com");
    expect(list).toEqual([{ id: "sig-g1", name: "alex@gmail.com", html: "Alex<br>CIO" }]);
    expect(defaults).toEqual({ g1: { new: "sig-g1", reply: "sig-g1" } });
  });
});

describe("splitSavedSignature", () => {
  it("finds our own block in a reply saved without a signature, not one in the quoted zMail message under it", () => {
    const quote = '<hr><p>From: Ann</p><div>Earlier</div><div class="zmail-signature"><p>Ann, Registrar</p></div>';
    const saved = `<html><body>${withSignature("<div>My reply</div>")}${quote}</body></html>`;
    const split = splitSavedSignature(saved)!;
    expect(split.body).toBe("<div>My reply</div>");
    expect(split.signature).toBe("");
    expect(split.quote).toContain("From: Ann");
    expect(split.quote).toContain("Ann, Registrar");
  });

  // A draft started in Outlook or Gmail has no block of ours, so one under its quote header is the quoted sender's.
  it.each([
    ["Outlook", `<div>My reply</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg">From: Ann</div><div class="zmail-signature"><a href="https://phish.example/login">Ann</a></div>`],
    ["Outlook (nested)", `<div>My reply</div><hr><div id="divRplyFwdMsg">From: Ann</div><div><div class="zmail-signature"><img src="https://tracker.example/p.png"></div></div>`],
    ["Gmail", `<div>My reply</div><div class="gmail_quote"><div>---------- Forwarded message ---------</div><div class="zmail-signature">Ann</div></div>`],
  ])("ignores a signature block under a %s quote", (_name, html) => {
    expect(splitSavedSignature(`<html><body>${html}</body></html>`)).toBeNull();
  });
});
