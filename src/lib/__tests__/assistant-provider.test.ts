// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/secrets", () => ({ getSecret: async () => null, setSecret: async () => {}, deleteSecret: async () => {} }));
const { useSettings } = await import("@/lib/settings");
const { assistantIsOffline, assistantModelName, assistantProvider, decisionProvider, generativeProvider } = await import("@/lib/ai/providers");
const { HttpGenerativeProvider } = await import("@/lib/ai/generative");
const { HttpDecisionProvider } = await import("@/lib/ai/decision");
const { MockGenerativeProvider } = await import("@/lib/ai/mock-generative");
const { MockDecisionProvider } = await import("@/lib/ai/mock-decision");
import type { AiProvider } from "@/lib/settings";

const prov = (id: string, p: Partial<AiProvider> = {}): AiProvider => ({
  id,
  group: "llm",
  type: "anthropic",
  name: "Anthropic",
  baseUrl: "https://api.example.com",
  models: [],
  enabledModels: [],
  apiKey: "k",
  ...p,
});

const anthropic = prov("a", { enabledModels: ["claude-sonnet"] });
const ollama = prov("o", { type: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", enabledModels: ["qwen3"], apiKey: "" });
const ollamaDecision = prov("d", { group: "decision", type: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", enabledModels: ["clef"], apiKey: "" });

beforeEach(() => useSettings.setState({ aiProviders: [anthropic, ollama, ollamaDecision], aiRoles: { assistant: null, writing: null, sorting: null } }));

describe("assistant model", () => {
  it("uses its own role when set", () => {
    useSettings.setState({ aiRoles: { assistant: { providerId: "a", model: "claude-sonnet" }, writing: { providerId: "o", model: "qwen3" }, sorting: null } });
    expect(assistantProvider()).toBeInstanceOf(HttpGenerativeProvider);
    expect(assistantModelName()).toBe("claude-sonnet");
    expect(assistantIsOffline()).toBe(false);
  });

  it("falls back to the writing model when unset", () => {
    useSettings.setState({ aiRoles: { assistant: null, writing: { providerId: "o", model: "qwen3" }, sorting: null } });
    expect(assistantProvider().name).toBe("qwen3");
    expect(assistantModelName()).toBe("qwen3");
  });

  it("falls back to the writing model when its provider is gone", () => {
    useSettings.setState({ aiRoles: { assistant: { providerId: "gone", model: "x" }, writing: { providerId: "o", model: "qwen3" }, sorting: null } });
    expect(assistantModelName()).toBe("qwen3");
  });

  it("is the offline mock when neither is set", () => {
    expect(assistantProvider()).toBeInstanceOf(MockGenerativeProvider);
    expect(assistantIsOffline()).toBe(true);
    expect(assistantModelName()).toBe("Offline demo");
  });

  it("never uses a decision provider for writing", () => {
    useSettings.setState({ aiRoles: { assistant: { providerId: "d", model: "clef" }, writing: { providerId: "d", model: "clef" }, sorting: null } });
    expect(generativeProvider()).toBeInstanceOf(MockGenerativeProvider);
    expect(assistantIsOffline()).toBe(true);
  });

  it("never writes a provider key to localStorage", () => {
    useSettings.getState().updateProvider("a", { apiKey: "secret-key" });
    expect(useSettings.getState().aiProviders[0].apiKey).toBe("secret-key");
    expect(localStorage.getItem("zmail.settings") ?? "").not.toContain("secret-key");
  });
});

describe("sorting and writing", () => {
  it("builds the decision provider from the sorting role with the type's option cap", () => {
    expect(decisionProvider()).toBeInstanceOf(MockDecisionProvider);
    useSettings.getState().setRole("sorting", { providerId: "d", model: "clef" });
    const d = decisionProvider();
    expect(d).toBeInstanceOf(HttpDecisionProvider);
    expect(d.name).toBe("clef");
    expect(d.maxChoiceOptions).toBe(26);
  });

  it("ignores an LLM provider in the sorting role", () => {
    useSettings.getState().setRole("sorting", { providerId: "a", model: "claude-sonnet" });
    expect(decisionProvider()).toBeInstanceOf(MockDecisionProvider);
  });

  it("builds the writing provider from the writing role", () => {
    expect(generativeProvider()).toBeInstanceOf(MockGenerativeProvider);
    useSettings.getState().setRole("writing", { providerId: "a", model: "claude-sonnet" });
    expect(generativeProvider().name).toBe("claude-sonnet");
  });

  it("is the mock when the provider has no endpoint", () => {
    useSettings.setState({ aiProviders: [prov("v", { type: "vllm", baseUrl: " " })] });
    useSettings.getState().setRole("writing", { providerId: "v", model: "m" });
    expect(generativeProvider()).toBeInstanceOf(MockGenerativeProvider);
  });
});
