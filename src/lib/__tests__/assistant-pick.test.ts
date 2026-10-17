import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/secrets", () => ({ getSecret: async () => "", setSecret: async () => {}, deleteSecret: async () => {} }));
const { useSettings } = await import("@/lib/settings");
const { assistantIsOffline, assistantModelName } = await import("@/lib/ai/providers");
const { currentChoiceKey, modelChoices } = await import("@/lib/ai/assistant/model-choices");
const { pickModel } = await import("@/components/assistant/model-picker");
import type { AiProvider } from "@/lib/settings";

const ollama: AiProvider = { id: "o", group: "llm", type: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", apiKey: "", models: [{ id: "qwen3.8" }], enabledModels: ["qwen3.8"] };
const claude: AiProvider = {
  id: "c",
  group: "llm",
  type: "anthropic",
  name: "Anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "k",
  models: [{ id: "claude-sonnet-5-5" }, { id: "claude-opus-5" }],
  enabledModels: ["claude-sonnet-5-5", "claude-opus-5"],
};

beforeEach(() =>
  useSettings.setState({ aiProviders: [ollama, claude], aiRoles: { assistant: { providerId: "o", model: "qwen3.8" }, writing: { providerId: "c", model: "claude-sonnet-5-5" }, sorting: null } }),
);

describe("assistant pick", () => {
  it("picking sets the Assistant role and leaves writing alone", () => {
    const opus = modelChoices(useSettings.getState()).find((c) => c.model === "claude-opus-5")!;
    pickModel(opus);
    const s = useSettings.getState();
    expect(s.aiRoles.assistant).toEqual({ providerId: "c", model: "claude-opus-5" });
    expect(s.aiRoles.writing).toEqual({ providerId: "c", model: "claude-sonnet-5-5" });
    expect(new Set(modelChoices(s).map((c) => c.group))).toEqual(new Set(["Ollama", "Anthropic"]));
  });

  it("currentChoiceKey follows the Assistant role, else writing", () => {
    expect(currentChoiceKey(useSettings.getState())).toBe("o|qwen3.8");
    useSettings.getState().setRole("assistant", null);
    expect(currentChoiceKey(useSettings.getState())).toBe("c|claude-sonnet-5-5");
    useSettings.getState().setRole("writing", null);
    expect(currentChoiceKey(useSettings.getState())).toBeNull();
  });

  it("removing a provider clears its roles", () => {
    useSettings.getState().removeProvider("o");
    expect(useSettings.getState().aiRoles.assistant).toBeNull();
    expect(currentChoiceKey(useSettings.getState())).toBe("c|claude-sonnet-5-5");
  });

  it("switching a model off clears a role that used it", () => {
    useSettings.getState().updateProvider("c", { enabledModels: ["claude-opus-5"] });
    expect(useSettings.getState().aiRoles.writing).toBeNull();
    expect(useSettings.getState().aiRoles.assistant).toEqual({ providerId: "o", model: "qwen3.8" });
  });

  it("providers honor the pick", () => {
    expect(assistantModelName()).toBe("qwen3.8");
    pickModel(modelChoices(useSettings.getState()).find((c) => c.model === "claude-opus-5")!);
    expect(assistantModelName()).toBe("claude-opus-5");
    expect(assistantIsOffline()).toBe(false);
  });
});
