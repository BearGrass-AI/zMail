// src/components/assistant/assistant-panel.tsx
// The ✦ Assistant side panel: conversation, cards, and the input with a chip
// showing what "this / these" means right now.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Brush, ChevronRight, Loader2, Sparkles, Square, X } from "lucide-react";
import { clearChat, planSend, useAssistant } from "@/lib/ai/assistant/state";
import { ask } from "@/lib/ai/assistant/loop";
import { inputKeyAction, matchCommands, senderSuggestions, type MenuItem, type SlashCommand } from "@/lib/ai/assistant/commands";
import { liveMentions, type MentionRef } from "@/lib/ai/assistant/mentions";
import { mentionQuery, usePeopleSearch } from "@/components/mail/people-suggest";
import { assistantIsOffline } from "@/lib/ai/providers";
import { useSettings } from "@/lib/settings";
import { useMail } from "@/lib/store";
import { useStickToBottom } from "@/lib/stick-to-bottom";
import { clampWidth, DEFAULT_WIDTH, useDragWidth } from "@/lib/ai/assistant/panel-width";
import { groupSteps, type StepGroup } from "@/lib/ai/assistant/steps";
import { MessageItem, MESSAGE_SELECTABLE } from "./message-item";
import { ModelPicker } from "./model-picker";
import { SLASH_LISTBOX_ID, SlashMenu, slashOptionId } from "./slash-menu";

/** A collapsed run of repeated step lines; click to show the individual lines. */
function StepGroupRow({ group, open, onToggle }: { group: StepGroup; open: boolean; onToggle: () => void }) {
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open} className={`${MESSAGE_SELECTABLE} flex w-full items-center gap-1 rounded text-left text-[11px] text-foreground/40 outline-none hover:text-foreground/60 focus-visible:text-foreground/70 focus-visible:ring-1 focus-visible:ring-primary`}>
        <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        {group.label}
      </button>
      {open && (
        <div className="mt-1 space-y-1 pl-4">
          {group.items.map((it) => (
            <MessageItem key={it.id} item={it} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Drag handle on the panel's left edge: drag left to widen, double-click to reset, arrows nudge. */
function ResizeHandle({ width }: { width: number }) {
  const setLive = useDragWidth((s) => s.setLive);
  const drag = useRef<{ startX: number; startW: number; w: number; raf: number } | null>(null);
  const [active, setActive] = useState(false);
  const commit = (w: number) => useSettings.getState().set({ assistantWidth: clampWidth(w, window.innerWidth) });

  const end = () => {
    const d = drag.current;
    if (!d) return;
    cancelAnimationFrame(d.raf);
    drag.current = null;
    document.body.style.userSelect = "";
    if (d.w !== useSettings.getState().assistantWidth) commit(d.w);
    setLive(null);
    setActive(false);
  };
  // Safety net if the panel unmounts mid-drag.
  useEffect(
    () => () => {
      cancelAnimationFrame(drag.current?.raf ?? 0);
      drag.current = null;
      document.body.style.userSelect = "";
      setLive(null);
    },
    [setLive],
  );
  // Window shrinks mid-drag: keep the live width inside the new limits.
  useEffect(() => {
    const onResize = () => {
      const d = drag.current;
      if (!d) return;
      d.w = clampWidth(d.w, window.innerWidth);
      setLive(d.w);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setLive]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize assistant panel"
      aria-valuenow={width}
      aria-valuemin={320}
      aria-valuemax={clampWidth(Infinity, window.innerWidth)}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0 || drag.current) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startW: width, w: width, raf: 0 };
        document.body.style.userSelect = "none";
        setActive(true);
        setLive(width);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // d.w is the source of truth for release; the frame only paints it.
        d.w = clampWidth(d.startW + (d.startX - e.clientX), window.innerWidth);
        if (!d.raf)
          d.raf = requestAnimationFrame(() => {
            if (!drag.current) return;
            drag.current.raf = 0;
            setLive(drag.current.w);
          });
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => width !== DEFAULT_WIDTH && commit(DEFAULT_WIDTH)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        commit(width + (e.key === "ArrowLeft" ? 16 : -16));
      }}
      style={{ cursor: "col-resize", touchAction: "none" }}
      className="group/resize absolute inset-y-0 left-0 z-10 flex w-1.5 justify-start outline-none"
    >
      <div className={`h-full w-px transition-colors group-hover/resize:bg-foreground/30 group-focus-visible/resize:bg-primary ${active ? "bg-foreground/40" : "bg-hairline"}`} />
    </div>
  );
}

function useContextLabel() {
  const selectedId = useMail((s) => s.selectedId);
  const checkedCount = useMail((s) => s.checked.size);
  const subject = useMail((s) => (s.selectedId ? s.emails.find((e) => e.id === s.selectedId)?.subject : undefined));
  const setLabel = useAssistant((s) => (s.activeSetId ? s.sets[s.activeSetId]?.label : undefined));
  const setCount = useAssistant((s) => (s.activeSetId ? s.sets[s.activeSetId]?.refs.length : undefined));
  if (checkedCount) return `${checkedCount} checked`;
  if (selectedId && subject) return `Viewing: ${subject}`;
  if (setLabel) return `Viewing: ${setLabel} · ${setCount}`;
  return null;
}

export function AssistantPanel() {
  const items = useAssistant((s) => s.items);
  const busy = useAssistant((s) => s.busy);
  const clearing = useAssistant((s) => s.clearing);
  const progress = useAssistant((s) => s.progress);
  const toggle = useAssistant((s) => s.toggle);
  // Re-read the offline state when settings change.
  const aiProviders = useSettings((s) => s.aiProviders);
  const aiRoles = useSettings((s) => s.aiRoles);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- assistantIsOffline reads the settings store directly; these deps only trigger the re-read.
  const offline = useMemo(() => assistantIsOffline(), [aiProviders, aiRoles]);
  const context = useContextLabel();
  const storedWidth = useSettings((s) => s.assistantWidth);
  const live = useDragWidth((s) => s.live);
  const width = live ?? clampWidth(storedWidth, window.innerWidth);
  // Keep the stored width inside the limits when the window shrinks.
  useEffect(() => {
    const onResize = () => {
      const w = useSettings.getState().assistantWidth;
      const c = clampWidth(w, window.innerWidth);
      if (c !== w) useSettings.getState().set({ assistantWidth: c });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const rows = useMemo(() => groupSteps(items), [items]);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [text, setText] = useState("");
  const [chip, setChip] = useState<SlashCommand | null>(null);
  const [menuActive, setMenuActive] = useState(0);
  // Esc hides the menu for this exact input; any change to the text or chip brings it back.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [caret, setCaret] = useState(0);
  const [mentions, setMentions] = useState<MentionRef[]>([]);
  const emails = useMail((s) => s.emails);
  const hasOpenEmail = useMail((s) => !!s.selectedId);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);
  // "Ask Assistant…" from an email's menu while the panel is already open.
  const focusAsk = useAssistant((s) => s.focusAsk);
  useEffect(() => {
    if (focusAsk) input.current?.focus();
  }, [focusAsk]);
  // Grow with the text up to the textarea's max height.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  // Follow new messages and growing cards, but not while you're scrolled up reading.
  useStickToBottom(scroller, items, busy);

  // "@Ty" before the caret; a finished mention ("@Tyler Smith ") isn't a new search.
  const found = mentionQuery(text, caret);
  const trigger = found && found.query && !mentions.some((m) => found.query === m.name || found.query.startsWith(`${m.name} `)) ? found : null;
  const { people } = usePeopleSearch(trigger ? trigger.query : null);

  const menuItems = useMemo<MenuItem[]>(() => {
    if (trigger) return people.slice(0, 6).map((p) => ({ type: "person", p }));
    if (!chip && /^\/\S*$/.test(text)) return matchCommands(text, { hasOpenEmail }).map((command) => ({ type: "command", command }));
    if (chip?.arg === "sender" && text.trim()) return senderSuggestions(emails, text).map((s) => ({ type: "sender", s }));
    return [];
  }, [chip, text, emails, hasOpenEmail, trigger, people]);
  const inputKey = `${chip?.name ?? ""}|${text}|${trigger?.query ?? ""}`;
  const menuOpen = menuItems.length > 0 && dismissed !== inputKey;
  const active = Math.min(menuActive, Math.max(menuItems.length - 1, 0));

  // What Enter would do right now, or null when it can't send.
  const plan = planSend(chip, text, busy, clearing);

  const reset = () => {
    setDismissed(null);
    setText("");
    setChip(null);
    setMenuActive(0);
    setMentions([]);
    setCaret(0);
  };
  const send = () => {
    if (!plan) return;
    const sending = plan.kind === "plain" ? plan.text : plan.kind === "command" ? plan.arg : "";
    const m = liveMentions(sending, mentions);
    reset();
    if ("redirect" in plan && plan.redirect) {
      // ask() returns early while busy, so end the running turn first.
      useAssistant.getState().stopTurn("redirected");
      useAssistant.getState().note("The user interrupted your previous answer with this message. Use it to refocus.");
    }
    if (plan.kind === "clear") void clearChat();
    else if (plan.kind === "plain") void ask(plan.text, undefined, undefined, { mentions: m });
    else void ask(plan.command.expand(plan.arg), undefined, undefined, { display: { command: plan.command.name, text: plan.arg }, mentions: m });
  };
  const pick = (item: MenuItem) => {
    setMenuActive(0);
    setDismissed(null);
    if (item.type === "person") {
      if (!trigger) return;
      const before = text.slice(0, trigger.start);
      const after = text.slice(trigger.start + 1 + trigger.query.length).replace(/^\s+/, "");
      const token = `@${item.p.name} `;
      setText(`${before}${token}${after}`);
      setMentions((ms) => [...ms.filter((x) => x.address !== item.p.address), { name: item.p.name, address: item.p.address }]);
      const c = before.length + token.length;
      setCaret(c);
      requestAnimationFrame(() => input.current?.setSelectionRange(c, c));
    } else if (item.type === "sender") {
      setDismissed(`${chip?.name ?? ""}|${item.s.value}`);
      setText(item.s.value);
    } else if (item.command.local === "clear") {
      reset();
      void clearChat();
    } else {
      setChip(item.command);
      setText("");
    }
    input.current?.focus();
  };

  return (
    <aside style={{ width }} className="pane relative flex h-full shrink-0 flex-col overflow-hidden rounded-2xl">
      <ResizeHandle width={width} />
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
        <Sparkles className="size-4 text-primary" />
        <span className="text-[13px] font-semibold">Assistant</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => void clearChat()} title="Clear conversation" aria-label="Clear conversation" className="flex h-7 items-center gap-1 rounded-lg px-1.5 text-[11.5px] text-foreground/50 hover:bg-foreground/[0.07]">
            <Brush className="size-3.5" />
            {clearing ? "Clearing…" : "Clear"}
          </button>
          <button onClick={() => toggle(false)} title="Close (⌘J)" aria-label="Close assistant" className="grid size-7 place-items-center rounded-lg text-foreground/50 hover:bg-foreground/[0.07]">
            <X className="size-4" />
          </button>
        </div>
      </div>
      <div ref={scroller} role="log" aria-live="polite" className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-3">
        {offline && (
          <div className="rounded-xl bg-foreground/[0.05] px-3 py-2 text-[11.5px] text-foreground/55">
            Offline demo. Set up a model in Settings → AI providers, then pick it in Settings → AI Assistant to use the assistant on your real mail.
          </div>
        )}
        {!items.length && (
          <div className="mt-6 space-y-1.5 text-center text-[12.5px] text-foreground/45">
            <p>Ask about your mail, or tell zMail what to do.</p>
            <p className="text-foreground/35">"Pull up my Amazon emails. How many are orders?"</p>
          </div>
        )}
        {rows.map((row, i) =>
          "items" in row ? (
            <StepGroupRow key={row.id} group={row} open={!!openGroups[row.id]} onToggle={() => setOpenGroups((o) => ({ ...o, [row.id]: !o[row.id] }))} />
          ) : (
            <MessageItem key={row.id} item={row} last={i === rows.length - 1} />
          ),
        )}
        {busy && (
          <div className="flex items-center gap-1.5 text-[11.5px] text-foreground/40">
            <Loader2 className="size-3 animate-spin" /> {progress ?? "Working…"}
          </div>
        )}
      </div>
      <div className="relative m-2.5 rounded-xl bg-pane-2 p-2 shadow-[inset_0_0_0_1px_var(--hairline)]">
        {menuOpen && <SlashMenu items={menuItems} active={active} onActive={setMenuActive} onPick={pick} />}
        {context && <div className="mb-1 inline-flex max-w-full truncate rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10.5px] text-foreground/55">◉ {context}</div>}
        <div className="flex items-end gap-2">
          {chip && (
            <span title="Backspace to remove" className="shrink-0 self-start rounded-md bg-primary/15 px-1.5 py-px font-mono text-[12px] font-semibold text-primary">
              /{chip.name}
            </span>
          )}
          <textarea
            ref={input}
            aria-label="Ask the assistant"
            value={text}
            rows={1}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setMenuActive(0);
              setDismissed(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            role="combobox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? SLASH_LISTBOX_ID : undefined}
            aria-activedescendant={menuOpen ? slashOptionId(active) : undefined}
            onKeyDown={(e) => {
              const act = inputKeyAction(
                e.key,
                { chip, text, menu: menuOpen ? { items: menuItems, active } : null, composing: composing || e.nativeEvent.isComposing || e.keyCode === 229 },
                e.shiftKey,
              );
              if (act.do === "none") {
                if (e.key === "Escape" && busy && !composing && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.stopPropagation(); // App's global Esc would blur the input
                  useAssistant.getState().stopTurn("stopped");
                }
                return;
              }
              e.preventDefault();
              if (act.do === "move") setMenuActive(act.active);
              else if (act.do === "pick") pick(act.item);
              else if (act.do === "close") {
                e.stopPropagation(); // App's global Esc would blur the input
                setDismissed(inputKey);
              }
              else if (act.do === "remove_chip") {
                setChip(null);
                setDismissed(null);
              }
              else send();
            }}
            placeholder={clearing ? "Clearing…" : chip ? (chip.placeholder ?? "Press ↵ to run") : busy ? "Add details or redirect… (Esc to stop)" : "Ask about your mail… (/ commands, @ people)"}
            className="max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-foreground/35"
          />
          <ModelPicker />
          {busy && !text.trim() && !chip ? (
            <button onClick={() => useAssistant.getState().stopTurn("stopped")} aria-label="Stop" title="Stop (Esc)" className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button onClick={send} disabled={!plan} aria-label="Send" className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40">
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
