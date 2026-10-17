// Bulk actions on many emails (the assistant's act tool, and anything else
// that needs to edit hundreds at once): types, the approval rule, and labels.

import type { Bucket, Email } from "@/lib/types";
import type { Lesson } from "@/lib/store";

export type BulkOp =
  | { kind: "archive" }
  | { kind: "trash" }
  | { kind: "spam" }
  | { kind: "move"; folderId: string }
  | { kind: "read"; read: boolean }
  | { kind: "star"; starred: boolean }
  | { kind: "section"; sectionId: string | null }
  | { kind: "lane"; lane: Bucket };

/** How an email was before a bulk action, so Undo can put it back. */
export interface UndoEntry {
  id: string;
  accountId: string;
  folderId: string;
  unread: boolean;
  starred: boolean;
  /** Provider labels before the action, so Undo can restore them exactly. */
  labels?: string[];
  /** The section lesson this email had before a section action (undefined = none). */
  sectionLesson?: Lesson;
  /** Previous section override; undefined = none. */
  section?: string | null;
  /** Previous lane override (undefined = none), whether a lane rule set it, and the lane lesson this email had, for a lane action. */
  bucket?: Bucket;
  bucketRuled?: boolean;
  bucketLesson?: Lesson;
}

export interface BulkResult {
  done: number;
  skipped: number;
  /** Emails not processed because a batch failed or the action was stopped (Resume retries these). */
  failed: Email[];
  undo: UndoEntry[];
  error?: string;
}

export interface BulkOptions {
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

export const DIRECT_LIMIT = 25;
const UNDOABLE: BulkOp["kind"][] = ["archive", "read", "star", "section", "lane"];

/** Undoable ops on up to 25 emails run directly; everything else shows a confirm card. */
export function needsConfirm(op: BulkOp, count: number) {
  return !UNDOABLE.includes(op.kind) || count > DIRECT_LIMIT;
}

export function opText(op: BulkOp, names: { folder?: string; section?: string } = {}): { verb: string; past: string } {
  switch (op.kind) {
    case "archive":
      return { verb: "Archive", past: "Archived" };
    case "trash":
      return { verb: "Move to Trash", past: "Moved to Trash" };
    case "spam":
      return { verb: "Mark as spam", past: "Marked as spam" };
    case "move":
      return { verb: `Move to ${names.folder ?? "folder"}`, past: `Moved to ${names.folder ?? "folder"}` };
    case "read":
      return op.read ? { verb: "Mark read", past: "Marked read" } : { verb: "Mark unread", past: "Marked unread" };
    case "star":
      return op.starred ? { verb: "Star", past: "Starred" } : { verb: "Unstar", past: "Unstarred" };
    case "section":
      return op.sectionId ? { verb: `Put in ${names.section ?? "section"}`, past: `Put in ${names.section ?? "section"}` } : { verb: "Take out of sections", past: "Taken out of sections" };
    case "lane": {
      const label = { needs_you: "Needs you", worth_skim: "Worth a skim", ready_archive: "Ready to archive" }[op.lane];
      return { verb: `Put in ${label}`, past: `Put in ${label}` };
    }
  }
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
