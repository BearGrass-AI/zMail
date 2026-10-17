import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { SPRING_PILL } from "@/lib/motion";
import { motion } from "motion/react";
import { CalendarDays, ChevronDown, Columns3, RefreshCw, Sparkles, Sun } from "lucide-react";
import { backfillLine, bucketOf, homeInbox, listEmails, useMail, type View } from "@/lib/store";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Account, Folder } from "@/lib/types";
import { RefreshButton } from "./refresh-button";
import { AccountSwitcher, accountLabel } from "./account-switcher";

function title(v: View, folders: Folder[], accounts: Account[]) {
  switch (v.kind) {
    case "inbox":
      return "All Inboxes";
    case "starred":
      return "Starred";
    case "snoozed":
      return "Snoozed";
    case "scheduled":
      return "Scheduled";
    case "folder": {
      const f = folders.find((x) => x.id === v.folderId);
      if (!f) return "Folder";
      const acct = accounts.find((a) => a.id === f.accountId)?.name;
      return f.system ? `${f.name} · ${acct}` : f.name;
    }
    default:
      return "";
  }
}

const MODES = [
  { kind: "brief", label: "Today", key: "⌘1", icon: Sun },
  { kind: "triage", label: "Triage", key: "⌘2", icon: Columns3 },
  { kind: "calendar", label: "Calendar", key: "⌘3", icon: CalendarDays },
] as const;

/**
 * The re-sort items. Rendered inside the menu content, so the inbox scans below
 * only run while the menu is open. The "Can go" ids are computed on click.
 */
function ReSortItems() {
  const running = useMail((s) => s.sorting.running);
  // Follows the account switch: with Outlook picked, only Outlook mail is re-sorted.
  const inboxCount = useMail((s) => homeInbox(s).length);
  const canGoCount = useMail((s) => canGoIds(s).length);
  const account = useMail((s) => (s.accountFilter ? s.accounts.find((a) => a.id === s.accountFilter) : undefined));
  const accounts = useMail((s) => s.accounts);
  const where = account ? `${accountLabel(account, accounts)} ` : "";
  return (
    <>
      {canGoCount > 0 && (
        <DropdownMenuItem disabled={running} onClick={() => void useMail.getState().sort({ ids: canGoIds(useMail.getState()) })}>
          <Sparkles className="text-primary" /> Re-sort {canGoCount} {where}in Can go &amp; Notifications
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        disabled={running || !inboxCount}
        onClick={() => {
          const s = useMail.getState();
          void s.sort(s.accountFilter ? { ids: homeInbox(s).map((e) => e.id) } : undefined);
        }}
      >
        <Sparkles className="text-primary" /> Re-sort all {inboxCount} {where}inbox emails
      </DropdownMenuItem>
    </>
  );
}

// The mail the category rules affect most: everything in Can go plus Notifications
// elsewhere. Corrected emails are left alone (your correction wins anyway).
function canGoIds(s: ReturnType<typeof useMail.getState>) {
  return homeInbox(s)
    .filter((e) => !s.categoryOverrides[e.id] && (bucketOf(s, e.id) === "ready_archive" || s.triage[e.id]?.category === "updates"))
    .map((e) => e.id);
}

export function TopBar() {
  const view = useMail((s) => s.view);
  const folders = useMail((s) => s.folders);
  const accounts = useMail((s) => s.accounts);
  const sorting = useMail((s) => s.sorting);
  const backfill = useMail((s) => s.backfill);
  const setView = useMail((s) => s.setView);
  const refresh = useMail((s) => s.refresh);
  const loadingOlder = useMemo(() => backfillLine(backfill), [backfill]);
  const isHome = view.kind === "brief" || view.kind === "triage" || view.kind === "calendar";
  // listEmails reads only these slices (same selector as mail-list); home views skip the count.
  const scheduledCount = useMail((s) => s.scheduled.length);
  // While searching, the results header carries the count; the view's own would contradict it.
  const searching = useMail((s) => !!s.search);
  const slices = useMail(useShallow((s) => ({ emails: s.emails, query: s.query, folders: s.folders, snoozed: s.snoozed })));
  const listCount = useMemo(() => {
    if (isHome) return 0;
    if (view.kind === "scheduled") return scheduledCount;
    return listEmails({ ...slices, view } as Parameters<typeof listEmails>[0]).length;
  }, [isHome, view, scheduledCount, slices]);

  return (
    <header data-tauri-drag-region className="flex h-12 min-w-0 shrink-0 items-center gap-3 overflow-hidden px-4">
      {isHome ? (
        <div className="inline-flex shrink-0 rounded-[9px] bg-foreground/[0.055] p-0.5">
          {MODES.map((m) => (
            <button
              key={m.kind}
              onClick={() => setView({ kind: m.kind })}
              title={m.key}
              className="relative h-7 rounded-[7px] px-3 text-[12.5px] font-medium"
            >
              {view.kind === m.kind && (
                <motion.span
                  layoutId="mode-pill"
                  className="absolute inset-0 rounded-[7px] bg-[var(--pane)] shadow-[0_1px_2px_oklch(0_0_0/10%),0_0_0_1px_var(--hairline)]"
                  transition={SPRING_PILL}
                />
              )}
              <span className={cn("relative flex items-center gap-1.5", view.kind !== m.kind && "text-foreground/50")}>
                <m.icon className="size-[13px]" />
                {m.label}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <h1 data-tauri-drag-region className="text-[15px] font-semibold tracking-tight">
          {title(view, folders, accounts)}
          {!searching && <span className="ml-2 text-[12.5px] font-normal text-foreground/40 tabular-nums">{listCount}</span>}
        </h1>
      )}
      {isHome && <AccountSwitcher />}
      {loadingOlder && <span className="ml-auto min-w-0 truncate text-[12px] text-foreground/40 tabular-nums">{loadingOlder}</span>}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-[12px] whitespace-nowrap text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/70 data-popup-open:bg-foreground/[0.06]",
            !loadingOlder && "ml-auto",
          )}
        >
          <span className="truncate">
            {sorting.running ? `Sorting ${sorting.done}/${sorting.total}…` : sorting.error ? <span className="text-destructive" title={sorting.error}>Sort failed</span> : sorting.model ? (
              <>
                Sorted by {sorting.model}
                {sorting.failed && (
                  <span className="text-destructive" title={sorting.failed.error}>
                    {" "}
                    · {sorting.failed.count} not sorted
                  </span>
                )}
              </>
            ) : (
              "Sorting"
            )}
          </span>
          <ChevronDown className="size-3 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem onClick={() => void refresh()}>
            <RefreshCw /> Check for new mail
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-[11px] leading-snug text-foreground/45">
            New mail is sorted automatically. Re-sorting sends those emails to {sorting.model ?? "the decision model"} again, one request each.
          </p>
          <ReSortItems />
        </DropdownMenuContent>
      </DropdownMenu>
      <RefreshButton className="grid size-7 shrink-0 place-items-center rounded-md text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground" />
    </header>
  );
}
