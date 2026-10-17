import { useEffect, useRef } from "react";
import { EASE_OUT } from "@/lib/motion";
import { useSettingsOpen } from "@/lib/settings-open";
import { motion } from "motion/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/topbar";
import { BriefView } from "@/components/brief/brief-view";
import { TriageView } from "@/components/triage/triage-view";
import { CalendarView } from "@/components/calendar/calendar-view";
import { EmptyReader, MailList } from "@/components/mail/mail-list";
import { SearchResults } from "@/components/mail/search-results";
import { Reader } from "@/components/mail/reader";
import { Composer } from "@/components/mail/composer";
import { ScheduledView } from "@/components/mail/scheduled-view";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { FolderPicker } from "@/components/folder-picker";
import { NewEventDialog } from "@/components/calendar/new-event-dialog";
import { useApplyTheme } from "@/lib/theme";
import { hydrateApiKeys, useSettings } from "@/lib/settings";
import { composerActive, orderedEmails, useMail } from "@/lib/store";
import { BulkBar } from "@/components/selection";
import { emailActions } from "@/components/email-actions";
import { installPressFeedback } from "@/lib/press";
import { SetView } from "@/components/assistant/set-view";
import { AssistantPanel } from "@/components/assistant/assistant-panel";
import { ErrorBoundary } from "@/components/error-boundary";
import { clampWidth, useDragWidth } from "@/lib/ai/assistant/panel-width";
import { useAssistant, listKeyBlocked, loadAssistant, startAssistantAutosave } from "@/lib/ai/assistant/state";
import { startNotifications } from "@/lib/notifications";
import { handleZoomKey } from "@/lib/page-zoom";

function useShortcuts(openSettings: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const s = useMail.getState();
      const mod = e.metaKey || e.ctrlKey;
      // ⌘+ / ⌘− / ⌘0 zoom everywhere, text fields included, as in Safari.
      if (handleZoomKey(e)) return;
      if (mod && e.key === "k") {
        e.preventDefault();
        return document.getElementById("global-search")?.focus();
      }
      if (mod && e.key === "j") {
        e.preventDefault();
        return useAssistant.getState().toggle();
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        return openSettings();
      }
      if (mod && e.key === "a" && !target.closest("input, textarea, [contenteditable]") && !document.querySelector('[role="dialog"]')) {
        e.preventDefault();
        // In an assistant set the inbox list is hidden; selecting it would tick mail the user can't see.
        // Search results show in place of a set, so their list is the one to select.
        if (listKeyBlocked(e.key, true, s.search ? null : useAssistant.getState().activeSetId)) return;
        return s.setChecked(orderedEmails(s).map((x) => x.id));
      }
      // ⌘⇧0 = all accounts, ⌘⇧1… = one account (e.code: Shift changes e.key to symbols).
      if (mod && e.shiftKey && /^Digit\d$/.test(e.code)) {
        e.preventDefault();
        const n = Number(e.code.slice(5));
        if (n === 0) return s.setAccountFilter(null);
        const a = s.accounts[n - 1];
        return a && s.setAccountFilter(a.id);
      }
      if (mod && (e.key === "1" || e.key === "2" || e.key === "3")) {
        e.preventDefault();
        return s.setView({ kind: e.key === "1" ? "brief" : e.key === "2" ? "triage" : "calendar" });
      }
      if (e.key === "Escape") {
        if (target.closest("input, textarea")) return (target as HTMLInputElement).blur();
        if (s.compose) return s.closeCompose();
        if (s.checked.size) return s.clearChecked();
        if (s.selectedId) return s.select(null);
        return;
      }
      if (target.closest("input, textarea, [contenteditable], [role=menu]") || mod) return;
      if (document.querySelector('[role="dialog"]')) return;
      // While a composer is open or opening, single keys never act on mail: not the email being answered, not the list.
      if (composerActive()) return;
      if (listKeyBlocked(e.key, false, s.search ? null : useAssistant.getState().activeSetId)) return;

      const list = orderedEmails(s);
      const idx = list.findIndex((x) => x.id === s.selectedId);
      const id = s.selectedId;
      const email = list.find((x) => x.id === id) ?? s.emails.find((x) => x.id === id);
      const a = emailActions();
      // With rows ticked, the action keys apply to all of them.
      const bulk = s.checked.size ? [...s.checked] : null;
      if (bulk) {
        const unread = s.emails.some((x) => s.checked.has(x.id) && x.unread);
        const handled: Record<string, () => void> = {
          e: () => void a.archive(bulk),
          "#": () => void a.trash(bulk),
          Backspace: () => void a.trash(bulk),
          "!": () => void a.spam(bulk),
          v: () => a.pickFolder(bulk),
          u: () => a.read(bulk, unread),
          d: () => a.done(bulk),
          s: () => s.setBulkSnoozeOpen(true),
        };
        if (handled[e.key]) {
          e.preventDefault();
          return handled[e.key]();
        }
      }
      switch (e.key) {
        case "x":
          if (id) s.toggleCheck(id);
          break;
        case "!":
          if (id) void a.spam([id]);
          break;
        case "j":
        case "ArrowDown":
          s.select(list[Math.min(idx + 1, list.length - 1)]?.id ?? null);
          break;
        case "k":
        case "ArrowUp":
          s.select(list[Math.max(idx - 1, 0)]?.id ?? null);
          break;
        case "e":
          if (id) void a.archive([id]);
          break;
        case "#":
        case "Backspace":
          if (id) void a.trash([id]);
          break;
        case "s":
          if (id) a.star(id);
          break;
        case "d":
          if (id) a.done([id]);
          break;
        case "u":
          if (email) a.read([email.id], email.unread);
          break;
        case "r":
          if (id) s.openCompose({ mode: "blank", replyTo: id });
          break;
        case "a":
          if (id) s.openCompose({ mode: "blank", replyTo: id, all: true });
          break;
        case "R":
          if (id) s.openCompose({ mode: "ai", replyTo: id });
          break;
        case "f":
          if (id) s.openCompose({ mode: "blank", replyTo: id, forward: true });
          break;
        case "c":
          s.openCompose({ mode: "blank" });
          break;
        case "v":
          if (id) s.openMovePicker({ ids: [id], mode: "move" });
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSettings]);
}

/** Suppress the browser's default context menu outside text fields and readable text. */
function useNoNativeContextMenu() {
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, .selectable")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onMenu);
    return () => window.removeEventListener("contextmenu", onMenu);
  }, []);
}

export default function App() {
  useApplyTheme();
  useNoNativeContextMenu();
  useEffect(() => installPressFeedback(), []);
  const settingsOpen = useSettingsOpen((s) => s.open);
  const setSettingsOpen = useSettingsOpen((s) => s.setOpen);
  const view = useMail((s) => s.view);
  const selectedId = useMail((s) => s.selectedId);
  const compose = useMail((s) => s.compose);
  // Error boundaries around the overlays retry when they open again.
  const pickerKey = useMail((s) => s.movePicker);
  const newEvent = useMail((s) => s.newEvent);
  const load = useMail((s) => s.load);
  const assistantOpen = useAssistant((s) => s.open);
  const assistantWidth = useSettings((s) => s.assistantWidth);
  const dragWidth = useDragWidth((s) => s.live);
  const activeSetId = useAssistant((s) => s.activeSetId);
  // Leave an assistant set when the user picks any sidebar view, even the current one: setView always
  // stores a new view object, so compare identity. reviewSet changes the view and sets the active set
  // in a microtask, so only clear if the set didn't change alongside the view.
  const firstView = useRef(view);
  const prevSetId = useRef(activeSetId);
  useEffect(() => {
    if (view !== firstView.current && useAssistant.getState().activeSetId === prevSetId.current) useAssistant.getState().showSet(null);
    firstView.current = view;
  }, [view]);
  useEffect(() => {
    prevSetId.current = activeSetId;
  }, [activeSetId]);
  useShortcuts(() => useSettingsOpen.getState().show());

  useEffect(() => {
    // Each step logs its own failure, so one rejection doesn't silently skip the rest.
    const failed = (step: string) => (err: unknown) => console.error(`[startup] ${step}`, err);
    // Keys first, so the initial sort can use a configured provider.
    const loaded = hydrateApiKeys()
      .catch(failed("hydrateApiKeys"))
      .then(() => load())
      .catch(failed("load"));
    void loaded.then(() => startNotifications()).catch(failed("startNotifications"));
    void loaded
      .then(() => loadAssistant())
      .catch(failed("loadAssistant"))
      .then(() => startAssistantAutosave())
      .catch(failed("startAssistantAutosave"));
  }, [load]);

  const detail = compose ? "compose" : selectedId ? "reader" : null;
  // Search mode shows its results in the list pane from any mail view, Today and Triage included.
  const searching = useMail((s) => !!s.search);
  const isList = searching || view.kind === "inbox" || view.kind === "starred" || view.kind === "snoozed" || view.kind === "folder";

  return (
    <TooltipProvider delay={500}>
      <div className="flex h-full">
        <ErrorBoundary label="the sidebar">
          <Sidebar onSettings={() => useSettingsOpen.getState().show()} />
        </ErrorBoundary>
        <main className="flex min-w-0 flex-1 py-2 pr-2">
          {isList ? (
            <div className="pane relative flex min-w-0 flex-1 overflow-hidden rounded-2xl">
              <div className="flex w-[380px] shrink-0 flex-col border-r border-hairline xl:w-[420px]">
                <TopBar />
                <div className="min-h-0 flex-1">
                  <ErrorBoundary label="the mail list" resetKey={`${JSON.stringify(view)}|${activeSetId ?? ""}|${searching}`}>
                    {searching ? <SearchResults /> : activeSetId ? <SetView key={activeSetId} /> : <MailList />}
                  </ErrorBoundary>
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <ErrorBoundary label={compose ? "the composer" : "this email"} resetKey={compose ?? selectedId}>
                  {compose ? <Composer /> : selectedId ? <Reader /> : <EmptyReader />}
                </ErrorBoundary>
              </div>
              <BulkBar />
            </div>
          ) : (
            <div data-detail={detail ? "" : undefined} className="group/main pane relative flex min-w-0 flex-1 overflow-hidden rounded-2xl">
              <div className="flex min-w-0 flex-1 flex-col">
                <TopBar />
                <div className="min-h-0 flex-1">
                  <ErrorBoundary label="this view" resetKey={view.kind}>
                    {view.kind === "brief" ? <BriefView /> : view.kind === "triage" ? <TriageView /> : view.kind === "scheduled" ? <ScheduledView /> : <CalendarView />}
                  </ErrorBoundary>
                </div>
              </div>
              {detail && (
                <aside className="shrink-0 overflow-hidden border-l border-hairline" style={{ width: "min(56%, 820px)" }}>
                  <motion.div
                    className="h-full min-w-[460px]"
                    initial={{ opacity: 0, transform: "translateX(24px)" }}
                    animate={{ opacity: 1, transform: "translateX(0px)" }}
                    transition={{ duration: 0.2, ease: EASE_OUT }}
                  >
                    <ErrorBoundary label={detail === "compose" ? "the composer" : "this email"} resetKey={compose ?? selectedId}>
                      {detail === "compose" ? <Composer /> : <Reader />}
                    </ErrorBoundary>
                  </motion.div>
                </aside>
              )}
              <BulkBar />
            </div>
          )}
        </main>
        {assistantOpen && (
          <div className="shrink-0 overflow-hidden py-2 pr-2" style={{ width: clampWidth(dragWidth ?? assistantWidth, window.innerWidth) + 8 }}>
            <motion.div
              className="h-full"
              initial={{ opacity: 0, transform: "translateX(24px)" }}
              animate={{ opacity: 1, transform: "translateX(0px)" }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
            >
              <ErrorBoundary label="the assistant">
                <AssistantPanel />
              </ErrorBoundary>
            </motion.div>
          </div>
        )}
      </div>
      <ErrorBoundary label="Settings" quiet resetKey={settingsOpen} onError={() => setSettingsOpen(false)}>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </ErrorBoundary>
      <ErrorBoundary label="Move to" quiet resetKey={pickerKey} onError={() => useMail.getState().openMovePicker(null)}>
        <FolderPicker />
      </ErrorBoundary>
      <ErrorBoundary label="the new event dialog" quiet resetKey={newEvent} onError={() => useMail.getState().openNewEvent(null)}>
        <NewEventDialog />
      </ErrorBoundary>
      <Toaster position="bottom-center" />
    </TooltipProvider>
  );
}
