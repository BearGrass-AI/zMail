// src/lib/ai/assistant/modules/types.ts
// One capability of the assistant: its tools, their handlers, prompt lines, and confirm-card actions.
import type { ToolCall, ToolDef } from "@/lib/ai/tool-chat";
import type { ToolDeps } from "../tools";

export type Handler = (args: Record<string, unknown>, deps: ToolDeps, call: ToolCall) => Promise<unknown>;
/** Runs when the user presses Confirm on this module's card; returns the result line shown on the card. */
export type ConfirmAction = (payload: unknown, deps: ToolDeps) => Promise<string>;

export interface ToolModule {
  id: string;
  /** Lines added to the system prompt's rules, each starting with "- ". */
  prompt?: string[];
  tools: ToolDef[];
  handlers: Record<string, Handler>;
  /** Confirm-card actions by name (card.action). */
  confirm?: Record<string, ConfirmAction>;
  /** Builds this module's own dependencies against the real store/providers (deps.ext[id]). */
  realDeps?: () => unknown;
}

/** A module's own dependencies from deps.ext. */
export const extOf = <T>(deps: ToolDeps, id: string) => deps.ext[id] as T;
