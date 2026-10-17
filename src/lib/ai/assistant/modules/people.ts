// People: contact lookup, and changing the open draft (its text, recipients and files). A change the model
// asks for lands in the draft only after the user approves it on a card; the user's own Redraft is the exception.
import type { ToolModule } from "./types";
import { extOf } from "./types";
import { useAssistant } from "../state";
import type { ToolDeps } from "../tools";
import { refOf } from "./ids";
import { pushConfirmCard } from "./confirm";
import { takeRedraft } from "../redraft";
import { useMail, type ComposeEditPatch, type ComposeView } from "@/lib/store";
import { searchPeople } from "@/lib/contacts";
import { formatBytes } from "@/lib/files";
import type { Email } from "@/lib/types";

const MAX_BYTES = 20 * 1024 * 1024;

export interface PeopleDeps {
  search(q: string): Promise<{ name: string; address: string; title?: string; department?: string }[]>;
  view(): ComposeView | null;
  /** The open compose session, or null when the composer is closed. */
  session(): number | null;
  editCompose(patch: ComposeEditPatch, session: number): void;
  /** The open draft is a scheduled email. */
  scheduled(): boolean;
  ensureEmail(ref: { id: string; accountId: string }): Promise<Email>;
  attachmentData(emailId: string, attachmentId: string): Promise<string>;
}

const realDeps = (): PeopleDeps => ({
  search: (q) => {
    const s = useMail.getState();
    return searchPeople(q, s.accounts, s.emails, 8);
  },
  view: () => useMail.getState().composeView,
  session: () => {
    const s = useMail.getState();
    return s.compose ? s.composeSession : null;
  },
  editCompose: (patch, session) => useMail.getState().editCompose(patch, session),
  scheduled: () => {
    const s = useMail.getState();
    const id = s.compose?.draft?.id;
    return !!id && s.scheduled.some((r) => r.draftId === id);
  },
  ensureEmail: (ref) => useMail.getState().ensureEmail(ref),
  attachmentData: (id, att) => useMail.getState().attachmentData(id, att),
});

const step = (text: string) => useAssistant.getState().push({ kind: "step", text });

/** Split a comma/semicolon list of addresses into trimmed parts. */
const parts = (v: string) => v.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const keyOf = (a: string) => (/<([^>]+)>/.exec(a)?.[1] ?? a).trim().toLowerCase();

function merge(base: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of [...base, ...extra]) {
    const k = keyOf(a);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

function listArg(v: unknown, name: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : null;
  if (!arr || arr.some((x) => typeof x !== "string")) throw new Error(`bad_query: ${name} must be a list of email addresses`);
  return arr.flatMap((x) => parts(x as string));
}

/** This launch: compose sessions start over at each launch, so a card saved in an earlier one can't match a new draft. */
const RUN = crypto.randomUUID();
/** The open draft a card was made for. */
interface Target {
  run: string;
  session: number;
}
type EditPayload = Target & { subject?: string; body?: string };
type RecipientsPayload = Target & { mode: "add" | "replace"; to?: string[]; cc?: string[]; bcc?: string[] };
type AttachPayload = Target & { email: { id: string; accountId: string }; attachmentIds: string[] };

const AWAITING = { status: "awaiting_confirmation", note: "A card is waiting for the user's OK. The draft hasn't changed yet." };
const SCHEDULED_NOTE = "This email is scheduled. Saving the change takes it off the schedule.";
const FIELD = { to: "To", cc: "Cc", bcc: "Bcc" } as const;

/** The open draft's session, or an error the model can read. */
function openSession(d: PeopleDeps): number {
  const session = d.session();
  if (!d.view() || session === null) throw new Error("No draft is open; use draft first.");
  return session;
}

/** At Apply: the card's draft must still be the one open. */
function stillOpen(d: PeopleDeps, p: Target) {
  if (p.run !== RUN || d.session() !== p.session || !d.view()) throw new Error("That draft isn't open anymore. Nothing was changed.");
}

/** edit_draft: a card showing the new subject and body. The user's own Redraft goes straight in (the composer offers Undo). */
export function proposeDraftEdit(edit: { subject?: string; body?: string }, deps: ToolDeps) {
  const d = extOf<PeopleDeps>(deps, "people");
  const session = openSession(d);
  if (takeRedraft(session)) {
    d.editCompose({ ...edit, redraft: true }, session);
    step("✎ Edited the draft");
    return { status: "edited", message: "The open draft was updated." };
  }
  const scheduled = d.scheduled();
  pushConfirmCard({
    module: "people",
    action: "edit_draft",
    title: scheduled ? "Change the scheduled email" : "Change the draft",
    detail: scheduled ? SCHEDULED_NOTE : d.view()?.subject || "(no subject)",
    preview: {
      fields: edit.subject !== undefined ? [{ label: "New subject", value: edit.subject || "(no subject)" }] : [],
      ...(edit.body !== undefined && { body: edit.body || "(empty)" }),
    },
    payload: { run: RUN, session, ...edit } satisfies EditPayload,
    confirmLabel: "Apply",
  });
  return AWAITING;
}

export const peopleModule: ToolModule = {
  id: "people",
  prompt: [
    "- Use find_people to get someone's address before drafting to them; never invent an address.",
    "- To change who an open draft goes to, use set_draft_recipients; to add an email's files to it, attach_to_draft. Both show the user a card; nothing changes until they approve it.",
  ],
  tools: [
    {
      name: "find_people",
      description: "Look up people by name or address in the directory, contacts and past mail. Returns up to 8 matches.",
      parameters: { type: "object", properties: { query: { type: "string", description: "A name or part of an address" } }, required: ["query"] },
    },
    {
      name: "set_draft_recipients",
      description: "Propose changing the To, Cc or Bcc of the draft that is open in the composer; the user approves it on a card. Default mode adds to what is there; replace overwrites the given fields.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "array", items: { type: "string" } },
          cc: { type: "array", items: { type: "string" } },
          bcc: { type: "array", items: { type: "string" } },
          mode: { type: "string", enum: ["replace", "add"] },
        },
      },
    },
    {
      name: "attach_to_draft",
      description: "Propose attaching the files of an email (by id from earlier results) to the open draft; the user approves it on a card. Optionally limit to some filenames.",
      parameters: {
        type: "object",
        properties: { email_id: { type: "string" }, filenames: { type: "array", items: { type: "string" } } },
        required: ["email_id"],
      },
    },
  ],
  handlers: {
    find_people: async (args, deps) => {
      const d = extOf<PeopleDeps>(deps, "people");
      const q = typeof args.query === "string" ? args.query.trim() : "";
      if (!q) throw new Error("bad_query: query is required");
      const found = await d.search(q);
      step(`Looked up “${q}”`);
      return {
        people: found.slice(0, 8).map((p) => ({
          name: p.name,
          address: p.address,
          ...(p.title && { title: p.title }),
          ...(p.department && { department: p.department }),
        })),
      };
    },

    set_draft_recipients: async (args, deps) => {
      const d = extOf<PeopleDeps>(deps, "people");
      const session = openSession(d);
      const view = d.view()!;
      const mode = args.mode === "replace" ? "replace" : "add";
      const payload: RecipientsPayload = { run: RUN, session, mode };
      const fields: { label: string; value: string }[] = [];
      for (const f of ["to", "cc", "bcc"] as const) {
        const given = listArg(args[f], f);
        if (given === undefined) continue;
        // Adding: only the addresses not on the draft yet, so the card shows exactly what changes.
        const have = new Set(mode === "add" ? parts(view[f]).map(keyOf) : []);
        const list = merge([], given).filter((a) => !have.has(keyOf(a)));
        payload[f] = list;
        if (mode === "add" && !list.length) continue;
        fields.push({ label: mode === "add" ? `Add ${FIELD[f]}` : FIELD[f], value: list.join(", ") || "(nobody)" });
      }
      if (!payload.to && !payload.cc && !payload.bcc) throw new Error("bad_query: give at least one of to, cc or bcc");
      if (!fields.length) return { ok: true, note: "Those addresses are already on the draft; nothing to change." };
      const scheduled = d.scheduled();
      pushConfirmCard({
        module: "people",
        action: "set_draft_recipients",
        title: scheduled ? "Change who the scheduled email goes to" : "Change who the draft goes to",
        detail: scheduled ? SCHEDULED_NOTE : view.subject || "(no subject)",
        preview: { fields },
        payload,
        confirmLabel: "Apply",
      });
      return AWAITING;
    },

    attach_to_draft: async (args, deps) => {
      const d = extOf<PeopleDeps>(deps, "people");
      const session = openSession(d);
      const email = await d.ensureEmail(refOf(args.email_id));
      const wanted = Array.isArray(args.filenames) ? new Set((args.filenames as unknown[]).map((x) => String(x).toLowerCase())) : null;
      const atts = (email.attachments ?? []).filter((a) => !a.inline && (!wanted || wanted.has(a.filename.toLowerCase())));
      if (!atts.length) return { error: "That email has no matching attachments." };
      const total = atts.reduce((n, a) => n + a.size, 0);
      if (total > MAX_BYTES) return { error: "Those files total over 20 MB; share them as a link instead." };
      const scheduled = d.scheduled();
      // Only ids on the card: the files are downloaded once the user approves.
      pushConfirmCard({
        module: "people",
        action: "attach_to_draft",
        title: scheduled ? "Attach to the scheduled email" : "Attach to the draft",
        detail: scheduled ? SCHEDULED_NOTE : `From “${email.subject || "(no subject)"}”`,
        preview: { fields: [{ label: "Attach", value: atts.map((a) => `${a.filename} (${formatBytes(a.size)})`).join(", ") }] },
        payload: { run: RUN, session, email: { id: email.id, accountId: email.accountId }, attachmentIds: atts.map((a) => a.id) } satisfies AttachPayload,
        confirmLabel: "Attach",
      });
      return AWAITING;
    },
  },
  confirm: {
    edit_draft: async (payload, deps) => {
      const d = extOf<PeopleDeps>(deps, "people");
      const p = payload as EditPayload;
      stillOpen(d, p);
      d.editCompose({ ...(p.subject !== undefined && { subject: p.subject }), ...(p.body !== undefined && { body: p.body }) }, p.session);
      return "Changed the draft";
    },

    set_draft_recipients: async (payload, deps) => {
      const d = extOf<PeopleDeps>(deps, "people");
      const p = payload as RecipientsPayload;
      stillOpen(d, p);
      const view = d.view()!;
      const patch: ComposeEditPatch = {};
      for (const f of ["to", "cc", "bcc"] as const) {
        const list = p[f];
        if (list === undefined || (p.mode === "add" && !list.length)) continue;
        // Added to what the draft has now: the user may have changed it since the card came up.
        patch[f] = merge(p.mode === "add" ? parts(view[f]) : [], list).join(", ");
      }
      d.editCompose(patch, p.session);
      return p.mode === "replace" ? "Set the draft's recipients" : "Added to the draft";
    },

    attach_to_draft: async (payload, deps) => {
      const d = extOf<PeopleDeps>(deps, "people");
      const p = payload as AttachPayload;
      stillOpen(d, p);
      const email = await d.ensureEmail(p.email);
      const want = new Set(p.attachmentIds);
      const atts = (email.attachments ?? []).filter((a) => !a.inline && want.has(a.id));
      if (!atts.length) throw new Error("Those files aren't on that email anymore.");
      if (atts.reduce((n, a) => n + a.size, 0) > MAX_BYTES) throw new Error("Those files total over 20 MB; share them as a link instead.");
      const addFiles = [];
      for (const a of atts) addFiles.push({ filename: a.filename, mimeType: a.mimeType, size: a.size, base64: await d.attachmentData(email.id, a.id) });
      // The downloads take a while: the user may have closed this draft or opened another.
      stillOpen(d, p);
      d.editCompose({ addFiles }, p.session);
      return `Attached ${atts.length === 1 ? atts[0].filename : `${atts.length} files`}`;
    },
  },
  realDeps,
};
