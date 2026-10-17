import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { SPRING, useEntranceOnce } from "@/lib/motion";
import { CalendarDays, Check, ChevronRight, MapPin, Mail, Video } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { allDayOn, emailForEvent, eventHue, eventsOn, inboxSuggestions, nextEvent, sameDay, selectSuggestions, useMail } from "@/lib/store";
import { SuggestionCard } from "../suggestion-card";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { eventTime } from "../event-chip";
import { hue } from "../meta";

const HOUR = 44;

function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function minutesUntil(iso: string, now: Date) {
  return Math.round((Date.parse(iso) - now.getTime()) / 60000);
}

export function AgendaRail() {
  const sug = useMail(useShallow(selectSuggestions));
  const events = useMail((x) => x.events);
  const accountFilter = useMail((x) => x.accountFilter);
  const select = useMail((x) => x.select);
  const setView = useMail((x) => x.setView);
  // What the event helpers read; `sug` already carries calendars, hiddenCalendars and emails.
  const s = { events, calendars: sug.calendars, hiddenCalendars: sug.hiddenCalendars, accountFilter, emails: sug.emails };
  const now = useNow();
  const nextEntrance = useEntranceOnce("today-up-next", { opacity: 0, y: 6 });
  // After the day's last meeting, look ahead to the next day that has events.
  let railDay = new Date(now);
  let today = eventsOn(s, now);
  if (!today.some((e) => Date.parse(e.end) > now.getTime())) {
    for (let i = 1; i <= 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      d.setHours(0, 0, 0, 0);
      const evs = eventsOn(s, d);
      if (evs.length) {
        railDay = d;
        today = evs;
        break;
      }
    }
  }
  const isToday = sameDay(railDay, now);
  const next = isToday ? nextEvent(s, now) : today[0] ?? null;
  const dayLabel = isToday
    ? "Today"
    : sameDay(railDay, new Date(now.getTime() + 864e5))
      ? "Tomorrow"
      : railDay.toLocaleDateString([], { weekday: "long" });
  const nextMail = next ? emailForEvent(s, next) : undefined;
  // Dates and invites found in mail, for the account the switcher shows.
  const everywhere = useSettings((x) => x.findDatesEverywhere);
  // Rebuilt only when the mail changes, not on every triage or suggestion update.
  const emailsById = useMemo(() => new Map(sug.emails.map((e) => [e.id, e])), [sug.emails]);
  const suggestions = useMemo(() => {
    return inboxSuggestions(sug, everywhere).filter((x) => {
      if (!accountFilter) return true;
      const mail = x.emailId ? emailsById.get(x.emailId) : undefined;
      const account = mail?.accountId ?? sug.calendars.find((c) => c.id === x.calendarId)?.accountId;
      return !account || account === accountFilter;
    });
  }, [sug, everywhere, accountFilter, emailsById]);
  const [allSug, setAllSug] = useState(false);
  const shownSug = allSug ? suggestions : suggestions.slice(0, 3);

  const startHour = Math.min(8, ...today.map((e) => new Date(e.start).getHours()));
  const endHour = Math.max(18, ...today.map((e) => new Date(e.end).getHours() + 1));
  const y = (d: Date) => (d.getHours() + d.getMinutes() / 60 - startHour) * HOUR;
  const mins = next ? minutesUntil(next.start, now) : 0;

  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-hairline bg-foreground/[0.012] px-4 pt-5 pb-8 group-data-detail/main:hidden">
      {next ? (
        <motion.div
          initial={nextEntrance}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING}
          style={hue(eventHue(s, next))}
          className="tint relative shrink-0 overflow-hidden rounded-2xl p-3.5 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--tint)_35%,transparent)]"
        >
          <div className="tint-soft absolute inset-0" />
          <div className="relative">
            <div className="tint-text text-[10.5px] font-semibold tracking-[0.05em] uppercase">
              {!isToday
                ? `Up next · ${dayLabel} ${eventTime(next, false)}`
                : mins > 0
                  ? `Up next · in ${mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} hr`}`
                  : "Happening now"}
            </div>
            <div className="mt-1 text-[15px] font-bold tracking-[-0.01em]">{next.title}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-foreground/60">
              <span className="shrink-0 whitespace-nowrap">
                {eventTime(next, false)}–{new Date(next.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
              {next.location && (
                <>
                  <MapPin className="ml-1 size-3 shrink-0" />
                  <span className="truncate" title={next.location}>
                    {next.location}
                  </span>
                </>
              )}
            </div>
            {(nextMail || next.video) && (
              <div className="mt-2.5 flex gap-1.5">
                {nextMail && (
                  <button
                    onClick={() => select(nextMail.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-black/[0.06] px-2.5 py-2 text-left text-[12px] text-foreground/75 transition hover:bg-black/10 dark:bg-black/25 dark:hover:bg-black/35"
                  >
                    <Mail className="tint-text size-3.5 shrink-0" />
                    <span className="truncate">{nextMail.subject}</span>
                  </button>
                )}
                {next.video && (
                  <button className="tint-grad flex items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold">
                    <Video className="size-3.5" /> Join
                  </button>
                )}
              </div>
            )}
          </div>
        </motion.div>
      ) : (
        <div className="flex items-center gap-2 rounded-2xl bg-foreground/[0.04] p-3.5 text-[13px] text-foreground/60">
          <Check className="size-4 text-[var(--bucket-ready_archive)]" /> No more meetings today.
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 pt-1 text-[11px] font-semibold tracking-[0.05em] text-foreground/40 uppercase">
            <Mail className="size-3.5" /> From your inbox
            <span className="font-medium tracking-normal tabular-nums">· {suggestions.length}</span>
          </div>
          <AnimatePresence initial={false}>
            {shownSug.map((sug) => (
              <SuggestionCard key={sug.id} sug={sug} />
            ))}
          </AnimatePresence>
          {suggestions.length > 3 && (
            <button onClick={() => setAllSug((v) => !v)} className="self-start px-1 text-[12px] font-medium text-primary hover:underline">
              {allSug ? "Show fewer" : `Show ${suggestions.length - 3} more`}
            </button>
          )}
        </div>
      )}

      <button
        onClick={() => setView({ kind: "calendar" })}
        className="flex items-center gap-1.5 pt-1 text-[11px] font-semibold tracking-[0.05em] text-foreground/40 uppercase hover:text-foreground/70"
      >
        <CalendarDays className="size-3.5" /> {dayLabel}
        <ChevronRight className="ml-auto size-3.5" />
      </button>

      {allDayOn(s, railDay).map((e) => (
        <div key={e.id} style={hue(eventHue(s, e))} className="cal-ev truncate rounded-lg px-2 py-1 text-[11.5px] font-semibold" title={e.title}>
          {e.title} <span className="font-normal opacity-70">· all day</span>
        </div>
      ))}

      <div className="relative" style={{ height: (endHour - startHour) * HOUR }}>
        {Array.from({ length: endHour - startHour }, (_, i) => (
          <div
            key={i}
            className="absolute inset-x-0 border-t border-hairline pt-0.5 text-[10px] text-foreground/30"
            style={{ top: i * HOUR }}
          >
            {((startHour + i + 11) % 12) + 1}
          </div>
        ))}
        {today.map((e) => {
          const top = y(new Date(e.start));
          const h = Math.max(20, y(new Date(e.end)) - top - 2);
          const mail = emailForEvent(s, e);
          const past = isToday && Date.parse(e.end) < now.getTime();
          return (
            <button
              key={e.id}
              onClick={() => (mail ? select(mail.id) : setView({ kind: "calendar" }))}
              style={{ ...hue(eventHue(s, e)), top, height: h }}
              className={cn(
                "cal-ev absolute right-0 left-6 overflow-hidden rounded-lg px-2 py-1 text-left text-[11.5px] leading-tight transition hover:brightness-110",
                past && "opacity-45",
              )}
            >
              <div className="truncate font-semibold">{e.title}</div>
              {h > 30 && (
                <div className="truncate opacity-75">
                  {eventTime(e, false)}
                  {e.location ? ` · ${e.location}` : e.attendees[0] ? ` · ${e.attendees[0].name}` : ""}
                </div>
              )}
              {mail && <Mail className="absolute top-1.5 right-1.5 size-3 opacity-70" />}
            </button>
          );
        })}
        {isToday && now.getHours() >= startHour && now.getHours() < endHour && (
          <div className="absolute right-0 left-5 z-10 h-0.5 bg-[var(--bucket-needs_you)]" style={{ top: y(now) }}>
            <span className="absolute -top-[3px] -left-1 size-2 rounded-full bg-[var(--bucket-needs_you)]" />
          </div>
        )}
      </div>
    </aside>
  );
}
