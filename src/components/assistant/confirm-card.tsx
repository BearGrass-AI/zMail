// src/components/assistant/confirm-card.tsx
// A module's action that needs the user's OK. Nothing happens until the confirm button.
import { Loader2 } from "lucide-react";
import { useAssistant, type Item } from "@/lib/ai/assistant/state";
import { confirmAll, dismissConfirm, runConfirm, type ConfirmCardData } from "@/lib/ai/assistant/modules/confirm";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { SendLaterMenu } from "@/components/mail/send-later-menu";
import { whenLabel } from "@/lib/mail/scheduled";

const btn = "h-7 rounded-lg px-2.5 text-[12px] font-semibold whitespace-nowrap";

/** Ids of the consecutive pending confirm cards (same module + action) ending at this one, if it is the last of them. */
function runEndingAt(items: Item[], id: string): string[] {
  const at = items.findIndex((i) => i.id === id);
  const me = items[at];
  if (!me || me.kind !== "card" || me.card.type !== "confirm") return [];
  const mine = me.card;
  const same = (it: Item | undefined) => it?.kind === "card" && it.card.type === "confirm" && it.card.status === "pending" && it.card.module === mine.module && it.card.action === mine.action;
  if (same(items[at + 1])) return [];
  const ids = [id];
  for (let k = at - 1; k >= 0 && same(items[k]); k--) ids.unshift(items[k].id);
  return ids;
}

/** Send cards: pick a time to schedule instead of sending now, or go back to sending now. */
function SendLaterControl({ id, card }: { id: string; card: ConfirmCardData }) {
  const payload = (card.payload ?? {}) as { sendAt?: number };
  const patch = useAssistant((s) => s.patchCard);
  return (
    <>
      <SendLaterMenu
        align="start"
        onPick={(at) => patch(id, { payload: { ...payload, sendAt: at.getTime() }, confirmLabel: `Schedule · ${whenLabel(at.getTime())}` })}
        trigger={<button className={cn(btn, "inline-flex items-center gap-1 text-foreground/65 hover:bg-foreground/[0.07]")}>Send later <ChevronDown className="size-3" /></button>}
      />
      {payload.sendAt !== undefined && (
        <button
          onClick={() => {
            const { sendAt: _, ...rest } = payload;
            patch(id, { payload: rest, confirmLabel: "Send" });
          }}
          className={cn(btn, "font-normal text-foreground/55 hover:text-foreground")}
        >
          Send now instead
        </button>
      )}
    </>
  );
}

export function ConfirmCard({ id, card }: { id: string; card: ConfirmCardData }) {
  const items = useAssistant((s) => s.items);
  const ids = card.status === "pending" ? runEndingAt(items, id) : [];
  const p = card.preview;
  return (
    <div className="rounded-xl bg-pane-2 p-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
      <div className="selectable text-[13px] font-semibold">{card.title}</div>
      {card.detail && <div className="selectable mt-0.5 text-[11.5px] text-foreground/50">{card.detail}</div>}
      {p?.fields && p.fields.length > 0 && (
        <div className="selectable mt-1.5 space-y-0.5 text-[12px]">
          {p.fields.map((f) => (
            <div key={f.label}>
              <span className="text-foreground/50">{f.label}:</span> {f.value}
            </div>
          ))}
        </div>
      )}
      {p?.body && <div className="selectable mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-foreground/[0.04] p-2 text-[12px]">{p.body}</div>}
      {(card.status === "pending" || card.status === "failed") && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button onClick={() => void runConfirm(id)} className={cn(btn, "bg-primary text-primary-foreground")}>
            {card.status === "failed" ? "Try again" : card.confirmLabel}
          </button>
          {ids.length >= 2 && (
            <button onClick={() => void confirmAll(ids)} className={cn(btn, "bg-primary text-primary-foreground")}>
              Confirm all {ids.length}
            </button>
          )}
          {card.later && <SendLaterControl id={id} card={card} />}
          <button onClick={() => dismissConfirm(id)} className={cn(btn, "text-foreground/55 hover:bg-foreground/[0.07]")}>
            Dismiss
          </button>
        </div>
      )}
      {card.status === "failed" && card.error && <div className="selectable mt-1.5 text-[11.5px] text-destructive">{card.error}</div>}
      {card.status === "running" && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-foreground/55">
          <Loader2 className="size-3 animate-spin" /> Working…
        </div>
      )}
      {card.status === "done" && <div className="selectable mt-1.5 text-[11.5px] text-foreground/55">✓ {card.result ?? "Done"}</div>}
      {card.status === "dismissed" && <div className="mt-1.5 text-[11.5px] text-foreground/55">Dismissed</div>}
    </div>
  );
}
