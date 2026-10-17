// Resolves the sorting / writing / assistant models from the providers and roles in settings.

import { resolveAssistant, resolveRef, useSettings, type ResolvedModel } from "@/lib/settings";
import { HttpDecisionProvider, type DecisionProvider } from "./decision";
import { HttpGenerativeProvider, type GenerativeProvider } from "./generative";
import { MockDecisionProvider } from "./mock-decision";
import { MockGenerativeProvider } from "./mock-generative";
import { providerType, type LlmTypeId } from "./catalog";

export function decisionProvider(): DecisionProvider {
  const s = useSettings.getState();
  const r = resolveRef(s, s.aiRoles.sorting, "decision");
  if (!r) return new MockDecisionProvider();
  return new HttpDecisionProvider({
    baseUrl: r.provider.baseUrl,
    model: r.model,
    apiKey: r.provider.apiKey,
    maxChoiceOptions: providerType("decision", r.provider.type)?.maxChoiceOptions,
  });
}

function httpWriter({ provider, model }: ResolvedModel) {
  return new HttpGenerativeProvider({ provider: provider.type as LlmTypeId, baseUrl: provider.baseUrl, model, apiKey: provider.apiKey });
}

export function generativeProvider(): GenerativeProvider {
  const s = useSettings.getState();
  const r = resolveRef(s, s.aiRoles.writing, "llm");
  return r ? httpWriter(r) : new MockGenerativeProvider();
}

/** The assistant's model: its own role, else the writing model, else the offline mock. */
export function assistantProvider(): GenerativeProvider {
  const r = resolveAssistant(useSettings.getState());
  return r ? httpWriter(r) : new MockGenerativeProvider();
}

export function assistantIsOffline() {
  return !resolveAssistant(useSettings.getState());
}

export function assistantModelName() {
  return resolveAssistant(useSettings.getState())?.model ?? "Offline demo";
}
