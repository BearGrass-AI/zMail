// What the user did (moves, rules, corrections, snoozes, calendar edits) is
// saved to the local database and restored on launch.

import type { AutoRule } from "@/lib/rules";
import { BUCKETS, CATEGORIES, type Bucket, type Category, type SenderHabit, type Triage } from "@/lib/types";
import type { MockOverlay } from "@/lib/mail/mock-provider";
import { kvSet } from "@/lib/db";
import { consistentBucket } from "@/lib/ai/triage";
import type { DateFind } from "@/lib/ai/dates";
import type { MailSection } from "@/lib/sections";
import { migrateTextSignatures, type MailSignature, type SignatureDefaults } from "@/lib/signature";
import { useMail } from "@/lib/store";
import type { Lesson } from "./learning";
import type { DraftSignature, MailState, Resolution } from "./types";
import { held } from "./held";
import { validRopeLineFlags, type RopeLineFlag } from "@/lib/ropeline";
import { DRAFT_SIGNATURES_CAP, validDraftSignatures } from "./draft-signatures";

export const SNAPSHOT_KEY = "state.v1";
const AUTO_HANDLED_CAP = 5000;
/** Saved triage and resolved entries for mail that isn't loaded (it may still be in the mailbox): the most recent ones. */
export const RESULTS_CAP = 5000;

export interface Snapshot {
  rules: Record<string, string>;
  autoRules?: AutoRule[];
  autoHandled?: string[];
  overrides: Record<string, Bucket>;
  laneRuled?: Record<string, Bucket>;
  categoryOverrides?: Record<string, Category>;
  dismissed: string[];
  snoozed: Record<string, number>;
  habits: [string, SenderHabit][];
  triage: Record<string, Triage>;
  hiddenCalendars: string[];
  calChanges: MailState["calChanges"];
  mockOverlay: MockOverlay;
  imageSenders?: string[];
  /** v1 plain-text signatures per account; migrated to signatureList. */
  signatures?: Record<string, string>;
  signatureList?: MailSignature[];
  accountFilter?: string | null;
  signatureDefaults?: Record<string, SignatureDefaults>;
  draftSignatures?: DraftSignature[];
  sections?: MailSection[];
  sectionOverrides?: Record<string, string | null>;
  lessons?: Lesson[];
  dateFinds?: Record<string, DateFind[]>;
  noDateSenders?: Record<string, true>;
  dateDismissals?: Record<string, string[]>;
  resolved?: Record<string, Resolution>;
  ropelineFlags?: Record<string, RopeLineFlag>;
}

/**
 * Entries (triage, resolved) to save: every one for loaded mail, plus the RESULTS_CAP most recently added of the rest.
 * Ids are raw provider ids that don't name their account, and unloaded mail may still be in the mailbox, so the cap
 * bounds what's kept rather than dropping everything not loaded.
 */
function capResults<T>(byId: Record<string, T>, emailIds: Set<string>): Record<string, T> {
  const entries = Object.entries(byId);
  const rest = entries.filter(([id]) => !emailIds.has(id));
  if (rest.length <= RESULTS_CAP) return byId;
  const kept = new Set(rest.slice(-RESULTS_CAP).map(([id]) => id));
  return Object.fromEntries(entries.filter(([id]) => emailIds.has(id) || kept.has(id)));
}

/**
 * The state field each Snapshot field is saved from (the v1 `signatures` field is only read back).
 * A Snapshot field missing here, or an entry Snapshot doesn't have, fails tsc; SAVED_KEYS is
 * derived from it, and snapshot() can read only these fields (and emails).
 */
const SAVED_FROM = {
  rules: "rules",
  autoRules: "autoRules",
  autoHandled: "autoHandled",
  overrides: "overrides",
  laneRuled: "laneRuled",
  categoryOverrides: "categoryOverrides",
  dismissed: "dismissed",
  snoozed: "snoozed",
  habits: "habits",
  triage: "triage",
  hiddenCalendars: "hiddenCalendars",
  calChanges: "calChanges",
  mockOverlay: "accounts",
  imageSenders: "imageSenders",
  signatureList: "signatures",
  accountFilter: "accountFilter",
  signatureDefaults: "signatureDefaults",
  draftSignatures: "draftSignatures",
  sections: "sections",
  sectionOverrides: "sectionOverrides",
  lessons: "lessons",
  dateFinds: "dateFinds",
  noDateSenders: "noDateSenders",
  dateDismissals: "dateDismissals",
  resolved: "resolved",
  ropelineFlags: "ropelineFlags",
} as const satisfies Record<Exclude<keyof Snapshot, "signatures">, keyof MailState>;
type SavedKey = (typeof SAVED_FROM)[keyof typeof SAVED_FROM];

// Typed so it can read only saved fields (and emails) and must write every Snapshot field.
export function snapshot(s: Pick<MailState, SavedKey | "emails">): Required<Omit<Snapshot, "signatures">> {
  const mockAccounts = new Set(s.accounts.filter((a) => a.kind === "mock").map((a) => a.id));
  const mockOverlay: MockOverlay = {};
  // Search results held in the store (see held.ts) are saved as if they weren't loaded.
  const saved = held.size ? s.emails.filter((e) => !held.has(e.id)) : s.emails;
  for (const e of saved)
    if (mockAccounts.has(e.accountId)) mockOverlay[e.id] = { folderId: e.folderId, unread: e.unread, starred: e.starred };
  const emailIds = new Set(saved.map((e) => e.id));
  return {
    rules: s.rules,
    autoRules: s.autoRules,
    autoHandled: Object.keys(s.autoHandled).slice(-AUTO_HANDLED_CAP),
    overrides: s.overrides,
    laneRuled: s.laneRuled,
    categoryOverrides: s.categoryOverrides,
    dismissed: [...s.dismissed],
    snoozed: Object.fromEntries(Object.entries(s.snoozed).filter(([, t]) => t > Date.now())),
    habits: [...s.habits.entries()],
    triage: capResults(s.triage, emailIds),
    hiddenCalendars: [...s.hiddenCalendars],
    calChanges: s.calChanges,
    mockOverlay,
    imageSenders: [...s.imageSenders],
    signatureList: s.signatures,
    accountFilter: s.accountFilter,
    signatureDefaults: s.signatureDefaults,
    draftSignatures: s.draftSignatures.slice(-DRAFT_SIGNATURES_CAP),
    sections: s.sections,
    sectionOverrides: s.sectionOverrides,
    lessons: s.lessons,
    // Only for mail still around; past dates drop out on their own.
    dateFinds: Object.fromEntries(Object.entries(s.dateFinds).filter(([id]) => emailIds.has(id))),
    noDateSenders: s.noDateSenders,
    dateDismissals: s.dateDismissals,
    resolved: capResults(s.resolved, emailIds),
    ropelineFlags: capResults(s.ropelineFlags, emailIds),
  };
}

export function restore(snap: Snapshot, _habits: Map<string, SenderHabit>) {
  useMail.setState((s) => {
    const deleted = new Set(snap.calChanges?.deleted ?? []);
    const resolved = new Set(snap.calChanges?.resolved ?? []);
    const added = snap.calChanges?.added ?? [];
    return {
      rules: snap.rules ?? {},
      autoRules: snap.autoRules ?? [],
      autoHandled: Object.fromEntries((snap.autoHandled ?? []).map((id) => [id, true as const])),
      overrides: snap.overrides ?? {},
      laneRuled: snap.laneRuled ?? {},
      categoryOverrides: snap.categoryOverrides ?? {},
      dismissed: new Set(snap.dismissed ?? []),
      snoozed: snap.snoozed ?? {},
      // An entry with a bucket or kind zMail doesn't know is dropped, so the email is sorted again. Sorted before
      // the bucket/category consistency rule: apply it now, no re-sort needed.
      triage: Object.fromEntries(
        Object.entries(snap.triage ?? {})
          .filter(([, t]) => BUCKETS.includes(t?.bucket) && CATEGORIES.includes(t.category))
          .map(([id, t]) => [id, { ...t, bucket: consistentBucket(t) }]),
      ),
      hiddenCalendars: new Set(snap.hiddenCalendars ?? []),
      imageSenders: new Set(snap.imageSenders ?? []),
      accountFilter: snap.accountFilter && s.accounts.some((a) => a.id === snap.accountFilter) ? snap.accountFilter : null,
      // Kept only for accounts still here.
      draftSignatures: validDraftSignatures(snap.draftSignatures).filter((r) => s.accounts.some((a) => a.id === r.accountId)),
      sections: snap.sections ?? [],
      sectionOverrides: snap.sectionOverrides ?? {},
      lessons: snap.lessons ?? [],
      dateFinds: snap.dateFinds ?? {},
      noDateSenders: snap.noDateSenders ?? {},
      resolved: snap.resolved ?? {},
      ropelineFlags: validRopeLineFlags(snap.ropelineFlags),
      dateDismissals: Object.fromEntries(
        Object.entries(snap.dateDismissals ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v : []]),
      ),
      ...(snap.signatureList
        ? { signatures: snap.signatureList, signatureDefaults: snap.signatureDefaults ?? {} }
        : (({ list, defaults }) => ({ signatures: list, signatureDefaults: defaults }))(
            migrateTextSignatures(snap.signatures ?? {}, (id) => s.accounts.find((a) => a.id === id)?.address ?? "Signature"),
          )),
      calChanges: { added, deleted: [...deleted], resolved: [...resolved] },
      events: [...s.events.filter((e) => !deleted.has(e.id)), ...added.filter((a) => !s.events.some((e) => e.id === a.id))],
      calSuggestions: s.calSuggestions.filter((x) => !resolved.has(x.id)),
    };
  });
}

const AUTOSAVE_SETTLE_MS = 600;
const AUTOSAVE_MAX_WAIT_MS = 2000;
// State fields that snapshot() persists (emails is handled separately: demo accounts only).
const SAVED_KEYS: readonly SavedKey[] = Object.values(SAVED_FROM);

let autosaveStarted = false;
export function startAutosave() {
  if (autosaveStarted) return;
  autosaveStarted = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  const save = () => {
    clearTimeout(timer);
    clearTimeout(maxTimer);
    timer = maxTimer = undefined;
    if (!dirty) return;
    dirty = false;
    kvSet(SNAPSHOT_KEY, snapshot(useMail.getState())).catch((err) => console.error("[persist] save failed", err));
  };
  useMail.subscribe((s, prev) => {
    const changed =
      SAVED_KEYS.some((k) => s[k] !== prev[k]) ||
      (s.emails !== prev.emails && s.accounts.some((a) => a.kind === "mock"));
    if (!changed) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(save, AUTOSAVE_SETTLE_MS);
    maxTimer ??= setTimeout(save, AUTOSAVE_MAX_WAIT_MS);
  });
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", save);
  }
}
