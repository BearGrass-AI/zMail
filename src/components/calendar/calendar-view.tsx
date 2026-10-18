import { useEffect, useMemo, useRef, useState } from "react";
import { SPRING, SPRING_PILL } from "@/lib/motion";
import { AnimatePresence, motion } from "motion/react";
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mail,
  MapPin,
  Trash2,
  Users,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import type { CalEvent } from "@/lib/types";
import { useShallow } from "zustand/react/shallow";
import { calendarProvider, dayEvents, emailForEvent, ensureEventRange, eventHue, eventsOn, inboxSuggestions, sameDay, selectSuggestions, useMail } from "@/lib/store";
import { SuggestionCard } from "../suggestion-card";
import { useSettings } from "@/lib/settings";
import { isTauri } from "@tauri-apps/api/core";
import { startOfWeek } from "@/lib/calendar/mock-calendar";
import { monthGrid } from "@/lib/calendar/month-grid";
import { layoutDay, type Span } from "@/lib/calendar/day-layout";
import { weekLabel } from "@/lib/calendar/week-label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { hue } from "../meta";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { confirmDeleteText, deleteEventWithUndo, otherGuests } from "@/lib/calendar/delete-event";

/** Pixels per hour in the week and day grids, which scroll through the whole day. */
const HOUR = 54;
/** The hour the grid opens at, unless that would leave now below the fold. */
const OPEN_AT = 7;
/** Blocks shorter than this put the time beside the title instead of under it. */
const SHORT_PX = 38;

async function openLink(url: string) {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener");
}

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/** "9 AM", "9:30 AM". */
const fmtShort = (iso: string) => fmtTime(iso).replace(/:00(?=\s?[AP]M)/i, "");
const timeRange = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
/** "9:00 – 10:00 AM". */
function fmtRange(e: CalEvent) {
  try {
    return timeRange.formatRange(new Date(e.start), new Date(e.end));
  } catch {
    return fmtTime(e.start);
  }
}

/** Re-renders once a minute, for the now line. */
function useMinute() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The hour labels down the grid's left edge, and the current time in red when today is shown. */
function HourGutter({ showNow }: { showNow: boolean }) {
  const now = useMinute();
  const at = now.getHours() + now.getMinutes() / 60;
  return (
    <div className="relative">
      {Array.from({ length: 23 }, (_, i) => i + 1).map((h) =>
        // The current time takes the place of an hour label it would overlap.
        showNow && Math.abs(h - at) < 0.3 ? null : (
          <div key={h} className="absolute right-2 text-[10px] text-foreground/35 tabular-nums" style={{ top: h * HOUR - 6 }}>
            {new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" })}
          </div>
        ),
      )}
      {showNow && (
        <div className="absolute right-1.5 z-20 text-[10px] font-semibold text-[var(--bucket-needs_you)] tabular-nums" style={{ top: at * HOUR - 6 }}>
          {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "")}
        </div>
      )}
    </div>
  );
}

function NowLine() {
  const now = useMinute();
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-[var(--bucket-needs_you)]"
      style={{ top: (now.getHours() + now.getMinutes() / 60) * HOUR }}
    >
      <span className="absolute -top-[3px] -left-1 size-2 rounded-full bg-[var(--bucket-needs_you)]" />
    </div>
  );
}

const RSVP = { accepted: ["Accept", "Accepted"], tentative: ["Maybe", "Marked tentative"], declined: ["Decline", "Declined"] } as const;

/** Each reply emails the organizer: one at a time, with the one being sent spinning. */
function RsvpButtons({ e }: { e: CalEvent }) {
  const respondEvent = useMail((s) => s.respondEvent);
  const [sending, setSending] = useState<keyof typeof RSVP | null>(null);
  const inFlight = useRef(false);
  const respond = async (r: keyof typeof RSVP) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(r);
    try {
      await respondEvent(e, r);
      toast.success(RSVP[r][1]);
    } catch (err) {
      toast.error("Couldn't respond", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.current = false;
      setSending(null);
    }
  };
  return (
    <>
      {(Object.keys(RSVP) as (keyof typeof RSVP)[]).map((r) => (
        <button
          key={r}
          disabled={sending !== null}
          onClick={() => void respond(r)}
          className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-lg bg-foreground/[0.06] text-[12px] font-medium hover:bg-foreground/10 disabled:opacity-60 disabled:hover:bg-foreground/[0.06]"
        >
          {sending === r && <Loader2 className="size-3.5 animate-spin" />}
          {RSVP[r][0]}
        </button>
      ))}
    </>
  );
}

/** What the event popover shows: time, place, people, calendar, related email, join, RSVP. */
function EventDetails({ e }: { e: CalEvent }) {
  const mail = useMail((s) => emailForEvent(s, e));
  const cal = useMail((s) => s.calendars.find((c) => c.id === e.calendarId));
  const select = useMail((s) => s.select);
  const evHue = e.hue ?? cal?.hue ?? 255;
  return (
    <>
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: `oklch(0.66 0.15 ${evHue})` }} />
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-[-0.01em]">{e.title}</div>
          <div className="mt-0.5 text-[12.5px] text-foreground/55">
            {new Date(e.start).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })} · {fmtTime(e.start)}–{fmtTime(e.end)}
          </div>
        </div>
      </div>
      <div className="mt-3 space-y-1.5 text-[12.5px] text-foreground/70">
        {e.location && (
          <div className="flex items-center gap-2"><MapPin className="size-3.5 text-foreground/40" /> {e.location}</div>
        )}
        {e.attendees.length > 0 && (
          <div className="flex items-center gap-2"><Users className="size-3.5 text-foreground/40" /> {e.attendees.map((a) => a.name).join(", ")}</div>
        )}
        <div className="flex items-center gap-2 text-foreground/45">
          <span className="size-2 rounded-full" style={{ background: `oklch(0.66 0.15 ${cal?.hue ?? 255})` }} /> {cal?.name}
        </div>
      </div>
      <div className="mt-3.5 flex gap-1.5">
        {mail && (
          <button
            onClick={() => select(mail.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-foreground/[0.06] px-2.5 py-1.5 text-[12px] font-medium hover:bg-foreground/10"
          >
            <Mail className="size-3.5 shrink-0 text-primary" /> <span className="truncate">{mail.subject}</span>
          </button>
        )}
        {e.joinUrl && (
          <button
            onClick={() => void openLink(e.joinUrl!)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-[12px] font-semibold text-primary-foreground"
          >
            <Video className="size-3.5" /> Join
          </button>
        )}
      </div>
      {calendarProvider(cal?.accountId ?? "") && e.related?.from && (
        <div className="mt-3 flex gap-1.5 border-t border-hairline pt-3">
          <RsvpButtons e={e} />
        </div>
      )}
    </>
  );
}

/** Where a block sits in its group of overlapping events, and how far in from the column's left edge. */
interface Slot {
  lane: number;
  span: number;
  lanes: number;
  inset: number;
}

/** A timed event: a block in its lane, or (with no slot) a band behind the day whose label opens it. */
function EventBlock({ x, slot, past, flip }: { x: Span; slot: Slot | null; past: boolean; flip?: boolean }) {
  const e = x.e;
  const mail = useMail((s) => emailForEvent(s, e));
  const cal = useMail((s) => s.calendars.find((c) => c.id === e.calendarId));
  const guests = useMail((s) => otherGuests(e, s.accounts.map((a) => a.address)));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const select = useMail((s) => s.select);
  const openCompose = useMail((s) => s.openCompose);
  const evHue = e.hue ?? cal?.hue ?? 255;
  const height = slot ? Math.max(20, (x.end - x.start) * HOUR - 3) : (x.end - x.start) * HOUR;
  const short = height < SHORT_PX;

  // Deleting emails every guest a cancellation: ask first when there are any.
  const remove = () => (guests ? setConfirmDelete(true) : deleteEventWithUndo(e));

  let trigger;
  if (slot) {
    const w = 100 / slot.lanes;
    const left = slot.lane ? 2 : slot.inset;
    trigger = (
      <motion.button
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={SPRING}
        style={{ ...hue(evHue), top: x.start * HOUR + 1, height, left: `calc(${slot.lane * w}% + ${left}px)`, width: `calc(${slot.span * w}% - ${left + 3}px)` }}
        className={cn(
          "cal-block absolute overflow-hidden rounded-md px-[7px] text-left leading-tight transition-[filter] hover:z-10 hover:brightness-110",
          past && "cal-past",
          short ? "flex items-baseline gap-1.5 py-0.5" : "py-[3px]",
        )}
      />
    );
  } else {
    trigger = <button className="pointer-events-auto sticky top-0 block max-w-full truncate px-1.5 py-[3px] text-left text-[10.5px] font-semibold hover:underline" />;
  }

  const shell = (
    <Popover>
      <ContextMenu>
        <ContextMenuTrigger render={<PopoverTrigger render={trigger} />}>
          {!slot ? (
            <>
              {e.title} · {fmtRange(e)}
            </>
          ) : short ? (
            <>
              <span className="min-w-0 truncate text-[12.5px] font-semibold tracking-[-0.005em]">{e.title}</span>
              <span className="shrink-0 text-[11px] opacity-70 tabular-nums">{fmtShort(e.start)}</span>
            </>
          ) : (
            <>
              <div className="truncate text-[12.5px] font-semibold tracking-[-0.005em]">{e.title}</div>
              <div className="mt-px truncate text-[11px] opacity-70 tabular-nums">
                {fmtRange(e)}
                {e.location ? ` · ${e.location}` : ""}
              </div>
              {mail && height > 56 && (
                <span className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full bg-black/10 px-1.5 py-px text-[10.5px] dark:bg-black/30">
                  <Mail className="size-2.5 shrink-0" /> <span className="truncate">{mail.subject}</span>
                </span>
              )}
            </>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          {mail && (
            <ContextMenuItem onClick={() => select(mail.id)}>
              <Mail /> Open related email
            </ContextMenuItem>
          )}
          {e.attendees.length > 0 && (
            <ContextMenuItem
              onClick={() => openCompose({ mode: "ai", replyTo: mail?.id })}
            >
              <Users /> Email attendees
            </ContextMenuItem>
          )}
          {e.joinUrl && (
            <ContextMenuItem onClick={() => void openLink(e.joinUrl!)}>
              <Video /> Join call
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={remove}>
            <Trash2 /> Delete event
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <PopoverContent side={flip ? "left" : "right"} align="start" sideOffset={8} className="w-72 rounded-2xl p-4">
        <EventDetails e={e} />
      </PopoverContent>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent showCloseButton={false} className="sm:max-w-[380px]">
          <DialogTitle>{confirmDeleteText(guests)}</DialogTitle>
          <DialogDescription>
            “{e.title}” is removed from your calendar and each guest gets a cancellation email.
          </DialogDescription>
          <DialogFooter>
            <button onClick={() => setConfirmDelete(false)} className="h-8 rounded-lg px-3 text-[13px] text-foreground/70 hover:bg-foreground/5">
              Cancel
            </button>
            <button
              onClick={() => {
                setConfirmDelete(false);
                deleteEventWithUndo(e);
              }}
              className="h-8 rounded-lg bg-destructive px-3 text-[13px] font-medium text-white"
            >
              Delete and notify
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Popover>
  );
  if (slot) return shell;
  return (
    <div className="cal-band pointer-events-none absolute inset-x-0" style={{ ...hue(evHue), top: x.start * HOUR, height }}>
      {shell}
    </div>
  );
}

const MONTH_SHOWN = 3;

type CalState = Parameters<typeof eventsOn>[0];

/** One event in a month cell: all-day as a filled bar, timed as a dot, time and title. Click for details. */
function MonthEvent({ e, s, flip, now }: { e: CalEvent; s: CalState; flip: boolean; now: Date }) {
  const h = eventHue(s, e);
  const past = Date.parse(e.end) < now.getTime();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            style={hue(h)}
            className={cn(
              "flex w-full min-w-0 items-center gap-1 rounded px-1 py-px text-left text-[11px] leading-tight hover:bg-foreground/[0.07]",
              e.allDay && "cal-chip font-semibold",
              past && (e.allDay ? "cal-past" : "text-foreground/60"),
            )}
            title={e.title}
          />
        }
      >
        {!e.allDay && <span className="size-1.5 shrink-0 rounded-full" style={{ background: `oklch(0.66 0.15 ${h})` }} />}
        {!e.allDay && <span className="shrink-0 text-foreground/50 tabular-nums">{fmtTime(e.start).replace(/:00(?=\s?[AP]M)/i, "")}</span>}
        <span className="truncate">{e.title}</span>
      </PopoverTrigger>
      <PopoverContent side={flip ? "left" : "right"} align="start" sideOffset={8} className="w-72 rounded-2xl p-4">
        <EventDetails e={e} />
      </PopoverContent>
    </Popover>
  );
}

function MonthView({
  grid,
  s,
  now,
  onOpenDay,
  onNew,
}: {
  grid: ReturnType<typeof monthGrid>;
  s: CalState;
  now: Date;
  onOpenDay: (d: Date) => void;
  onNew: (d: Date) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-hairline">
      <div className="grid grid-cols-7 border-b border-hairline">
        {grid.days.slice(0, 7).map((d) => (
          <div key={d.getDay()} className="px-2.5 py-1.5 text-[10.5px] font-semibold tracking-[0.05em] text-foreground/45 uppercase">
            {d.toLocaleDateString([], { weekday: "short" })}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7" style={{ gridTemplateRows: `repeat(${grid.weeks}, minmax(0, 1fr))` }}>
        {grid.days.map((d, i) => {
          const inMonth = d.getMonth() === grid.first.getMonth();
          const today = sameDay(d, now);
          const { allDay, timed } = dayEvents(s, d);
          const list = [...allDay, ...timed];
          const more = list.length - MONTH_SHOWN;
          return (
            <div
              key={d.toISOString()}
              onDoubleClick={(ev) => {
                if ((ev.target as HTMLElement).closest("button")) return;
                onNew(d);
              }}
              title="Double-click to add an event"
              className={cn(
                "flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-b border-hairline p-1",
                i % 7 !== 0 && "border-l",
                !inMonth && "bg-foreground/[0.02]",
                today && "bg-foreground/[0.035]",
              )}
            >
              <button
                onClick={() => onOpenDay(d)}
                title="Open this day"
                className={cn(
                  "mb-0.5 self-start rounded-full px-1.5 text-[12px] leading-[20px] font-semibold tabular-nums hover:bg-foreground/[0.07]",
                  !inMonth && "text-foreground/35",
                  today && "bg-[var(--bucket-needs_you)] text-white hover:bg-[var(--bucket-needs_you)]",
                )}
              >
                {d.getDate() === 1 ? d.toLocaleDateString([], { month: "short", day: "numeric" }) : d.getDate()}
              </button>
              {list.slice(0, more > 0 ? MONTH_SHOWN - 1 : MONTH_SHOWN).map((e) => (
                <MonthEvent key={e.id} e={e} s={s} flip={i % 7 >= 5} now={now} />
              ))}
              {more > 0 && (
                <button onClick={() => onOpenDay(d)} className="self-start rounded px-1 text-[11px] font-medium text-foreground/50 hover:bg-foreground/[0.07] hover:text-foreground">
                  +{more + 1} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** "From your inbox": its own component, so mail and triage changes re-render this list, not the grid. */
function InboxSuggestions() {
  const slice = useMail(useShallow(selectSuggestions));
  const everywhere = useSettings((x) => x.findDatesEverywhere);
  const suggestions = useMemo(() => inboxSuggestions(slice, everywhere), [slice, everywhere]);
  return (
    <aside className="flex w-[290px] shrink-0 flex-col gap-2.5 overflow-y-auto border-l border-hairline px-4 pt-1 pb-8 group-data-detail/main:hidden">
      <div className="pb-1 text-[11px] font-semibold tracking-[0.05em] text-foreground/40 uppercase">From your inbox</div>
      <AnimatePresence initial={false}>
        {suggestions.map((sug) => (
          <SuggestionCard key={sug.id} sug={sug} />
        ))}
      </AnimatePresence>
      {suggestions.length === 0 && <p className="text-[12.5px] text-foreground/40">You're all caught up.</p>}
    </aside>
  );
}

export function CalendarView() {
  const events = useMail((x) => x.events);
  const calendars = useMail((x) => x.calendars);
  const hiddenCalendars = useMail((x) => x.hiddenCalendars);
  const accountFilter = useMail((x) => x.accountFilter);
  const openNewEvent = useMail((x) => x.openNewEvent);
  // What the event helpers read.
  const s = { events, calendars, hiddenCalendars, accountFilter };
  const [offset, setOffset] = useState(0);
  const [mode, setMode] = useState<"week" | "day" | "month">("week");
  const [dayOffset, setDayOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const month = useMemo(() => monthGrid(monthOffset), [monthOffset]);
  const scroller = useRef<HTMLDivElement>(null);
  const now = new Date();

  const days = useMemo(() => {
    if (mode === "month") return month.days;
    if (mode === "day") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + dayOffset);
      return [d];
    }
    const monday = startOfWeek(new Date());
    monday.setDate(monday.getDate() + offset * 7);
    const count = (now.getDay() === 0 || now.getDay() === 6) && offset === 0 ? 7 : 5;
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` is a fresh Date each render; it only picks 5 vs 7 columns, so the week/day/offset changes are what rebuild this.
  }, [mode, offset, dayOffset, month]);

  // Open the grid at 7 AM, or further down when now would be below the fold. Again on leaving Month,
  // which unmounts the grid.
  const monthShown = mode === "month";
  useEffect(() => {
    const el = scroller.current;
    if (monthShown || !el) return;
    const t = new Date();
    const hour = t.getHours() + t.getMinutes() / 60;
    const shown = el.clientHeight / HOUR;
    // 10px above the hour, so its label isn't cut off by the day headers.
    el.scrollTo({ top: Math.max(0, (hour > OPEN_AT + shown - 1 ? hour - shown / 3 : OPEN_AT) * HOUR - 10) });
  }, [monthShown]);

  // Weeks beyond the synced window (about a month ahead) load when you page to them.
  useEffect(() => {
    const end = new Date(days[days.length - 1]);
    end.setDate(end.getDate() + 1);
    void ensureEventRange(days[0], end);
  }, [days]);

  const title = (mode === "month" ? month.first : days[0]).toLocaleDateString([], { month: "long", year: "numeric" });
  const step = (n: number) =>
    mode === "week" ? setOffset((o) => o + n) : mode === "day" ? setDayOffset((o) => o + n) : setMonthOffset((o) => o + n);
  /** Open one date in the day view (from the month grid). */
  const openDay = (d: Date) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    setDayOffset(Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - today.getTime()) / 864e5));
    setMode("day");
  };

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 px-5 pb-3">
          <h2 className="text-[19px] font-semibold tracking-[-0.02em]">{title}</h2>
          {mode === "week" && <span className="text-[12.5px] text-foreground/45 tabular-nums">{weekLabel(days)}</span>}
          <div className="flex items-center gap-1">
            <button onClick={() => step(-1)} className="grid size-7 place-items-center rounded-md hover:bg-foreground/[0.06]" aria-label="Previous">
              <ChevronLeft className="size-4" />
            </button>
            <button
              onClick={() => {
                setOffset(0);
                setDayOffset(0);
                setMonthOffset(0);
              }}
              className="h-7 rounded-md bg-foreground/[0.06] px-2.5 text-[12px] font-medium hover:bg-foreground/10"
            >
              Today
            </button>
            <button onClick={() => step(1)} className="grid size-7 place-items-center rounded-md hover:bg-foreground/[0.06]" aria-label="Next">
              <ChevronRight className="size-4" />
            </button>
          </div>
          <button
            onClick={() => openNewEvent({})}
            className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-primary-foreground"
          >
            <CalendarPlus className="size-3.5" /> New event
          </button>
          <div className="inline-flex rounded-[9px] bg-foreground/[0.055] p-0.5">
            {(["day", "week", "month"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  "relative h-7 rounded-[7px] px-3 text-[12px] font-medium capitalize",
                  mode !== m && "text-foreground/50",
                )}
              >
                {mode === m && (
                  <motion.span layoutId="cal-mode" transition={SPRING_PILL} className="absolute inset-0 rounded-[7px] bg-[var(--pane)] shadow-[0_1px_2px_oklch(0_0_0/10%),0_0_0_1px_var(--hairline)]" />
                )}
                <span className="relative">{m}</span>
              </button>
            ))}
          </div>
        </div>

        {mode === "month" ? (
          <MonthView grid={month} s={s} now={now} onOpenDay={openDay} onNew={(d) => {
            const start = new Date(d);
            start.setHours(9, 0, 0, 0);
            openNewEvent({ start: start.toISOString(), end: new Date(start.getTime() + 30 * 60000).toISOString() });
          }} />
        ) : (
        <>
        <div className="grid border-y border-hairline" style={{ gridTemplateColumns: `52px repeat(${days.length}, 1fr)` }}>
          <div />
          {days.map((d) => {
            const today = sameDay(d, now);
            return (
              <div key={d.toISOString()} className="flex h-9 items-center gap-1.5 border-l border-hairline px-2.5 text-[12px] text-foreground/50">
                {d.toLocaleDateString([], { weekday: "short" })}
                <span
                  className={cn(
                    "text-[13.5px] font-semibold text-foreground tabular-nums",
                    today && "inline-grid h-[22px] min-w-[22px] place-items-center rounded-full bg-[var(--bucket-needs_you)] px-1.5 text-[12.5px] text-white",
                  )}
                >
                  {d.getDate()}
                </span>
              </div>
            );
          })}
        </div>

        {days.some((d) => dayEvents(s, d).allDay.length > 0) && (
          <div className="grid border-b border-hairline" style={{ gridTemplateColumns: `52px repeat(${days.length}, 1fr)` }}>
            <div className="py-1.5 pr-2 text-right text-[10px] text-foreground/35">all-day</div>
            {days.map((d) => (
              <div key={d.toISOString()} className="space-y-1 border-l border-hairline p-1">
                {dayEvents(s, d).allDay.map((e) => (
                  <div
                    key={e.id}
                    style={hue(eventHue(s, e))}
                    className={cn("cal-chip truncate rounded-[5px] px-2 py-0.5 text-[11px] font-semibold", Date.parse(e.end) < now.getTime() && "cal-past")}
                    title={e.title}
                  >
                    {e.title}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div
            className="relative grid"
            style={{
              gridTemplateColumns: `52px repeat(${days.length}, 1fr)`,
              height: 24 * HOUR,
              // Hour lines, and fainter half-hour lines.
              backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${HOUR - 1}px, var(--hairline) ${HOUR - 1}px ${HOUR}px), repeating-linear-gradient(to bottom, transparent 0 ${HOUR / 2 - 1}px, color-mix(in oklch, var(--hairline) 45%, transparent) ${HOUR / 2 - 1}px ${HOUR / 2}px)`,
            }}
          >
            <HourGutter showNow={days.some((d) => sameDay(d, now))} />
            {days.map((d, col) => {
              const today = sameDay(d, now);
              const weekend = days.length === 7 && (d.getDay() === 0 || d.getDay() === 6);
              const { bands, placed } = layoutDay(dayEvents(s, d).timed, d);
              const flip = days.length > 1 && col >= days.length - 2;
              return (
                <div
                  key={d.toISOString()}
                  onDoubleClick={(ev) => {
                    if ((ev.target as HTMLElement).closest(".cal-block, button")) return;
                    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                    const hours = Math.min(23.5, Math.floor(((ev.clientY - rect.top) / HOUR) * 2) / 2);
                    const start = new Date(d);
                    start.setHours(Math.floor(hours), (hours % 1) * 60, 0, 0);
                    openNewEvent({ start: start.toISOString(), end: new Date(start.getTime() + 30 * 60000).toISOString() });
                  }}
                  title="Double-click to add an event"
                  className={cn("relative border-l border-hairline", today ? "bg-foreground/[0.018]" : weekend && "bg-foreground/[0.012]")}
                >
                  {bands.map((x) => (
                    <EventBlock key={x.e.id} x={x} slot={null} past={Date.parse(x.e.end) < now.getTime()} flip={flip} />
                  ))}
                  {/* initial={false}: a week or day step remounts the columns; their events just appear. */}
                  <AnimatePresence initial={false}>
                    {placed.map((p) => (
                      <EventBlock
                        key={p.e.id}
                        x={p}
                        // Blocks over a band start past its edge stripe.
                        slot={{ lane: p.lane, span: p.span, lanes: p.lanes, inset: bands.some((b) => b.start < p.end && b.end > p.start) ? 7 : 3 }}
                        past={Date.parse(p.e.end) < now.getTime()}
                        flip={flip}
                      />
                    ))}
                  </AnimatePresence>
                  {today && <NowLine />}
                </div>
              );
            })}
          </div>
        </div>
        </>
        )}
      </div>

      <InboxSuggestions />
    </div>
  );
}
