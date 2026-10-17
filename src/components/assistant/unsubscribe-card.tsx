// src/components/assistant/unsubscribe-card.tsx
// Unsubscribe from a sender using its List-Unsubscribe header. Nothing is posted,
// sent or opened until the user clicks; header URLs are untrusted, so only https
// is ever posted to or opened, and a mailto only supplies an address and subject.
import { Loader2 } from "lucide-react";
import type { Card } from "@/lib/ai/assistant/state";
import { useAssistant } from "@/lib/ai/assistant/state";
import { realDeps } from "@/lib/ai/assistant/deps";
import { pushRuleCard, type ToolDeps } from "@/lib/ai/assistant/tools";
import { hasRuleCard } from "@/lib/ai/assistant/cards";
import { hostOf, parseMailto, safeHttps } from "@/lib/mail/unsubscribe";
import { HttpError } from "@/lib/transport";
import { cn } from "@/lib/utils";

type UnsubCard = Extract<Card, { type: "unsubscribe" }>;
type UnsubDeps = Pick<ToolDeps, "oneClick" | "sendUnsubscribe" | "openLink">;
const btn = "h-7 rounded-lg px-2.5 text-[12px] font-semibold whitespace-nowrap";

/** The live card, not the rendered prop, so a double click can't act twice. */
function liveCard(id: string): UnsubCard | undefined {
  const item = useAssistant.getState().items.find((i) => i.id === id);
  return item?.kind === "card" && item.card.type === "unsubscribe" ? item.card : undefined;
}

const patch = (id: string, p: Partial<UnsubCard>) => useAssistant.getState().patchCard(id, p);

function errorText(err: unknown) {
  if (err instanceof HttpError) return `The sender's server answered ${err.status}.`;
  return err instanceof Error ? err.message : "Couldn't unsubscribe.";
}

/** Tell the model how the card ended, if it's still in this chat. Never with links or server bodies. */
function noteOutcome(id: string) {
  const card = liveCard(id);
  if (!card) return;
  const st = useAssistant.getState();
  if (card.status === "done") st.note(`Unsubscribed from ${card.from} (${card.method === "one_click" ? "one-click" : card.method})`);
  else if (card.status === "failed") st.note(`Unsubscribe from ${card.from} failed: ${shortError(card.error)}`);
  else if (card.status === "opened") st.note(`Opened the unsubscribe page for ${card.from}; the user finishes it there`);
  else if (card.status === "dismissed") st.note(`User dismissed unsubscribe for ${card.from}`);
}

/** An error for a note: links replaced, one line, short. */
export function shortError(text: string | undefined): string {
  const t = (text ?? "Couldn't unsubscribe.").replace(/\b(?:https?|mailto):[^\s)>"']+/gi, "link").replace(/\s+/g, " ").trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

/** Open the sender's https unsubscribe page (the link method, or the fallback after a failure). */
export function openUnsubscribePage(id: string, deps: UnsubDeps = realDeps()) {
  const card = liveCard(id);
  if (!card || (card.status !== "pending" && card.status !== "failed")) return;
  const url = card.http ? safeHttps(card.http) : null;
  if (!url) {
    patch(id, { status: "failed", error: "That unsubscribe link isn't a secure (https) page." });
    noteOutcome(id);
    return;
  }
  deps.openLink(url);
  patch(id, { status: "opened" });
  noteOutcome(id);
}

/** The card's main button. */
export async function runUnsubscribe(id: string, deps: UnsubDeps = realDeps()) {
  const card = liveCard(id);
  if (!card || card.status !== "pending") return;
  if (card.method === "link") return openUnsubscribePage(id, deps);
  patch(id, { status: "working", error: undefined });
  try {
    if (card.method === "one_click") {
      const url = card.http ? safeHttps(card.http) : null;
      if (!url) throw new Error("That unsubscribe link isn't a secure (https) page.");
      await deps.oneClick(url);
    } else {
      const m = card.mailto ? parseMailto(card.mailto) : null;
      if (!m) throw new Error("That unsubscribe address isn't valid.");
      await deps.sendUnsubscribe(card.accountId, m.to, m.subject);
    }
    patch(id, { status: "done" });
  } catch (err) {
    patch(id, { status: "failed", error: errorText(err) });
  }
  noteOutcome(id);
}

export function dismissUnsubscribe(id: string) {
  const card = liveCard(id);
  if (!card || (card.status !== "pending" && card.status !== "failed")) return;
  patch(id, { status: "dismissed" });
  noteOutcome(id);
}

/** After unsubscribing: mail can keep coming for a few days, so offer a trash rule meanwhile. Once. */
export function trashMeanwhile(id: string) {
  const card = liveCard(id);
  if (card?.status !== "done" || card.meanwhileOffered || hasRuleCard(useAssistant.getState().items, card.from, "trash")) return;
  patch(id, { meanwhileOffered: true });
  pushRuleCard({ from: card.from, action: "trash" });
}

function detail(card: UnsubCard) {
  const host = card.http ? hostOf(card.http) : "";
  if (card.method === "one_click") return `Asks ${host} to stop sending you mail.`;
  if (card.method === "email") return `Sends a short email to ${(card.mailto && parseMailto(card.mailto)?.to) || "the sender"} from ${card.accountAddress}.`;
  return `Opens ${host}'s unsubscribe page in your browser.`;
}

const LABEL: Record<UnsubCard["method"], string> = { one_click: "Unsubscribe", email: "Send unsubscribe email", link: "Open unsubscribe page" };

export function UnsubscribeCard({ id, card }: { id: string; card: UnsubCard }) {
  const dismiss = () => dismissUnsubscribe(id);
  const ruleShown = useAssistant((s) => hasRuleCard(s.items, card.from, "trash"));
  return (
    <div className="rounded-xl bg-pane-2 p-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
      <div className="selectable text-[13px] font-semibold">Unsubscribe from {card.from}</div>
      <div className="selectable mt-0.5 text-[11.5px] break-words text-foreground/50">{detail(card)}</div>
      {card.status === "pending" && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button onClick={() => void runUnsubscribe(id)} className={cn(btn, "bg-primary text-primary-foreground")}>
            {LABEL[card.method]}
          </button>
          <button onClick={dismiss} className={cn(btn, "text-foreground/55 hover:bg-foreground/[0.07]")}>
            Dismiss
          </button>
        </div>
      )}
      {card.status === "working" && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-foreground/55">
          <Loader2 className="size-3 animate-spin" /> {card.method === "email" ? "Sending…" : "Unsubscribing…"}
        </div>
      )}
      {card.status === "done" && (
        <>
          <div className="mt-1.5 text-[11.5px] text-foreground/55">✓ Unsubscribed · new mail may take a few days to stop</div>
          {!card.meanwhileOffered && !ruleShown && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <button onClick={() => trashMeanwhile(id)} className={cn(btn, "max-w-full truncate bg-foreground/[0.07] hover:bg-foreground/10")}>
                Trash new mail from {card.from} meanwhile
              </button>
            </div>
          )}
        </>
      )}
      {card.status === "opened" && <div className="mt-1.5 text-[11.5px] text-foreground/55">Finish in your browser</div>}
      {card.status === "dismissed" && <div className="mt-1.5 text-[11.5px] text-foreground/55">Dismissed</div>}
      {card.status === "failed" && (
        <>
          <div className="selectable mt-1.5 text-[11.5px] text-destructive">{card.error ?? "Couldn't unsubscribe."}</div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {card.http && safeHttps(card.http) && (
              <button onClick={() => openUnsubscribePage(id)} className={cn(btn, "bg-foreground/[0.07] hover:bg-foreground/10")}>
                Open unsubscribe page
              </button>
            )}
            <button onClick={dismiss} className={cn(btn, "text-foreground/55 hover:bg-foreground/[0.07]")}>
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
}
