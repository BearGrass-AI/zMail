// Settings → Sorting & Rules: automatic rules, date suggestions, "always file" rules and what zMail has learned.

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/lib/settings";
import { folderPath, useMail } from "@/lib/store";
import { describeRule, isLaneRule } from "@/lib/rules";
import { Group, Row } from "./settings-ui";
import { ROPELINE_TERMS_READY } from "@/lib/ropeline-hosted";

export function RulesPage() {
  const s = useMail();
  const rules = Object.entries(s.rules);
  const corrections = Object.keys(s.overrides).length + Object.keys(s.categoryOverrides).length + Object.keys(s.sectionOverrides).length;
  const learned = [...s.habits.values()].filter((h) => h.total >= 2).length;
  const folderName = (id: string) => s.folders.find((f) => f.id === id)?.name;
  const findDates = useSettings((x) => x.findDatesEverywhere);
  const hosted = useSettings((x) => x.ropeLineHosted);
  const hostedUrl = useSettings((x) => x.ropeLineHostedUrl);
  const setSetting = useSettings((x) => x.set);
  const muted = Object.keys(s.noDateSenders);
  // Reset can't be undone: it asks first, naming what goes.
  const [confirmReset, setConfirmReset] = useState(false);
  const lessons = s.lessons.length;
  const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  return (
    <>
      <Group title="Automatic rules" footer="These act on new mail without asking. Undo is in the notification. Create them from the ✦ Assistant after a cleanup.">
        {s.autoRules.length === 0 && <Row label={<span className="text-foreground/45">No automatic rules yet.</span>} />}
        {s.autoRules.map((r) => (
          <Row
            key={r.id}
            label={describeRule(r, folderName)}
            hint={isLaneRule(r) ? "Applies to all mail from this sender" : r.lastHitAt ?`${r.hits} emails · last on ${new Date(r.lastHitAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Hasn't run yet"}
          >
            <Switch checked={r.enabled} onCheckedChange={(on) => s.setAutoRuleEnabled(r.id, on)} aria-label="Enabled" />
            <button onClick={() => s.removeAutoRule(r.id)} className="grid size-7 place-items-center rounded-md text-foreground/45 hover:bg-foreground/5 hover:text-destructive" aria-label="Remove automatic rule">
              <Trash2 className="size-3.5" />
            </button>
          </Row>
        ))}
      </Group>
      <Group
        title="RopeLine"
        footer="The check on this Mac always runs and only flags mail. A hosted verdict stays off until RopeLine's Terms and Privacy pages are published. It would send a fingerprint and the signal names, not the message."
      >
        <Row
          label="Ask RopeLine for a verdict"
          hint={ROPELINE_TERMS_READY ? "Sends a fingerprint and the signal names." : "Off until the Terms and Privacy pages exist. Turning this on does not send anything yet."}
        >
          <Switch checked={hosted} onCheckedChange={(on) => setSetting({ ropeLineHosted: on })} aria-label="Ask RopeLine for a verdict" />
        </Row>
        <Row label="Verdict address" hint="Used only after those pages exist.">
          <input
            aria-label="RopeLine verdict address"
            value={hostedUrl}
            onChange={(e) => setSetting({ ropeLineHostedUrl: e.target.value.slice(0, 200) })}
            placeholder="https://example.com"
            maxLength={200}
            spellCheck={false}
            className="w-56 rounded-md bg-transparent px-2 py-1 text-[13px] outline-none ring-1 ring-foreground/15"
          />
        </Row>
      </Group>
      <Group title="Dates">
        <Row label="Find dates in your mail" hint="Offers to add due dates, deadlines and events to your calendar. Skips promotions and newsletters.">
          <Switch checked={findDates} onCheckedChange={(on) => setSetting({ findDatesEverywhere: on })} aria-label="Find dates in your mail" />
        </Row>
        <Row label="No date suggestions from" hint={muted.length ? undefined : "None"} />
        {muted.map((addr) => (
          <Row key={addr} label={addr}>
            <button onClick={() => s.removeNoDateSender(addr)} className="grid size-7 place-items-center rounded-md text-foreground/45 hover:bg-foreground/5 hover:text-destructive" aria-label={`Allow date suggestions from ${addr}`}>
              <Trash2 className="size-3.5" />
            </button>
          </Row>
        ))}
      </Group>
      <Group title="Always file" footer='Add rules by right-clicking an email → "Always file … in…". zMail still asks before each move.'>
        {rules.length === 0 && <Row label={<span className="text-foreground/45">No rules yet.</span>} />}
        {rules.map(([sender, folderId]) => (
          <Row key={sender} label={sender} hint={folderPath(s.folders, folderId)}>
            <button onClick={() => s.removeRule(sender)} className="grid size-7 place-items-center rounded-md text-foreground/45 hover:bg-foreground/5 hover:text-destructive" aria-label="Remove rule">
              <Trash2 className="size-3.5" />
            </button>
          </Row>
        ))}
      </Group>
      <Group title="What zMail has learned">
        <Row label="Senders with a filing habit" hint="Learned from where you've filed mail before.">
          <span className="text-[13px] font-medium tabular-nums">{learned}</span>
        </Row>
        <Row label="Your corrections" hint="Buckets, kinds of email and sections you've corrected, from dragging in Triage or “Teach zMail”.">
          <span className="text-[13px] font-medium tabular-nums">{corrections}</span>
          {corrections > 0 && !confirmReset && (
            <button onClick={() => setConfirmReset(true)} className="h-7 rounded-md px-2.5 text-[12px] text-foreground/55 hover:bg-foreground/5">
              Reset
            </button>
          )}
          {corrections > 0 && confirmReset && (
            <>
              <span className="text-[12px] text-foreground/55">
                Forget {plural(corrections, "correction")}
                {lessons > 0 && ` and ${plural(lessons, "lesson")}`}? This can't be undone.
              </span>
              <button
                onClick={() => {
                  s.clearOverrides();
                  setConfirmReset(false);
                }}
                className="h-7 rounded-md bg-destructive px-2.5 text-[12px] font-medium text-white"
              >
                Reset
              </button>
              <button onClick={() => setConfirmReset(false)} className="h-7 rounded-md px-2.5 text-[12px] text-foreground/60 hover:bg-foreground/5">
                Cancel
              </button>
            </>
          )}
        </Row>
      </Group>
    </>
  );
}
