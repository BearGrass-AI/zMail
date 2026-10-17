import { useEffect, useMemo, useState, type ReactNode } from "react";
import { SPRING, useEntranceOnce } from "@/lib/motion";
import { AnimatePresence, motion } from "motion/react";
import { Archive, Bell, Check, CheckSquare, ChevronDown, Eye, List, MailOpen, Trash2, WandSparkles, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import type { Bucket, Category, Email } from "@/lib/types";
import { useShallow } from "zustand/react/shallow";
import { backfillLine, categoryOf, homeGroups, selectHome, todayKeep, useMail } from "@/lib/store";
import type { MailSection } from "@/lib/sections";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { todayList, unreadCount, sortNeeds } from "@/lib/mail/unread";
import { CategoryItems, useEmailActions } from "../email-actions";
import { CompactRow, RichRow } from "../mail/email-row";
import { SelectAll } from "../selection";
import { ShowMore, usePaged } from "../show-more";
import { BUCKET_META, CATEGORY_META, SECTION_ICON } from "@/lib/meta";
import { Tile, tint } from "../meta";
import { AgendaRail } from "./agenda-rail";
import { useSettings } from "@/lib/settings";
import { refreshNotifyStatus } from "@/lib/notifications";
import { notifyRequest, notifyStatus, type NotifyStatus } from "@/lib/notify-native";

const BUNDLE_TITLES: Record<Category, string> = {
  security: "Sign-in links",
  promotions: "Promos",
  social: "Social",
  updates: "Notifications",
  newsletters: "Newsletters",
  transactions: "Receipts",
  primary: "Handled threads",
};

function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Hero({ counts, sections }: { counts: Record<Bucket, number>; sections: { section: MailSection; emails: Email[] }[] }) {
  const me = useMail((s) => s.me);
  const sorting = useMail((s) => s.sorting);
  const backfill = useMail((s) => s.backfill);
  const loadingOlder = useMemo(() => backfillLine(backfill), [backfill]);
  const today = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  // Slides up the first time Today opens; coming back to it (⌘1) it's already there.
  const entrance = useEntranceOnce("today-hero", { opacity: 0, y: 8 });
  const pills: { b: Bucket; label: string }[] = [
    { b: "needs_you", label: counts.needs_you === 1 ? "needs you" : "need you" },
    { b: "worth_skim", label: "to skim" },
    { b: "ready_archive", label: "can go" },
  ];

  return (
    <motion.div
      initial={entrance}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className="hero-card rounded-[18px] px-6 pt-5 pb-5"
    >
      <div className="text-[11.5px] font-semibold tracking-[0.06em] text-foreground/45 uppercase">{today}</div>
      <h1 className="mt-1.5 text-[27px] leading-[1.15] font-bold tracking-[-0.025em] group-data-detail/main:text-[22px]">
        {greeting()}, {me.name.split(" ")[0]}.
        <br />
        <span className="text-foreground/40">
          {sorting.running && sorting.done < sorting.total
            ? `Reading your inbox… ${sorting.done}/${sorting.total}`
            : (loadingOlder ?? "Here's what matters today.")}
        </span>
      </h1>
      <div className="mt-4 flex flex-wrap gap-2">
        {pills.map(({ b, label }) => (
          <button
            key={b}
            onClick={() => scrollTo(`sec-${b}`)}
            className="hero-pill flex h-9 items-center gap-2 rounded-full pr-3.5 pl-1.5 text-[13.5px] font-semibold transition hover:brightness-110"
          >
            <Tile icon={BUCKET_META[b].icon} k={b} variant="solid" size={24} className="rounded-full!" />
            <span className="tabular-nums">{counts[b]}</span>
            <span className="text-[12.5px] font-medium text-foreground/50">{label}</span>
          </button>
        ))}
        <TodayShowSwitch />
        {sections.map(({ section, emails }) => (
          <button
            key={section.id}
            onClick={() => scrollTo(`sec-${section.id}`)}
            className="hero-pill flex h-9 items-center gap-2 rounded-full pr-3.5 pl-1.5 text-[13.5px] font-semibold transition hover:brightness-110"
          >
            <Tile icon={SECTION_ICON[section.icon]} h={section.hue} variant="solid" size={24} className="rounded-full!" />
            <span className="tabular-nums">{unreadCount(emails)}</span>
            <span className="text-[12.5px] font-medium text-foreground/50">{section.name.toLowerCase()}</span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}

/** Asks once, before macOS's own prompt, whether to show banners. "Not now" never asks again. */
function NotifyCard() {
  const asked = useSettings((s) => s.notifications.asked);
  const hasReal = useMail((s) => s.accounts.some((a) => a.kind !== "mock"));
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void notifyStatus().then((st) => live && setStatus(st));
    return () => {
      live = false;
    };
  }, []);
  if (asked || status !== "notDetermined" || !hasReal) return null;

  const answer = () => {
    const st = useSettings.getState();
    st.set({ notifications: { ...st.notifications, asked: true } });
  };
  const turnOn = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await notifyRequest();
    answer();
    void refreshNotifyStatus();
    if (!ok) toast("Notifications are off", { description: "You can turn them on in System Settings → Notifications → zMail." });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className="mb-3 flex items-start gap-3 rounded-2xl bg-pane-2 p-3.5 shadow-[inset_0_0_0_1px_var(--hairline)]"
    >
      <Tile icon={Bell} k="needs_you" size={28} />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold">Get a banner when mail needs you?</div>
        <p className="mt-0.5 text-[12.5px] leading-snug text-foreground/55">
          zMail will only notify you about new mail it sorts into Needs you: people and processes waiting on you. Newsletters, receipts and FYIs stay quiet.
        </p>
        <div className="mt-2.5 flex items-center gap-1.5">
          <button onClick={answer} disabled={busy} className="h-7 rounded-lg bg-foreground/[0.07] px-2.5 text-[12px] font-semibold hover:bg-foreground/10">
            Not now
          </button>
          <button
            onClick={() => void turnOn()}
            disabled={busy}
            className="h-7 rounded-lg bg-primary px-2.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-60"
          >
            Turn on notifications
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function Section({
  id,
  icon,
  k,
  h,
  label,
  meta,
  right,
  children,
}: {
  id: string;
  icon: LucideIcon;
  k?: Bucket;
  /** Hue for your own sections (buckets use `k`). */
  h?: number;
  label: string;
  meta?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mt-7 scroll-mt-4">
      <div className="group/section mb-2 flex h-7 items-center gap-2.5">
        <Tile icon={icon} k={k} h={h} variant="solid" size={22} />
        <h3 className="text-[14.5px] font-semibold tracking-[-0.01em]">{label}</h3>
        {meta && <span className="text-[12px] text-foreground/40">{meta}</span>}
        <div className="ml-auto flex items-center gap-2">{right}</div>
      </div>
      {children}
    </section>
  );
}

function BundleCard({
  category,
  emails,
  open,
  onToggle,
}: {
  category: Category;
  emails: Email[];
  open: boolean;
  onToggle: () => void;
}) {
  const a = useEmailActions();
  const ids = emails.map((e) => e.id);
  const senders = [...new Set(emails.map((e) => e.from.name.replace(/\s*\(.*\)/, "")))];
  const unread = emails.some((e) => e.unread);
  const selectAll = () => {
    if (!open) onToggle();
    const s = useMail.getState();
    s.setChecked([...new Set([...s.checked, ...ids])]);
  };

  return (
    <motion.div layout exit={{ opacity: 0, scale: 0.95 }} transition={SPRING}>
      <ContextMenu>
        <ContextMenuTrigger>
          <div
            onClick={onToggle}
            className={cn(
              "group relative flex h-full cursor-default flex-col gap-2 rounded-2xl bg-pane-2 p-3 shadow-[inset_0_0_0_1px_var(--hairline)] transition hover:brightness-[1.03] dark:hover:brightness-110",
              open && "shadow-[inset_0_0_0_1.5px_var(--primary)]",
            )}
          >
            <div className="flex items-center gap-2.5">
              <Tile icon={CATEGORY_META[category].icon} k={category} size={28} />
              <span className="truncate text-[13px] font-semibold">{BUNDLE_TITLES[category]}</span>
              <span className="ml-auto text-[19px] font-semibold tracking-[-0.02em] tabular-nums">{emails.length}</span>
            </div>
            <div className="truncate text-[12px] text-foreground/45">{senders.join(", ")}</div>
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute right-2 bottom-2 flex items-center overflow-hidden rounded-md bg-[var(--pane)] opacity-0 shadow-sm ring-1 ring-hairline transition group-hover:opacity-100"
            >
              <button
                onClick={() => void a.archive(ids)}
                title={`Archive all ${ids.length}`}
                className="flex h-6 items-center gap-1 px-2 text-[11.5px] font-medium text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <Archive className="size-3" /> Archive
              </button>
              <span className="h-3.5 w-px bg-hairline" />
              <button
                onClick={() => void a.trash(ids)}
                title={`Delete all ${ids.length}`}
                className="flex h-6 items-center gap-1 px-2 text-[11.5px] font-medium text-foreground/70 hover:bg-foreground/[0.06] hover:text-destructive"
              >
                <Trash2 className="size-3" /> Delete
              </button>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem onClick={() => void a.archive(ids)}>
            <Archive /> Archive all {emails.length}
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => void a.trash(ids)}>
            <Trash2 /> Delete all {emails.length}
          </ContextMenuItem>
          {unread && (
            <ContextMenuItem onClick={() => a.read(ids, true)}>
              <MailOpen /> Mark all as read
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={selectAll}>
            <CheckSquare /> Select all {emails.length}…
          </ContextMenuItem>
          <ContextMenuItem onClick={onToggle}>
            <List /> {open ? "Hide" : "Show"} emails
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <WandSparkles /> These are really
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-56">
              <CategoryItems ids={ids} />
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem onClick={() => a.teach(ids, "worth_skim")}>
            <Eye /> These are worth a skim
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </motion.div>
  );
}

/** One of your sections: compact rows, 10 at a time. `flagged`: urgent mail it keeps out of Needs you (listed first). */
function SectionBlock({ section, emails, read, flagged }: { section: MailSection; emails: Email[]; read: number; flagged: ReadonlySet<string> }) {
  const page = usePaged(emails);
  return (
    <Section
      id={`sec-${section.id}`}
      icon={SECTION_ICON[section.icon]}
      h={section.hue}
      label={section.name}
      meta={unreadCount(emails)}
      right={<SelectAll ids={emails.map((e) => e.id)} />}
    >
      {emails.length > 0 && (
        <div className="rounded-2xl bg-pane-2 px-3 py-1 shadow-[inset_0_0_0_1px_var(--hairline)]">
          <AnimatePresence initial={false}>
            {splitRows(page.shown, emails.length - read, read, (e) => <CompactRow key={e.id} email={e} flag={flagged.has(e.id)} />)}
          </AnimatePresence>
        </div>
      )}
      <ShowMore paged={page} />
      <ReadHidden read={read} />
    </Section>
  );
}

/** Today's Unread / All switch: read mail below a divider, or hidden. */
function TodayShowSwitch() {
  const show = useSettings((s) => s.todayShow);
  const set = useSettings((s) => s.set);
  return (
    <div role="radiogroup" aria-label="Show in Today" className="ml-auto inline-flex h-9 items-center rounded-full bg-foreground/[0.055] p-1">
      {(["unread", "all"] as const).map((v) => (
        <button
          key={v}
          role="radio"
          aria-checked={show === v}
          onClick={() => set({ todayShow: v })}
          className={cn(
            "h-7 rounded-full px-3 text-[12.5px] font-medium",
            show === v ? "bg-[var(--pane)] shadow-[0_1px_2px_oklch(0_0_0/10%),0_0_0_1px_var(--hairline)]" : "text-foreground/50 hover:text-foreground/80",
          )}
        >
          {v === "unread" ? "Unread" : "All"}
        </button>
      ))}
    </div>
  );
}

/** Rows with a "Read · N" line before the first read one. `firstRead` is its index in the full list. */
function splitRows(shown: Email[], firstRead: number, read: number, row: (e: Email) => ReactNode) {
  return shown.flatMap((e, i) => [
    ...(i === firstRead && read > 0
      ? [
          <div key="read-divider" className="flex items-center gap-2 px-1 pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-foreground/40 uppercase after:h-px after:flex-1 after:bg-hairline">
            Read · {read}
          </div>,
        ]
      : []),
    i >= firstRead ? (
      <div key={e.id} className="opacity-60 transition-opacity hover:opacity-100">
        {row(e)}
      </div>
    ) : (
      row(e)
    ),
  ]);
}

/** With the switch on Unread: how many read emails this section is hiding, and a way back. */
function ReadHidden({ read }: { read: number }) {
  const show = useSettings((s) => s.todayShow);
  const set = useSettings((s) => s.set);
  if (show !== "unread" || !read) return null;
  return (
    <button onClick={() => set({ todayShow: "all" })} className="mt-1 px-1 text-[12px] text-foreground/40 hover:text-foreground/70">
      {read} read hidden · Show
    </button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-[13px] text-foreground/40">{children}</p>;
}

function SkeletonRows({ n }: { n: number }) {
  return (
    <div className="space-y-4 py-2">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="size-8 animate-pulse rounded-full bg-foreground/[0.06]" />
          <div className="flex-1 space-y-2">
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-foreground/[0.07]" />
            <div className="h-2.5 w-3/4 animate-pulse rounded bg-foreground/[0.05]" />
          </div>
        </div>
      ))}
    </div>
  );
}

const NEEDS_SORTS = [
  { id: "urgency", label: "urgency", item: "Most urgent first" },
  { id: "newest", label: "newest first", item: "Newest first" },
  { id: "oldest", label: "oldest first", item: "Oldest first" },
] as const;

/** "sorted by urgency ▾": Needs you by the model's urgency or by date (remembered). */
function NeedsSortMenu() {
  const sort = useSettings((s) => s.needsSort);
  const set = useSettings((s) => s.set);
  const label = NEEDS_SORTS.find((x) => x.id === sort)?.label ?? "urgency";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md px-1 text-[12px] text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/70">
        sorted by {label} <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {NEEDS_SORTS.map((x) => (
          <DropdownMenuItem key={x.id} onClick={() => set({ needsSort: x.id })}>
            <span className="flex-1">{x.item}</span>
            {sort === x.id && <Check className="size-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BriefView() {
  const home = useMail(useShallow(selectHome));
  const categoryOverrides = useMail((s) => s.categoryOverrides);
  const sortingRunning = useMail((s) => s.sorting.running);
  const a = useEmailActions();
  const [openBundle, setOpenBundle] = useState<Category | null>(null);

  const show = useSettings((s) => s.todayShow);
  const needsSort = useSettings((s) => s.needsSort);
  const openId = useMail((s) => s.selectedId);
  const todayKept = useMail((s) => s.todayKept);
  // The grouping and each Can go email's bundle depend only on the mail; J/K redoes just the cheap step below.
  const { g, canGoCats } = useMemo(() => {
    const g = homeGroups(home);
    const canGoCats = new Map<string, Category>(g.canGo.map((e) => [e.id, categoryOf({ triage: home.triage, categoryOverrides }, e.id) ?? "updates"]));
    return { g, canGoCats };
  }, [home, categoryOverrides]);
  const { needs, sections, skim, bundles, canGo, unsorted, read } = useMemo(() => {
    // Unread first and read after a divider, or read hidden (the Unread / All switch).
    const keep = todayKeep(todayKept, openId);
    const n = todayList(sortNeeds(g.needs, needsSort), show, keep);
    const k = todayList(g.skim, show, keep);
    const needs = n.list;
    const skim = k.list;
    const sections = g.sections.map(({ section, emails, flagged }) => {
      const t = todayList(emails, show, keep);
      return { section, emails: t.list, read: t.read, flagged };
    });
    const canGo = show === "unread" ? g.canGo.filter((e) => e.unread || keep.has(e.id)) : g.canGo;
    const unsorted = g.unsorted;
    const groups = new Map<Category, Email[]>();
    for (const e of canGo) {
      const c = canGoCats.get(e.id)!;
      const list = groups.get(c);
      if (list) list.push(e);
      else groups.set(c, [e]);
    }
    const bundles = [...groups.entries()].sort((x, y) => y[1].length - x[1].length);
    return {
      needs,
      sections: sections.filter((x) => x.emails.length || x.read),
      skim,
      bundles,
      canGo,
      unsorted,
      read: { needs: n.read, skim: k.read },
    };
  }, [g, canGoCats, show, openId, todayKept, needsSort]);

  const needsPage = usePaged(needs);
  const skimPage = usePaged(skim);
  const sorting = sortingRunning && unsorted > 0;
  const expanded = bundles.find(([c]) => c === openBundle);

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-8 pt-3 pb-24 group-data-detail/main:px-6">
          <NotifyCard />
          {/* Unread counts, like the dock badge and the account chips. */}
          <Hero counts={{ needs_you: unreadCount(needs), worth_skim: unreadCount(skim), ready_archive: unreadCount(canGo) }} sections={sections} />

          <Section
            id="sec-needs_you"
            icon={BUCKET_META.needs_you.icon}
            k="needs_you"
            label="Needs you"
            meta={<NeedsSortMenu />}
            right={
              <>
                <SelectAll ids={needs.map((e) => e.id)} />
                <span className="flex items-center gap-1.5 text-[12px] text-foreground/35 group-data-detail/main:hidden">
                  <kbd className="kbd">J</kbd>
                  <kbd className="kbd">K</kbd> move · <kbd className="kbd">R</kbd> reply
                </span>
              </>
            }
          >
            {sorting && !needs.length ? (
              <SkeletonRows n={3} />
            ) : needs.length ? (
              <>
                <AnimatePresence initial={false}>
                  {splitRows(needsPage.shown, needs.length - read.needs, read.needs, (e) => <RichRow key={e.id} email={e} />)}
                </AnimatePresence>
                <ShowMore paged={needsPage} />
                <ReadHidden read={read.needs} />
              </>
            ) : read.needs ? (
              <ReadHidden read={read.needs} />
            ) : (
              <Empty>No one is waiting on you. Nice.</Empty>
            )}
          </Section>

          {sections.map(({ section, emails, read, flagged }) => (
            <SectionBlock key={section.id} section={section} emails={emails} read={read} flagged={flagged} />
          ))}

          <Section
            id="sec-worth_skim"
            icon={BUCKET_META.worth_skim.icon}
            k="worth_skim"
            label="Worth a skim"
            meta={unreadCount(skim)}
            right={<SelectAll ids={skim.map((e) => e.id)} />}
          >
            {sorting && !skim.length ? (
              <SkeletonRows n={2} />
            ) : skim.length ? (
              <>
                <div className="rounded-2xl bg-pane-2 px-3 py-1 shadow-[inset_0_0_0_1px_var(--hairline)]">
                  <AnimatePresence initial={false}>
                    {splitRows(skimPage.shown, skim.length - read.skim, read.skim, (e) => <CompactRow key={e.id} email={e} />)}
                  </AnimatePresence>
                </div>
                <ShowMore paged={skimPage} />
                <ReadHidden read={read.skim} />
              </>
            ) : read.skim ? (
              <ReadHidden read={read.skim} />
            ) : (
              <Empty>Nothing to skim.</Empty>
            )}
          </Section>

          <Section
            id="sec-ready_archive"
            icon={BUCKET_META.ready_archive.icon}
            k="ready_archive"
            label="Can go"
            meta={unreadCount(canGo)}
            right={
              canGo.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    style={tint("ready_archive")}
                    className="tint tint-chip flex h-7 items-center gap-1 rounded-full pr-2 pl-3 text-[12px] font-semibold"
                  >
                    Clear all {canGo.length} <ChevronDown className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={() => void a.archive(canGo.map((e) => e.id))}>
                      <Archive /> Archive all {canGo.length}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => void a.trash(canGo.map((e) => e.id))}>
                      <Trash2 /> Delete all {canGo.length}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            }
          >
            {bundles.length ? (
              <>
                <div className="grid grid-cols-3 gap-2 group-data-detail/main:grid-cols-2">
                  <AnimatePresence initial={false}>
                    {bundles.map(([cat, emails]) => (
                      <BundleCard
                        key={cat}
                        category={cat}
                        emails={emails}
                        open={openBundle === cat}
                        onToggle={() => setOpenBundle((o) => (o === cat ? null : cat))}
                      />
                    ))}
                  </AnimatePresence>
                </div>
                <AnimatePresence initial={false}>
                  {expanded && (
                    <motion.div
                      key={expanded[0]}
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={SPRING}
                      className="mt-2 overflow-hidden rounded-2xl bg-pane-2 px-3 py-1 shadow-[inset_0_0_0_1px_var(--hairline)]"
                    >
                      {expanded[1].map((e) => (
                        <CompactRow key={e.id} email={e} order={() => expanded[1].map((x) => x.id)} />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            ) : (
              <Empty>{sorting ? "Sorting…" : "Nothing to clear."}</Empty>
            )}
          </Section>
        </div>
      </div>
      <AgendaRail />
    </div>
  );
}
