// People: contact lookup, and editing the open draft's recipients and files.
import type { ToolModule } from "./types";
import { extOf } from "./types";
import { useAssistant } from "../state";
import { refOf } from "./ids";
import { useMail, type ComposeEditPatch, type ComposeView } from "@/lib/store";
import { searchPeople } from "@/lib/contacts";
import type { Email } from "@/lib/types";

const MAX_BYTES = 20 * 1024 * 1024;

export interface PeopleDeps {
  search(q: string): Promise<{ name: string; address: string; title?: string; department?: string }[]>;
  view(): ComposeView | null;
  /** The open compose session, or null when the composer is closed. */
  session(): number | null;
  editCompose(patch: ComposeEditPatch, session: number): void;
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

export const peopleModule: ToolModule = {
  id: "people",
  prompt: [
    "- Use find_people to get someone's address before drafting to them; never invent an address.",
    "- To change who an open draft goes to, use set_draft_recipients; to add an email's files to it, attach_to_draft.",
  ],
  tools: [
    {
      name: "find_people",
      description: "Look up people by name or address in the directory, contacts and past mail. Returns up to 8 matches.",
      parameters: { type: "object", properties: { query: { type: "string", description: "A name or part of an address" } }, required: ["query"] },
    },
    {
      name: "set_draft_recipients",
      description: "Change the To, Cc or Bcc of the draft that is open in the composer. Default mode adds to what is there; replace overwrites the given fields.",
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
      description: "Attach the files of an email (by id from earlier results) to the open draft. Optionally limit to some filenames.",
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
      const view = d.view();
      const session = d.session();
      if (!view || session === null) throw new Error("No draft is open; use draft first.");
      const mode = args.mode === "replace" ? "replace" : "add";
      const patch: ComposeEditPatch = {};
      for (const f of ["to", "cc", "bcc"] as const) {
        const given = listArg(args[f], f);
        if (given === undefined) continue;
        patch[f] = merge(mode === "add" ? parts(view[f]) : [], given).join(", ");
      }
      if (!Object.keys(patch).length) throw new Error("bad_query: give at least one of to, cc or bcc");
      d.editCompose(patch, session);
      step(mode === "replace" ? "Set the draft's recipients" : "Added recipients to the draft");
      return { ok: true, ...patch };
    },

    attach_to_draft: async (args, deps) => {
      const d = extOf<PeopleDeps>(deps, "people");
      const session = d.session();
      if (!d.view() || session === null) throw new Error("No draft is open; use draft first.");
      const email = await d.ensureEmail(refOf(args.email_id));
      const wanted = Array.isArray(args.filenames) ? new Set((args.filenames as unknown[]).map((x) => String(x).toLowerCase())) : null;
      const atts = (email.attachments ?? []).filter((a) => !a.inline && (!wanted || wanted.has(a.filename.toLowerCase())));
      if (!atts.length) return { error: "That email has no matching attachments." };
      const total = atts.reduce((n, a) => n + a.size, 0);
      if (total > MAX_BYTES) return { error: "Those files total over 20 MB; share them as a link instead." };
      const addFiles = [];
      for (const a of atts) addFiles.push({ filename: a.filename, mimeType: a.mimeType, size: a.size, base64: await d.attachmentData(email.id, a.id) });
      // The downloads take a while: the user may have closed this draft or opened another.
      if (d.session() !== session) return { error: "The open draft changed while the files were downloading; nothing was attached." };
      d.editCompose({ addFiles }, session);
      step(`Attached ${atts.length === 1 ? atts[0].filename : `${atts.length} files`} to the draft`);
      return { ok: true, attached: atts.map((a) => a.filename) };
    },
  },
  realDeps,
};
