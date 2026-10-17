# Date Suggestions for All Real Mail, and Sorting the Whole Inbox: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offer calendar suggestions for real dates in any non-promotional email, never for marketing dates. Then download and sort every email in the Inbox, not just the newest ~300.

**Architecture:** Part A widens date finding, which today only covers section mail with "catch dates" on:
- A pure candidate filter decides which emails get checked: a local date check, zMail's own categories, a 30-day window and a sender opt-out list.
- The writing-model prompt drops the section and gains marketing rules.
- Suggestions and chips show without sections.

Part B adds an Inbox backfill:
- Each provider gets a `backfillInbox` page method.
- The store runs a once-per-session background loop with progress.
- The SQLite cache becomes Inbox-aware, so the Inbox survives a reload.
- Triage writes are batched, so a large backlog doesn't re-render the UI per email.

**Tech Stack:** Tauri 2 (Rust, rusqlite), React 19, TypeScript, Zustand v5, Vitest/jsdom.

**Spec:** `docs/superpowers/specs/2026-10-11-dates-and-whole-inbox-design.md`

## Global Constraints

- Work on `main` and commit directly. No push, no branches. Leave the untracked `inspirational_ideas/` and `zMail_icon/` alone. A dev server is running; don't start or stop it.
- Before every commit, `npx tsc --noEmit -p .` must be clean and the full `npx vitest run` must pass. When Rust changes, `cargo check` and `cargo test` must pass in `src-tauri`.
- Zustand v5: selectors must not return new objects or arrays.
- Never use Gmail tabs, `CATEGORY_*` labels or Outlook Focused as signals. Use only zMail's own triage categories.
- No real accounts or model keys in tests. Browser checks use the demo account.
- Change only the files a task names, plus their tests. Don't restyle unrelated UI.
- Subagents never dispatch other subagents. Commit messages end with your attribution trailer.

## Review Focus

1. **A promotional email with a date** (e.g. "Prime Day starts July 8", "Sale ends Sunday") must produce no suggestion. It's excluded by category before the model, and the prompt tells the model to drop marketing dates.
2. **A school or event email with no section** ("Christmas band concert Thursday Dec 12 at 6:30 PM") must produce a suggestion on Today and a chip on the row.
3. **Re-checking.** Each email reaches the writing model at most once, across reloads too (`dateFinds` is persisted). The backfill must not re-sort already-triaged mail.
4. **Inbox survives a reload.** After a backfill grows the Inbox past 2,000 cached rows, a relaunch still shows the whole Inbox.
5. **The UI stays responsive** during a long sort. Triage results are applied in batches, not one store write per email.

---

### Task 1: Date candidates, local date check, prompt without sections

**Files:**
- Modify:
  - `src/lib/ai/dates.ts`: `mentionsDate`, `datesPrompt(email, section?)` with the marketing rules
  - `src/lib/store.ts`: `findDates` candidate filter, `noDateSenders`, the setting, the call after load
  - `src/lib/settings.ts`: `findDatesEverywhere: boolean`, default `true`
- Create: `src/lib/date-candidates.ts`, a pure `isDateCandidate(...)`
- Test:
  - `src/lib/__tests__/date-candidates.test.ts`
  - `src/lib/__tests__/dates.test.ts` (extend it, or create it if missing)

**Interfaces:**
- `mentionsDate(text: string): boolean`. It's true for:
  - a month name or abbreviation followed by a day number (`Dec 12`, `December 12th`, `12 December`);
  - numeric dates (`12/12`, `12/12/2026`, `12-12-2026`, `2026-12-12`);
  - weekday names;
  - `today`, `tonight`, `tomorrow`, `next week`;
  - clock times (`6:30 PM`, `6pm`, `18:30`).

  Version strings like `v1.2.3`, and prices and decimals like `12.99`, are false.
- `isDateCandidate(e, ctx): boolean` where `ctx = { inbox: boolean; category?: Category; section?: { dates?: boolean } | null; noDateSenders: Record<string, true>; everywhere: boolean; now: number }`. Rules:
  1. It must be in an Inbox and not partial.
  2. A section with `dates` true is always a candidate.
  3. A section with `dates` false is never a candidate.
  4. Otherwise it needs `everywhere`, a category that isn't `promotions` or `newsletters`, a sender address (lowercased) that isn't in `noDateSenders` (checked with `Object.hasOwn`), `now - Date.parse(e.date) <= 30 days`, and `mentionsDate(subject + " " + text.slice(0, 5000))`.
- `datesPrompt(email, section?)`:
  - The section line only appears when `section` is given.
  - The keep and ignore lists follow the spec's "What the model keeps", with keep including bills, payments, deadlines, appointments, reservations, travel, school, family and community events, RSVPs and closures. It must also keep **deadlines and asks from people**, such as "can you send the slides by Friday?", "need your sign-off by EOD tomorrow" or "please review before the 15th". Resolve relative dates ("Friday", "tomorrow", "next week") against the email's **sent date**, not today, and label them clearly (e.g. "Slides to Jen due"). Add a test that the prompt contains this rule and shows both the sent date and today.
  - It includes the sentence "When unsure whether a date is marketing, leave it out."
  - `extractDates(p, email, section?)` passes through.
- Store:
  - `noDateSenders: Record<string, true>` in state and in snapshot/restore, defaulting to `{}`.
  - `findDates()` uses `isDateCandidate` with `sectionOf(s, e)`, `s.triage[e.id]?.category`, `useSettings.getState().findDatesEverywhere` and `Date.now()`. Section mail still passes the section name to the prompt.
  - Call `void findDates()` once at the end of `load()`.

- [ ] Failing tests for `mentionsDate`:
  - true: `Thursday, Dec 12 at 6:30 PM`, `Payment due 10/18`, `due October 18`, `tomorrow`, `2026-12-12`;
  - false: `Version 1.2.3 released`, `Only $12.99 today`, plus a plain sentence.

  Note `Only $12.99 today` is **true** because of "today", which is acceptable; the category filter and the model handle it. Assert that it's true, so the test documents the behaviour.
- [ ] Failing tests for `isDateCandidate`:
  - excluded: `promotions`, `newsletters`, a sender in `noDateSenders`, mail older than 30 days, no date mention, not in the Inbox, partial, `everywhere` off;
  - always included: a section with dates on (even old, even with no mention);
  - always excluded: a section with dates off.
- [ ] Failing test: `datesPrompt` with no section has no section line and contains "Prime Day" (or "sale ends") in its ignore list, plus the "When unsure" sentence. With a section, it includes the section line.
- [ ] Implement. Store test (in the style of `src/lib/__tests__/store-counts.test.ts` / `auto-rules-store.test.ts`, with the writing model mocked): an inbox `transactions` email "Payment due October 18" with no sections gets `extractDates` called once and `dateFinds` set. A `promotions` email with a date isn't sent. Running `findDates` again doesn't call the model a second time.
- [ ] Run tsc and the full vitest, then commit with the message `Dates: check real mail for dates without sections; skip promos`.

### Task 2: Show finds without sections; learn from "Not now"; Settings

**Files:**
- Modify:
  - `src/lib/store.ts`: `inboxSuggestions`, `dismissCalSuggestion` sender learning, `removeNoDateSender`
  - `src/lib/ai/dates.ts`: `findToSuggestion(f, email, sectionId: string | undefined, calendarId)`
  - `src/components/date-chip.tsx`
  - `src/components/settings/settings-dialog.tsx`: the switch and the sender list in `Rules()`
- Test: `src/lib/__tests__/date-suggestions.test.ts`

**Interfaces and rules:**
- **`inboxSuggestions`:** include finds from any email that `isDateCandidate` would accept now, or that has a section with dates on. Simpler, and correct: include every `dateFinds` entry unless the email is in trash or spam, its section has dates **off**, or its sender is in `noDateSenders`. Pass `sectionId` only when the email is in a section.
- **`DateChip`:**
  - Show without a section.
  - Hue: the section's hue if any, otherwise the accent.
  - Keep the today/tomorrow needs-you hue.
  - Hide when the sender is in `noDateSenders`.
  - Selectors must return primitives or stable references.
- **Learning:**
  - `dismissCalSuggestion(id)` keeps what it does today. When the suggestion came from an email (`sug.emailId`), it also increments a persisted `dateDismissals: Record<senderAddress, number>`.
  - At 2, it adds the sender to `noDateSenders` and toasts "Won't suggest dates from <sender> anymore". The toast has an **Undo** that removes the sender and resets the count to 0.
  - `removeNoDateSender(addr)` deletes the sender from `noDateSenders` and resets its count.
- **Settings → Sorting & Rules**, a new group **Dates**, placed above "Always file" and below "Automatic rules" if that group exists:
  - A switch, **Find dates in your mail**, bound to `findDatesEverywhere`. Hint: "Offers to add due dates, deadlines and events to your calendar. Skips promotions and newsletters."
  - **No date suggestions from**: the senders, each with a remove button. Empty state: "None".

- [ ] Failing tests:
  - `inboxSuggestions` returns a find from non-section mail;
  - it hides finds from senders in `noDateSenders`;
  - it hides finds when the section has dates off;
  - a second dismissal from the same sender adds the sender;
  - `removeNoDateSender` re-enables it.
- [ ] Implement, including the chip and Settings.
- [ ] Run tsc and the full vitest, then commit with the message `Dates: suggest and chip dates without sections; stop after two Not nows`.

### Task 3: Inbox-aware message cache (Rust + TS)

**Files:**
- Modify:
  - `src-tauri/src/db.rs`: `cache_list_messages` gains `folders: Option<Vec<String>>`
  - `src/lib/db.ts`: `cacheListMessages(accountId, limit = 2000, folders?: string[])`
  - the browser (non-Tauri) fallback in `src/lib/db.ts`, if it has one
  - `src/lib/store.ts` `load()`
  - `src/lib/google/gmail.ts` and `src/lib/microsoft/graph.ts` `listMessages` (pass the Inbox folder id)
- Test: the Rust unit tests in `db.rs`, plus a TS test for the call site if practical

**Behaviour:**
- With `folders` given, the result is the union of the newest `limit` rows for the account and **all** rows whose `folder_id` is in `folders`, deduplicated by id and ordered by date descending.
- Without it, behaviour is unchanged.
- Add an index on `(account_id, folder_id)` (`CREATE INDEX IF NOT EXISTS`).
- The Inbox folder id comes from the account's folders, the one with `system === "inbox"`:
  - **Gmail:** its Inbox folder id. Check how `gmail-map` builds it.
  - **Graph:** the store/provider already knows its system folder id (`systemFolderId("inbox")`).
  - If it isn't known yet, call it without `folders`.
- Tauri command argument naming: the Rust parameter `folders` arrives from `invoke("cache_list_messages", { accountId, limit, folders })`. Match the existing camelCase convention.

- [ ] A failing Rust test: 2,500 rows, 2,100 of them in the Inbox and older than the 400 newest non-Inbox rows. The call with `folders=[inbox]` returns all 2,100 Inbox rows plus the newest rows up to the limit, deduplicated.
- [ ] Implement in Rust, then in TS. Wire up `load()` and both providers' `listMessages`.
- [ ] Run `cargo check`, `cargo test`, tsc and the full vitest, then commit with the message `Cache: always keep the whole Inbox when listing cached mail`.

### Task 4: Provider Inbox backfill pages

**Files:**
- Modify:
  - `src/lib/mail/provider.ts`: optional `backfillInbox?(cursor?: string): Promise<{ emails: Email[]; next?: string; total?: number }>`
  - `src/lib/google/gmail.ts`
  - `src/lib/microsoft/graph.ts`
  - `src/lib/mail/mock-provider.ts` (no-op: `{ emails: [] }`)
- Test: `src/lib/__tests__/gmail-provider.test.ts` and `src/lib/__tests__/graph.test.ts`, in their existing mocking styles

**Behaviour:**
- **Gmail:**
  - List one page of Inbox ids with `/messages?q=in:inbox&maxResults=500&pageToken=…`. Use `resultSizeEstimate` as `total`.
  - Skip ids already in the cache (`cacheListMessages(..., folders: [inbox])`, or the same cache check the sync uses).
  - Fetch the rest with the sync's full fetch (`fetchMessages`) in chunks of 25, and save each chunk to the cache as the sync does.
  - Return the newly fetched `Email`s and `next = nextPageToken`.
  - Quota pacing is automatic through `this.api`.
- **Graph:**
  - Fetch one page of `/me/mailFolders/inbox/messages?$select=${MSG_FIELDS}&$orderby=receivedDateTime desc&$top=100`. On later calls, use the `@odata.nextLink` passed back as the cursor.
  - Skip ids already cached, convert through the same `toEmails` path, and cache them.
  - Return `next` = nextLink. `total` is optional; Graph can give the folder's `totalItemCount`, so fetch it once when there's no cursor if that's easy.
- Never fetch outside the Inbox.

- [ ] Failing tests:
  - **Gmail:** two pages, where page 1 has 3 ids (1 already cached) and page 2 has 1 id. That gives 2 then 1 fetched, the first page's `next` is set, the last page has no `next`, and the list query uses `in:inbox`.
  - **Graph:** the same idea with nextLink.
- [ ] Implement.
- [ ] Run tsc and the full vitest, then commit with the message `Providers: page through the whole Inbox`.

### Task 5: Background backfill in the store, batched triage writes, progress UI

**Files:**
- Modify:
  - `src/lib/store.ts`: `backfill` state, the loop, batched triage `set`s
  - the existing sorting progress display: find the component that renders `sorting` ("Sorting done/total…" in the top bar and "Reading your inbox…" on Today) and add the backfill line next to it
- Test: `src/lib/__tests__/backfill-store.test.ts`, in the style of `store-counts.test.ts` (a fake MailProvider plus `vi.mock("@/lib/accounts")`)

**Behaviour:**
- **State:** `backfill: Record<accountId, { loaded: number; total?: number; running: boolean; error?: string }>`. Not persisted.
- **Cursor:** a per-account cursor persisted in kv under `backfill.<accountId>`, holding `{ next?: string; done?: boolean }`.
- **The loop:** after the first successful `refresh()` in a session, for each non-mock account whose provider has `backfillInbox` and whose saved cursor isn't `done`, run this sequentially, one account at a time:
  1. Call `backfillInbox(cursor)`.
  2. Merge the returned emails into `emails`: dedupe by id and keep the date order.
  3. `await applyAutoRules()`, then `await get().sort({ onlyNew: true, skip })`, using the same skip handling as `doRefresh`.
  4. Save `next`, or `done: true` when there's no `next`.
  5. Update `backfill[accountId]`.
  6. Pause about 500 ms before the next page.
- **Errors:** on error, record it in `backfill[accountId].error`, stop that account for this session, and keep the cursor so it resumes next session.
- **Guards:** never two loops at once (a module-level promise guard). A refresh mid-backfill is fine, since it's guarded separately.
- **Batched triage writes:** in `sort()`, buffer `triageAll` results and apply them with one `set` at most every 250 ms, plus a final flush, updating `sorting.done` by the batch size. Behaviour is otherwise unchanged.
- **UI:** while any `backfill[...]` is running, show "Loading older Inbox mail · {loaded} of ~{total}" (or "· {loaded}" when the total is unknown) wherever the sorting progress already shows, styled the same way. Show nothing when idle.

- [ ] Failing tests:
  - pages until there's no `next`, then saves `done`;
  - skips when the saved cursor says `done`;
  - resumes from the saved `next`;
  - new emails are sorted and rules run before sorting (assert the order with spies);
  - runs once per session (a second refresh doesn't restart it);
  - an error stops the account and keeps the cursor;
  - batched triage: 20 triage results produce far fewer than 20 store updates (spy on `set`, or count subscriber calls).
- [ ] Implement.
- [ ] Run tsc and the full vitest, then commit with the message `Inbox: sort the whole Inbox in the background`.
