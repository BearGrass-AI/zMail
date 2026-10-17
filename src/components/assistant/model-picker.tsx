// The assistant's model picker: a quiet pill in the ask box that opens a searchable list of models,
// grouped by provider. Picking one sets the Assistant model (the panel and the ✦ search both use it).

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Search, SlidersHorizontal } from "lucide-react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { resolveAssistant, useSettings } from "@/lib/settings";
import { useSettingsOpen } from "@/lib/settings-open";
import { currentChoiceKey, modelChoices, type ModelChoice } from "@/lib/ai/assistant/model-choices";
import { useModelHealth } from "@/lib/ai/assistant/model-health";
import { ProviderLogo } from "./provider-logo";

export const useModelPickerOpen = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

/** Make `choice` the Assistant model. */
export function pickModel(choice: ModelChoice) {
  useSettings.getState().setRole("assistant", { providerId: choice.providerId, model: choice.model });
}

export function ModelPicker() {
  const { aiProviders, aiRoles } = useSettings(useShallow((s) => ({ aiProviders: s.aiProviders, aiRoles: s.aiRoles })));
  const health = useModelHealth((s) => s.health);
  const open = useModelPickerOpen((s) => s.open);
  const setOpen = useModelPickerOpen((s) => s.setOpen);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  const choices = useMemo(() => modelChoices({ aiProviders }), [aiProviders]);
  const currentKey = currentChoiceKey({ aiProviders, aiRoles });
  const resolved = resolveAssistant({ aiProviders, aiRoles });
  const current = choices.find((c) => c.key === currentKey);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? choices.filter((c) => `${c.name} ${c.model}`.toLowerCase().includes(needle)) : choices;
  }, [choices, q]);
  const groups = useMemo(() => {
    const out: { title: string; items: { c: ModelChoice; i: number }[] }[] = [];
    shown.forEach((c, i) => {
      let g = out.find((x) => x.title === c.group);
      if (!g) out.push((g = { title: c.group, items: [] }));
      g.items.push({ c, i });
    });
    return out;
  }, [shown]);

  // Opening starts with an empty search on the current model.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQ("");
      setActive(Math.max(0, choices.findIndex((c) => c.key === currentKey)));
    }
  }

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
    // Attach only while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (c: ModelChoice) => {
    pickModel(c);
    setOpen(false);
  };

  const label = current?.name ?? resolved?.model ?? "Offline demo";
  const logoProvider = current?.provider ?? resolved?.provider.type;

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Assistant model"
        className="flex h-7 max-w-40 items-center gap-1.5 rounded-lg px-1.5 text-[12px] text-foreground/55 hover:bg-foreground/[0.07] hover:text-foreground"
      >
        {logoProvider ? <ProviderLogo provider={logoProvider} className="size-3.5 shrink-0" /> : <Bot className="size-3.5 shrink-0" aria-hidden />}
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0" />
      </button>
      {open && (
        <div className="absolute right-0 bottom-full z-20 mb-2 w-72 overflow-hidden rounded-xl bg-pane-2 shadow-lg ring-1 ring-hairline origin-bottom-right animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1 duration-150 ease-out">
          <label className="flex h-9 items-center gap-2 border-b border-hairline px-3 text-[12.5px] text-foreground/45">
            <Search className="size-3.5 shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation(); // App's global Esc would blur the input
                  setOpen(false);
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (shown.length) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (shown[active]) choose(shown[active]);
                }
              }}
              placeholder="Search your models…"
              aria-label="Search your models"
              className="selectable w-full bg-transparent text-foreground outline-none placeholder:text-foreground/40"
            />
          </label>
          <div role="listbox" aria-label="Assistant model" className="max-h-[300px] overflow-y-auto p-1">
            {shown.length === 0 && <div className="px-2 py-3 text-center text-[12px] text-foreground/45">No models match</div>}
            {groups.map((g) => (
              <div key={g.title} role="group" aria-label={g.title}>
                <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-foreground/45">{g.title}</div>
                {g.items.map(({ c, i }) => (
                  <div
                    key={c.key}
                    role="option"
                    aria-selected={c.key === currentKey}
                    ref={(el) => {
                      if (el && i === active) el.scrollIntoView({ block: "nearest" });
                    }}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(c);
                    }}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 ${i === active ? "bg-primary/12" : ""}`}
                  >
                    <ProviderLogo provider={c.provider} className="size-4 shrink-0 text-foreground/60" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px]">{c.name}</div>
                      <div className="truncate text-[11px] text-foreground/40">{c.model}</div>
                      {health[c.key] === "struggled" && <div className="text-[10.5px] text-amber-600 dark:text-amber-400">Struggled with zMail's tools</div>}
                    </div>
                    {c.key === currentKey && <Check className="size-3.5 shrink-0 text-primary" />}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              useSettingsOpen.getState().show("providers");
            }}
            className="flex w-full items-center gap-2 border-t border-hairline px-3 py-2 text-left text-[12px] text-foreground/60 hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <SlidersHorizontal className="size-3.5" />
            Manage providers &amp; models
          </button>
        </div>
      )}
    </div>
  );
}
