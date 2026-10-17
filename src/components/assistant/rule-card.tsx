// src/components/assistant/rule-card.tsx
// The assistant's proposed automatic rule. Nothing is saved until Save rule.
import { toast } from "sonner";
import type { Card } from "@/lib/ai/assistant/state";
import { useAssistant } from "@/lib/ai/assistant/state";
import { realDeps } from "@/lib/ai/assistant/deps";
import type { ToolDeps } from "@/lib/ai/assistant/tools";
import { describeRule } from "@/lib/rules";
import { cn } from "@/lib/utils";

type RuleCardData = Extract<Card, { type: "rule" }>;
const btn = "h-7 rounded-lg px-2.5 text-[12px] font-semibold whitespace-nowrap";

function liveRuleCard(id: string): RuleCardData | undefined {
  const item = useAssistant.getState().items.find((i) => i.id === id);
  return item?.kind === "card" && item.card.type === "rule" ? item.card : undefined;
}

/** The card's rule in words: "Trash new mail from amazon.com". */
export function ruleText(card: RuleCardData): string {
  return describeRule({ id: "", match: { from: card.from, subjectAny: card.subjectAny }, action: card.action, createdAt: "", enabled: true, hits: 0 }, () => card.folderName);
}

/** Reads the live card, not the rendered prop, so a double click can't save twice. */
export function saveRule(id: string, deps: Pick<ToolDeps, "addRule" | "laneMatches"> = realDeps()) {
  const card = liveRuleCard(id);
  if (card?.status !== "pending") return;
  try {
    const ruleId = deps.addRule({ from: card.from, subjectAny: card.subjectAny, action: card.action });
    const isLane = typeof card.action === "object" && "lane" in card.action;
    const moved = isLane ? deps.laneMatches?.(ruleId) : undefined;
    useAssistant.getState().patchCard(id, { status: "saved", ruleId, ...(moved !== undefined ? { moved } : {}) });
    useAssistant.getState().note(`Rule saved: ${ruleText(card)}`);
    toast("Rule saved");
  } catch (err) {
    toast(err instanceof Error ? err.message : "Couldn't save the rule");
  }
}

export function dismissRule(id: string) {
  const card = liveRuleCard(id);
  if (card?.status !== "pending") return;
  useAssistant.getState().patchCard(id, { status: "dismissed" });
  useAssistant.getState().note(`User declined the automatic rule for ${card.from}`);
}

export function RuleCard({ id, card }: { id: string; card: RuleCardData }) {
  const text = ruleText(card);
  return (
    <div className="rounded-xl bg-pane-2 p-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
      <div className="selectable text-[13px] font-semibold">Automatic rule</div>
      <div className="selectable mt-0.5 text-[11.5px] text-foreground/50">{text}{card.accountLabel ? ` (${card.accountLabel})` : ""}</div>
      {card.status === "pending" && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button onClick={() => saveRule(id)} className={cn(btn, "bg-primary text-primary-foreground")}>
            Save rule
          </button>
          <button onClick={() => dismissRule(id)} className={cn(btn, "text-foreground/55 hover:bg-foreground/[0.07]")}>
            No thanks
          </button>
        </div>
      )}
      {card.status === "saved" && <div className="mt-1.5 text-[11.5px] text-foreground/55">✓ Saved{card.moved !== undefined ? ` · ${card.moved.toLocaleString()} ${card.moved === 1 ? "email" : "emails"} in your inbox ${card.moved === 1 ? "is" : "are"} now in this lane` : ""} · Manage in Settings → Sorting & Rules</div>}
      {card.status === "dismissed" && <div className="mt-1.5 text-[11.5px] text-foreground/55">Not saved</div>}
    </div>
  );
}
