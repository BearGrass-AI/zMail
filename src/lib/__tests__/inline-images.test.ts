// @vitest-environment jsdom
// Embedded (cid:) images: finding them in a Gmail MIME tree, and the store action that fetches them once.
import { describe, expect, it, vi } from "vitest";
import type { Email } from "@/lib/types";
import { inlineParts, type GPart } from "@/lib/google/gmail-map";

describe("inlineParts", () => {
  it("returns image parts with a Content-ID, not ordinary attachments", () => {
    const tree: GPart = {
      mimeType: "multipart/related",
      parts: [
        { mimeType: "text/html", body: { size: 1, data: "x" } },
        { mimeType: "image/png", filename: "a.png", headers: [{ name: "Content-ID", value: "<logo@x>" }], body: { size: 1, attachmentId: "att1" } },
        { mimeType: "image/jpeg", headers: [{ name: "Content-Id", value: " <pic@x> " }], body: { size: 1, data: "QUJD" } },
        { mimeType: "application/pdf", filename: "a.pdf", headers: [{ name: "Content-ID", value: "<pdf@x>" }], body: { size: 1, attachmentId: "att2" } },
        { mimeType: "image/gif", filename: "plain.gif", body: { size: 1, attachmentId: "att3" } },
      ],
    };
    expect(inlineParts(tree)).toEqual([
      { cid: "logo@x", mimeType: "image/png", data: undefined, attachmentId: "att1" },
      { cid: "pic@x", mimeType: "image/jpeg", data: "QUJD", attachmentId: undefined },
    ]);
  });
});

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const row = (id: string) =>
  ({ id, accountId: "g", threadId: id, folderId: "g:INBOX", from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date: "2026-01-01T00:00:00Z", unread: false, starred: false, labels: ["INBOX"] }) as Email;

let inline = vi.fn(async (_id: string) => [{ cid: "Logo@X", mimeType: "image/png", base64: "AAAA" }]);
const fake = {
  account: gmail,
  batchSize: 50,
  listFolders: async () => [],
  listMessages: async () => [] as Email[],
  inlineImages: (id: string) => inline(id),
};
vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "g", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: () => fake,
}));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ai/triage")>()), triageAll: async () => ({ done: 0, failed: 0 }) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => 0, { error: () => 0, success: () => 0 }) }));

const { useMail } = await import("@/lib/store");

describe("store inlineImages", () => {
  it("maps lowercased cids to data URLs and fetches each email once", async () => {
    if (!useMail.getState().accounts.length) await useMail.getState().load();
    useMail.setState({ emails: [row("e1"), row("e2")] });
    const [a, b] = await Promise.all([useMail.getState().inlineImages("e1"), useMail.getState().inlineImages("e1")]);
    expect(a.get("logo@x")).toBe("data:image/png;base64,AAAA");
    expect(b).toBe(a);
    await useMail.getState().inlineImages("e1");
    expect(inline).toHaveBeenCalledTimes(1);
  });

  it("resolves to an empty map when the provider fails", async () => {
    inline = vi.fn(async () => {
      throw new Error("boom");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = await useMail.getState().inlineImages("e2");
    expect(m.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
