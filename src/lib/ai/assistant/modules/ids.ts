// Email ids the model hands back: only ids (and set_ids) from earlier tool results resolve.
import { useAssistant, type Ref } from "../state";

/** The email behind an id from an earlier tool result. */
export function refOf(id: unknown): Ref {
  const known = useAssistant.getState().known;
  if (typeof id === "string" && Object.hasOwn(known, id)) return known[id];
  throw new Error(`unknown id "${String(id)}": only use ids from earlier tool results`);
}

/** The emails named by `ids` and/or a `set_id`, deduped, at most `max`. */
export function refsFrom(a: Record<string, unknown>, opts: { max?: number } = {}): Ref[] {
  const st = useAssistant.getState();
  const refs: Ref[] = [];
  if (a.set_id !== undefined) {
    if (typeof a.set_id !== "string" || !Object.hasOwn(st.sets, a.set_id)) throw new Error(`unknown set_id "${String(a.set_id)}"`);
    refs.push(...st.sets[a.set_id].refs);
  }
  if (a.ids !== undefined) {
    if (!Array.isArray(a.ids)) throw new Error("bad_query: ids must be a list");
    refs.push(...a.ids.map(refOf));
  }
  const seen = new Set<string>();
  const out = refs.filter((r) => !seen.has(r.id) && !!seen.add(r.id));
  if (!out.length) throw new Error("bad_query: give ids or a set_id");
  if (opts.max !== undefined && out.length > opts.max) throw new Error(`bad_query: at most ${opts.max.toLocaleString()} emails at once; narrow the set`);
  return out;
}
