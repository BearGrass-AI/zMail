// src/lib/ai/assistant/modules/index.ts
// Every assistant module. A new capability gets its own file and is added to this list.
import type { ToolModule } from "./types";
import { calendarModule } from "./calendar";
import { attachmentsModule } from "./attachments";
import { peopleModule } from "./people";
import { snoozeModule } from "./snooze";
import { organizeModule } from "./organize";
import { navigateModule } from "./navigate";
import { settingsModule } from "./settings";
import { sendModule } from "./send";
import { travelModule } from "./travel";
import { webModule } from "./web";
import { autoreplyModule } from "./autoreply";
import { passagesModule } from "./passages";

export const MODULES: ToolModule[] = [calendarModule, attachmentsModule, peopleModule, snoozeModule, organizeModule, navigateModule, settingsModule, sendModule, travelModule, webModule, autoreplyModule, passagesModule];
