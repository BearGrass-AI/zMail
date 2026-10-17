# Assistant Slash Commands, Citations, Auto-Rules and Unsubscribe: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/` command menu with chips to the ✦ Assistant, cited answers with a Sources list, assistant-proposed automatic rules, and List-Unsubscribe support.

**Architecture:**
- Pure logic lives in small new modules: `commands.ts`, `rules.ts` and `unsubscribe.ts`, plus ref helpers in the assistant state. Each is unit-tested.
- The assistant loop gains a `display` option, so the chat shows the chip and the user's text while the model receives the expanded prompt.
- Citations are short per-conversation refs (`m1`, `m2`, …) that tools attach to the email rows they show the model. A post-sanitize Markdown pass turns them into buttons.
- Rules run inside the store's sync path, before triage.
- Unsubscribe reads fresh headers via `provider.getMessage`.

**Tech Stack:** Tauri 2, React 19, TypeScript, Zustand v5, Tailwind v4, lucide-react, sonner, marked + DOMPurify, Vitest/jsdom, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-11-assistant-slash-commands-design.md`

## Global Constraints

- **Branch:** work on `main` and commit directly. No push, no branches. Leave the untracked `inspirational_ideas/` and `zMail_icon/` alone.
- **Checks before every commit:**
  - `npx tsc --noEmit -p .` is clean.
  - `npx vitest run` passes.
  - A dev server is already running. Don't start or stop it.
- **Zustand v5:** selectors must not return new objects or arrays. Derive with `useMemo`.
- **Scope:** change only the files a task names, plus their tests. Don't restyle unrelated UI.
- **No send tool:** the assistant has no send tool. The only email these features send is the user-confirmed mailto unsubscribe.
- **Untrusted input:**
  - Model-supplied strings never index objects except through `Object.hasOwn`. Use the existing `own()` in `tools.ts`.
  - Header URLs are untrusted. Only `https:` is ever fetched. Only `https:` and `mailto:` are ever opened.
- **Secrets:** never put API keys or tokens in localStorage. Don't use real accounts or real model keys in tests. Tests use fakes; browser checks use the mock (demo) provider.
- **No provider categories:** Gmail tabs, `CATEGORY_*` labels and Outlook Focused are never used as signals.
- **Subagents:** implementers never dispatch other subagents.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Retry after a slash command.** Retry must resend the *expanded* prompt and keep the chip bubble. It must not duplicate the user item or fail because the item's text no longer matches. Snapshots saved before this change, where `error.retry` holds message text, must still retry.
2. **Unknown or invented citation refs.** `[m99]` (unknown), `[m1]` inside a code span, and a reply with no citations must render as today: no stray markers, no empty Sources list.
3. **An auto-rule firing on old or unrelated mail.** It must skip mail received before the rule was created, mail outside an Inbox, partial header rows, and a domain rule's look-alike domains (`notamazon.com` must not match `amazon.com`, while `email.amazon.com` must).
4. **The slash menu and the Enter key.** Enter while the menu is open picks the item and doesn't send. With IME composition (`isComposing`/229), Enter is ignored. Esc closes the menu without clearing the text. Backspace on empty text removes the chip.
5. **Hostile List-Unsubscribe values.**
   - `http://`, `javascript:`, multiple `<…>` entries, whitespace and line folding, a mailto with `subject` and `body` query parts.
   - Only `https` gets POSTed or opened.
   - A mailto send uses only the header's address and subject, never model text.

---

### Task 1: Command registry and pure helpers

**Files:**
- Create: `src/lib/ai/assistant/commands.ts`
- Test: `src/lib/__tests__/assistant-commands.test.ts`

**Interfaces:**
- **Produces:**
  - `SlashCommand`
  - `COMMANDS: SlashCommand[]`
  - `matchCommands(prefix: string, ctx: { hasOpenEmail: boolean }): SlashCommand[]`
  - `findCommand(name: string): SlashCommand | undefined`
  - `parseSlash(text: string): { command: SlashCommand; arg: string } | null`
  - `senderSuggestions(emails: Email[], query: string, limit?: number): SenderSuggestion[]`
  - `SenderSuggestion = { value: string; label: string; count: number; kind: "domain" | "address" }`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/__tests__/assistant-commands.test.ts
import { describe, expect, it } from "vitest";
import type { Email } from "@/lib/types";
import { COMMANDS, findCommand, matchCommands, parseSlash, senderSuggestions } from "@/lib/ai/assistant/commands";

const mk = (id: string, name: string, address: string, partial = false) =>
  ({ id, accountId: "a", threadId: id, folderId: "a:inbox", from: { name, address }, to: [], subject: "s", snippet: "", text: "", date: "2026-10-01T00:00:00Z", unread: false, starred: false, labels: [], ...(partial ? { partial: true } : {}) }) as Email;

describe("commands", () => {
  it("lists the starting set in menu order", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(["breakdown", "cleanup", "unsubscribe", "find", "summarize", "reply", "schedule", "clear"]);
  });

  it("filters by prefix and hides email commands with nothing open", () => {
    expect(matchCommands("cl", { hasOpenEmail: false }).map((c) => c.name)).toEqual(["cleanup", "clear"]);
    expect(matchCommands("", { hasOpenEmail: false }).some((c) => c.group === "email")).toBe(false);
    expect(matchCommands("su", { hasOpenEmail: true }).map((c) => c.name)).toEqual(["summarize"]);
    expect(matchCommands("/BR", { hasOpenEmail: false }).map((c) => c.name)).toEqual(["breakdown"]);
  });

  it("parses typed commands with or without a colon", () => {
    expect(parseSlash("/breakdown amazon")).toMatchObject({ command: { name: "breakdown" }, arg: "amazon" });
    expect(parseSlash("/breakdown: Amazon.com ")).toMatchObject({ command: { name: "breakdown" }, arg: "Amazon.com" });
    expect(parseSlash("/summarize")).toMatchObject({ command: { name: "summarize" }, arg: "" });
    expect(parseSlash("/nope hi")).toBeNull();
    expect(parseSlash("hello /find x")).toBeNull();
    expect(parseSlash("/new")).toMatchObject({ command: { name: "clear" } });
  });

  it("expands prompts with the user's text and keeps /clear local", () => {
    expect(findCommand("breakdown")!.expand("amazon")).toContain("amazon");
    expect(findCommand("find")!.expand("what did Jen say")).toContain("what did Jen say");
    expect(findCommand("find")!.expand("x")).toContain("[mN]");
    expect(findCommand("clear")!.local).toBe("clear");
  });

  it("suggests domains then addresses, with counts, from full emails only", () => {
    const emails = [
      mk("1", "Amazon.com", "ship@amazon.com"),
      mk("2", "Amazon.com", "ship@amazon.com"),
      mk("3", "Amazon Deals", "deals@amazon.com"),
      mk("4", "AWS", "no-reply@aws.amazon.com"),
      mk("5", "Amanda Lee", "amanda@example.org"),
      mk("6", "Ghost", "ghost@amazon.com", true),
    ];
    const s = senderSuggestions(emails, "am");
    expect(s[0]).toEqual({ value: "amazon.com", label: "amazon.com", count: 3, kind: "domain" });
    expect(s.find((x) => x.value === "amanda@example.org")).toMatchObject({ label: "Amanda Lee", count: 1, kind: "address" });
    expect(s.find((x) => x.value === "aws.amazon.com")).toMatchObject({ count: 1, kind: "domain" });
    expect(senderSuggestions(emails, "")).toEqual([]);
    expect(senderSuggestions(emails, "am", 2)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run `npx vitest run src/lib/__tests__/assistant-commands.test.ts`. They should fail because the module isn't found.

- [ ] **Step 3: Implement**

```ts
// src/lib/ai/assistant/commands.ts
// Slash commands for the assistant input: a curated prompt per command. The chat
// shows the chip and what the user typed; the model gets expand(arg).

import type { Email } from "@/lib/types";

export interface SlashCommand {
  name: string;
  group: "mail" | "email";
  description: string;
  arg: "sender" | "text" | "none";
  placeholder?: string;
  local?: "clear";
  expand(arg: string): string;
}

const CITE = "Cite each statement that comes from an email as [mN] using the ref from tool output.";

export const COMMANDS: SlashCommand[] = [
  {
    name: "breakdown",
    group: "mail",
    description: "Categorize & count",
    arg: "sender",
    placeholder: "sender, topic or folder…",
    expand: (a) =>
      `Break down my email matching: ${a || "my inbox"}. Search for it (the inbox unless I named a folder or said all mail), then break_down by kind, and by sender if there are several senders. Answer with a short table of counts and one sentence with the takeaway.`,
  },
  {
    name: "cleanup",
    group: "mail",
    description: "Find it, then trash or archive",
    arg: "sender",
    placeholder: "sender or kind of email…",
    expand: (a) =>
      `Clean up my email matching: ${a}. Search for it, show a breakdown by kind, then use act to propose moving the bulk mail to Trash (archive instead for mail from real people). After the action is done, call propose_rule for new mail like it, and call check_unsubscribe if it comes from a bulk sender.`,
  },
  {
    name: "unsubscribe",
    group: "mail",
    description: "Stop a sender for good",
    arg: "sender",
    placeholder: "sender…",
    expand: (a) => `Unsubscribe me from ${a}. Call check_unsubscribe for that sender. Then offer to clean up the mail from it that's already here.`,
  },
  {
    name: "find",
    group: "mail",
    description: "Answer with the emails it came from",
    arg: "text",
    placeholder: "a question about your mail…",
    expand: (a) =>
      `Answer from my email: ${a}\nSearch as needed and read the most relevant emails. Answer in one to four sentences. ${CITE} If nothing you read supports an answer, say so plainly instead of guessing.`,
  },
  {
    name: "summarize",
    group: "email",
    description: "Summarize this thread",
    arg: "none",
    expand: () => `Summarize the email I have open (call current_view, then read_email). Give the key points, anything asked of me, and any dates. ${CITE}`,
  },
  {
    name: "reply",
    group: "email",
    description: "Draft a reply",
    arg: "text",
    placeholder: "what to say…",
    expand: (a) => `Draft a reply to the email I have open (call current_view first). Instructions: ${a || "a short, friendly reply"}.`,
  },
  {
    name: "schedule",
    group: "email",
    description: "Add it to my calendar",
    arg: "none",
    expand: () => "Find the meeting, event or date in the email I have open (call current_view, then read_email) and propose it with create_event.",
  },
  { name: "clear", group: "mail", description: "Start a new conversation", arg: "none", local: "clear", expand: () => "" },
];

const ALIASES: Record<string, string> = { new: "clear" };

export function findCommand(name: string): SlashCommand | undefined {
  const n = name.toLowerCase();
  return COMMANDS.find((c) => c.name === (ALIASES[n] ?? n));
}

export function matchCommands(prefix: string, ctx: { hasOpenEmail: boolean }): SlashCommand[] {
  const p = prefix.replace(/^\//, "").toLowerCase();
  return COMMANDS.filter((c) => (c.group === "mail" || ctx.hasOpenEmail) && c.name.startsWith(p));
}

/** "/name arg" or "/name: arg" at the very start. Unknown names are not commands. */
export function parseSlash(text: string): { command: SlashCommand; arg: string } | null {
  const m = /^\/([a-z]+):?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const command = findCommand(m[1]);
  return command ? { command, arg: (m[2] ?? "").trim() } : null;
}

export interface SenderSuggestion {
  value: string;
  label: string;
  count: number;
  kind: "domain" | "address";
}

/** Senders and domains from local mail matching a prefix of the domain, address or name. Domains rank first. */
export function senderSuggestions(emails: Email[], query: string, limit = 6): SenderSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const domains = new Map<string, number>();
  const addresses = new Map<string, { name: string; count: number }>();
  for (const e of emails) {
    if (e.partial) continue;
    const addr = e.from.address.toLowerCase();
    const domain = addr.split("@")[1];
    if (domain) domains.set(domain, (domains.get(domain) ?? 0) + 1);
    const a = addresses.get(addr);
    if (a) a.count++;
    else addresses.set(addr, { name: e.from.name.trim(), count: 1 });
  }
  const starts = (s: string) => s.toLowerCase().split(/[\s.@]+/).some((w) => w.startsWith(q)) || s.toLowerCase().startsWith(q);
  const d: SenderSuggestion[] = [...domains].filter(([k]) => starts(k)).map(([k, count]) => ({ value: k, label: k, count, kind: "domain" }));
  const a: SenderSuggestion[] = [...addresses]
    .filter(([k, v]) => starts(k) || starts(v.name))
    .map(([k, v]) => ({ value: k, label: v.name || k, count: v.count, kind: "address" }));
  const byCount = (x: SenderSuggestion, y: SenderSuggestion) => y.count - x.count || x.value.localeCompare(y.value);
  return [...d.sort(byCount), ...a.sort(byCount)].slice(0, limit);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx vitest run src/lib/__tests__/assistant-commands.test.ts`. They should pass. Then run `npx tsc --noEmit -p .`.

- [ ] **Step 5: Commit** with the message `Assistant: slash command registry, parsing and sender suggestions`.

---

### Task 2: Loop and chat support for slash commands (display text, retry by id)

**Files:**
- Modify:
  - `src/lib/ai/assistant/state.ts`: the `Item` user/error variants, `submitAction`
  - `src/lib/ai/assistant/loop.ts`: `ask`, `retry`
  - `src/components/assistant/message-item.tsx`: the user bubble and the error Retry button
- Test: `src/lib/__tests__/assistant-loop.test.ts`, `src/lib/__tests__/assistant-state.test.ts`

**Interfaces:**
- **Consumes:** `parseSlash` and `findCommand` from Task 1.
- **Produces:**
  - `Item` user variant: `{ id; kind: "user"; text: string; display?: { command: string; text: string } }`. `text` is what the model gets.
  - `Item` error variant: `retry?: string`. It now holds the **user item id**. Old snapshots stored message text there.
  - `ask(text, deps?, provider?, opts?: { retrying?: boolean; display?: { command: string; text: string } })`
  - `retry(userItemIdOrText: string, deps?, provider?)`
  - `submitAction(text, busy, clearing?)` returns `"clear"` for `/clear` and `/new`, and also for `parseSlash(text)?.command.local === "clear"`.
  - `UserChip` component exported from `message-item.tsx`: `({ name }: { name: string }) => JSX`.

**Requirements:**
1. **`ask`:**
   - Pushes `{kind:"user", text, ...(opts.display ? {display} : {})}` and keeps its id as `userId`.
   - Every error item it pushes uses `retry: userId`. A retrying ask reuses the existing user item id: `retry` passes it through as `opts.userId`, an internal option that may be added.
   - History gets `text`, the expansion, exactly as today, including the notes prefix.
2. **`retry(key)`:**
   - Find the user item: first by `id === key`, then fall back to the last user item with `text === key`, for old snapshots.
   - Find the history message to cut: the last `role:"user"` message whose content ends with that item's `text`.
   - Remove error items whose `retry` equals the key or the item's id.
   - Keep the bulk cards that follow it, as today.
   - Call `ask(item.text, deps, provider, { retrying: true, display: item.display, userId: item.id })`.
   - When no user item is found, keep today's behaviour of cutting history and dropping the error.
3. **User bubble in `message-item.tsx`:**
   - When `item.display` is set, render `<UserChip name={display.command} />` followed by `display.text`. Otherwise render `item.text`.
   - `UserChip`: monospace, 11px, `rounded-md px-1.5 py-px font-semibold`. Background `bg-white/15` on the primary bubble, text inherited. Content is `/{name}`.
4. **Copy button:** copies `/${display.command} ${display.text}` for display items.
5. **Error Retry button:** calls `retry(item.retry)` and is unchanged otherwise.

- [ ] **Step 1: Write the failing tests.** Add them to `assistant-loop.test.ts`, reusing its `scripted`, `tool` and `deps` helpers:

```ts
it("a slash command shows its chip but sends the expansion", async () => {
  const seen: unknown[] = [];
  const provider = { chat: async (_s: string, h: unknown[]) => (seen.push(structuredClone(h)), { text: "ok", toolCalls: [] }) };
  await ask("EXPANDED PROMPT", deps, provider as never, { display: { command: "breakdown", text: "amazon" } });
  const user = useAssistant.getState().items.find((i) => i.kind === "user")!;
  expect(user).toMatchObject({ text: "EXPANDED PROMPT", display: { command: "breakdown", text: "amazon" } });
  expect(JSON.stringify(seen[0])).toContain("EXPANDED PROMPT");
});

it("retry by user item id resends the expansion and keeps one chip bubble", async () => {
  const failing = { chat: async () => { throw new Error("boom"); } };
  await ask("EXPANDED", deps, failing as never, { display: { command: "find", text: "q" } });
  const err = useAssistant.getState().items.find((i) => i.kind === "error")!;
  const userId = useAssistant.getState().items.find((i) => i.kind === "user")!.id;
  expect(err).toMatchObject({ retry: userId });
  const seen: string[] = [];
  await retry(userId, deps, { chat: async (_s: string, h: { role: string; content: string }[]) => (seen.push(h.filter((m) => m.role === "user").map((m) => m.content).join("|")), { text: "ok", toolCalls: [] }) } as never);
  const users = useAssistant.getState().items.filter((i) => i.kind === "user");
  expect(users).toHaveLength(1);
  expect(users[0]).toMatchObject({ display: { command: "find" } });
  expect(seen[0]).toBe("EXPANDED");
  expect(useAssistant.getState().items.some((i) => i.kind === "error")).toBe(false);
});

it("retry still works with an old snapshot's text-keyed error", async () => {
  useAssistant.setState({ items: [{ id: "u1", kind: "user", text: "hello" }, { id: "e1", kind: "error", text: "x", retry: "hello" }], history: [{ role: "user", content: "hello" }] });
  await retry("hello", deps, { chat: async () => ({ text: "ok", toolCalls: [] }) } as never);
  expect(useAssistant.getState().items.filter((i) => i.kind === "user")).toHaveLength(1);
  expect(useAssistant.getState().items.some((i) => i.kind === "error")).toBe(false);
});
```

Add this to `assistant-state.test.ts`:

```ts
it("treats a typed /clear-family command as clear", () => {
  expect(submitAction("/new", true)).toBe("clear");
  expect(submitAction("/clear", false)).toBe("clear");
  expect(submitAction("/find x", true)).toBe("ignore");
});
```

Existing tests that call `retry(text)` and assert `retry: text` on error items must be updated to the id behaviour. Keep their intent.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npx vitest run src/lib/__tests__/assistant-loop.test.ts src/lib/__tests__/assistant-state.test.ts`.
- [ ] **Step 3: Implement** Requirements 1–5.
- [ ] **Step 4: Run the full suite and tsc.** Both must be green.
- [ ] **Step 5: Commit** with the message `Assistant: commands show a chip, send the expanded prompt, retry by message id`.

---

### Task 3: Slash menu, chip input and sender suggestions in the panel

**Files:**
- Create: `src/components/assistant/slash-menu.tsx`
- Modify: `src/components/assistant/assistant-panel.tsx`
- Test: `src/lib/__tests__/assistant-commands.test.ts`. Add tests for the `inputKeyAction` reducer below.

**Interfaces:**
- **Consumes:**
  - Task 1: `matchCommands`, `parseSlash`, `senderSuggestions`, `SlashCommand`.
  - Task 2: `ask(…, { display })` and `UserChip`.
- **Produces:** `inputKeyAction(key, state)` in `commands.ts`, a pure key reducer so the keyboard logic is testable.

```ts
export type MenuItem = { type: "command"; command: SlashCommand } | { type: "sender"; s: SenderSuggestion };
export interface InputState { chip: SlashCommand | null; text: string; menu: { items: MenuItem[]; active: number } | null; composing: boolean }
/** What a key does. "none" lets the textarea handle it. */
export function inputKeyAction(key: string, st: InputState, shift = false):
  | { do: "move"; active: number }
  | { do: "pick"; item: MenuItem }
  | { do: "close" }
  | { do: "remove_chip" }
  | { do: "send" }
  | { do: "none" };
```

Reducer rules:
- While `composing`, every key is `none`.
- With the menu open:
  - ArrowDown/ArrowUp move `active`, wrapping around.
  - Tab, or Enter without Shift, picks `items[active]`.
  - Escape closes the menu.
- With the menu closed:
  - Enter without Shift sends.
  - Backspace removes the chip when `chip` is set and `text === ""`.
- Everything else is `none`.

Tests: move and wrap; Enter picks rather than sends while the menu is open; Enter sends with the menu closed; composing makes Enter `none`; Escape closes; Backspace removes the chip only when the text is empty.

**Panel behaviour, in `assistant-panel.tsx`:**
- **State:** add `chip: SlashCommand | null` and `menuActive: number`. Keep `text`.
- **Menu items** are derived with `useMemo`:
  - No chip and `text` starts with `/` with no whitespace yet: commands from `matchCommands(text, { hasOpenEmail })`. `hasOpenEmail` comes from the selector `useMail((s) => !!s.selectedId)`.
  - Chip with `arg === "sender"` and non-empty text: `senderSuggestions(emails, text)`. Read `emails` with `useMail((s) => s.emails)`, which is a stable reference.
  - Otherwise none.
  - The menu shows when there are items and it hasn't been dismissed with Esc. Reset the dismissal when the text changes.
- **Picking:**
  - A command with `local === "clear"`: run `clearChat()` and reset the input.
  - Any other command: set the chip, set the text to `""`, focus the textarea.
  - A sender: set the text to the suggestion's `value`.
- **Sending:**
  - With a chip: `ask(chip.expand(text.trim()), undefined, undefined, { display: { command: chip.name, text: text.trim() } })`.
  - Without a chip, use `parseSlash(text)`:
    - a local command clears;
    - a model command sends with display;
    - no match sends the plain text as today.
  - Commands with `arg !== "none"` and empty text don't send. The send button is disabled in that case.
  - Busy and clearing rules are unchanged. /clear always works.
- **Chip in the input:** render `<UserChip>`-style styling inside the input row, in primary-tinted colors (`bg-primary/15 text-primary`), before the textarea. The textarea placeholder becomes `chip.placeholder` while a chip is set. Otherwise it's `Ask about your mail… (/ for commands)`, or `Clearing…` while clearing.
- **Menu (`slash-menu.tsx`):**
  - Absolutely positioned above the input box, full input width, `max-h-72 overflow-y-auto`.
  - Pane style: `rounded-xl bg-pane-2 shadow-lg ring-1 ring-hairline`.
  - Group headings: "Your mail" and "This email" for commands, "Senders" for suggestions. Each heading is uppercase, 9.5px, muted.
  - Command rows: monospace bold `/name`, then the muted description. Sender rows: the label, then a muted count ("412 emails") and the address when it differs from the label.
  - The active row is `bg-primary/12`, with text in `text-primary` for the command name.
  - Footer: `↑↓ choose · Tab or ↵ pick · Esc close`.
  - Mouse: hover sets active, and click picks. Use `onMouseDown` with `preventDefault` so the textarea keeps focus.
  - `role="listbox"` and `aria-activedescendant` on the textarea; `role="option"` and `aria-selected` on rows.
- Keep the existing auto-grow, IME handling and focus behaviour.

- [ ] **Step 1:** Write the failing reducer tests and run them to watch them fail.
- [ ] **Step 2:** Implement `inputKeyAction` and run the tests until they pass.
- [ ] **Step 3:** Implement the menu and the panel wiring. Run tsc and the full suite.
- [ ] **Step 4: Commit** with the message `Assistant: slash command menu with chips and sender suggestions`.

The controller verifies this task in the browser preview with the demo account.

---

### Task 4: Citations: refs on tool rows, rendering, Sources list

**Files:**
- Modify:
  - `src/lib/ai/assistant/state.ts`: refs state, `refFor`, `newChat`, persistence
  - `src/lib/ai/assistant/tools.ts`: add refs in `search_mail` sample rows, `read_email` and `current_view`
  - `src/lib/ai/assistant/prompts.ts`: the citation rule
  - `src/lib/ai/assistant/markdown.ts`: `renderMarkdown(text, refs?)`
  - `src/components/assistant/message-item.tsx`: citations, the Sources list, clicks, copy
  - `src/index.css`: `.assistant-md .cite` styles
- Test: `src/lib/__tests__/assistant-markdown.test.ts`, `src/lib/__tests__/assistant-tools.test.ts`, `src/lib/__tests__/assistant-state.test.ts`

**Interfaces:**
- **Produces:**
  - `RefInfo = { id: string; accountId: string; from: string; subject: string; date: string }` (date is YYYY-MM-DD).
  - In `useAssistant`:
    - `refs: Record<string, RefInfo>` and `refSeq: number`.
    - `refFor(e: Email): string` returns the existing ref for `e.id` or assigns `m${++refSeq}`.
    - `newChat` resets `refs` to `{}` and `refSeq` to `0`.
    - `AssistantSnapshot` gains `refs?` and `refSeq?`, saved and restored with defaults `{}` and `0`.
  - `rowFor(e, folders, ref?)` adds `ref` when given. `search_mail` samples, `current_view` open/checked, and `read_email` (the `ref` field next to `id`) all pass `st.refFor(e)`.
  - `renderMarkdown(text: string, refs?: Record<string, RefInfo>): { html: string; cited: string[] }`. **Return type changes.** Update every caller (`message-item.tsx` and the tests). `cited` lists the refs in order of first appearance.

**Rendering rules (in `polish`, after sanitizing):**
- Walk the text nodes under the root, skipping any inside `code` or `pre`.
- Match `/\[(m\d+)\]/g`. When the ref is a key of `refs` (checked with `Object.hasOwn`), replace the token with `<button type="button" class="cite" data-ref="mN">n</button>`, where `n` is the 1-based position of `mN` in `cited`. Otherwise remove the token.
- The class hook must not strip these. They're created after the sanitize step, so no allowlist change is needed. Don't add `cite` to the sanitizer.
- With no `refs` argument, any `[mN]` tokens are removed.

**Prompt rule** (append to `systemPrompt`):
`- When a statement comes from a specific email, cite it right after the statement as [mN] using that email's ref from tool output (for example [m3]). Never invent refs. If nothing you read supports an answer, say so.`

**`message-item.tsx`:**
- `AssistantText` reads refs with `useAssistant((s) => s.refs)`, which is a stable reference per change, and renders `renderMarkdown(text, refs)`.
- When `cited.length > 0`, render a **Sources** block under the text. Each row shows the number, the sender, the subject (truncated) and the date in the format "Oct 3". Use the rest of the panel's style: `rounded-lg bg-pane-2 px-2 py-1 text-[11px]`, with a 9.5px uppercase "Sources" label.
- Clicking a `.cite` button (delegated in the existing `onClick`) or a source row:
  1. `const full = await useMail.getState().ensureEmail({ id, accountId })`.
  2. `useMail.getState().select(full.id)`.
  3. On failure, `toast("That email is no longer available")`.
- **Copy:** replace each `[mN]` with `[n]` and append `\n\nSources:\n1. Sender — Subject (date)` lines.
- `.assistant-md .cite` in `index.css`: inline-grid, `min-w-[16px] h-[16px]`, rounded 4px, `bg-primary/15 text-primary`, 9.5px, tabular-nums, `align-super`, a pointer cursor, `mx-px`.

**Tests:**
- **markdown:**
  - Known refs are numbered by first appearance (`[m4] … [m2] … [m4]` → 1, 2, 1).
  - An unknown `[m9]` is removed.
  - A token inside backticks is untouched.
  - No refs at all leaves no `.cite`, and `cited` is empty.
  - A ref named `__proto__`, as in `[m__proto__]`, doesn't match the pattern and isn't rendered.
- **tools:**
  - A search's sample rows carry `ref: "m1"…`.
  - Searching the same email again gives the same ref.
  - `read_email` returns `ref`.
- **state:**
  - `newChat` resets refs.
  - Snapshot round-trip keeps refs.

- [ ] **Step 1:** Write the failing tests. **Step 2:** Run them and watch them fail. **Step 3:** Implement. **Step 4:** Run the full suite and tsc until green.
- [ ] **Step 5: Commit** with the message `Assistant: cite emails as numbered sources`.

---

### Task 5: Automatic rules: engine, store hook, Settings

**Files:**
- Create: `src/lib/rules.ts`
- Modify:
  - `src/lib/store.ts`: `autoRules` state, actions, snapshot/restore, `applyAutoRules` hooked into `doRefresh`, the load path and `addAccount`, before `sort`
  - `src/components/settings/settings-dialog.tsx`: an "Automatic rules" group in `Rules()`
- Test: `src/lib/__tests__/auto-rules.test.ts` for the pure part, and `src/lib/__tests__/bulk-store.test.ts` (or a new `auto-rules-store.test.ts` in the same style) for the store hook

**Interfaces:**

```ts
// src/lib/rules.ts
import type { Email } from "@/lib/types";
import type { BulkOp } from "@/lib/mail/bulk";
export type RuleAction = "trash" | "archive" | "mark_read" | { moveTo: string };
export interface AutoRule {
  id: string;
  match: { from: string; subjectAny?: string[] };
  action: RuleAction;
  createdAt: string;
  enabled: boolean;
  hits: number;
  lastHitAt?: string;
}
export function normalizeFrom(v: string): string | null; // lowercased address or bare domain; null if neither
export function ruleMatches(rule: AutoRule, e: Email, isInbox: (e: Email) => boolean): boolean;
export function ruleOp(action: RuleAction): BulkOp;      // trash→{kind:"trash"}, archive→{kind:"archive"}, mark_read→{kind:"read",read:true}, moveTo→{kind:"move",folderId}
export function describeRule(rule: AutoRule, folderName?: (id: string) => string | undefined): string;
// e.g. "Trash new mail from amazon.com with “order”, “shipped” or “delivered” in the subject"
export function planRuleRun(rules: AutoRule[], emails: Email[], isInbox: (e: Email) => boolean): { rule: AutoRule; emails: Email[] }[]; // first enabled match wins
```

**`ruleMatches`:**
- The rule must be enabled.
- The email must not be `partial`, must be in an Inbox (`isInbox(e)`), and must have `Date.parse(e.date) >= Date.parse(rule.createdAt)`.
- Sender: an address rule needs `from` to equal the address exactly. A domain rule needs the domain to equal `from` or end with `"." + from`.
- `subjectAny`, when non-empty: some term (lowercased) must be included in the lowercased subject.

**`normalizeFrom`:** trims and lowercases.
- `x@y.z` is an address.
- `y.z` is a domain if it matches `/^[a-z0-9-]+(\.[a-z0-9-]+)+$/`.
- `@y.z` becomes the domain `y.z`.
- Anything else returns null.

**Store (`useMail`):**
- **State:** `autoRules: AutoRule[]`, default `[]`.
- **Snapshot:** add it to the `Snapshot` interface, `snapshot()` and `restore()` (`snap.autoRules ?? []`).
- **Actions:**
  - `addAutoRule(input: { from: string; subjectAny?: string[]; action: RuleAction }): AutoRule`. Normalizes the sender, throws on an invalid one, and sets `createdAt = new Date().toISOString()`, `enabled: true`, `hits: 0`.
  - `setAutoRuleEnabled(id, on)`.
  - `removeAutoRule(id)`.
- **`applyAutoRules()`** (internal, async):
  1. Candidates are inbox emails with no `triage[e.id]` yet.
  2. Run `planRuleRun`. For each `{rule, emails}`, call `get().bulkApply(emails, ruleOp(rule.action))`.
  3. Bump `hits` by `res.done` and set `lastHitAt`.
  4. Collect the undo entries.
  5. If anything was done, show **one** sonner toast: `Auto-${verb} ${n} from ${rule.match.from}`. With several rules it's `Automatic rules handled ${n} emails`. The **Undo** action calls `get().bulkUndo(entries, op)` for each rule's entries.
  6. Failures are left for the next run. Remember failed rule ids in a module-level `Set` and toast "An automatic rule couldn't run" only once per rule per session.
- **Calling it:** call `await applyAutoRules()` right before each `await get().sort({ onlyNew: true })` in `doRefresh`, `load` and `addAccount`.

**Settings, in the `Rules()` panel, above "Always file":**
- A group titled `Automatic rules`. Footer: `These act on new mail without asking. Undo is in the notification. Create them from the ✦ Assistant after a cleanup.`
- Empty state: `No automatic rules yet.`
- Each row:
  - label: `describeRule(rule, …)`;
  - hint: `${hits} emails · last on Oct 3`, or `Hasn't run yet`;
  - a toggle (reuse the panel's existing switch component if there is one, otherwise a checkbox styled like other toggles in this dialog);
  - a delete button like "Always file" uses.
- Add `automatic` to the section's search keywords.

**Tests:**
- **pure:** an exact address; a domain plus subdomain; a look-alike domain rejected; `subjectAny` case-insensitive; `createdAt` cutoff; non-inbox and partial mail skipped; disabled skipped; first-match-wins in `planRuleRun`; every `normalizeFrom` case; the `describeRule` text for each action.
- **store:**
  - a matching new inbox email gets `bulkApply`'d before `sort` runs (assert the order with spies);
  - one toast with Undo, which calls `bulkUndo`;
  - `hits` is updated;
  - snapshot round-trip.

- [ ] **Step 1:** Write the failing tests. **Step 2:** Run them and watch them fail. **Step 3:** Implement. **Step 4:** Run the full suite and tsc until green.
- [ ] **Step 5: Commit** with the message `Automatic rules: sender/subject rules that act on new inbox mail`.

---

### Task 6: `propose_rule` tool and rule card

**Files:**
- Modify:
  - `src/lib/ai/assistant/state.ts`: the new card type
  - `src/lib/ai/assistant/tools.ts`: tool def and executor
  - `src/lib/ai/assistant/prompts.ts`
  - `src/lib/ai/assistant/deps.ts`: a `ToolDeps.addRule` implementation
  - `src/components/assistant/message-item.tsx`: render the card
- Create: `src/components/assistant/rule-card.tsx`
- Test: `src/lib/__tests__/assistant-tools.test.ts`

**Interfaces:**
- **Consumes:** Task 5's `AutoRule`, `RuleAction`, `normalizeFrom`, `describeRule` and `useMail.addAutoRule`.
- **Produces:**
  - `Card` variant: `{ type: "rule"; from: string; subjectAny?: string[]; action: RuleAction; folderName?: string; status: "pending" | "saved" | "dismissed"; ruleId?: string }`
  - `ToolDeps.addRule(input: { from: string; subjectAny?: string[]; action: RuleAction }): string`. Returns the rule id. Real deps call `useMail.getState().addAutoRule`.

**Tool:**

```ts
{
  name: "propose_rule",
  description: "After a cleanup the user confirmed, propose an automatic rule for NEW mail like it. The user saves it on a card; nothing is saved by this call. Match on a sender address or domain, plus up to 5 subject words when the cleanup was narrower than the whole sender.",
  parameters: { type: "object", properties: {
    from: { type: "string", description: "Sender address or domain, e.g. amazon.com" },
    subject_any: { type: "array", items: { type: "string" }, description: "Optional: words or phrases; the rule matches if the subject contains any" },
    action: { type: "string", enum: ["trash", "archive", "mark_read", "move_to_folder"] },
    folder: { type: "string", description: "Folder id or name for move_to_folder" },
  }, required: ["from", "action"] },
}
```

**Executor:**
- `normalizeFrom(from)` must not be null. Otherwise throw `bad_query: from must be an address or domain`.
- `subject_any`: optional array, at most 5 items. Each item is trimmed, non-empty, at most 40 characters, and must not be a plain number. Otherwise throw `bad_query: …`.
- `move_to_folder` resolves the folder like `OPS.move_to_folder` does, giving `{ moveTo: folderId }`.
- Push the card with status `"pending"`.
- Return `{ status: "awaiting_confirmation", message: "A rule card is showing. Nothing is saved until the user clicks Save rule." }`.

**Card (`rule-card.tsx`), styled like `BulkCard`:**
- Title: `Automatic rule`.
- Body: `describeRule(...)`.
- Pending: a primary **Save rule** button, then **No thanks**.
  - Save calls `deps.addRule` through `realDeps()`, sets status to `saved` with the `ruleId`, and toasts "Rule saved".
  - No thanks sets status to `dismissed`.
- Saved: `✓ Saved · Manage in Settings → Sorting & Rules`.
- Dismissed: `Not saved`.

**Prompt rule:** `- After a cleanup the user confirmed and that finished, offer one automatic rule with propose_rule. Use subject words from the cleaned set's samples when it was narrower than the whole sender. Never propose a rule unasked otherwise.`

**Tests:**
- valid proposals push a pending card and save nothing (`addRule` isn't called);
- an invalid `from` or bad `subject_any` returns malformed;
- `move_to_folder` resolves a folder;
- a `__proto__` folder name doesn't resolve.

- [ ] **Step 1:** Write the failing tests. **Step 2:** Run them and watch them fail. **Step 3:** Implement. **Step 4:** Run the full suite and tsc until green.
- [ ] **Step 5: Commit** with the message `Assistant: propose_rule tool and rule card`.

---

### Task 7: Unsubscribe: header parsing, providers, `check_unsubscribe`, card

**Files:**
- Create:
  - `src/lib/mail/unsubscribe.ts`
  - `src/components/assistant/unsubscribe-card.tsx`
- Modify:
  - `src/lib/types.ts`: `Email.unsubscribe?`
  - `src/lib/google/gmail-map.ts`: parse from `payload.headers`
  - `src/lib/google/gmail.ts`: the header-row `metadataHeaders` gains `List-Unsubscribe` and `List-Unsubscribe-Post`
  - `src/lib/microsoft/graph.ts`: `getMessage` adds `internetMessageHeaders` to its `$select`
  - `src/lib/microsoft/graph-map.ts`: parse from `internetMessageHeaders`
  - `src/lib/mail/mock-data.ts`: add `unsubscribe` to the demo bulk senders (one each of one-click, mailto-only and link-only)
  - `src/lib/ai/assistant/state.ts`: card type
  - `src/lib/ai/assistant/tools.ts`, `prompts.ts`, `deps.ts`
  - `src/components/assistant/message-item.tsx`
- Test: `src/lib/__tests__/unsubscribe.test.ts`, `gmail-map.test.ts`, `graph.test.ts`, `assistant-tools.test.ts`

**Interfaces:**

```ts
// src/lib/types.ts (Email)
unsubscribe?: { http?: string; mailto?: string; oneClick: boolean };

// src/lib/mail/unsubscribe.ts
export function parseListUnsubscribe(listUnsubscribe?: string, listUnsubscribePost?: string): Email["unsubscribe"] | undefined;
export type UnsubMethod = "one_click" | "email" | "link" | "none";
export function unsubMethod(u?: Email["unsubscribe"]): UnsubMethod; // one_click if oneClick && http; else email if mailto; else link if http; else none
export function parseMailto(mailto: string): { to: string; subject: string } | null; // subject defaults to "unsubscribe"; body ignored
export async function oneClickUnsubscribe(url: string): Promise<void>; // https only; requestText("POST", url, { headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: "List-Unsubscribe=One-Click" }); throws on non-2xx or non-https
```

**`parseListUnsubscribe`:**
- Unfold whitespace and split on commas outside `<>`. Take each `<…>` value.
- `http` is the first `https:` URL. `http:`, `javascript:` and other schemes are ignored.
- `mailto` is the first `mailto:` URL, kept raw.
- `oneClick` is true only when `listUnsubscribePost` (trimmed, case-insensitive) equals `list-unsubscribe=one-click` and `http` is set.
- Returns `undefined` when neither `http` nor `mailto` is present.

**`parseMailto`:**
- Use `new URL`. The address comes from the path and is decoded.
- `to` must look like an email address. Otherwise return null.
- The subject comes from the `subject` query parameter, defaulting to `unsubscribe`.

**Providers:**
- Gmail `toEmail` sets `unsubscribe: parseListUnsubscribe(header(p, "List-Unsubscribe"), header(p, "List-Unsubscribe-Post"))` when present.
- Graph `messageToEmail` does the same from `m.internetMessageHeaders?.find(...)`, with case-insensitive names. Add `internetMessageHeaders?: { name: string; value: string }[]` to `GMsg`. Only the single-message `getMessage` `$select` adds `internetMessageHeaders`. List queries are unchanged.
- The mock provider's `getMessage` already returns the stored email, so mock data just carries the field.

**ToolDeps additions:**
- `freshMessage(ref: Ref): Promise<Email>`. Real deps call `providerOf(ref.accountId).getMessage(ref.id)` directly from `@/lib/store`, not `ensureEmail`, so cached copies without `unsubscribe` don't matter.
- `newestFrom(from: string): Promise<Ref | null>`. It searches with `deps.search({ from }, 1)` and returns the first ref.
- `sendUnsubscribe(accountId: string, to: string, subject: string): Promise<void>`, which calls `useMail.getState().send(accountId, { to: [{ name: "", address: to }], subject, text: "unsubscribe" })`. Match the existing `SendRequest` field types exactly.
- `oneClick(url: string): Promise<void>`
- `openLink(url: string): void`, which uses `openExternal`.

**Tool:**

```ts
{
  name: "check_unsubscribe",
  description: "Check how to unsubscribe from a sender (from its newest email's List-Unsubscribe header) and show the user an Unsubscribe card. Nothing happens until the user clicks.",
  parameters: { type: "object", properties: { from: { type: "string", description: "Sender address or domain" } }, required: ["from"] },
}
```

**Executor:**
1. `normalizeFrom` must not be null.
2. Get the ref from `newestFrom`. If there isn't one, return `{ available: "none", reason: "no email from that sender" }`.
3. `freshMessage(ref)`, then `unsubMethod(email.unsubscribe)`.
4. If the method isn't `none`, push the card.
5. Return `{ available: method, from }`.

**Card variant:**
`{ type: "unsubscribe"; from: string; accountId: string; accountAddress: string; method: Exclude<UnsubMethod, "none">; http?: string; mailto?: string; status: "pending" | "working" | "done" | "failed" | "opened"; error?: string }`

**`unsubscribe-card.tsx`:**
- Title: `Unsubscribe from ${from}`.
- Detail, by method:
  - one_click: `Asks ${host} to stop sending you mail.`
  - email: `Sends a short email to ${to} from ${accountAddress}.`
  - link: `Opens ${host}'s unsubscribe page in your browser.`
- Button, by method: **Unsubscribe**, **Send unsubscribe email**, **Open unsubscribe page**.
- On click:
  - one_click calls `deps.oneClick(http)`.
  - email calls `parseMailto`, then `deps.sendUnsubscribe(accountId, to, subject)`.
  - link calls `deps.openLink(http)` and sets `opened`.
- While working: a spinner.
- Done: `✓ Unsubscribed · new mail may take a few days to stop`.
- Opened: `Finish in your browser`.
- Failed: the `error`, plus an **Open unsubscribe page** fallback when `http` is set.
- There's also a **Dismiss** button.

**Prompt rule:** `- check_unsubscribe only shows a card; never say the user is unsubscribed unless the card says so.`

**Tests:**
- **parse:**
  - `<https://a.com/u?x=1>, <mailto:u@a.com?subject=stop>` with Post set gives `oneClick: true`, both fields set.
  - An `http:` URL only gives undefined.
  - A `javascript:` URL is ignored.
  - Folded whitespace is handled.
  - Post without https gives `oneClick: false`.
  - A Post header with different text gives false.
- **`unsubMethod`:** every branch.
- **`parseMailto`:** subject, default subject, a bad address gives null, the body is ignored.
- **`oneClickUnsubscribe`:** mock `@/lib/transport`. It rejects `http:` without calling the transport. The exact POST body and headers are sent. A non-2xx response throws, which happens through `requestText`'s `HttpError`.
- **gmail-map / graph-map:** the field is mapped from headers.
- **tool:** a card is pushed with the method; `none` gives no card; an invalid `from` is malformed; nothing is sent or posted when the tool runs.

- [ ] **Step 1:** Write the failing tests. **Step 2:** Run them and watch them fail. **Step 3:** Implement. **Step 4:** Run the full suite and tsc until green.
- [ ] **Step 5: Commit** with the message `Unsubscribe: List-Unsubscribe parsing, check_unsubscribe tool and card`.

---

## Final verification (controller)

In the browser preview with the demo account, using the mock assistant agent:
- the menu, filtering, chip, Backspace, Esc and Enter-picks;
- sender suggestions;
- a /find answer with numbered sources, and clicking a source opens the email;
- a saved rule appears in Settings → Sorting & Rules;
- one Unsubscribe card for each of the three methods.

The offline `mock-agent.ts` may need small scripted additions for /find, propose_rule and check_unsubscribe. Add them in the task that owns each feature.
