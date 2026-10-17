// Plain text from files the user adds to "Draft with AI", so the assistant can read them.

import { invoke, isTauri } from "@tauri-apps/api/core";

export const PER_FILE_CHARS = 20_000;
export const TOTAL_CHARS = 40_000;

export type Readable = "text" | "pdf" | "word" | null;

const TEXT_EXT = new Set(["txt", "md", "csv", "tsv", "json", "ics", "eml", "log"]);
const WORD_EXT = new Set(["doc", "docx", "rtf", "rtfd", "odt"]);

const ext = (filename: string) => filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

/** Which reader handles a file, by MIME type then extension; null = can't read. */
export function readableKind(filename: string, mimeType: string): Readable {
  const mime = mimeType.toLowerCase();
  const e = ext(filename);
  if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXT.has(e)) return "text";
  if (mime === "application/pdf" || e === "pdf") return "pdf";
  if (WORD_EXT.has(e)) return "word";
  return null;
}

function toBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function pdfText(bytes: Uint8Array, max: number): Promise<string> {
  // pdf.js 6's standard build calls brand-new built-ins (Map.prototype.getOrInsertComputed,
  // Math.sumPrecise); where the web view lacks them, use its legacy build, which polyfills.
  const modern =
    typeof (Map.prototype as { getOrInsertComputed?: unknown }).getOrInsertComputed === "function" &&
    typeof (Math as { sumPrecise?: unknown }).sumPrecise === "function";
  const pdfjs = modern ? await import("pdfjs-dist") : await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { default: workerUrl } = modern
    ? await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    : await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: bytes });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    let length = 0;
    for (let n = 1; n <= doc.numPages && length <= max; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      const text = content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
      pages.push(text);
      length += text.length;
    }
    return pages.join("\n\n");
  } finally {
    // pdf.js 6 tears a document down through its loading task.
    void task.destroy();
  }
}

/** The file's text, cut to `max` characters. Throws a plain-language Error when it can't read it. */
export async function extractText(
  file: { filename: string; mimeType: string; base64: string },
  max = PER_FILE_CHARS,
): Promise<{ text: string; truncated: boolean }> {
  const kind = readableKind(file.filename, file.mimeType);
  if (!kind) throw new Error("Can't read this type");
  let raw: string;
  try {
    if (kind === "text") raw = new TextDecoder("utf-8").decode(toBytes(file.base64));
    else if (kind === "pdf") raw = await pdfText(toBytes(file.base64), max);
    else {
      if (!isTauri()) throw new Error("Word files can be read in the desktop app");
      raw = await invoke<string>("extract_text", { filename: file.filename, base64: file.base64 });
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Word files")) throw err;
    throw new Error("Couldn't read this file");
  }
  const text = raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}
