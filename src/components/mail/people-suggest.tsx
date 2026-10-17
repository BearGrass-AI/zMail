// @mentions in the Draft with AI box, and autocomplete for To/Cc fields.
// People come from the M365 directory, Google contacts and your own mail.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { keepInPlace, rankPeople, searchRemotePeople, searchesRemote, type Person } from "@/lib/contacts";
import { useMail } from "@/lib/store";
import type { Account } from "@/lib/types";
import { cn } from "@/lib/utils";

export type Mention = Person & { role: "to" | "cc" };

/** One shared empty list, so callers comparing by identity don't see a change on every render. */
const NO_PEOPLE: Person[] = [];

/** How long typing pauses before the directories are asked. Your own mail's people show at once. */
export const REMOTE_DEBOUNCE_MS = 150;

/**
 * People search; null query means closed. People from your mail match on every keystroke with no
 * wait; directory and contacts results (debounced) merge in when they arrive. Until then the last
 * answer's people are re-ranked against what's typed now, so they don't blink out per keystroke.
 */
export function usePeopleSearch(query: string | null) {
  const accounts = useMail((s) => s.accounts);
  const emails = useMail((s) => s.emails);
  const [remote, setRemote] = useState<{ query: string; accounts: Account[]; lists: Person[][] } | null>(null);
  // Closing clears the directory results so reopening starts fresh.
  if (query === null && remote) setRemote(null);
  useEffect(() => {
    if (query === null || !searchesRemote(query)) return;
    // Only the latest query's answer lands: typing on (or closing) retires this one.
    let current = true;
    const t = setTimeout(() => {
      searchRemotePeople(query, accounts)
        .catch(() => [])
        .then((lists) => current && setRemote({ query, accounts, lists }));
    }, REMOTE_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [query, accounts]);
  const lists = remote && remote.accounts === accounts ? remote.lists : undefined;
  const people = useMemo(() => (query === null ? NO_PEOPLE : rankPeople(query, accounts, emails, lists)), [query, accounts, emails, lists]);
  const loading = query !== null && searchesRemote(query) && (remote?.query !== query || remote.accounts !== accounts);
  return { people, loading };
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

function PeopleList({ people, active, loading, onPick, onHover }: { people: Person[]; active: number; loading: boolean; onPick: (p: Person) => void; onHover: (i: number) => void }) {
  if (!people.length && !loading) return null;
  return (
    <div role="listbox" className="absolute top-full right-0 left-0 z-40 mt-1.5 overflow-hidden rounded-xl bg-popover p-1 text-left shadow-lg ring-1 ring-foreground/10">
      {!people.length && (
        <div className="flex h-9 items-center gap-2 px-2.5 text-[12px] text-foreground/45">
          <Loader2 className="size-3.5 animate-spin" /> Searching people…
        </div>
      )}
      {people.map((p, i) => (
        <button
          key={p.address}
          type="button"
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(p)}
          className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left", i === active && "bg-foreground/[0.07]")}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-[10.5px] font-semibold text-primary">{initials(p.name)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">
              {p.name}
              {(p.title || p.department) && (
                <span className="font-normal text-foreground/45"> · {[p.title, p.department].filter(Boolean).join(", ")}</span>
              )}
            </span>
            <span className="block truncate text-[11.5px] text-foreground/45">{p.address}</span>
          </span>
          {p.source === "directory" && <span className="shrink-0 text-[10px] font-medium tracking-wide text-foreground/35 uppercase">Directory</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * The open suggestion list and its keyboard handling (onKey returns true when it consumed the key).
 * A new query starts at the top; more results for the same query re-rank around the highlighted
 * row, so Enter never picks someone who just slid under it.
 */
function useListKeys(found: Person[], query: string | null, onPick: (p: Person) => void, onClose: () => void) {
  const [list, setList] = useState({ found, query, people: found, active: 0 });
  let cur = list;
  if (list.found !== found) {
    const same = list.query === query;
    const people = same ? keepInPlace(list.people, found, list.active) : found;
    cur = { found, query, people, active: same ? Math.min(list.active, Math.max(people.length - 1, 0)) : 0 };
    setList(cur);
  }
  const { people, active } = cur;
  const setActive = (next: number | ((a: number) => number)) =>
    setList((l) => ({ ...l, active: typeof next === "function" ? next(l.active) : next }));
  const onKey = (e: KeyboardEvent) => {
    if (!people.length) return e.key === "Escape" ? (onClose(), true) : false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : people.length - 1)) % people.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      onPick(people[active]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return true;
    }
    return false;
  };
  return { people, active, setActive, onKey };
}

/** The @query being typed just before the caret, if any. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|\s)@([^@\n]{0,40})$/.exec(text.slice(0, caret));
  if (!m || /^\s|\s{2,}$/.test(m[1])) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

/** Mentions still present in the text, in order of appearance. */
export function activeMentions(text: string, mentions: Mention[]): Mention[] {
  return mentions.filter((m) => text.includes(`@${m.name}`)).sort((a, b) => text.indexOf(`@${a.name}`) - text.indexOf(`@${b.name}`));
}

/** "@Scott Hollis" → "Scott Hollis" for the model's instruction. */
export const stripMentions = (text: string, mentions: Mention[]) => mentions.reduce((t, m) => t.split(`@${m.name}`).join(m.name), text);

export function MentionInput({
  value,
  onChange,
  mentions,
  onMentionsChange,
  onSubmit,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  mentions: Mention[];
  onMentionsChange: (m: Mention[]) => void;
  onSubmit: () => void;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const mentionSearch = trigger && trigger.query.length >= 1 ? trigger.query : null;
  const { people: found, loading } = usePeopleSearch(mentionSearch);

  // Grow with the text.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  // A finished mention ("@Jen Alvarez ") isn't a new search.
  const sync = (text: string, caret: number) => {
    const t = mentionQuery(text, caret);
    setTrigger(t && !mentions.some((m) => t.query.startsWith(m.name)) ? t : null);
  };

  const pick = (p: Person) => {
    if (!trigger) return;
    const before = value.slice(0, trigger.start);
    const after = value.slice(trigger.start + 1 + trigger.query.length);
    const role: Mention["role"] = /\bcc:?\s*$/i.test(before) ? "cc" : "to";
    const token = `@${p.name}`;
    const next = `${before}${token} ${after.replace(/^\s+/, "")}`;
    onChange(next);
    onMentionsChange([...mentions.filter((m) => m.address !== p.address), { ...p, role }]);
    setTrigger(null);
    const caret = before.length + token.length + 1;
    requestAnimationFrame(() => ref.current?.setSelectionRange(caret, caret));
  };

  const list = useListKeys(found, mentionSearch, pick, () => setTrigger(null));

  // Mirror behind the textarea paints the mention highlights.
  const live = activeMentions(value, mentions);
  const parts: { text: string; mention?: Mention }[] = [];
  let rest = value;
  while (rest) {
    const hits = live.map((m) => ({ m, i: rest.indexOf(`@${m.name}`) })).filter((h) => h.i >= 0).sort((a, b) => a.i - b.i);
    if (!hits.length) {
      parts.push({ text: rest });
      break;
    }
    const { m, i } = hits[0];
    if (i) parts.push({ text: rest.slice(0, i) });
    parts.push({ text: `@${m.name}`, mention: m });
    rest = rest.slice(i + m.name.length + 1);
  }

  const box = "col-start-1 row-start-1 w-full px-0 py-1 text-[14px] leading-[22px] whitespace-pre-wrap break-words";

  return (
    <div className="relative grid flex-1">
      <div aria-hidden className={cn(box, "pointer-events-none text-transparent")}>
        {parts.map((p, i) =>
          p.mention ? (
            <span key={i} className={cn("rounded-[5px] shadow-[0_0_0_2px]", p.mention.role === "cc" ? "bg-foreground/10 shadow-foreground/10" : "bg-primary/20 shadow-primary/20")}>
              {p.text}
            </span>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
        {"​"}
      </div>
      <textarea
        ref={ref}
        rows={1}
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          sync(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => sync(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setTrigger(null)}
        onKeyDown={(e) => {
          if (trigger && list.onKey(e)) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className={cn(box, "selectable resize-none overflow-hidden bg-transparent outline-none placeholder:text-foreground/35")}
      />
      {mentionSearch && <PeopleList people={list.people} active={list.active} loading={loading} onPick={pick} onHover={list.setActive} />}
    </div>
  );
}

/** A To/Cc field: comma-separated addresses with autocomplete on the one being typed. */
export function AddressInput({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  const segStart = Math.max(value.lastIndexOf(","), value.lastIndexOf(";")) + 1;
  const query = value.slice(segStart).trim();
  const search = open && query.length >= 1 && !/@\S+\.\S+$/.test(query) ? query : null;
  const { people: found, loading } = usePeopleSearch(search);

  const pick = (p: Person) => {
    const before = value.slice(0, segStart).trim();
    onChange(`${before ? `${before} ` : ""}${p.address}, `);
    setOpen(false);
  };
  const list = useListKeys(found, search, pick, () => setOpen(false));

  return (
    <div className="relative flex-1">
      <input
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (open && list.people.length) list.onKey(e);
        }}
        className="selectable w-full bg-transparent outline-none"
      />
      {open && query && <PeopleList people={list.people} active={list.active} loading={loading} onPick={pick} onHover={list.setActive} />}
    </div>
  );
}
