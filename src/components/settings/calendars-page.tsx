// Settings → Calendars: which calendars show in zMail.

import { Switch } from "@/components/ui/switch";
import { useMail } from "@/lib/store";
import { Group, Row } from "./settings-ui";

export function CalendarsPage() {
  const s = useMail();
  return (
    <Group title="Show in zMail" footer="Hidden calendars are left out of Today's agenda and the Calendar view.">
      {s.calendars.map((c) => (
        <Row key={c.id} label={<span className="flex items-center gap-2.5"><span className="size-3 rounded-full" style={{ background: `oklch(0.66 0.15 ${c.hue})` }} />{c.name}</span>}>
          <Switch checked={!s.hiddenCalendars.has(c.id)} onCheckedChange={() => s.toggleCalendar(c.id)} />
        </Row>
      ))}
    </Group>
  );
}
