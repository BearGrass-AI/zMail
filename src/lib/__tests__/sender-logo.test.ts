// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ on: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => tauri.on, invoke: tauri.invoke }));

import { MAX_ENTRIES, logoDomain, resetSenderLogoQueue, useSenderLogos } from "@/lib/sender-logo";

describe("logoDomain", () => {
  const own = ["example.org"];
  it("returns a brand domain, normalized", () => {
    expect(logoDomain("billing@stripe.com", own)).toBe("stripe.com");
    expect(logoDomain("Bob@STRIPE.Com", own)).toBe("stripe.com");
  });
  // A lookup reaches the sender's own DNS and web servers, so a sender must not be able to aim one.
  it("looks a well-known company up by its listed domain, never the subdomain the sender wrote", () => {
    expect(logoDomain("news@r-a1b2c3.email.amazon.com", own)).toBe("amazon.com");
    expect(logoDomain("x@amazon.com.tracker.example", own)).toBeNull();
    expect(logoDomain("x@notamazon.com", own)).toBeNull();
  });
  it("gives any other sender no lookup unless you always load their images", () => {
    expect(logoDomain("news@r-a1b2c3.tracker.example", own)).toBeNull();
    expect(logoDomain("billing@shop.example", own)).toBeNull();
    const allowed = new Set(["billing@shop.example"]);
    expect(logoDomain("Billing@Shop.example", own, allowed)).toBe("shop.example");
    expect(logoDomain("other@shop.example", own, allowed)).toBeNull();
  });
  it("skips personal email services", () => {
    expect(logoDomain("friend@gmail.com", own)).toBeNull();
    expect(logoDomain("friend@iCloud.com", own)).toBeNull();
  });
  it("skips the user's own organization, its subdomains and its parents", () => {
    expect(logoDomain("boss@example.org", own)).toBeNull();
    expect(logoDomain("x@cs.example.org", own)).toBeNull();
    expect(logoDomain("x@example.org", ["cs.example.org"])).toBeNull();
    expect(logoDomain("x@cs.example.org", ["cs.example.org"])).toBeNull();
  });
  it("skips IP literals, dotless hosts and addresses without @", () => {
    expect(logoDomain("bob@[10.0.0.1]", own)).toBeNull();
    expect(logoDomain("bob@10.0.0.1", own)).toBeNull();
    expect(logoDomain("bob@localhost", own)).toBeNull();
    expect(logoDomain("nobody", own)).toBeNull();
    expect(logoDomain("bob@", own)).toBeNull();
  });
});

describe("useSenderLogos.request", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.on = false;
    resetSenderLogoQueue();
    useSenderLogos.setState({ logos: {} });
  });

  it("does nothing outside Tauri", () => {
    useSenderLogos.getState().request("ramp.com");
    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(useSenderLogos.getState().logos).toEqual({});
  });

  it("runs at most 4 lookups at once, stores all, and does not repeat", async () => {
    tauri.on = true;
    let active = 0;
    let peak = 0;
    tauri.invoke.mockImplementation(async (_cmd: string, args: { domain: string }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return `data:${args.domain}`;
    });
    const domains = ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"];
    for (const d of domains) useSenderLogos.getState().request(d);
    expect(tauri.invoke).toHaveBeenCalledTimes(4);
    await vi.waitFor(() => expect(Object.keys(useSenderLogos.getState().logos)).toHaveLength(6));
    expect(peak).toBeLessThanOrEqual(4);
    expect(useSenderLogos.getState().logos["f.com"]).toBe("data:f.com");
    useSenderLogos.getState().request("a.com");
    expect(tauri.invoke).toHaveBeenCalledTimes(6);
  });

  it("stores null when the lookup fails", async () => {
    tauri.on = true;
    tauri.invoke.mockRejectedValue(new Error("boom"));
    useSenderLogos.getState().request("bad.com");
    await vi.waitFor(() => expect("bad.com" in useSenderLogos.getState().logos).toBe(true));
    expect(useSenderLogos.getState().logos["bad.com"]).toBeNull();
  });

  it("applies results in one batched update and keeps at most MAX_ENTRIES", async () => {
    tauri.on = true;
    tauri.invoke.mockImplementation(async (_cmd: string, args: { domain: string }) => `data:${args.domain}`);
    let updates = 0;
    const unsub = useSenderLogos.subscribe(() => updates++);
    for (let i = 0; i < 10; i++) useSenderLogos.getState().request(`s${i}.com`);
    await vi.waitFor(() => expect(Object.keys(useSenderLogos.getState().logos)).toHaveLength(10));
    expect(updates).toBe(1);
    for (let i = 0; i < 600; i++) useSenderLogos.getState().request(`t${i}.com`);
    await vi.waitFor(() => expect("t599.com" in useSenderLogos.getState().logos).toBe(true), { timeout: 5000 });
    unsub();
    const logos = useSenderLogos.getState().logos;
    expect(Object.keys(logos).length).toBeLessThanOrEqual(MAX_ENTRIES);
    expect("s0.com" in logos).toBe(false);
  });
});
