// Small presentational helpers shared across views. Bucket/category labels and icons live in @/lib/meta.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import type { Contact } from "@/lib/types";
import type { Tinted } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useSenderPicture } from "@/lib/sender-photo";

/** Inline style that points the `.tint` utilities at a palette hue. */
export const tint = (key: Tinted): CSSProperties =>
  ({ "--h": `var(--h-${key})` }) as CSSProperties;

/** Same, for a raw hue number (folders, calendars, events). */
export const hue = (h: number): CSSProperties => ({ "--h": String(h) }) as CSSProperties;

/** Rounded icon tile: gradient ("solid") or tinted background ("soft"). */
export function Tile({
  icon: Icon,
  k,
  h,
  variant = "soft",
  size = 32,
  className,
}: {
  icon: LucideIcon;
  k?: Tinted;
  h?: number;
  variant?: "soft" | "solid";
  size?: number;
  className?: string;
}) {
  const style = { ...(k ? tint(k) : h !== undefined ? hue(h) : {}), width: size, height: size, borderRadius: size * 0.28 };
  return (
    <span
      style={style}
      className={cn(
        "tint grid shrink-0 place-items-center",
        variant === "solid" ? "tint-grad" : "tint-soft tint-text",
        className,
      )}
    >
      <Icon style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={variant === "solid" ? 2.3 : 2} />
    </span>
  );
}

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export function initials(name: string) {
  const parts = name.replace(/\(.*?\)/g, "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function SenderAvatar({
  contact,
  className,
  compact,
  junk = false,
}: {
  contact: Contact;
  className?: string;
  compact?: boolean;
  junk?: boolean;
}) {
  const pic = useSenderPicture(contact.address, { junk });
  const [failed, setFailed] = useState(false);
  // Fade only when a picture arrives after mount; rows that mount with one already (scrolling) show it at once.
  // Compares with the last src (not a first-run flag), so StrictMode's double effect run doesn't fade either.
  const lastSrc = useRef(pic?.src);
  const [loaded, setLoaded] = useState(!!pic?.src);
  useEffect(() => {
    if (lastSrc.current === pic?.src) return;
    lastSrc.current = pic?.src;
    setFailed(false);
    setLoaded(false);
  }, [pic?.src]);
  const fade = cn(
    "transition-opacity duration-150 ease-out",
    loaded ? "opacity-100" : "opacity-0",
  );
  if (pic && !failed) {
    if (pic.kind === "photo") {
      return (
        <div className={cn("size-8 shrink-0 overflow-hidden rounded-full ring-1 ring-black/10 ring-inset", className)} aria-hidden>
          <img src={pic.src} alt="" draggable={false} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} className={cn("size-full object-cover", fade)} />
        </div>
      );
    }
    return (
      <div
        className={cn("grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-white ring-1 ring-black/10 ring-inset", className)}
        aria-hidden
      >
        <img src={pic.src} alt="" draggable={false} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} className={cn("size-[72%] object-contain", fade)} />
      </div>
    );
  }
  const hue = hash(contact.address.split("@")[1] ?? contact.address) % 360;
  return (
    <div
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold tracking-wide text-white",
        className,
      )}
      style={{ background: `linear-gradient(140deg, oklch(0.7 0.14 ${hue}), oklch(0.55 0.16 ${(hue + 40) % 360}))` }}
      aria-hidden
    >
      {compact ? initials(contact.name)[0] : initials(contact.name)}
    </div>
  );
}

export function relTime(iso: string) {
  const d = new Date(iso);
  const diffH = (Date.now() - d.getTime()) / 36e5;
  if (diffH < 24 && d.getDate() === new Date().getDate())
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diffH < 24 * 6) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "Today 3:09 PM", "Yesterday 3:09 PM", "Mon 3:09 PM" (this week), "Oct 3, 3:09 PM" (this year), "Oct 3, 2024, 3:09 PM". */
export function readerDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 864e5);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days <= 6) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return `${date}, ${time}`;
}

/** Display names for a recipient list: the user's own addresses become "me", empty names fall back to the address. */
export function recipientNames(list: Contact[], mine: string[]): { label: string; address: string }[] {
  const own = new Set(mine.map((a) => a.toLowerCase()));
  return list.map((c) => ({
    label: own.has(c.address.toLowerCase()) ? "me" : c.name?.trim() || c.address,
    address: c.address,
  }));
}

export function TintBadge({ k, label, className }: { k: Tinted; label: string; className?: string }) {
  return (
    <span
      style={tint(k)}
      className={cn(
        "tint tint-soft tint-text inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        className,
      )}
    >
      {label}
    </span>
  );
}
