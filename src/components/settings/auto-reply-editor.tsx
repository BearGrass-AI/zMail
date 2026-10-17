// Settings → Accounts → Automatic replies: the account's out-of-office reply, edited as plain text.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useMail } from "@/lib/store";
import { cancelSignIn } from "@/lib/oauth";
import { generativeProvider } from "@/lib/ai/providers";
import { htmlToText, textToHtml } from "@/lib/signature";
import { fromLocalInput, gmailAudienceOptions, toLocalInput, type AutoReply, type AutoReplyAudience } from "@/lib/mail/auto-replies";
import type { Account } from "@/lib/types";

const CONTAINER = "grid grid-cols-[72px_1fr] items-center gap-x-4 gap-y-3.5 border-t border-hairline bg-foreground/[0.015] py-4 pr-4 pl-[58px] text-[12.5px]";
const INPUT = "selectable h-8 rounded-lg border border-hairline bg-[var(--pane)] px-2.5 text-[13px] outline-none focus:ring-2 focus:ring-ring/30";
const TEXTAREA = "selectable w-full resize-y rounded-lg border border-hairline bg-[var(--pane)] px-2.5 py-2 text-[13px] leading-relaxed outline-none focus:ring-2 focus:ring-ring/30";

/** Tomorrow 8:00 AM to four days after that, 5:00 PM (a working week), local time. */
function defaultRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 5, 17, 0);
  return { start: toLocalInput(start.getTime()), end: toLocalInput(end.getTime()) };
}

interface Draft {
  enabled: boolean;
  scheduled: boolean;
  start: string;
  end: string;
  text: string;
  different: boolean;
  externalText: string;
  audience: AutoReplyAudience;
}

function draftOf(r: AutoReply): Draft {
  const range = r.start && r.end ? { start: toLocalInput(r.start), end: toLocalInput(r.end) } : defaultRange();
  return {
    enabled: r.enabled,
    scheduled: !!(r.start && r.end),
    ...range,
    text: htmlToText(r.message),
    different: r.externalMessage !== undefined,
    externalText: r.externalMessage !== undefined ? htmlToText(r.externalMessage) : "",
    audience: r.audience,
  };
}

/**
 * Plain text back to HTML. Unchanged text keeps the original HTML, so simply opening and saving loses nothing;
 * simple HTML (p/br/div) survives an edit as line breaks. Rich formatting set elsewhere (fonts, styled links)
 * is lost once the text is edited here, which is accepted.
 */
function toHtml(text: string, originalHtml: string | undefined, originalText: string): string {
  return originalHtml !== undefined && text === originalText ? originalHtml : textToHtml(text);
}

const domainOf = (address: string) => address.split("@")[1] ?? address;

function rangeText(start: number, end: number) {
  const day = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `from ${day(start)} to ${day(end)}`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="col-span-2 flex items-center justify-between gap-4">
      <span className="text-foreground/70">{label}</span>
      {children}
    </div>
  );
}

function ReplyForm({ account, value }: { account: Account; value: AutoReply }) {
  const saveAutoReply = useMail((s) => s.saveAutoReply);
  const [draft, setDraft] = useState<Draft>(() => draftOf(value));
  const [saving, setSaving] = useState(false);
  const [writing, setWriting] = useState(false);
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const outlook = account.kind === "m365";
  const domain = domainOf(account.address);
  const original = draftOf(value);

  const start = draft.scheduled ? fromLocalInput(draft.start) : undefined;
  const end = draft.scheduled ? fromLocalInput(draft.end) : undefined;
  const badRange = draft.scheduled && (start === undefined || end === undefined || end <= start);

  const build = (): AutoReply => ({
    enabled: draft.enabled,
    ...(draft.scheduled && start !== undefined && end !== undefined ? { start, end } : {}),
    message: toHtml(draft.text, value.message, original.text),
    ...(outlook && draft.different ? { externalMessage: toHtml(draft.externalText, value.externalMessage, original.externalText) } : {}),
    audience: draft.audience,
    ...(!outlook && value.subject !== undefined ? { subject: value.subject } : {}),
  });

  const save = async () => {
    setSaving(true);
    try {
      const r = build();
      await saveAutoReply(account.id, r);
      toast(r.enabled && !value.enabled ? "Automatic replies on" : !r.enabled && value.enabled ? "Automatic replies off" : "Automatic replies saved");
    } catch (err) {
      toast.error("Couldn't save automatic replies", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const writeForMe = async () => {
    setWriting(true);
    try {
      const away = !badRange && start !== undefined && end !== undefined ? rangeText(start, end) : "until further notice";
      const first = account.name.trim().split(/\s+/)[0] || account.name;
      const text = await generativeProvider().complete(
        [
          {
            role: "user",
            content: `Write a brief, friendly out-of-office reply for ${account.name} (${account.address}). Away ${away}. Plain text, 2–4 short sentences, no subject line, sign with ${first}.`,
          },
        ],
        { maxTokens: 400 },
      );
      patch({ text: text.trim() });
    } catch (err) {
      toast.error("Couldn't write the reply", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setWriting(false);
    }
  };

  return (
    <div className={CONTAINER}>
      <Row label="Send automatic replies">
        <Switch checked={draft.enabled} onCheckedChange={(on) => patch({ enabled: on })} aria-label="Send automatic replies" />
      </Row>
      <Row label="Only during these dates">
        <Switch checked={draft.scheduled} onCheckedChange={(on) => patch({ scheduled: on })} aria-label="Only during these dates" />
      </Row>
      {draft.scheduled && (
        <div className="col-span-2 flex flex-wrap items-center gap-2">
          <span className="text-foreground/50">From</span>
          <input type="datetime-local" value={draft.start} onChange={(e) => patch({ start: e.target.value })} className={INPUT} />
          <span className="text-foreground/50">To</span>
          <input type="datetime-local" value={draft.end} onChange={(e) => patch({ end: e.target.value })} className={INPUT} />
          {badRange && <span className="text-[11.5px] text-destructive">The end must be after the start.</span>}
        </div>
      )}
      <textarea
        rows={5}
        value={draft.text}
        onChange={(e) => patch({ text: e.target.value })}
        placeholder="I'm away and will reply when I'm back."
        aria-label="The reply"
        className={`col-span-2 ${TEXTAREA}`}
      />
      {outlook ? (
        <>
          <Row label={`Different reply for people outside ${domain}`}>
            <Switch checked={draft.different} onCheckedChange={(on) => patch({ different: on, externalText: on && !draft.externalText ? draft.text : draft.externalText })} aria-label="Different reply for people outside" />
          </Row>
          {draft.different && (
            <textarea
              rows={5}
              value={draft.externalText}
              onChange={(e) => patch({ externalText: e.target.value })}
              aria-label="The reply for people outside"
              className={`col-span-2 ${TEXTAREA}`}
            />
          )}
          <Row label={`Reply to people outside ${domain}`}>
            <select
              value={draft.audience}
              onChange={(e) => patch({ audience: e.target.value as AutoReplyAudience })}
              className="h-7 w-[160px] rounded-md border border-hairline bg-[var(--pane)] px-2 text-[12px] outline-none"
            >
              <option value="all">Everyone</option>
              <option value="contactsOnly">Only my contacts</option>
              <option value="none">No one</option>
            </select>
          </Row>
        </>
      ) : (
        <Row label="Reply to">
          <select
            value={draft.audience}
            onChange={(e) => patch({ audience: e.target.value as AutoReplyAudience })}
            aria-label="Who gets an automatic reply"
            className="h-7 w-[200px] rounded-md border border-hairline bg-[var(--pane)] px-2 text-[12px] outline-none"
          >
            {gmailAudienceOptions(value.audience).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Row>
      )}
      <div className="col-span-2 flex items-center gap-2">
        <button
          onClick={() => void writeForMe()}
          disabled={writing}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[12px] text-foreground/70 hover:bg-foreground/5 hover:text-foreground disabled:opacity-60"
        >
          {writing && <Loader2 className="size-3.5 animate-spin" />}✦ Write it for me
        </button>
        <span className="flex-1" />
        <button onClick={() => setDraft(draftOf(value))} className="h-7 rounded-md px-2.5 text-[12px] text-foreground/60 hover:bg-foreground/5">
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={saving || badRange}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-60"
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          Save
        </button>
      </div>
    </div>
  );
}

/** The editor under an account row: loading, sign-in needed, an error, or the form. */
export function AutoReplyEditor({ account, onReconnect, reconnecting = false }: { account: Account; onReconnect: () => void; reconnecting?: boolean }) {
  const value = useMail((s) => s.autoReplies[account.id]);
  const loadAutoReply = useMail((s) => s.loadAutoReply);
  const [retrying, setRetrying] = useState(false);

  // Read the setting again once a sign-in finishes, to pick up the new permission.
  const wasReconnecting = useRef(reconnecting);
  useEffect(() => {
    if (wasReconnecting.current && !reconnecting) void loadAutoReply(account.id);
    wasReconnecting.current = reconnecting;
  }, [reconnecting, account.id, loadAutoReply]);

  if (value === undefined)
    return (
      <div className={CONTAINER}>
        <span className="col-span-2 flex items-center gap-2 text-foreground/50">
          <Loader2 className="size-3.5 animate-spin" />
          Loading…
        </span>
      </div>
    );

  if (value === "needs-permission")
    return (
      <div className={CONTAINER}>
        <span className="col-span-2 text-foreground/70">zMail needs your permission to manage automatic replies for this account.</span>
        <div className="col-span-2 flex items-center gap-3">
          <button
            onClick={onReconnect}
            disabled={reconnecting}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[12px] text-foreground/70 hover:bg-foreground/5 hover:text-foreground disabled:opacity-60"
          >
            {reconnecting && <Loader2 className="size-3.5 animate-spin" />}
            {reconnecting ? "Waiting for sign-in…" : "Sign in again"}
          </button>
          {reconnecting && (
            <button onClick={() => void cancelSignIn()} className="text-[12px] font-medium text-primary hover:underline">
              Cancel
            </button>
          )}
        </div>
      </div>
    );

  if (value === "error")
    return (
      <div className={CONTAINER}>
        <span className="col-span-2 flex items-center gap-3">
          <span className="text-foreground/70">Couldn't load automatic replies.</span>
          <button
            onClick={() => {
              setRetrying(true);
              void loadAutoReply(account.id).finally(() => setRetrying(false));
            }}
            disabled={retrying}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[12px] text-foreground/70 hover:bg-foreground/5 hover:text-foreground disabled:opacity-60"
          >
            {retrying && <Loader2 className="size-3.5 animate-spin" />}
            Retry
          </button>
        </span>
      </div>
    );

  // A fresh form whenever the stored setting changes (after a save, the re-read replaces it).
  return <ReplyForm key={JSON.stringify(value)} account={account} value={value} />;
}
