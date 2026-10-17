// Whether the Settings dialog is open, and which section to open it on.

import { create } from "zustand";

interface SettingsOpenStore {
  open: boolean;
  section: string | null;
  show: (section?: string) => void;
  setOpen: (open: boolean) => void;
}

export const useSettingsOpen = create<SettingsOpenStore>((set) => ({
  open: false,
  section: null,
  show: (section) => set({ open: true, section: section ?? null }),
  setOpen: (open) => set(open ? { open } : { open, section: null }),
}));
