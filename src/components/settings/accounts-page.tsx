// Settings → Accounts: connected accounts (edit, reconnect, automatic replies, remove) and adding Gmail or Microsoft 365.

import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Loader2, PlugZap } from "lucide-react";
import { toast } from "sonner";
import { connectGoogle, connectMicrosoft, loadOAuthApp, reconnect, type OAuthApp } from "@/lib/connect";
import { cancelSignIn } from "@/lib/oauth";
import { useMail } from "@/lib/store";
import { cn } from "@/lib/utils";
import { activeNow } from "@/lib/mail/auto-replies";
import { toIconDataUrl } from "@/lib/image";
import type { Account } from "@/lib/types";
import { AccountIcon, accountColorOf, accountLabel } from "../account-switcher";
import { AutoReplyEditor } from "./auto-reply-editor";
import { Group, Row } from "./settings-ui";

function ConnectForm({ provider }: { provider: "google" | "microsoft" }) {
  const [app, setApp] = useState<OAuthApp>({ clientId: "", clientSecret: "", tenant: "organizations" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void loadOAuthApp(provider).then((saved) => setApp((a) => ({ ...a, ...saved, clientSecret: saved.clientSecret ?? "" })));
  }, [provider]);
  const google = provider === "google";

  const connect = async () => {
    setBusy(true);
    try {
      const account = await (google ? connectGoogle(app) : connectMicrosoft(app));
      toast.success(`Connected ${account.address}`, { description: "Syncing mail and calendar…" });
    } catch (err) {
      toast.error("Couldn't connect", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const field = (k: keyof OAuthApp, label: string, placeholder: string, type = "text") => (
    <Row label={label}>
      <input
        type={type}
        value={app[k] ?? ""}
        onChange={(e) => setApp({ ...app, [k]: e.target.value })}
        placeholder={placeholder}
        className="selectable h-7 w-[340px] rounded-md border border-hairline bg-[var(--pane)] px-2.5 font-mono text-[11.5px] outline-none focus:ring-2 focus:ring-ring/30"
      />
    </Row>
  );

  return (
    <>
      <div className="px-4 py-3 text-[12px] leading-relaxed text-foreground/60">
        {google ? (
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>
              In{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), void openLink("https://console.cloud.google.com/apis/credentials"))} className="text-primary hover:underline">
                Google Cloud Console
              </a>
              , create a project and enable the Gmail, Google Calendar and Google Drive APIs.
            </li>
            <li>OAuth consent screen: External, and add yourself as a test user.</li>
            <li>Credentials → Create OAuth client ID → <b>Desktop app</b>. Paste the ID and secret below.</li>
          </ol>
        ) : (
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>
              In{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), void openLink("https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"))} className="text-primary hover:underline">
                Entra admin center
              </a>
              , register an app. Choose <b>Single tenant</b> for your own organization, or another account type if others will use it. Under
              Platform, choose <b>Mobile and desktop applications</b> and set the redirect URI to <code>http://localhost</code>.
            </li>
            <li>
              Under Authentication → Settings, turn on <b>Allow public client flows</b>.
            </li>
            <li>
              Under API permissions, add these Microsoft Graph delegated permissions: Mail.ReadWrite, Mail.Send, MailboxSettings.ReadWrite, Calendars.ReadWrite, Files.Read.All,
              People.Read, User.ReadBasic.All, User.Read, offline_access, openid, email. Then use <b>Grant admin consent</b>. If your organization requires admin approval
              for apps, ask an admin to approve it.
            </li>
            <li>
              Paste the Application (client) ID below. For <b>Tenant</b>, use your Directory (tenant) ID or your domain. Use <code>organizations</code>{" "}
              only for multi-tenant apps.
            </li>
          </ol>
        )}
      </div>
      {field("clientId", google ? "Client ID" : "Application (client) ID", google ? "1234…apps.googleusercontent.com" : "00000000-0000-0000-0000-000000000000")}
      {google
        ? field("clientSecret", "Client secret", "GOCSPX-…", "password")
        : field("tenant", "Tenant", "Directory (tenant) ID or your domain")}
      <Row label="" hint="Opens your browser to sign in. zMail never sees your password; tokens are stored in the Keychain.">
        <button
          onClick={() => void connect()}
          disabled={busy || !app.clientId}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground transition disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
          {busy ? "Waiting for browser…" : google ? "Sign in with Google" : "Sign in with Microsoft"}
        </button>
      </Row>
    </>
  );
}

async function openLink(url: string) {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener");
}

const SWATCHES = ["oklch(0.68 0.16 25)", "#7a0d32", "oklch(0.68 0.16 295)", "oklch(0.68 0.16 255)", "oklch(0.68 0.16 195)", "oklch(0.68 0.16 150)", "oklch(0.7 0.15 75)", "oklch(0.6 0.02 260)"];

/** Inline editor for an account's name, icon and color. */
function AccountEditor({ account, onReconnect, reconnecting = false }: { account: Account; onReconnect?: () => void; reconnecting?: boolean }) {
  const accounts = useMail((s) => s.accounts);
  const updateAccount = useMail((s) => s.updateAccount);
  const fileInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const color = accountColorOf(account, accounts);

  const applyImage = async (file?: File | null) => {
    if (!file) return;
    try {
      await updateAccount(account.id, { icon: await toIconDataUrl(file) });
    } catch (err) {
      toast.error("Couldn't use that image", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="grid grid-cols-[72px_1fr] items-center gap-x-4 gap-y-3.5 border-t border-hairline bg-foreground/[0.015] py-4 pr-4 pl-[58px] text-[12.5px]">
      <span className="text-foreground/50">Name</span>
      <input
        defaultValue={account.label ?? ""}
        placeholder={accountLabel({ ...account, label: undefined }, accounts)}
        onBlur={(e) => void updateAccount(account.id, { label: e.target.value.trim() || undefined })}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="selectable h-8 w-full max-w-[320px] rounded-lg border border-hairline bg-[var(--pane)] px-2.5 text-[13px] outline-none focus:ring-2 focus:ring-ring/30"
      />
      <span className="text-foreground/50">Icon</span>
      <div className="flex items-center gap-3">
        <button
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void applyImage(e.dataTransfer.files[0]);
          }}
          title="Drop an image here, or click to choose one"
          className={cn("rounded-[14px] p-0.5 ring-2 ring-transparent transition", over ? "ring-primary" : "hover:ring-hairline")}
        >
          <AccountIcon account={account} size={56} />
        </button>
        <div className="flex flex-col items-start gap-1.5">
          <div className="flex gap-1.5">
            <button onClick={() => fileInput.current?.click()} className="h-7 rounded-md bg-foreground/[0.07] px-2.5 text-[12px] font-medium hover:bg-foreground/10">
              Upload image…
            </button>
            {account.icon && (
              <button onClick={() => void updateAccount(account.id, { icon: undefined })} className="h-7 rounded-md px-2.5 text-[12px] text-foreground/60 hover:bg-foreground/5">
                Use letter
              </button>
            )}
          </div>
          <span className="text-[11px] text-foreground/40">PNG, JPG or SVG · drop it on the tile · stays on this Mac</span>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/gif,image/webp"
          hidden
          onChange={(e) => {
            void applyImage(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      <span className="text-foreground/50">Color</span>
      <div className="flex items-center gap-2">
        {SWATCHES.map((c) => (
          <button
            key={c}
            aria-label={`Color ${c}`}
            onClick={() => void updateAccount(account.id, { color: c })}
            className={cn("size-5 rounded-full transition hover:scale-110", color === c && "ring-2 ring-foreground ring-offset-2 ring-offset-[var(--pane)]")}
            style={{ background: c }}
          />
        ))}
        <label title="Custom color" className="relative size-5 cursor-pointer overflow-hidden rounded-full bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] transition hover:scale-110">
          <input type="color" className="absolute inset-0 cursor-pointer opacity-0" onChange={(e) => void updateAccount(account.id, { color: e.target.value })} />
        </label>
        {account.color && (
          <button onClick={() => void updateAccount(account.id, { color: undefined })} className="ml-1 text-[11.5px] text-foreground/45 hover:text-foreground">
            Reset
          </button>
        )}
      </div>
      {onReconnect && (
        <>
          <span className="text-foreground/50">Sign-in</span>
          <div className="flex items-center gap-3">
            <button
              onClick={onReconnect}
              disabled={reconnecting}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[12px] text-foreground/70 hover:bg-foreground/5 hover:text-foreground disabled:opacity-60"
            >
              {reconnecting && <Loader2 className="size-3.5 animate-spin" />}
              {reconnecting ? "Waiting for sign-in…" : "Sign in again"}
            </button>
            {reconnecting ? (
              <button onClick={() => void cancelSignIn()} className="text-[12px] font-medium text-primary hover:underline">
                Cancel
              </button>
            ) : (
              <span className="text-[11.5px] text-foreground/45">Picks up newly approved permissions</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function AccountsPage() {
  const accounts = useMail((s) => s.accounts);
  const folders = useMail((s) => s.folders);
  const status = useMail((s) => s.accountStatus);
  const removeAccount = useMail((s) => s.removeAccount);
  const refresh = useMail((s) => s.refresh);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [adding, setAdding] = useState<"google" | "microsoft" | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [replies, setReplies] = useState<string | null>(null);
  const autoReplies = useMail((s) => s.autoReplies);
  const loadAutoReply = useMail((s) => s.loadAutoReply);
  // Each Reconnect opens a browser sign-in; a ref stops a second click before the re-render.
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const reconnectBusy = useRef(false);
  const startReconnect = (a: Account) => {
    if (reconnectBusy.current) return;
    reconnectBusy.current = true;
    setReconnecting(a.id);
    void reconnect(a)
      .then(() => toast.success(`Reconnected ${a.address}`))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "sign-in cancelled") toast.error("Couldn't reconnect", { description: msg });
      })
      .finally(() => {
        reconnectBusy.current = false;
        setReconnecting(null);
      });
  };

  const kindLabel = (kind: string) => (kind === "m365" ? "Microsoft 365" : kind === "gmail" ? "Gmail" : "Demo mailbox");

  return (
    <>
      <Group title="Connected" footer="Demo mailboxes hold sample mail so you can try zMail. Remove them once your real accounts are in.">
        {accounts.length === 0 && <Row label={<span className="text-foreground/45">No accounts yet.</span>} />}
        {accounts.map((a) => {
          const st = status[a.id];
          return (
            <div key={a.id}>
            <Row
              label={
                <span className="flex items-center gap-2.5">
                  <AccountIcon account={a} size={32} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{accountLabel(a, accounts)}</span>
                    <span className="block truncate text-[11.5px] text-foreground/45">
                      {a.address !== accountLabel(a, accounts) && `${a.address} · `}
                      {kindLabel(a.kind)} · {folders.filter((f) => f.accountId === a.id && !f.system).length} folders
                      {st?.state === "syncing" && " · syncing…"}
                      {st?.state === "error" && <span className="text-destructive"> · {st.error}</span>}
                    </span>
                  </span>
                </span>
              }
            >
              {a.kind !== "mock" && st?.state === "error" && (
                <button
                  onClick={() => startReconnect(a)}
                  disabled={reconnecting !== null}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {reconnecting === a.id && <Loader2 className="size-3.5 animate-spin" />}
                  {reconnecting === a.id ? "Waiting for sign-in…" : "Reconnect"}
                </button>
              )}
              {reconnecting === a.id && st?.state === "error" && (
                <button onClick={() => void cancelSignIn()} className="h-7 px-1.5 text-[12px] font-medium text-primary hover:underline">
                  Cancel
                </button>
              )}
              {(() => {
                const r = autoReplies[a.id];
                const on = !!r && typeof r === "object" && activeNow(r);
                return (
                  <button
                    onClick={() => {
                      if (replies === a.id) return setReplies(null);
                      setReplies(a.id);
                      void loadAutoReply(a.id);
                    }}
                    className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-foreground/60 hover:bg-foreground/5", replies === a.id && "bg-foreground/[0.07] text-foreground")}
                  >
                    {on && <span className="size-1.5 rounded-full bg-emerald-500" aria-label="On" />}
                    Automatic replies
                  </button>
                );
              })()}
              <button
                onClick={() => setEditing(editing === a.id ? null : a.id)}
                className={cn("h-7 rounded-md px-2.5 text-[12px] text-foreground/60 hover:bg-foreground/5", editing === a.id && "bg-foreground/[0.07] text-foreground")}
              >
                {editing === a.id ? "Done" : "Edit"}
              </button>
              {a.kind !== "mock" && (
                <button
                  onClick={() => void refresh()}
                  disabled={st?.state === "syncing"}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-foreground/60 hover:bg-foreground/5 disabled:hover:bg-transparent"
                >
                  {st?.state === "syncing" && <Loader2 className="size-3.5 animate-spin" />}
                  {st?.state === "syncing" ? "Syncing…" : "Sync now"}
                </button>
              )}
              {confirm === a.id ? (
                <button
                  onClick={() => {
                    void removeAccount(a.id);
                    setConfirm(null);
                  }}
                  className="h-7 rounded-md bg-destructive/15 px-2.5 text-[12px] font-semibold text-destructive"
                >
                  Confirm remove
                </button>
              ) : (
                <button onClick={() => setConfirm(a.id)} className="h-7 rounded-md px-2.5 text-[12px] text-foreground/60 hover:bg-foreground/5 hover:text-destructive">
                  Remove
                </button>
              )}
            </Row>
            {replies === a.id && <AutoReplyEditor account={a} onReconnect={() => startReconnect(a)} reconnecting={reconnecting === a.id} />}
            {editing === a.id && <AccountEditor account={a} onReconnect={a.kind !== "mock" ? () => startReconnect(a) : undefined} reconnecting={reconnecting === a.id} />}
            </div>
          );
        })}
      </Group>
      <Group title="Add account">
        <Row label="Gmail" hint="Mail, labels and Google Calendar.">
          <button
            onClick={() => setAdding(adding === "google" ? null : "google")}
            className="h-7 rounded-md border border-hairline bg-[var(--pane)] px-3 text-[12px] font-medium hover:bg-foreground/5"
          >
            {adding === "google" ? "Cancel" : "Connect"}
          </button>
        </Row>
        {adding === "google" && <ConnectForm provider="google" />}
        <Row label="Microsoft 365" hint="Outlook mail, folders and calendar via Microsoft Graph.">
          <button
            onClick={() => setAdding(adding === "microsoft" ? null : "microsoft")}
            className="h-7 rounded-md border border-hairline bg-[var(--pane)] px-3 text-[12px] font-medium hover:bg-foreground/5"
          >
            {adding === "microsoft" ? "Cancel" : "Connect"}
          </button>
        </Row>
        {adding === "microsoft" && <ConnectForm provider="microsoft" />}
      </Group>
    </>
  );
}
