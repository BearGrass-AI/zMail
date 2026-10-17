// Settings → Keyboard Shortcuts.

import { Group, Row } from "./settings-ui";

const SHORTCUTS: [string, string][] = [
  ["⌘1 / ⌘2 / ⌘3", "Today · Triage · Calendar"],
  ["J / K", "Next / previous email"],
  ["E", "Archive"],
  ["D", "Done (leaves Needs you)"],
  ["V", "Move to folder…"],
  ["S", "Star"],
  ["U", "Mark read / unread"],
  ["R", "Reply"],
  ["⇧R", "Draft reply with AI"],
  ["F", "Forward"],
  ["C", "New message"],
  ["# / ⌫", "Delete"],
  ["⌘K", "Search"],
  ["⌘,", "Settings"],
  ["Esc", "Close reader / composer"],
];

export function ShortcutsPage() {
  return (
    <Group>
      {SHORTCUTS.map(([k, d]) => (
        <Row key={k} label={d}>
          <span className="flex gap-1">
            {k.split(" ").map((part, i) =>
              part === "/" ? <span key={i} className="text-foreground/30">/</span> : <kbd key={i} className="kbd h-[20px] min-w-[22px] text-[11px]">{part}</kbd>,
            )}
          </span>
        </Row>
      ))}
    </Group>
  );
}
