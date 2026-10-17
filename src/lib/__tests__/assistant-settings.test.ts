// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, type ToolDeps } from "@/lib/ai/assistant/tools";
import { settingsModule, type SettingsDeps } from "@/lib/ai/assistant/modules/settings";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));
const mac = vi.hoisted(() => ({ enableMacContacts: vi.fn() }));
vi.mock("@/lib/mac-contacts", () => mac);

let s: Record<string, unknown>;
let defs: Record<string, { new?: string | null; reply?: string | null }>;
let toasts: { text: string; undo?: () => void }[];
let deps: ToolDeps;
const fake = (): SettingsDeps => ({
  getSettings: () => s,
  setSetting: (k, v) => void (s[k] = v),
  enableMacContacts: mac.enableMacContacts,
  signatures: () => [{ id: "s1", name: "Work" }, { id: "s2", name: "Casual" }],
  accounts: () => [{ id: "a1", address: "a@x.com" }, { id: "a2", address: "b@x.com" }],
  signatureDefaults: () => defs,
  setSignatureDefault: (a, w, id) => void (defs[a] = { ...defs[a], [w]: id }),
});
const run = (name: string, args: Record<string, unknown>) => executeTool({ id: "c1", name, args }, deps);

beforeEach(() => {
  s = { theme: "system", palette: "glacier", suggestThreshold: 0.7, macContactsPhotos: false, apiKey: "secret" };
  defs = { a1: { new: "s2", reply: null } };
  toasts = [];
  mac.enableMacContacts.mockReset();
  deps = { ext: { settings: fake() }, toast: (text: string, undo?: () => void) => toasts.push({ text, undo }) } as unknown as ToolDeps;
});

describe("settings module", () => {
  it("registers its tools", () => {
    expect(settingsModule.tools.map((t) => t.name).sort()).toEqual(["change_setting", "get_settings", "set_default_signature"]);
  });

  it("reads allowlisted settings and signature names only", async () => {
    const r = (await run("get_settings", {})).content as { settings: Record<string, unknown>; signatureDefaults: unknown[] };
    expect(r.settings.theme).toBe("system");
    expect(r.settings).not.toHaveProperty("apiKey");
    expect(r.signatureDefaults[0]).toEqual({ account: "a@x.com", new: "Casual", reply: null });
  });

  it("rejects unknown keys and bad values", async () => {
    expect((await run("change_setting", { key: "apiKey", value: "x" })).malformed).toBe(true);
    expect((await run("change_setting", { key: "theme", value: "neon" })).malformed).toBe(true);
    expect((await run("change_setting", { key: "suggestThreshold", value: 2 })).malformed).toBe(true);
    expect((await run("change_setting", { key: "peoplePhotos", value: "yes" })).malformed).toBe(true);
    expect(s.theme).toBe("system");
  });

  it("changes a setting and undo restores it", async () => {
    await run("change_setting", { key: "theme", value: "dark" });
    expect(s.theme).toBe("dark");
    expect(toasts[0].text).toBe("Changed theme");
    toasts[0].undo!();
    expect(s.theme).toBe("system");
  });

  it("enables Mac Contacts through the permission flow", async () => {
    mac.enableMacContacts.mockResolvedValueOnce("denied");
    await run("change_setting", { key: "macContactsPhotos", value: true });
    expect(s.macContactsPhotos).toBe(false);
    mac.enableMacContacts.mockResolvedValueOnce("granted");
    const r = await run("change_setting", { key: "macContactsPhotos", value: true });
    expect(s.macContactsPhotos).toBe(true);
    expect((r.content as { result: string }).result).toBe("granted");
    toasts[0].undo!();
    expect(s.macContactsPhotos).toBe(false);
    await run("change_setting", { key: "macContactsPhotos", value: false });
    expect(mac.enableMacContacts).toHaveBeenCalledTimes(2);
  });

  it("sets a default signature by name for all accounts, with undo", async () => {
    await run("set_default_signature", { which: "new", signature: "work" });
    expect(defs.a1.new).toBe("s1");
    expect(defs.a2.new).toBe("s1");
    toasts[0].undo!();
    expect(defs.a1.new).toBe("s2");
    expect(defs.a2.new).toBeNull();
  });

  it("targets one account, supports none, rejects unknown names", async () => {
    await run("set_default_signature", { account: "b@x.com", which: "reply", signature: "Casual" });
    expect(defs.a2.reply).toBe("s2");
    expect(defs.a1.reply).toBeNull();
    await run("set_default_signature", { which: "new", signature: "none" });
    expect(defs.a1.new).toBeNull();
    expect((await run("set_default_signature", { which: "new", signature: "Nope" })).malformed).toBe(true);
    expect((await run("set_default_signature", { account: "z@x.com", which: "new", signature: "Work" })).malformed).toBe(true);
  });
});
