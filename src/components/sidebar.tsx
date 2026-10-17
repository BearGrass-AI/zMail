import { useMemo } from "react";
import { SPRING_PILL } from "@/lib/motion";
import { motion } from "motion/react";
import {
  BellOff,
  CalendarDays,
  Check,
  Columns3,
  Inbox,
  PenLine,
  Search,
  Settings,
  Sparkles,
  Star,
  Sun,
} from "lucide-react";
import { allInboxesUnread, eventsOn, starredCount, unreadByFolder, useMail, type View } from "@/lib/store";
import { useAssistant } from "@/lib/ai/assistant/state";
import { ask } from "@/lib/ai/assistant/loop";
import { searchAskAction } from "@/lib/ai/assistant/search-ask";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FolderTrees } from "./folder-tree";
import { useEffect, useRef, useState } from "react";
import { Clock, Plane } from "lucide-react";
import { toast } from "sonner";
import { stripText } from "@/lib/mail/auto-replies";
import { useSettingsOpen } from "@/lib/settings-open";
import { accountLabel } from "./account-switcher";

/** Reminder while automatic replies are on (or about to start) for any account. */
function AutoReplyStrip() {
  const autoReplies = useMail((s) => s.autoReplies);
  const accounts = useMail((s) => s.accounts);
  // Re-check every minute so "until Fri" disappears when the replies end.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const on = accounts.flatMap((a) => {
    const r = autoReplies[a.id];
    const text = r && typeof r === "object" ? stripText(r, now) : null;
    return r && typeof r === "object" && text ? [{ account: a, r, text }] : [];
  });
  if (!on.length) return null;
  const { account, r, text } = on[0];
  const title = on.length >= 2 ? `${account.address} · ${accountLabel(account, accounts)}` : account.address;
  const turnOff = async () => {
    try {
      await useMail.getState().saveAutoReply(account.id, { ...r, enabled: false });
      toast("Automatic replies off");
    } catch (err) {
      toast.error("Couldn't turn off automatic replies", { description: err instanceof Error ? err.message : String(err) });
    }
  };
  return (
    <div className="mx-2 mb-2 flex items-center gap-2 rounded-lg bg-amber-500/12 px-2.5 py-1.5 text-[12px] font-medium text-amber-700 dark:text-amber-300">
      <Plane className="size-3.5 shrink-0" />
      <button className="min-w-0 flex-1 truncate text-left" onClick={() => useSettingsOpen.getState().show("accounts")} title={title}>
        {text}
      </button>
      <button className="shrink-0 text-[11.5px] font-normal text-foreground/55 hover:text-foreground" onClick={() => void turnOff()}>
        Turn off
      </button>
    </div>
  );
}

function sameView(a: View, b: View) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function NavItem({
  view,
  icon,
  label,
  count,
  shortcut,
  hint,
}: {
  view: View;
  icon: React.ReactNode;
  label: string;
  count?: number;
  shortcut?: string;
  /** Hover text, e.g. what the count means. */
  hint?: string;
}) {
  const current = useMail((s) => s.view);
  const setView = useMail((s) => s.setView);
  const active = sameView(view, current);
  return (
    <button
      onClick={() => setView(view)}
      title={hint}
      className={cn(
        "group relative flex h-[32px] w-full items-center gap-3 rounded-lg px-2.5 text-[13.5px] text-foreground/80 transition-colors hover:text-foreground",
        active && "font-medium text-foreground",
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-lg bg-foreground/[0.075] dark:bg-foreground/10"
          transition={SPRING_PILL}
        />
      )}
      <span className="relative grid size-[18px] place-items-center text-foreground/70 group-hover:text-foreground [&_svg]:size-[17px] [&_svg]:stroke-[1.6]">
        {icon}
      </span>
      <span className="relative flex-1 truncate text-left">{label}</span>
      {shortcut && <span className="relative hidden text-[10.5px] text-foreground/30 group-hover:inline">{shortcut}</span>}
      {count !== undefined && count > 0 && (
        <span className={cn("relative text-[11.5px] text-foreground/40 tabular-nums", shortcut && "group-hover:hidden")}>{count}</span>
      )}
    </button>
  );
}

const SEARCH_DEBOUNCE_MS = 150;

/**
 * The search box's text. What you type shows at once; the store's query, which every list, count
 * and Today grouping filters on, follows 150 ms after the last keystroke, so fast typing costs one
 * rescan instead of one per key. A debounce here rather than useDeferredValue, which every reader
 * of the query would have to adopt. Clearing the box, leaving it (Escape blurs) and asking apply at once.
 */
function useSearchText() {
  const query = useMail((s) => s.query);
  const setQuery = useMail((s) => s.setQuery);
  const [text, setText] = useState(query);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sent = useRef(query);
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  // A query set elsewhere shows in the box.
  useEffect(() => {
    if (query === sent.current) return;
    sent.current = query;
    cancel();
    setText(query);
  }, [query]);
  useEffect(() => cancel, []);
  const commit = (q: string) => {
    cancel();
    sent.current = q;
    setQuery(q);
  };
  const change = (q: string) => {
    setText(q);
    if (!q) return commit(q);
    cancel();
    timer.current = setTimeout(() => commit(q), SEARCH_DEBOUNCE_MS);
  };
  /** Apply a pending keystroke now. */
  const flush = () => {
    if (timer.current !== undefined) commit(text);
  };
  return { text, change, flush };
}

export function Sidebar({ onSettings }: { onSettings: () => void }) {
  const assistantOpen = useAssistant((x) => x.open);
  const emails = useMail((s) => s.emails);
  const folders = useMail((s) => s.folders);
  const accounts = useMail((s) => s.accounts);
  const snoozed = useMail((s) => s.snoozed);
  const events = useMail((s) => s.events);
  const calendars = useMail((s) => s.calendars);
  const hiddenCalendars = useMail((s) => s.hiddenCalendars);
  const accountFilter = useMail((s) => s.accountFilter);
  const viewKind = useMail((s) => s.view.kind);
  const search = useSearchText();
  const openCompose = useMail((s) => s.openCompose);
  const toggleCalendar = useMail((s) => s.toggleCalendar);
  const scheduledCount = useMail((s) => s.scheduled.length);

  const counts = useMemo(() => {
    const unread = unreadByFolder(emails);
    const sel = { emails, folders, accounts, snoozed, events, calendars, hiddenCalendars, accountFilter };
    return {
      inbox: allInboxesUnread(sel),
      // "Unread · Gmail 570 · Outlook 30", so the All Inboxes number explains itself.
      inboxHint: `Unread in all inboxes · ${accounts
        .map((a) => `${accountLabel(a, accounts)} ${allInboxesUnread({ ...sel, accounts: [a] }).toLocaleString()}`)
        .join(" · ")}`,
      starred: starredCount(emails),
      // eslint-disable-next-line react-hooks/purity -- evaluated when the mail data changes, not on the clock
      snoozed: Object.values(snoozed).filter((t) => t > Date.now()).length,
      folder: (id: string) => unread.get(id) ?? 0,
      // eslint-disable-next-line react-hooks/purity -- same: counted when the events change, not on the clock
      meetings: eventsOn(sel, new Date()).filter((e) => Date.parse(e.end) > Date.now()).length,
    };
  }, [emails, folders, accounts, snoozed, events, calendars, hiddenCalendars, accountFilter]);

  const askFromSearch = () => {
    const a = useAssistant.getState();
    const action = searchAskAction({ text: search.text, busy: a.busy });
    if (action === "toggle") return a.toggle();
    a.toggle(true);
    if (action === "ask") {
      void ask(search.text.trim());
      search.change("");
    }
  };


  return (
    <aside className="shell-blur flex h-full w-[264px] shrink-0 flex-col">
      {/* traffic lights live in this strip */}
      <div data-tauri-drag-region className="h-[46px] shrink-0" />

      <div className="flex gap-1.5 px-3">
        <button
          onClick={() => openCompose({ mode: "blank" })}
          className="flex h-8 flex-1 items-center justify-center gap-2 rounded-[9px] bg-primary text-[13px] font-semibold text-primary-foreground shadow-[inset_0_1px_0_oklch(1_0_0/18%),0_1px_2px_oklch(0_0_0/25%)] transition-[filter] hover:brightness-110"
        >
          <PenLine className="size-[15px]" /> New message
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                onClick={() => openCompose({ mode: "ai" })}
                aria-label="Draft with AI"
                className="grid size-8 place-items-center rounded-[9px] bg-foreground/[0.07] text-primary shadow-[inset_0_0_0_1px_var(--hairline)] transition-colors hover:bg-foreground/[0.1]"
              />
            }
          >
            <Sparkles className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="bottom">Draft with AI</TooltipContent>
        </Tooltip>
      </div>

      <div className="mt-2.5 px-3">
        <label className="relative flex h-7 items-center gap-2 rounded-lg bg-foreground/[0.055] px-2.5 text-[12.5px] text-foreground/45 focus-within:ring-2 focus-within:ring-ring/40">
          <Search className="size-3.5" />
          <input
            id="global-search"
            value={search.text}
            onChange={(e) => search.change(e.target.value)}
            onBlur={search.flush}
            onKeyDown={(e) => {
              // Escape clears the search (back to where it started); the app's handler then leaves the box.
              if (e.key === "Escape" && search.text && !e.nativeEvent.isComposing) search.change("");
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                askFromSearch();
              }
            }}
            placeholder="Search"
            className="selectable w-full bg-transparent py-0 pr-6 text-foreground outline-none placeholder:text-foreground/40"
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={askFromSearch}
                  aria-label="Ask zMail (⌘J)"
                  aria-pressed={assistantOpen}
                  className={cn(
                    "absolute top-1/2 right-1 grid size-[22px] -translate-y-1/2 place-items-center rounded-md text-primary transition-colors hover:bg-primary/15",
                    assistantOpen && "bg-primary/15",
                  )}
                />
              }
            >
              <Sparkles className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent side="bottom">Ask zMail ⌘J</TooltipContent>
          </Tooltip>
        </label>
      </div>

      <nav className="mt-2 flex-1 overflow-y-auto px-2 pb-3">
        <AutoReplyStrip />
        <div className="flex h-7 items-center px-2.5 text-[11px] font-semibold tracking-[0.06em] text-foreground/40 uppercase">Mailboxes</div>
        <NavItem view={{ kind: "brief" }} icon={<Sun />} label="Today" shortcut="⌘1" />
        <NavItem view={{ kind: "triage" }} icon={<Columns3 />} label="Triage" shortcut="⌘2" />
        <NavItem view={{ kind: "calendar" }} icon={<CalendarDays />} label="Calendar" shortcut="⌘3" count={counts.meetings} />
        <NavItem view={{ kind: "inbox" }} icon={<Inbox />} label="All Inboxes" count={counts.inbox} hint={counts.inboxHint} />
        <NavItem view={{ kind: "starred" }} icon={<Star />} label="Starred" count={counts.starred} />
        <NavItem view={{ kind: "snoozed" }} icon={<BellOff />} label="Snoozed" count={counts.snoozed} />
        {scheduledCount > 0 && <NavItem view={{ kind: "scheduled" }} icon={<Clock />} label="Scheduled" count={scheduledCount} />}

        {viewKind === "calendar" && (
          <div className="mt-3">
            <div className="flex h-7 items-center px-2.5 text-[11px] font-semibold tracking-[0.06em] text-foreground/40 uppercase">Calendars</div>
            {calendars.map((c) => {
              const on = !hiddenCalendars.has(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggleCalendar(c.id)}
                  className="flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-foreground/75 hover:bg-foreground/[0.04]"
                >
                  <span
                    className="grid size-4 place-items-center rounded-[5px] border-2"
                    style={{ borderColor: `oklch(0.66 0.15 ${c.hue})`, background: on ? `oklch(0.66 0.15 ${c.hue})` : "transparent" }}
                  >
                    {on && <Check className="size-2.5 text-white" strokeWidth={3.5} />}
                  </span>
                  <span className={cn("truncate", !on && "text-foreground/40")}>{c.name}</span>
                </button>
              );
            })}
          </div>
        )}

        {viewKind !== "calendar" && <FolderTrees onSettings={onSettings} />}
      </nav>

      <div className="flex items-center justify-end border-t border-hairline px-3 py-2.5 text-foreground/45">
        <button onClick={onSettings} className="rounded p-1 hover:bg-foreground/[0.07]" aria-label="Settings">
          <Settings className="size-3.5" />
        </button>
      </div>
    </aside>
  );
}
