// Mass select: hover checkboxes on rows, ⌘/⇧-click, and the floating bar that
// acts on every ticked email. The open email (selectedId) stays separate.

import type { MouseEvent, ReactNode } from "react";
import { SPRING } from "@/lib/motion";
import { AnimatePresence, motion } from "motion/react";
import { Archive, BellOff, Check, Folder as FolderIcon, Mail, MailOpen, OctagonAlert, Trash2, X } from "lucide-react";
import { orderedEmails, useMail } from "@/lib/store";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { snoozeTimes, useEmailActions } from "./email-actions";

/**
 * Click behavior shared by every row: plain click opens, ⌘ toggles, ⇧ extends a range.
 * While anything is ticked, a plain click ticks or unticks instead of opening.
 */
export function useRowSelect(id: string, order?: () => string[]) {
  const checked = useMail((s) => s.checked.has(id));
  const selecting = useMail((s) => s.checked.size > 0);
  const onClick = (e: MouseEvent) => {
    const s = useMail.getState();
    if (e.metaKey || e.ctrlKey || (s.checked.size > 0 && !e.shiftKey)) return s.toggleCheck(id);
    if (e.shiftKey) {
      e.preventDefault();
      return s.checkRange(id, order?.() ?? orderedEmails(s).map((x) => x.id));
    }
    s.select(id);
  };
  const onCheck = (e: MouseEvent) => {
    e.stopPropagation();
    const s = useMail.getState();
    if (e.shiftKey) s.checkRange(id, order?.() ?? orderedEmails(s).map((x) => x.id));
    else s.toggleCheck(id);
  };
  return { checked, selecting, onClick, onCheck };
}

/**
 * Checkbox that sits where the avatar (or tile) is. Hidden until the row is
 * hovered; always shown once anything is selected. `children` is the avatar.
 */
export function RowCheck({
  checked,
  selecting,
  onCheck,
  size = 32,
  children,
}: {
  checked: boolean;
  selecting: boolean;
  onCheck: (e: MouseEvent) => void;
  size?: number;
  children?: ReactNode;
}) {
  const show = checked || selecting;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {children && <div className={cn("transition-opacity duration-100", show ? "opacity-0" : "group-hover:opacity-0")}>{children}</div>}
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={checked ? "Deselect" : "Select"}
        onClick={onCheck}
        className={cn(
          "absolute inset-0 grid place-items-center transition-opacity duration-100",
          show ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <span
          className={cn(
            "grid size-[18px] place-items-center rounded-[5px] border-[1.5px] transition-colors",
            checked ? "border-primary bg-primary text-primary-foreground" : "border-foreground/35 bg-[var(--pane)] hover:border-foreground/60",
          )}
        >
          {checked && <Check className="size-3" strokeWidth={3} />}
        </span>
      </button>
    </div>
  );
}

/**
 * "Select all N" for a section or lane; shown on header hover and while selecting. `fit` shortens
 * the label to fit a narrow `@container/lane` header, keeping the full wording as its name and tooltip.
 */
export function SelectAll({ ids, className, fit }: { ids: string[]; className?: string; fit?: boolean }) {
  const selecting = useMail((s) => s.checked.size > 0);
  const all = useMail((s) => ids.length > 0 && ids.every((id) => s.checked.has(id)));
  if (!ids.length) return null;
  const label = all ? "Deselect all" : `Select all ${ids.length}`;
  return (
    <button
      aria-label={fit ? label : undefined}
      title={fit ? label : undefined}
      onClick={() => {
        const s = useMail.getState();
        const next = new Set(s.checked);
        for (const id of ids) all ? next.delete(id) : next.add(id);
        s.setChecked([...next]);
      }}
      className={cn(
        "h-6 rounded-md px-1.5 text-[12px] font-medium text-primary transition-opacity hover:bg-primary/10",
        selecting ? "opacity-100" : "opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100",
        fit && all && "@max-[295px]/lane:bg-primary/15",
        className,
      )}
    >
      {fit ? (
        // Widths measured for Can go beside "Archive all N": the full label needs 320px inside the header padding.
        <>
          <span className="@max-[319px]/lane:hidden">{label}</span>
          <span className="hidden @max-[319px]/lane:inline @max-[295px]/lane:hidden">{all ? "Deselect" : "Select all"}</span>
          {/* Narrowest: "All" either way, filled while everything is ticked. */}
          <span className="hidden @max-[295px]/lane:inline">All</span>
        </>
      ) : (
        label
      )}
    </button>
  );
}

function BarButton({ label, kbd, onClick, children, danger }: { label: string; kbd?: string; onClick?: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] whitespace-nowrap text-foreground/85 hover:bg-foreground/[0.08] [&_svg]:size-[15px]",
        danger && "hover:text-destructive",
      )}
    >
      {children}
      <span className="@max-[720px]/bar:hidden">{label}</span>
      {kbd && <kbd className="kbd @max-[900px]/bar:hidden">{kbd}</kbd>}
    </button>
  );
}

/** Floating bar for the ticked emails. Mount inside a `relative` pane. */
export function BulkBar() {
  // Select the Set itself (stable reference); a fresh array per render would loop.
  const checked = useMail((s) => s.checked);
  const ids = [...checked];
  const anyUnread = useMail((s) => s.emails.some((e) => s.checked.has(e.id) && e.unread));
  const snoozeOpen = useMail((s) => s.bulkSnoozeOpen);
  const { clearChecked, setBulkSnoozeOpen, openMovePicker } = useMail.getState();
  const a = useEmailActions();
  const n = ids.length;

  return (
    <div className="@container/bar pointer-events-none absolute inset-x-0 bottom-5 z-30 flex justify-center px-4">
      <AnimatePresence>
        {n > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={SPRING}
            className="pointer-events-auto flex max-w-full items-center gap-0.5 rounded-2xl bg-popover p-1.5 text-popover-foreground shadow-[0_12px_32px_-8px_oklch(0_0_0/40%)] ring-1 ring-foreground/10"
          >
            <div className="px-2.5 leading-tight">
              <div className="text-[13px] font-semibold tabular-nums">{n} selected</div>
              <div className="text-[10.5px] text-foreground/40 @max-[720px]/bar:hidden">Esc to clear</div>
            </div>
            <span className="mx-1 h-6 w-px bg-hairline" />
            <BarButton label="Archive" kbd="E" onClick={() => void a.archive(ids)}>
              <Archive />
            </BarButton>
            <BarButton label="Delete" kbd="#" danger onClick={() => void a.trash(ids)}>
              <Trash2 />
            </BarButton>
            <BarButton label="Move…" kbd="V" onClick={() => openMovePicker({ ids, mode: "move" })}>
              <FolderIcon />
            </BarButton>
            <BarButton label={anyUnread ? "Mark read" : "Mark unread"} kbd="U" onClick={() => a.read(ids, anyUnread)}>
              {anyUnread ? <MailOpen /> : <Mail />}
            </BarButton>
            <DropdownMenu open={snoozeOpen} onOpenChange={setBulkSnoozeOpen}>
              <DropdownMenuTrigger className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-foreground/85 hover:bg-foreground/[0.08] data-popup-open:bg-foreground/[0.08] [&_svg]:size-[15px]">
                <BellOff />
                <span className="@max-[720px]/bar:hidden">Snooze</span>
                <kbd className="kbd @max-[900px]/bar:hidden">S</kbd>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="center" className="w-56">
                {snoozeTimes().map((t) => (
                  <DropdownMenuItem key={t.label} onClick={() => a.snooze(ids, t.at, t.label)}>
                    {t.label} <span className="ml-auto text-xs text-muted-foreground">{t.hint}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <BarButton label="Spam" kbd="!" onClick={() => void a.spam(ids)}>
              <OctagonAlert />
            </BarButton>
            <span className="mx-1 h-6 w-px bg-hairline" />
            <button onClick={clearChecked} aria-label="Clear selection" className="grid size-8 place-items-center rounded-lg text-foreground/50 hover:bg-foreground/[0.08] hover:text-foreground">
              <X className="size-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
