// Offline stand-in for Jev / Clef. Accepts the exact same request and returns
// the same response shape, using keyword heuristics instead of a model, so the
// rest of the app is provider-agnostic.

import {
  choiceFrom,
  scoreFrom,
  type Answer,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
} from "./decision";
import { STAY } from "./triage";
import { NO_SECTION } from "@/lib/sections";

type MockState = {
  email?: {
    from?: { name?: string; address?: string };
    subject?: string;
    body?: string;
    date?: string;
  };
  sender_history?: {
    emails_filed: number;
    filed_into: { folder_id: string; count: number }[];
  };
  section_history?: { section_id: string; sender_emails_in_it?: number; example_subjects?: string[] }[];
  user_corrected_category?: { examples: { subject: string; corrected_to: string }[] };
};

const STOP = new Set("the and for from with your you any that this what about anything saying my our are was".split(" "));
const stems = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.replace(/(ies|es|s)$/, ""));

const has = (s: string, re: RegExp) => re.test(s);

function classify(state: MockState) {
  const e = state.email ?? {};
  const addr = (e.from?.address ?? "").toLowerCase();
  const text = `${e.subject ?? ""}\n${e.body ?? ""}`.toLowerCase();
  const local = addr.split("@")[0];
  const automated =
    has(addr, /no-?reply|notifications?|mailer|news|hello@|team@|info@|updates@/) ||
    has(local, /^(provost|budget|infosec|scores|auto-confirm|deltaairlines|connectevents|support|billing|alerts?)$/);
  const ageHours = e.date ? (Date.now() - Date.parse(e.date)) / 36e5 : 0;

  const cat = {
    security: has(text, /verification code|sign[- ]?in|magic link|secure link|password|2fa|one-time/) ? 4 : 0,
    transactions: has(text, /receipt|invoice|order|payment|shipped|statement|purchase|refund/) ? 3 : 0,
    promotions: has(text, /% off|\$\d+ off|sale|offer|discount|last chance|seats|register now|early bird|rewards|points|what's new|try (the|our) new|come back|waiting for you/) ? (automated ? 3 : 0.5) : 0,
    social: has(`${addr} ${text}`, /tiktok|linkedin|facebook|instagram|nextdoor|posted|impressions|new follower|friend request|liked your/) ? 3.5 : 0,
    newsletters: has(text, /newsletter|digest|this week|issue #|weekly|roundup|unsubscribe/) ? 2 : 0,
    updates: automated ? 2 : 0,
    primary: automated ? 0 : 3,
  };
  if (!automated && has(text, /\?/)) cat.primary += 1;
  if (has(text, /unsubscribe/)) (cat.primary -= 2.5), (cat.promotions += 1);
  // A correction on a similar email from this sender outweighs keywords;
  // dissimilar corrections don't apply.
  const subject = new Set(stems(e.subject ?? ""));
  let best: { k: string; hits: number } | undefined;
  for (const x of state.user_corrected_category?.examples ?? []) {
    const hits = stems(x.subject).filter((w) => subject.has(w)).length;
    if (hits && (!best || hits > best.hits)) best = { k: x.corrected_to, hits };
  }
  if (best && best.k in cat) cat[best.k as keyof typeof cat] += 5 + best.hits;

  const question = !automated && !has(text, /unsubscribe/) && has(text, /\?|can you|could you|let me know|thoughts/);
  const urgentWords = has(text, /urgent|asap|today|eod|by end of day|deadline|tomorrow/);
  const noAction = has(text, /no action needed|close the loop|just fyi|no need to reply/);
  return { cat, automated, question: question && !noAction, urgentWords, ageHours, noAction };
}

function answerFor(key: string, criteria: unknown, state: MockState): Answer {
  const c = classify(state);
  const category = choiceFrom(c.cat).choice;

  switch (key) {
    case "category":
      return choiceFrom(c.cat);

    case "bucket": {
      const s = { needs_you: 0, worth_skim: 0.5, ready_archive: 0 };
      if (category === "primary") s.needs_you += c.question ? 3 : 1.5;
      if (c.noAction) (s.needs_you -= 4), (s.worth_skim += 2);
      if (c.urgentWords) s.needs_you += 1.5;
      if (category === "promotions") s.ready_archive += 3;
      if (category === "social") s.ready_archive += 2, (s.worth_skim += 0.5);
      if (category === "security") s.ready_archive += c.ageHours > 1 ? 3.5 : 0.5;
      if (category === "security" && c.ageHours <= 1) s.needs_you += 1.5;
      if (category === "newsletters") s.worth_skim += 1.5;
      if (category === "updates") s.worth_skim += 1, (s.ready_archive += 0.8);
      if (category === "transactions") s.worth_skim += 1.5;
      return choiceFrom(s);
    }

    case "urgency": {
      const raw = [1.5, 1, 0, -1];
      if (c.urgentWords) (raw[2] += 2), (raw[3] += 1.5);
      if (c.question) raw[1] += 1, (raw[2] += 1);
      if (category === "security" && c.ageHours <= 1) raw[3] += 3;
      return scoreFrom(4, raw);
    }

    case "needs_reply":
      return { type: "noul", noul: c.question ? 0.86 : c.automated ? 0.03 : 0.22 };

    case "folder": {
      const options = Object.keys(criteria as Record<string, string>);
      const h = state.sender_history;
      const scores: Record<string, number> = Object.fromEntries(
        options.map((o) => [o, o === STAY ? 1.2 : -1]),
      );
      if (h && h.emails_filed >= 2) {
        for (const f of h.filed_into) {
          if (!(f.folder_id in scores)) continue;
          const share = f.count / h.emails_filed;
          scores[f.folder_id] = -1 + share * 4 + Math.log2(1 + f.count) * 0.9;
        }
      }
      return choiceFrom(scores);
    }

    case "section": {
      // Words shared between the email and each section's description, plus
      // how often this sender's mail is already in the section's label.
      const words = new Set(stems(`${state.email?.from?.name ?? ""} ${state.email?.subject ?? ""} ${state.email?.body ?? ""}`));
      const scores: Record<string, number> = {};
      for (const [id, text] of Object.entries(criteria as Record<string, string>)) {
        if (id === NO_SECTION) {
          scores[id] = 1.6;
          continue;
        }
        const hits = new Set(stems(text).filter((w) => words.has(w))).size;
        const filed = state.section_history?.find((h) => h.section_id === id)?.sender_emails_in_it ?? 0;
        scores[id] = hits * 0.9 + Math.log2(1 + filed) * 1.5;
      }
      // Examples whose subject resembles this one pull toward their section (or none).
      const subject = new Set(stems(state.email?.subject ?? ""));
      for (const h of state.section_history ?? []) {
        const like = Math.max(0, ...(h.example_subjects ?? []).map((x) => stems(x).filter((w) => subject.has(w)).length));
        if (like && h.section_id in scores) scores[h.section_id] += 2 + like * 1.5;
      }
      return choiceFrom(scores);
    }

    default: {
      // Unknown question: flat distribution.
      if (Array.isArray(criteria)) return scoreFrom(criteria.length, criteria.map(() => 0));
      const opts = Object.keys(criteria as object);
      if (opts.includes("true")) return { type: "noul", noul: 0.5 };
      return choiceFrom(Object.fromEntries(opts.map((o) => [o, 0])));
    }
  }
}

export class MockDecisionProvider implements DecisionProvider {
  readonly name = "mock-clef";
  readonly maxChoiceOptions = 255;

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 160));
    const state = req.state as MockState;
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([k, q]) => [k, answerFor(k, q.criteria, state)]),
    );
    return {
      model: this.name,
      provider: "zmail-mock",
      answers,
      usage: { input_tokens: JSON.stringify(req).length / 4, output_tokens: 0, cost: 0 },
    };
  }
}
