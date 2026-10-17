// src/lib/ai/assistant/steps.ts
// Render-time grouping of consecutive step lines (stored items are unchanged).

import type { Item } from "./state";

export type StepGroup = { kind: "steps"; id: string; label: string; items: Item[] };

type Step = Extract<Item, { kind: "step" }>;

const isRead = (text: string) => text.startsWith("Read “");
/** Steps with the same key belong to one sub-run: all read_email steps, or identical text. */
const keyOf = (s: Step) => (isRead(s.text) ? "\0read" : s.text);

/** Collapse maximal sub-runs (2+) of consecutive read_email steps or identical step text. */
export function groupSteps(items: Item[]): Array<Item | StepGroup> {
  const out: Array<Item | StepGroup> = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.kind !== "step") {
      out.push(it);
      i++;
      continue;
    }
    const key = keyOf(it);
    let j = i + 1;
    while (j < items.length) {
      const n = items[j];
      if (n.kind !== "step" || keyOf(n) !== key) break;
      j++;
    }
    const run = items.slice(i, j) as Step[];
    if (run.length >= 2) {
      const label = isRead(it.text) ? `Read ${run.length} emails` : `${it.text} ×${run.length}`;
      out.push({ kind: "steps", id: it.id, label, items: run });
    } else out.push(it);
    i = j;
  }
  return out;
}
