// "Show 10 at a time" for Today sections and Triage lanes. Hidden rows are
// still part of J/K order and "Select all"; walking past the end reveals more.

import { useState } from "react";
import { useMail } from "@/lib/store";
import { cn } from "@/lib/utils";

export const PAGE = 10;

export function usePaged<T extends { id: string }>(items: T[], step = PAGE) {
  const [limit, setLimit] = useState(step);
  const selectedId = useMail((s) => s.selectedId);
  const resetKey = useMail((s) => `${s.accountFilter}|${s.query}`);

  // A different account or search starts over at 10.
  const reset = `${resetKey}|${step}`;
  const [prevReset, setPrevReset] = useState(reset);
  const i = selectedId ? items.findIndex((x) => x.id === selectedId) : -1;
  if (prevReset !== reset) {
    setPrevReset(reset);
    setLimit(step);
  } else if (i >= limit) {
    // J/K onto a hidden row reveals the batch it's in.
    setLimit(Math.ceil((i + 1) / step) * step);
  }

  return {
    shown: items.slice(0, limit),
    hidden: Math.max(0, items.length - limit),
    total: items.length,
    expanded: limit > step,
    more: () => setLimit((l) => l + step),
    all: () => setLimit(items.length),
    less: () => setLimit(step),
  };
}

export function ShowMore({ paged, className }: { paged: ReturnType<typeof usePaged>; className?: string }) {
  const { hidden, total, expanded, more, all, less } = paged;
  if (!hidden && !expanded) return null;
  return (
    <div className={cn("mt-1.5 flex items-center gap-2.5 rounded-xl px-3 py-2 text-[12.5px] shadow-[inset_0_0_0_1px_var(--hairline)]", className)}>
      {hidden > 0 ? (
        <>
          <button onClick={more} className="font-semibold text-primary hover:underline">
            Show {Math.min(PAGE, hidden)} more
          </button>
          {hidden > PAGE && (
            <>
              <span className="h-3.5 w-px bg-hairline" />
              <button onClick={all} className="text-foreground/60 hover:text-foreground">
                Show all {total}
              </button>
            </>
          )}
          <span className="ml-auto text-[11.5px] text-foreground/40 tabular-nums">{hidden} more</span>
        </>
      ) : (
        <button onClick={less} className="text-foreground/60 hover:text-foreground">
          Show fewer
        </button>
      )}
    </div>
  );
}
