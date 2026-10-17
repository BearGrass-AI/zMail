import { describe, expect, it, vi } from "vitest";

const calls: { method: string; url: string; headers?: Record<string, string>; body?: unknown }[] = [];
vi.mock("@/lib/db", () => ({
  kvGet: async () => ({ accountId: "ACC", clientId: "CID", userEmail: "alex@example.org" }),
  kvSet: async () => undefined,
}));
vi.mock("@/lib/secrets", () => ({ getSecret: async () => "SECRET", setSecret: async () => undefined }));
vi.mock("@/lib/transport", () => ({
  request: async (method: string, url: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) => {
    calls.push({ method, url, ...opts });
    if (url.startsWith("https://zoom.us/oauth/token")) return { access_token: "ZT", expires_in: 3600 };
    return { id: 123, join_url: "https://zoom.us/j/123", password: "abc" };
  },
}));

const { createZoomMeeting, durationMinutes } = await import("@/lib/zoom/zoom");

describe("zoom", () => {
  it("gets an account-credentials token, then schedules for the host", async () => {
    const m = await createZoomMeeting({ topic: "Trustees prep", start: "2026-10-12T16:00:00.000Z", end: "2026-10-12T16:45:00.000Z" });
    expect(m.join_url).toBe("https://zoom.us/j/123");
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=ACC" });
    expect(calls[0].headers!.Authorization).toBe(`Basic ${btoa("CID:SECRET")}`);
    expect(calls[1]).toMatchObject({
      url: "https://api.zoom.us/v2/users/alex%40example.org/meetings",
      headers: { Authorization: "Bearer ZT" },
      body: { topic: "Trustees prep", type: 2, start_time: "2026-10-12T16:00:00Z", duration: 45, timezone: "UTC" },
    });
  });

  it("enforces a 15 minute minimum duration", () => {
    expect(durationMinutes("2026-10-12T16:00:00Z", "2026-10-12T16:05:00Z")).toBe(15);
  });
});
