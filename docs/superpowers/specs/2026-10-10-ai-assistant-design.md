# zMail AI Assistant: design

Date: 2026-10-10 · Status: approved in conversation, pending spec review

## Goal

Talk to your mailbox in plain English, in a panel beside your mail:

- **Find** sets of mail: "pull up all my emails from amazon.com"
- **Understand** them: "how many are just orders/delivery?", "what did Sarah say about the budget?"
- **Act** on them: "delete those", "add this to my calendar", "reply yes", "forward this to Mike"

The assistant replaces the separate "Draft with AI" entry point. Drafting becomes one of the things you ask for.

## Decisions

| Topic | Decision |
|---|---|
| Scope | Find and clean up, plus questions about content, calendar events, drafting replies/forwards/new mail |
| Model | A separate **assistant model** setting. If it's unset, the assistant uses the writing model |
| Placement | **Side panel** on the right, toggled by the ✦ button next to New message and by ⌘J. The mail list shows the results |
| Search reach | **Whole mailbox**, via Gmail and Outlook server search, paged. Not just the local cache |
| Approvals | Undoable actions run directly with Undo; trash, spam, move to folder and calendar events always confirm; any action on more than 25 emails confirms; **the assistant never sends** |
| Architecture | **Tool-using assistant**: the model calls zMail tools in a loop. Not a one-shot planner |

## Tools

The model never sees or types raw lists of email ids. Searches and breakdowns create **result sets** with ids, and bulk actions take only set ids. So the model can't act on emails it made up.

### Read-only (run right away)

- **`search_mail(query)`**: a structured query with these fields: `from` (address or domain), `to`, `words`, `subject`, `after`/`before`, `folder`, `unread`, `starred`, `hasAttachment`, `category` (zMail's), `section`, `account`. zMail turns it into a server search, pages through every result and stores a set. It returns `{setId, count, label, sample: first ~20 rows (sender, subject, date, short snippet)}`.
- **`break_down(setId, by)`**: `by` is one of `sender`, `month` or `kind`.
  - For `kind`, mail zMail has already sorted uses its category. Older or unsorted mail is labelled by the assistant model from sender and subject only, in batches of about 200.
  - Labels are cached locally by message id.
  - Returns counts per group, and each group becomes its own set (e.g. "186 order & delivery").
- **`read_email(id)`**: the full text of one email, capped at 6,000 characters. The id must come from a set sample, the current view, or an earlier tool result.
- **`current_view()`**: the open email, the checked rows, and the current list or set. This is how "this", "these" and "those" resolve.

### Actions (through the approval gate)

| Tool | Behavior |
|---|---|
| `act(setId \| emailIds-from-view, op)` with op `archive`, `mark_read`, `mark_unread`, `star`, `unstar`, `move_to_section` | Runs directly with an Undo toast **if there are 25 emails or fewer**; otherwise shows a confirm card |
| `act(..., op)` with op `trash`, `spam`, `move_to_folder` | Always shows a confirm card: count, description, **Review** (shows the set in the mail list), and a red action button |
| `create_event(title, start, end?, allDay?, location?, notes?, fromEmailId?)` | Always shows a card. It reuses the Today rail's `SuggestionCard`, with a calendar picker and Add |
| `draft(kind: reply \| reply_all \| forward \| new, emailId?, to?, instructions)` | Writes the text with the **writing model** and opens compose prefilled. The user presses Send. **There is no send tool** |

Unsubscribe and snooze are out of scope for v1.

## UI

- **The ✦ button** next to New message (where "Draft with AI" is today) and **⌘J** open and close the panel. Opening it focuses the input.
- **Panel:** a header ("✦ Assistant", a model name pill, New chat, close), the messages, and an input with a **context chip** showing what "this/these" means right now ("Viewing: Delta flight email", "3 checked", "186 order & delivery").
- **Messages:** your messages, assistant text, grey **step lines** ("⌕ Searched all mail · from:amazon.com · 214"), clickable **set chips**, small breakdown bars, and cards.
- **Set in the mail list:** clicking a set chip shows that set in the main list with a banner, "✦ Assistant set: {label} · {count} · Back to Inbox". Breakdown sets get **tabs** above the list (186 order & delivery / 19 receipts / 9 promos / All 214). Every normal row action works.
  - Rows for emails that aren't in the local cache come from search header rows. Opening one fetches the full message.
- **Cards:** confirm, then progress bar ("Moving… 88 / 186"), then a summary with **Undo**. Event cards use the existing suggestion card. Draft hand-off shows "Opened a draft reply to Sarah" with a button to bring compose back up.
- Mockups (local only, not committed): `.superpowers/brainstorm/*/content/placement.html`, `panel-detail.html`.

## Architecture

```
src/lib/ai/assistant/
  loop.ts      conversation loop: model ↔ tools, max 8 tool steps per user message
  tools.ts     tool schemas, executors, approval gate
  query.ts     structured query → Gmail q / Graph $search+$filter, plus local filters
  sets.ts      result sets: id → {query, label, ids[], headers, parent?}
  kinds.ts     batch "kind" labelling for unsorted mail + local cache
  prompts.ts   system prompt (rules: use tools, never claim an action happened unless a tool reported it, ask when "this" is unclear)
src/components/assistant/
  assistant-panel.tsx, message.tsx, set-chip.tsx, action-card.tsx, set-banner.tsx
```

### Model client

- `GenerativeProvider` gains `chat(messages, tools) → {text?, toolCalls?[]}` alongside `complete()`.
- Anthropic: Messages API `tools` / `tool_use` / `tool_result` blocks.
- OpenAI, Ollama and custom servers: `/v1/chat/completions` with `tools` / `tool_calls` / `role: "tool"`.
- `MockGenerativeProvider.chat` follows a scripted plan so the tests and the browser preview never use a real model.
- Settings → AI gets an **Assistant model** section (provider, base URL, model, key). The key goes in the macOS Keychain, like the existing keys. If it's empty, the assistant uses the writing model.

### Mail providers

- `search(query, pageToken?) → {headers: EmailHeader[], next?}` uses Gmail `messages.list?q=` plus metadata `messages.get` (batched), and Graph `/messages?$search|$filter&$select=…`.
- `batchMove(ids, folderId)`, `batchSetRead(ids, read)` and `batchSetStarred(ids, starred)` use Gmail `messages.batchModify` (1,000 ids per call) and Graph `$batch` (20 requests per call).
- The mock provider implements all of these over the mock data.
- Store actions that already exist (archive, trash, setSection…) are used for emails in the local cache. Batch provider calls handle large sets and mail that isn't cached; the local cache is updated to match.

### State and persistence

- **Conversation:** the current conversation (messages, step lines, card outcomes) is saved in the `kv` snapshot and survives a relaunch. **New chat** clears it.
- **Sets:** kept in memory only. A set chip from an earlier session re-runs its search when clicked.
- **Kind labels:** cached in `kv` by message id, trimmed to the newest 20,000.
- **Bulk undo:** each action records `{id, fromFolderId}` per email. Undo restores them in batches. The record is kept until the next action or New chat.

### What goes to the assistant model

- The user's messages.
- From tool results: counts, set labels, and up to ~20 sample rows (sender, subject, date, snippet).
- Full email text only through `read_email` on a specific email.
- For kind labelling: sender and subject only.
- Settings states this in one line for cloud models. Nothing is sent to the writing model except `draft` instructions and the email being replied to or forwarded, as today.

## Errors

- **No assistant model, or no tool support.** The panel shows a setup prompt linking to Settings → AI. Two malformed tool calls in a row end the turn with "This model isn't handling zMail's tools well. Try a stronger assistant model."
- **Broad searches.** Sets are capped at 10,000. Past that, the tool returns `too_many` and the assistant asks the user to narrow it.
- **Partial bulk failure.** The card shows "Moved 1,412 of 3,000" with **Resume** and **Undo what was moved**. No silent retries.
- **Stale sets.** Emails already gone or moved are skipped, and the summary reports how many.
- **Model errors and timeouts** show inline with Retry. The conversation is kept.
- **Unclear references** ("this" with no open or checked email): the assistant asks instead of guessing. This rule is in the system prompt, and `current_view` returns an empty result.

## Testing

All tests run on mock providers: no real keys and no real models.

- `query.ts`: structured query → Gmail `q` and Graph `$filter`/`$search`, for each field and combination; local filters for category and section.
- Loop with a scripted mock model:
  - Amazon flow: search → break_down → trash card → confirm → progress → summary → undo.
  - Calendar flow: read_email → create_event card.
  - Draft flow: draft → compose opened with text and no send.
- Approval gate:
  - A 25-email archive runs directly, and a 26-email archive confirms.
  - Trash, spam and move to folder always confirm.
  - Events always confirm.
  - There is no send tool.
- Id safety: `act` rejects ids that aren't in a set or the current view.
- Batching: chunk sizes (1,000 for Gmail, 20 for Graph); a failure halfway through leads to resume and to undoing only what was moved.
- Tool-call formats: Anthropic and OpenAI request and response mapping, including several tool calls in one turn.
- Kind labels are cached, so a second breakdown makes no model call.
- A browser preview run-through of the panel with mock providers.

## Out of scope (v1)

Unsubscribe, snooze via the assistant, scheduled or standing rules ("always trash Amazon delivery mail"), voice, attachments as input, and the assistant sending mail.
