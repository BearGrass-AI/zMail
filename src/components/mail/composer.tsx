import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Check, ChevronDown, Cloud, Loader2, MailPlus, Paperclip, Save, Send, Sparkles, Trash2, X } from "lucide-react";
import { DrivePicker } from "./drive-picker";
import { FromPicker } from "./from-picker";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AddressInput, MentionInput, activeMentions, stripMentions, type Mention } from "./people-suggest";
import { linksBlockHtml } from "@/lib/drive";
import { RichEditor } from "./rich-editor";
import { bodyIsEmpty, composeRichHtml, composeRichText, markdownToBodyHtml, textToBodyHtml } from "@/lib/mail/compose-html";
import type { OutgoingAttachment } from "@/lib/google/gmail-map";
import type { SendRequest } from "@/lib/mail/provider";
import { fileToBase64, formatBytes } from "@/lib/files";
import { PER_FILE_CHARS, TOTAL_CHARS, extractText, readableKind, type Readable } from "@/lib/file-text";
import { fileIcon } from "@/lib/file-icons";
import { toast } from "sonner";
import { useMail, type Compose } from "@/lib/store";
import type { Email } from "@/lib/types";
import { forwardBody, replyRecipients } from "@/lib/mail/compose-text";
import { splitRecipients } from "@/lib/mail/address";
import { cn } from "@/lib/utils";
import { draftRequest } from "@/lib/ai/assistant/draft-request";
import { useAssistant } from "@/lib/ai/assistant/state";
import { ask as askAssistant } from "@/lib/ai/assistant/loop";
import { expectRedraft } from "@/lib/ai/assistant/redraft";
import { htmlToText, inlineDataImages, sanitizeSignature, sizeSignatureImages, withoutRemoteLoads } from "@/lib/signature";
import { openExternal } from "./email-body";
import { Clock } from "lucide-react";
import { SendLaterMenu } from "./send-later-menu";
import { OUTLOOK_SERVER_HOLD, longWhen, whenLabel } from "@/lib/mail/scheduled";
import { SPRING } from "@/lib/motion";

type Doc = { to: string; cc: string; bcc: string; subject: string; body: string };

/** A file in the Draft-with-AI box (or the draft's attachments): what to do with it and what was read. */
type FileEntry = OutgoingAttachment & {
  id: string;
  size: number;
  /** Give its text to the assistant. */
  read: boolean;
  /** Send it with the email. */
  attach: boolean;
  readable: Readable;
  status: { state: "reading" | "ready" | "failed"; text?: string; truncated?: boolean; error?: string };
};

/** The signature picker's id for a reopened draft's own signature. */
const DRAFT_SIG = "zmail:draft";

/** A saved draft's provider id and the account it lives in. */
type SavedDraft = { id?: string; acct?: string };

/** What the user could lose by closing: the fields plus the attached files. */
const snapshot = (d: Doc, fs: { filename: string; size: number }[]) => JSON.stringify([d.to, d.cc, d.bcc, d.subject, d.body, fs.map((f) => [f.filename, f.size])]);
/** What a scheduled email would send: its fields and files, From account and signature. */
const sentAs = (snap: string | null, from: string | undefined, sig: string | null) => JSON.stringify([snap, from ?? null, sig]);

const attachOnly =(f: OutgoingAttachment & { size: number }): FileEntry => ({
  ...f,
  id: crypto.randomUUID(),
  read: false,
  attach: true,
  readable: readableKind(f.filename, f.mimeType),
  status: { state: "ready" },
});

/** A session's opening fields and its unsaved-changes baseline (null: unsaved from the start). Draft with AI starts on the ask screen. */
function seed(compose: Compose, replyTo: Email | undefined, mine: string[]) {
  const closed = { doc: null, baseline: null, showCc: false, showBcc: false };
  if (compose.mode === "ai") return closed;
  const rec = replyTo && !compose.forward ? replyRecipients(replyTo, mine, !!compose.all) : { to: [], cc: [] };
  const base = !replyTo
    ? { to: "", cc: "", bcc: "", subject: "", body: "" }
    : compose.forward
      ? { to: "", cc: "", bcc: "", subject: `Fwd: ${replyTo.subject}`, body: textToBodyHtml(forwardBody(replyTo)) }
      : { to: rec.to.join(", "), cc: rec.cc.join(", "), bcc: "", subject: `Re: ${replyTo.subject}`, body: "" };
  const p = compose.prefill;
  const { bodyIsHtml, ...fields } = p ?? {};
  const doc: Doc = p
    ? { ...base, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), ...(p.body !== undefined && { body: bodyIsHtml ? p.body : markdownToBodyHtml(p.body) }) }
    : base;
  return {
    doc,
    // Untouched replies and reopened drafts are clean; an AI-written draft was never saved, so it counts as unsaved.
    baseline: p && !compose.draft ? null : snapshot(doc, compose.attachments ?? []),
    showCc: !!base.cc || !!p?.cc,
    showBcc: !!p?.bcc,
  };
}

export function Composer() {
  // Closing sets compose to null while the panel is still sliding out (Today,
  // Triage, Calendar); keep showing the last session until it's gone.
  const live = useMail((s) => s.compose);
  const [last, setLast] = useState(live);
  if (live && live !== last) setLast(live);
  const compose = (live ?? last)!;
  const openCompose = useMail((s) => s.openCompose);
  const replyTo = useMail((s) => s.emails.find((e) => e.id === compose.replyTo));
  const accounts = useMail((s) => s.accounts);
  const sendMail = useMail((s) => s.send);
  const saveDraftAction = useMail((s) => s.saveDraft);
  const sendDraftAction = useMail((s) => s.sendDraft);
  const deleteDraftAction = useMail((s) => s.deleteDraft);
  const scheduleMessage = useMail((s) => s.scheduleMessage);
  const closeCompose = useMail((s) => s.closeCompose);
  const setComposeDirty = useMail((s) => s.setComposeDirty);
  const closeAsk = useMail((s) => s.composeCloseAsk);
  const setCloseAsk = useMail((s) => s.setComposeCloseAsk);
  // This composer's session. Work that awaits re-checks it before touching the composer: another message may be open by then.
  const session = useMail((s) => s.composeSession);
  const ours = (id: number) => {
    const s = useMail.getState();
    return !!s.compose && s.composeSession === id;
  };
  const mine = accounts.map((a) => a.address);
  const recipients = replyTo && !compose.forward ? replyRecipients(replyTo, mine, !!compose.all) : { to: [], cc: [] };
  const defaultFrom = compose.fromAccountId ?? replyTo?.accountId ?? accounts.find((a) => a.kind !== "mock")?.id ?? accounts[0]?.id;
  const [fromId, setFromId] = useState(defaultFrom);
  const [sending, setSending] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- per-session reset on a new compose session (or default From change), kept with the other reset effects so the reset lands in one commit
  useEffect(() => setFromId(defaultFrom), [compose, defaultFrom]);
  // Send later: the picked time (null = send now). A draft reopened from Scheduled keeps its time.
  const [sendAt, setSendAt] = useState<number | null>(compose.scheduledAt ?? null);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- per-session reset on a new compose session, kept with the other reset effects
  useEffect(() => setSendAt(compose.scheduledAt ?? null), [compose]);
  const from = accounts.find((a) => a.id === fromId);
  // The session's fields are there on the first frame: no empty pane before the editor.
  const [first] = useState(() => seed(compose, replyTo, mine));
  const [ask, setAsk] = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [showCc, setShowCc] = useState(first.showCc);
  const [showBcc, setShowBcc] = useState(first.showBcc);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<Doc | null>(first.doc);
  // Redraft with AI: the ask screen shows over the draft, which stays (and stays unsaved) underneath.
  const [asking, setAsking] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>(() => (compose.attachments ?? []).map(attachOnly));
  const [dragging, setDragging] = useState(false);
  const [drive, setDrive] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const askFileInput = useRef<HTMLInputElement>(null);
  const promptBox = useRef<HTMLDivElement>(null);
  const multi = accounts.length > 1;
  const signatures = useMail((s) => s.signatures);
  const defaultSig = useMail((s) => (fromId ? s.signatureDefaults[fromId]?.[replyTo ? "reply" : "new"] : null) ?? null);
  // A reopened draft keeps the signature it was saved with: its own, when zMail could get it back, else none (it's in the body).
  const draftSig = compose.signatureHtml;
  const sigList = useMemo(() => (draftSig ? [{ id: DRAFT_SIG, name: "Saved with draft", html: draftSig }, ...signatures] : signatures), [draftSig, signatures]);
  const sigDefault = compose.draft ? (draftSig ? DRAFT_SIG : null) : defaultSig;
  const [sigId, setSigId] = useState<string | null>(sigDefault);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- per-session reset on a new compose session (or From change), kept with the other reset effects
  useEffect(() => setSigId(sigDefault), [compose, sigDefault]);
  const signature = sigList.find((x) => x.id === sigId)?.html ?? "";
  const sigName = sigList.find((x) => x.id === sigId)?.name;
  // A draft's signature came from the server: show it without loading anything remote.
  const signaturePreview = useMemo(
    () => (signature ? (sigId === DRAFT_SIG ? withoutRemoteLoads(sanitizeSignature(signature)) : sanitizeSignature(signature)) : ""),
    [signature, sigId],
  );

  // The saved draft this session edits (if any) and the last saved/opened state, to tell unsaved changes.
  const [draftId, setDraftId] = useState(compose.draft?.id);
  const [draftMsgId, setDraftMsgId] = useState(compose.draft?.emailId);
  const [draftAcct, setDraftAcct] = useState(compose.draft ? compose.fromAccountId : undefined);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [baseline, setBaseline] = useState<string | null>(first.baseline);
  // A reopened scheduled email: what it was scheduled to send. Saved with changes, it leaves the schedule.
  const scheduledFor = (c: Compose, opened: string | null) => (c.scheduledAt !== undefined && c.draft ? sentAs(opened, defaultFrom, sigDefault) : null);
  const [scheduledAs, setScheduledAs] = useState(() => scheduledFor(compose, first.baseline));
  const stillScheduled = useMail((s) => !!compose.draft && s.scheduled.some((r) => r.draftId === compose.draft?.id));
  const withdrawScheduled = useMail((s) => s.withdrawScheduled);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the saved-draft identity per compose session with the other reset effects; left as an effect so save/send timing stays the same
    setDraftId(compose.draft?.id);
    setDraftMsgId(compose.draft?.emailId);
    setDraftAcct(compose.draft ? compose.fromAccountId : undefined);
    setSavedAt(null);
  }, [compose]);

  // Reseed (during render, so no frame shows the old fields) whenever a new compose session starts, or once the email
  // being answered arrives in the store. Keyed on its id, not the object: a sync that refreshes that email must not wipe the reply.
  const replyToId = replyTo?.id;
  const [seededFor, setSeededFor] = useState({ compose, replyToId });
  if (seededFor.compose !== compose || seededFor.replyToId !== replyToId) {
    const next = seed(compose, replyTo, mine);
    setSeededFor({ compose, replyToId });
    setAsk("");
    setMentions([]);
    setShowCc(next.showCc);
    setShowBcc(next.showBcc);
    setFiles((compose.attachments ?? []).map(attachOnly));
    setDoc(next.doc);
    setBaseline(next.baseline);
    setScheduledAs(scheduledFor(compose, next.baseline));
    setAsking(false);
  }

  const drafting = useRef(false);
  const generate = async () => {
    // Enter in the prompt and the button can both land before the re-render that disables it.
    if (drafting.current || (!ask.trim() && !replyTo && !(doc && asking))) return;
    if (files.some((f) => f.read && f.status.state === "reading")) return;
    drafting.current = true;
    setBusy(true);
    try {
      const people = activeMentions(ask, mentions);
      const instruction = stripMentions(ask, people).trim();
      // Whatever the toggles allow, within the total reading budget.
      let room = TOTAL_CHARS;
      const sent = files.map((f) => {
        const full = f.read && f.status.state === "ready" ? (f.status.text ?? "") : undefined;
        if (full === undefined) return { filename: f.filename, attach: f.attach };
        const text = full.slice(0, room);
        room -= text.length;
        return { filename: f.filename, text, truncated: f.status.truncated || text.length < full.length, attach: f.attach };
      });
      const rework = doc && asking ? htmlToText(doc.body) : undefined;
      const req = draftRequest({ instruction, people: rework === undefined ? people : [], replyTo, forward: compose.forward, all: compose.all, files: sent, rework });
      const a = useAssistant.getState();
      if (a.busy) {
        toast("The assistant is still working", { description: "Try again when it finishes, or stop it in the panel." });
        return;
      }
      // The draft tool only accepts ids the assistant has seen.
      if (replyTo) a.remember([{ id: replyTo.id, accountId: replyTo.accountId }]);
      if (doc && asking) {
        // A redraft keeps this message open (fields, files, saved draft) and the assistant rewrites its body in place.
        const add = (field: string, role: "to" | "cc") =>
          [field, ...people.filter((p) => p.role === role && !field.toLowerCase().includes(p.address.toLowerCase())).map((p) => p.address)].filter((x) => x.trim()).join(", ");
        setDoc({ ...doc, to: add(doc.to, "to"), cc: add(doc.cc, "cc") });
        if (people.some((p) => p.role === "cc")) setShowCc(true);
        // Files added only for reading aren't attached.
        setFiles((prev) => prev.filter((f) => f.attach).map((f) => ({ ...f, read: false })));
        setAsk("");
        setMentions([]);
        setAsking(false);
        // The rewrite the user asked for goes straight into this message (with Undo); other changes need a card.
        const done = expectRedraft(session);
        a.toggle(true);
        void askAssistant(req.text, undefined, undefined, { display: req.display }).finally(done);
        return;
      }
      a.setPendingFrom(fromId ?? null);
      a.setPendingAttachments(files.filter((f) => f.attach).map(({ filename, mimeType, base64 }) => ({ filename, mimeType, base64 })));
      a.toggle(true);
      setComposeDirty(false);
      openCompose(null);
      void askAssistant(req.text, undefined, undefined, { display: req.display });
    } finally {
      drafting.current = false;
      setBusy(false);
    }
  };

  /** Per-request attachment ceilings for the simple send APIs we use. */
  const limit = from?.kind === "m365" ? 3 * 1024 * 1024 : 5 * 1024 * 1024;
  const total = files.reduce((n, f) => n + f.size, 0);

  const patchFile = (id: string, patch: Partial<FileEntry>) => setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const addFiles = async (list: FileList | File[]) => {
    const forAsk = !doc || asking;
    const loaded = await Promise.all(
      [...list].map(async (f) => ({ filename: f.name, mimeType: f.type || "application/octet-stream", size: f.size, base64: await fileToBase64(f) })),
    );
    // Reading budget left after the files already set to be read (or being read).
    let room = TOTAL_CHARS - files.reduce((n, f) => n + (f.read ? (f.status.text?.length ?? PER_FILE_CHARS) : 0), 0);
    const added: FileEntry[] = loaded.map((f) => {
      const readable = readableKind(f.filename, f.mimeType);
      const entry: FileEntry = { ...f, id: crypto.randomUUID(), read: false, attach: true, readable, status: { state: "ready" } };
      if (!forAsk || !readable) return entry;
      if (room <= 0) return { ...entry, status: { state: "failed", error: "Over the reading limit" } };
      const max = Math.min(PER_FILE_CHARS, room);
      room -= max;
      void extractText(f, max).then(
        (r) => patchFile(entry.id, { status: { state: "ready", ...r } }),
        (err: Error) => patchFile(entry.id, { read: false, status: { state: "failed", error: err.message } }),
      );
      return { ...entry, read: true, status: { state: "reading" } };
    });
    setFiles((prev) => [...prev, ...added]);
  };

  /** Flip Read or Attach; the file goes away when neither is left. */
  const toggleFile = (id: string, key: "read" | "attach") =>
    setFiles((prev) =>
      prev.flatMap((f) => {
        if (f.id !== id) return [f];
        const next = { ...f, [key]: !f[key] };
        return next.read || next.attach ? [next] : [];
      }),
    );
  const reading = files.some((f) => f.read && f.status.state === "reading");

  /** The To, Cc and Bcc fields as recipients, or null after saying which entry isn't a single address. */
  const recipientsOf = (d: Doc, failed: string) => {
    try {
      return { to: splitRecipients(d.to), cc: splitRecipients(d.cc), bcc: splitRecipients(d.bcc) };
    } catch (err) {
      toast.error(failed, { description: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };

  /** The email as it would be sent (and as a draft is saved), to recipients already checked by recipientsOf. */
  const buildRequest = async (d: Doc, to: string[], cc: string[], bcc: string[]): Promise<SendRequest> => {
    // A draft's signature came from the server: measuring its images mustn't fetch anything.
    const { html, inline } = inlineDataImages(await sizeSignatureImages(composeRichHtml(d.body, signature), undefined, { remote: sigId !== DRAFT_SIG }));
    return {
      to,
      cc,
      bcc,
      subject: d.subject,
      text: composeRichText(d.body, signature),
      html,
      inline,
      replyTo: compose.forward ? undefined : replyTo,
      attachments: files.map(({ filename, mimeType, base64 }) => ({ filename, mimeType, base64 })),
    };
  };

  /** The saved draft's id, unless the user has since switched the From account (then the old draft is removed and a new one starts). */
  // A ref mirrors the draft state, so save and send read it when they start (before any await, while the session is theirs).
  const draftRef = useRef<SavedDraft>({ id: draftId, acct: draftAcct });
  useLayoutEffect(() => {
    draftRef.current = { id: draftId, acct: draftAcct };
  });
  const usableDraft = async (accountId: string, draft: SavedDraft, mine: number): Promise<string | undefined> => {
    if (!draft.id) return undefined;
    if (!draft.acct || draft.acct === accountId) return draft.id;
    await deleteDraftAction(draft.acct, draft.id, draftMsgId).catch(() => {});
    if (ours(mine)) {
      draftRef.current = { id: undefined, acct: undefined };
      setDraftId(undefined);
      setDraftMsgId(undefined);
    }
    return undefined;
  };

  // Unsaved changes: anything differing from the last saved/opened state (a new, empty message is never unsaved).
  const dirty =
    !!live &&
    !!doc &&
    snapshot(doc, files) !== baseline &&
    (!!draftId || !!(doc.to.trim() || doc.cc.trim() || doc.bcc.trim() || doc.subject.trim() || !bodyIsEmpty(doc.body) || files.length));
  // A reopened scheduled email that no longer matches what was scheduled: saving it takes it off the schedule.
  const changesSchedule = !!live && !!doc && scheduledAs !== null && stillScheduled && sentAs(snapshot(doc, files), fromId, sigId) !== scheduledAs;
  // Re-sent for each session too: closing one clears the store's flag, and the next may be just as unsaved.
  useEffect(() => setComposeDirty(dirty), [dirty, live, setComposeDirty]);
  useEffect(() => () => setComposeDirty(false), [setComposeDirty]);

  // Publish the open draft as composeView for the assistant, and apply its composeEdit changes.
  const setComposeView = useMail((s) => s.setComposeView);
  useEffect(() => {
    if (!doc) return setComposeView(null);
    const t = setTimeout(() => setComposeView({ fromAccountId: fromId, to: doc.to, cc: doc.cc, bcc: doc.bcc, subject: doc.subject, body: htmlToText(doc.body) }), 250);
    return () => clearTimeout(t);
  }, [doc, fromId, setComposeView]);
  useEffect(() => () => setComposeView(null), [setComposeView]);
  const editSeq = useMail((s) => s.composeEdit?.seq);
  const lastEditSeq = useRef(useMail.getState().composeEdit?.seq);
  useEffect(() => {
    if (editSeq === undefined || editSeq === lastEditSeq.current) return;
    const edit = useMail.getState().composeEdit;
    lastEditSeq.current = editSeq;
    // An edit made for another session (say the user switched drafts while the assistant downloaded files) is dropped.
    if (!edit || !doc || edit.session !== session) return;
    // Undo puts back what the assistant replaced or added.
    const undo: Partial<Doc> = {};
    for (const k of ["subject", "body", "to", "cc", "bcc"] as const) if (edit[k] !== undefined) undo[k] = doc[k];
    const added = (edit.addFiles ?? []).map(attachOnly);
    const addedIds = new Set(added.map((f) => f.id));
    toast(edit.redraft ? "Redrafted with AI" : "The assistant changed the draft", {
      action: {
        label: "Undo",
        onClick: () => {
          if (!ours(session)) return;
          setDoc((d) => d && { ...d, ...undo });
          if (addedIds.size) setFiles((prev) => prev.filter((f) => !addedIds.has(f.id)));
        },
      },
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- applies the assistant's one-shot composeEdit command (once per seq), not state derivable from props
    setDoc({
      ...doc,
      ...(edit.subject !== undefined && { subject: edit.subject }),
      ...(edit.body !== undefined && { body: markdownToBodyHtml(edit.body) }),
      ...(edit.to !== undefined && { to: edit.to }),
      ...(edit.cc !== undefined && { cc: edit.cc }),
      ...(edit.bcc !== undefined && { bcc: edit.bcc }),
    });
    if (edit.cc?.trim()) setShowCc(true);
    if (edit.bcc?.trim()) setShowBcc(true);
    if (added.length) setFiles((prev) => [...prev, ...added]);
  }, [editSeq, doc, session]);

  const saveInFlight = useRef(false);
  // The running save and the draft it saved, so Send in the same session can wait for it instead of racing it.
  const savePromise = useRef<{ session: number; done: Promise<SavedDraft | undefined> } | null>(null);
  const saveDraft = async (fromClose = false): Promise<boolean> => {
    if (!doc || !from || saveInFlight.current || inFlight.current) return false;
    if (total > limit) {
      toast.error(`Attachments are over ${formatBytes(limit)}`, { description: "Share large files as a link instead: use Insert from Drive." });
      return false;
    }
    // Checked before anything is taken off the schedule.
    const rcpt = recipientsOf(doc, "Couldn't save the draft");
    if (!rcpt) return false;
    saveInFlight.current = true;
    setSaving(true);
    const mine = session;
    const draft = draftRef.current;
    const saved = snapshot(doc, files);
    const unschedule = changesSchedule ? compose.draft?.id : undefined;
    let putBack: (() => void) | null = null;
    let result: SavedDraft | undefined;
    let done!: (d: SavedDraft | undefined) => void;
    savePromise.current = { session: mine, done: new Promise((r) => (done = r)) };
    try {
      // Off the schedule before the save: by itself, a scheduled email only ever sends what the user scheduled.
      if (unschedule) putBack = await withdrawScheduled(unschedule);
      const msg = await buildRequest(doc, rcpt.to, rcpt.cc, rcpt.bcc);
      const res = await saveDraftAction(from.id, msg, await usableDraft(from.id, draft, mine));
      result = { id: res.draftId, acct: from.id };
      if (ours(mine)) {
        draftRef.current = result;
        setDraftId(res.draftId);
        setDraftMsgId(res.messageId);
        setDraftAcct(from.id);
        setSavedAt(new Date());
        setBaseline(saved);
      }
      if (putBack) toast("Saved, and no longer scheduled", { description: "It changed after you scheduled it. It's in Drafts: schedule it again to send it later." });
      else if (fromClose) toast("Draft saved");
      return true;
    } catch (err) {
      putBack?.();
      toast.error("Couldn't save the draft", { description: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      saveInFlight.current = false;
      savePromise.current = null;
      done(result);
      setSaving(false);
    }
  };

  const deleteDraft = async () => {
    if (!draftId || !draftAcct) return;
    const mine = session;
    try {
      await deleteDraftAction(draftAcct, draftId, draftMsgId);
      toast("Draft deleted");
      if (!ours(mine)) return;
      setComposeDirty(false);
      openCompose(null);
    } catch (err) {
      toast.error("Couldn't delete the draft", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  /** Finish the "Save this draft?" question: close the composer, then carry on with what the user was doing. */
  const answer = async (choice: "save" | "discard" | "keep") => {
    if (!closeAsk) return;
    if (choice === "keep") {
      setCloseAsk(null);
      return closeAsk.cancel?.();
    }
    const mine = session;
    if (choice === "save" && !(await saveDraft(true))) return;
    if (!ours(mine)) return;
    setCloseAsk(null);
    setComposeDirty(false);
    openCompose(null);
    closeAsk.then();
  };

  // A ref, not state: two quick clicks or ⌘↩ presses land before a re-render.
  const inFlight = useRef(false);
  const send = async () => {
    if (!doc || !from || inFlight.current) return;
    if (total > limit)
      return toast.error(`Attachments are over ${formatBytes(limit)}`, {
        description: "Share large files as a link instead: use Insert from Drive.",
      });
    const rcpt = recipientsOf(doc, "Couldn't send");
    if (!rcpt) return;
    const { to, cc, bcc } = rcpt;
    if (!to.length) return toast.error("Add at least one recipient");
    inFlight.current = true;
    setSending(true);
    const mine = session;
    let draft = draftRef.current;
    const pendingSave = savePromise.current;
    try {
      // A save in progress may still be creating the draft: let it finish so we send that draft, not a second message.
      if (pendingSave?.session === mine) draft = (await pendingSave.done) ?? draft;
      const msg = await buildRequest(doc, to, cc, bcc);
      const existing = await usableDraft(from.id, draft, mine);
      if (existing) await sendDraftAction(from.id, msg, existing);
      else await sendMail(from.id, msg);
      toast.success("Sent", from.kind === "mock" ? { description: "Demo account — nothing left your Mac." } : { description: `From ${from.address}` });
      // Close only this message: the user may have opened another while it was sending.
      if (!ours(mine)) return;
      setComposeDirty(false);
      openCompose(null);
    } catch (err) {
      toast.error("Couldn't send", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  /** Send later: save the draft and leave it to the scheduler (same guards as send). */
  const schedule = async () => {
    if (!doc || !from || inFlight.current || sendAt === null) return;
    if (total > limit)
      return toast.error(`Attachments are over ${formatBytes(limit)}`, {
        description: "Share large files as a link instead: use Insert from Drive.",
      });
    const rcpt = recipientsOf(doc, "Couldn't schedule");
    if (!rcpt) return;
    const { to, cc, bcc } = rcpt;
    if (!to.length) return toast.error("Add at least one recipient");
    inFlight.current = true;
    setSending(true);
    const mine = session;
    let draft = draftRef.current;
    const pendingSave = savePromise.current;
    try {
      if (pendingSave?.session === mine) draft = (await pendingSave.done) ?? draft;
      const msg = await buildRequest(doc, to, cc, bcc);
      const existing = await usableDraft(from.id, draft, mine);
      await scheduleMessage(from.id, msg, sendAt, existing ? { id: existing, emailId: draftMsgId } : undefined);
      toast.success(`Scheduled for ${whenLabel(sendAt)}`, { description: from.address });
      if (!ours(mine)) return;
      setComposeDirty(false);
      openCompose(null);
    } catch (err) {
      toast.error("Couldn't schedule", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  const primary = () => void (sendAt === null ? send() : schedule());
  // Gmail can't hold mail on the server, and Outlook's hold is off until verified: zMail sends these itself.
  const localHold = from?.kind === "gmail" || (from?.kind === "m365" && !OUTLOOK_SERVER_HOLD);

  const title = doc && !asking ? (replyTo ? (compose.forward ? "Forward" : `${compose.all ? "Reply all to" : "Reply to"} ${replyTo.from.name}`) : "New message") : "Draft with AI";

  return (
    <div
      className="relative flex h-full min-w-0 flex-col"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void saveDraft();
        }
      }}
    >
      <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-4">
        <button
          onClick={() => closeCompose()}
          className="grid size-7 place-items-center rounded-md text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
        <span className="text-[13px] font-medium text-foreground/70">{title}</span>
        {draftId && (
          <button
            onClick={() => void deleteDraft()}
            className="grid size-7 place-items-center rounded-md text-foreground/50 hover:bg-foreground/[0.06] hover:text-destructive"
            aria-label="Delete draft"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </header>
      {closeAsk && doc && (
        <div role="alert" className="flex items-center gap-2 border-b border-hairline bg-primary/[0.06] px-6 py-2 text-[13px]">
          <span className="mr-auto font-medium">
            Save this draft?{changesSchedule && <span className="font-normal text-foreground/60"> Saving takes it off the schedule.</span>}
          </span>
          <button
            onClick={() => void answer("save")}
            disabled={saving}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground disabled:opacity-60"
          >
            {saving && <Loader2 className="size-3 animate-spin" />} Save draft
          </button>
          <button onClick={() => void answer("discard")} disabled={saving} className="inline-flex h-7 items-center rounded-lg px-3 text-[12.5px] text-foreground/70 hover:bg-foreground/5 disabled:opacity-60">
            Discard
          </button>
          <button onClick={() => void answer("keep")} disabled={saving} className="inline-flex h-7 items-center rounded-lg px-3 text-[12.5px] text-foreground/70 hover:bg-foreground/5 disabled:opacity-60">
            Keep editing
          </button>
        </div>
      )}

      {/* No exit-then-enter wait: the next screen is there on the first frame while the old one fades out of the way. */}
      <AnimatePresence initial={false} mode="popLayout">
        {!doc || asking ? (
          <motion.div
            key="ask"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={SPRING}
            className="grid flex-1 place-items-center px-8"
          >
            <div className="w-full max-w-[520px] text-center">
              <div className="mx-auto mb-3 grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary">
                {replyTo ? <Sparkles className="size-5" /> : <MailPlus className="size-5" />}
              </div>
              <h2 className="text-[24px] font-semibold tracking-tight">
                {doc && !bodyIsEmpty(doc.body) ? "How should we change it?" : replyTo ? `What should we tell ${replyTo.from.name.split(" ")[0]}?` : "Let's write an email."}
              </h2>
              <div
                ref={promptBox}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("Files")) {
                    e.preventDefault();
                    setDragging(true);
                  }
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  if (!e.dataTransfer.files.length) return;
                  e.preventDefault();
                  setDragging(false);
                  void addFiles(e.dataTransfer.files);
                }}
                className={cn(
                  dragging && "ring-2 ring-primary/40",
                  "mt-6 rounded-2xl border border-hairline bg-pane-2 px-4 py-2.5 text-left shadow-sm focus-within:ring-2 focus-within:ring-ring/30",
                  multi ? "flex flex-col gap-2" : "flex items-end gap-2",
                )}
              >
                <MentionInput
                  value={ask}
                  onChange={setAsk}
                  mentions={mentions}
                  onMentionsChange={setMentions}
                  onSubmit={() => void generate()}
                  placeholder={doc && !bodyIsEmpty(doc.body) ? "Shorter, and a little warmer" : replyTo ? "Approved — go ahead with Saturday" : "Ask @Jen for the Trustees slides by Monday"}
                />
                <div className={cn("flex items-center gap-2", !multi && "contents")}>
                  {multi && (
                    <FromPicker
                      compact
                      accounts={accounts}
                      value={fromId}
                      onChange={setFromId}
                      isReply={!!replyTo}
                      finalFocus={() => promptBox.current?.querySelector("textarea") ?? null}
                    />
                  )}
                  <button
                    onClick={() => askFileInput.current?.click()}
                    className="grid size-8 shrink-0 place-items-center rounded-full text-foreground/45 hover:bg-foreground/5 hover:text-foreground/70"
                    aria-label="Add files"
                  >
                    <Paperclip className="size-4" />
                  </button>
                  <input
                    ref={askFileInput}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                      if (e.target.files) void addFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <button
                    onClick={() => void generate()}
                    disabled={busy || reading || (!ask.trim() && !replyTo && !doc)}
                    className="ml-auto grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition disabled:opacity-30"
                    aria-label="Generate draft"
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                  </button>
                </div>
              </div>
              {files.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 text-left">
                  {files.map((f) => {
                    const Icon = fileIcon(f.mimeType, f.filename);
                    const toggle = (on: boolean, disabled = false) =>
                      cn(
                        "h-5 rounded px-1.5 text-[11px] transition",
                        on ? "bg-primary/15 text-primary" : "text-foreground/40 hover:bg-foreground/5",
                        disabled && "pointer-events-none opacity-40",
                      );
                    return (
                      <span key={f.id} className="flex h-8 items-center gap-2 rounded-lg border border-hairline bg-pane-2 pr-1.5 pl-2 text-[12px]">
                        <Icon className="size-3.5 text-primary" />
                        <span className="max-w-[160px] truncate">{f.filename}</span>
                        <span className="text-foreground/40">{formatBytes(f.size)}</span>
                        {f.status.state === "reading" && <Loader2 className="size-3 animate-spin text-foreground/40" />}
                        {f.status.state === "failed" && <span className="max-w-[140px] truncate text-destructive">{f.status.error}</span>}
                        {f.read && f.status.truncated && <span className="text-foreground/40">First part read</span>}
                        <button
                          aria-pressed={f.read}
                          disabled={f.readable === null || f.status.state !== "ready"}
                          title={f.readable === null ? "Can't read this type" : "Let the assistant read this file"}
                          onClick={() => toggleFile(f.id, "read")}
                          className={toggle(f.read, f.readable === null || f.status.state !== "ready")}
                        >
                          Read
                        </button>
                        <button aria-pressed={f.attach} onClick={() => toggleFile(f.id, "attach")} title="Attach this file to the email" className={toggle(f.attach)}>
                          Attach
                        </button>
                        <button
                          onClick={() => setFiles(files.filter((x) => x.id !== f.id))}
                          className="grid size-5 place-items-center rounded text-foreground/40 hover:bg-foreground/10"
                          aria-label={`Remove ${f.filename}`}
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              <div className="mt-3 flex justify-center gap-4 text-[11.5px] text-foreground/40">
                <span>
                  <kbd className="kbd">↵</kbd> Ask zMail to draft
                </span>
                <span>
                  <kbd className="kbd">@</kbd> Add people · “cc @…” to copy
                </span>
                <button
                  className="hover:text-foreground/70"
                  onClick={() => {
                    if (doc) return setAsking(false);
                    if (recipients.cc.length) setShowCc(true);
                    const blank = { to: recipients.to.join(", "), cc: recipients.cc.join(", "), bcc: "", subject: replyTo ? `Re: ${replyTo.subject}` : "", body: "" };
                    setBaseline(snapshot(blank, files));
                    setDoc(blank);
                  }}
                >
                  {doc ? "Back to the draft" : "Write it myself"}
                </button>
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="doc"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={SPRING}
            className="flex min-h-0 flex-1 flex-col"
          >
            {accounts.length > 1 && (
              <div className="flex items-center gap-3 border-b border-hairline px-6 py-2 text-[13px]">
                <span className="w-14 text-foreground/45">From</span>
                <FromPicker accounts={accounts} value={fromId} onChange={setFromId} isReply={!!replyTo} />
              </div>
            )}
            <div className="flex items-center gap-3 border-b border-hairline px-6 py-2.5 text-[13px]">
              <span className="w-14 text-foreground/45">To</span>
              <AddressInput value={doc.to} onChange={(to) => setDoc({ ...doc, to })} placeholder="Name or email" autoFocus={!doc.to} />
              {!showCc && !doc.cc && (
                <button onClick={() => setShowCc(true)} className="text-[12px] text-foreground/40 hover:text-foreground/70">
                  Cc
                </button>
              )}
              {!showBcc && !doc.bcc && (
                <button onClick={() => setShowBcc(true)} className="text-[12px] text-foreground/40 hover:text-foreground/70">
                  Bcc
                </button>
              )}
            </div>
            {(showCc || doc.cc) && (
              <div className="flex items-center gap-3 border-b border-hairline px-6 py-2.5 text-[13px]">
                <span className="w-14 text-foreground/45">Cc</span>
                <AddressInput value={doc.cc} onChange={(cc) => setDoc({ ...doc, cc })} autoFocus={showCc && !doc.cc} />
              </div>
            )}
            {(showBcc || doc.bcc) && (
              <div className="flex items-center gap-3 border-b border-hairline px-6 py-2.5 text-[13px]">
                <span className="w-14 text-foreground/45">Bcc</span>
                <AddressInput value={doc.bcc} onChange={(bcc) => setDoc({ ...doc, bcc })} autoFocus={showBcc && !doc.bcc} />
              </div>
            )}
            <label className="flex items-center gap-3 border-b border-hairline px-6 py-2.5 text-[13px]">
              <span className="w-14 text-foreground/45">Subject</span>
              <input
                value={doc.subject}
                onChange={(e) => setDoc({ ...doc, subject: e.target.value })}
                className="selectable flex-1 bg-transparent outline-none"
              />
            </label>
            <RichEditor
              html={doc.body}
              onChange={(body) => setDoc((d) => d && { ...d, body })}
              onSubmit={primary}
              onFiles={(f) => void addFiles(f)}
              autoFocus={!!doc.to}
            />
            {sigList.length > 0 && (
              <div className="px-6 pb-3">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label="Signature"
                    className="mb-1.5 inline-flex cursor-pointer items-center gap-1 rounded text-[11.5px] text-foreground/45 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 hover:text-foreground/70 focus-visible:text-foreground/70 data-popup-open:text-foreground/70"
                  >
                    {sigName ? `Signature: ${sigName}` : "No signature"}
                    <ChevronDown className="size-3" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-auto min-w-44">
                    {[{ id: null as string | null, name: "No signature" }, ...sigList].map((x) => (
                      <DropdownMenuItem key={x.id ?? "none"} onClick={() => setSigId(x.id)} className="gap-2 text-[12.5px]">
                        {x.name}
                        {(sigId ?? null) === x.id && <Check className="ml-auto size-3.5 text-primary" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                {signaturePreview && (
                  // Shown as recipients will see it: on white, with its own colors.
                  <div
                    className="max-h-[220px] overflow-auto rounded-lg bg-white px-4 py-3 text-[11pt] text-[#1d1d1f] ring-1 ring-hairline [font-family:Aptos,Calibri,Helvetica,Arial,sans-serif] [&_a]:text-[#0563c1] [&_a]:underline"
                    dangerouslySetInnerHTML={{ __html: signaturePreview }}
                    // A link here would otherwise load in the app's own window.
                    onClick={(e) => {
                      const a = (e.target as HTMLElement).closest("a");
                      if (!a) return;
                      e.preventDefault();
                      void openExternal(a.href);
                    }}
                  />
                )}
              </div>
            )}
            {files.length > 0 && (
              <div className="flex flex-wrap gap-2 border-t border-hairline px-4 py-2.5">
                {files.map((f) => {
                  const Icon = fileIcon(f.mimeType, f.filename);
                  return (
                    <span key={f.id} className="flex h-8 items-center gap-2 rounded-lg border border-hairline bg-pane-2 pr-1.5 pl-2 text-[12px]">
                      <Icon className="size-3.5 text-primary" />
                      <span className="max-w-[180px] truncate">{f.filename}</span>
                      <span className="text-foreground/40">{formatBytes(f.size)}</span>
                      <button onClick={() => setFiles(files.filter((x) => x.id !== f.id))} className="grid size-5 place-items-center rounded text-foreground/40 hover:bg-foreground/10" aria-label={`Remove ${f.filename}`}>
                        <X className="size-3" />
                      </button>
                    </span>
                  );
                })}
                <span className={cn("self-center text-[11.5px]", total > limit ? "text-destructive" : "text-foreground/40")}>
                  {formatBytes(total)} of {formatBytes(limit)}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 border-t border-hairline px-4 py-3">
              <button
                onClick={() => setAsking(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] text-foreground/60 hover:bg-foreground/5"
              >
                <Sparkles className="size-3.5 text-primary" /> {bodyIsEmpty(doc.body) ? "Draft with AI" : "Redraft with AI"}
              </button>
              <button
                onClick={() => fileInput.current?.click()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] text-foreground/60 hover:bg-foreground/5"
              >
                <Paperclip className="size-3.5" /> Attach
              </button>
              <button
                onClick={() => setDrive(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] text-foreground/60 hover:bg-foreground/5"
              >
                <Cloud className="size-3.5" /> Insert from Drive
              </button>
              <DrivePicker
                open={drive}
                onClose={() => setDrive(false)}
                preferAccount={fromId}
                onInsert={(picked) =>
                  picked.length && setDoc((d) => d && { ...d, body: `${d.body}${linksBlockHtml(picked)}` })
                }
              />
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              {savedAt && !dirty && (
                <span className="ml-auto text-[11.5px] text-foreground/40">Saved {savedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              )}
              <button
                onClick={() => void saveDraft()}
                disabled={saving || sending}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] text-foreground/60 hover:bg-foreground/5 disabled:opacity-60",
                  !(savedAt && !dirty) && "ml-auto",
                )}
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save draft{" "}
                <kbd className="ml-1 text-[10.5px] opacity-70">⌘S</kbd>
              </button>
              <span className="inline-flex">
                <button
                  onClick={primary}
                  disabled={sending}
                  className="inline-flex h-8 items-center gap-1.5 rounded-l-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground disabled:opacity-60"
                >
                  {sendAt === null ? (
                    <>
                      {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Send{" "}
                      <kbd className="ml-1 text-[10.5px] opacity-70">⌘↵</kbd>
                    </>
                  ) : (
                    <>
                      {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Clock className="size-3.5" />} Schedule
                    </>
                  )}
                </button>
                <SendLaterMenu
                  align="end"
                  onPick={(at) => setSendAt(at.getTime())}
                  trigger={
                    <button
                      aria-label="Send later"
                      disabled={sending}
                      className="inline-flex h-8 items-center rounded-r-lg border-l border-white/20 bg-primary px-1.5 text-primary-foreground disabled:opacity-60"
                    >
                      <ChevronDown className="size-3.5" />
                    </button>
                  }
                />
              </span>
            </div>
            {sendAt !== null && (
              <div className="-mt-2 px-4 pb-3">
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-primary/10 px-2.5 py-1.5 text-[12.5px] font-medium text-primary">
                  <Clock className="size-3.5" /> Sends {longWhen(sendAt)}
                  {localHold && <span className="font-normal text-foreground/50">· zMail must be open on this Mac then</span>}
                  <button className="ml-auto font-normal text-foreground/55 hover:text-foreground" onClick={() => setSendAt(null)}>
                    Send now instead
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
