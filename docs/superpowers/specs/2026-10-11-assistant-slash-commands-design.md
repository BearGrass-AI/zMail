# Assistant slash commands, cited answers, auto-rules and unsubscribe: design

Date: 2026-10-11 · Status: design approved in conversation (mockup `slash-commands.html`), pending spec review

## Goal

Make the ✦ Assistant faster to use and more useful for the things people actually ask it:

1. **Slash commands.** Type `/` for a menu of curated prompts. Pick one, type the subject, and press Enter. zMail sends a well-shaped prompt so the answer is consistent.
2. **Answers with sources** (`/find`). Short answers where each claim is numbered to the email it came from, and you can click a source to open it.
3. **Cleanups that stick** (`/cleanup`). After a bulk action, offer to handle new matching mail automatically with a visible, deletable zMail rule.
4. **Unsubscribe** (`/unsubscribe`). Use the sender's own List-Unsubscribe header.

Out of scope: a daily briefing (Today/Triage already covers it), user-defined custom commands, follow-up tracking, and multi-draft queues. These are possible later additions.

## Decisions

| Topic | Decision |
|---|---|
| Entry | `/` at the start of the assistant input opens the menu. Typing `/breakdown amazon` in full without the menu works too |
| Look | The picked command becomes a **chip** in the input. Backspace on an empty argument removes it. The sent message shows the same chip plus your text |
| Hidden prompt | The visible message is the chip plus your text. The model receives the command's curated prompt with your text filled in |
| Argument help | Commands that take a sender suggest senders and domains from your local mail with counts. These suggestions are local only, with no model call |
| Citations | Every answer may cite emails as `[mN]`, a short per-conversation ref. zMail renders these as numbered markers with a **Sources** list. Refs it doesn't know are dropped, never shown |
| Rules | New **automatic rules** match on sender (address or domain) plus optional subject words. Matching is deterministic and local, with no AI per email. The model *proposes* a rule; you save it from a card |
| Rule scope | Rules apply only to **new inbox mail that arrives after the rule was saved**, on all accounts. Existing mail is what the cleanup itself handled |
| Unsubscribe | (1) RFC 8058 one-click HTTPS POST, (2) `mailto:` unsubscribe email, (3) open the HTTPS link in the browser. All of these run only after you confirm on a card. Plain `http:` URLs are never fetched |
| Sending | The assistant still has no send tool. A mailto unsubscribe is the only email zMail sends from these features. Its recipient and subject come from the header, its body is fixed, and you confirm it on a card that says exactly what will be sent |

## 1. Slash commands

### Registry (`src/lib/ai/assistant/commands.ts`, new, pure)

```ts
interface SlashCommand {
  name: string;            // "breakdown"
  group: "mail" | "email"; // "email" commands need an open email
  description: string;     // menu text
  arg: "sender" | "text" | "none";
  placeholder?: string;    // input hint after picking: "sender, topic or folder…"
  local?: "clear";         // handled in zMail, never sent to the model
  expand(arg: string): string; // the hidden prompt sent to the model
}
```

Starting set (the menu order):

| Command | Group | Arg | Prompt intent |
|---|---|---|---|
| `/breakdown` | mail | sender | Search the subject, then `break_down` by kind and by sender. Answer with a table of counts plus a one-line takeaway |
| `/cleanup` | mail | sender | Search, show a breakdown, and propose the bulk action (trash by default, or archive for mail from people). After it completes, call `propose_rule`, and `check_unsubscribe` if it's a bulk sender |
| `/unsubscribe` | mail | sender | Call `check_unsubscribe` for the sender, then offer cleanup of existing mail |
| `/find` | mail | text | Search as needed, read the most relevant emails, answer in 1–4 sentences, cite every claim with `[mN]`, and say plainly if nothing supports an answer |
| `/summarize` | email | none | Summarize the open email or thread: key points, asks and dates |
| `/reply` | email | text | Draft a reply to the open email using the instructions |
| `/schedule` | email | none | Find the meeting or date in the open email and call `create_event` |
| `/clear` | mail | none | Local: same as today |

Pure helpers, all unit-tested:
- `matchCommands(prefix, {hasOpenEmail})` filters by name prefix and hides "email" commands when no email is open.
- `parseSlash(text)` returns `{command, arg}` or null. It accepts `/name arg` and `/name: arg`. Unknown names return null, so the text is sent as typed.
- `senderSuggestions(emails, query, limit = 6)` works over non-partial emails. It groups by domain and by address with counts, matches on prefix of domain, address or display name, and ranks domains before single addresses when both match.

### Input UI (`assistant-panel.tsx`, plus a small `slash-menu.tsx`)

- **Panel state:** `command: SlashCommand | null`, `text`, `menu: {items, active} | null`.
- **Opening the menu:** with no chip, typing `/` as the first character opens it, and further characters filter it. With a chip and an `arg: "sender"` command, the menu shows sender suggestions for the current text.
- **Keys:**
  - ↑/↓ move the selection.
  - Tab, or Enter with the menu open, picks: a command becomes the chip, and a suggestion fills the text.
  - Esc closes the menu.
  - Enter with the menu closed sends.
  - Backspace with empty text removes the chip.
- **Sending:** `command.local === "clear"` runs `clearChat()`. Otherwise call `ask(expanded, …, { display: { command: name, text } })`. A typed `/name arg` without a chip goes through `parseSlash` and is handled the same way.
- **Busy state:** /clear keeps working while busy, as it does today. Other commands follow the existing busy rule.
- **Placeholder:** drop "(/clear to start over)" and use `Ask about your mail… (/ for commands)`.
- **Look:** as in the approved mockup. The menu floats above the input in the pane style and has group headings ("Your mail", "This email"). It shows a key-hint footer, and the active row is tinted with the primary color.

### Loop changes (`loop.ts`, `state.ts`, `message-item.tsx`)

- **`ask` options:** `ask(text, deps?, provider?, opts?: { display?: { command: string; text: string } })`. The user item stores `text` (the expansion) plus an optional `display`. The history message uses the expansion.
- **User bubble:** when `display` is set it renders the chip plus `display.text`. Otherwise it renders `text`.
- **Retry:** `retry` finds the user item by **id** rather than by matching text, and resends the item's stored expansion and display. The error item's `retry` field holds the user item id.
- **Persistence:** `display` is persisted in `assistant.v1`. Older snapshots without it render as today.

## 2. Answers with sources

### Refs

- **Assigning refs:** the assistant state gains `refs: Record<string, RefInfo>` and `refSeq`. `RefInfo = {id, accountId, from, subject, date}`. Each email that a tool shows the model (search sample rows, `read_email`, `current_view`) gets a stable ref `m1`, `m2`, … for the conversation, assigned on first sight. A `ref` field is added to `rowFor` and to the `read_email` and `current_view` outputs.
- **Lifetime:** refs are persisted with the conversation and cleared by `/clear`.
- **Tools still use ids:** they keep taking real ids, which are already checked against `known`. Refs exist only for citing.
- **Prompt rule (all answers, not only /find):** "When a statement comes from a specific email, cite it as [mN] using the ref from tool output. Never invent refs. If nothing you read supports an answer, say so."

### Rendering (`markdown.ts` `polish()`, `message-item.tsx`)

- `renderMarkdown(md, refs)`: after sanitizing, walk the text nodes outside `code`/`pre`. Replace each `[mN]` that exists in `refs` with `<button class="cite" data-ref="mN">n</button>`, numbering by order of first appearance in that message. Remove unknown `[mN]` tokens.
- Allowing these is safe because they're built in the post-sanitize step from known refs. The sanitizer allowlist stays as it is, and the class hook gains `cite`.
- Under a message with at least one citation, show a **Sources** list: number, sender, subject, date. Clicking a marker or a source row runs `ensureEmail(ref)` and then `select(id)`, using the `HeaderRow` pattern from `set-view.tsx`. If the email can't be loaded, show a toast ("That email is no longer available").
- Copy (button or selection) includes the plain `[n]` markers plus the sources as text lines.

## 3. Automatic rules

### Model (`src/lib/rules.ts`, new, pure)

```ts
interface AutoRule {
  id: string;
  match: { from: string /* address or bare domain */; subjectAny?: string[] /* case-insensitive words/phrases */ };
  action: "trash" | "archive" | "mark_read" | { moveTo: string /* folderId */ };
  createdAt: string;   // ISO; only mail received after this is touched
  enabled: boolean;
  hits: number;        // lifetime count
  lastHitAt?: string;
}
```

- `ruleMatches(rule, email)`: a sender `from` must equal the address, or the domain (or a subdomain of it) for a bare-domain rule. If `subjectAny` is set, at least one item must appear in the subject. The email must also be newer than `createdAt`, be in an Inbox, and not be partial.
- **Storage:** rules are stored in `useMail` as `autoRules: AutoRule[]`, persisted in the `state.v1` snapshot and defaulting to `[]`. The existing "Always file" suggestion map stays as it is, separate.

### Running

- **Function:** `applyAutoRules(newEmails)` in the store runs right after mail is merged in `doRefresh`, *before* `sort({onlyNew})`, so auto-handled mail costs no triage calls. It also runs on the first-load path (`load`/`addAccount`).
- **What counts as new:** inbox emails not yet triaged that match an enabled rule. The first matching rule wins, in list order.
- **Applying:** actions go through `bulkApply`, in one batch per action. `hits` and `lastHitAt` are updated.
- **Notice:** one toast per refresh that actually did something, such as "Auto-trashed 3 from amazon.com". It has an **Undo** that uses the `bulkApply` undo entries and expires like other toasts.
- **Failures:** a failed batch leaves the mail where it is, and the rule tries again on the next refresh. The toast reports a failure only once per rule per session.

### Creating rules from the assistant

- **`propose_rule` tool:** args `{from, subject_any?, action, folder?}`.
  - Validation: `from` must look like an address or domain, `subject_any` is limited to 5 items of 40 characters each, and `action` must be one of the four.
  - It pushes a **rule card** and never saves by itself.
- **The card:** it shows the rule in plain words, for example "Trash new mail from **amazon.com** with *order*, *shipped* or *delivered* in the subject". The buttons are **Save rule** and **No thanks**. Once saved it says "Saved · Manage in Settings → Sorting & Rules".
- **Prompt guidance:** propose a rule only after a cleanup the user confirmed. When the cleaned set was a narrower kind (orders or shipping), use 2–5 subject words seen in that set's sample rather than the whole sender.

### Settings → Sorting & Rules

Add an **Automatic rules** group above "Always file". Each row has:
- the plain-words rule,
- a hit count with the last hit date,
- an enable toggle,
- a delete button.

Footer: "These act on new mail without asking. Undo is in the notification."

## 4. Unsubscribe

### Headers

- **`Email.unsubscribe?: { http?: string; mailto?: string; oneClick: boolean }`**:
  - `http` is HTTPS only.
  - `mailto` is a parsed `mailto:` URL.
  - `oneClick` is true when a `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header is present.
- **Gmail:** `gmail-map.ts` parses it from `payload.headers` on full messages. The header-row request (`format=metadata`) also asks for `List-Unsubscribe` and `List-Unsubscribe-Post`.
- **Graph:** single-message GETs add `internetMessageHeaders` to `$select`, and `graph-map.ts` parses it.
- **Mock provider:** gains realistic headers for its bulk senders, so the browser preview demonstrates all three methods.
- **Freshness:** the unsubscribe flow always reads a fresh copy via `provider.getMessage(id)`, so emails cached before this change don't matter.

### `check_unsubscribe` tool and card

- **Tool:** args `{from}`. It finds the newest local or server email from that sender, reads its headers, and returns `{available: "one_click" | "email" | "link" | "none", from}`. When something is available it pushes an **Unsubscribe card**.
- **Card buttons by method:**
  - one-click: **Unsubscribe**. This POSTs `List-Unsubscribe=One-Click` as `application/x-www-form-urlencoded` through the Rust HTTP command. Any 2xx counts as success.
  - email: **Send unsubscribe email**. The card shows "Sends a short email to *list@sender* from *you@account*". It sends through `useMail.send` with the header's to and subject (default "unsubscribe") and the body "unsubscribe".
  - link: **Open unsubscribe page**, which opens the link in the browser. The card says you finish it there.
- **Card results:** success shows "Unsubscribed from amazon.com · new mail may take a few days to stop", and offers to save a trash rule meanwhile (the `propose_rule` card). Failure shows the reason plus the link fallback when there is one.
- **Cleanup offer:** the `/cleanup` follow-up shows an **Unsubscribe** button only when `check_unsubscribe` found a method.

## Safety

- Header URLs are untrusted.
  - Only `https:` gets fetched.
  - The POST carries no cookies or credentials, and the Rust HTTP command must not attach any.
  - Only `https:` and `mailto:` are ever opened.
- Every new side effect needs a click on a card: saving a rule, an unsubscribe POST, a mailto send, opening a link. The model can only propose.
- Refs can't reach anything outside the conversation's own `refs` map. Citation clicks go through `ensureEmail`.
- Auto-rules never touch mail older than the rule, never delete permanently, and every run can be undone from its toast.

## Testing

Unit tests (vitest), in the repo's existing style:
- **commands:** `matchCommands`, `parseSlash`, `senderSuggestions` ranking and counts, and each `expand` including the user text.
- **loop:** `display` stored and rendered, history gets the expansion, retry by id, `assistant.v1` round-trip with and without `display`.
- **refs:** stable numbering on repeat sight, refs reset on clear, unknown `[mN]` dropped, numbering by first appearance, citations not replaced inside code.
- **rules:**
  - matching: address, domain, subdomain, subjectAny, createdAt cutoff, non-inbox and partial mail skipped;
  - `applyAutoRules`: runs before sort, toast with Undo, first-match wins, failed batch retried;
  - snapshot round-trip.
- **unsubscribe:** header parsing for Gmail and Graph (angle brackets, multiple URIs, http rejected, mailto with subject), method choice, POST body and headers, the mailto send request.

Plus browser-preview checks with the mock provider: the menu, chip, suggestions, a /find answer with sources, /cleanup through a saved rule, and an unsubscribe in each of the three methods.
