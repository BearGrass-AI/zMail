// "From your inbox" cards: invites, bookings and dates found in your sections,
// each one click from the calendar. Shown on Today's rail and in Calendar.

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { SPRING } from "@/lib/motion";
import { CalendarPlus, ChevronDown, Loader2, PlaneTakeoff, Sparkles, Users } from "lucide-react";
import { toast } from "sonner";
import type { CalSuggestion } from "@/lib/types";
import { useMail } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { SECTION_ICON } from "@/lib/meta";
import { Tile, hue } from "./meta";

const KIND = {
  invite: { icon: Users, h: 255 },
  extracted: { icon: PlaneTakeoff, h: 210 },
  block: { icon: Sparkles, h: 75 },
};

export function suggestionWhen(sug: CalSuggestion) {
  const d = new Date(sug.start);
  const day = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return sug.allDay ? `${day} · all day` : `${day} · ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function SuggestionCard({ sug, onAccept, onDismiss }: { sug: CalSuggestion; onAccept?: (calendarId: string) => Promise<void>; onDismiss?: () => void }) {
  const s = useMail();
  const section = sug.sectionId ? s.sections.find((x) => x.id === sug.sectionId) : undefined;
  // The suggestion's default calendar can arrive after the card mounts (calendars sync after saved
  // suggestions render), so only an explicit pick is kept in state; otherwise follow the live default.
  const [picked, setCalendarId] = useState<string>();
  const calendarId = picked || sug.calendarId;
  const [busy, setBusy] = useState<"yes" | "maybe" | null>(null);
  // A ref, not state: a double click lands before the re-render that disables the buttons.
  const inFlight = useRef(false);
  const calendars = s.calendars.filter((c) => !s.hiddenCalendars.has(c.id) || c.id === calendarId);
  const calendar = s.calendars.find((c) => c.id === calendarId);
  /** A pick becomes that account's default for next time (the account whose calendar was suggested). */
  const pickCalendar = (id: string) => {
    setCalendarId(id);
    const account = s.calendars.find((c) => c.id === sug.calendarId)?.accountId;
    if (!account) return;
    const st = useSettings.getState();
    if (st.defaultCalendars[account] !== id) st.set({ defaultCalendars: { ...st.defaultCalendars, [account]: id } });
  };
  const h = section?.hue ?? KIND[sug.kind].h;
  const icon = section ? SECTION_ICON[section.icon] : KIND[sug.kind].icon;

  const accept = async (r: "yes" | "maybe" = "yes") => {
    if (inFlight.current) return;
    if (!calendarId) return toast.error("Connect a calendar first", { description: "Settings → Accounts." });
    inFlight.current = true;
    setBusy(r);
    try {
      if (onAccept) await onAccept(calendarId);
      else await s.acceptCalSuggestion(sug.id, r, calendarId);
      toast.success(sug.kind === "invite" ? (r === "yes" ? "Accepted" : "Marked as maybe") : `Added to ${calendar?.name ?? "calendar"}`, {
        description: sug.title,
      });
    } catch (err) {
      toast.error("Couldn't add it", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 20, transition: { duration: 0.15 } }}
      transition={SPRING}
      style={hue(h)}
      className="tint rounded-2xl bg-pane-2 p-3 shadow-[inset_0_0_0_1px_var(--hairline)]"
    >
      {section && (
        <div className="tint-text mb-1.5 flex items-center gap-1 text-[10.5px] font-semibold tracking-[0.05em] uppercase">
          {section.name}
          {sug.label && <span className="opacity-70">· {sug.label}</span>}
        </div>
      )}
      <div className="flex items-center gap-2.5">
        <Tile icon={icon} h={h} size={26} />
        <button
          onClick={() => sug.emailId && s.select(sug.emailId)}
          disabled={!sug.emailId}
          title={sug.emailId ? "Open the email" : undefined}
          className="min-w-0 text-left"
        >
          <div className="line-clamp-2 text-[13px] leading-snug font-semibold">{sug.title}</div>
          <div className="text-[11.5px] text-foreground/45">{suggestionWhen(sug)}</div>
        </button>
      </div>
      {sug.quote ? (
        <p className="mt-2 line-clamp-2 text-[12px] leading-snug text-foreground/50">“{sug.quote}”</p>
      ) : (
        <p className="mt-2 text-[12px] leading-snug text-foreground/55">{sug.detail}</p>
      )}
      <div className="mt-2.5 flex items-center gap-1.5">
        {sug.kind === "invite" ? (
          <>
            <button
              onClick={() => void accept("yes")}
              disabled={!!busy}
              className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--bucket-ready_archive)] text-[12px] font-semibold text-white disabled:opacity-60"
            >
              {busy === "yes" && <Loader2 className="size-3.5 animate-spin" />}
              Accept
            </button>
            <button
              onClick={() => void accept("maybe")}
              disabled={!!busy}
              className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-lg bg-foreground/[0.07] text-[12px] font-semibold hover:bg-foreground/10 disabled:opacity-60"
            >
              {busy === "maybe" && <Loader2 className="size-3.5 animate-spin" />}
              Maybe
            </button>
            <button
              disabled={!!busy}
              onClick={() => {
                s.dismissCalSuggestion(sug.id);
                toast("Declined", { description: sug.title });
              }}
              className="h-7 flex-1 rounded-lg bg-foreground/[0.07] text-[12px] font-semibold hover:bg-foreground/10"
            >
              Decline
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => void accept()}
              disabled={!!busy}
              className={cn("tint-grad flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold whitespace-nowrap", busy && "opacity-60")}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CalendarPlus className="size-3.5" />} {sug.kind === "block" ? "Block it" : "Add"}
            </button>
            <button onClick={() => (onDismiss ? onDismiss() : s.dismissCalSuggestion(sug.id))} className="h-7 shrink-0 rounded-lg bg-foreground/[0.07] px-2.5 text-[12px] font-semibold whitespace-nowrap hover:bg-foreground/10">
              Not now
            </button>
            {calendars.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  title={`Add to ${calendar?.name ?? "calendar"}`}
                  className="ml-auto flex h-7 min-w-0 items-center gap-1 rounded-lg px-1.5 text-[11.5px] text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  <span className="size-2 shrink-0 rounded-full" style={{ background: `oklch(0.66 0.15 ${calendar?.hue ?? 255})` }} />
                  <span className="min-w-0 truncate">{calendar?.name ?? "Calendar"}</span>
                  <ChevronDown className="size-3 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuRadioGroup value={calendarId} onValueChange={(v) => pickCalendar(v as string)}>
                    {calendars.map((c) => (
                      <DropdownMenuRadioItem key={c.id} value={c.id} closeOnClick>
                        <span className="size-2 rounded-full" style={{ background: `oklch(0.66 0.15 ${c.hue})` }} />
                        <span className="truncate">{c.name}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
