# Date suggestions for all real mail, and sorting the whole Inbox: design

Date: 2026-10-11 · Status: approved in conversation ("yes.")

## Why

1. **Dates.** zMail never offered to add the user's credit card bill (due Oct 18) to the calendar. Date finding only ran on mail in a *section* with "catch dates" on, and the user has no sections, so it had never checked a single email. The user wants any email with a real date surfaced and offered, for example "Christmas band concert", but never marketing ("Prime Day is here!").
2. **Whole Inbox.** Today and Triage only sort the newest ~300 emails from the last 90 days. As the user files recent mail, older Inbox mail never takes its place. The user's Gmail Inbox has 665+ unread, while zMail's copy has 29.

## Part A: date suggestions

### Which emails get checked

An email is checked once, by the writing model, when all of these hold:
- It's in an Inbox and isn't a partial header row.
- It's at most 30 days old, so a whole-Inbox backfill doesn't send years of mail to the model.
- zMail's own triage didn't put it in the **promotions** or **newsletters** category. Gmail tabs and Outlook Focused are never used.
- Its sender isn't on the user's "no date suggestions" list (see Learning below).
- A cheap local check passes: subject or body (first 5,000 characters) mentions a date or time. That means a month name or abbreviation followed by a day, a numeric date (`12/12`, `12-12-2026`, `2026-12-12`), a weekday name, "today", "tonight", "tomorrow" or "next week", or a clock time (`6:30 PM`, `18:30`).

Section mail with "catch dates" on is checked as today, and it skips the 30-day and local-check limits. Section mail with catch dates **off** isn't checked; the switch keeps its meaning.

A new setting, **Find dates in your mail**, is on by default. It lives in Settings → Sorting & Rules and covers all non-section mail. Turning it off restores the old behaviour.

### What the model keeps

The prompt is rewritten so it doesn't depend on a section, and the section line becomes optional.
- **Keep:** dates that need the user to act or show up: bills and payments due, deadlines (forms, sign-ups, permission slips, renewals the user must act on), appointments, reservations, travel, school, family and community events, RSVPs, closures.
- **Ignore:** marketing and sales dates: sale or offer ends, "Prime Day", launches, webinar or event pitches from companies selling something, "limited time", shipping estimates, newsletter publication dates. Also past dates, the sent date and vague dates.
- **When unsure,** leave it out.

The existing `parseDates` safeguards stay: at most 6 finds, within a year, upcoming dates only, and only well-formed dates are kept.

### Where finds show up

- **Today → "From your inbox"** (`inboxSuggestions`): upcoming finds from any checked email, with **Add** / **Not now** as today. Accepted and dismissed suggestions are remembered (`calChanges.resolved`).
- **Date chip** (`DateChip`) on email rows in Today, Triage and lists, whether or not the email is in a section:
  - Section mail keeps its section hue.
  - Other mail uses the accent hue.
  - Today or tomorrow use the needs-you hue.
- **Calendar view suggestions** use the same function, so they follow automatically.

`findToSuggestion` takes an optional `sectionId`.

### Learning from "Not now"

When the user dismisses date suggestions from the same sender address twice, that address is added to `noDateSenders` (persisted in `state.v1`). It's no longer checked, and its existing suggestions are hidden.

Settings → Sorting & Rules shows **No date suggestions from** with a remove button for each sender, under the new switch.

### Running

`findDates()` already runs after sorting and on section changes. Keep those triggers.
- Concurrency stays at 2.
- The failure back-off stays at 30 minutes.
- Also call it once after load, which covers the user's current Inbox.
- Emails already in `dateFinds` are skipped.
- The once-per-email cache (`dateFinds[id]`, persisted) means each email is read by the model at most once.

## Part B: sort the whole Inbox

### Fetching

On each account, after the existing sync, a **background Inbox backfill** pages through *all* messages currently in the Inbox, newest first, and adds the ones zMail doesn't have yet to the local cache and the store:
- **Gmail:** `q=in:inbox` with the same full-message fetching the sync uses.
- **Outlook:** the Inbox folder's messages.

The backfill:
- Runs once per account per app session, after the first successful refresh.
- Resumes from a persisted page cursor per account if it was interrupted.
- Stops when the Inbox is exhausted.
- Respects the existing Gmail quota pacing and Graph throttling behaviour.
- Fetches in pages of 100 with a short pause between pages, so the app stays responsive.

A small progress line ("Loading older Inbox mail · 400 of ~1,200") shows where the existing sorting progress shows. It disappears when done.

Mail outside the Inbox is never backfilled. The 90-day window for everything else is unchanged. Messages the user later moves out of the Inbox stay in the cache like any other synced mail and leave Today and Triage as they do today.

Gmail lists Inbox ids with the existing search paging (`q: "in:inbox"`, 500 ids per page), skips ids already cached, and fetches the rest with the sync's full-message fetch. That's paced by the existing quota limiter, about 250 messages a minute. Outlook pages `/me/mailFolders/inbox/messages` 100 at a time with the sync's fields, one page at a time; on an error it stops and resumes next session. The mock provider's backfill does nothing.

### Sorting

Backfilled mail goes through the existing `sort({ onlyNew: true })`, newest first, in the background, and automatic rules run before sorting as they do for new mail.
- Mail the decision model has already sorted (`triage[id]`) is never re-sorted.
- Each email costs one decision-model request, once.
- **The cache must not drop Inbox mail.** Today `cache_list_messages` returns the newest 2,000 rows per account across all folders, so a large Inbox would be cut off on the next launch. Make the list folder-aware: return the newest 2,000 rows **plus every row in the given folder ids** (the account's Inbox), deduplicated, newest first. `load()` and the providers' `listMessages` pass the account's Inbox folder id.
- **Batch the triage writes.** Today each triaged email is its own store `set`, so a backlog of thousands re-renders Today and Triage thousands of times. Results are buffered and applied together at most every 250 ms, along with the progress count.

### Performance

The store may grow from hundreds to several thousand emails. Selectors and `homeGroups` already filter over `emails` per render. That's acceptable at this size, but avoid adding new per-render O(n²) work, and keep persisted snapshot fields keyed by id. Triage for a few thousand emails is fine in `state.v1`.

## Safety and constraints

- Gmail tabs, `CATEGORY_*` labels and Outlook Focused are never used. Only zMail's own triage categories are.
- No new network calls beyond the providers already used and the configured writing and decision models.
- Real accounts and real model keys are never used in tests. Browser checks use the demo account.

## Testing

- **Local check:** month-and-day, numeric, weekday, relative and clock-time phrases pass; plain text without dates fails.
- **Candidates:**
  - The promotions and newsletters categories are excluded.
  - A sender on `noDateSenders` is excluded.
  - The 30-day cutoff applies, except for section mail.
  - Section mail with dates on is included even without the local check.
  - Section mail with dates off is excluded.
  - The setting off restores the old behaviour.
- **Prompt:** the marketing rules are present, and it works with no section.
- **Surfacing:** `inboxSuggestions` and `DateChip` work without sections; `noDateSenders` hides suggestions.
- **Learning:** a second Not now from the same sender adds it; removing it in Settings re-enables it.
- **Backfill:**
  - pages until exhausted;
  - skips known ids;
  - resumes from its cursor;
  - runs once per session;
  - newly backfilled mail is sorted and rules run before sorting;
  - the cache limit keeps the whole Inbox across a reload.
