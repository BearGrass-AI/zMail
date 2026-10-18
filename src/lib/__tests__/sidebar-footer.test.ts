// @vitest-environment jsdom
// The bottom of the sidebar: one status line that puts an account that couldn't sync first, then an
// update, then a sync under way, then when mail was last synced, and opens wherever it's fixed.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));

import { SidebarFooter } from "@/components/sidebar-footer";
import { useMail } from "@/lib/store";
import { useSettingsOpen } from "@/lib/settings-open";
import { useUpdates } from "@/lib/updates";
import type { Account } from "@/lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const gmail = { id: "g", kind: "gmail", name: "Gmail", address: "a@example.com", label: "Gmail" } as Account;
const outlook = { id: "o", kind: "m365", name: "Outlook", address: "a@example.org", label: "Outlook" } as Account;
const min = 60_000;

let root: Root;
const onSettings = vi.fn();
const text = () => document.body.textContent ?? "";
const button = (match: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(match));
const set = (accountStatus: Record<string, { state: "syncing" | "ok" | "error"; error?: string; at?: number }>) => act(() => useMail.setState({ accountStatus }));

beforeEach(() => {
  onSettings.mockReset();
  useMail.setState({ accounts: [gmail, outlook], accountStatus: { g: { state: "ok", at: Date.now() - 2 * min }, o: { state: "ok", at: Date.now() - 5 * min } } });
  useUpdates.setState({ status: { kind: "none" } });
  useSettingsOpen.setState({ open: false, section: null });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(createElement(SidebarFooter, { onSettings })));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("sidebar footer", () => {
  it("says when every account was last synced, going by the one synced longest ago", () => {
    expect(text()).toContain("Synced 5 min ago");
  });

  it("refreshes when the synced line is clicked", () => {
    const refresh = vi.fn(async () => {});
    act(() => useMail.setState({ refresh }));
    act(() => button("Synced")!.click());
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("names the account that's syncing", () => {
    set({ g: { state: "ok", at: Date.now() }, o: { state: "syncing" } });
    expect(text()).toContain("Syncing Outlook…");
  });

  it("shows an update over a sync, and opens About", () => {
    set({ g: { state: "syncing" }, o: { state: "ok", at: Date.now() } });
    act(() => useUpdates.setState({ status: { kind: "available", version: "0.1.2", notes: "", date: null } }));
    expect(text()).toContain("Update to 0.1.2 available");
    expect(document.querySelector('[aria-label="Settings (update available)"]')).not.toBeNull();
    act(() => button("Update to 0.1.2")!.click());
    expect(useSettingsOpen.getState()).toMatchObject({ open: true, section: "about" });
  });

  it("puts an account that couldn't sync first, and opens Accounts", () => {
    act(() => useUpdates.setState({ status: { kind: "available", version: "0.1.2", notes: "", date: null } }));
    set({ g: { state: "error", error: "401 Unauthorized", at: Date.now() }, o: { state: "syncing" } });
    const line = button("couldn't sync")!;
    expect(line.textContent).toBe("Gmail couldn't sync");
    expect(line.title).toBe("401 Unauthorized");
    act(() => line.click());
    expect(useSettingsOpen.getState()).toMatchObject({ open: true, section: "accounts" });
  });

  it("opens Keyboard Shortcuts and Settings", () => {
    act(() => (document.querySelector('[aria-label="Keyboard shortcuts"]') as HTMLButtonElement).click());
    expect(useSettingsOpen.getState()).toMatchObject({ open: true, section: "shortcuts" });
    act(() => (document.querySelector('[aria-label="Settings"]') as HTMLButtonElement).click());
    expect(onSettings).toHaveBeenCalledOnce();
  });
});

describe("sidebar footer, folded", () => {
  const fold = () => act(() => root.render(createElement(SidebarFooter, { onSettings, collapsed: true })));

  it("keeps the account badges and Settings, without the synced line", () => {
    fold();
    expect(text()).not.toContain("Synced");
    expect(document.querySelectorAll('[title^="Gmail"], [title^="Outlook"]')).toHaveLength(2);
    act(() => (document.querySelector('[aria-label="Settings"]') as HTMLButtonElement).click());
    expect(onSettings).toHaveBeenCalledOnce();
  });

  it("keeps an account that couldn't sync as an icon that opens Accounts", () => {
    set({ g: { state: "error", error: "401 Unauthorized", at: Date.now() }, o: { state: "ok", at: Date.now() } });
    fold();
    act(() => (document.querySelector(`[aria-label="Gmail couldn't sync"]`) as HTMLButtonElement).click());
    expect(useSettingsOpen.getState()).toMatchObject({ open: true, section: "accounts" });
  });
});
