import { memo, useEffect, useState } from "react";
import { QUICK, ROW_MOTION } from "@/lib/motion";
import { motion } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { Check, Folder as FolderIcon, Paperclip, Star, X } from "lucide-react";
import type { Email } from "@/lib/types";
import { categoryOf, folderPath, sameDay, suggestionFor, useMail } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { generativeProvider } from "@/lib/ai/providers";
import { oneLiner } from "@/lib/ai/generative";
import { cn } from "@/lib/utils";
import { EmailContextMenu, QuickActions, useEmailActions } from "../email-actions";
import { CATEGORY_META } from "@/lib/meta";
import { SenderAvatar, Tile, relTime } from "../meta";
import { EventChip } from "../event-chip";
import { DateChip, SectionTag } from "../date-chip";
import { Flag } from "lucide-react";
import { RowCheck, useRowSelect } from "../selection";
import { AccountDot } from "../account-switcher";

const lineCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

/** Lazily fetch (and cache) the AI one-liner for an email. */
export function useOneLiner(email: Email, enabled = true) {
  const [line, setLine] = useState(lineCache.get(email.id));
  useEffect(() => {
    if (!enabled || lineCache.has(email.id)) return;
    let live = true;
    const p = inflight.get(email.id) ?? oneLiner(generativeProvider(), email);
    inflight.set(email.id, p);
    p.then((l) => {
      lineCache.set(email.id, l);
      if (live) setLine(l);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the one-liner is cached per email.id; a refreshed copy of the same email must not refetch
  }, [email.id, enabled]);
  return line;
}

/** Inline "→ Folder ✓" chip for a confident folder suggestion. */
export function FolderChip({ email }: { email: Email }) {
  const a = useEmailActions();
  const threshold = useSettings((x) => x.suggestThreshold);
  const sug = useMail(useShallow((s) => suggestionFor(s, email, threshold)));
  const folders = useMail((s) => s.folders);
  const dismissSuggestion = useMail((s) => s.dismissSuggestion);
  if (!sug) return null;
  const where = folderPath(folders, sug.folderId);
  const title = sug.rule
    ? `${where} · your rule: always file ${email.from.name} here`
    : sug.evidence?.total
      ? `${where} · you filed ${sug.evidence.filed} of ${sug.evidence.total} from this sender here · ${Math.round(sug.probability * 100)}%`
      : `${where} · ${Math.round(sug.probability * 100)}% confident`;

  return (
    <span
      onClick={(e) => e.stopPropagation()}
      title={title}
      className="group/chip inline-flex h-[22px] shrink-0 items-center overflow-hidden rounded-full bg-primary/[0.09] text-[11.5px] font-medium text-primary"
    >
      <button
        onClick={() => void a.move([email.id], sug.folderId)}
        className="flex h-full items-center gap-1.5 pr-1.5 pl-2 hover:bg-primary/10"
      >
        <FolderIcon className="size-3" strokeWidth={2} />
        {sug.folder.name}
        <Check className="size-3" />
      </button>
      <button
        onClick={() => dismissSuggestion([email.id])}
        aria-label="Dismiss suggestion"
        className="hidden h-full items-center pr-1.5 pl-0.5 text-primary/60 hover:text-primary group-hover/chip:flex"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/** Two-line row with the AI one-liner, for mail that needs attention. */
export const RichRow = memo(function RichRow({ email }: { email: Email }) {
  const selected = useMail((s) => s.selectedId === email.id);
  const sel = useRowSelect(email.id);
  const line = useOneLiner(email);
  const t = useMail((s) => s.triage[email.id]);
  const junk = useMail((s) => s.folders.find((f) => f.id === email.folderId)?.system === "spam");
  // "Today" in the text only means today for mail that arrived today.
  const due = (t?.urgency ?? 0) > 0.5 && sameDay(new Date(email.date), new Date()) && /today|eod|end of day|tonight/i.test(email.text);

  return (
    <motion.div {...ROW_MOTION} className="overflow-hidden">
      <EmailContextMenu email={email}>
        <div
          onClick={sel.onClick}
          className={cn(
            "group relative -mx-3 flex cursor-default gap-3 rounded-xl px-3 py-2.5 transition-colors select-none",
            sel.checked ? "bg-primary/[0.13]" : selected ? "bg-primary/[0.08]" : "hover:bg-foreground/[0.035]",
          )}
        >
          <RowCheck checked={sel.checked} selecting={sel.selecting} onCheck={sel.onCheck}>
            <div className="relative">
              <SenderAvatar contact={email.from} junk={junk} />
              {email.unread && <span className="absolute -top-0.5 -left-0.5 size-2.5 rounded-full border-2 border-[var(--pane)] bg-primary" />}
              <AccountDot accountId={email.accountId} />
            </div>
          </RowCheck>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className={cn("shrink-0 text-[13.5px]", email.unread ? "font-semibold" : "font-medium")}>{email.from.name}</span>
              <span className="truncate text-[13.5px] text-foreground/85">{email.subject}</span>
              <span className={cn("ml-auto shrink-0 pl-2 text-[12px] text-foreground/40 tabular-nums transition-opacity", !sel.selecting && "group-hover:opacity-0")}>
                {relTime(email.date)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[12.5px]">
              <span className="text-primary">✦</span>
              {line === undefined ? (
                <span className="h-2.5 w-2/3 animate-pulse rounded bg-foreground/[0.07]" />
              ) : (
                <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={QUICK} className="truncate text-foreground/55">
                  {line || email.snippet}
                </motion.span>
              )}
              {due && (
                <span
                  style={{ "--h": "var(--h-needs_you)" } as React.CSSProperties}
                  className="tint tint-chip inline-flex h-[21px] shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium"
                >
                  <Flag className="size-3" /> Due today
                </span>
              )}
              <SectionTag email={email} />
              <DateChip email={email} />
              <EventChip email={email} />
              {email.starred && <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />}
              {!!email.attachments?.length && <Paperclip className="size-3 shrink-0 text-foreground/40" />}
            </div>
          </div>
          {!sel.selecting && <QuickActions email={email} />}
        </div>
      </EmailContextMenu>
    </motion.div>
  );
});

/** One-line row: sender · subject · chip · time. `flag`: urgent mail a section keeps out of Needs you. */
export function CompactRow({ email, showSnippet, order, flag }: { email: Email; showSnippet?: boolean; order?: () => string[]; flag?: boolean }) {
  const selected = useMail((s) => s.selectedId === email.id);
  // `order` overrides keyboard order for ⇧-click ranges (e.g. rows inside a bundle).
  const sel = useRowSelect(email.id, order);
  const category = useMail((s) => categoryOf(s, email.id));

  return (
    <motion.div {...ROW_MOTION} className="overflow-hidden">
      <EmailContextMenu email={email}>
        <div
          onClick={sel.onClick}
          className={cn(
            "group relative -mx-3 flex h-10 cursor-default items-center gap-3 rounded-lg px-3 transition-colors select-none",
            sel.checked ? "bg-primary/[0.13]" : selected ? "bg-primary/[0.08]" : "hover:bg-foreground/[0.035]",
          )}
        >
          <span className={cn("size-1.5 shrink-0 rounded-full", email.unread ? "bg-primary" : "bg-transparent")} />
          <RowCheck checked={sel.checked} selecting={sel.selecting} onCheck={sel.onCheck} size={24}>
            {category && <Tile icon={CATEGORY_META[category].icon} k={category} size={24} />}
          </RowCheck>
          <span className={cn("w-[160px] shrink-0 truncate text-[13px] group-data-detail/main:w-[110px]", email.unread ? "font-semibold" : "font-medium text-foreground/85")}>
            {email.from.name}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/70">
            {email.subject}
            {showSnippet && <span className="text-foreground/40"> — {email.snippet}</span>}
          </span>
          {email.starred && <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />}
          {!!email.attachments?.length && <Paperclip className="size-3 shrink-0 text-foreground/40" />}
          <span className={cn("flex items-center gap-1.5 transition-[margin] duration-150", !sel.selecting && "group-hover:mr-9")}>
            {flag && (
              <span
                style={{ "--h": "var(--h-needs_you)" } as React.CSSProperties}
                className="tint tint-chip inline-flex h-[21px] shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium"
              >
                <Flag className="size-3" /> Needs you
              </span>
            )}
            <DateChip email={email} />
            <EventChip email={email} />
            <FolderChip email={email} />
          </span>
          <span className={cn("w-[60px] shrink-0 text-right text-[12px] whitespace-nowrap text-foreground/40 tabular-nums transition-opacity", !sel.selecting && "group-hover:opacity-0")}>
            {relTime(email.date)}
          </span>
          {!sel.selecting && <QuickActions email={email} compact />}
        </div>
      </EmailContextMenu>
    </motion.div>
  );
}

/** Classic two-line inbox row for the 3-pane list (avatar, sender, time, subject, snippet). */
export const InboxRow = memo(function InboxRow({ email }: { email: Email }) {
  const selected = useMail((s) => s.selectedId === email.id);
  const junk = useMail((s) => s.folders.find((f) => f.id === email.folderId)?.system === "spam");
  const sel = useRowSelect(email.id);
  const category = useMail((s) => categoryOf(s, email.id));

  return (
    <motion.div {...ROW_MOTION} className="overflow-hidden">
      <EmailContextMenu email={email}>
        <div
          onClick={sel.onClick}
          className={cn(
            "group relative flex cursor-default gap-3 rounded-xl px-3 py-2.5 transition-colors select-none",
            sel.checked ? "bg-primary/[0.15]" : selected ? "bg-primary/[0.1]" : "hover:bg-foreground/[0.04]",
          )}
        >
          {email.unread && <span className="absolute top-[18px] left-1 size-1.5 rounded-full bg-primary" />}
          <RowCheck checked={sel.checked} selecting={sel.selecting} onCheck={sel.onCheck}>
            <div className="relative h-fit shrink-0">
              <SenderAvatar contact={email.from} junk={junk} />
              {category && (
                <span className="absolute -right-1 -bottom-1 rounded-full ring-2 ring-[var(--pane)]">
                  <Tile icon={CATEGORY_META[category].icon} k={category} size={16} className="rounded-full! [&_svg]:size-[9px]!" />
                </span>
              )}
            </div>
          </RowCheck>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className={cn("truncate text-[13.5px]", email.unread ? "font-semibold" : "font-medium")}>{email.from.name}</span>
              {email.starred && <Star className="size-3 shrink-0 translate-y-px fill-amber-400 text-amber-400" />}
              {!!email.attachments?.length && <Paperclip className="size-3 shrink-0 translate-y-px text-foreground/40" />}
              <span className={cn("ml-auto shrink-0 text-[11.5px] text-foreground/40 tabular-nums transition-opacity", !sel.selecting && "group-hover:opacity-0")}>
                {relTime(email.date)}
              </span>
            </div>
            <div className={cn("truncate text-[13px]", email.unread ? "text-foreground" : "text-foreground/80")}>{email.subject}</div>
            <div className="truncate text-[12.5px] text-foreground/45">{email.snippet}</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5 empty:hidden">
              <DateChip email={email} />
              <EventChip email={email} />
              <FolderChip email={email} />
            </div>
          </div>
          {!sel.selecting && <QuickActions email={email} compact />}
        </div>
      </EmailContextMenu>
    </motion.div>
  );
});
