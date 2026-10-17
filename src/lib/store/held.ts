// Search results that weren't loaded, held in the store while a search is open.
//
// Search across all mail finds rows only the local cache has (older mail outside the newest
// rows per account). To open or act on one, it has to be in `emails`: the reader, the
// composer and every mail action look emails up there by id. Such a row is "held": it's in
// `emails`, but everything that walks the mailbox leaves it out, so showing or opening search
// results changes nothing else. Held rows aren't inbox mail (isInbox is false, so no triage,
// rules, dates, Today, Triage or notifications), aren't listed in folder views, aren't counted
// (unread, starred) and aren't saved. They're dropped from `emails` when the search ends.
//
// The set only changes together with a new `emails` array, so selectors cached per array
// (unreadByFolder, starredCount, …) never see a stale answer.

export const held = new Set<string>();
