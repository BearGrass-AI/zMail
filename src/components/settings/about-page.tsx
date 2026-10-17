// Settings → About zMail.

import { Group, Row } from "./settings-ui";

export function AboutPage() {
  return (
    <Group footer="Local-first: mail stays on this Mac. Only model requests leave it, to the providers you choose.">
      <Row label="zMail" hint="An AI-first email client">
        <span className="text-[12px] text-foreground/50">0.1.0 prototype</span>
      </Row>
      <Row label="Stack" hint="Tauri 2 · React · shadcn · Motion" />
    </Group>
  );
}
