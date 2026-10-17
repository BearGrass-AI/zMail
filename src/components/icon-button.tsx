import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Props = ComponentProps<"button"> & { label: string; active?: boolean };

/** Round toolbar button, as in the reader / list headers. */
export const RoundButton = forwardRef<HTMLButtonElement, Props>(function RoundButton(
  { label, active, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      className={cn(
        "no-drag grid size-8 place-items-center rounded-full border border-hairline bg-pane text-foreground/75 transition-[background-color,color] duration-150 hover:bg-pane-2 hover:text-foreground disabled:opacity-40 [&_svg]:size-[15px]",
        active && "tint tint-soft tint-text",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

export function WithTip({ tip, shortcut, children }: { tip: string; shortcut?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
      <TooltipContent>
        {tip}
        {shortcut && <kbd className="ml-1 rounded bg-background/20 px-1 font-sans text-[10px]">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}
