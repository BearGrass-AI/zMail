import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SPRING, typeInWord } from "@/lib/motion";
import { useShallow } from "zustand/react/shallow";
import { AnimatePresence, motion } from "motion/react";
import {
  Archive,
  ArrowUp,
  Check,
  FolderInput,
  Forward,
  Loader2,
  MailOpen,
  Maximize2,
  OctagonAlert,
  Reply,
  ReplyAll,
  Moon,
  Sparkles,
  Sun,
  Star,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Contact, Email } from "@/lib/types";
import { neighborsOf, orderedEmails, selectHome, suggestionFor, useMail } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useSettings } from "@/lib/settings";
import { generativeProvider } from "@/lib/ai/providers";
import { draft, summarize } from "@/lib/ai/generative";
import { composeHtml, composeText, inlineDataImages, sizeSignatureImages } from "@/lib/signature";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RoundButton, WithTip } from "../icon-button";
import { BUCKET_META, categoryMeta } from "@/lib/meta";
import { SenderAvatar, readerDate, recipientNames } from "../meta";
import { useEmailActions } from "../email-actions";
import { EmailBody, useLightForced, useWouldRenderDark } from "./email-body";
import { warmRender } from "@/lib/mail/dark-mode";
import { useAppDark } from "@/lib/theme";
import { isSingleMailbox } from "@/lib/mail/address";
import { AttachmentStrip } from "./attachments";
import { bucketOf, categoryOf } from "@/lib/store";

/** Text already revealed this session (the last 50), so reopening a summary shows it at once. */
const revealed = new Set<string>();

/** Reveals text word by word so model output feels live; the whole reveal takes 0.2s. */
export function TypeIn({ text }: { text: string }) {
  const [animate] = useState(() => !revealed.has(text));
  useEffect(() => {
    revealed.add(text);
    if (revealed.size > 50) revealed.delete(revealed.values().next().value!);
  }, [text]);
  if (!animate) return <span>{text}</span>;
  const words = text.split(/(\s+)/);
  return (
    <span>
      {words.map((w, i) => (
        <motion.span key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={typeInWord(i, words.length)}>
          {w}
        </motion.span>
      ))}
    </span>
  );
}

function ViewModeButton({ email }: { email: Email }) {
  const wouldDark = useWouldRenderDark(email);
  const forced = useLightForced((s) => s.ids.has(email.id));
  const toggle = useLightForced((s) => s.toggle);
  if (!wouldDark) return null;
  const tip = forced ? "View in dark" : "View in light";
  return (
    <WithTip tip={tip}>
      <RoundButton label={tip} onClick={() => toggle(email.id)}>{forced ? <Moon /> : <Sun />}</RoundButton>
    </WithTip>
  );
}

function SummaryButton({ email }: { email: Email }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [summaryFor, setSummaryFor] = useState(email.id);
  if (summaryFor !== email.id) {
    setSummaryFor(email.id);
    setSummary(null);
  }

  const load = async () => {
    if (summary || loading) return;
    setLoading(true);
    try {
      setSummary(await summarize(generativeProvider(), email));
    } catch (err) {
      setSummary(`Couldn't summarize: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Popover onOpenChange={(o) => o && void load()}>
      <WithTip tip="Summarize">
        <PopoverTrigger render={<RoundButton label="Summarize" />}>
          <Sparkles />
        </PopoverTrigger>
      </WithTip>
      <PopoverContent align="end" sideOffset={8} className="w-[380px] rounded-2xl p-4">
        <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-foreground/55">
          <Sparkles className="size-3.5" /> Summary
        </div>
        <div className="text-[14px] leading-relaxed">
          {loading || !summary ? (
            <span className="inline-flex items-center gap-2 text-foreground/50">
              <Loader2 className="size-3.5 animate-spin" /> Reading…
            </span>
          ) : (
            <TypeIn text={summary} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function SuggestionBanner({ email }: { email: Email }) {
  const sel = useMail(useShallow(selectHome));
  const dismiss = useMail((s) => s.dismissSuggestion);
  const threshold = useSettings((s) => s.suggestThreshold);
  const sug = suggestionFor(sel, email, threshold);
  const a = useEmailActions();

  // Keyed per email and not animated in: moving to an email that has a suggestion shows it in
  // place on the first paint instead of pushing the body down. Moving or dismissing still folds it away.
  return (
    <AnimatePresence key={email.id} initial={false}>
      {sug && (
        <motion.div
          initial={{ opacity: 0, height: 0, marginTop: 0 }}
          animate={{ opacity: 1, height: "auto", marginTop: 16 }}
          exit={{ opacity: 0, height: 0, marginTop: 0 }}
          transition={SPRING}
          className="overflow-hidden"
        >
          <div className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/[0.07] px-3.5 py-2.5">
            <WandSparkles className="size-4 shrink-0 text-primary" />
            <p className="flex-1 text-[13px] leading-snug">
              {sug.evidence && sug.evidence.total > 0 ? (
                <>
                  You've filed <b>{sug.evidence.filed}</b> of {sug.evidence.total} emails from{" "}
                  {email.from.name.split(" ")[0]} into <b>{sug.folder.name}</b>.
                </>
              ) : (
                <>
                  This looks like it belongs in <b>{sug.folder.name}</b>.
                </>
              )}{" "}
              Move it?
              <span className="ml-1.5 text-[11px] tabular-nums text-foreground/45">
                {Math.round(sug.probability * 100)}%
              </span>
            </p>
            <button
              onClick={() => void a.move([email.id], sug.folder.id)}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-primary px-2.5 text-[12px] font-medium text-primary-foreground transition"
            >
              <Check className="size-3.5" /> Move
            </button>
            <button
              onClick={() => dismiss([email.id])}
              className="grid size-7 place-items-center rounded-lg text-foreground/50 hover:bg-foreground/5"
              aria-label="Dismiss suggestion"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function QuickReply({ email }: { email: Email }) {
  const me = useMail((s) => s.me);
  const accounts = useMail((s) => s.accounts);
  const sendMail = useMail((s) => s.send);
  const openCompose = useMail((s) => s.openCompose);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [textFor, setTextFor] = useState(email.id);
  if (textFor !== email.id) {
    setTextFor(email.id);
    setText("");
  }

  /** Continue in the full reply editor; the body is Markdown or plain text and arrives formatted. */
  const openFull = (body: string) => {
    openCompose({ mode: "blank", replyTo: email.id, prefill: body.trim() ? { body } : undefined });
    setText("");
  };

  const drafting = useRef(false);
  const aiDraft = async () => {
    if (drafting.current) return;
    drafting.current = true;
    setBusy(true);
    try {
      // AI drafts are whole emails with formatting: they open in the full editor, not this one-line box.
      openFull((await draft(generativeProvider(), text || "reply helpfully", me, email)).body);
    } catch (err) {
      toast.error("Draft failed", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      drafting.current = false;
      setBusy(false);
    }
  };

  const [sending, setSending] = useState(false);
  // Grow with the text (wrapped lines too) up to max-h-48, then scroll.
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  // A ref, not state: two quick clicks or ⌘↩ presses land before a re-render.
  const inFlight = useRef(false);
  const send = async () => {
    if (!text.trim() || inFlight.current) return;
    // A malformed From parses to no address: there is no one to reply to.
    if (!isSingleMailbox(email.from.address)) return toast.error("Couldn't send", { description: "This sender has no valid email address to reply to." });
    inFlight.current = true;
    setSending(true);
    const account = accounts.find((a) => a.id === email.accountId);
    try {
      const { signatures, signatureDefaults } = useMail.getState();
      const signature = signatures.find((x) => x.id === signatureDefaults[email.accountId]?.reply)?.html;
      const { html, inline } = inlineDataImages(await sizeSignatureImages(composeHtml(text, signature)));
      await sendMail(email.accountId, {
        to: [email.from.address],
        subject: email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`,
        text: composeText(text, signature),
        html,
        inline,
        replyTo: email,
      });
      toast.success(`Reply sent to ${email.from.name}`, account?.kind === "mock" ? { description: "Demo account — nothing left your Mac." } : undefined);
      setText("");
    } catch (err) {
      toast.error("Couldn't send", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  return (
    <div className="border-t border-hairline p-3">
      <div className="flex items-end gap-2 rounded-2xl border border-hairline bg-pane-2 px-3 py-2 focus-within:ring-2 focus-within:ring-ring/30">
        <textarea
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          readOnly={sending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={`Quick reply to ${email.from.name}…  (type an instruction and hit ✨ to draft)`}
          className={cn(
            "selectable max-h-48 flex-1 resize-none bg-transparent py-1 text-[13px] outline-none placeholder:text-foreground/40",
            sending && "text-foreground/50",
          )}
        />
        <WithTip tip="Open in full editor">
          <button
            onClick={() => openFull(text)}
            disabled={busy || sending}
            className="grid size-7 place-items-center rounded-full text-foreground/50 hover:bg-foreground/[0.07] hover:text-foreground"
            aria-label="Open in full editor"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </WithTip>
        <WithTip tip="Draft with AI">
          <button
            onClick={() => void aiDraft()}
            disabled={busy || sending}
            className="grid size-7 place-items-center rounded-full text-primary hover:bg-primary/10"
            aria-label="Draft with AI"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          </button>
        </WithTip>
        <WithTip tip={sending ? "Sending…" : "Send"} shortcut={sending ? undefined : "⌘↩"}>
          <button
            disabled={!text.trim() || sending}
            onClick={() => void send()}
            className={cn(
              "grid size-7 place-items-center rounded-full bg-primary text-primary-foreground transition",
              sending ? "disabled:opacity-70" : "disabled:opacity-30",
            )}
            aria-label={sending ? "Sending…" : "Send"}
          >
            {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </button>
        </WithTip>
      </div>
    </div>
  );
}

/** "To: Anne Grant, Antony Jo and 4 more" — names, hover for the address, click "more" to show all. */
function Recipients({ label, list }: { label: string; list: Contact[] }) {
  const accounts = useMail((s) => s.accounts);
  const [open, setOpen] = useState(false);
  if (list.length === 0) return null;
  const names = recipientNames(list, accounts.map((a) => a.address));
  const shown = open ? names : names.slice(0, 3);
  const more = names.length - shown.length;
  return (
    <div className="selectable text-[12.5px] text-foreground/50">
      {label}:{" "}
      {shown.map((n, i) => (
        <span key={`${n.address}:${i}`}>
          <span title={n.address}>{n.label}</span>
          {i < shown.length - 1 ? ", " : ""}
        </span>
      ))}
      {more > 0 && (
        <>
          {" and "}
          <button type="button" className="hover:text-foreground/80 hover:underline" onClick={() => setOpen(true)}>
            {more} more
          </button>
        </>
      )}
    </div>
  );
}

export function Reader() {
  const a = useEmailActions();
  const email = useMail((s) => s.emails.find((e) => e.id === s.selectedId));
  const junk = useMail((s) => s.folders.find((f) => f.id === email?.folderId)?.system === "spam");
  const t = useMail((s) => (s.selectedId ? s.triage[s.selectedId] : undefined));
  const bucket = useMail((s) => (s.selectedId ? bucketOf(s, s.selectedId) : undefined));
  const category = useMail((s) => (s.selectedId ? categoryOf(s, s.selectedId) : undefined));
  const select = useMail((s) => s.select);
  const ensureBody = useMail((s) => s.ensureBody);
  const scroller = useRef<HTMLDivElement>(null);
  const emailId = email?.id;
  const trimmed = !!email?.bodyTrimmed;
  const [bodyFailed, setBodyFailed] = useState<string | null>(null);
  // List rows carry no html: load the full body on open, and again if a refresh swaps in a slim row.
  useEffect(() => {
    if (!emailId || !trimmed) return;
    let live = true;
    ensureBody(emailId).catch(() => live && setBodyFailed(emailId));
    return () => {
      live = false;
    };
  }, [emailId, trimmed, ensureBody]);

  // The scroll area stays mounted across emails, so reset it by hand.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [emailId]);

  // Once the open email is readable, warm the next two and the previous one.
  const appDark = useAppDark();
  const background = useSettings((s) => s.messageBackground);
  useEffect(() => {
    if (!emailId || trimmed) return;
    const timer = setTimeout(() => {
      const s = useMail.getState();
      for (const id of neighborsOf(orderedEmails(s).map((e) => e.id), emailId))
        void s.ensureBody(id).then((e) => e?.html && warmRender(e.html, appDark, background)).catch(() => undefined);
    }, 150);
    return () => clearTimeout(timer);
  }, [emailId, trimmed, appDark, background]);

  return (
    <section className="flex h-full min-w-0 flex-col">
      <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-1.5 border-b border-hairline px-3">
        {email && (
          <>
            <WithTip tip="Close" shortcut="Esc"><RoundButton label="Close" onClick={() => select(null)}><X /></RoundButton></WithTip>
            <div className="mx-1.5 h-5 w-px bg-hairline" />
            <WithTip tip="Reply" shortcut="R"><RoundButton label="Reply" onClick={() => a.reply(email.id)}><Reply /></RoundButton></WithTip>
            <WithTip tip="Reply all" shortcut="A"><RoundButton label="Reply all" onClick={() => a.replyAll(email.id)}><ReplyAll /></RoundButton></WithTip>
            <WithTip tip="Forward" shortcut="F"><RoundButton label="Forward" onClick={() => a.forward(email.id)}><Forward /></RoundButton></WithTip>
            <div className="mx-1.5 h-5 w-px bg-hairline" />
            <WithTip tip="Archive" shortcut="E">
              <RoundButton label="Archive" onClick={() => void a.archive([email.id])}><Archive /></RoundButton>
            </WithTip>
            <WithTip tip="Spam"><RoundButton label="Spam" onClick={() => void a.spam([email.id])}><OctagonAlert /></RoundButton></WithTip>
            <WithTip tip="Trash" shortcut="#">
              <RoundButton label="Trash" onClick={() => void a.trash([email.id])}><Trash2 /></RoundButton>
            </WithTip>
            <WithTip tip="Move to folder" shortcut="V">
              <RoundButton label="Move to folder" onClick={() => a.pickFolder([email.id])}>
                <FolderInput />
              </RoundButton>
            </WithTip>
            <div className="ml-auto flex gap-1.5">
              <ViewModeButton email={email} />
              <SummaryButton email={email} />
              <WithTip tip="Star" shortcut="S">
                <RoundButton label="Star" onClick={() => a.star(email.id)}>
                  <Star className={email.starred ? "fill-amber-400 text-amber-400" : ""} />
                </RoundButton>
              </WithTip>
              <WithTip tip="Mark unread">
                <RoundButton label="Mark unread" onClick={() => a.read([email.id], false)}>
                  <MailOpen />
                </RoundButton>
              </WithTip>
            </div>
          </>
        )}
      </header>

      {email ? (
        <div className="flex min-h-0 flex-1 flex-col">
            <div ref={scroller} className="flex-1 overflow-y-auto px-8 py-7">
              <h2 className="selectable text-[24px] leading-tight font-semibold tracking-tight">{email.subject}</h2>
              <div className="mt-4 flex items-center gap-3">
                <SenderAvatar contact={email.from} junk={junk} className="size-10 text-[13px]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-semibold">{email.from.name}</span>
                    <span className="selectable truncate rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11.5px] text-foreground/55">
                      {email.from.address}
                    </span>
                  </div>
                  <Recipients key={email.id} label="To" list={email.to} />
                  <Recipients key={`${email.id}:cc`} label="Cc" list={email.cc ?? []} />
                </div>
                <div
                  className="shrink-0 text-[12.5px] text-foreground/50"
                  title={new Date(email.date).toLocaleString([], { dateStyle: "full", timeStyle: "short" })}
                >
                  {readerDate(email.date)}
                </div>
              </div>

              {t && bucket && (
                <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px] text-foreground/50">
                  <span className="size-[7px] rounded-full" style={{ background: `var(--bucket-${bucket})` }} />
                  <span
                    className="font-medium text-foreground/70"
                    title={`Sorted by ${t.model}, ${Math.round((t.bucketProbs[t.bucket] ?? 0) * 100)}% sure`}
                  >
                    {BUCKET_META[bucket].label}
                  </span>·
                  <span>{categoryMeta(category ?? t.category).label}</span>
                  {t.needsReply > 0.5 && <>· <span>reply expected</span></>}
                </div>
              )}

              <SuggestionBanner email={email} />
              <AttachmentStrip email={email} />

              <div className="mt-6 border-t border-hairline pt-6">
                {email.html !== undefined || !email.bodyTrimmed || bodyFailed === email.id ? (
                  <EmailBody email={email} />
                ) : (
                  <>
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.3 }}
                      className="inline-flex items-center gap-2 text-[13px] text-foreground/50"
                    >
                      <Loader2 className="size-3.5 animate-spin" /> Loading…
                    </motion.div>
                    <div className="min-h-[200px]" />
                  </>
                )}
              </div>
            </div>
            <QuickReply email={email} />
        </div>
      ) : (
        <div className="grid flex-1 place-items-center text-[13px] text-foreground/40">Select a message</div>
      )}
    </section>
  );
}
