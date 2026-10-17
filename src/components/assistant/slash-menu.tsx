// src/components/assistant/slash-menu.tsx
// The popup above the assistant input: slash commands, or sender suggestions after a chip.

import type { MenuItem } from "@/lib/ai/assistant/commands";
import { SenderAvatar } from "../meta";

export const slashOptionId = (i: number) => `slash-option-${i}`;
export const SLASH_LISTBOX_ID = "slash-menu";

const HEADING: Record<"mail" | "email" | "sender" | "person", string> = { mail: "Your mail", email: "This email", sender: "Senders", person: "People" };
const headingOf = (it: MenuItem) => (it.type === "sender" || it.type === "person" ? HEADING[it.type] : HEADING[it.command.group]);
const keyOf = (it: MenuItem) => (it.type === "command" ? `c:${it.command.name}` : it.type === "person" ? `p:${it.p.address}` : `s:${it.s.kind}:${it.s.value}`);

export function SlashMenu({ items, active, onActive, onPick }: { items: MenuItem[]; active: number; onActive: (i: number) => void; onPick: (item: MenuItem) => void }) {
  return (
    <div className="absolute inset-x-0 bottom-full z-20 mb-1.5 overflow-hidden rounded-xl bg-pane-2 shadow-lg ring-1 ring-hairline">
      <div id={SLASH_LISTBOX_ID} role="listbox" aria-label={items.every((it) => it.type === "person") ? "People" : "Commands"} className="max-h-72 overflow-y-auto p-1">
        {items.map((it, i) => {
          const heading = headingOf(it);
          const showHeading = i === 0 || headingOf(items[i - 1]) !== heading;
          return (
            <div key={keyOf(it)}>
              {showHeading && <div className="px-2 pt-1.5 pb-1 text-[9.5px] font-semibold tracking-wide text-foreground/40 uppercase">{heading}</div>}
              <div
                id={slashOptionId(i)}
                role="option"
                aria-selected={i === active}
                ref={(el) => {
                  if (el && i === active) el.scrollIntoView({ block: "nearest" });
                }}
                onMouseEnter={() => onActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus in the textarea
                  onPick(it);
                }}
                className={`flex cursor-pointer ${it.type === "person" ? "items-center" : "items-baseline"} gap-2 rounded-lg px-2 py-1.5 text-[12.5px] ${i === active ? "bg-primary/12" : ""}`}
              >
                {it.type === "command" ? (
                  <>
                    <span className={`font-mono font-bold ${i === active ? "text-primary" : ""}`}>/{it.command.name}</span>
                    <span className="truncate text-foreground/50">{it.command.description}</span>
                  </>
                ) : it.type === "person" ? (
                  <>
                    <SenderAvatar contact={{ name: it.p.name, address: it.p.address }} className="size-5 self-center text-[8.5px]" compact />
                    <span className="truncate">{it.p.name}</span>
                    <span className="truncate text-[11px] text-foreground/35">{it.p.address}</span>
                    {it.p.source === "directory" && <span className="ml-auto shrink-0 text-[10px] font-medium tracking-wide text-foreground/35 uppercase">Directory</span>}
                  </>
                ) : (
                  <>
                    <span className="truncate">{it.s.label}</span>
                    <span className="shrink-0 text-[11px] text-foreground/45">{it.s.count} {it.s.count === 1 ? "email" : "emails"}</span>
                    {it.s.label !== it.s.value && <span className="truncate text-[11px] text-foreground/35">{it.s.value}</span>}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-hairline px-3 py-1.5 text-[10.5px] text-foreground/40">↑↓ choose · Tab or ↵ pick · Esc close</div>
    </div>
  );
}
