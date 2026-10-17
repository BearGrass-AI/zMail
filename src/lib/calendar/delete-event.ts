// Deleting an event by hand: guests hear about it, so ask first when there are any, and hold the delete behind Undo.

import { toast } from "sonner";
import type { CalEvent } from "@/lib/types";
import { useMail } from "@/lib/store";
import { EVENT_DELETE_HOLD_MS } from "@/lib/store/calendar-actions";

/** How many people a delete would email a cancellation: the attendees who aren't the user. */
export function otherGuests(e: CalEvent, mine: string[]): number {
  const me = new Set(mine.map((a) => a.toLowerCase()));
  return new Set(e.attendees.map((a) => a.address.toLowerCase()).filter((a) => a && !me.has(a))).size;
}

/** "Delete and notify 6 guests?" */
export const confirmDeleteText = (guests: number) => `Delete and notify ${guests} ${guests === 1 ? "guest" : "guests"}?`;

/** Off the calendar at once, behind an Undo toast; the server delete waits out the toast. A refusal puts it back and says so. */
export function deleteEventWithUndo(e: CalEvent) {
  const held = useMail.getState().holdDeleteEvent(e.id);
  if (!held) return;
  const id = toast(`Deleted "${e.title}"`, { duration: EVENT_DELETE_HOLD_MS, action: { label: "Undo", onClick: held.undo } });
  held.done.catch((err: unknown) =>
    toast.error(`Couldn't delete "${e.title}"`, { id, description: `${err instanceof Error ? err.message : String(err)} It's back on your calendar.` }),
  );
}
