// Settings → AI Assistant → Search: the meaning-based search switch, its one-time model download
// (progress, cancel, resume) and the background index's progress. Everything it controls runs on
// this Mac; the download is the only time it uses the network.

import { useEffect, useState, type ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { semanticCancelDownload, semanticDisable, semanticEnable, semanticStatus, type SemanticStatus } from "@/lib/semantic";
import { Group, Row } from "../settings-ui";

const mb = (bytes: number) => `${Math.round(bytes / 1e6).toLocaleString()} MB`;

/** While something is happening the status is read often; otherwise now and then. */
const busy = (s: SemanticStatus | null) => !!s && (s.model === "downloading" || s.model === "verifying" || (s.enabled && s.model === "ready" && s.indexed < s.total));

function Bar({ value }: { value: number }) {
  return (
    <div className="h-1 w-40 overflow-hidden rounded-full bg-foreground/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <div className="h-full rounded-full bg-primary/70 transition-[width] duration-300" style={{ width: `${Math.min(100, value * 100)}%` }} />
    </div>
  );
}

const linkButton = "h-7 shrink-0 rounded-md px-2.5 text-[12px] font-medium text-primary hover:bg-foreground/5";

export function SemanticSearchGroup() {
  const [status, setStatus] = useState<SemanticStatus | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const active = busy(status);
  useEffect(() => {
    let live = true;
    const poll = () =>
      void semanticStatus().then(
        (s) => live && setStatus(s),
        (err: unknown) => live && setFailed(String(err)),
      );
    poll();
    const timer = setInterval(poll, active ? 700 : 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active]);

  /** Run a command, then show the status it answers with (or why it failed). */
  const run = async (f: () => Promise<SemanticStatus>) => {
    setPending(true);
    setFailed(null);
    try {
      setStatus(await f());
    } catch (err) {
      setFailed(String(err));
    } finally {
      setPending(false);
    }
  };

  const hasData = !!status && (status.model === "ready" || status.model === "partial" || status.indexed > 0);
  const toggle = (on: boolean) => {
    if (on) {
      setConfirmOff(false);
      return void run(semanticEnable);
    }
    // Something to keep or delete: ask which. Nothing yet: just off.
    if (hasData || status?.model === "downloading") setConfirmOff(true);
    else void run(() => semanticDisable(false));
  };

  const s = status;
  const on = !!s?.enabled && !confirmOff;
  let detail: ReactNode = null;
  if (s && confirmOff) {
    detail = (
      <Row label="Delete the model and its index too?" hint="Keeping them lets you turn this back on without downloading again.">
        <button className={linkButton} disabled={pending} onClick={() => void run(() => semanticDisable(false)).then(() => setConfirmOff(false))}>
          Keep them
        </button>
        <button
          className="h-7 shrink-0 rounded-md bg-destructive/15 px-2.5 text-[12px] font-semibold text-destructive disabled:opacity-50"
          disabled={pending}
          onClick={() => void run(() => semanticDisable(true)).then(() => setConfirmOff(false))}
        >
          Delete
        </button>
      </Row>
    );
  } else if (s?.model === "downloading") {
    detail = (
      <Row label={`Downloading… ${mb(s.downloaded)} of ${mb(s.size)}`}>
        <Bar value={s.size ? s.downloaded / s.size : 0} />
        <button className={linkButton} onClick={() => void run(semanticCancelDownload)}>
          Cancel
        </button>
      </Row>
    );
  } else if (s?.model === "verifying") {
    detail = <Row label="Checking the download…" />;
  } else if (s?.error && (s.enabled || s.model === "partial")) {
    detail = (
      <Row label={<span className="text-destructive">{s.error}</span>}>
        <button className={linkButton} disabled={pending} onClick={() => void run(semanticEnable)}>
          Try again
        </button>
      </Row>
    );
  } else if (s?.model === "partial") {
    detail = (
      <Row label={`Download paused at ${mb(s.downloaded)} of ${mb(s.size)}`}>
        <button className={linkButton} disabled={pending} onClick={() => void run(semanticEnable)}>
          Resume
        </button>
      </Row>
    );
  } else if (s?.enabled && s.model === "ready") {
    detail =
      s.indexed < s.total ? (
        <Row label={`Indexed ${s.indexed.toLocaleString()} of ${s.total.toLocaleString()}`} hint="Your mail is indexed in the background, newest first. Search uses it as it goes.">
          <Bar value={s.total ? s.indexed / s.total : 0} />
        </Row>
      ) : (
        <Row label={`Ready. ${s.total.toLocaleString()} ${s.total === 1 ? "email" : "emails"} indexed.`} />
      );
  }

  return (
    <Group
      title="Search"
      footer="Best matches appear above search results, and the assistant reads the passages that answer your question instead of whole emails. Mail is indexed on this Mac and never sent anywhere for this."
    >
      <Row label="Meaning-based search" hint="Finds mail by what it's about, not only its exact words. Downloads a 310 MB model. Runs on this Mac; nothing leaves it.">
        <Switch checked={on} disabled={!s || pending} onCheckedChange={toggle} aria-label="Meaning-based search" />
      </Row>
      {detail}
      {failed && <Row label={<span className="text-destructive">{failed}</span>} />}
    </Group>
  );
}
