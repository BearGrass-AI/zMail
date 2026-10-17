// Scheduled: emails waiting to go out later, with Edit, Send now and Cancel.

import { useState } from "react";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { useMail } from "@/lib/store";
import { OUTLOOK_SERVER_HOLD, whenLabel, type ScheduledSend } from "@/lib/mail/scheduled";
import { accountColorOf } from "../account-switcher";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function Row({ r }: { r: ScheduledSend }) {
  const accounts = useMail((s) => s.accounts);
  const account = accounts.find((a) => a.id === r.accountId);
  const [busy, setBusy] = useState(false);
  // Gmail and (while the flag is off) Outlook wait for zMail to send them.
  const local = !r.server && (account?.kind === "gmail" || (account?.kind === "m365" && !OUTLOOK_SERVER_HOLD));
  const act = (label: string, run: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await run();
    } catch (err) {
      toast.error(label, { description: errText(err) });
    } finally {
      setBusy(false);
    }
  };
  const s = useMail.getState();
  const button = "inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-foreground/65 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50";
  return (
    <li className="rounded-xl px-4 py-3 ring-1 ring-hairline">
      <div className="flex items-center gap-2.5">
        {account && <span className="size-2 shrink-0 rounded-full" style={{ background: accountColorOf(account, accounts) }} title={account.address} />}
        <span className="min-w-0 truncate text-[13px] font-semibold">{r.to.join(", ") || "(no recipients)"}</span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11.5px] font-medium text-primary tabular-nums">
          <Clock className="size-3" /> {whenLabel(r.sendAt)}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[12.5px] text-foreground/55">
        <span className="text-foreground/80">{r.subject}</span>
        {r.snippet && <> · {r.snippet}</>}
      </div>
      {local && <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">zMail must be open on this Mac at send time</div>}
      {r.error && <div className="mt-1 text-[11px] text-destructive">Couldn't send: {r.error}</div>}
      <div className="mt-2 -ml-2.5 flex items-center gap-1">
        <button disabled={busy} className={button} onClick={act("Couldn't open it", () => s.editScheduled(r.id))}>
          Edit
        </button>
        <button disabled={busy} className={button} onClick={act("Couldn't send", () => s.sendScheduledNow(r.id))}>
          Send now
        </button>
        <button disabled={busy} className={button} onClick={act("Couldn't cancel", () => s.cancelScheduled(r.id))}>
          Cancel
        </button>
      </div>
    </li>
  );
}

export function ScheduledView() {
  const scheduled = useMail((s) => s.scheduled);
  const list = [...scheduled].sort((a, b) => a.sendAt - b.sendAt);
  return (
    <div className="h-full overflow-y-auto px-4 pb-6">
      {list.length ? (
        <ul className="mx-auto flex max-w-[720px] flex-col gap-2 pt-1">
          {list.map((r) => (
            <Row key={r.id} r={r} />
          ))}
        </ul>
      ) : (
        <div className="grid h-full place-items-center text-[13px] text-foreground/45">Nothing scheduled</div>
      )}
    </div>
  );
}
