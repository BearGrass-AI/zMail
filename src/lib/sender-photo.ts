// People's photos for sender avatars: Google contacts and the Microsoft directory, cached on this Mac.

import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { accessToken } from "@/lib/oauth";
import { request } from "@/lib/transport";
import { kvGet, kvSet } from "@/lib/db";
import { useSettings } from "@/lib/settings";
import { useMail } from "@/lib/store";
import { useSenderLogo } from "@/lib/sender-logo";
import { macContactPhoto } from "@/lib/mac-contacts";
import type { Account } from "@/lib/types";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const INDEX_TTL = DAY;
const FOUND_TTL = 14 * DAY;
const MISSING_TTL = 3 * DAY;
const MAX_PAGES = 10;
/** Results are applied in one store update per flush, and the map keeps only the newest MAX_ENTRIES (evicted ones re-resolve from the kv cache). */
export const MAX_ENTRIES = 500;
const FLUSH_MS = 100;
const pendingResults = new Map<string, string | null>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const MAX_IN_FLIGHT = 4;

// ---- Google contacts ----

export interface GPhotoPerson {
  emailAddresses?: { value?: string }[];
  photos?: { url?: string; default?: boolean }[];
}

/** [lowercased address, photo url] for each person who has a real (non-placeholder) photo. */
export function indexFromPeople(people: GPhotoPerson[]): [string, string][] {
  const out: [string, string][] = [];
  for (const p of people) {
    const url = p.photos?.find((ph) => ph.url && ph.default !== true)?.url;
    if (!url) continue;
    for (const e of p.emailAddresses ?? []) {
      const a = e.value?.trim().toLowerCase();
      if (a) out.push([a, url]);
    }
  }
  return out;
}

interface PeoplePage {
  connections?: GPhotoPerson[];
  otherContacts?: GPhotoPerson[];
  nextPageToken?: string;
}

async function pagedPeople(accountId: string, path: string, params: Record<string, string>, key: "connections" | "otherContacts") {
  const token = await accessToken(accountId);
  const all: GPhotoPerson[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = new URLSearchParams({ ...params, pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
    const page = await request<PeoplePage>("GET", `https://people.googleapis.com/v1/${path}?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    all.push(...(page[key] ?? []));
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  return all;
}

const indexes = new Map<string, Promise<Map<string, string>>>();
const failedIndexes = new Set<string>();

async function buildIndex(accountId: string): Promise<Map<string, string>> {
  const cacheKey = `google_photo_index:${accountId}`;
  try {
    const cached = await kvGet<{ at: number; entries: [string, string][] }>(cacheKey);
    if (cached && Date.now() - cached.at < INDEX_TTL) return new Map(cached.entries);
  } catch {
    // fall through to a fresh build
  }
  try {
    const mine = await pagedPeople(accountId, "people/me/connections", { personFields: "emailAddresses,photos" }, "connections");
    const other = await pagedPeople(accountId, "otherContacts", { readMask: "emailAddresses,photos" }, "otherContacts");
    // "My contacts" first, so their photo wins over an "other contacts" one.
    const map = new Map<string, string>();
    for (const [a, u] of [...indexFromPeople(mine), ...indexFromPeople(other)]) if (!map.has(a)) map.set(a, u);
    try {
      await kvSet(cacheKey, { at: Date.now(), entries: [...map] });
    } catch {
      // cache is best-effort
    }
    return map;
  } catch {
    failedIndexes.add(accountId);
    return new Map();
  }
}

export function googlePhotoIndex(accountId: string): Promise<Map<string, string>> {
  let p = indexes.get(accountId);
  if (!p) {
    p = buildIndex(accountId);
    indexes.set(accountId, p);
  }
  return p;
}

// ---- Microsoft directory ----

const forbiddenAccounts = new Set<string>();

export async function directoryPhoto(account: Account, address: string): Promise<string | null> {
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(address)}/photos/96x96/$value`;
  try {
    return (await invoke<string | null>("fetch_photo", { url, bearer: await accessToken(account.id) })) ?? null;
  } catch (e) {
    if (String(e) === "forbidden" || (e instanceof Error && e.message === "forbidden")) forbiddenAccounts.add(account.id);
    throw e;
  }
}

function domainOf(address: string) {
  return address.slice(address.lastIndexOf("@") + 1).trim().toLowerCase();
}

function inOwnDomain(address: string, account: Account) {
  const d = domainOf(address);
  const own = domainOf(account.address);
  return !!own && (d === own || d.endsWith(`.${own}`));
}

// ---- Lookup ----

/** Other sources of person photos (for example the Mac Contacts app), tried before the built-in ones. */
export const extraPhotoSources: ((address: string) => Promise<string | null>)[] = [macContactPhoto];

/** `clean` is false when something failed along the way, so the result should not be cached. */
async function lookup(address: string, accounts: Account[]): Promise<{ photo: string | null; clean: boolean }> {
  let clean = true;
  for (const source of extraPhotoSources) {
    try {
      const p = await source(address);
      if (p) return { photo: p, clean };
    } catch {
      clean = false;
    }
  }
  for (const acct of accounts.filter((a) => a.kind === "gmail")) {
    const index = await googlePhotoIndex(acct.id);
    if (failedIndexes.has(acct.id)) clean = false;
    const url = index.get(address);
    if (!url) continue;
    try {
      const p = await invoke<string | null>("fetch_photo", { url, bearer: null });
      if (p) return { photo: p, clean };
    } catch {
      clean = false;
    }
  }
  for (const acct of accounts.filter((a) => a.kind === "m365" && inOwnDomain(address, a))) {
    if (forbiddenAccounts.has(acct.id)) {
      clean = false;
      continue;
    }
    try {
      const p = await directoryPhoto(acct, address);
      if (p) return { photo: p, clean };
    } catch {
      clean = false;
    }
  }
  return { photo: null, clean };
}

export async function lookupPhoto(address: string, accounts: Account[]): Promise<string | null> {
  return (await lookup(address.toLowerCase(), accounts)).photo;
}

// ---- Store ----

const inFlight = new Set<string>();
const queue: string[] = [];
let running = 0;

interface PhotoState {
  photos: Record<string, string | null>;
  request: (address: string) => void;
}

async function resolve(address: string): Promise<string | null> {
  const key = `person_photo:${address}`;
  // Entries remember whether Mac Contacts was on when they were looked up; a change makes them stale.
  const contacts = useSettings.getState().macContactsPhotos;
  try {
    const hit = await kvGet<{ photo: string | null; at: number; contacts?: boolean }>(key);
    if (hit && (hit.contacts ?? false) === contacts && Date.now() - hit.at < (hit.photo ? FOUND_TTL : MISSING_TTL)) {
      return hit.photo;
    }
  } catch {
    // look it up instead
  }
  const { photo, clean } = await lookup(address, useMail.getState().accounts);
  if (clean) {
    try {
      await kvSet(key, { photo, at: Date.now(), contacts });
    } catch {
      // cache is best-effort
    }
  }
  return photo;
}

export const usePersonPhotos = create<PhotoState>()((set, get) => {
  const flush = () => {
    flushTimer = null;
    const batch = [...pendingResults];
    pendingResults.clear();
    set((s) => {
      const next = { ...s.photos };
      // Re-inserting moves a key to the newest end, so the oldest entries are dropped first.
      for (const [k, v] of batch) {
        delete next[k];
        next[k] = v;
      }
      const keys = Object.keys(next);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete next[k];
      return { photos: next };
    });
  };
  const pump = () => {
    while (running < MAX_IN_FLIGHT && queue.length) {
      const address = queue.shift()!;
      running++;
      void resolve(address)
        .catch(() => null)
        .then((photo) => {
          pendingResults.set(address, photo);
          if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
        })
        .finally(() => {
          running--;
          inFlight.delete(address);
          pump();
        });
    }
  };
  return {
    photos: {},
    request: (raw) => {
      if (!isTauri()) return;
      const address = raw.toLowerCase();
      if (address in get().photos || inFlight.has(address) || pendingResults.has(address)) return;
      inFlight.add(address);
      queue.push(address);
      pump();
    },
  };
});

// Turning Mac Contacts photos on or off: forget this session's results so visible avatars look again.
useSettings.subscribe((s, prev) => {
  if (s.macContactsPhotos !== prev.macContactsPhotos) usePersonPhotos.setState({ photos: {} });
});

/** Test hook: forget queued/in-flight bookkeeping and per-launch memory. */
export function resetPersonPhotoQueue() {
  inFlight.clear();
  queue.length = 0;
  running = 0;
  pendingResults.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  indexes.clear();
  failedIndexes.clear();
  forbiddenAccounts.clear();
}

// ---- Hook ----

export function useSenderPicture(address: string, opts: { junk: boolean }): { src: string; kind: "photo" | "logo" } | null {
  const enabled = useSettings((s) => s.peoplePhotos);
  const accounts = useMail((s) => s.accounts);
  const key = address.toLowerCase();
  const own = useMemo(() => accounts.some((a) => a.address.toLowerCase() === key), [accounts, key]);
  const want = enabled && !opts.junk && !own;
  const requestPhoto = usePersonPhotos((s) => s.request);
  useEffect(() => {
    if (want) requestPhoto(key);
  }, [want, key, requestPhoto]);
  const photo = usePersonPhotos((s) => (want ? (s.photos[key] ?? null) : null));
  const logo = useSenderLogo(address, { junk: opts.junk });
  if (opts.junk) return null;
  if (photo) return { src: photo, kind: "photo" };
  if (logo) return { src: logo, kind: "logo" };
  return null;
}
