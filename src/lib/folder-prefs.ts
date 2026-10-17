// Per-user folder UI state: favorites, expanded tree nodes, recent move targets.

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface FolderPrefs {
  favorites: string[];
  expanded: Record<string, boolean>;
  recent: string[];
  toggleFavorite: (id: string) => void;
  setExpanded: (id: string, open: boolean) => void;
  pushRecent: (id: string) => void;
}

export const useFolderPrefs = create<FolderPrefs>()(
  persist(
    (set) => ({
      favorites: ["work:depts", "work:campus-it"],
      expanded: { "acct:personal": true, "acct:work": true, "work:inbox": true, "work:depts": true },
      recent: [],
      toggleFavorite: (id) =>
        set((s) => ({ favorites: s.favorites.includes(id) ? s.favorites.filter((f) => f !== id) : [...s.favorites, id] })),
      setExpanded: (id, open) => set((s) => ({ expanded: { ...s.expanded, [id]: open } })),
      pushRecent: (id) => set((s) => ({ recent: [id, ...s.recent.filter((r) => r !== id)].slice(0, 8) })),
    }),
    { name: "zmail.folders", partialize: ({ favorites, expanded, recent }) => ({ favorites, expanded, recent }) },
  ),
);
