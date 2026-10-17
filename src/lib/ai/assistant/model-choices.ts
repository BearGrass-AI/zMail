// The assistant model picker's choices: every model the user enabled on an LLM provider.

import type { LlmTypeId, ModelInfo, ProviderTypeId } from "@/lib/ai/catalog";
import { resolveAssistant, type Settings } from "@/lib/settings";
import type { ModelHealth } from "./model-health";

export interface ModelChoice {
  /** `${providerId}|${model}` */
  key: string;
  providerId: string;
  /** The provider's type (for its logo and API quirks). */
  provider: LlmTypeId;
  /** Model id. */
  model: string;
  /** Friendly name. */
  name: string;
  /** Provider name; duplicates get " 2", " 3". */
  group: string;
}

const title = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);
const UPPER = new Set(["gpt", "oss"]);

/** Title-case hyphen-separated words, splitting a trailing version off a word ("qwen3.8" → "Qwen 3.8"). */
function words(id: string): string {
  const out: string[] = [];
  for (const tok of id.split("-").filter(Boolean)) {
    const m = /^([a-z]+)(\d[\d.]*)$/i.exec(tok);
    const parts = m ? [m[1], m[2]] : [tok];
    // Two-letter words are usually initials ("vl" → "VL").
    for (const p of parts) out.push(UPPER.has(p.toLowerCase()) || /^[a-z]{2}$/i.test(p) ? p.toUpperCase() : title(p));
  }
  return out.join(" ");
}

export function modelDisplayName(provider: ProviderTypeId, m: ModelInfo): string {
  if (m.label) return m.label;
  const id = m.id;
  if (provider === "anthropic") {
    const out: string[] = [];
    for (const t of id.replace(/-\d{8}$/, "").split("-")) {
      if (/^\d+$/.test(t) && out.length && /^\d+(\.\d+)*$/.test(out[out.length - 1])) out[out.length - 1] += `.${t}`;
      else out.push(/^\d+$/.test(t) ? t : title(t));
    }
    return out.join(" ");
  }
  if (provider === "openai") {
    const g = /^gpt-(.+)$/i.exec(id);
    return g ? `GPT-${g[1]}` : id;
  }
  // "hf.co/user/humanizer:BF16" → "Humanizer": the last path part, without the tag.
  return words(id.split(":")[0].split("/").pop() ?? id);
}

export const choiceKey = (providerId: string, model: string) => `${providerId}|${model}`;

export function modelChoices(s: Pick<Settings, "aiProviders">): ModelChoice[] {
  const out: ModelChoice[] = [];
  const nameCount = new Map<string, number>();
  for (const p of s.aiProviders) {
    if (p.group !== "llm") continue;
    const n = (nameCount.get(p.name) ?? 0) + 1;
    nameCount.set(p.name, n);
    const group = n > 1 ? `${p.name} ${n}` : p.name;
    const seen = new Set<string>();
    for (const id of p.enabledModels) {
      if (seen.has(id)) continue;
      seen.add(id);
      const info = p.models.find((m) => m.id === id) ?? { id };
      if (info.tag === "decision") continue;
      out.push({ key: choiceKey(p.id, id), providerId: p.id, provider: p.type as LlmTypeId, model: id, name: modelDisplayName(p.type, info), group });
    }
  }
  return out;
}

/** The key of the model the assistant uses now (its own role, else the writing role), or null when offline. */
export function currentChoiceKey(s: Pick<Settings, "aiProviders" | "aiRoles">): string | null {
  const r = resolveAssistant(s);
  return r ? choiceKey(r.provider.id, r.model) : null;
}

export function bestToolModel(choices: ModelChoice[], health: Record<string, ModelHealth>, currentKey: string | null): ModelChoice | null {
  let best: ModelChoice | null = null;
  let bestScore = -1;
  for (const c of choices) {
    if (c.key === currentKey || health[c.key] === "struggled") continue;
    const id = c.model.toLowerCase();
    const score =
      (health[c.key] === "ok" ? 100 : 0) +
      (c.provider === "anthropic" ? 30 : c.provider === "openai" ? 20 : 0) +
      (id.includes("opus") ? 3 : id.includes("sonnet") ? 2 : id.includes("haiku") ? 1 : 0);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}
