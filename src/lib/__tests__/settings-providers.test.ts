// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const vault = new Map<string, string>();
const deleted: string[] = [];
vi.mock("@/lib/secrets", () => ({
  getSecret: async (name: string) => vault.get(name) ?? null,
  setSecret: async (name: string, value: string) => void vault.set(name, value),
  deleteSecret: async (name: string) => {
    deleted.push(name);
    vault.delete(name);
  },
}));

const { useSettings, migrateSettings, hydrateApiKeys, providerKeyName } = await import("@/lib/settings");
import type { AiProvider } from "@/lib/settings";

const mock = { provider: "mock", baseUrl: "", model: "", apiKey: "", models: [] };
const ep = (provider: string, baseUrl: string, model: string, models: { id: string }[] = []) => ({ provider, baseUrl, model, apiKey: "", models });

type Migrated = { aiProviders: AiProvider[]; aiRoles: Record<string, { providerId: string; model: string } | null>; legacyKeys?: Record<string, string> };
const migrate = (v1: Record<string, unknown>) => migrateSettings({ theme: "dark", suggestThreshold: 0.8, ...v1 }, 1) as unknown as Migrated & Record<string, unknown>;

beforeEach(() => {
  vault.clear();
  deleted.length = 0;
  useSettings.setState({ aiProviders: [], aiRoles: { assistant: null, writing: null, sorting: null }, legacyKeys: undefined });
});

describe("v1 → v2 migration", () => {
  it("all mock → no providers, no roles, other keys kept", () => {
    const st = migrate({ decision: mock, generative: mock, assistant: mock, assistantPick: null });
    expect(st.aiProviders).toEqual([]);
    expect(st.aiRoles).toEqual({ assistant: null, writing: null, sorting: null });
    expect(st.legacyKeys).toBeUndefined();
    expect(st.theme).toBe("dark");
    expect(st.suggestThreshold).toBe(0.8);
    for (const k of ["decision", "generative", "assistant", "assistantPick"]) expect(st).not.toHaveProperty(k);
  });

  it("Anthropic writing + Ollama assistant + Jev decision → three providers with the right roles", () => {
    const st = migrate({
      decision: ep("jev", "https://api.typesafe.ai", "jev-1", [{ id: "jev-1" }]),
      generative: ep("anthropic", "https://api.anthropic.com", "claude-sonnet-5-5", [{ id: "claude-sonnet-5-5" }, { id: "claude-opus-5" }]),
      assistant: ep("ollama", "http://localhost:11434", "qwen3.8"),
      assistantPick: null,
    });
    expect(st.aiProviders.map((p) => [p.group, p.type, p.name, p.enabledModels])).toEqual([
      ["decision", "jev", "Jev API", ["jev-1"]],
      ["llm", "anthropic", "Anthropic", ["claude-sonnet-5-5"]],
      ["llm", "ollama", "Ollama", ["qwen3.8"]],
    ]);
    const [jev, claude, ollama] = st.aiProviders;
    expect(claude.models.map((m) => m.id)).toEqual(["claude-sonnet-5-5", "claude-opus-5"]);
    expect(st.aiRoles).toEqual({
      sorting: { providerId: jev.id, model: "jev-1" },
      writing: { providerId: claude.id, model: "claude-sonnet-5-5" },
      assistant: { providerId: ollama.id, model: "qwen3.8" },
    });
    expect(st.legacyKeys).toEqual({ [jev.id]: "decision", [claude.id]: "generative", [ollama.id]: "assistant" });
  });

  it("the same Ollama for writing and assistant → one provider, two enabled models", () => {
    const st = migrate({
      decision: mock,
      generative: ep("ollama", "http://localhost:11434", "qwen3.8"),
      assistant: ep("ollama", "http://localhost:11434/", "gpt-oss:20b"),
      assistantPick: null,
    });
    expect(st.aiProviders).toHaveLength(1);
    const [p] = st.aiProviders;
    expect(p.enabledModels).toEqual(["qwen3.8", "gpt-oss:20b"]);
    expect(st.aiRoles.writing).toEqual({ providerId: p.id, model: "qwen3.8" });
    expect(st.aiRoles.assistant).toEqual({ providerId: p.id, model: "gpt-oss:20b" });
  });

  it("Ollama for sorting and writing stays two providers (different groups)", () => {
    const st = migrate({ decision: ep("ollama", "http://localhost:11434", "clef"), generative: ep("ollama", "http://localhost:11434", "qwen3.8"), assistant: mock });
    expect(st.aiProviders.map((p) => p.group)).toEqual(["decision", "llm"]);
  });

  it("assistantPick → assistant role on the writing provider", () => {
    const st = migrate({
      decision: mock,
      generative: ep("anthropic", "https://api.anthropic.com", "claude-sonnet-5-5"),
      assistant: ep("ollama", "http://localhost:11434", "qwen3.8"),
      assistantPick: { source: "generative", model: "claude-opus-5" },
    });
    const claude = st.aiProviders.find((p) => p.type === "anthropic")!;
    expect(claude.enabledModels).toEqual(["claude-sonnet-5-5", "claude-opus-5"]);
    expect(st.aiRoles.assistant).toEqual({ providerId: claude.id, model: "claude-opus-5" });
  });

  it("custom writing → OpenAI-compatible LLM; a provider without a model keeps its endpoint but no role", () => {
    const st = migrate({ decision: ep("custom", "http://localhost:9000", ""), generative: ep("custom", "http://localhost:8000", "m"), assistant: mock });
    expect(st.aiProviders.map((p) => [p.group, p.type, p.name, p.baseUrl])).toEqual([
      ["decision", "custom", "Custom (SystemOne)", "http://localhost:9000"],
      ["llm", "custom", "OpenAI-compatible", "http://localhost:8000"],
    ]);
    expect(st.aiRoles.sorting).toBeNull();
  });

  it("v0 state migrates through to providers", () => {
    const st = migrateSettings({ decision: { mode: "http", url: "http://localhost:9000/v1/systemone", model: "clef" }, generative: { mode: "mock" } }, 0) as unknown as Migrated;
    expect(st.aiProviders.map((p) => [p.group, p.type, p.baseUrl])).toEqual([["decision", "custom", "http://localhost:9000"]]);
    expect(st.aiRoles.sorting?.model).toBe("clef");
  });
});

describe("persisting", () => {
  it("partialize strips every provider key", () => {
    const id = useSettings.getState().addProvider({ group: "llm", type: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", models: [], enabledModels: [], apiKey: "sk-secret" });
    useSettings.getState().setRole("writing", { providerId: id, model: "gpt-5.1" });
    const saved = localStorage.getItem("zmail.settings") ?? "";
    expect(saved).toContain('"aiProviders"');
    expect(saved).not.toContain("sk-secret");
    expect(saved).toContain('"version":2');
  });
});

describe("hydrateApiKeys", () => {
  const p = (id: string, apiKey = ""): AiProvider => ({ id, group: "llm", type: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", models: [], enabledModels: [], apiKey });

  it("copies a legacy slot key to the provider's key once, then drops the map", async () => {
    vault.set("apikey.generative", "old-key");
    useSettings.setState({ aiProviders: [p("a")], legacyKeys: { a: "generative" } });
    await hydrateApiKeys();
    expect(useSettings.getState().aiProviders[0].apiKey).toBe("old-key");
    expect(vault.get(providerKeyName("a"))).toBe("old-key");
    expect(useSettings.getState().legacyKeys).toBeUndefined();

    // A second launch reads the new key only.
    vault.set("apikey.generative", "changed");
    useSettings.setState({ aiProviders: [p("a")] });
    await hydrateApiKeys();
    expect(useSettings.getState().aiProviders[0].apiKey).toBe("old-key");
  });

  it("prefers the provider's own key over the legacy one", async () => {
    vault.set("apikey.assistant", "old");
    vault.set(providerKeyName("a"), "new");
    useSettings.setState({ aiProviders: [p("a")], legacyKeys: { a: "assistant" } });
    await hydrateApiKeys();
    expect(useSettings.getState().aiProviders[0].apiKey).toBe("new");
  });

  it("leaves providers without any key empty", async () => {
    useSettings.setState({ aiProviders: [p("a")] });
    await hydrateApiKeys();
    expect(useSettings.getState().aiProviders[0].apiKey).toBe("");
    expect(vault.size).toBe(0);
  });
});

describe("provider actions", () => {
  it("add, update and remove keep roles and the Keychain in step", async () => {
    vi.useFakeTimers();
    try {
      const s = () => useSettings.getState();
      const id = s().addProvider({ group: "llm", type: "xai", name: "xAI", baseUrl: "https://api.x.ai", models: [{ id: "grok-4" }], enabledModels: ["grok-4"], apiKey: "xk" });
      s().setRole("assistant", { providerId: id, model: "grok-4" });
      s().updateProvider(id, { name: "Grok", apiKey: "xk2" });
      await vi.advanceTimersByTimeAsync(500);
      expect(vault.get(providerKeyName(id))).toBe("xk2");
      expect(s().aiProviders[0].name).toBe("Grok");
      expect(s().aiRoles.assistant).toEqual({ providerId: id, model: "grok-4" });
      s().removeProvider(id);
      await vi.advanceTimersByTimeAsync(0);
      expect(s().aiProviders).toEqual([]);
      expect(s().aiRoles.assistant).toBeNull();
      expect(deleted).toContain(providerKeyName(id));
    } finally {
      vi.useRealTimers();
    }
  });
});
