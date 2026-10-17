// Zoom meetings via a Server-to-Server OAuth app (account credentials grant).
// The client secret lives in the Keychain; tokens are cached in memory.

import { request } from "@/lib/transport";
import { kvGet, kvSet } from "@/lib/db";
import { getSecret, setSecret } from "@/lib/secrets";

export interface ZoomConfig {
  accountId: string;
  clientId: string;
  /** Zoom user (email) who will host meetings. */
  userEmail: string;
}

const KEY = "zoom.config";
const SECRET = "zoom.client_secret";
let cached: { token: string; expires: number } | null = null;

export async function loadZoom(): Promise<(ZoomConfig & { clientSecret: string }) | null> {
  const cfg = await kvGet<ZoomConfig>(KEY);
  if (!cfg) return null;
  return { ...cfg, clientSecret: (await getSecret(SECRET)) ?? "" };
}

export async function saveZoom(cfg: ZoomConfig & { clientSecret: string }) {
  const { clientSecret, ...rest } = cfg;
  await kvSet(KEY, rest);
  await setSecret(SECRET, clientSecret);
  cached = null;
}

export async function zoomConnected() {
  const z = await loadZoom();
  return !!(z?.accountId && z.clientId && z.clientSecret && z.userEmail);
}

async function token(): Promise<{ token: string; user: string }> {
  const z = await loadZoom();
  if (!z?.clientSecret) throw new Error("Connect Zoom in Settings → Video Meetings first.");
  if (cached && cached.expires > Date.now()) return { token: cached.token, user: z.userEmail };
  const res = await request<{ access_token: string; expires_in: number }>(
    "POST",
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(z.accountId)}`,
    { headers: { Authorization: `Basic ${btoa(`${z.clientId}:${z.clientSecret}`)}` } },
  );
  cached = { token: res.access_token, expires: Date.now() + (res.expires_in - 60) * 1000 };
  return { token: res.access_token, user: z.userEmail };
}

export interface ZoomMeeting {
  id: number;
  join_url: string;
  password?: string;
}

/** Minutes between two ISO times (at least 15). */
export const durationMinutes = (start: string, end: string) => Math.max(15, Math.round((Date.parse(end) - Date.parse(start)) / 60000));

export async function createZoomMeeting(input: { topic: string; start: string; end: string; agenda?: string }): Promise<ZoomMeeting> {
  const { token: t, user } = await token();
  return request<ZoomMeeting>("POST", `https://api.zoom.us/v2/users/${encodeURIComponent(user)}/meetings`, {
    headers: { Authorization: `Bearer ${t}` },
    body: {
      topic: input.topic,
      type: 2, // scheduled
      start_time: new Date(input.start).toISOString().replace(/\.\d{3}Z$/, "Z"),
      duration: durationMinutes(input.start, input.end),
      timezone: "UTC",
      agenda: input.agenda,
      settings: { join_before_host: false, waiting_room: true },
    },
  });
}

export async function testZoom(): Promise<string> {
  const { token: t, user } = await token();
  const me = await request<{ email: string; first_name?: string; last_name?: string }>("GET", `https://api.zoom.us/v2/users/${encodeURIComponent(user)}`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  return `${me.first_name ?? ""} ${me.last_name ?? ""}`.trim() || me.email;
}
