import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { useMail } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * "Check for new mail": spins while a check or sort runs (yours or the automatic one),
 * then briefly shows a check after one you started.
 */
export function RefreshButton({ className }: { className?: string }) {
  const refresh = useMail((s) => s.refresh);
  const busy = useMail((s) => s.sorting.running || Object.values(s.accountStatus).some((x) => x?.state === "syncing"));
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const run = async () => {
    if (phase === "running") return;
    clearTimeout(timer.current);
    setPhase("running");
    // Spin long enough to see, even when there's nothing new.
    await Promise.all([refresh().catch(() => undefined), new Promise((r) => setTimeout(r, 600))]);
    setPhase("done");
    timer.current = setTimeout(() => setPhase("idle"), 1500);
  };

  const spinning = phase === "running" || (phase === "idle" && busy);
  const label = spinning ? "Checking for new mail…" : phase === "done" ? "Up to date" : "Check for new mail";
  return (
    <button onClick={() => void run()} className={className} aria-label={label} title={label}>
      {phase === "done" ? (
        <Check className="size-3.5 text-primary" />
      ) : (
        <RefreshCw className={cn("size-3.5", spinning && "animate-spin text-primary")} />
      )}
    </button>
  );
}
