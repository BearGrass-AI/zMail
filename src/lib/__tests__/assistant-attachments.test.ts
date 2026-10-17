// @vitest-environment jsdom
// Attachments module: reading attachment text and opening forwards with files.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, type ToolDeps } from "@/lib/ai/assistant/tools";
import type { AttachmentsDeps } from "@/lib/ai/assistant/modules/attachments";
import type { Compose } from "@/lib/store";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));
const { useAssistant } = await import("@/lib/ai/assistant/state");

const att = (id: string, filename: string, mimeType: string, size = 10, inline = false) => ({ id, filename, mimeType, size, inline });
const email = { id: "e1", accountId: "a", attachments: [att("1", "Contract.pdf", "application/pdf"), att("2", "pic.png", "image/png"), att("3", "logo.pdf", "application/pdf", 5, true)] };

function make(over: Record<string, unknown> = {}) {
  const d = {
    getEmail: vi.fn(async () => email),
    attachmentData: vi.fn(async () => "QUJD"),
    extract: vi.fn(async () => ({ text: "x".repeat(15_000), truncated: false })),
    openCompose: vi.fn<(c: Compose) => Promise<"opened">>(async () => "opened"),
    ...over,
  };
  return { d, deps: { ext: { attachments: d as unknown as AttachmentsDeps } } as unknown as ToolDeps };
}
const run = (name: string, args: Record<string, unknown>, deps: ToolDeps) => executeTool({ id: "c1", name, args }, deps);

beforeEach(() => {
  useAssistant.getState().newChat();
  useAssistant.getState().remember([{ id: "e1", accountId: "a" }]);
});

describe("read_attachment", () => {
  it("reads case-insensitively and caps text at 12,000 characters", async () => {
    const { d, deps } = make();
    const r = (await run("read_attachment", { email_id: "e1", filename: "contract.PDF" }, deps)).content as Record<string, unknown>;
    expect(r.filename).toBe("Contract.pdf");
    expect((r.text as string).length).toBe(12_000);
    expect(r.truncated).toBe(true);
    expect(d.attachmentData).toHaveBeenCalledWith("e1", "1");
  });
  it("errors on an unknown filename and skips inline files", async () => {
    const { deps } = make();
    expect(((await run("read_attachment", { email_id: "e1", filename: "nope.pdf" }, deps)).content as { error: string }).error).toMatch(/No attachment named/);
    expect(((await run("read_attachment", { email_id: "e1", filename: "logo.pdf" }, deps)).content as { error: string }).error).toMatch(/No attachment named/);
  });
  it("errors on an unreadable type", async () => {
    const { d, deps } = make();
    const r = (await run("read_attachment", { email_id: "e1", filename: "pic.png" }, deps)).content as { error: string };
    expect(r.error).toMatch(/^Can't read this type of file/);
    expect(d.extract).not.toHaveBeenCalled();
  });
  it("rejects ids the model never saw", async () => {
    const { deps } = make();
    expect((await run("read_attachment", { email_id: "zzz", filename: "a" }, deps)).content).toHaveProperty("error");
  });
});

describe("forward_with_attachments", () => {
  it("opens the forward with all non-inline files, to and body", async () => {
    const { d, deps } = make();
    const r = await run("forward_with_attachments", { email_id: "e1", to: "legal@x.com", body: "FYI" }, deps);
    expect(r.content).toEqual({ status: "opened", files: 2 });
    expect(d.openCompose).toHaveBeenCalledWith({
      mode: "blank", replyTo: "e1", forward: true, prefill: { to: "legal@x.com", body: "FYI" },
      attachments: [{ filename: "Contract.pdf", mimeType: "application/pdf", base64: "QUJD", size: 10 }, { filename: "pic.png", mimeType: "image/png", base64: "QUJD", size: 10 }],
    });
  });
  it("includes only the named files", async () => {
    const { d, deps } = make();
    expect((await run("forward_with_attachments", { email_id: "e1", filenames: ["CONTRACT.pdf"] }, deps)).content).toEqual({ status: "opened", files: 1 });
    expect(d.openCompose.mock.calls[0][0].attachments).toHaveLength(1);
  });
  it("errors over 20 MB without opening", async () => {
    const big = { ...email, attachments: [att("1", "a.pdf", "application/pdf", 15 * 1024 * 1024), att("2", "b.pdf", "application/pdf", 8 * 1024 * 1024)] };
    const { d, deps } = make({ getEmail: vi.fn(async () => big) });
    expect(((await run("forward_with_attachments", { email_id: "e1" }, deps)).content as { error: string }).error).toMatch(/20 MB/);
    expect(d.openCompose).not.toHaveBeenCalled();
  });
});
