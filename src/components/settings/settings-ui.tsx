// Building blocks shared by the Settings pages: grouped panels of rows, like macOS System Settings.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      {title && <h3 className="mb-2 px-1 text-[12px] font-semibold text-foreground/50">{title}</h3>}
      <div className="divide-y divide-hairline overflow-hidden rounded-xl bg-pane-2 shadow-[inset_0_0_0_1px_var(--hairline)]">{children}</div>
      {footer && <p className="mt-2 px-1 text-[11.5px] leading-snug text-foreground/40">{footer}</p>}
    </section>
  );
}

export function Row({ label, hint, disabled, children }: { label: ReactNode; hint?: ReactNode; disabled?: boolean; children?: ReactNode }) {
  return (
    <div className={cn("flex min-h-12 items-center gap-4 px-4 py-2.5", disabled && "opacity-50")}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-foreground/45">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
