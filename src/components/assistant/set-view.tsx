// src/components/assistant/set-view.tsx
// An assistant set shown in the mail list: banner with "Back to Inbox",
// breakdown tabs, and rows. Mail zMail has loaded uses the normal InboxRow;
// header-only rows (older mail from a search) open by loading the full email
// and have their own quick actions.

import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { Email } from "@/lib/types";
import { useAssistant, type ResultSet } from "@/lib/ai/assistant/state";
import { realDeps } from "@/lib/ai/assistant/deps";
import { useMail } from "@/lib/store";
import { InboxRow } from "@/components/mail/email-row";
import { cn } from "@/lib/utils";

const PAGE = 100;

function HeaderRow({ email }: { email: Email }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const full = await useMail.getState().ensureEmail(email);
      useMail.getState().select(full.id);
    } catch (err) {
      toast.error("Couldn't open it", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  const act = async (kind: "archive" | "trash") => {
    try {
      const res = await useMail.getState().bulkApply([email], { kind });
      if (res.failed.length) {
        toast.error(kind === "trash" ? "Couldn't move it" : "Couldn't archive it", { description: res.error });
        return;
      }
      const undo = async () => {
        try {
          const r = await useMail.getState().bulkUndo(res.undo, { kind });
          if (r.failed.length) toast.error("Couldn't undo", { description: r.error });
        } catch (err) {
          toast.error("Couldn't undo", { description: err instanceof Error ? err.message : String(err) });
        }
      };
      toast(kind === "trash" ? "Moved to Trash" : "Archived", { action: { label: "Undo", onClick: () => void undo() } });
    } catch (err) {
      toast.error(kind === "trash" ? "Couldn't move it" : "Couldn't archive it", { description: err instanceof Error ? err.message : String(err) });
    }
  };
  return (
    <div onClick={() => void open()} className={cn("group flex cursor-default items-center gap-2 rounded-lg px-3 py-2 hover:bg-foreground/[0.04]", busy && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("truncate text-[13px]", email.unread && "font-semibold")}>{email.from.name || email.from.address}</span>
          <span className="ml-auto shrink-0 text-[11px] text-foreground/40">{new Date(email.date).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" })}</span>
        </div>
        <div className="truncate text-[12.5px] text-foreground/60">{email.subject}</div>
      </div>
      <div className="hidden shrink-0 gap-0.5 group-hover:flex">
        <button onClick={(e) => (e.stopPropagation(), void act("archive"))} aria-label="Archive" className="grid size-7 place-items-center rounded-md text-foreground/50 hover:bg-foreground/[0.08]">
          <Archive className="size-3.5" />
        </button>
        <button onClick={(e) => (e.stopPropagation(), void act("trash"))} aria-label="Move to Trash" className="grid size-7 place-items-center rounded-md text-foreground/50 hover:bg-foreground/[0.08]">
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function SetView() {
  const activeSetId = useAssistant((s) => s.activeSetId);
  const sets = useAssistant((s) => s.sets);
  const headers = useAssistant((s) => s.headers);
  const emails = useMail((s) => s.emails);
  const [shown, setShown] = useState(PAGE);
  const set: ResultSet | undefined = activeSetId ? sets[activeSetId] : undefined;
  const root: ResultSet | undefined = set?.parentId ? sets[set.parentId] : set;

  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const lastKey = useRef("");
  useEffect(() => {
    if (!set) return;
    const key = `${set.id}:${shown}:${retry}`;
    if (lastKey.current === key) return;
    lastKey.current = key;
    setLoadError(false);
    realDeps()
      .loadHeaders(set.refs.slice(0, shown))
      .catch(() => {
        if (lastKey.current === key) setLoadError(true);
      });
  }, [set, shown, retry]);

  const rows = useMemo(() => {
    if (!set) return [];
    const loaded = new Map(emails.filter((e) => !e.partial).map((e) => [e.id, e]));
    return set.refs
      .slice(0, shown)
      .map((r) => loaded.get(r.id) ?? headers[r.id])
      .filter((e): e is Email => !!e);
  }, [set, shown, emails, headers]);

  if (!set || !root) return null;
  // Rows that left this mailbox state (moved by an action) still show until the set is re-run; that's expected.
  return (
    <div className="flex h-full flex-col">
      <div className="mx-2 mt-1 flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-2 text-[12px]">
        <Sparkles className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 truncate">
          Assistant set: <b className="text-primary">{set.label}</b> · {set.refs.length.toLocaleString()}
        </span>
        <button onClick={() => useAssistant.getState().showSet(null)} className="ml-auto flex shrink-0 items-center gap-1 text-foreground/50 hover:text-foreground">
          Back to Inbox <X className="size-3.5" />
        </button>
      </div>
      {root.groups && (
        <div className="mx-2 mt-1.5 flex flex-wrap gap-1">
          {root.groups.map((g) => (
            <button
              key={g.setId}
              onClick={() => useAssistant.getState().showSet(g.setId)}
              className={cn("rounded-full px-2.5 py-0.5 text-[11px]", activeSetId === g.setId ? "bg-foreground text-background" : "bg-foreground/[0.06] text-foreground/60 hover:bg-foreground/10")}
            >
              {g.count.toLocaleString()} {g.label.toLowerCase()}
            </button>
          ))}
          <button
            onClick={() => useAssistant.getState().showSet(root.id)}
            className={cn("rounded-full px-2.5 py-0.5 text-[11px]", activeSetId === root.id ? "bg-foreground text-background" : "bg-foreground/[0.06] text-foreground/60 hover:bg-foreground/10")}
          >
            All {root.refs.length.toLocaleString()}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-16">
        {rows.map((e) => (e.partial ? <HeaderRow key={e.id} email={e} /> : <InboxRow key={e.id} email={e} />))}
        {loadError && (
          <div className="flex items-center justify-center gap-2 py-3 text-[12px] text-foreground/60">
            Couldn't load these emails.
            <button onClick={() => setRetry((n) => n + 1)} className="text-primary hover:underline">
              Retry
            </button>
          </div>
        )}
        {shown < set.refs.length && (
          <button onClick={() => setShown((n) => n + PAGE)} className="w-full py-3 text-center text-[12px] text-foreground/45 hover:text-foreground">
            Show {Math.max(0, Math.min(PAGE, set.refs.length - shown)).toLocaleString()} more of {Math.max(0, set.refs.length - shown).toLocaleString()}
          </button>
        )}
      </div>
    </div>
  );
}
