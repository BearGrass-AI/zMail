// @vitest-environment jsdom
// ⌃⌘S folds the sidebar to icons and back, and remembers; ⌘K still reaches the search box when it's folded.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { focusSearch, toggleSidebar } from "@/lib/sidebar";
import { useSettings } from "@/lib/settings";

beforeEach(() => {
  useSettings.setState({ sidebarCollapsed: false });
  document.body.innerHTML = "";
});

describe("sidebar folding", () => {
  it("folds and unfolds", () => {
    toggleSidebar();
    expect(useSettings.getState().sidebarCollapsed).toBe(true);
    toggleSidebar();
    expect(useSettings.getState().sidebarCollapsed).toBe(false);
  });

  it("opens a folded sidebar to focus the search box", () => {
    useSettings.setState({ sidebarCollapsed: true });
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => (f(0), 0));
    const box = document.body.appendChild(Object.assign(document.createElement("input"), { id: "global-search" }));
    focusSearch();
    expect(useSettings.getState().sidebarCollapsed).toBe(false);
    expect(document.activeElement).toBe(box);
    vi.unstubAllGlobals();
  });
});
