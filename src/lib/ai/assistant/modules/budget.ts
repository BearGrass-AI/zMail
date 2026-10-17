// The per-message budget for changes made without a confirm card, shared by every module.
import { DIRECT_LIMIT } from "@/lib/mail/bulk";
import { useAssistant } from "../state";

/** Reserve n emails from this user message's direct-action budget (DIRECT_LIMIT); false = use a confirm card instead. */
export function takeDirect(n: number): boolean {
  if (useAssistant.getState().directThisTurn + n > DIRECT_LIMIT) return false;
  useAssistant.setState((s) => ({ directThisTurn: s.directThisTurn + n }));
  return true;
}
