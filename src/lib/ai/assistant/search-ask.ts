// What the ✦ button in the sidebar search box does, given the box and the assistant's state.
export type SearchAskAction = "toggle" | "ask" | "open";

export function searchAskAction({ text, busy }: { text: string; busy: boolean }): SearchAskAction {
  if (!text.trim()) return "toggle";
  return busy ? "open" : "ask";
}
