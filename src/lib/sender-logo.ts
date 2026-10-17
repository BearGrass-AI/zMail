// Company logos for sender avatars: which domain to look up, and a small store of results.

import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useSettings } from "@/lib/settings";
import { useMail } from "@/lib/store";

export const FREEMAIL: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com",
  "me.com", "mac.com", "yahoo.com", "ymail.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.net", "mail.com", "fastmail.com", "zoho.com", "hey.com",
]);

/** The domain to look a logo up for, or null when this sender should never get one. */
export function logoDomain(address: string, ownDomains: string[]): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const d = address.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  if (!d || d.startsWith("[") || !d.includes(".") || /^[\d.]+$/.test(d) || d.includes(":")) return null;
  if (FREEMAIL.has(d)) return null;
  for (const raw of ownDomains) {
    const own = raw.trim().toLowerCase();
    if (!own) continue;
    if (d === own || d.endsWith(`.${own}`) || own.endsWith(`.${d}`)) return null;
  }
  return d;
}

/** Results are applied in one store update per flush, and the map keeps only the newest MAX_ENTRIES (evicted ones re-resolve from the kv cache). */
export const MAX_ENTRIES = 500;
const FLUSH_MS = 100;
const pendingResults = new Map<string, string | null>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const MAX_IN_FLIGHT = 4;
const inFlight = new Set<string>();
const queue: string[] = [];
let running = 0;

interface LogoState {
  logos: Record<string, string | null>;
  request: (domain: string) => void;
}

export const useSenderLogos = create<LogoState>()((set, get) => {
  const flush = () => {
    flushTimer = null;
    const batch = [...pendingResults];
    pendingResults.clear();
    set((s) => {
      const next = { ...s.logos };
      // Re-inserting moves a key to the newest end, so the oldest entries are dropped first.
      for (const [k, v] of batch) {
        delete next[k];
        next[k] = v;
      }
      const keys = Object.keys(next);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete next[k];
      return { logos: next };
    });
  };
  const pump = () => {
    while (running < MAX_IN_FLIGHT && queue.length) {
      const domain = queue.shift()!;
      running++;
      void invoke<string | null>("sender_logo", { domain })
        .catch(() => null)
        .then((logo) => {
          pendingResults.set(domain, logo ?? null);
          if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
        })
        .finally(() => {
          running--;
          inFlight.delete(domain);
          pump();
        });
    }
  };
  return {
    logos: {},
    request: (domain) => {
      if (!isTauri()) return;
      if (domain in get().logos || inFlight.has(domain) || pendingResults.has(domain)) return;
      inFlight.add(domain);
      queue.push(domain);
      pump();
    },
  };
});

/** Test hook: forget queued/in-flight bookkeeping. */
export function resetSenderLogoQueue() {
  inFlight.clear();
  queue.length = 0;
  running = 0;
  pendingResults.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

export function useSenderLogo(address: string, opts: { junk: boolean }): string | null {
  const enabled = useSettings((s) => s.senderLogos);
  const accounts = useMail((s) => s.accounts);
  const ownKey = useMemo(
    () => accounts.map((a) => a.address.slice(a.address.lastIndexOf("@") + 1)).join("\n"),
    [accounts],
  );
  const domain = useMemo(
    () => (enabled && !opts.junk ? logoDomain(address, ownKey ? ownKey.split("\n") : []) : null),
    [enabled, opts.junk, address, ownKey],
  );
  const request = useSenderLogos((s) => s.request);
  useEffect(() => {
    if (domain) request(domain);
  }, [domain, request]);
  return useSenderLogos((s) => (domain ? (s.logos[domain] ?? null) : null));
}
