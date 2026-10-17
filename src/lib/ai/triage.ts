// Turns an email (+ the user's filing history) into one decision request and
// maps the typed answers back into a Triage record.

import type {
  Bucket,
  Category,
  Email,
  Folder,
  SenderHabit,
  Triage,
} from "@/lib/types";
import { BUCKETS } from "@/lib/types";
import { NO_SECTION, sectionHistory, sectionQuestion, sectionsFor, sectionsKey, type MailSection } from "@/lib/sections";
import type {
  ChoiceAnswer,
  DecisionProvider,
  DecisionRequest,
  NoulAnswer,
  Question,
  ScoreAnswer,
} from "./decision";

/** What the user has shown zMail about one sender, as examples rather than rules. */
export interface SenderExamples {
  /** Emails whose kind the user corrected, newest first. */
  categories?: { subject: string; category: Category }[];
  /** Emails the user moved to another bucket, newest first. */
  buckets?: { subject: string; bucket: Bucket }[];
  /** Section id → subjects of this sender's mail already in its linked label. */
  sections?: Record<string, string[]>;
}

const BODY_CHARS = 2400; // keep state well under the 16k-token Clef default
export const STAY = "stay_in_inbox";
/** Decision models cap a choice at 255 options; big trees are narrowed first. */
const MAX_CANDIDATES = 40;

function pathOf(folders: Folder[], id: string) {
  const parts: string[] = [];
  let f = folders.find((x) => x.id === id);
  while (f) {
    if (f.system !== "inbox") parts.unshift(f.name);
    f = f.parentId ? folders.find((x) => x.id === f!.parentId) : undefined;
  }
  return parts.join(" › ");
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9&]+/)
    .filter((w) => w.length > 2 && !["the", "and", "for", "your", "from", "with", "you"].includes(w));

/**
 * Pick the folders worth asking the model about: everything the sender has
 * been filed into, then folders whose path shares words with the sender,
 * domain or subject. Small trees are passed through whole.
 */
export function candidateFolders(
  email: Email,
  folders: Folder[],
  habit: SenderHabit | undefined,
  max = MAX_CANDIDATES,
): Folder[] {
  const targets = folders.filter((f) => !f.system);
  if (targets.length <= max) return targets;
  const signal = new Set(
    words(`${email.from.name} ${email.from.address.split("@")[1] ?? ""} ${email.subject}`),
  );
  const scored = targets.map((f) => {
    let score = (habit?.byFolder[f.id] ?? 0) * 10;
    for (const w of words(pathOf(folders, f.id))) if (signal.has(w)) score += 3;
    return { f, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.f);
}

const QUESTIONS = {
  bucket: {
    type: "choice",
    instructions:
      "Which inbox bucket does this email belong in for the user right now?",
    criteria: {
      needs_you:
        "A specific person wrote to the user and is waiting on them to act, decide or reply; or a real deadline or approval that only the user can handle: a bill or payment coming due, a form or request awaiting their approval, a required report or submission that is due. Threads the user is only cc'd on, statements, receipts, deliveries, notices and anything selling or inviting do not count.",
      worth_skim:
        "Real business the user may want to know about, with nothing they have to do: work threads they are only cc'd on, announcements from their own organization or the people they work with, statements or documents now available, schedule and status updates, notices about their own accounts and services. Never marketing, promotions, newsletters, digests or social notifications, however relevant they look.",
      ready_archive:
        "Automated, promotional or done: marketing, unsolicited sales outreach, webinar and event promotion, newsletters and digests, social notifications, receipts, order, shipping and delivery updates, expired or already-handled items. Safe to archive without reading.",
    },
  },
  category: {
    type: "choice",
    instructions: "What kind of email is this?",
    criteria: {
      primary: "Personal or work correspondence written by a person to the user.",
      transactions: "Receipts, invoices, orders, payments, shipping, bills and statements for money the user owes or spent.",
      updates:
        "Something factual about the user's own accounts, services, claims, appointments, school or work systems that they would want to know, such as a claim processed, a balance low, an account changed or an assignment graded. Not anything trying to get the user to buy, use or come back to a product.",
      promotions:
        "Anything whose purpose is to sell, upsell or re-engage: sales, offers, deals, rewards and points statements, product and feature announcements, \"see what's new\", \"you have notifications waiting\", \"come back\" and \"try our new…\" nudges, event and webinar promotion. Branded senders writing as if they were notifications still belong here.",
      social:
        "Activity on social networks and communities: posts, likes, follows, friend requests, impressions, \"people are messaging you\" digests from TikTok, LinkedIn, Facebook, Instagram, X, Nextdoor and similar.",
      newsletters: "Recurring editorial content the user subscribed to read: newsletters, digests, blogs, columns.",
      security: "Sign-in links, verification codes, password and security alerts.",
    },
  },
  urgency: {
    type: "score",
    instructions: "How time-sensitive is this email for the user?",
    criteria: [
      "Not time-sensitive at all.",
      "Can wait a few days.",
      "Should be handled today.",
      "Needs attention within the hour.",
    ],
  },
  needs_reply: {
    type: "noul",
    instructions: "Does the sender expect a written reply from the user?",
    criteria: {
      true: "The sender asked a question or is waiting on the user's response.",
      false: "No reply is expected.",
    },
  },
} satisfies Record<string, Question>;

export function buildRequest(
  email: Email,
  me: { name: string; address: string },
  folders: Folder[],
  habit: SenderHabit | undefined,
  maxChoiceOptions = 255,
  allSections: MailSection[] = [],
  examples: SenderExamples = {},
): DecisionRequest {
  // One option is reserved for "stay in inbox".
  const targets = candidateFolders(email, folders, habit, Math.min(MAX_CANDIDATES, maxChoiceOptions - 1));
  const name = (id: string) => folders.find((f) => f.id === id)?.name ?? id;

  const questions: Record<string, Question> = { ...QUESTIONS };
  if (targets.length) {
    questions.folder = {
      type: "choice",
      instructions:
        "The user files mail into folders. Based on the sender's filing history and the content, where would the user most likely file this email? Choose stay_in_inbox unless there is a clear pattern.",
      criteria: {
        [STAY]: "Leave it in the inbox; no clear filing pattern.",
        ...Object.fromEntries(
          targets.map((f) => [f.id, `Folder "${pathOf(folders, f.id)}"`]),
        ),
      },
    };
  }

  const sections = sectionsFor(allSections, email.accountId);
  const section = sectionQuestion(sections, maxChoiceOptions);
  if (section) questions.section = section;
  const inSections = sectionHistory(sections, habit, examples.sections);

  return {
    state: {
      user: me,
      email: {
        from: email.from,
        to: email.to,
        cc: email.cc ?? [],
        subject: email.subject,
        date: email.date,
        unread: email.unread,
        body: email.text.slice(0, BODY_CHARS),
      },
      sender_history: habit
        ? {
            emails_filed: habit.total,
            filed_into: Object.entries(habit.byFolder)
              .sort((a, b) => b[1] - a[1])
              .map(([id, count]) => ({ folder: pathOf(folders, id) || name(id), folder_id: id, count })),
          }
        : { emails_filed: 0, filed_into: [] },
      ...(examples.categories?.length
        ? {
            user_corrected_category: {
              note: "The user corrected the category of these past emails from this sender. If this email is like one of them, use the corrected category; if it's a different kind of email, judge it on its own content.",
              examples: examples.categories.map((x) => ({ subject: x.subject, corrected_to: x.category })),
            },
          }
        : {}),
      ...(examples.buckets?.length
        ? {
            user_corrected_bucket: {
              note: "The user moved these past emails from this sender to a different bucket. If this email is like one of them, use the bucket they chose; if it's a different kind of email, judge it on its own content.",
              examples: examples.buckets.map((x) => ({ subject: x.subject, moved_to: x.bucket })),
            },
          }
        : {}),
      ...(inSections.length ? { section_history: inSections } : {}),
    },
    questions,
  };
}

/** Kinds of mail that always go to Ready to archive, whatever the bucket answer says. */
const ARCHIVE_KINDS: readonly Category[] = ["promotions", "social", "newsletters"];

/**
 * The bucket and category questions are answered separately, so the model can call an
 * email a promotion and still say it needs you or is worth a skim. Its own category wins:
 * Needs you and Worth a skim are for real business, so such mail is ready to archive.
 */
export function consistentBucket(t: Pick<Triage, "bucket" | "category">): Bucket {
  return ARCHIVE_KINDS.includes(t.category) ? "ready_archive" : t.bucket;
}

export async function triageEmail(
  provider: DecisionProvider,
  email: Email,
  me: { name: string; address: string },
  folders: Folder[],
  habit: SenderHabit | undefined,
  sections: MailSection[] = [],
  examples?: SenderExamples,
): Promise<Triage> {
  const res = await provider.decide(buildRequest(email, me, folders, habit, provider.maxChoiceOptions, sections, examples));
  const a = res.answers;
  const bucket = a.bucket as ChoiceAnswer;
  const category = a.category as ChoiceAnswer;
  const urgency = a.urgency as ScoreAnswer;
  const reply = a.needs_reply as NoulAnswer;
  const folder = a.folder as ChoiceAnswer | undefined;
  const section = a.section as ChoiceAnswer | undefined;

  const bucketProbs = Object.fromEntries(
    BUCKETS.map((b) => [b, bucket.probabilities[b] ?? 0]),
  ) as Record<Bucket, number>;

  let suggestion: Triage["folder"];
  if (folder && folder.choice !== STAY) {
    suggestion = {
      folderId: folder.choice,
      probability: folder.confidence,
      evidence: habit
        ? { filed: habit.byFolder[folder.choice] ?? 0, total: habit.total }
        : undefined,
    };
  }

  return {
    emailId: email.id,
    bucket: consistentBucket({ bucket: bucket.choice as Bucket, category: category.choice as Category }),
    bucketProbs,
    category: category.choice as Category,
    urgency: urgency.score,
    needsReply: reply.noul,
    folder: suggestion,
    section: section && section.choice !== NO_SECTION ? section.choice : undefined,
    sectionsKey: sectionsKey(sections, email.accountId) || undefined,
    model: res.model,
  };
}

/** How a triageAll run went: emails sorted, emails whose request failed, and the last failure. */
export interface TriageRun {
  done: number;
  failed: number;
  lastError?: string;
}

/** Run triage over many emails with bounded concurrency. One failed email doesn't stop the rest. */
export async function triageAll(
  provider: DecisionProvider,
  emails: Email[],
  ctx: {
    me: { name: string; address: string };
    folders: Folder[];
    habits: Map<string, SenderHabit>;
    sections?: MailSection[];
    /** Sender address → examples of their mail the user corrected or filed in a section. */
    examples?: Map<string, SenderExamples>;
  },
  onResult: (t: Triage) => void,
  concurrency = 6,
): Promise<TriageRun> {
  let next = 0;
  const run: TriageRun = { done: 0, failed: 0 };
  const worker = async () => {
    while (next < emails.length) {
      const email = emails[next++];
      try {
        const folders = ctx.folders.filter((f) => f.accountId === email.accountId);
        const sender = email.from.address.toLowerCase();
        const habit = ctx.habits.get(sender);
        onResult(await triageEmail(provider, email, ctx.me, folders, habit, ctx.sections, ctx.examples?.get(sender)));
        run.done++;
      } catch (err) {
        console.error("[triage]", email.id, err);
        run.failed++;
        run.lastError = String(err);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return run;
}
