// A searchable checklist of a provider's models, shared by the Add provider and Manage models dialogs.

import { useState } from "react";
import { Check, Search } from "lucide-react";
import type { ModelInfo, ProviderTypeId } from "@/lib/ai/catalog";
import { modelDisplayName } from "@/lib/ai/assistant/model-choices";
import { HttpError } from "@/lib/transport";
import { cn } from "@/lib/utils";

/** A short, human message for a failed connect or model list. */
export function connectionError(err: unknown): string {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return "The API key was rejected.";
  return err instanceof Error ? err.message : String(err);
}

export function ModelChecklist({
  type,
  models,
  selected,
  onChange,
  available,
  disabled = false,
}: {
  type: ProviderTypeId;
  models: ModelInfo[];
  selected: string[];
  onChange: (ids: string[]) => void;
  /** Ids in the latest list from the provider; others are flagged. */
  available?: string[];
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle ? models.filter((m) => `${m.id} ${modelDisplayName(type, m)}`.toLowerCase().includes(needle)) : models;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <label className="flex h-8 items-center gap-2 rounded-lg border border-hairline bg-[var(--pane)] px-2.5 text-[12.5px] text-foreground/45 focus-within:ring-2 focus-within:ring-ring/30">
        <Search className="size-3.5 shrink-0" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search models…"
          aria-label="Search available models"
          className="selectable w-full bg-transparent text-foreground outline-none placeholder:text-foreground/40"
        />
      </label>
      <div className="flex items-center gap-1 px-1 text-[12px] text-foreground/55">
        <span className="flex-1">{selected.length} selected</span>
        <button
          type="button"
          disabled={disabled || !shown.length}
          onClick={() => onChange([...new Set([...selected, ...shown.map((m) => m.id)])])}
          className="rounded-md px-2 py-0.5 font-medium text-primary hover:bg-primary/10 disabled:opacity-40"
        >
          {needle ? "Select shown" : "Select all"}
        </button>
        <button
          type="button"
          disabled={disabled || !selected.length}
          onClick={() => onChange([])}
          className="rounded-md px-2 py-0.5 font-medium text-primary hover:bg-primary/10 disabled:opacity-40"
        >
          Clear all
        </button>
      </div>
      <div role="group" aria-label="Models zMail can use" className="max-h-[300px] min-h-0 overflow-y-auto rounded-xl bg-pane-2 p-1 shadow-[inset_0_0_0_1px_var(--hairline)]">
        {shown.map((m) => {
          const on = selected.includes(m.id);
          const name = modelDisplayName(type, m);
          return (
            <button
              key={m.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={`Enable ${m.id}`}
              disabled={disabled}
              onClick={() => toggle(m.id)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-foreground/[0.05] disabled:opacity-50"
            >
              <span className={cn("grid size-4 shrink-0 place-items-center rounded-[5px] border", on ? "border-primary bg-primary text-primary-foreground" : "border-foreground/25")}>
                {on && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{name}</span>
                {name !== m.id && <span className="block truncate font-mono text-[10.5px] text-foreground/40">{m.id}</span>}
                {available && !available.includes(m.id) && <span className="block text-[10.5px] text-amber-600 dark:text-amber-400">Not in the latest list from this provider</span>}
              </span>
              {m.tag && <span className="rounded bg-primary/12 px-1.5 py-px text-[10px] font-medium text-primary">{m.tag}</span>}
            </button>
          );
        })}
        {!shown.length && <p className="px-3 py-4 text-center text-[12px] text-foreground/40">{needle ? "No models match your search." : "No models found for this provider."}</p>}
      </div>
    </div>
  );
}
