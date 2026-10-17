import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { SPRING } from "@/lib/motion";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import type { Bucket, Email } from "@/lib/types";
import { useShallow } from "zustand/react/shallow";
import { categoryOf, homeGroups, sectionOf, selectHome, useMail } from "@/lib/store";
import type { MailSection } from "@/lib/sections";
import { cn } from "@/lib/utils";
import { unreadCount } from "@/lib/mail/unread";
import { EmailContextMenu, QuickActions, useEmailActions } from "../email-actions";
import { BUCKET_META, CATEGORY_META, SECTION_ICON } from "@/lib/meta";
import { SenderAvatar, Tile, relTime } from "../meta";
import { EventChip } from "../event-chip";
import { DateChip, SectionTag } from "../date-chip";
import { FolderChip, useOneLiner } from "../mail/email-row";
import { RowCheck, SelectAll, useRowSelect } from "../selection";
import { AccountDot } from "../account-switcher";
import { ShowMore, usePaged } from "../show-more";

/** Where in the card the pointer grabbed it, so the drop knows where the card was let go. */
let grab: { id: string; dx: number; dy: number } | null = null;
/** A card just dropped on another lane: its top-left on screen when let go. */
let released: { id: string; left: number; top: number; at: number } | null = null;

/** The released spot for this card, if it was just dropped (and not some older drop). */
const releasedFor = (id: string) => (released?.id === id && performance.now() - released.at < 1000 ? released : null);

function Card({ email, rich, order }: { email: Email; rich: boolean; order: () => string[] }) {
  const isOpen = useMail((s) => s.selectedId === email.id);
  const sel = useRowSelect(email.id, order);
  const line = useOneLiner(email, rich);
  const junk = useMail((s) => s.folders.find((f) => f.id === email.folderId)?.system === "spam");
  const category = useMail((s) => categoryOf(s, email.id));
  const [dragging, setDragging] = useState(false);
  // A card you dragged here settles in from where you let go. Shared-layout flight (layoutId)
  // would start it back in its old lane, so it's only for moves zMail makes, like a re-sort.
  const [dropped] = useState(() => !!releasedFor(email.id));
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const reduce = useReducedMotion();
  useLayoutEffect(() => {
    const from = releasedFor(email.id);
    if (!dropped || !from || !ref.current) return;
    released = null;
    if (reduce) return;
    const r = ref.current.getBoundingClientRect();
    x.set(from.left - r.left);
    y.set(from.top - r.top);
    void animate(x, 0, SPRING);
    void animate(y, 0, SPRING);
  }, [dropped, email.id, reduce, x, y]);

  return (
    <motion.div
      ref={ref}
      layout
      layoutId={dropped ? undefined : `card-${email.id}`}
      style={{ x, y }}
      initial={dropped ? false : { opacity: 0, scale: 0.98 }}
      animate={{ opacity: dragging ? 0.4 : 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={SPRING}
    >
      <EmailContextMenu email={email}>
        <div
          draggable
          onDragStart={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            grab = { id: email.id, dx: e.clientX - r.left, dy: e.clientY - r.top };
            e.dataTransfer.setData("text/zmail-id", email.id);
            e.dataTransfer.effectAllowed = "move";
            setDragging(true);
          }}
          onDragEnd={() => setDragging(false)}
          onClick={sel.onClick}
          className={cn(
            "group relative cursor-grab rounded-xl bg-[var(--pane)] px-3 py-2.5 shadow-[0_1px_2px_oklch(0_0_0/5%),0_0_0_1px_var(--hairline)] transition-shadow select-none hover:shadow-[0_6px_16px_-6px_oklch(0_0_0/18%),0_0_0_1px_var(--hairline)] active:cursor-grabbing",
            isOpen && "shadow-[0_0_0_2px_var(--primary)]!",
            sel.checked && "bg-primary/[0.1] shadow-[0_0_0_1.5px_var(--primary)]!",
          )}
        >
          <div className="flex items-center gap-2">
            <RowCheck checked={sel.checked} selecting={sel.selecting} onCheck={sel.onCheck} size={22}>
              {rich && (
                <div className="relative">
                  <SenderAvatar contact={email.from} junk={junk} compact className="size-[22px] text-[9.5px]" />
                  <AccountDot accountId={email.accountId} className="size-2 border-[1.5px]" />
                </div>
              )}
              {!rich && category && <Tile icon={CATEGORY_META[category].icon} k={category} size={22} />}
            </RowCheck>
            <span className={cn("truncate text-[12.5px]", email.unread ? "font-semibold" : "font-medium")}>{email.from.name}</span>
            <span className={cn("ml-auto shrink-0 text-[11.5px] text-foreground/40 tabular-nums transition-opacity", !sel.selecting && "group-hover:opacity-0")}>
              {relTime(email.date)}
            </span>
          </div>
          <div className="mt-1 truncate text-[13px] text-foreground/80">{email.subject}</div>
          {rich && (
            <div className="mt-1 flex gap-1.5 text-[12px]">
              <span className="text-primary">✦</span>
              <span className="line-clamp-2 text-foreground/50">{line === undefined ? "…" : line || email.snippet}</span>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5 empty:hidden">
            {rich && <SectionTag email={email} />}
            <DateChip email={email} />
            <EventChip email={email} />
            <FolderChip email={email} />
          </div>
          {!sel.selecting && <QuickActions email={email} compact />}
        </div>
      </EmailContextMenu>
    </motion.div>
  );
}

type LaneKind = { bucket: Bucket; section?: undefined } | { section: MailSection; bucket?: undefined };

function Lane({ kind, emails }: { kind: LaneKind; emails: Email[] }) {
  const a = useEmailActions();
  const [over, setOver] = useState(false);
  const page = usePaged(emails);
  const { bucket, section } = kind;
  // ⇧-click ranges stay in this lane and cover only the cards on screen.
  const order = () => page.shown.map((e) => e.id);

  /** Moves the email to this lane; false when there was nothing to move. */
  const drop = (id: string) => {
    const s = useMail.getState();
    const email = s.emails.find((e) => e.id === id);
    // Back on the lane it came from: nothing to learn or pin, and nothing to say. The card settles back.
    if (!email || emails.some((e) => e.id === id)) return false;
    // Into a section also takes it out of "Needs you", or it would stay in that lane.
    if (section) {
      a.section([id], section.id);
      return true;
    }
    if (bucket !== "needs_you" && sectionOf(s, email)) s.setSection([id], null);
    a.teach([id], bucket);
    return true;
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData("text/zmail-id");
        if (!id) return;
        const from = grab?.id === id ? grab : { dx: 0, dy: 0 };
        // Set before the move, so the card mounting in this lane finds it.
        released = { id, left: e.clientX - from.dx, top: e.clientY - from.dy, at: performance.now() };
        if (!drop(id)) released = null;
      }}
      className={cn(
        "flex min-h-0 flex-col rounded-2xl bg-foreground/[0.03] transition-colors",
        over && "bg-primary/[0.07] ring-2 ring-primary/30",
      )}
    >
      <div className="group/section @container/lane flex h-11 shrink-0 items-center gap-2 px-4 text-[13px] font-semibold whitespace-nowrap">
        {section ? (
          <>
            <Tile icon={SECTION_ICON[section.icon]} h={section.hue} variant="solid" size={22} />
            <span className="min-w-0 truncate">{section.name}</span>
          </>
        ) : (
          <>
            <Tile icon={BUCKET_META[bucket].icon} k={bucket} variant="solid" size={22} />
            <span className="shrink-0">{BUCKET_META[bucket].label}</span>
          </>
        )}
        {/* Unread, like the dock badge; Select all and Archive all still cover every email in the lane. */}
        <span title="Unread" className="shrink-0 font-medium text-foreground/40 tabular-nums">{unreadCount(emails)}</span>
        <SelectAll ids={emails.map((e) => e.id)} fit={bucket === "ready_archive"} className="ml-auto min-w-0 truncate" />
        {bucket === "ready_archive" && emails.length > 0 && (
          <button
            onClick={() => void a.archive(emails.map((e) => e.id))}
            className="h-6 shrink-0 rounded-md border border-hairline bg-[var(--pane)] px-2.5 text-[11.5px] font-semibold whitespace-nowrap text-foreground/70 hover:text-foreground"
          >
            Archive all {emails.length}
          </button>
        )}
      </div>
      {/* pt: room for a selected card's ring, which the scroll edge would clip. */}
      <div className="flex-1 space-y-2 overflow-y-auto px-2.5 pt-0.5 pb-3">
        <AnimatePresence initial={false} mode="popLayout">
          {page.shown.map((e) => (
            <Card key={e.id} email={e} rich={bucket === "needs_you"} order={order} />
          ))}
        </AnimatePresence>
        <ShowMore paged={page} className="bg-[var(--pane)]" />
        {emails.length === 0 && (
          <div className="grid h-24 place-items-center rounded-xl border border-dashed border-hairline text-[12px] text-foreground/35">
            Drop emails here
          </div>
        )}
      </div>
    </div>
  );
}

export function TriageView() {
  const home = useMail(useShallow(selectHome));
  const g = useMemo(() => homeGroups(home), [home]);

  // Needs you, then your sections, then Worth a skim and Can go. More than
  // three lanes scroll sideways.
  return (
    <div className="grid h-full auto-cols-[minmax(260px,1fr)] grid-flow-col gap-3 overflow-x-auto p-4 pt-1">
      <Lane kind={{ bucket: "needs_you" }} emails={g.needs} />
      {g.sections.map(({ section, emails }) => (
        <Lane key={section.id} kind={{ section }} emails={emails} />
      ))}
      <Lane kind={{ bucket: "worth_skim" }} emails={g.skim} />
      <Lane kind={{ bucket: "ready_archive" }} emails={g.canGo} />
    </div>
  );
}
