import { useEffect, useMemo, useState } from "react";
import { Check, Cloud, Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useMail } from "@/lib/store";
import { driveFor, type DriveFile, type DriveProvider } from "@/lib/drive";
import { formatBytes } from "@/lib/files";
import { cn } from "@/lib/utils";
import { fileIcon } from "@/lib/file-icons";
import { relTime } from "../meta";

export function DrivePicker({ open, onClose, onInsert, preferAccount }: {
  open: boolean;
  onClose: () => void;
  onInsert: (files: DriveFile[]) => void;
  preferAccount?: string;
}) {
  const accounts = useMail((s) => s.accounts);
  // One source per real account; a single demo source for demo mailboxes.
  const sources = useMemo<DriveProvider[]>(() => {
    const real = accounts.filter((a) => a.kind !== "mock").map(driveFor);
    const demo = accounts.find((a) => a.kind === "mock");
    return demo ? [...real, driveFor(demo)] : real;
  }, [accounts]);
  const [sourceIdx, setSourceIdx] = useState(0);
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [chosen, setChosen] = useState<Map<string, DriveFile>>(new Map());
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const source = sources[sourceIdx];

  // Each time the dialog opens, start fresh (and on the preferred account).
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setChosen(new Map());
      setQ("");
      const i = sources.findIndex((s) => s.account.id === preferAccount);
      setSourceIdx(i >= 0 ? i : 0);
    }
  }

  useEffect(() => {
    if (!open || !source) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the fetch below as started; it is the effect's own loading flag
    setState({ busy: true });
    const t = setTimeout(() => {
      (q.trim() ? source.search(q.trim()) : source.recent())
        .then((f) => live && (setFiles(f), setState({ busy: false })))
        .catch((err) => live && (setFiles([]), setState({ busy: false, error: err instanceof Error ? err.message : String(err) })));
    }, q ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, source, q]);

  const toggle = (f: DriveFile) =>
    setChosen((m) => {
      const next = new Map(m);
      if (next.has(f.id)) next.delete(f.id);
      else next.set(f.id, f);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[560px]">
        <div className="flex items-center gap-2.5 border-b border-hairline px-5 py-3.5">
          <Cloud className="size-4 text-primary" />
          <DialogTitle className="text-[15px] font-semibold">Insert from Drive</DialogTitle>
          {sources.length > 1 && (
            <div className="ml-auto inline-flex rounded-lg bg-foreground/[0.06] p-0.5">
              {sources.map((s, i) => (
                <button
                  key={s.account.id}
                  onClick={() => setSourceIdx(i)}
                  title={s.account.address}
                  className={cn("h-7 rounded-md px-2.5 text-[12px] font-medium", i === sourceIdx ? "bg-[var(--pane)] shadow-sm ring-1 ring-hairline" : "text-foreground/55")}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <label className="flex items-center gap-2.5 border-b border-hairline px-5">
          <Search className="size-4 text-foreground/40" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={source ? `Search ${source.label}` : "No drives connected"}
            className="selectable h-11 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-foreground/35"
          />
          {state.busy && <Loader2 className="size-4 animate-spin text-foreground/40" />}
        </label>
        <div className="h-[340px] overflow-y-auto p-1.5">
          {!q && <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.04em] text-foreground/40 uppercase">Recent</div>}
          {files.map((f) => {
            const Icon = fileIcon(f.mimeType, f.name);
            const on = chosen.has(f.id);
            return (
              <button
                key={f.id}
                onClick={() => toggle(f)}
                onDoubleClick={() => (onInsert([f]), onClose())}
                className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left", on ? "bg-primary/10" : "hover:bg-foreground/[0.05]")}
              >
                <span className={cn("grid size-5 place-items-center rounded-md border", on ? "border-primary bg-primary text-primary-foreground" : "border-foreground/20")}>
                  {on && <Check className="size-3" strokeWidth={3} />}
                </span>
                <Icon className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{f.name}</span>
                  <span className="block truncate text-[11.5px] text-foreground/45">
                    {relTime(f.modified)}
                    {f.owner ? ` · ${f.owner}` : ""}
                    {f.size ? ` · ${formatBytes(f.size)}` : ""}
                  </span>
                </span>
              </button>
            );
          })}
          {!state.busy && !files.length && (
            <p className="px-4 py-10 text-center text-[12.5px] text-foreground/45">{state.error ?? (q ? `Nothing matches “${q}”.` : "No recent files.")}</p>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-hairline px-5 py-3">
          <span className="text-[11.5px] text-foreground/40">Links keep each file's existing sharing.</span>
          <button onClick={onClose} className="ml-auto h-8 rounded-lg px-3 text-[13px] text-foreground/60 hover:bg-foreground/5">
            Cancel
          </button>
          <button
            onClick={() => (onInsert([...chosen.values()]), onClose())}
            disabled={!chosen.size}
            className="h-8 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground disabled:opacity-40"
          >
            Insert {chosen.size > 1 ? `${chosen.size} links` : "link"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
