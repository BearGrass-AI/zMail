// The Send later menu: preset times plus a date-time picker. Used by the composer and the assistant's send cards.

import { useState, type ReactElement } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { sendLaterTimes, validSendAt } from "@/lib/mail/scheduled";
import { localMinute } from "@/lib/dates/local";

function tomorrowAt8() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8, 0, 0, 0);
}

export function SendLaterMenu({ onPick, align = "end", trigger }: { onPick: (at: Date) => void; align?: "start" | "center" | "end"; trigger: ReactElement }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // The picker is a popover over the same trigger: a text input inside a menu fights its typeahead.
  const [pickOpen, setPickOpen] = useState(false);
  const [value, setValue] = useState("");
  const times = menuOpen ? sendLaterTimes() : [];
  const picked = value ? new Date(value).getTime() : NaN;
  // eslint-disable-next-line react-hooks/purity -- validity is judged against the current time on every render, by design
  const ok = Number.isFinite(picked) && validSendAt(picked, Date.now());

  const openPicker = () => {
    setValue(localMinute(tomorrowAt8()));
    // After the menu has closed, so its focus return doesn't dismiss the picker.
    setTimeout(() => setPickOpen(true), 0);
  };

  return (
    <span className="relative inline-flex">
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent align={align} className="w-auto min-w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-[9.5px] font-medium tracking-[0.06em] text-foreground/40 uppercase">Send later</DropdownMenuLabel>
            {times.map((t) => (
              <DropdownMenuItem key={t.label} onClick={() => onPick(t.at)} className="gap-4 px-2 py-1.5 text-[12.5px]">
                {t.label}
                <span className="ml-auto text-foreground/45 tabular-nums">{t.hint}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={openPicker} className="px-2 py-1.5 text-[12.5px]">
            Pick date &amp; time…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover open={pickOpen} onOpenChange={setPickOpen}>
        <PopoverTrigger nativeButton={false} render={<span aria-hidden className="pointer-events-none absolute inset-0" />} />
        <PopoverContent align={align} className="w-64">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!ok) return;
              setPickOpen(false);
              onPick(new Date(picked));
            }}
            className="flex flex-col gap-2"
          >
            <input
              type="datetime-local"
              autoFocus
              value={value}
              // eslint-disable-next-line react-hooks/purity -- the earliest allowed time is "now + 2 min" whenever this renders
              min={localMinute(new Date(Date.now() + 2 * 60_000))}
              onChange={(e) => setValue(e.target.value)}
              className="selectable h-8 rounded-md border border-hairline bg-[var(--pane)] px-2 text-[12.5px] tabular-nums outline-none"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setPickOpen(false);
                  setTimeout(() => setMenuOpen(true), 0);
                }}
                className="text-[12px] text-foreground/55 hover:text-foreground"
              >
                Back
              </button>
              <button disabled={!ok} className="ml-auto h-7 rounded-md bg-primary px-2.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50">
                Schedule
              </button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </span>
  );
}
