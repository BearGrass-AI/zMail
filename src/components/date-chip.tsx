// Small chips for mail with dates: the date found in it ("Due Thu Oct 24") and,
// on "Needs you" rows, which section it also belongs to.

import { CalendarDays } from "lucide-react";
import type { Email } from "@/lib/types";
import { localDate } from "@/lib/ai/dates";
import { datesShownFor, sectionOf, useMail } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { SECTION_ICON } from "@/lib/meta";
import { hue } from "./meta";

const chip = "tint tint-chip inline-flex h-[21px] shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap";

function dayLabel(date: string) {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (date === localDate(today)) return "today";
  if (date === localDate(tomorrow)) return "tomorrow";
  const d = new Date(`${date}T00:00:00`);
  const soon = d.getTime() - today.getTime() < 6 * 864e5;
  return d.toLocaleDateString([], soon ? { weekday: "short" } : { weekday: "short", month: "short", day: "numeric" });
}

export function DateChip({ email }: { email: Email }) {
  const finds = useMail((s) => s.dateFinds[email.id]);
  const section = useMail((s) => sectionOf(s, email));
  const everywhere = useSettings((x) => x.findDatesEverywhere);
  const shown = useMail((s) => datesShownFor(s, email, everywhere));
  if (!finds?.length || !shown) return null;
  const today = localDate(new Date());
  const upcoming = finds.filter((f) => f.date >= today);
  if (!upcoming.length) return null;
  const f = upcoming[0];
  const day = dayLabel(f.date);
  const urgent = day === "today" || day === "tomorrow";
  const text =
    upcoming.length > 1 ? `${upcoming.length} dates` : f.kind === "event" ? day.charAt(0).toUpperCase() + day.slice(1) : `Due ${day}`;
  return (
    <span
      title={upcoming.map((x) => `${x.title} · ${x.date}${x.time ? ` ${x.time}` : ""}`).join("\n")}
      style={urgent ? ({ "--h": "var(--h-needs_you)" } as React.CSSProperties) : section ? hue(section.hue) : ({ "--h": "var(--h-accent)" } as React.CSSProperties)}
      className={chip}
    >
      <CalendarDays className="size-3" /> {text}
    </span>
  );
}

/** "Bills" on a Needs-you row whose email is also in a section. */
export function SectionTag({ email }: { email: Email }) {
  const section = useMail((s) => sectionOf(s, email));
  if (!section) return null;
  const Icon = SECTION_ICON[section.icon];
  return (
    <span style={hue(section.hue)} className={chip} title={`Also in ${section.name}`}>
      <Icon className="size-3" /> {section.name}
    </span>
  );
}
