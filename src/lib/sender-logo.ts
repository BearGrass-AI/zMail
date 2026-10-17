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

/**
 * Companies whose logo zMail looks up for anyone. A lookup reaches the company's own servers
 * (DNS, then https) from this Mac, so a sender that could choose it could learn your IP address
 * and when your inbox showed its mail, which blocking remote images exists to prevent.
 */
export const WELL_KNOWN: ReadonlySet<string> = new Set([
  // Software and services
  "apple.com", "google.com", "microsoft.com", "amazon.com", "github.com", "gitlab.com", "atlassian.com", "slack.com",
  "zoom.us", "dropbox.com", "box.com", "adobe.com", "salesforce.com", "docusign.com", "docusign.net", "notion.so",
  "figma.com", "canva.com", "asana.com", "trello.com", "monday.com", "airtable.com", "hubspot.com", "mailchimp.com",
  "intuit.com", "squarespace.com", "wix.com", "shopify.com", "stripe.com", "cloudflare.com", "digitalocean.com",
  "heroku.com", "vercel.com", "openai.com", "anthropic.com", "linear.app", "okta.com", "1password.com", "grammarly.com",
  "calendly.com", "zendesk.com", "twilio.com", "discord.com", "spotify.com", "netflix.com", "hulu.com", "disneyplus.com",
  "youtube.com", "twitch.tv", "steampowered.com", "epicgames.com", "playstation.com", "xbox.com", "nintendo.com",
  // Social
  "facebook.com", "facebookmail.com", "instagram.com", "meta.com", "whatsapp.com", "linkedin.com", "x.com", "twitter.com",
  "pinterest.com", "reddit.com", "redditmail.com", "tiktok.com", "snapchat.com", "nextdoor.com", "medium.com", "substack.com",
  "quora.com",
  // Shopping and delivery
  "ebay.com", "etsy.com", "walmart.com", "target.com", "bestbuy.com", "costco.com", "homedepot.com", "lowes.com", "ikea.com",
  "wayfair.com", "chewy.com", "nike.com", "samsung.com", "dell.com", "hp.com", "lenovo.com", "newegg.com", "zappos.com",
  "macys.com", "nordstrom.com", "kohls.com", "gap.com", "uniqlo.com", "sephora.com", "ulta.com", "instacart.com",
  "doordash.com", "ubereats.com", "grubhub.com", "uber.com", "lyft.com",
  // Money
  "paypal.com", "venmo.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "capitalone.com",
  "americanexpress.com", "discover.com", "usbank.com", "schwab.com", "fidelity.com", "vanguard.com", "robinhood.com",
  "coinbase.com", "wise.com", "squareup.com", "cash.app", "ally.com", "sofi.com", "experian.com", "equifax.com",
  "transunion.com", "creditkarma.com", "mastercard.com", "visa.com", "affirm.com", "klarna.com",
  // Travel and shipping
  "airbnb.com", "booking.com", "expedia.com", "hotels.com", "vrbo.com", "tripadvisor.com", "kayak.com", "delta.com",
  "united.com", "aa.com", "southwest.com", "jetblue.com", "marriott.com", "hilton.com", "hyatt.com", "ihg.com", "hertz.com",
  "enterprise.com", "avis.com", "ups.com", "fedex.com", "dhl.com",
  // Phone, internet and everything else
  "verizon.com", "att.com", "t-mobile.com", "comcast.net", "xfinity.com", "nytimes.com", "wsj.com", "washingtonpost.com",
  "bloomberg.com", "economist.com", "theguardian.com", "yelp.com", "opentable.com", "ticketmaster.com", "eventbrite.com",
  "stubhub.com", "duolingo.com", "coursera.org", "udemy.com", "patreon.com", "kickstarter.com", "gofundme.com",
  "wikipedia.org", "mozilla.org",
]);

/** The listed company `d` belongs to (itself or a parent domain), if any. */
function wellKnown(d: string): string | null {
  const labels = d.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const cand = labels.slice(i).join(".");
    if (WELL_KNOWN.has(cand)) return cand;
  }
  return null;
}

/**
 * The domain to look a logo up for, or null when this sender should never get one. Well-known
 * companies get one by their listed domain, never the subdomain the sender wrote (which could
 * tag the lookup to one message or recipient). Anyone else only once you've chosen to always
 * load their images (`imageSenders`), which already lets them see you.
 */
export function logoDomain(address: string, ownDomains: string[], imageSenders: ReadonlySet<string> = new Set()): string | null {
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
  return wellKnown(d) ?? (imageSenders.has(address.trim().toLowerCase()) ? d : null);
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
  const imageSenders = useMail((s) => s.imageSenders);
  const ownKey = useMemo(
    () => accounts.map((a) => a.address.slice(a.address.lastIndexOf("@") + 1)).join("\n"),
    [accounts],
  );
  const domain = useMemo(
    () => (enabled && !opts.junk ? logoDomain(address, ownKey ? ownKey.split("\n") : [], imageSenders) : null),
    [enabled, opts.junk, address, ownKey, imageSenders],
  );
  const request = useSenderLogos((s) => s.request);
  useEffect(() => {
    if (domain) request(domain);
  }, [domain, request]);
  return useSenderLogos((s) => (domain ? (s.logos[domain] ?? null) : null));
}
