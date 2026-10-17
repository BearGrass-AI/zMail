// All | Personal | Work: filters Today, Triage and Calendar to one account.
// Each account gets a color; in "All", a dot on avatars shows which account.

import { motion } from "motion/react";
import { SPRING_PILL } from "@/lib/motion";
import { useShallow } from "zustand/react/shallow";
import type { Account } from "@/lib/types";
import { inNeedsYou, inboxEmails, useMail } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Distinct hues in connection order: red, violet, teal, amber, green. */
const HUES = [25, 295, 195, 75, 150];

export function accountHue(accounts: Account[], id: string) {
  const i = accounts.findIndex((a) => a.id === id);
  return HUES[(i < 0 ? 0 : i) % HUES.length];
}

export const accountColor = (h: number) => `oklch(0.68 0.16 ${h})`;

/** The account's chosen color, or its default by connection order. */
export const accountColorOf = (a: Account, accounts: Account[]) => a.color ?? accountColor(accountHue(accounts, a.id));

/** Your name for it, else "Gmail" / "Outlook" (the address when two accounts share a kind). */
export function accountLabel(a: Account, accounts: Account[]) {
  if (a.label?.trim()) return a.label.trim();
  if (a.kind === "mock") return a.name;
  const same = accounts.filter((x) => x.kind === a.kind).length > 1;
  return same ? a.address : a.kind === "m365" ? "Outlook" : "Gmail";
}

/** The account's image, or a letter tile in its color. */
export function AccountIcon({ account, size = 32, className }: { account: Account; size?: number; className?: string }) {
  const accounts = useMail((s) => s.accounts);
  const radius = Math.round(size * 0.27);
  if (account.icon)
    return (
      <img
        src={account.icon}
        alt=""
        draggable={false}
        // White tile: transparent logos (e.g. maroon on clear) stay visible in dark mode.
        className={cn("shrink-0 bg-white object-contain", className)}
        style={{ width: size, height: size, borderRadius: radius, padding: Math.max(1, Math.round(size * 0.08)) }}
      />
    );
  const letter = (account.label?.trim() || (account.kind === "m365" ? "Outlook" : account.kind === "gmail" ? "Gmail" : account.name)).charAt(0).toUpperCase();
  return (
    <span
      className={cn("grid shrink-0 place-items-center font-bold text-white", className)}
      style={{ width: size, height: size, borderRadius: radius, background: accountColorOf(account, accounts), fontSize: Math.round(size * 0.42) }}
    >
      {letter}
    </span>
  );
}

/** Which account an email came from, shown only when several accounts are mixed together. */
export function AccountDot({ accountId, className }: { accountId: string; className?: string }) {
  const accounts = useMail((s) => s.accounts);
  const filtered = useMail((s) => !!s.accountFilter);
  if (accounts.length < 2 || filtered) return null;
  const a = accounts.find((x) => x.id === accountId);
  if (!a) return null;
  if (a.icon)
    return (
      <img
        src={a.icon}
        alt=""
        title={accountLabel(a, accounts)}
        className={cn("absolute -right-1 -bottom-1 size-3.5 rounded-[4px] bg-white object-contain p-px ring-2 ring-[var(--pane)]", className)}
      />
    );
  return (
    <span
      title={accountLabel(a, accounts)}
      className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-[var(--pane)]", className)}
      style={{ background: accountColorOf(a, accounts) }}
    />
  );
}

export function AccountSwitcher() {
  const accounts = useMail((s) => s.accounts);
  const filter = useMail((s) => s.accountFilter);
  const setFilter = useMail((s) => s.setAccountFilter);
  // Unread "Needs you" per account (same as the dock badge), so you can see where the fire is before switching.
  const counts = useMail(
    useShallow((s) => {
      const out: Record<string, number> = {};
      for (const e of inboxEmails(s)) if (e.unread && inNeedsYou(s, e)) out[e.accountId] = (out[e.accountId] ?? 0) + 1;
      return out;
    }),
  );
  if (accounts.length < 2) return null;
  const total = Object.values(counts).reduce((n, x) => n + x, 0);

  const items = [{ id: null as string | null, label: "All", count: total, account: null as Account | null, title: "All accounts · ⌘⇧0" }].concat(
    accounts.map((a, i) => ({ id: a.id, label: accountLabel(a, accounts), count: counts[a.id] ?? 0, account: a, title: `${a.address} · ⌘⇧${i + 1}` })),
  );

  return (
    <div className="inline-flex min-w-0 rounded-[9px] bg-foreground/[0.055] p-0.5">
      {items.map((it) => {
        const on = filter === it.id;
        return (
          <button key={it.id ?? "all"} onClick={() => setFilter(it.id)} title={it.title} className="relative h-7 min-w-0 rounded-[7px] px-2.5 text-[12.5px] font-medium">
            {on && (
              <motion.span
                layoutId="account-pill"
                className="absolute inset-0 rounded-[7px] bg-[var(--pane)] shadow-[0_1px_2px_oklch(0_0_0/10%),0_0_0_1px_var(--hairline)]"
                transition={SPRING_PILL}
              />
            )}
            <span className={cn("relative flex min-w-0 items-center gap-1.5", !on && "text-foreground/50")}>
              {it.account &&
                (it.account.icon ? (
                  <AccountIcon account={it.account} size={15} />
                ) : (
                  <span className="size-[7px] rounded-full" style={{ background: accountColorOf(it.account, accounts) }} />
                ))}
              <span className="max-w-[140px] min-w-0 truncate">{it.label}</span>
              {it.count > 0 && <span className={cn("text-[11px] tabular-nums", on ? "text-foreground/45" : "text-foreground/35")}>{it.count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
