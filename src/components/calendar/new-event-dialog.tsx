import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarPlus, Loader2, MapPin, Users, Video } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { calendarProvider, useMail } from "@/lib/store";
import type { VideoOption } from "@/lib/calendar/provider";
import { zoomConnected } from "@/lib/zoom/zoom";
import { cn } from "@/lib/utils";
import { localDate, pad2 } from "@/lib/dates/local";

const toDateInput = localDate;
const toTimeInput = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** Next half hour, or tomorrow 9:00 once the workday is over. */
function nextHalfHour() {
  const d = new Date();
  if (d.getHours() >= 20) {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

const VIDEO_LABEL: Record<VideoOption, string> = { meet: "Google Meet", teams: "Teams", zoom: "Zoom" };

export function NewEventDialog() {
  const prefill = useMail((s) => s.newEvent);
  const close = useMail((s) => s.openNewEvent);
  const calendars = useMail((s) => s.calendars);
  const createEvent = useMail((s) => s.createEvent);
  const [zoomOk, setZoomOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: "", calendarId: "", date: "", start: "", end: "", attendees: "", location: "", notes: "", video: null as VideoOption | null });

  useEffect(() => {
    if (!prefill) return;
    void zoomConnected().then(setZoomOk);
    const start = prefill.start ? new Date(prefill.start) : nextHalfHour();
    const end = prefill.end ? new Date(prefill.end) : new Date(start.getTime() + 30 * 60000);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- form is editable local state seeded from the prefill (default start is "now"); deriving it in render would discard edits
    setForm({
      title: prefill.title ?? "",
      calendarId: prefill.calendarId ?? calendars[0]?.id ?? "",
      date: toDateInput(start),
      start: toTimeInput(start),
      end: toTimeInput(end),
      attendees: (prefill.attendees ?? []).join(", "),
      location: prefill.location ?? "",
      notes: prefill.description ?? "",
      video: null,
    });
  }, [prefill, calendars]);

  const cal = calendars.find((c) => c.id === form.calendarId);
  const videoOptions = useMemo<VideoOption[]>(() => {
    const native = cal ? calendarProvider(cal.accountId)?.nativeVideo ?? [] : (["meet", "teams"] as VideoOption[]);
    // Demo calendars can preview any option; Zoom only once connected.
    const base = cal && calendarProvider(cal.accountId) ? native : (["meet", "teams"] as VideoOption[]);
    return zoomOk ? [...base, "zoom"] : base;
  }, [cal, zoomOk]);

  // A ref, not state: Enter in the title and the button can both land before a re-render.
  const inFlight = useRef(false);
  const save = async () => {
    if (inFlight.current) return;
    if (!form.title.trim()) return toast.error("Give the event a title");
    const start = new Date(`${form.date}T${form.start}`);
    const end = new Date(`${form.date}T${form.end}`);
    // An end time earlier than the start means the event runs past midnight.
    if (end <= start) end.setDate(end.getDate() + 1);
    inFlight.current = true;
    setBusy(true);
    try {
      const ev = await createEvent({
        calendarId: form.calendarId,
        title: form.title.trim(),
        start: start.toISOString(),
        end: end.toISOString(),
        location: form.location.trim() || undefined,
        description: form.notes.trim() || undefined,
        attendees: form.attendees.split(/[,;\s]+/).map((x) => x.trim()).filter((x) => x.includes("@")),
        video: form.video,
      });
      toast.success(`Created “${ev.title}”`, ev.joinUrl ? { description: ev.joinUrl } : undefined);
      close(null);
    } catch (err) {
      toast.error("Couldn't create the event", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const input = "selectable h-8 w-full rounded-lg border border-hairline bg-[var(--pane)] px-2.5 text-[13px] outline-none focus:ring-2 focus:ring-ring/30";

  return (
    <Dialog open={!!prefill} onOpenChange={(o) => !o && close(null)}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[500px]">
        <div className="flex items-center gap-2.5 border-b border-hairline px-5 py-4">
          <CalendarPlus className="size-4 text-primary" />
          <DialogTitle className="text-[15px] font-semibold">New event</DialogTitle>
        </div>
        <div className="space-y-3 px-5 py-4">
          <input
            autoFocus
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void save()}
            placeholder="Title"
            className="selectable w-full bg-transparent text-[18px] font-semibold tracking-[-0.01em] outline-none placeholder:text-foreground/30"
          />
          <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-2">
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className={input} aria-label="Date" />
            <input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} className={input} aria-label="Start" />
            <input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} className={input} aria-label="End" />
          </div>
          <select value={form.calendarId} onChange={(e) => setForm({ ...form, calendarId: e.target.value, video: null })} className={input} aria-label="Calendar">
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2">
            <Users className="size-4 shrink-0 text-foreground/40" />
            <input value={form.attendees} onChange={(e) => setForm({ ...form, attendees: e.target.value })} placeholder="Invite people (emails, comma separated)" className={input} />
          </label>
          <label className="flex items-center gap-2">
            <MapPin className="size-4 shrink-0 text-foreground/40" />
            <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Location" className={input} />
          </label>
          <div className="flex items-center gap-2">
            <Video className="size-4 shrink-0 text-foreground/40" />
            <div className="inline-flex rounded-lg bg-foreground/[0.06] p-0.5">
              {([null, ...videoOptions] as (VideoOption | null)[]).map((v) => (
                <button
                  key={v ?? "none"}
                  onClick={() => setForm({ ...form, video: v })}
                  className={cn(
                    "h-7 rounded-md px-3 text-[12px] font-medium",
                    form.video === v ? "bg-[var(--pane)] shadow-sm ring-1 ring-hairline" : "text-foreground/55",
                  )}
                >
                  {v ? VIDEO_LABEL[v] : "No video"}
                </button>
              ))}
            </div>
            {!zoomOk && <span className="text-[11px] text-foreground/35">Zoom: connect in Settings</span>}
          </div>
          <textarea
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            rows={3}
            placeholder="Notes"
            className="selectable w-full resize-none rounded-lg border border-hairline bg-[var(--pane)] px-2.5 py-2 text-[13px] outline-none focus:ring-2 focus:ring-ring/30"
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
          <button onClick={() => close(null)} className="h-8 rounded-lg px-3 text-[13px] text-foreground/60 hover:bg-foreground/5">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground disabled:opacity-60"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {form.attendees.trim() ? "Send invites" : "Create"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
