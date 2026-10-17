import { describe, expect, it } from "vitest";
import { gfileToDrive, linksBlock, oditemToDrive } from "@/lib/drive";

describe("drive mapping", () => {
  it("maps Google Drive files", () => {
    expect(
      gfileToDrive({ id: "1", name: "Budget.xlsx", mimeType: "x", modifiedTime: "2026-10-01T00:00:00Z", size: "2048", webViewLink: "https://docs.google.com/x", owners: [{ displayName: "Alex" }] }),
    ).toEqual({ id: "1", name: "Budget.xlsx", mimeType: "x", modified: "2026-10-01T00:00:00Z", size: 2048, url: "https://docs.google.com/x", owner: "Alex", source: "gdrive" });
  });

  it("maps OneDrive items, unwraps shared remote items, skips folders", () => {
    expect(oditemToDrive({ id: "f", name: "Docs", folder: {}, lastModifiedDateTime: "", webUrl: "" })).toBeNull();
    const shared = oditemToDrive({
      id: "recent-1",
      name: "ignored",
      lastModifiedDateTime: "",
      webUrl: "",
      remoteItem: { id: "remote", name: "Runbook.pdf", file: { mimeType: "application/pdf" }, size: 10, lastModifiedDateTime: "2026-10-02T00:00:00Z", webUrl: "https://umt.sharepoint.com/x" },
    })!;
    expect(shared).toMatchObject({ id: "recent-1", name: "Runbook.pdf", url: "https://umt.sharepoint.com/x", source: "onedrive" });
  });

  it("formats inserted links", () => {
    expect(linksBlock([{ id: "1", name: "A.pdf", url: "https://a", mimeType: "", modified: "", source: "demo" }, { id: "2", name: "B", url: "https://b", mimeType: "", modified: "", source: "demo" }])).toBe(
      "A.pdf\nhttps://a\n\nB\nhttps://b",
    );
  });
});
