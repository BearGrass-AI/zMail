// Settings → About zMail: which version this is, whether there's a newer one (check, install,
// relaunch) and where the source lives. An update only shows a card when one is out; otherwise a
// quiet status row says when zMail last looked.

import { useEffect, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useMail } from "@/lib/store";
import { checkForUpdate, installUpdate, relaunch, useUpdates, type UpdateStatus } from "@/lib/updates";
import { cn } from "@/lib/utils";
import appIcon from "@/assets/app-icon.png";
import { version } from "../../../package.json";
import { Group, Row } from "./settings-ui";

const REPO = "https://github.com/umzcio/zMail";

async function openLink(url: string) {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** "Checked 4 minutes ago", from the last time a check got an answer. */
function checkedAgo(at: number | null, now: number): string {
  if (at === null) return "Not checked yet";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `Checked ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** The first few lines of the release notes, without list markers or headings. */
function noteLines(notes: string, max = 3): string[] {
  return notes
    .split("\n")
    .map((line) => line.replace(/^\s*[-*•]\s+/, "").trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, max);
}

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

/** Re-renders once a minute so "Checked 4 minutes ago" stays true. */
function useMinute() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Dot({ tone }: { tone: "ok" | "new" | "error" }) {
  return <span className={cn("mr-1.5 inline-block size-2 rounded-full align-[1px]", tone === "ok" ? "bg-emerald-500" : tone === "new" ? "bg-primary" : "bg-destructive")} />;
}

function Card({ children }: { children: ReactNode }) {
  return <section className="mb-6 grid gap-2 rounded-xl bg-primary/10 px-4 py-3.5">{children}</section>;
}

function LinkRow({ label, hint, url }: { label: string; hint?: string; url: string }) {
  return (
    <button type="button" onClick={() => void openLink(url)} className="flex min-h-12 w-full items-center gap-4 px-4 py-2.5 text-left hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.05] focus-visible:outline-none">
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-foreground/45">{hint}</div>}
      </div>
      <ArrowUpRight className="size-4 text-foreground/35" aria-hidden />
    </button>
  );
}

/** Installed: relaunch, unless unsaved draft text would be lost by quitting. */
function ReadyCard({ version: next }: { version: string }) {
  const dirty = useMail((s) => !!s.compose && s.composeDirty);
  return (
    <Card>
      <div className="text-[13px] font-semibold">
        <Dot tone="new" />
        zMail {next} is ready
      </div>
      <div className="text-[12px] text-foreground/60">{dirty ? "Save or close the message you're writing, then relaunch to finish." : "Relaunch to finish."}</div>
      <div>
        <Button size="sm" disabled={dirty} onClick={() => void relaunch()}>
          Relaunch
        </Button>
      </div>
    </Card>
  );
}

function UpdateCard({ status, onLater }: { status: UpdateStatus; onLater: () => void }) {
  if (status.kind === "available") {
    const lines = noteLines(status.notes);
    const install = async () => {
      const result = await installUpdate();
      // Quitting would drop unsaved draft text; the ready card asks for that to be handled first.
      const s = useMail.getState();
      if (result.ok && !(s.compose && s.composeDirty)) await relaunch();
    };
    return (
      <Card>
        <div className="text-[13px] font-semibold">zMail {status.version} is available</div>
        {lines.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 text-[12px] leading-snug text-foreground/60">
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void install()}>
            Install and relaunch
          </Button>
          <Button size="sm" variant="secondary" onClick={onLater}>
            Later
          </Button>
          <button type="button" onClick={() => void openLink(`${REPO}/releases/tag/v${status.version.replace(/^v/, "")}`)} className="ml-1 text-[12px] font-medium text-primary hover:underline">
            Full notes
          </button>
        </div>
      </Card>
    );
  }
  if (status.kind === "installing") {
    const share = status.total ? Math.min(1, status.downloaded / status.total) : null;
    return (
      <Card>
        <div className="text-[13px] font-semibold">Downloading zMail {status.version}…</div>
        <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share === null ? undefined : Math.round(share * 100)}>
          <div className={cn("h-full rounded-full bg-primary", share === null && "w-1/3 animate-pulse")} style={share === null ? undefined : { width: `${share * 100}%` }} />
        </div>
        <div className="text-[11.5px] text-foreground/50 tabular-nums">{status.total ? `${mb(status.downloaded)} of ${mb(status.total)} MB` : `${mb(status.downloaded)} MB`}</div>
      </Card>
    );
  }
  if (status.kind === "installed") return <ReadyCard version={status.version} />;
  return null;
}

/** The quiet row shown when there's no update card. */
function StatusRow({ status, lastChecked, now }: { status: UpdateStatus; lastChecked: number | null; now: number }) {
  const check = () => void checkForUpdate();
  switch (status.kind) {
    case "unsupported":
      return <Row label="Updates are off in development builds" hint="Install a release build to get updates." />;
    case "checking":
      return (
        <Row
          label={
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin text-foreground/50" aria-hidden />
              Checking for updates…
            </span>
          }
        >
          <Button size="sm" variant="secondary" disabled>
            Check now
          </Button>
        </Row>
      );
    case "error":
      return (
        <Row
          label={
            <>
              <Dot tone="error" />
              Couldn't check for updates
            </>
          }
          hint={status.message}
        >
          <Button size="sm" variant="secondary" onClick={check}>
            Try again
          </Button>
        </Row>
      );
    case "available":
      // The card was put off with Later; the update stays one click away.
      return (
        <Row
          label={
            <>
              <Dot tone="new" />
              zMail {status.version} is available
            </>
          }
          hint={checkedAgo(lastChecked, now)}
        >
          <Button size="sm" onClick={() => void installUpdate()}>
            Install
          </Button>
        </Row>
      );
    case "none":
      return (
        <Row
          label={
            <>
              <Dot tone="ok" />
              zMail is up to date
            </>
          }
          hint={checkedAgo(lastChecked, now)}
        >
          <Button size="sm" variant="secondary" onClick={check}>
            Check now
          </Button>
        </Row>
      );
    default:
      return (
        <Row label="Check for updates" hint={checkedAgo(lastChecked, now)}>
          <Button size="sm" variant="secondary" onClick={check}>
            Check now
          </Button>
        </Row>
      );
  }
}

export function AboutPage() {
  const status = useUpdates((s) => s.status);
  const lastChecked = useUpdates((s) => s.lastChecked);
  const autoCheck = useUpdates((s) => s.autoCheckUpdates);
  const setAutoCheck = useUpdates((s) => s.setAutoCheck);
  const [laterFor, setLaterFor] = useState<string | null>(null);
  const now = useMinute();

  const putOff = status.kind === "available" && laterFor === status.version;
  const card = !putOff && (status.kind === "available" || status.kind === "installing" || status.kind === "installed");

  return (
    <>
      <Group>
        <div className="flex items-center gap-3.5 px-4 py-3.5">
          <img src={appIcon} alt="" className="size-14 shrink-0" />
          <div className="min-w-0">
            <div className="text-[16px] font-bold">zMail</div>
            <div className="mt-0.5 text-[12px] text-foreground/50">Version {version} · Apple silicon</div>
          </div>
        </div>
      </Group>
      {card && <UpdateCard status={status} onLater={() => status.kind === "available" && setLaterFor(status.version)} />}
      <Group footer="Your mail stays on this Mac. Only the requests you send to AI providers leave it.">
        {!card && <StatusRow status={status} lastChecked={lastChecked} now={now} />}
        <Row label="Check for updates automatically" hint="Once a day. zMail asks before installing.">
          <Switch checked={autoCheck} onCheckedChange={setAutoCheck} aria-label="Check for updates automatically" />
        </Row>
        <LinkRow label="Source code" hint="github.com/umzcio/zMail" url={REPO} />
        <LinkRow label="Report a problem" url={`${REPO}/issues/new`} />
      </Group>
    </>
  );
}
