// Settings → Video Meetings: Teams and Meet come with their accounts; Zoom needs its own app.

import { useEffect, useState } from "react";
import { Loader2, PlugZap } from "lucide-react";
import { toast } from "sonner";
import { loadZoom, saveZoom, testZoom } from "@/lib/zoom/zoom";
import { useMail } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Group, Row } from "./settings-ui";

export function VideoMeetingsPage() {
  const accounts = useMail((s) => s.accounts);
  const [cfg, setCfg] = useState({ accountId: "", clientId: "", clientSecret: "", userEmail: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void loadZoom().then((z) => z && setCfg(z));
  }, []);
  const field = (k: keyof typeof cfg, label: string, placeholder: string, type = "text") => (
    <Row label={label}>
      <input
        type={type}
        value={cfg[k]}
        onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })}
        placeholder={placeholder}
        className="selectable h-7 w-[300px] rounded-md border border-hairline bg-[var(--pane)] px-2.5 font-mono text-[11.5px] outline-none focus:ring-2 focus:ring-ring/30"
      />
    </Row>
  );
  const saveAndTest = async () => {
    setBusy(true);
    try {
      await saveZoom(cfg);
      const who = await testZoom();
      toast.success("Zoom connected", { description: `Meetings will be hosted by ${who}.` });
    } catch (err) {
      toast.error("Zoom didn't connect", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  const has = (k: string) => accounts.some((a) => a.kind === k);
  return (
    <>
      <Group title="Built in" footer="Created with the event on the calendar you choose.">
        <Row label="Microsoft Teams" hint="On Outlook calendars (Microsoft 365 account).">
          <span className={cn("text-[12px]", has("m365") ? "text-[var(--bucket-ready_archive)]" : "text-foreground/40")}>
            {has("m365") ? "Available" : "Connect Microsoft 365"}
          </span>
        </Row>
        <Row label="Google Meet" hint="On Google calendars (Gmail account).">
          <span className={cn("text-[12px]", has("gmail") ? "text-[var(--bucket-ready_archive)]" : "text-foreground/40")}>
            {has("gmail") ? "Available" : "Connect Gmail"}
          </span>
        </Row>
      </Group>
      <Group
        title="Zoom"
        footer="Uses a Zoom Server-to-Server OAuth app (Zoom Marketplace → Develop → Build App → Server-to-Server OAuth) with the meeting:write:admin and user:read:admin scopes. The secret is stored in the Keychain."
      >
        {field("accountId", "Account ID", "Zoom account id")}
        {field("clientId", "Client ID", "Client id")}
        {field("clientSecret", "Client secret", "Client secret", "password")}
        {field("userEmail", "Host", "you@example.org")}
        <Row label="">
          <button
            onClick={() => void saveAndTest()}
            disabled={busy || !cfg.accountId || !cfg.clientId || !cfg.clientSecret || !cfg.userEmail}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />} Save &amp; test
          </button>
        </Row>
      </Group>
    </>
  );
}
