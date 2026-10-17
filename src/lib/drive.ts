// Cloud files for "Insert from Drive": Google Drive (Gmail accounts) and
// OneDrive/SharePoint (Microsoft 365 accounts). Read-only: zMail inserts the
// file's link, which keeps the file's existing sharing settings.

import type { Account } from "@/lib/types";
import { request } from "@/lib/transport";
import { accessToken } from "@/lib/oauth";
import { graph } from "@/lib/microsoft/graph";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modified: string;
  size?: number;
  url: string;
  owner?: string;
  source: "gdrive" | "onedrive" | "demo";
}

export interface DriveProvider {
  readonly label: string;
  readonly account: Account;
  recent(): Promise<DriveFile[]>;
  search(q: string): Promise<DriveFile[]>;
}

// ---- Google Drive ------------------------------------------------------------------

interface GFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  webViewLink: string;
  owners?: { displayName: string }[];
}

export function gfileToDrive(f: GFile): DriveFile {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modified: f.modifiedTime,
    size: f.size ? Number(f.size) : undefined,
    url: f.webViewLink,
    owner: f.owners?.[0]?.displayName,
    source: "gdrive",
  };
}

export class GoogleDrive implements DriveProvider {
  readonly label = "Google Drive";
  constructor(readonly account: Account) {}

  private async list(q: string) {
    const params = new URLSearchParams({
      q,
      orderBy: "modifiedTime desc",
      pageSize: "50",
      fields: "files(id,name,mimeType,modifiedTime,size,webViewLink,owners(displayName))",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    const token = await accessToken(this.account.id);
    const res = await request<{ files: GFile[] }>("GET", `https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.files.map(gfileToDrive);
  }

  recent() {
    return this.list("trashed = false and mimeType != 'application/vnd.google-apps.folder'");
  }

  search(q: string) {
    const safe = q.replace(/['\\]/g, "\\$&");
    return this.list(`trashed = false and name contains '${safe}' and mimeType != 'application/vnd.google-apps.folder'`);
  }
}

// ---- OneDrive / SharePoint ------------------------------------------------------------

interface ODItem {
  id: string;
  name: string;
  file?: { mimeType?: string };
  folder?: unknown;
  size?: number;
  lastModifiedDateTime: string;
  webUrl: string;
  remoteItem?: ODItem;
  createdBy?: { user?: { displayName?: string } };
}

export function oditemToDrive(raw: ODItem): DriveFile | null {
  const it = raw.remoteItem ? { ...raw.remoteItem, id: raw.id } : raw;
  if (it.folder || !it.file) return null;
  return {
    id: it.id,
    name: it.name,
    mimeType: it.file.mimeType ?? "application/octet-stream",
    modified: it.lastModifiedDateTime,
    size: it.size,
    url: it.webUrl,
    owner: it.createdBy?.user?.displayName,
    source: "onedrive",
  };
}

export class OneDrive implements DriveProvider {
  readonly label = "OneDrive";
  constructor(readonly account: Account) {}

  private async get(path: string) {
    const res = await graph<{ value: ODItem[] }>(this.account.id, "GET", path);
    return res.value.map(oditemToDrive).filter((f): f is DriveFile => !!f);
  }

  recent() {
    return this.get("/me/drive/recent?$top=50");
  }

  search(q: string) {
    return this.get(`/me/drive/root/search(q='${encodeURIComponent(q.replace(/'/g, "''"))}')?$top=50`);
  }
}

// ---- demo ---------------------------------------------------------------------------------

const DEMO: DriveFile[] = [
  ["FY27 Budget Request – IT.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 1],
  ["Trustees Oct – IT Section.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 2],
  ["AI Governance Policy DRAFT v3.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 3],
  ["Banner 9.4 Upgrade Runbook.pdf", "application/pdf", 5],
  ["Lab Refresh Comparison.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 8],
].map(([name, mimeType, daysAgo], i) => ({
  id: `demo-${i}`,
  name: String(name),
  mimeType: String(mimeType),
  modified: new Date(Date.now() - Number(daysAgo) * 864e5).toISOString(),
  url: `https://example.com/demo-drive/${encodeURIComponent(String(name))}`,
  owner: "Alex Rivera",
  source: "demo" as const,
}));

export class DemoDrive implements DriveProvider {
  readonly label = "Demo files";
  constructor(readonly account: Account) {}
  async recent() {
    return DEMO;
  }
  async search(q: string) {
    return DEMO.filter((f) => f.name.toLowerCase().includes(q.toLowerCase()));
  }
}

export function driveFor(a: Account): DriveProvider {
  return a.kind === "gmail" ? new GoogleDrive(a) : a.kind === "m365" ? new OneDrive(a) : new DemoDrive(a);
}

/** Plain-text block inserted into a message for the chosen files. */
export function linksBlock(files: DriveFile[]) {
  return files.map((f) => `${f.name}\n${f.url}`).join("\n\n");
}

/** The same files as HTML: a paragraph per file with a link. */
export function linksBlockHtml(files: DriveFile[]) {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return files.map((f) => `<p><a href="${esc(f.url)}">${esc(f.name)}</a></p>`).join("");
}
