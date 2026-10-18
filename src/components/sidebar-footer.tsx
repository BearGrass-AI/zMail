// The bottom of the sidebar: a badge per account with its sync light, one status line (an account
// that couldn't sync, an update, a sync under way, or when mail was last synced) and buttons for
// Keyboard Shortcuts and Settings. The status line opens wherever its problem is fixed. In the folded
// sidebar the badges stack, and only a problem, an update or a sync under way keeps its icon.

import { useEffect, useState } from "react";
import { ArrowUp, Check, CircleAlert, Keyboard, Loader2, Settings } from "lucide-react";
import { useMail } from "@/lib/store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSettingsOpen } from "@/lib/settings-open";
import { useUpdates } from "@/lib/updates";
import { cn } from "@/lib/utils";
import { AccountIcon, accountLabel } from "./account-switcher";

/** Badges shown before the rest collapse into "+N". */
const MAX_BADGES = 4;

/** "just now", "2 min ago", "3 hr ago", or a date. */
function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Re-renders once a minute so "2 min ago" stays true. */
function useMinute() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const LIGHT = { ok: "bg-emerald-500", syncing: "bg-amber-500", error: "bg-destructive" } as const;

const iconButton = "relative grid size-7 shrink-0 place-items-center rounded-md text-foreground/45 hover:bg-foreground/[0.07] hover:text-foreground/70";

export function SidebarFooter({ onSettings, collapsed = false }: { onSettings: () => void; collapsed?: boolean }) {
  const accounts = useMail((s) => s.accounts);
  const status = useMail((s) => s.accountStatus);
  const refresh = useMail((s) => s.refresh);
  const update = useUpdates((s) => s.status);
  const now = useMinute();
  const show = (section: string) => useSettingsOpen.getState().show(section);

  const failed = accounts.find((a) => status[a.id]?.state === "error");
  const syncing = accounts.filter((a) => status[a.id]?.state === "syncing");
  const updateTo = update.kind === "available" || update.kind === "installed" ? update.version : null;
  // The account synced longest ago decides "Synced …", so the line is true for every account.
  const synced = accounts.map((a) => status[a.id]?.at).filter((t): t is number => typeof t === "number");
  const oldest = synced.length === accounts.length && synced.length > 0 ? Math.min(...synced) : null;
  const demo = accounts.length > 0 && accounts.every((a) => a.kind === "mock");

  const line = "flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md px-1 py-0.5 text-left text-[11.5px] [&_svg]:size-3 [&_svg]:shrink-0";
  let statusLine;
  if (failed) {
    statusLine = (
      <button className={cn(line, "text-destructive hover:bg-destructive/10")} onClick={() => show("accounts")} title={status[failed.id]?.error}>
        <CircleAlert />
        <span className="truncate">{accountLabel(failed, accounts)} couldn't sync</span>
      </button>
    );
  } else if (updateTo) {
    statusLine = (
      <button className={cn(line, "font-medium text-primary hover:bg-primary/10")} onClick={() => show("about")}>
        <ArrowUp />
        <span className="truncate">{update.kind === "installed" ? `Relaunch for ${updateTo}` : `Update to ${updateTo} available`}</span>
      </button>
    );
  } else if (syncing.length) {
    statusLine = (
      <span className={cn(line, "text-foreground/50")}>
        <Loader2 className="animate-spin" />
        <span className="truncate">{syncing.length === 1 ? `Syncing ${accountLabel(syncing[0], accounts)}…` : "Syncing…"}</span>
      </span>
    );
  } else if (demo) {
    statusLine = <span className={cn(line, "text-foreground/50")}>Demo mailbox</span>;
  } else {
    statusLine = (
      <button className={cn(line, "text-foreground/50 hover:bg-foreground/[0.07]")} onClick={() => void refresh()} title="Check for new mail">
        {oldest !== null && <Check className="text-emerald-500" />}
        <span className="truncate">{oldest !== null ? `Synced ${ago(oldest, now)}` : "Not synced yet"}</span>
      </button>
    );
  }

  const shown = accounts.slice(0, MAX_BADGES);
  const badges = shown.map((a) => {
    const st = status[a.id];
    const label = accountLabel(a, accounts);
    const title = st?.state === "error" ? `${label} couldn't sync` : st?.state === "syncing" ? `${label} is syncing` : st?.at ? `${label} synced ${ago(st.at, now)}` : label;
    return (
      <span key={a.id} className="relative" title={title}>
        <AccountIcon account={a} size={18} />
        {st && <i className={cn("absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full ring-[1.5px] ring-shell", LIGHT[st.state])} />}
      </span>
    );
  });
  const more = accounts.length > MAX_BADGES && <span className="text-[11px] text-foreground/40 tabular-nums">+{accounts.length - MAX_BADGES}</span>;
  const settings = (
    <button className={iconButton} onClick={onSettings} aria-label={updateTo ? "Settings (update available)" : "Settings"} title="Settings">
      <Settings className="size-3.5" />
      {updateTo && <span className="absolute top-1 right-1 size-[7px] rounded-full bg-primary ring-[1.5px] ring-shell" />}
    </button>
  );

  if (collapsed) {
    let alert = null;
    if (failed) alert = { icon: <CircleAlert />, text: `${accountLabel(failed, accounts)} couldn't sync`, tone: "text-destructive hover:bg-destructive/10", go: () => show("accounts") };
    else if (updateTo) alert = { icon: <ArrowUp />, text: update.kind === "installed" ? `Relaunch for ${updateTo}` : `Update to ${updateTo} available`, tone: "text-primary hover:bg-primary/10", go: () => show("about") };
    else if (syncing.length) alert = { icon: <Loader2 className="animate-spin" />, text: syncing.length === 1 ? `Syncing ${accountLabel(syncing[0], accounts)}…` : "Syncing…", tone: "text-foreground/50" };
    return (
      <div className="flex flex-col items-center gap-2 py-2.5">
        {badges}
        {more}
        {alert && (
          <Tooltip>
            <TooltipTrigger
              render={<button onClick={alert.go} aria-label={alert.text} className={cn("grid size-7 place-items-center rounded-md [&_svg]:size-3.5", alert.tone)} />}
            >
              {alert.icon}
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6}>{alert.text}</TooltipContent>
          </Tooltip>
        )}
        {settings}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-t border-hairline py-2 pr-2 pl-3">
      {shown.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5">
          {badges}
          {more}
        </div>
      )}
      {statusLine}
      <button className={iconButton} onClick={() => show("shortcuts")} aria-label="Keyboard shortcuts" title="Keyboard shortcuts">
        <Keyboard className="size-3.5" />
      </button>
      {settings}
    </div>
  );
}
