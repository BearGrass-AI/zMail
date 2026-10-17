import { useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { QUICK } from "@/lib/motion";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Inbox, Sparkles } from "lucide-react";
import { inNeedsYou, inboxEmails, listEmails, useMail } from "@/lib/store";
import { InboxRow } from "./email-row";

/** Middle pane of the 3-pane layout for Inbox, Starred, Snoozed and folders. Only on-screen rows are mounted. */
export function MailList() {
  // listEmails reads only these slices; selecting them individually keeps the list stable across unrelated updates.
  const emails = useMail((s) => s.emails);
  const query = useMail((s) => s.query);
  const view = useMail((s) => s.view);
  const folders = useMail((s) => s.folders);
  const snoozed = useMail((s) => s.snoozed);
  const selectedId = useMail((s) => s.selectedId);
  const list = useMemo(
    () => listEmails({ emails, query, view, folders, snoozed } as Parameters<typeof listEmails>[0]),
    [emails, query, view, folders, snoozed],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualizer is only read in this component; nothing memoized receives its functions
  const virtualizer = useVirtualizer({
    count: list.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 76,
    overscan: 8,
    getItemKey: (i) => list[i].id,
  });

  // Keyboard navigation can select a row that isn't mounted; scroll to it.
  // Runs only when the selection changes, so a list refresh doesn't yank the view back.
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    if (!selectedId) return;
    const index = listRef.current.findIndex((e) => e.id === selectedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [selectedId, virtualizer]);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-2 pb-16">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full motion-safe:transition-transform motion-safe:duration-[120ms] motion-safe:ease-out"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {/* initial={false} skips the row's entry animation for rows that mount on scroll */}
            <AnimatePresence initial={false}>
              <InboxRow key={list[item.index].id} email={list[item.index]} />
            </AnimatePresence>
          </div>
        ))}
      </div>
      {list.length === 0 && <p className="py-16 text-center text-[13px] text-foreground/40">Nothing here.</p>}
    </div>
  );
}

/** Right pane when nothing is selected. */
export function EmptyReader() {
  const s = useMail();
  const inbox = inboxEmails(s);
  const unread = inbox.filter((e) => e.unread).length;
  // Same as the dock badge: unread mail that really is in Needs you (not resolved, not held by a section).
  const needs = inbox.filter((e) => e.unread && inNeedsYou(s, e)).length;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={QUICK}
      className="grid h-full place-items-center text-center"
    >
      <div>
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-foreground/[0.05] text-foreground/35">
          <Inbox className="size-6" strokeWidth={1.6} />
        </div>
        <div className="mt-4 text-[15px] font-semibold text-foreground/70">No message selected</div>
        <div className="mt-1 text-[12.5px] text-foreground/40">
          {unread} unread · <Sparkles className="inline size-3 text-primary" /> {needs} need you
        </div>
        <div className="mt-4 flex justify-center gap-3 text-[11.5px] text-foreground/35">
          <span><kbd className="kbd">J</kbd> <kbd className="kbd">K</kbd> browse</span>
          <span><kbd className="kbd">C</kbd> compose</span>
          <span><kbd className="kbd">⌘K</kbd> search</span>
        </div>
      </div>
    </motion.div>
  );
}
