// The list pane while searching: "Results for …", the All mail / this view switch, and one list of
// matches across all cached mail, newest first. With meaning-based search on, a few Best matches
// come first (the local model ranks them; nothing leaves the Mac). Rows show where each email is;
// they never ask a remote model for anything (no one-liners, no triage), so a search spends nothing.

import { Fragment, memo, useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Email } from "@/lib/types";
import { ROW_MOTION, SPRING_PILL } from "@/lib/motion";
import { resultGroups, SEARCH_MAX, searchHere, searchWords, useMail, type SearchScope } from "@/lib/store";
import { markParts, resultLine } from "@/lib/mail/search-text";
import { cn } from "@/lib/utils";
import { EmailContextMenu, QuickActions } from "../email-actions";
import { SenderAvatar, relTime } from "../meta";
import { RowCheck, useRowSelect } from "../selection";
import { AccountDot } from "../account-switcher";

/** This year: as other lists show dates. Before: just the year (the full date is in the tooltip). */
function resultDate(iso: string) {
  const d = new Date(iso);
  return d.getFullYear() === new Date().getFullYear() ? relTime(iso) : String(d.getFullYear());
}

function Marked({ text, words }: { text: string; words: string[] }) {
  return (
    <>
      {markParts(text, words).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-[3px] bg-amber-300/45 px-px text-inherit dark:bg-amber-300/30">
            {p.text}
          </mark>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

/** One result: avatar, sender, subject, the matching line, and the date over the email's folder. */
const ResultRow = memo(function ResultRow({ email, words }: { email: Email; words: string[] }) {
  const selected = useMail((s) => s.selectedId === email.id);
  const folder = useMail((s) => s.folders.find((f) => f.id === email.folderId));
  const sel = useRowSelect(email.id);
  const line = useMemo(() => resultLine(email, words), [email, words]);

  return (
    <motion.div {...ROW_MOTION} className="overflow-hidden">
      <EmailContextMenu email={email}>
        <div
          onClick={sel.onClick}
          className={cn(
            "group relative flex cursor-default gap-3 rounded-xl px-3 py-2.5 transition-colors select-none",
            sel.checked ? "bg-primary/[0.15]" : selected ? "bg-primary/[0.1]" : "hover:bg-foreground/[0.04]",
          )}
        >
          {email.unread && <span className="absolute top-[18px] left-1 size-1.5 rounded-full bg-primary" />}
          <RowCheck checked={sel.checked} selecting={sel.selecting} onCheck={sel.onCheck}>
            <div className="relative h-fit shrink-0">
              <SenderAvatar contact={email.from} junk={folder?.system === "spam"} />
              <AccountDot accountId={email.accountId} />
            </div>
          </RowCheck>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className={cn("max-w-[60%] shrink-0 truncate text-[13.5px]", email.unread ? "font-semibold" : "font-medium")}>{email.from.name || email.from.address}</span>
              <span className={cn("min-w-0 truncate text-[13px]", email.unread ? "text-foreground" : "text-foreground/80")}>{email.subject}</span>
            </div>
            <div className="mt-0.5 truncate text-[12.5px] text-foreground/45">
              <Marked text={line} words={words} />
            </div>
          </div>
          <div className={cn("flex shrink-0 flex-col items-end gap-1 transition-opacity", !sel.selecting && "group-hover:opacity-0")}>
            <span className="text-[11.5px] text-foreground/40 tabular-nums" title={new Date(email.date).toLocaleString()}>
              {resultDate(email.date)}
            </span>
            {folder && (
              <span className="inline-flex h-[18px] max-w-[110px] items-center rounded-full bg-foreground/[0.05] px-1.5 text-[10.5px] text-foreground/50 shadow-[inset_0_0_0_1px_var(--hairline)]">
                <span className="truncate">{folder.name}</span>
              </span>
            )}
          </div>
          {!sel.selecting && <QuickActions email={email} compact />}
        </div>
      </EmailContextMenu>
    </motion.div>
  );
});

type Item = { email: Email } | { head: string };
const NONE: Email[] = [];

/** All mail, or the view the search started from. */
function ScopeSwitch({ scope, here }: { scope: SearchScope; here: string }) {
  const options: { id: SearchScope; label: string }[] = [
    { id: "all", label: "All mail" },
    { id: "here", label: here },
  ];
  return (
    <div role="radiogroup" aria-label="Search in" className="inline-flex min-w-0 shrink-0 rounded-[8px] bg-foreground/[0.055] p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={scope === o.id}
          onClick={() => useMail.getState().setSearchScope(o.id)}
          className="relative h-6 max-w-[150px] min-w-0 rounded-[6px] px-2.5 text-[12px] font-medium"
        >
          {scope === o.id && (
            <motion.span
              layoutId="search-scope-pill"
              className="absolute inset-0 rounded-[6px] bg-[var(--pane)] shadow-[0_1px_2px_oklch(0_0_0/10%),0_0_0_1px_var(--hairline)]"
              transition={SPRING_PILL}
            />
          )}
          <span className={cn("relative block truncate", scope !== o.id && "text-foreground/50")}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** The list pane in search mode. Only on-screen rows are mounted. */
export function SearchResults() {
  const search = useMail((s) => s.search);
  const emails = useMail((s) => s.emails);
  const folders = useMail((s) => s.folders);
  const snoozed = useMail((s) => s.snoozed);
  const view = useMail((s) => s.view);
  const accountFilter = useMail((s) => s.accountFilter);
  const accounts = useMail((s) => s.accounts);
  const query = useMail((s) => s.query.trim());
  const selectedId = useMail((s) => s.selectedId);
  const groups = useMemo(
    () => (search ? resultGroups({ emails, folders, snoozed, view, accountFilter, accounts, search }) : null),
    [search, emails, folders, snoozed, view, accountFilter, accounts],
  );
  const list = groups?.all ?? NONE;
  // What the list mounts: the rows, with a heading over each group when there are Best matches.
  const items = useMemo<Item[]>(() => {
    if (!groups?.best.length) return list.map((email) => ({ email }));
    return [
      { head: "Best matches" },
      ...groups.best.map((email) => ({ email })),
      ...(groups.rest.length ? [{ head: "Newest first" }, ...groups.rest.map((email) => ({ email }))] : []),
    ];
  }, [groups, list]);
  const results = search?.results ?? null;
  const answered = results?.query ?? "";
  const words = useMemo(() => searchWords(answered), [answered]);
  const here = useMemo(() => {
    const h = searchHere(view);
    if (h.kind === "folder") return folders.find((f) => f.id === h.folderId)?.name ?? "This folder";
    return h.kind === "starred" ? "Starred" : h.kind === "snoozed" ? "Snoozed" : "Inbox";
  }, [view, folders]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualizer is only read in this component; nothing memoized receives its functions
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => ("head" in items[i] ? 30 : 64),
    overscan: 8,
    getItemKey: (i) => {
      const it = items[i];
      return "head" in it ? `head:${it.head}` : it.email.id;
    },
  });

  // A new answer (another query, scope or account) starts at the top.
  const key = results?.key;
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [key]);

  // Keyboard navigation can select a row that isn't mounted; scroll to it (only when the selection changes).
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    if (!selectedId) return;
    const index = itemsRef.current.findIndex((it) => "email" in it && it.email.id === selectedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [selectedId, virtualizer]);

  if (!search) return null;
  const capped = !!results && (results.capped || list.length >= SEARCH_MAX);
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 pb-2">
        <h2 className="min-w-0 max-w-full truncate text-[14px] font-semibold tracking-tight">Results for “{query}”</h2>
        {results && <span className="text-[12.5px] text-foreground/40 tabular-nums">{capped ? `${SEARCH_MAX}+` : list.length.toLocaleString()}</span>}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <ScopeSwitch scope={search.scope} here={here} />
          <button onClick={() => useMail.getState().setQuery("")} className="shrink-0 rounded px-1 text-[12px] font-medium text-primary hover:underline">
            Clear
          </button>
        </div>
      </div>
      {results?.indexing && <p className="px-4 pb-1.5 text-[12px] text-foreground/45">Still indexing older mail. Some results may be missing.</p>}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-16">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const it = items[item.index];
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full motion-safe:transition-transform motion-safe:duration-[120ms] motion-safe:ease-out"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {"head" in it ? (
                  <h3 className={cn("px-3 pb-1 text-[11.5px] font-semibold text-foreground/45", item.index === 0 ? "pt-0.5" : "pt-3")}>{it.head}</h3>
                ) : (
                  // initial={false}: rows mounting on scroll or with a new answer don't animate in
                  <AnimatePresence initial={false}>
                    <ResultRow key={it.email.id} email={it.email} words={words} />
                  </AnimatePresence>
                )}
              </div>
            );
          })}
        </div>
        {results && list.length === 0 && <p className="py-16 text-center text-[13px] text-foreground/40">No results</p>}
      </div>
    </div>
  );
}
