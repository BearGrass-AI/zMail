import { describe, expect, it } from "vitest";
import type { AiProvider } from "@/lib/settings";
import { bestToolModel, currentChoiceKey, modelChoices, modelDisplayName, type ModelChoice } from "@/lib/ai/assistant/model-choices";

const prov = (p: Partial<AiProvider> = {}): AiProvider => ({ id: "p", group: "llm", type: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", models: [], enabledModels: [], apiKey: "", ...p });

describe("modelDisplayName", () => {
  it("names a path id by its last part and capitalizes two-letter words", () => {
    expect(modelDisplayName("ollama", { id: "hf.co/jialinyyzz/humanizer:BF16" })).toBe("Humanizer");
    expect(modelDisplayName("ollama", { id: "qwen3-vl:8b" })).toBe("Qwen 3 VL");
  });
  it("uses a label when present", () => {
    expect(modelDisplayName("anthropic", { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" })).toBe("Claude Sonnet 5.5");
  });
  it("names Anthropic ids", () => {
    expect(modelDisplayName("anthropic", { id: "claude-sonnet-5-5" })).toBe("Claude Sonnet 5.5");
    expect(modelDisplayName("anthropic", { id: "claude-haiku-4-5-20251001" })).toBe("Claude Haiku 4.5");
  });
  it("names OpenAI ids", () => {
    expect(modelDisplayName("openai", { id: "gpt-5.1" })).toBe("GPT-5.1");
    expect(modelDisplayName("openai", { id: "o4-mini" })).toBe("o4-mini");
  });
  it("names Ollama and custom ids", () => {
    expect(modelDisplayName("ollama", { id: "qwen3.8:latest" })).toBe("Qwen 3.8");
    expect(modelDisplayName("ollama", { id: "llama3.1:8b" })).toBe("Llama 3.1");
    expect(modelDisplayName("ollama", { id: "gpt-oss:20b" })).toBe("GPT OSS");
    expect(modelDisplayName("custom", { id: "mistral-small3.2" })).toBe("Mistral Small 3.2");
  });
  it("names Gemini, xAI and Perplexity ids", () => {
    expect(modelDisplayName("gemini", { id: "gemini-2.5-pro" })).toBe("Gemini 2.5 Pro");
    expect(modelDisplayName("gemini", { id: "gemini-2.5-flash-lite" })).toBe("Gemini 2.5 Flash Lite");
    expect(modelDisplayName("xai", { id: "grok-4" })).toBe("Grok 4");
    expect(modelDisplayName("xai", { id: "grok-4-fast" })).toBe("Grok 4 Fast");
    expect(modelDisplayName("perplexity", { id: "sonar-pro" })).toBe("Sonar Pro");
    expect(modelDisplayName("perplexity", { id: "sonar-reasoning-pro" })).toBe("Sonar Reasoning Pro");
  });
});

describe("modelChoices", () => {
  it("lists enabled models of LLM providers, grouped by provider name", () => {
    const c = modelChoices({
      aiProviders: [
        prov({ id: "o", type: "ollama", name: "Ollama", models: [{ id: "qwen3.8" }, { id: "llama3.1" }], enabledModels: ["qwen3.8"] }),
        prov({ id: "j", group: "decision", type: "jev", name: "Jev API", enabledModels: ["jev-1"] }),
        prov({ id: "a", type: "anthropic", name: "Work Claude", models: [{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }], enabledModels: ["claude-sonnet-5-5"] }),
      ],
    });
    expect(c.map((x) => [x.key, x.group, x.model, x.name, x.provider])).toEqual([
      ["o|qwen3.8", "Ollama", "qwen3.8", "Qwen 3.8", "ollama"],
      ["a|claude-sonnet-5-5", "Work Claude", "claude-sonnet-5-5", "Claude Sonnet 5.5", "anthropic"],
    ]);
  });
  it("numbers duplicate provider names", () => {
    const c = modelChoices({
      aiProviders: [prov({ id: "1", name: "Ollama", enabledModels: ["m1"] }), prov({ id: "2", name: "Ollama", enabledModels: ["m2"] })],
    });
    expect(c.map((x) => x.group)).toEqual(["Ollama", "Ollama 2"]);
  });
  it("skips decision-tagged models and duplicates", () => {
    const c = modelChoices({ aiProviders: [prov({ id: "o", models: [{ id: "clef", tag: "decision" }], enabledModels: ["clef", "m", "m"] })] });
    expect(c.map((x) => x.model)).toEqual(["m"]);
  });
  it("is empty without providers", () => {
    expect(modelChoices({ aiProviders: [] })).toEqual([]);
  });
});

describe("currentChoiceKey", () => {
  const aiProviders = [prov({ id: "o", enabledModels: ["m"] }), prov({ id: "x", type: "openai", enabledModels: ["gpt-5.1"] })];
  it("prefers the assistant role", () => {
    expect(currentChoiceKey({ aiProviders, aiRoles: { assistant: { providerId: "o", model: "m" }, writing: { providerId: "x", model: "gpt-5.1" }, sorting: null } })).toBe("o|m");
  });
  it("falls back to the writing role", () => {
    expect(currentChoiceKey({ aiProviders, aiRoles: { assistant: null, writing: { providerId: "x", model: "gpt-5.1" }, sorting: null } })).toBe("x|gpt-5.1");
  });
  it("is null when neither resolves", () => {
    expect(currentChoiceKey({ aiProviders, aiRoles: { assistant: { providerId: "gone", model: "m" }, writing: null, sorting: null } })).toBeNull();
  });
});

describe("bestToolModel", () => {
  const c = (provider: ModelChoice["provider"], model: string): ModelChoice => ({ key: `${provider}|${model}`, providerId: provider, provider, model, name: model, group: "g" });
  const opus = c("anthropic", "claude-opus-5");
  const sonnet = c("anthropic", "claude-sonnet-5-5");
  const haiku = c("anthropic", "claude-haiku-5");
  const local = c("ollama", "qwen3.8");
  it("prefers a model known to work", () => {
    expect(bestToolModel([opus, local], { [local.key]: "ok" }, null)).toBe(local);
  });
  it("never returns the current or a struggled model", () => {
    expect(bestToolModel([opus, sonnet, haiku], { [sonnet.key]: "struggled" }, opus.key)).toBe(haiku);
  });
  it("prefers Opus over Sonnet over Haiku", () => {
    expect(bestToolModel([haiku, sonnet, opus], {}, null)).toBe(opus);
    expect(bestToolModel([haiku, sonnet], {}, null)).toBe(sonnet);
  });
  it("returns null when nothing qualifies", () => {
    expect(bestToolModel([opus], {}, opus.key)).toBeNull();
    expect(bestToolModel([local], { [local.key]: "struggled" }, null)).toBeNull();
    expect(bestToolModel([], {}, null)).toBeNull();
  });
});
