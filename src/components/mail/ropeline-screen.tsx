// The on-device RopeLine reading for one message. Checking a question does not move the mail.

import { useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { Email } from "@/lib/types";
import { useMail } from "@/lib/store";
import { screenMail, type ScreenLevel } from "@/lib/ropeline-security";
import { cn } from "@/lib/utils";

const LABEL: Record<ScreenLevel, string> = {
  clear: "Nothing to check",
  warn: "Check this",
  quarantine: "Hold",
};

export function RopeLineBadge({ email }: { email: Email }) {
  const flag = useMail((s) => s.ropelineFlags[email.id]);
  const level = screenMail(email, flag).level;
  if (level === "clear") return null;
  return (
    <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium", level === "quarantine" ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-700 dark:text-amber-300")}>
      {LABEL[level]}
    </span>
  );
}

export function RopeLineScreen({ email }: { email: Email }) {
  const flag = useMail((s) => s.ropelineFlags[email.id]);
  const setCheck = useMail((s) => s.setRopeLineCheck);
  const screening = screenMail(email, flag);
  const [open, setOpen] = useState(screening.level !== "clear");
  const Icon = screening.level === "clear" ? ShieldCheck : ShieldAlert;
  return (
    <section className="mt-4 rounded-xl border border-hairline bg-pane-2" aria-label="RopeLine">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon className={cn("size-4 shrink-0", screening.level === "quarantine" ? "text-destructive" : screening.level === "warn" ? "text-amber-600" : "text-foreground/45")} />
        <span className="text-[13px] font-medium">RopeLine · {LABEL[screening.level]}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/55">{screening.reason}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-hairline px-3 py-3">
          {screening.level === "quarantine" && (
            <p className="text-[12.5px] leading-snug text-foreground/70">Held for you to look at. Nothing was deleted, and the message is still in this folder.</p>
          )}
          {screening.findings.map((f) => (
            <div key={f.id}>
              <div className="text-[13px] font-medium">{f.title}</div>
              <p className="text-[12.5px] leading-snug text-foreground/60">{f.detail}</p>
            </div>
          ))}
          {screening.questions.map((q) => {
            const on = flag?.checks?.[q.id] === true;
            return (
              <label key={q.id} className="flex items-start gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={on}
                  onChange={(e) => setCheck(email.id, q.id, e.target.checked)}
                />
                <span>{q.prompt}</span>
              </label>
            );
          })}
          {screening.level === "clear" && <p className="text-[12.5px] text-foreground/55">Signals were read on this Mac.</p>}
        </div>
      )}
    </section>
  );
}
