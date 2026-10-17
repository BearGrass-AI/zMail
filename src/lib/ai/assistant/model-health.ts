// Which models have been seen working (or failing) with zMail's tools. Keyed by ModelChoice.key.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { mirroredStorage } from "@/lib/web-store";

export type ModelHealth = "ok" | "struggled";

interface ModelHealthStore {
  health: Record<string, ModelHealth>;
  mark: (key: string, h: ModelHealth) => void;
}

export const useModelHealth = create<ModelHealthStore>()(
  persist(
    (set) => ({
      health: {},
      mark: (key, h) => set((s) => (s.health[key] === h ? s : { health: { ...s.health, [key]: h } })),
    }),
    {
      name: "zmail.model-health",
      storage: createJSONStorage(() => mirroredStorage),
      partialize: (s) => ({ health: s.health }),
      // Version 1: one batch of calls into folders that didn't exist could mark a model "struggled". Marks
      // saved before then aren't trustworthy, so they're dropped; "ok" marks stay.
      version: 1,
      migrate: (persisted, version) => {
        const health = (persisted as { health?: Record<string, ModelHealth> } | undefined)?.health ?? {};
        return { health: version < 1 ? Object.fromEntries(Object.entries(health).filter(([, h]) => h === "ok")) : health } as ModelHealthStore;
      },
    },
  ),
);
