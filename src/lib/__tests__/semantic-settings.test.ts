// @vitest-environment jsdom
// Settings → Search: the meaning-based search switch says what it costs, downloads with progress,
// cancel and resume, says "ready" only once Rust says the model is in place, shows indexing
// progress, and asks before deleting the model and its index.
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SemanticStatus } from "@/lib/semantic";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: SemanticStatus = { enabled: false, model: "missing", downloaded: 0, size: 309_855_456, error: null, indexed: 0, total: 37_311, indexing: false };
let status: SemanticStatus = base;
const sem = vi.hoisted(() => ({
  semanticStatus: vi.fn(),
  semanticEnable: vi.fn(),
  semanticCancelDownload: vi.fn(),
  semanticDisable: vi.fn(),
}));
vi.mock("@/lib/semantic", () => sem);

let root: Root | null = null;
let ui: typeof import("@/components/settings/ai/semantic-search");

async function show() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(createElement(ui.SemanticSearchGroup)));
}
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label);
const toggle = () => document.querySelector<HTMLElement>('[aria-label="Meaning-based search"]')!;
async function click(el: HTMLElement | undefined) {
  await act(async () => el!.click());
}
async function tick(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

beforeEach(async () => {
  vi.useFakeTimers();
  status = base;
  sem.semanticStatus.mockReset().mockImplementation(async () => status);
  sem.semanticEnable.mockReset().mockImplementation(async () => (status = { ...status, enabled: true, model: "downloading" }));
  sem.semanticCancelDownload.mockReset().mockImplementation(async () => (status = { ...status, model: "partial" }));
  sem.semanticDisable.mockReset().mockImplementation(async (del: boolean) => (status = { ...status, enabled: false, ...(del ? { model: "missing", downloaded: 0, indexed: 0 } : {}) }));
  ui = await import("@/components/settings/ai/semantic-search");
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("meaning-based search settings", () => {
  it("explains the cost, then downloads with progress and cancel", async () => {
    await show();
    expect(text()).toContain("Downloads a 310 MB model. Runs on this Mac; nothing leaves it.");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await click(toggle());
    expect(sem.semanticEnable).toHaveBeenCalledOnce();
    status = { ...status, downloaded: 120_000_000 };
    await tick(800);
    expect(text()).toContain("Downloading… 120 MB of 310 MB");
    expect(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("39");
    expect(text()).not.toContain("Ready");
    await click(button("Cancel"));
    expect(sem.semanticCancelDownload).toHaveBeenCalledOnce();
    expect(text()).toContain("Download paused at 120 MB of 310 MB");
    await click(button("Resume"));
    expect(sem.semanticEnable).toHaveBeenCalledTimes(2);
  });

  it("shows checking, then indexing progress, then ready, as Rust reports them", async () => {
    status = { ...base, enabled: true, model: "verifying", downloaded: base.size };
    await show();
    expect(text()).toContain("Checking the download…");
    expect(text()).not.toContain("Ready");
    status = { ...status, model: "ready", indexed: 12_400, indexing: true };
    await tick(800);
    expect(text()).toContain("Indexed 12,400 of 37,311");
    status = { ...status, indexed: 37_311, indexing: false };
    await tick(800);
    expect(text()).toContain("Ready. 37,311 emails indexed.");
  });

  it("shows a failed download and lets you try again", async () => {
    status = { ...base, enabled: true, model: "missing", error: "The download didn't match the model's checksum, so it was deleted." };
    await show();
    expect(text()).toContain("didn't match the model's checksum");
    await click(button("Try again"));
    expect(sem.semanticEnable).toHaveBeenCalledOnce();
  });

  it("asks before deleting the model and its index when turned off", async () => {
    status = { ...base, enabled: true, model: "ready", indexed: 37_311 };
    await show();
    await click(toggle());
    expect(sem.semanticDisable).not.toHaveBeenCalled();
    expect(text()).toContain("Delete the model and its index too?");
    await click(button("Delete"));
    expect(sem.semanticDisable).toHaveBeenCalledWith(true);
    expect(text()).not.toContain("Delete the model and its index too?");
    expect(toggle().getAttribute("aria-checked")).toBe("false");

    // Keeping them: off, nothing deleted.
    status = { ...base, enabled: true, model: "ready", indexed: 5 };
    await tick(5100);
    await click(toggle());
    await click(button("Keep them"));
    expect(sem.semanticDisable).toHaveBeenLastCalledWith(false);
  });

  it("with nothing downloaded, turning it off just turns it off", async () => {
    status = { ...base, enabled: true, model: "missing", error: "offline" };
    await show();
    await click(toggle());
    expect(sem.semanticDisable).toHaveBeenCalledWith(false);
    expect(text()).not.toContain("Delete the model");
  });
});
