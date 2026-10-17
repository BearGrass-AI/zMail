// Searchable "Move to…" picker. Scales to hundreds of folders: type to filter
// by any part of the path, arrows to choose, Enter to move.

import { useEffect, useMemo, useRef, useState } from "react";
import { Folder as FolderIcon, History, Search, WandSparkles } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { folderPath, suggestionFor, useMail } from "@/lib/store";
import { useFolderPrefs } from "@/lib/folder-prefs";
import { rankFolderMatches } from "@/lib/folder-search";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useEmailActions } from "./email-actions";

type Item = { id: string; path: string; group: "Suggested" | "Recent" | "All folders"; hint?: string };

export function FolderPicker() {
  const s = useMail();
  const ids = s.movePicker?.ids ?? null;
  const mode = s.movePicker?.mode ?? "move";
  const a = useEmailActions();
  const recent = useFolderPrefs((p) => p.recent);
  const threshold = useSettings((x) => x.suggestThreshold);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const first = ids ? s.emails.find((e) => e.id === ids[0]) : undefined;
  const accountId = first?.accountId;

  const items = useMemo<Item[]>(() => {
    if (!accountId || !first) return [];
    // Gmail parents synthesized from "a/b" label names aren't real labels.
    const targets = s.folders.filter((f) => f.accountId === accountId && !f.system && !f.id.includes(":path:"));
    const all = targets.map((f) => ({ id: f.id, path: folderPath(s.folders, f.id) }));
    if (q.trim()) return rankFolderMatches(all, q).map((f) => ({ ...f, group: "All folders" as const }));
    const out: Item[] = [];
    const sug = suggestionFor(s, first, threshold);
    if (sug) out.push({ id: sug.folderId, path: folderPath(s.folders, sug.folderId), group: "Suggested", hint: sug.rule ? "rule" : `${Math.round(sug.probability * 100)}%` });
    for (const r of recent) {
      const f = all.find((x) => x.id === r);
      if (f && !out.some((o) => o.id === f.id)) out.push({ ...f, group: "Recent" });
    }
    for (const f of all) if (!out.some((o) => o.id === f.id)) out.push({ ...f, group: "All folders" });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Narrow on purpose: `s` is the whole store and `first` its email, so listing them would rebuild on every store change.
  }, [accountId, q, s.folders, recent, threshold]);

  // A new picker starts with an empty search at the top.
  const [prevIds, setPrevIds] = useState(ids);
  if (ids !== prevIds) {
    setPrevIds(ids);
    setQ("");
    setIdx(0);
  }
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const choose = (item: Item | undefined) => {
    if (!item || !ids) return;
    if (mode === "rule" && first) a.rule(first, item.id);
    else void a.move(ids, item.id);
    s.openMovePicker(null);
  };

  return (
    <Dialog open={!!ids} onOpenChange={(o) => !o && s.openMovePicker(null)}>
      <DialogContent showCloseButton={false} className="top-[22%] translate-y-0 gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[520px]">
        <DialogTitle className="sr-only">Move to folder</DialogTitle>
        <div className="flex items-center gap-2.5 border-b border-hairline px-4">
          <Search className="size-4 text-foreground/40" />
          <input
            autoFocus
            value={q}
            onChange={(e) => (setQ(e.target.value), setIdx(0))}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setIdx((i) => Math.min(i + 1, items.length - 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setIdx((i) => Math.max(i - 1, 0)));
              if (e.key === "Enter") (e.preventDefault(), choose(items[idx]));
            }}
            placeholder={
              mode === "rule"
                ? `Always file ${first?.from.name.split(/[\s(]/)[0] ?? "this sender"} in… type a folder`
                : `Move ${ids && ids.length > 1 ? `${ids.length} emails` : "to"}… type any part of a folder path`
            }
            className="selectable h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-foreground/35"
          />
          <kbd className="kbd">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {items.map((it, i) => {
            const header = it.group !== items[i - 1]?.group ? it.group : null;
            const parts = it.path.split(" › ");
            return (
              <div key={`${it.group}-${it.id}`}>
                {header && <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-[0.04em] text-foreground/40 uppercase">{header}</div>}
                <button
                  data-idx={i}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => choose(it)}
                  className={cn(
                    "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px]",
                    i === idx ? "bg-primary text-primary-foreground" : "text-foreground/85",
                  )}
                >
                  {it.group === "Suggested" ? (
                    <WandSparkles className="size-4 shrink-0" />
                  ) : it.group === "Recent" ? (
                    <History className="size-4 shrink-0 opacity-70" />
                  ) : (
                    <FolderIcon className="size-4 shrink-0 opacity-60" strokeWidth={1.7} />
                  )}
                  <span className="truncate">
                    {parts.length > 1 && <span className={i === idx ? "opacity-70" : "text-foreground/40"}>{parts.slice(0, -1).join(" › ")} › </span>}
                    <span className="font-medium">{parts[parts.length - 1]}</span>
                  </span>
                  {it.hint && <span className="ml-auto text-[11.5px] opacity-70">{it.hint}</span>}
                </button>
              </div>
            );
          })}
          {items.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-foreground/40">No folder matches “{q}”.</p>}
        </div>
        <div className="flex gap-4 border-t border-hairline px-4 py-2 text-[11px] text-foreground/40">
          <span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> choose</span>
          <span><kbd className="kbd">↵</kbd> move</span>
          <span className="ml-auto">zMail learns from every move</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
