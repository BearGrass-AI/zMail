// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

const h = vi.hoisted(() => ({ on: true, check: vi.fn(), relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => h.on }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: h.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: h.relaunch }));

type Updates = typeof import("@/lib/updates");
let u: Updates;

interface FakeUpdate {
  version: unknown;
  body?: unknown;
  date?: unknown;
  downloadAndInstall: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeUpdate(fields: Partial<Pick<FakeUpdate, "version" | "body" | "date">> = {}): FakeUpdate {
  return {
    version: "0.2.0",
    body: "  Faster search.  ",
    date: "2026-10-01T12:00:00Z",
    ...fields,
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const status = () => u.useUpdates.getState().status;

beforeEach(async () => {
  h.on = true;
  h.check.mockReset();
  h.relaunch.mockReset();
  h.relaunch.mockResolvedValue(undefined);
  vi.stubEnv("DEV", false);
  localStorage.clear();
  // The module holds the pending update and in-flight work, so each test gets a fresh copy.
  vi.resetModules();
  u = await import("@/lib/updates");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("where updates run", () => {
  it("skips the browser preview with a clear state", async () => {
    h.on = false;
    expect(await u.checkForUpdate()).toEqual({ kind: "error", message: "Updates work in release builds." });
    expect(status()).toEqual({ kind: "unsupported", message: "Updates work in release builds." });
    expect(h.check).not.toHaveBeenCalled();
    expect(await u.installUpdate()).toEqual({ ok: false, message: "Updates work in release builds." });
  });

  it("skips dev builds", async () => {
    vi.stubEnv("DEV", true);
    expect(u.updatesSupported()).toBe(false);
    expect((await u.checkForUpdate()).kind).toBe("error");
    expect(h.check).not.toHaveBeenCalled();
  });
});

describe("checkForUpdate", () => {
  it("reports no update and records the check", async () => {
    h.check.mockResolvedValue(null);
    expect(await u.checkForUpdate()).toEqual({ kind: "none" });
    expect(status()).toEqual({ kind: "none" });
    expect(u.useUpdates.getState().lastChecked).toBeGreaterThan(0);
  });

  it("reports an update with tidy notes and an ISO date", async () => {
    h.check.mockResolvedValue(fakeUpdate());
    const want = { kind: "available", version: "0.2.0", notes: "Faster search.", date: "2026-10-01T12:00:00.000Z" };
    expect(await u.checkForUpdate()).toEqual(want);
    expect(status()).toEqual(want);
  });

  it("copes with a missing or garbled date and notes", async () => {
    h.check.mockResolvedValue(fakeUpdate({ body: 42, date: "someday" }));
    expect(await u.checkForUpdate()).toMatchObject({ kind: "available", notes: "", date: null });
  });

  it("caps very long notes", async () => {
    h.check.mockResolvedValue(fakeUpdate({ body: "x".repeat(50_000) }));
    const got = await u.checkForUpdate();
    expect(got.kind === "available" && got.notes.length).toBe(20_000);
  });

  it("refuses a version it can't read and lets the update go", async () => {
    for (const version of ["", "latest", 3, "1.2", "9".repeat(70) + ".0.0", "1.0.0 <script>"]) {
      const bad = fakeUpdate({ version });
      h.check.mockResolvedValueOnce(bad);
      expect(await u.checkForUpdate()).toEqual({ kind: "error", message: "The update server sent something zMail couldn't read." });
      expect(bad.close).toHaveBeenCalled();
    }
    expect(u.useUpdates.getState().lastChecked).toBeNull();
    expect(await u.installUpdate()).toEqual({ ok: false, message: "Check for updates first." });
  });

  it("passes on the plugin's error without recording a check", async () => {
    h.check.mockRejectedValue("Could not fetch a valid release JSON from the remote");
    expect(await u.checkForUpdate()).toEqual({ kind: "error", message: "Could not fetch a valid release JSON from the remote" });
    expect(status().kind).toBe("error");
    expect(u.useUpdates.getState().lastChecked).toBeNull();
  });

  it("falls back to a plain message for an empty error", async () => {
    h.check.mockRejectedValue(new Error("   "));
    expect(await u.checkForUpdate()).toEqual({ kind: "error", message: "Couldn't reach the update server." });
  });

  it("shares one check between overlapping calls", async () => {
    let answer!: (v: null) => void;
    h.check.mockImplementation(() => new Promise((r) => (answer = r)));
    const a = u.checkForUpdate();
    const b = u.checkForUpdate();
    expect(status()).toEqual({ kind: "checking" });
    answer(null);
    expect(await a).toEqual(await b);
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it("lets go of the previous update when a new check replaces it", async () => {
    const old = fakeUpdate({ version: "0.2.0" });
    h.check.mockResolvedValueOnce(old).mockResolvedValueOnce(fakeUpdate({ version: "0.3.0" }));
    await u.checkForUpdate();
    await u.checkForUpdate();
    expect(old.close).toHaveBeenCalled();
    expect(status()).toMatchObject({ kind: "available", version: "0.3.0" });
  });
});

describe("installUpdate", () => {
  it("needs a check first", async () => {
    expect(await u.installUpdate()).toEqual({ ok: false, message: "Check for updates first." });
  });

  it("reports bytes as they arrive and succeeds only once installed", async () => {
    const update = fakeUpdate();
    let finish!: () => void;
    update.downloadAndInstall.mockImplementation((onEvent: (e: DownloadEvent) => void) => {
      onEvent({ event: "Started", data: { contentLength: 1000 } });
      onEvent({ event: "Progress", data: { chunkLength: 400 } });
      onEvent({ event: "Progress", data: { chunkLength: 600 } });
      onEvent({ event: "Finished" });
      return new Promise<void>((r) => (finish = r));
    });
    h.check.mockResolvedValue(update);
    await u.checkForUpdate();
    const seen: number[] = [];
    const done = u.installUpdate((p) => seen.push(p.downloaded));
    await vi.waitFor(() => expect(seen).toContain(1000));
    // Downloaded but still installing: not a success yet.
    expect(status()).toEqual({ kind: "installing", version: "0.2.0", downloaded: 1000, total: 1000 });
    finish();
    expect(await done).toEqual({ ok: true, version: "0.2.0" });
    expect(seen).toEqual([0, 0, 400, 1000, 1000]);
    expect(status()).toEqual({ kind: "installed", version: "0.2.0" });
  });

  it("ignores nonsense sizes from the plugin", async () => {
    const update = fakeUpdate();
    update.downloadAndInstall.mockImplementation((onEvent: (e: DownloadEvent) => void) => {
      onEvent({ event: "Started", data: { contentLength: -5 } });
      onEvent({ event: "Progress", data: { chunkLength: Number.NaN } });
      onEvent({ event: "Progress", data: { chunkLength: 10 } });
      return Promise.resolve();
    });
    h.check.mockResolvedValue(update);
    await u.checkForUpdate();
    const last: { downloaded: number; total: number | null }[] = [];
    await u.installUpdate((p) => last.push(p));
    expect(last.at(-1)).toEqual({ downloaded: 10, total: null });
  });

  it("reports a failed install as a failure", async () => {
    const update = fakeUpdate();
    update.downloadAndInstall.mockRejectedValue("signature verification failed");
    h.check.mockResolvedValue(update);
    await u.checkForUpdate();
    expect(await u.installUpdate()).toEqual({ ok: false, message: "signature verification failed" });
    expect(status()).toEqual({ kind: "error", message: "signature verification failed" });
    expect(update.close).toHaveBeenCalled();
    expect(await u.installUpdate()).toEqual({ ok: false, message: "Check for updates first." });
  });

  it("installs once when asked twice, and doesn't check mid-install", async () => {
    const update = fakeUpdate();
    let finish!: () => void;
    update.downloadAndInstall.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    h.check.mockResolvedValue(update);
    await u.checkForUpdate();
    const a = u.installUpdate();
    const b = u.installUpdate();
    expect((await u.checkForUpdate()).kind).toBe("error");
    expect(h.check).toHaveBeenCalledTimes(1);
    finish();
    expect(await a).toEqual(await b);
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(update.close).not.toHaveBeenCalled();
  });

  it("keeps going when the progress callback throws", async () => {
    h.check.mockResolvedValue(fakeUpdate());
    await u.checkForUpdate();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await u.installUpdate(() => {
        throw new Error("ui");
      }),
    ).toEqual({ ok: true, version: "0.2.0" });
    warn.mockRestore();
  });

  it("relaunches through the process plugin", async () => {
    await u.relaunch();
    expect(h.relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("startUpdateChecks", () => {
  it("checks shortly after launch and again after a day, never installing", async () => {
    vi.useFakeTimers();
    const update = fakeUpdate();
    h.check.mockResolvedValue(update);
    const stop = u.startUpdateChecks();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(h.check).toHaveBeenCalledTimes(1);
    // Looked at hourly, so the next check comes within the hour after a day has passed.
    await vi.advanceTimersByTimeAsync(13 * 60 * 60 * 1000);
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    stop();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it("stays quiet while the setting is off", async () => {
    vi.useFakeTimers();
    u.useUpdates.getState().setAutoCheck(false);
    const stop = u.startUpdateChecks();
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000);
    expect(h.check).not.toHaveBeenCalled();
    stop();
  });

  it("starts once", async () => {
    vi.useFakeTimers();
    h.check.mockResolvedValue(null);
    const stop = u.startUpdateChecks();
    u.startUpdateChecks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.check).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does nothing in the browser preview", async () => {
    vi.useFakeTimers();
    h.on = false;
    u.startUpdateChecks();
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60 * 1000);
    expect(h.check).not.toHaveBeenCalled();
    expect(status().kind).toBe("unsupported");
  });
});

describe("persisted settings", () => {
  it("saves only the setting and the last check", async () => {
    h.check.mockResolvedValue(null);
    u.useUpdates.getState().setAutoCheck(false);
    await u.checkForUpdate();
    const saved = JSON.parse(localStorage.getItem("zmail.updates") ?? "{}") as { state: Record<string, unknown> };
    expect(Object.keys(saved.state).sort()).toEqual(["autoCheckUpdates", "lastChecked"]);
    expect(saved.state.autoCheckUpdates).toBe(false);
  });

  it("drops garbled saved values", async () => {
    localStorage.setItem("zmail.updates", JSON.stringify({ state: { autoCheckUpdates: "no", lastChecked: 1e20, status: { kind: "installed" } }, version: 0 }));
    vi.resetModules();
    u = await import("@/lib/updates");
    const s = u.useUpdates.getState();
    expect(s.autoCheckUpdates).toBe(true);
    expect(s.lastChecked).toBeNull();
    expect(s.status).toEqual({ kind: "idle" });
  });

  it("keeps a sane last check", () => {
    const now = Date.UTC(2026, 9, 16);
    expect(u.sanitizeLastChecked(now - 5_000, now)).toBe(now - 5_000);
    for (const v of [null, "1700000000000", Number.NaN, Infinity, -1, 0, now + 2 * 86_400_000]) expect(u.sanitizeLastChecked(v, now)).toBeNull();
  });
});
