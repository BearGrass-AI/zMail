// Folding the sidebar to a rail of icons, and getting to the search box from either state.

import { useSettings } from "@/lib/settings";

export function toggleSidebar() {
  const s = useSettings.getState();
  s.set({ sidebarCollapsed: !s.sidebarCollapsed });
}

/** Focus the search box, opening the sidebar first when it's folded (the rail has no box). */
export function focusSearch() {
  const s = useSettings.getState();
  const box = () => document.getElementById("global-search")?.focus();
  if (!s.sidebarCollapsed) return box();
  s.set({ sidebarCollapsed: false });
  // The box mounts on the next render.
  requestAnimationFrame(box);
}
