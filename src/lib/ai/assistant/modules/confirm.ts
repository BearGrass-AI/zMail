// src/lib/ai/assistant/modules/confirm.ts
// The generic confirm card: a module pushes one for an action that needs the
// user's OK, and its button runs the module's named confirm action.

import { useAssistant, type Card } from "../state";
import type { ToolDeps } from "../tools";
import { realDeps } from "../deps";
import { MODULES } from "./index";
import type { ToolModule } from "./types";

export type ConfirmCardData = Extract<Card, { type: "confirm" }>;

/** Pushes a pending confirm card; returns its item id. */
export function pushConfirmCard(card: Omit<ConfirmCardData, "type" | "status">): string {
  return useAssistant.getState().push({ kind: "card", card: { ...card, type: "confirm", status: "pending" } });
}

function liveCard(itemId: string): ConfirmCardData | undefined {
  const item = useAssistant.getState().items.find((i) => i.id === itemId);
  return item?.kind === "card" && item.card.type === "confirm" ? item.card : undefined;
}

/** Queues an outcome note for the model, unless the card's chat was cleared meanwhile. */
function noter(itemId: string): (text: string) => void {
  const chat = useAssistant.getState().chatId;
  return (text) => {
    if (useAssistant.getState().chatId === chat && liveCard(itemId)) useAssistant.getState().note(text);
  };
}

/** Runs the card's action once. Reads the live card, so a double click can't run it twice; a failed card can be retried. */
export async function runConfirm(itemId: string, deps?: ToolDeps, modules: ToolModule[] = MODULES): Promise<void> {
  const card = liveCard(itemId);
  if (!card || (card.status !== "pending" && card.status !== "failed")) return;
  const st = useAssistant.getState();
  // The model last saw "awaiting confirmation", so it hears how this turned out.
  const note = noter(itemId);
  const action = modules.find((m) => m.id === card.module)?.confirm?.[card.action];
  if (!action) {
    st.patchCard(itemId, { status: "failed", error: "This action is no longer available." });
    note(`The user confirmed "${card.title}" but it failed: this action is no longer available.`);
    return;
  }
  st.patchCard(itemId, { status: "running", error: undefined });
  try {
    const result = await action(card.payload, deps ?? realDeps());
    useAssistant.getState().patchCard(itemId, { status: "done", result });
    note(`The user confirmed "${card.title}": ${result}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useAssistant.getState().patchCard(itemId, { status: "failed", error: message });
    note(`The user confirmed "${card.title}" but it failed: ${message}`);
  }
}

export function dismissConfirm(itemId: string) {
  const card = liveCard(itemId);
  if (card?.status !== "pending" && card?.status !== "failed") return;
  useAssistant.getState().patchCard(itemId, { status: "dismissed" });
  useAssistant.getState().note(`The user dismissed "${card.title}". Nothing was done.`);
}

/** Runs the still-pending cards among itemIds, one after another. */
export async function confirmAll(itemIds: string[], deps?: ToolDeps, modules: ToolModule[] = MODULES): Promise<void> {
  for (const id of itemIds) {
    if (liveCard(id)?.status === "pending") await runConfirm(id, deps, modules);
  }
}
