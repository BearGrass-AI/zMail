// src/components/assistant/message-item.tsx
import { useMemo, useState } from "react";
import { AlertCircle, Copy, Globe, Loader2, PenLine } from "lucide-react";
import { toast } from "sonner";
import type { Item } from "@/lib/ai/assistant/state";
import { useAssistant, type RefInfo } from "@/lib/ai/assistant/state";
import { addEvent, dismissEvent, eventDetail, rerunSetChip, reviewSet } from "@/lib/ai/assistant/cards";
import { retry } from "@/lib/ai/assistant/loop";
import { splitMentions } from "@/lib/ai/assistant/mentions";
import { useSettings } from "@/lib/settings";
import { bestToolModel, currentChoiceKey, modelChoices } from "@/lib/ai/assistant/model-choices";
import { useModelHealth } from "@/lib/ai/assistant/model-health";
import { ProviderLogo } from "./provider-logo";
import { pickModel, useModelPickerOpen } from "./model-picker";
import { useMail } from "@/lib/store";
import { SuggestionCard } from "@/components/suggestion-card";
import { BulkCard } from "./bulk-card";
import { RuleCard } from "./rule-card";
import { ConfirmCard } from "./confirm-card";
import { UnsubscribeCard } from "./unsubscribe-card";
import { renderMarkdown } from "@/lib/ai/assistant/markdown";
import { openExternal } from "@/components/mail/email-body";
import { realDeps } from "@/lib/ai/assistant/deps";

/** The "model can't handle the tools" error: retry on the best other model, or open the picker. */
function ToolTroubleError({ text, retryKey }: { text: string; retryKey: string }) {
  const aiProviders = useSettings((s) => s.aiProviders);
  const aiRoles = useSettings((s) => s.aiRoles);
  const health = useModelHealth((s) => s.health);
  const best = useMemo(
    () => bestToolModel(modelChoices({ aiProviders }), health, currentChoiceKey({ aiProviders, aiRoles })),
    [aiProviders, aiRoles, health],
  );
  return (
    <div className="rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px]">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <div className={`${MESSAGE_SELECTABLE} min-w-0 flex-1`}>{text}</div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-5.5">
        {best && (
          <button
            onClick={() => {
              pickModel(best);
              void retry(retryKey);
            }}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-[12px] font-semibold text-primary-foreground"
          >
            Retry with
            <ProviderLogo provider={best.provider} className="size-3.5" />
            {best.name}
          </button>
        )}
        <button onClick={() => useModelPickerOpen.getState().setOpen(true)} className="rounded-lg px-2 py-1 text-[12px] font-semibold text-primary hover:bg-primary/10">
          Choose a model…
        </button>
      </div>
    </div>
  );
}

function SetChip({ itemId, setId, label, count, capped, canRerun }: { itemId: string; setId: string; label: string; count: number; capped?: boolean; canRerun: boolean }) {
  const exists = useAssistant((s) => !!s.sets[setId]);
  const [rerunning, setRerunning] = useState(false);
  // A chip from an earlier session runs its search again when clicked.
  const click = async () => {
    if (exists) return reviewSet(setId);
    setRerunning(true);
    try {
      await rerunSetChip(itemId);
    } catch (err) {
      toast.error("Couldn't search again", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setRerunning(false);
    }
  };
  const usable = exists || canRerun;
  return (
    <button
      disabled={!usable || rerunning}
      title={exists ? "Show in your mail list" : canRerun ? "From an earlier session. Click to search again." : "From an earlier session. Ask again to see these."}
      onClick={() => void click()}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/12 px-2 py-0.5 text-[11.5px] font-semibold text-primary disabled:opacity-50"
    >
      {rerunning && <Loader2 className="size-3 animate-spin" />}
      <span className="truncate">{label}</span> · {count.toLocaleString()}
      {capped ? "+" : ""}
    </button>
  );
}

function GroupRow({ group, max }: { group: { label: string; count: number; setId: string }; max: number }) {
  const exists = useAssistant((s) => !!s.sets[group.setId]);
  return (
    <button
      disabled={!exists}
      title={exists ? "Show in your mail list" : "From an earlier session. Ask again to see these."}
      onClick={() => reviewSet(group.setId)}
      className="flex w-full items-center gap-2 text-left text-[11.5px] hover:opacity-80 disabled:opacity-50"
    >
      <span className="w-32 truncate text-foreground/60">{group.label}</span>
      <span className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.max(4, (group.count / max) * 110)}px` }} />
      <span className="tabular-nums">{group.count.toLocaleString()}</span>
    </button>
  );
}

/** Message content must stay selectable: the app blocks the native menu everywhere else. */
export const MESSAGE_SELECTABLE = "selectable";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
    return true;
  } catch {
    toast.error("Couldn't copy");
    return false;
  }
}

const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** "2025-10-03" -> "Oct 3". */
export function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : SHORT_DATE.format(d);
}

/** Copy text: [mN] tokens become [n] and a numbered Sources list follows. */
export function copyWithSources(text: string, cited: string[], refs: Record<string, RefInfo>): string {
  if (!cited.length) return text;
  const body = text.replace(/\[(m\d+)\]/g, (_all, k: string) => (cited.includes(k) ? `[${cited.indexOf(k) + 1}]` : ""));
  const lines = cited.map((k, i) => `${i + 1}. ${refs[k].from} — ${refs[k].subject} (${shortDate(refs[k].date)})`);
  return `${body}\n\nSources:\n${lines.join("\n")}`;
}

async function openRef(info: RefInfo) {
  try {
    const full = await useMail.getState().ensureEmail({ id: info.id, accountId: info.accountId });
    useMail.getState().select(full.id);
  } catch {
    toast("That email is no longer available");
  }
}

type WebSource = { url: string; title: string };
const WEB_SOURCES_MAX = 5;

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Copied text gets the cited web pages after any email sources. */
function withWebSources(text: string, web: WebSource[]) {
  return web.length ? `${text}\n\nWeb:\n${web.map((s) => `- ${s.title} — ${s.url}`).join("\n")}` : text;
}

function AssistantText({ text, webSources }: { text: string; webSources?: WebSource[] }) {
  const refs = useAssistant((s) => s.refs);
  const { html, cited } = useMemo(() => renderMarkdown(text, refs), [text, refs]);
  const web = (webSources ?? []).slice(0, WEB_SOURCES_MAX);
  // Click and middle-click both go to the system browser, never an in-webview window.
  const onLink = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    const cite = el.closest<HTMLElement>("button.cite");
    if (cite) {
      // A cite inside link text must not follow the link.
      e.preventDefault();
      e.stopPropagation();
      const key = cite.dataset.ref ?? "";
      if (e.type === "click" && Object.hasOwn(refs, key)) void openRef(refs[key]);
      return;
    }
    const a = el.closest("a");
    if (!a) return;
    e.preventDefault();
    void openExternal(a.href);
  };
  return (
    <div className={`group/reply relative ${MESSAGE_SELECTABLE}`}>
      <div
        className="assistant-md text-[13px] leading-relaxed"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={onLink}
        onAuxClick={(e) => e.button === 1 && onLink(e)}
      />
      {cited.length > 0 && (
        <div className="mt-2 space-y-0.5">
          <div className="text-[9.5px] font-semibold tracking-wide text-foreground/45 uppercase">Sources</div>
          {cited.map((k, i) => (
            <button
              key={k}
              type="button"
              onClick={() => void openRef(refs[k])}
              title="Open this email"
              className="flex w-full items-center gap-1.5 rounded-lg bg-pane-2 px-2 py-1 text-left text-[11px] hover:opacity-80"
            >
              <span className="tabular-nums text-primary">{i + 1}</span>
              <span className="shrink-0 font-medium">{refs[k].from}</span>
              <span className="min-w-0 flex-1 truncate text-foreground/60">{refs[k].subject}</span>
              <span className="shrink-0 text-foreground/45">{shortDate(refs[k].date)}</span>
            </button>
          ))}
        </div>
      )}
      {web.length > 0 && (
        <div className="mt-2 space-y-0.5">
          <div className="text-[9.5px] font-semibold tracking-wide text-foreground/45 uppercase">Web</div>
          {web.map((s) => (
            <button
              key={s.url}
              type="button"
              onClick={() => void openExternal(s.url)}
              title={s.url}
              className="flex w-full items-center gap-1.5 rounded-lg bg-pane-2 px-2 py-1 text-left text-[11px] hover:opacity-80"
            >
              <Globe className="size-3 shrink-0 text-foreground/45" />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span className="shrink-0 text-foreground/45">{hostOf(s.url)}</span>
            </button>
          ))}
        </div>
      )}
      <button
        onClick={() => void copyText(withWebSources(copyWithSources(text, cited, refs), web))}
        title="Copy"
        aria-label="Copy reply"
        className="absolute -top-1 right-0 grid size-6 place-items-center rounded-md bg-pane-2 text-foreground/50 opacity-0 shadow-[inset_0_0_0_1px_var(--hairline)] transition-opacity group-hover/reply:opacity-100 focus-visible:opacity-100"
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

/** The command chip shown in a user bubble: /name. */
export function UserChip({ name }: { name: string }) {
  return <span className="mr-1.5 rounded-md bg-white/15 px-1.5 py-px font-mono text-[11px] font-semibold">/{name}</span>;
}

/** `last`: the newest item in the chat (only the latest error offers Retry). */
export function MessageItem({ item, last = false }: { item: Item; last?: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className={`${MESSAGE_SELECTABLE} ml-8 self-end rounded-2xl rounded-br-md bg-primary px-3 py-2 text-[13px] whitespace-pre-wrap text-primary-foreground`}>
          {item.display ? (
            <>
              <UserChip name={item.display.command} />
              {item.display.text}
            </>
          ) : item.mentions?.length ? (
            splitMentions(item.text, item.mentions).map((p, i) => (p.mention ? <span key={i} className="font-semibold">{p.text}</span> : p.text))
          ) : (
            item.text
          )}
        </div>
      );
    case "assistant":
      return <AssistantText text={item.text} webSources={item.webSources} />;
    case "step":
      return <div className={`${MESSAGE_SELECTABLE} text-[11px] text-foreground/40`}>{item.text}</div>;
    case "set": {
      const max = Math.max(1, ...(item.groups ?? []).map((g) => g.count));
      return (
        <div className="space-y-1.5">
          {item.groups ? (
            <div className="text-[10.5px] font-medium tracking-wide text-foreground/45 uppercase">{item.by ? `By ${item.by}` : "Breakdown"}</div>
          ) : (
            <SetChip itemId={item.id} setId={item.setId} label={item.label} count={item.count} capped={item.capped} canRerun={!!item.query} />
          )}
          {item.groups && (
            <div className="space-y-1">
              {item.groups.map((g) => (
                <GroupRow key={g.setId} group={g} max={max} />
              ))}
            </div>
          )}
        </div>
      );
    }
    case "card": {
      const c = item.card;
      if (c.type === "bulk") return <BulkCard id={item.id} card={c} />;
      if (c.type === "rule") return <RuleCard id={item.id} card={c} />;
      if (c.type === "unsubscribe") return <UnsubscribeCard id={item.id} card={c} />;
      if (c.type === "confirm") return <ConfirmCard id={item.id} card={c} />;
      if (c.type === "draft")
        return (
          <button onClick={() => useMail.getState().openCompose(c.compose)} className="flex items-center gap-2 rounded-xl bg-pane-2 px-3 py-2 text-left text-[12.5px] shadow-[inset_0_0_0_1px_var(--hairline)]">
            <PenLine className="size-3.5 text-primary" /> {c.summary} <span className="text-foreground/40">· Open</span>
          </button>
        );
      if (c.status !== "pending") return <div className="text-[11.5px] text-foreground/45">{c.status === "added" ? `✓ Added “${c.event.title}” to your calendar` : `Dismissed “${c.event.title}”`}</div>;
      return (
        <SuggestionCard
          sug={{ id: item.id, kind: "extracted", title: c.event.title, detail: eventDetail(c.event), start: c.event.start, end: c.event.end, allDay: c.event.allDay, calendarId: realDeps().defaultCalendar() ?? "", emailId: c.event.emailId, label: "event" }}
          onAccept={(calendarId) => addEvent(item.id, calendarId)}
          onDismiss={() => dismissEvent(item.id)}
        />
      );
    }
    case "error":
      if (item.toolTrouble && item.retry && last) return <ToolTroubleError text={item.text} retryKey={item.retry} />;
      return (
        <div className="flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px]">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <div className={`${MESSAGE_SELECTABLE} min-w-0 flex-1`}>{item.text}</div>
          {item.retry && last && (
            <button onClick={() => void retry(item.retry!)} className="shrink-0 text-[12px] font-semibold text-primary">
              Retry
            </button>
          )}
        </div>
      );
  }
}
