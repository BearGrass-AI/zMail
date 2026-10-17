import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));
// Vite's `?url` gives a server path; in Node, pdf.js loads its worker from a file URL instead.
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: new URL("../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href,
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({
  default: new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).href,
}));

const { readableKind, extractText } = await import("@/lib/file-text");

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe("readableKind", () => {
  it("picks a reader by MIME type", () => {
    expect(readableKind("x", "text/plain")).toBe("text");
    expect(readableKind("x", "application/json")).toBe("text");
    expect(readableKind("x", "application/pdf")).toBe("pdf");
  });
  it("falls back to the extension", () => {
    expect(readableKind("a.pdf", "application/octet-stream")).toBe("pdf");
    expect(readableKind("a.DOCX", "application/octet-stream")).toBe("word");
    expect(readableKind("a.csv", "application/octet-stream")).toBe("text");
  });
  it("can't read images or spreadsheets", () => {
    expect(readableKind("a.png", "image/png")).toBeNull();
    expect(readableKind("a.xlsx", "application/vnd.ms-excel")).toBeNull();
  });
});

describe("extractText", () => {
  it("decodes a UTF-8 text file", async () => {
    const r = await extractText({ filename: "a.txt", mimeType: "text/plain", base64: b64("héllo\r\n\r\n\r\n\r\nworld") });
    expect(r).toEqual({ text: "héllo\n\nworld", truncated: false });
  });
  it("cuts to max and says so", async () => {
    const r = await extractText({ filename: "a.txt", mimeType: "text/plain", base64: b64("x".repeat(50)) }, 10);
    expect(r).toEqual({ text: "x".repeat(10), truncated: true });
  });
  it("asks for the desktop app for Word files in the browser", async () => {
    await expect(extractText({ filename: "a.docx", mimeType: "", base64: "" })).rejects.toThrow("Word files can be read in the desktop app");
  });
  it("refuses types it can't read", async () => {
    await expect(extractText({ filename: "a.png", mimeType: "image/png", base64: "" })).rejects.toThrow("Can't read this type");
  });
});

/** A one-page PDF whose page draws `text` in Helvetica, with a correct xref table. */
function tinyPdf(text: string): string {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return btoa(pdf);
}

describe("extractText on a PDF", () => {
  // Node lacks Math.sumPrecise, so this takes the legacy build (the web-view fallback).
  it("reads the page text", async () => {
    const r = await extractText({ filename: "a.pdf", mimeType: "application/pdf", base64: tinyPdf("Quarterly budget") });
    expect(r).toEqual({ text: "Quarterly budget", truncated: false });
  });
  it("reads it with the standard build where the new built-ins exist", async () => {
    const math = Math as { sumPrecise?: (xs: Iterable<number>) => number };
    const had = "sumPrecise" in math;
    if (!had) math.sumPrecise = (xs) => [...xs].reduce((a, b) => a + b, 0);
    try {
      const r = await extractText({ filename: "a.pdf", mimeType: "application/pdf", base64: tinyPdf("Board agenda") });
      expect(r).toEqual({ text: "Board agenda", truncated: false });
    } finally {
      if (!had) delete math.sumPrecise;
    }
  });
  it("says it couldn't read a broken PDF", async () => {
    await expect(extractText({ filename: "a.pdf", mimeType: "application/pdf", base64: btoa("not a pdf") })).rejects.toThrow("Couldn't read this file");
  });
});
