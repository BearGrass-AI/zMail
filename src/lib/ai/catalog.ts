// Provider types for both groups (LLMs for chat and writing, decision models for
// sorting), plus model discovery. Each type knows its default base URL, whether
// it needs a key, where its OpenAI-style API lives, and how to list models.
//
// AWS Bedrock and Groq (offered in zedQ) are left out: Bedrock needs AWS
// request signing, which zMail's plain-HTTP transport doesn't do.

import { normalizeBase, request } from "@/lib/transport";

export type ProviderGroup = "llm" | "decision";
export type LlmTypeId = "ollama" | "vllm" | "openai" | "anthropic" | "gemini" | "xai" | "perplexity" | "openrouter" | "custom";
export type DecisionTypeId = "jev" | "ollama" | "custom";
export type ProviderTypeId = LlmTypeId | DecisionTypeId;

export interface ProviderType {
  group: ProviderGroup;
  id: ProviderTypeId;
  label: string;
  hint: string;
  /** Default endpoint; empty means the user enters one. */
  baseUrl: string;
  key: "required" | "optional" | "none";
  /** Max options per decision `choice` question (decision types only). */
  maxChoiceOptions?: number;
}

export interface ModelInfo {
  id: string;
  label?: string;
  /** e.g. "decision" for Ollama decision models. */
  tag?: string;
}

export const ANTHROPIC_VERSION = "2023-06-01";

export const PROVIDER_TYPES: ProviderType[] = [
  { group: "llm", id: "ollama", label: "Ollama", hint: "Local models on this Mac or another machine you run.", baseUrl: "http://localhost:11434", key: "none" },
  { group: "llm", id: "vllm", label: "vLLM", hint: "A vLLM server's OpenAI-compatible API.", baseUrl: "", key: "optional" },
  { group: "llm", id: "openai", label: "OpenAI", hint: "Chat Completions API.", baseUrl: "https://api.openai.com", key: "required" },
  { group: "llm", id: "anthropic", label: "Anthropic", hint: "Claude via the Messages API.", baseUrl: "https://api.anthropic.com", key: "required" },
  { group: "llm", id: "gemini", label: "Google Gemini", hint: "Gemini via Google's OpenAI-compatible API.", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", key: "required" },
  { group: "llm", id: "xai", label: "xAI", hint: "Grok models.", baseUrl: "https://api.x.ai", key: "required" },
  { group: "llm", id: "perplexity", label: "Perplexity", hint: "Sonar models with web search.", baseUrl: "https://api.perplexity.ai", key: "required" },
  { group: "llm", id: "openrouter", label: "OpenRouter", hint: "Many providers' models behind one key.", baseUrl: "https://openrouter.ai/api", key: "required" },
  { group: "llm", id: "custom", label: "OpenAI-compatible", hint: "Any server with /v1/models and /v1/chat/completions — e.g. LM Studio, LiteLLM.", baseUrl: "", key: "optional" },
  { group: "decision", id: "jev", label: "Jev API", hint: "TypeSafe's hosted decision model (POST /v1/systemone).", baseUrl: "https://api.typesafe.ai", key: "required", maxChoiceOptions: 255 },
  { group: "decision", id: "ollama", label: "Ollama", hint: "Local decision models (Clef, Clef Flash, Nimble) via /v1/systemone. Ollama 0.35+.", baseUrl: "http://localhost:11434", key: "none", maxChoiceOptions: 26 },
  { group: "decision", id: "custom", label: "Custom (SystemOne)", hint: "Any Jev-compatible server with /v1/systemone and /v1/models — e.g. Clef served by vLLM or SGLang.", baseUrl: "", key: "optional", maxChoiceOptions: 255 },
];

export function providerTypes(group: ProviderGroup): ProviderType[] {
  return PROVIDER_TYPES.filter((t) => t.group === group);
}

export function providerType(group: ProviderGroup, id: string): ProviderType | undefined {
  return PROVIDER_TYPES.find((t) => t.group === group && t.id === id);
}

/** Fixed model list for providers without a usable list endpoint. */
const PERPLEXITY_MODELS = ["sonar", "sonar-pro", "sonar-reasoning", "sonar-reasoning-pro"];

/**
 * The URL that `/chat/completions`, `/messages` and `/models` are appended to:
 * `<base>/v1` for most, the base itself for Gemini and Perplexity.
 */
export function apiBase(type: ProviderTypeId, baseUrl: string): string {
  const base = normalizeBase(baseUrl);
  return type === "gemini" || type === "perplexity" ? base : `${base}/v1`;
}

/** Known Ollama decision models (Ollama's decision capability, v0.35+). */
const OLLAMA_DECISION = /^(clef|clef-flash|nimble|tev1)(:|$)/;

function bearer(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Pull `data[].id`-style lists from OpenAI-like or loosely shaped /v1/models responses. */
function parseModelList(json: unknown, withNames = false): ModelInfo[] {
  const j = json as Record<string, unknown>;
  const arr = (Array.isArray(json) ? json : (j.data ?? j.models ?? [])) as unknown[];
  return arr
    .map((m): ModelInfo => {
      if (typeof m === "string") return { id: m };
      const r = m as Record<string, unknown>;
      const id = String(r.id ?? r.name ?? "");
      const name = typeof r.name === "string" && r.name !== id ? r.name : undefined;
      return withNames && name ? { id, label: name } : { id };
    })
    .filter((m) => m.id);
}

/** The provider's models, each id once (some servers list a model twice). */
export async function listModels(group: ProviderGroup, type: ProviderTypeId, baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  const seen = new Set<string>();
  return (await fetchModels(group, type, baseUrl, apiKey)).filter((m) => !seen.has(m.id) && !!seen.add(m.id));
}

async function fetchModels(group: ProviderGroup, type: ProviderTypeId, baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  const base = normalizeBase(baseUrl);
  if (!base) throw new Error("Enter an endpoint first.");

  if (type === "ollama") {
    const res = await request<{ models: { name: string }[] }>("GET", `${base}/api/tags`);
    const models = res.models.map((m) => ({ id: m.name, tag: OLLAMA_DECISION.test(m.name) ? "decision" : undefined }));
    // Decision group: decision models first; LLM group: hide them.
    return group === "decision" ? models.sort((a, b) => Number(!!b.tag) - Number(!!a.tag)) : models.filter((m) => !m.tag);
  }

  if (group === "decision") {
    // Jev and custom SystemOne servers expose GET /v1/models.
    return parseModelList(await request<unknown>("GET", `${base}/v1/models`, { headers: bearer(apiKey) }));
  }

  const api = apiBase(type, baseUrl);
  switch (type) {
    case "anthropic": {
      const res = await request<{ data: { id: string; display_name?: string }[] }>("GET", `${api}/models?limit=100`, {
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      });
      return res.data.map((m) => ({ id: m.id, label: m.display_name }));
    }
    case "perplexity":
      // No list endpoint worth calling; connecting just saves.
      return PERPLEXITY_MODELS.map((id) => ({ id }));
    case "gemini": {
      const models = parseModelList(await request<unknown>("GET", `${api}/models`, { headers: bearer(apiKey) }));
      return models.map((m) => ({ ...m, id: m.id.replace(/^models\//, "") }));
    }
    case "openai": {
      const models = parseModelList(await request<unknown>("GET", `${api}/models`, { headers: bearer(apiKey) }));
      return models.filter((m) => /^(gpt|o\d|chatgpt)/.test(m.id)).sort((a, b) => b.id.localeCompare(a.id));
    }
    default:
      // vLLM, xAI, OpenRouter and custom OpenAI-compatible servers.
      return parseModelList(await request<unknown>("GET", `${api}/models`, { headers: bearer(apiKey) }), type === "openrouter");
  }
}
