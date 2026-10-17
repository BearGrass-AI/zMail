// src/components/assistant/bulk-card.tsx
import { Loader2 } from "lucide-react";
import { useAssistant, type Card } from "@/lib/ai/assistant/state";
import { automateFromBulk, bulkFollowUp, cancelCard, confirmBulk, dismissFollowUp, resumeBulk, reviewSet, stopBulk, undoBulk, unsubscribeFromBulk } from "@/lib/ai/assistant/cards";
import { cn } from "@/lib/utils";

type Bulk = Extract<Card, { type: "bulk" }>;
const btn = "h-7 rounded-lg px-2.5 text-[12px] font-semibold whitespace-nowrap";

export function BulkCard({ id, card }: { id: string; card: Bulk }) {
  const destructive = card.op.kind === "trash" || card.op.kind === "spam" || card.op.kind === "move";
  const skipped = card.skipped ?? 0;
  const pct = card.total ? Math.round((card.done / card.total) * 100) : 0;
  const sets = useAssistant((s) => s.sets);
  const items = useAssistant((s) => s.items);
  const follow = bulkFollowUp(card, sets, items);
  return (
    <div className="rounded-xl bg-pane-2 p-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
      <div className="selectable text-[13px] font-semibold">{card.title}</div>
      <div className="selectable mt-0.5 text-[11.5px] text-foreground/50">{card.detail}</div>
      {(card.status === "running" || card.status === "partial") && (
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]">
          <div className={cn("h-full rounded-full transition-[width]", destructive ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="mt-1.5 text-[11.5px] text-foreground/55">
        {card.status === "running" && (card.phase ?? `Working… ${card.done.toLocaleString()} / ${card.total.toLocaleString()}`)}
        {card.status === "done" && `✓ Done · ${Math.max(0, card.done - skipped).toLocaleString()} emails${skipped ? ` · ${skipped.toLocaleString()} skipped` : ""}`}
        {card.status === "partial" && `${card.done.toLocaleString()} of ${card.total.toLocaleString()} done${card.error ? ` · ${card.error}` : ""}`}
        {card.status === "cancelled" && "Cancelled. Nothing was changed."}
        {card.status === "undone" && `Undone${card.error ? ` · ${card.error}` : ""}`}
        {card.status === "done" && card.error && ` · ${card.error}`}
        {card.undoExpired && (card.status === "done" || card.status === "partial") && <span className="text-foreground/40"> · Undo expired</span>}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {card.status === "pending" && (
          <>
            <button onClick={() => void confirmBulk(id)} className={cn(btn, destructive ? "bg-destructive text-white" : "bg-primary text-primary-foreground")}>
              {card.title.split(":")[0]}
            </button>
            {card.setId && (
              <button onClick={() => reviewSet(card.setId!)} className={cn(btn, "bg-foreground/[0.07] hover:bg-foreground/10")}>
                Review
              </button>
            )}
            <button onClick={() => cancelCard(id)} className={cn(btn, "text-foreground/55 hover:bg-foreground/[0.07]")}>
              Cancel
            </button>
          </>
        )}
        {card.status === "running" && (
          <button onClick={() => stopBulk(id)} className={cn(btn, "bg-foreground/[0.07] hover:bg-foreground/10")}>
            <Loader2 className="mr-1 inline size-3 animate-spin" /> Stop
          </button>
        )}
        {card.status === "partial" && !!card.failedRefs?.length && !card.undoing && (
          <button onClick={() => void resumeBulk(id)} className={cn(btn, "bg-primary text-primary-foreground")}>
            Resume
          </button>
        )}
        {(card.status === "done" || card.status === "partial") && !!card.undo?.length && (
          <button disabled={card.undoing} onClick={() => void undoBulk(id)} className={cn(btn, "bg-foreground/[0.07] hover:bg-foreground/10 disabled:opacity-50")}>
            {card.undoing ? "Undoing…" : card.status === "partial" ? "Undo what was done" : "Undo"}
          </button>
        )}
      </div>
      {follow && (
        <div className="mt-2.5 border-t border-hairline pt-2.5">
          <div className="selectable text-[11.5px] text-foreground/55">More mail from {follow.sender}?</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {follow.rule && (
              <button onClick={() => automateFromBulk(id)} className={cn(btn, "bg-foreground/[0.07] hover:bg-foreground/10")}>
                Do this automatically
              </button>
            )}
            {follow.unsub && (
              <button disabled={card.unsubOffered === "checking"} onClick={() => void unsubscribeFromBulk(id)} className={cn(btn, "bg-foreground/[0.07] hover:bg-foreground/10 disabled:opacity-50")}>
                {card.unsubOffered === "checking" && <Loader2 className="mr-1 inline size-3 animate-spin" />}
                Unsubscribe
              </button>
            )}
            <button onClick={() => dismissFollowUp(id)} className="px-1 text-[12px] text-foreground/50 hover:text-foreground/70 hover:underline">
              No thanks
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
