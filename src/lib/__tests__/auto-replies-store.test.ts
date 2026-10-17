// @vitest-environment jsdom
// Automatic replies in the store, against the real MockMailProvider.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/accounts", async () => {
  const { ACCOUNTS } = await import("@/lib/mail/mock-data");
  const { MockMailProvider } = await import("@/lib/mail/mock-provider");
  return {
    loadRegistry: async () => [ACCOUNTS[0]],
    saveRegistry: async () => {},
    calendarProviderFor: () => null,
    mailProviderFor: (a: import("@/lib/types").Account) => new MockMailProvider(a),
  };
});
vi.mock("@/lib/db", () => ({
  kvGet: async () => null,
  kvSet: async () => {},
  cacheListFolders: async () => [],
  cacheListMessages: async () => [],
  cachePutMessages: async () => {},
  cacheDeleteAccount: async () => [],
}));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", () => ({ triageAll: async () => ({ done: 0, failed: 0 }) }));

const { useMail, providerOf } = await import("@/lib/store");
const { NeedsPermissionError } = await import("@/lib/mail/auto-replies");

describe("automatic replies in the store", () => {
  it("loads after startup, saves, and reads back", async () => {
    await useMail.getState().load();
    const id = useMail.getState().accounts[0].id;
    await vi.waitFor(() => expect(useMail.getState().autoReplies[id]).toEqual({ enabled: false, message: "", audience: "all" }));

    await useMail.getState().saveAutoReply(id, { enabled: true, message: "<p>Away</p>", audience: "contactsOnly" });
    const r = useMail.getState().autoReplies[id];
    expect(typeof r === "object" && r.enabled).toBe(true);
    expect(await providerOf(id).getAutoReply!()).toMatchObject({ enabled: true, audience: "contactsOnly" });
  });

  it("marks needs-permission and error without throwing on load, and rethrows on save", async () => {
    const id = useMail.getState().accounts[0].id;
    const p = providerOf(id);
    const get = vi.spyOn(p, "getAutoReply").mockRejectedValueOnce(new NeedsPermissionError());
    await useMail.getState().loadAutoReply(id);
    expect(useMail.getState().autoReplies[id]).toBe("needs-permission");

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    get.mockRejectedValueOnce(new Error("boom"));
    await useMail.getState().loadAutoReply(id);
    expect(useMail.getState().autoReplies[id]).toBe("error");
    err.mockRestore();

    vi.spyOn(p, "setAutoReply").mockRejectedValueOnce(new NeedsPermissionError());
    await expect(useMail.getState().saveAutoReply(id, { enabled: false, message: "", audience: "all" })).rejects.toBeInstanceOf(NeedsPermissionError);
    expect(useMail.getState().autoReplies[id]).toBe("needs-permission");
  });

  it("drops the account's entry when the account is removed", async () => {
    const id = useMail.getState().accounts[0].id;
    await useMail.getState().loadAutoReply(id);
    expect(useMail.getState().autoReplies[id]).toBeDefined();
    await useMail.getState().removeAccount(id);
    expect(useMail.getState().autoReplies[id]).toBeUndefined();
  });
});
