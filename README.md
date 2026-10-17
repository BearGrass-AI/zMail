<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="zMail icon">
</p>

<h1 align="center">zMail</h1>

I get a lot of email, and most of it doesn't need me. zMail is the Mac mail client I wanted for that: it sorts the inbox into what actually needs me, what's worth a skim, and what can go, and it lets me hand the busywork to an assistant.

It works with Outlook / Microsoft 365 and Gmail, and it's built with Tauri 2 (Rust), React 19, Tailwind and Zustand. macOS only. It's a personal project, so expect rough edges.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/today-dark.jpg">
  <img src="docs/images/today-light.jpg" alt="The Today view: what needs you, sorted by urgency, with your next meeting and suggestions from your inbox on the right">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/triage-dark.jpg">
  <img src="docs/images/triage-light.jpg" alt="Triage: the inbox as three lanes, Needs you, Worth a skim and Can go">
</picture>

<sub>Screenshots use the built-in demo mailbox.</sub>

## Two models, two jobs

Sorting and writing are different problems, so zMail uses a different model for each.

- **Sorting** goes to a *decision model* like [Jev](https://typesafe.ai), or Clef running in Ollama. It answers a fixed set of questions about each email (which lane, what kind of mail, how urgent, does it want a reply, which folder) and returns probabilities rather than prose. It's fast and cheap enough to run on every message.
- **Writing** goes to a regular LLM (Anthropic, OpenAI, Ollama, or anything OpenAI-compatible). It writes summaries and drafts, and powers the assistant.

When you move an email to another lane or fix its kind, zMail remembers it and shows the decision model those examples the next time that sender writes. It also re-sorts the rest of that sender's inbox right away. Rules are there when you want a guarantee rather than a hint.

## What's in it

- **Today, Triage and a classic three-pane inbox.** Triage is a board: drag cards between lanes, shift-click to select a run, archive a whole lane at once.
- **The assistant** can search your mail, act on it (with Undo), draft and send replies after you confirm, read your calendar, RSVP, look people up, and change settings. Type `@` and a name to point it at someone.
- **Search by meaning.** Optional and fully local: turn it on in Settings → AI Assistant and zMail downloads a ~300 MB embedding model once, then indexes your mail in the background.
- **Scheduled send, snooze, automatic replies, signatures, attachments.** Scheduled mail is sent by zMail itself, so the app has to be open. Anything overdue goes out at the next launch.
- **Calendar** with Teams, Meet and Zoom meeting creation, and drive times from Apple Maps.
- **Notifications** for new mail that needs you, with quiet hours and a dock badge.
- Dark mode that adapts the colors inside emails instead of just inverting them.

## Running it

You'll need Node with pnpm, a Rust toolchain, and Xcode's command line tools.

```sh
pnpm install
pnpm tauri dev   # the real app
pnpm dev         # UI only, in the browser at localhost:1420, with demo mail
```

Dev builds are signed with your local Apple Development identity (see `src-tauri/scripts/dev-run.sh`). Set `ZMAIL_DEV_SIGN_IDENTITY` to use a different one. Notifications only work in a signed build.

Without accounts or models connected, zMail runs on a demo mailbox and mock models, so you can poke around without setting anything up.

## Connecting accounts

Sign-in happens in your browser (OAuth with PKCE and a loopback redirect). Tokens and API keys are stored in the macOS Keychain. Mail is cached in SQLite at `~/Library/Application Support/com.zach.zmail/zmail.sqlite3`.

You bring your own OAuth app for each provider:

### Gmail, Google Calendar and Drive

1. In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create a project and enable the Gmail, Google Calendar, Google Drive and People APIs.
2. Set up the OAuth consent screen as External and add yourself as a test user.
3. Create an OAuth client ID of type **Desktop app**, then paste the client ID and secret into Settings → Accounts → Gmail.

Scopes requested: `gmail.modify`, `gmail.settings.basic`, `calendar.events`, `calendar.calendarlist.readonly`, `drive.metadata.readonly`, `contacts.readonly`, `contacts.other.readonly`, `openid email`.

### Microsoft 365

1. In the Entra admin center, register an app with the **Mobile and desktop applications** platform and `http://localhost` as the redirect URI.
2. Under Authentication, turn on *Allow public client flows*.
3. Add these delegated permissions and grant admin consent: `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Files.Read.All`, `People.Read`, `User.ReadBasic.All`, `MailboxSettings.ReadWrite`, `User.Read`, `offline_access`.
4. Paste the client ID and tenant (`organizations`, or your tenant ID) into Settings → Accounts → Microsoft 365.

If your organization blocks user consent, signing in will send an approval request to your admins instead.

### Zoom

Create a Server-to-Server OAuth app with `meeting:write:admin` and `user:read:admin`, then add the account ID, client ID, client secret and host email in Settings → Video Meetings.

### Models

Add providers in Settings → AI Providers (enter a key, connect, pick a model, send a test), then choose which model does what in Settings → AI Assistant.

| Job | Providers | API |
|---|---|---|
| Sorting | Jev, Ollama 0.35+, custom | `POST /v1/systemone` |
| Writing | Anthropic, OpenAI, Ollama, custom | Anthropic Messages or OpenAI chat completions |

Ollama limits a choice question to 26 options, so people with big folder trees get their folders narrowed down first. All model traffic goes through Rust rather than the webview, so there are no CORS problems and servers on your local network work fine.

## Finding your way around the code

- `src/lib/mail/`: the `MailProvider` interface, the Gmail and Graph implementations, and the demo mailbox.
- `src/lib/ai/triage.ts`: turns an email into one request to the decision model. The questions it asks live here.
- `src/lib/ai/decision.ts` and `generative.ts`: clients for the two kinds of model.
- `src/lib/store/`: app state (Zustand), including what zMail learns from your corrections.
- `src-tauri/src/`: the Rust side, covering HTTP, OAuth, the Keychain, SQLite, the search index and native macOS bits.

## Tests

```sh
pnpm verify        # typecheck, lint, Vitest, cargo test and clippy
pnpm test          # just the front-end tests
cd src-tauri && cargo test -- --ignored   # live checks that hit the Keychain or a real API
```
