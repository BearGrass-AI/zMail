// Every way to act on an email: the hover quick-action bar and the right-click
// menu. Both route through useEmailActions so behavior (and undo) is identical.

import { useState, type ReactNode } from "react";
import {
  Archive,
  BellOff,
  CalendarPlus,
  Clock,
  Folder as FolderIcon,
  Forward,
  History,
  Search,
  Mail,
  MailOpen,
  OctagonAlert,
  Reply,
  ReplyAll,
  Sparkles,
  Star,
  Trash2,
  UserRoundCheck,
  WandSparkles,
  CircleSlash,
} from "lucide-react";
import { toast } from "sonner";
import type { Bucket, Category, Email } from "@/lib/types";
import { BUCKETS, CATEGORIES } from "@/lib/types";
import { bucketOf, categoryOf, folderPath, inboxEmails, sectionOf, suggestionFor, useMail, type ActionResult } from "@/lib/store";
import { useShallow } from "zustand/react/shallow";
import { Check, Undo2 } from "lucide-react";
import { inNeedsYou, isInbox } from "@/lib/store";
import { sectionsFor } from "@/lib/sections";
import { useFolderPrefs } from "@/lib/folder-prefs";
import { useSettings } from "@/lib/settings";
import { generativeProvider } from "@/lib/ai/providers";
import { summarize } from "@/lib/ai/generative";
import { useAssistant } from "@/lib/ai/assistant/state";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BUCKET_META, CATEGORY_META, SECTION_ICON } from "@/lib/meta";
import { Tile, hue } from "./meta";
import { disposalNeedsConfirm } from "@/lib/ropeline-security";

/** Category names as the Can go bundles show them. */
export const CATEGORY_NAMES: Record<Category, string> = {
  primary: "Personal",
  transactions: "Receipts & bills",
  updates: "Notifications",
  promotions: "Promos",
  social: "Social",
  newsletters: "Newsletters",
  security: "Sign-in & security",
};

// ---- behavior ---------------------------------------------------------------

export function snoozeTimes() {
  const now = new Date();
  const later = new Date(now.getTime() + 3 * 36e5);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  nextWeek.setHours(8, 0, 0, 0);
  return [
    { label: "Later today", hint: later.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), at: later },
    { label: "Tomorrow", hint: "8:00 AM", at: tomorrow },
    { label: "Next week", hint: nextWeek.toLocaleDateString([], { weekday: "short" }) + " 8:00 AM", at: nextWeek },
  ];
}

/** The sender's first name when the emails share one sender, else "these senders". */
function senderName(emails: Email[], ids: string[]) {
  const want = new Set(ids);
  const from = emails.filter((e) => want.has(e.id));
  const senders = new Set(from.map((e) => e.from.address.toLowerCase()));
  if (senders.size !== 1) return "these senders";
  return from[0].from.name?.split(/[\s(]/)[0] || from[0].from.address;
}

/**
 * Actions read the store when they run (not at render), so they're safe to call
 * from keyboard handlers too, and rows don't re-render on every store change.
 */
export function emailActions() {
  const s = useMail.getState();
  const live = () => useMail.getState();

  /**
   * Run a folder-changing action. The emails leave the screen at once and the Undo toast
   * shows right away; anything the server refuses comes back, and the toast says so.
   */
  const withUndo = (ids: string[], label: string, pastTense: string, run: () => Promise<ActionResult>) => {
    const before = new Map(ids.map((id) => [id, live().emails.find((e) => e.id === id)?.folderId]));
    const pending = run();
    let undone = false;
    const undo = async () => {
      if (undone) return;
      undone = true;
      // Undo only what actually moved, once it has.
      const { done } = await pending;
      const byFolder = new Map<string, string[]>();
      for (const id of done) {
        const f = before.get(id);
        if (f) byFolder.set(f, [...(byFolder.get(f) ?? []), id]);
      }
      const res = await Promise.all([...byFolder].map(([f, group]) => live().move(group, f, { learn: false })));
      const failed = res.reduce((k, r) => k + r.failed.length, 0);
      if (failed) toast.error(failed === done.length ? "Couldn't undo" : `Couldn't undo ${failed} of ${done.length}`, { description: res.find((r) => r.error)?.error });
    };
    const action = { label: "Undo", onClick: () => void undo() };
    const id = toast(label, { action });
    return pending.then((res) => {
      // Nothing moved (say it was already on its way there): no toast claiming it did.
      if (!res.done.length && !res.failed.length) return void toast.dismiss(id);
      if (!res.failed.length) return;
      const total = res.done.length + res.failed.length;
      toast.error(res.done.length ? `${res.failed.length} of ${total} not ${pastTense}` : `Not ${pastTense}`, {
        id,
        description: `${res.error ?? "The server refused."} ${res.failed.length === 1 ? "It's" : "They're"} back where ${res.failed.length === 1 ? "it was" : "they were"}.`,
        action: res.done.length ? action : undefined,
      });
    });
  };
  const n = (ids: string[]) => (ids.length === 1 ? "" : ` ${ids.length}`);
  /** Search results that aren't loaded yet go into the store first, so the action finds them like any email. */
  const take = <T extends string | string[]>(ids: T): T => {
    live().adoptResults(typeof ids === "string" ? [ids] : ids);
    return ids;
  };
  /** Re-sort the same senders' other inbox mail with a correction; the toast line that says so. */
  const relearn = (ids: string[], then: string) => {
    const n = live().resortSendersOf(ids);
    return n ? `${then} Re-sorting ${n} more from ${senderName(live().emails, ids)} with this.` : then;
  };

  return {
    archive: (ids: string[]) => {
      take(ids);
      // Section mail with a linked label gets filed there instead of archived.
      const st = live();
      const secs = ids.map((id) => {
        const e = st.emails.find((x) => x.id === id);
        return e ? sectionOf(st, e) : undefined;
      });
      const one = secs[0]?.folderId && secs.every((x) => x?.id === secs[0]?.id) ? secs[0] : undefined;
      return withUndo(ids, one ? `Filed${n(ids)} in ${one.name}` : `Archived${n(ids)}`, one ? "filed" : "archived", () => s.archive(ids));
    },
    trash: (ids: string[]) => {
      take(ids);
      // Mail already in Trash has nowhere to go: say so, with no Undo for a move that didn't happen.
      const st = live();
      const inTrash = (id: string) => {
        const e = st.emails.find((x) => x.id === id);
        return !!e && st.folders.find((f) => f.id === e.folderId)?.system === "trash";
      };
      const rest = ids.filter((id) => !inTrash(id));
      if (!rest.length) {
        toast("Already in Trash");
        return Promise.resolve();
      }
      const go = () => withUndo(rest, `Deleted${n(rest)}`, "deleted", () => live().trash(rest));
      if (disposalNeedsConfirm(rest, st.emails, st.ropelineFlags)) {
        toast(rest.length === 1 ? "RopeLine is holding this message" : `RopeLine is holding ${rest.length} messages`, {
          description: "Trash it anyway? Nothing has been deleted yet.",
          action: { label: "Trash", onClick: () => void go() },
        });
        return Promise.resolve();
      }
      return go();
    },
    spam: (ids: string[]) => {
      const taken = take(ids);
      const go = () => withUndo(taken, `Marked as spam`, "marked as spam", () => live().spam(taken));
      const st = live();
      if (disposalNeedsConfirm(taken, st.emails, st.ropelineFlags)) {
        toast(taken.length === 1 ? "RopeLine is holding this message" : `RopeLine is holding ${taken.length} messages`, {
          description: "Mark it as spam anyway? Nothing has been moved yet.",
          action: { label: "Spam", onClick: () => void go() },
        });
        return Promise.resolve();
      }
      return go();
    },
    move: (ids: string[], folderId: string) => {
      take(ids);
      const folder = live().folders.find((f) => f.id === folderId);
      // A folder belongs to one account; mail from other accounts can't go there.
      const same = ids.filter((id) => live().emails.find((e) => e.id === id)?.accountId === folder?.accountId);
      if (same.length < ids.length) toast(`${ids.length - same.length} from other accounts weren't moved`, { description: "Folders belong to one account." });
      if (!same.length) return Promise.resolve();
      useFolderPrefs.getState().pushRecent(folderId);
      return withUndo(same, `Moved${n(same)} to ${folder?.name}`, "moved", () => s.move(same, folderId));
    },
    pickFolder: (ids: string[]) => s.openMovePicker({ ids: take(ids), mode: "move" }),
    pickRule: (id: string) => s.openMovePicker({ ids: [take(id)], mode: "rule" }),
    snooze: (ids: string[], at: Date, label: string) => {
      s.snooze(take(ids), at.getTime());
      toast(`Snoozed until ${label.toLowerCase()}`);
    },
    star: (id: string) => void s.toggleStar(take(id)).then((r) => r.failed.length && toast.error("Couldn't change the star", { description: r.error })),
    read: (ids: string[], read: boolean) =>
      void s.setRead(take(ids), read).then((r) => r.failed.length && toast.error(`Couldn't mark as ${read ? "read" : "unread"}`, { description: r.error })),
    reply: (id: string) => s.openCompose({ mode: "blank", replyTo: take(id) }),
    replyAll: (id: string) => s.openCompose({ mode: "blank", replyTo: take(id), all: true }),
    replyAI: (id: string) => s.openCompose({ mode: "ai", replyTo: take(id) }),
    forward: (id: string) => s.openCompose({ mode: "blank", replyTo: take(id), forward: true }),
    teach: (ids: string[], bucket: Bucket) => {
      take(ids);
      // A section holds mail out of Worth a skim and Can go, so taking it there means taking it
      // out of its section too (as dragging between Triage lanes does).
      const st = live();
      const sectioned = bucket === "needs_you" ? [] : ids.filter((id) => {
        const e = st.emails.find((x) => x.id === id);
        return !!e && !!sectionOf(st, e);
      });
      if (sectioned.length) s.setSection(sectioned, null);
      s.setBucket(ids, bucket);
      toast(`Got it: ${BUCKET_META[bucket].label}`, { description: relearn(ids, "It stays there, even after a re-sort.") });
    },
    category: (ids: string[], category: Category) => {
      take(ids);
      const st = live();
      s.setCategory(ids, category);
      // The same sender's other inbox mail is usually the same kind; offer to fix it too.
      const senders = new Set(st.emails.filter((e) => ids.includes(e.id)).map((e) => e.from.address.toLowerCase()));
      const others = senders.size === 1 ? inboxEmails(st).filter((e) => !ids.includes(e.id) && senders.has(e.from.address.toLowerCase()) && categoryOf(st, e.id) !== category) : [];
      const name = st.emails.find((e) => e.id === ids[0])?.from.name ?? "this sender";
      toast(`Got it: ${CATEGORY_NAMES[category]}`, {
        description: relearn(ids, `zMail will tell ${st.sorting.model ?? "the sorting model"} next time ${senders.size === 1 ? name : "these senders"} write${senders.size === 1 ? "s" : ""}.`),
        ...(others.length
          ? { action: { label: `Also ${others.length} more from ${name.split(/[\s(]/)[0]}`, onClick: () => useMail.getState().setCategory(others.map((e) => e.id), category) } }
          : {}),
      });
    },
    section: (ids: string[], sectionId: string | null) => {
      take(ids);
      const st = live();
      // Moving out of "Needs you" into a section, so it shows up there.
      if (sectionId) st.setBucket(ids.filter((id) => bucketOf(st, id) === "needs_you"), "worth_skim");
      s.setSection(ids, sectionId);
      const name = st.sections.find((x) => x.id === sectionId)?.name;
      toast(name ? `Got it: ${name}` : "Taken out of its section", { description: relearn(ids, "It stays that way, even after a re-sort.") });
    },
    rule: (email: Email, folderId: string) => {
      s.addRule(email.from.address, folderId);
      const name = live().folders.find((f) => f.id === folderId)?.name;
      toast(`Mail from ${email.from.name} will be filed in ${name}`, {
        description: "zMail will still ask before moving each one.",
      });
    },
    summarize: async (email: Email) => {
      const id = toast.loading("Summarizing…");
      try {
        const text = await summarize(generativeProvider(), email);
        toast(email.subject, { id, description: text, duration: 9000, icon: <Sparkles className="size-4 text-primary" /> });
      } catch (err) {
        toast.error("Couldn't summarize", { id, description: String(err) });
      }
    },
    /** Out of Needs you for good, still in the inbox, marked read. Teaches the model nothing. */
    done: (ids: string[]) => {
      take(ids);
      const st = live();
      const todo = ids.filter((id) => !st.resolved[id]);
      if (!todo.length) return;
      st.resolve(todo, "done");
      toast(todo.length > 1 ? `Done · ${todo.length}` : "Done", { action: { label: "Undo", onClick: () => useMail.getState().unresolve(todo) } });
    },
    notDone: (ids: string[]) => live().unresolve(ids),
  };
}

export const useEmailActions = emailActions;

function useMoveTargets(email: Email) {
  const folders = useMail((s) => s.folders);
  const threshold = useSettings((x) => x.suggestThreshold);
  const recentIds = useFolderPrefs((p) => p.recent);
  const sug = useMail(useShallow((s) => suggestionFor(s, email, threshold)));
  const recent = recentIds
    .map((id) => folders.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => !!f && f.accountId === email.accountId && f.id !== sug?.folderId)
    .slice(0, 5);
  return { sug, recent, path: (id: string) => folderPath(folders, id) };
}

// ---- right-click menu -----------------------------------------------------------

/** Kinds of email, for "Teach zMail: this is ▸". */
export function CategoryItems({ ids }: { ids: string[] }) {
  const a = useEmailActions();
  const current = useMail((s) => (ids.length === 1 ? categoryOf(s, ids[0]) : undefined));
  return (
    <ContextMenuGroup>
      <ContextMenuLabel>Kind of email</ContextMenuLabel>
      {CATEGORIES.map((c) => (
        <ContextMenuItem key={c} onClick={() => a.category(ids, c)}>
          <Tile icon={CATEGORY_META[c].icon} k={c} size={16} className="[&_svg]:size-[9px]!" />
          {CATEGORY_NAMES[c]}
          {current === c && <span className="ml-auto text-[11px] opacity-60">current</span>}
        </ContextMenuItem>
      ))}
    </ContextMenuGroup>
  );
}

/** Your sections, inside "Teach zMail: this is ▸" next to the lanes (on Triage they're lanes too). */
function SectionItems({ ids }: { ids: string[] }) {
  const a = useEmailActions();
  const sections = useMail((s) => s.sections);
  const emails = useMail((s) => s.emails);
  const current = useMail((s) => {
    const e = ids.length === 1 ? s.emails.find((x) => x.id === ids[0]) : undefined;
    return e ? sectionOf(s, e)?.id : undefined;
  });
  const accounts = new Set(emails.filter((e) => ids.includes(e.id)).map((e) => e.accountId));
  const options = sections.filter((x) => [...accounts].every((acc) => sectionsFor([x], acc).length));
  if (!options.length) return null;
  return (
    <>
      <ContextMenuGroup>
        <ContextMenuLabel>Your sections</ContextMenuLabel>
        {options.map((x) => {
          const Icon = SECTION_ICON[x.icon];
          return (
            <ContextMenuItem key={x.id} onClick={() => a.section(ids, x.id)}>
              <Icon style={hue(x.hue)} className="tint tint-text" /> {x.name}
              {current === x.id && <span className="ml-auto text-[11px] opacity-60">current</span>}
            </ContextMenuItem>
          );
        })}
        {current && (
          <ContextMenuItem onClick={() => a.section(ids, null)}>
            <CircleSlash /> Not in a section
          </ContextMenuItem>
        )}
      </ContextMenuGroup>
      <ContextMenuSeparator />
    </>
  );
}

/** Bulk "Mark as read/unread". Lives inside the menu content, so it only subscribes while the menu is open. */
function BulkReadItem({ ids }: { ids: string[] }) {
  const a = useEmailActions();
  const unread = useMail((s) => s.emails.some((e) => s.checked.has(e.id) && e.unread));
  return (
    <ContextMenuItem onClick={() => a.read(ids, unread)}>
      {unread ? <MailOpen /> : <Mail />} Mark as {unread ? "read" : "unread"}
      <ContextMenuShortcut>U</ContextMenuShortcut>
    </ContextMenuItem>
  );
}

/**
 * "Done" for urgent mail (several: always), or "Not done" once all of it is done.
 * Lives inside the menu content, so it only subscribes while the menu is open.
 */
function DoneItem({ ids }: { ids: string[] }) {
  const a = useEmailActions();
  const state = useMail((s) =>
    ids.every((id) => s.resolved[id]) ? "done" : ids.length > 1 || bucketOf(s, ids[0]) === "needs_you" ? "open" : null,
  );
  if (!state) return null;
  return state === "done" ? (
    <ContextMenuItem onClick={() => a.notDone(ids)}>
      <Undo2 /> Not done
    </ContextMenuItem>
  ) : (
    <ContextMenuItem onClick={() => a.done(ids)}>
      <Check /> Done <ContextMenuShortcut>D</ContextMenuShortcut>
    </ContextMenuItem>
  );
}

/**
 * Open the ✦ Assistant pointed at these emails: one is opened (the assistant reads it as "this"),
 * several stay ticked ("these"). The cursor lands in the ask box.
 */
export function askAssistantAbout(ids: string[]) {
  const s = useMail.getState();
  if (ids.length === 1) {
    // Ticked rows would win as "these": one right-clicked email means just that one.
    if (s.checked.size && !(s.checked.size === 1 && s.checked.has(ids[0]))) s.clearChecked();
    if (s.selectedId !== ids[0]) s.select(ids[0]);
  }
  useAssistant.getState().askFocus();
}

export function EmailContextMenu({ email, children, className }: { email: Email; children: ReactNode; className?: string }) {
  const a = useEmailActions();
  const select = useMail((s) => s.select);
  const checked = useMail((s) => s.checked);
  const { sug, recent, path } = useMoveTargets(email);
  const first = email.from.name.split(/[\s(]/)[0];
  // Right-clicking one of several ticked rows acts on all of them.
  const bulk = checked.has(email.id) && checked.size > 1;
  const ids = bulk ? [...checked] : [email.id];

  if (bulk)
    return (
      <ContextMenu>
        <ContextMenuTrigger className={className}>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <ContextMenuGroup>
            <ContextMenuLabel>{ids.length} selected</ContextMenuLabel>
            <ContextMenuItem onClick={() => void a.archive(ids)}>
              <Archive /> Archive <ContextMenuShortcut>E</ContextMenuShortcut>
            </ContextMenuItem>
            <DoneItem ids={ids} />
            <ContextMenuItem onClick={() => askAssistantAbout(ids)}>
              <Sparkles className="text-primary" /> Ask Assistant about these…
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FolderIcon /> Move to
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-64">
              {recent.length > 0 && (
                <>
                  <ContextMenuGroup>
                    <ContextMenuLabel>Recent</ContextMenuLabel>
                    {recent.map((f) => (
                      <ContextMenuItem key={f.id} onClick={() => void a.move(ids, f.id)}>
                        <History /> <span className="truncate">{path(f.id)}</span>
                      </ContextMenuItem>
                    ))}
                  </ContextMenuGroup>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem onClick={() => a.pickFolder(ids)}>
                <Search /> Choose folder… <ContextMenuShortcut>V</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Clock /> Snooze
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-56">
              {snoozeTimes().map((t) => (
                <ContextMenuItem key={t.label} onClick={() => a.snooze(ids, t.at, t.label)}>
                  {t.label} <ContextMenuShortcut className="tracking-normal">{t.hint}</ContextMenuShortcut>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <BulkReadItem ids={ids} />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <WandSparkles /> Teach zMail: these are
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-56">
              {BUCKETS.map((b) => (
                <ContextMenuItem key={b} onClick={() => a.teach(ids, b)}>
                  <span className="size-2 rounded-full" style={{ background: `var(--bucket-${b})` }} />
                  {BUCKET_META[b].label}
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
              <SectionItems ids={ids} />
              <CategoryItems ids={ids} />
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => void a.spam(ids)}>
            <OctagonAlert /> Mark as spam <ContextMenuShortcut>!</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => void a.trash(ids)}>
            <Trash2 /> Delete {ids.length} <ContextMenuShortcut>⌫</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => useMail.getState().clearChecked()}>Clear selection</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );

  return (
    <ContextMenu>
      <ContextMenuTrigger className={className}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuItem onClick={() => select(email.id)}>
          <Mail /> Open
        </ContextMenuItem>
        <ContextMenuItem onClick={() => a.reply(email.id)}>
          <Reply /> Reply <ContextMenuShortcut>R</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => a.replyAll(email.id)}>
          <ReplyAll /> Reply all <ContextMenuShortcut>A</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => a.forward(email.id)}>
          <Forward /> Forward <ContextMenuShortcut>F</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => askAssistantAbout([email.id])}>
          <Sparkles className="text-primary" /> Ask Assistant about this… <ContextMenuShortcut>⌘J</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => a.replyAI(email.id)}>
          <Sparkles className="text-primary" /> Draft reply with AI <ContextMenuShortcut>⇧R</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void a.summarize(email)}>
          <Sparkles className="text-primary" /> Summarize
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            useMail.getState().openNewEvent({
              title: email.subject.replace(/^(re|fwd?):\s*/i, ""),
              attendees: [email.from.address, ...(email.cc ?? []).map((c) => c.address)].filter(Boolean),
            })
          }
        >
          <CalendarPlus /> Schedule a meeting…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void a.archive([email.id])}>
          <Archive /> Archive <ContextMenuShortcut>E</ContextMenuShortcut>
        </ContextMenuItem>
        <DoneItem ids={[email.id]} />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderIcon /> Move to
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-64">
            {sug && (
              <ContextMenuGroup>
                <ContextMenuLabel>Suggested</ContextMenuLabel>
                <ContextMenuItem onClick={() => void a.move([email.id], sug.folderId)}>
                  <WandSparkles /> <span className="truncate">{path(sug.folderId)}</span>
                  <ContextMenuShortcut className="tracking-normal">{sug.rule ? "rule" : `${Math.round(sug.probability * 100)}%`}</ContextMenuShortcut>
                </ContextMenuItem>
              </ContextMenuGroup>
            )}
            {recent.length > 0 && (
              <ContextMenuGroup>
                <ContextMenuLabel>Recent</ContextMenuLabel>
                {recent.map((f) => (
                  <ContextMenuItem key={f.id} onClick={() => void a.move([email.id], f.id)}>
                    <History /> <span className="truncate">{path(f.id)}</span>
                  </ContextMenuItem>
                ))}
              </ContextMenuGroup>
            )}
            {(sug || recent.length > 0) && <ContextMenuSeparator />}
            <ContextMenuItem onClick={() => a.pickFolder([email.id])}>
              <Search /> Choose folder… <ContextMenuShortcut>V</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Clock /> Snooze
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-56">
            {snoozeTimes().map((t) => (
              <ContextMenuItem key={t.label} onClick={() => a.snooze([email.id], t.at, t.label)}>
                {t.label} <ContextMenuShortcut className="tracking-normal">{t.hint}</ContextMenuShortcut>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={() => a.star(email.id)}>
          <Star /> {email.starred ? "Unstar" : "Star"} <ContextMenuShortcut>S</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => a.read([email.id], email.unread)}>
          {email.unread ? <MailOpen /> : <Mail />} Mark as {email.unread ? "read" : "unread"}
          <ContextMenuShortcut>U</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => a.pickRule(email.id)}>
          <UserRoundCheck /> Always file {first} in…
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <WandSparkles /> Teach zMail: this is
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-56">
            {BUCKETS.map((b) => (
              <ContextMenuItem key={b} onClick={() => a.teach([email.id], b)}>
                <span className="size-2 rounded-full" style={{ background: `var(--bucket-${b})` }} />
                {BUCKET_META[b].label}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <SectionItems ids={[email.id]} />
            <CategoryItems ids={[email.id]} />
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void a.spam([email.id])}>
          <OctagonAlert /> Mark as spam
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={() => void a.trash([email.id])}>
          <Trash2 /> Delete <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---- hover quick actions ----------------------------------------------------------

function QA({ tip, onClick, children, danger }: { tip: string; onClick?: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={tip}
            onClick={(e) => {
              e.stopPropagation();
              onClick?.();
            }}
            className={cn(
              "grid size-7 place-items-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/[0.07] hover:text-foreground [&_svg]:size-[15px]",
              danger && "hover:text-destructive",
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  );
}

const menuTrigger =
  "grid size-7 place-items-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/[0.07] hover:text-foreground data-popup-open:bg-foreground/[0.07] [&_svg]:size-[15px]";

export function QuickActions({ email, compact }: { email: Email; compact?: boolean }) {
  const a = useEmailActions();
  const [open, setOpen] = useState<string | null>(null);
  const needs = useMail((s) => isInbox(s, email) && inNeedsYou(s, email));

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      data-open={open ? "" : undefined}
      className="quick-actions pointer-events-none absolute top-1/2 right-2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-lg border border-hairline bg-[var(--pane)] p-0.5 opacity-0 shadow-sm transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 data-open:pointer-events-auto data-open:opacity-100"
    >
      {needs && (
        <QA tip="Done (D)" onClick={() => a.done([email.id])}>
          <Check />
        </QA>
      )}
      {!compact && (
        <QA tip="Reply" onClick={() => a.reply(email.id)}>
          <Reply />
        </QA>
      )}
      <QA tip="Archive · E" onClick={() => void a.archive([email.id])}>
        <Archive />
      </QA>
      <QA tip="Move · V" onClick={() => a.pickFolder([email.id])}>
        <FolderIcon />
      </QA>
      {!compact && (
        <DropdownMenu onOpenChange={(o) => setOpen(o ? "snooze" : null)}>
          <DropdownMenuTrigger aria-label="Snooze" className={menuTrigger}>
            <BellOff />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {snoozeTimes().map((t) => (
              <DropdownMenuItem key={t.label} onClick={() => a.snooze([email.id], t.at, t.label)}>
                {t.label} <span className="ml-auto text-xs text-muted-foreground">{t.hint}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <QA tip="Delete" danger onClick={() => void a.trash([email.id])}>
        <Trash2 />
      </QA>
    </div>
  );
}
