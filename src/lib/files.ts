// Saving/opening attachments. In the browser preview, files download instead.

import { invoke, isTauri } from "@tauri-apps/api/core";

export async function saveFile(filename: string, base64: string, to: "downloads" | "temp"): Promise<string | null> {
  if (isTauri()) return invoke<string>("save_attachment", { filename, base64, to });
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
  return null;
}

/** What `open_path` rejects with for a file type that can run code (matches `RISKY_MESSAGE` in files.rs). */
export const RISKY_MESSAGE = "This file type can run code, so zMail showed it in Finder instead.";

export async function openPath(path: string) {
  if (isTauri()) await invoke("open_path", { path });
}

export async function revealPath(path: string) {
  if (isTauri()) await invoke("reveal_path", { path });
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Read a browser File as standard base64. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
