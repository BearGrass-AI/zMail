import { CalendarDays } from "lucide-react";
import type { CalEvent, Email } from "@/lib/types";
import { eventForEmail, eventHue, sameDay, useMail } from "@/lib/store";
import { hue } from "./meta";

export function eventTime(e: CalEvent, withDay = true) {
  const d = new Date(e.start);
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(":00", "");
  if (!withDay || sameDay(d, new Date())) return t;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
}

/** "📅 Lunch · Dana · 12" — shown on emails that relate to a meeting. */
export function EventChip({ email }: { email: Email }) {
  const setView = useMail((s) => s.setView);
  const e = useMail((s) => eventForEmail(s, email));
  const invite = useMail((s) => s.calSuggestions.find((x) => x.emailSubject && email.subject.includes(x.emailSubject)));
  const evHue = useMail((s) => (e ? eventHue(s, e) : 255));
  if (!e && invite)
    return (
      <button
        onClick={(ev) => {
          ev.stopPropagation();
          setView({ kind: "calendar" });
        }}
        title="Respond in Calendar"
        style={hue(255)}
        className="tint tint-chip inline-flex h-[21px] shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap"
      >
        <CalendarDays className="size-3" />
        {invite.kind === "invite" ? "RSVP" : invite.kind === "extracted" ? "Add to calendar" : "Block time"}
      </button>
    );
  if (!e) return null;
  return (
    <button
      onClick={(ev) => {
        ev.stopPropagation();
        setView({ kind: "calendar" });
      }}
      title="Open in Calendar"
      style={hue(evHue)}
      className="tint tint-chip inline-flex h-[21px] shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap"
    >
      <CalendarDays className="size-3" />
      {e.title} · {eventTime(e)}
    </button>
  );
}
