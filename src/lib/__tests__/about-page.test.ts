// @vitest-environment jsdom
// Settings → About: a quiet status row until an update is out, then a card that installs it and
// relaunches, unless relaunching would lose a draft that hasn't been saved.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {} }));
vi.mock("@/lib/oauth", () => ({ accessToken: async () => "tok", signOut: async () => {} }));
vi.mock("@/lib/accounts", () => ({ loadRegistry: async () => [], saveRegistry: async () => {}, mailProviderFor: () => ({}), calendarProviderFor: () => ({}) }));
const h = vi.hoisted(() => ({ install: vi.fn(), relaunch: vi.fn(), check: vi.fn() }));
vi.mock("@/lib/updates", async (original) => ({
  ...(await original<typeof import("@/lib/updates")>()),
  installUpdate: h.install,
  relaunch: h.relaunch,
  checkForUpdate: h.check,
}));

import { AboutPage } from "@/components/settings/about-page";
import { useUpdates, type UpdateStatus } from "@/lib/updates";
import { useMail } from "@/lib/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
const text = () => document.body.textContent ?? "";
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const show = (status: UpdateStatus) => act(() => useUpdates.setState({ status }));

beforeEach(() => {
  h.install.mockReset().mockResolvedValue({ ok: true, version: "0.2.0" });
  h.relaunch.mockReset().mockResolvedValue(undefined);
  h.check.mockReset().mockResolvedValue({ kind: "none" });
  useUpdates.setState({ status: { kind: "none" }, lastChecked: Date.now() - 4 * 60_000, autoCheckUpdates: true });
  useMail.setState({ compose: null, composeDirty: false });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(createElement(AboutPage)));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("About zMail", () => {
  it("says it's up to date, when it last checked, and checks again on request", () => {
    expect(text()).toContain("zMail is up to date");
    expect(text()).toContain("Checked 4 minutes ago");
    act(() => button("Check now")!.click());
    expect(h.check).toHaveBeenCalledOnce();
  });

  it("shows an available update as a card with the first notes, without list markers or headings", () => {
    show({ kind: "available", version: "0.2.0", notes: "## What's new\n- Shift-click selects a run\n* Search by meaning\n• Fixes\n- A fourth line", date: null });
    expect(text()).toContain("zMail 0.2.0 is available");
    const items = [...document.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual(["Shift-click selects a run", "Search by meaning", "Fixes"]);
  });

  it("puts the card off with Later but keeps the update one click away", () => {
    show({ kind: "available", version: "0.2.0", notes: "", date: null });
    act(() => button("Later")!.click());
    expect(button("Install and relaunch")).toBeUndefined();
    expect(button("Install")).toBeDefined();
  });

  it("installs and relaunches", async () => {
    show({ kind: "available", version: "0.2.0", notes: "", date: null });
    await act(async () => button("Install and relaunch")!.click());
    expect(h.install).toHaveBeenCalledOnce();
    expect(h.relaunch).toHaveBeenCalledOnce();
  });

  it("doesn't relaunch over a draft that hasn't been saved", async () => {
    useMail.setState({ compose: { mode: "blank" } as never, composeDirty: true });
    show({ kind: "available", version: "0.2.0", notes: "", date: null });
    await act(async () => button("Install and relaunch")!.click());
    expect(h.relaunch).not.toHaveBeenCalled();
    show({ kind: "installed", version: "0.2.0" });
    expect(text()).toContain("Save or close the message you're writing");
    expect(button("Relaunch")!.disabled).toBe(true);
  });

  it("explains that development builds don't update", () => {
    show({ kind: "unsupported", message: "Updates work in release builds." });
    expect(text()).toContain("Updates are off in development builds");
    expect(button("Check now")).toBeUndefined();
  });

  it("offers to try again after a failed check", () => {
    show({ kind: "error", message: "GitHub didn't respond." });
    expect(text()).toContain("Couldn't check for updates");
    expect(text()).toContain("GitHub didn't respond.");
    act(() => button("Try again")!.click());
    expect(h.check).toHaveBeenCalledOnce();
  });
});
