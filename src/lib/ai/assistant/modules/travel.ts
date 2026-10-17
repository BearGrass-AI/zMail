// Travel: drive times and leave-by times from Apple Maps, with expected traffic.
import { useSettings } from "@/lib/settings";
import { travelEta, type TravelEta, type TravelPlace } from "@/lib/maps";
import { useAssistant } from "../state";
import { extOf, type ToolModule } from "./types";
import { localMinute } from "@/lib/dates/local";

export interface TravelDeps {
  eta(from: string, to: string, departMs?: number): Promise<TravelEta>;
  places(): { home: string; work: string };
  now(): Date;
}

const ID = "travel";
const SAVED = { home: "Home", work: "Work" } as const;
type Saved = keyof typeof SAVED;


/** "45 min", "2 h", "2 h 31 min". */
export function formatDrive(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

interface Resolved {
  query: string;
  /** "Home" / "Work" when a saved place was used. */
  label?: string;
}

/** "home" / "work" become the saved address; anything else goes to Apple Maps as typed. */
function resolvePlace(raw: string, d: TravelDeps): Resolved | { error: string } {
  const key = raw.trim().toLowerCase();
  if (key !== "home" && key !== "work") return { query: raw.trim() };
  const saved = d.places()[key as Saved].trim();
  if (!saved) return { error: `No ${key} address saved. Ask the user where they're starting from, or suggest saving it in Settings → AI Assistant → Places.` };
  return { query: saved, label: SAVED[key as Saved] };
}

function parseTime(v: unknown, name: string): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const d = typeof v === "string" ? new Date(v.trim()) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw new Error(`bad_query: ${name} must be a local time like 2026-10-14T10:00`);
  return d;
}

const placeText = (r: Resolved, p: TravelPlace) => (r.label ? `${r.label}: ${r.query}` : p.address ? `${p.name} · ${p.address}` : p.name);

export const travelModule: ToolModule = {
  id: ID,
  prompt: [
    "- For how long a drive takes or when to leave, call travel_time; never estimate drive times yourself. Give the leave-by time, mention it's an Apple Maps estimate, and suggest a few minutes of buffer for parking or weather.",
    '- travel_time starts from "home" unless the user says otherwise. If no home address is saved, ask where they\'re starting from.',
  ],
  tools: [
    {
      name: "travel_time",
      description:
        'Driving time between two places from Apple Maps, with expected traffic at that time. Use it whenever the user asks how long a drive takes or when to leave. Places can be addresses, venue names with a town, or "home" / "work".',
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Destination" },
          from: { type: "string", description: 'Starting point; defaults to "home"' },
          arrive_by: { type: "string", description: "Local time to arrive by, YYYY-MM-DDTHH:mm" },
          depart_at: { type: "string", description: "Local departure time, YYYY-MM-DDTHH:mm; defaults to now" },
        },
        required: ["to"],
      },
    },
  ],
  handlers: {
    travel_time: async (args, deps) => {
      const d = extOf<TravelDeps>(deps, ID);
      if (typeof args.to !== "string" || !args.to.trim()) throw new Error("bad_query: to must be a place");
      if (args.from !== undefined && args.from !== null && typeof args.from !== "string") throw new Error("bad_query: from must be a place");
      const arriveBy = parseTime(args.arrive_by, "arrive_by");
      const departAt = parseTime(args.depart_at, "depart_at");
      if (arriveBy && departAt) throw new Error("bad_query: give arrive_by or depart_at, not both");

      const from = resolvePlace(typeof args.from === "string" && args.from.trim() ? args.from : "home", d);
      if ("error" in from) return from;
      const to = resolvePlace(args.to, d);
      if ("error" in to) return to;

      let eta: TravelEta;
      let depart: Date;
      let arrive: Date;
      if (arriveBy) {
        // MapKit's ETA depends on the departure time, so guess it from a first pass, then refine.
        const first = await d.eta(from.query, to.query, arriveBy.getTime());
        eta = await d.eta(from.query, to.query, arriveBy.getTime() - first.seconds * 1000);
        arrive = arriveBy;
        depart = new Date(arriveBy.getTime() - eta.seconds * 1000);
      } else {
        depart = departAt ?? d.now();
        eta = await d.eta(from.query, to.query, depart.getTime());
        arrive = new Date(depart.getTime() + eta.seconds * 1000);
      }

      const drive = formatDrive(eta.seconds);
      useAssistant.getState().push({ kind: "step", text: `Checked drive time · ${from.label ?? eta.from.name} → ${to.label ?? eta.to.name} · ${drive}` });
      return {
        from: placeText(from, eta.from),
        to: placeText(to, eta.to),
        drive,
        minutes: Math.round(eta.seconds / 60),
        miles: Math.round((eta.meters / 1609.344) * 10) / 10,
        depart: localMinute(depart),
        arrive: localMinute(arrive),
        ...(arriveBy ? { leave_by: localMinute(depart) } : {}),
        source: "Apple Maps estimate with expected traffic",
      };
    },
  },
  realDeps: (): TravelDeps => ({
    eta: travelEta,
    places: () => useSettings.getState().travelPlaces,
    now: () => new Date(),
  }),
};
