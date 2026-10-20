# RopeLine Privacy Policy

**DRAFT for review. Not in force.** Written 2026-10-19 from the zMail code on `ropeline-security` at `e70256a`. These pages are not published, not linked from the app, and they do not turn the hosted verdict on. The gate `ROPELINE_TERMS_READY` in `src/lib/ropeline-hosted.ts` stays `false`.

This draft describes RopeLine as that zMail build implements it. It does not describe any other RopeLine job. [MARK TO CONFIRM] whether a published page should also cover other RopeLine work.

The hosted client was added on `ropeline-phase3` (`e1ecad9`) in `src/lib/ropeline-hosted.ts` (`hostedBody`, `hostedCallAllowed`, `askHosted`, `attachVerdicts`). The 8-second timeout and the fail-open are in that same file (`HOSTED_TIMEOUT_MS`, and `askHosted` returning no verdict on timeout or error), on `ropeline-security`.

Words in brackets are not in the code.

## Who this is about

[MARK TO CONFIRM] the legal name of the entity responsible for RopeLine, and the contact email and postal address for a privacy question.

"You" means the person using zMail on their Mac. RopeLine in this draft is the screening in that app.

## What stays on the Mac

On each sort, RopeLine reads inbox mail on the machine and stores a flag in zMail's local snapshot (`state.v1` in the app's database). The flag holds:

- the signals listed below
- a fingerprint, or none
- a local key, the first 32 hex characters of a SHA-256 of the From address, the subject, and the text
- later, if you have a saved decision provider, that provider's advice
- later, if a hosted verdict were ever allowed and returned, the word `good`, `unsure`, or `spam`
- your answers to the on-screen questions

The local key is not sent in the hosted request.

The on-device security reading (`screenMail` in `src/lib/ropeline-security.ts`) also stays on the Mac. It uses the stored signals when they exist, and otherwise reads the same mailbox signals. It also reads `spf`, `dkim`, and `dmarc` from Authentication-Results, one Reply-To address, the attachment's file-name extension, payment words, and phrases aimed at an automated reader. Those authentication results, the Reply-To address, the attachment name, and the question answers are not fields of the hosted request.

Flags for mail still loaded are kept, plus up to 5,000 flags for mail that is no longer loaded (`RESULTS_CAP` in `src/lib/store/persistence.ts`). The code sets no number of days after which a flag expires.

[MARK TO CONFIRM] whether the published policy should promise a deletion period for data on the Mac. The code does not.

## The hosted verdict: off, and opt-in

No hosted call is made unless three things are all true:

1. `ROPELINE_TERMS_READY` is true. It is false in this build.
2. You turned **Ask RopeLine for a verdict** on. It starts off.
3. The verdict address is not blank. It starts blank.

Turning the switch on while the gate is false does not send anything. The settings line says so.

If a later build turns the gate on, a sort can POST once per inbox message in that sort that has a fingerprint or at least one signal, and that does not already have a verdict for the current text. The URL is the address you typed, trailing slashes removed, then `/v1/verdict`. The code adds no API key and no Authorization header to that call.

### Fields that would be posted

`hostedBody` builds the only object that may be posted. It has two fields:

| Field | What it is |
|---|---|
| `fingerprint` | 16 lowercase hex digits, or `null`. A simhash of the subject and the body after normalization. Null when that normalized wording is under 8 words. |
| `signals` | Up to 60 items. Each item is `kind` and `value`. |

Normalization lowercases the wording, drops format characters, replaces a URL with the word `url`, replaces an email-shaped token with the word `email`, and replaces a run of digits with `0`. The subject and the body are not copied into the JSON. The fingerprint is a digest of that normalized wording, not the wording itself.

`value` is cut at 320 characters. The kinds the code can send, and what `value` is for each:

| `kind` | `value` |
|---|---|
| `url_count` | How many links were seen, as digits |
| `url_domain` | A link's hostname, `www.` removed, up to 20 |
| `shortener` | A shortener hostname, up to 10 |
| `ip_literal_url` | A numeric host from a link, up to 10 |
| `punycode_domain` | A hostname that uses `xn--`, up to 10 |
| `lookalike_domain` | A hostname whose name is within two edits of a long label on a domain of yours, up to 10 |
| `own_domain_sender` | The sender's domain, only when it matches a connected account's domain and that domain is not in the free-mail list |
| `free_mail_sender` | The sender's domain, only when it is in the built-in free-mail list |
| `zero_width_text` | How many hidden characters sit inside words |
| `bidi_control` | How many direction-control characters were counted |
| `mixed_script` | One mixed-alphabet word, cut at 64 characters |
| `name_repeated` | The word `word` |
| `name_random_string` | `digits`, `case`, or `consonants` |

A domain can appear more than once, for example as both `shortener` and `url_domain`.

The posted object does not have a subject field, a body field, a snippet field, a full From address, the local key, the decision-provider advice, your question answers, `spf` / `dkim` / `dmarc`, the Reply-To address, or an attachment name. The sender's domain can appear, as the table says. A mixed-alphabet word from the display name or the text can appear, cut at 64 characters. Link hostnames can appear.

If the fingerprint is null and there are no signals, the code does not POST.

The code reads one field of the reply: `verdict`. It keeps it only when the word is `good`, `unsure`, or `spam`. Any other reply is dropped.

### Eight seconds, then fail open

The call waits 8 seconds (`HOSTED_TIMEOUT_MS` is 8000). If the wait ends, the connection fails, or the verdict word is not one of those three, `askHosted` returns no verdict. The message stays where it is. That failure does not move mail.

A verdict already stored as `spam` can still move on a later sort if you have turned **Move confident spam to Spam** on. That switch starts off. The move goes to Spam, with Undo, and does not use Trash.

### Retention of a hosted copy

The client does not define a hosted store, a log, or a retention period. [MARK TO CONFIRM] whether a verdict service would keep the fingerprint and the signals, for how long, and who would operate that service. Until you set that, the retention of anything received at the verdict address is TBD.

The code names no subprocessor. The verdict address is whatever you type. [MARK TO CONFIRM] the operator and any subprocessors, if a RopeLine-run address is offered later.

## A different call: your saved decision provider

This is not the hosted verdict, and it does not use the RopeLine verdict address.

If you have saved a decision provider, `spamRequest` in `src/lib/ropeline-questions.ts` sends that provider a POST to `{its address}/v1/systemone`. The body includes the provider's model name, a note that the message is data, and the message as `from` (name and address), `subject`, and `body` cut at 2,400 characters. It also includes the question text RopeLine asks. If you saved an API key for that provider, the request carries it as a Bearer token.

If you have not saved a decision provider, this call is not made.

That provider is yours. The catalog default for an Ollama-style provider is `http://localhost:11434`. [MARK TO CONFIRM] whether the published policy should name any particular model host. This code does not send that request to a fixed RopeLine host.

The answers are stored on the Mac in the flag as advice. They do not file the mail.

## Training

No RopeLine file in this build sends mail to a training job, a fine-tune, or a dataset export. [MARK TO CONFIRM] if the published policy should promise that this stays true. A promise past what the code does is yours to make.

## Sharing across customers

This zMail code posts, when the gate and the switch allow it, to the one address you typed. It does not add another customer's mail, and it does not fan a signal out to other sites. [MARK TO CONFIRM] that a published policy should keep it that way. Cross-customer sharing is not in this code, and this draft does not authorize it.

## Sale

This code has no sale of mail and no advertising use. [MARK TO CONFIRM] the published sentence you want on sale of personal information.

## Children and privacy requests

This code has no age check and no form for an access, correction, or deletion request. Deleting the app's local database removes the local snapshot; the code does not define a hosted copy to delete.

[MARK TO CONFIRM] an age rule, which privacy statutes you want named, and how a person asks for access or deletion.

## Contact

[MARK TO CONFIRM] the privacy contact email and postal address.
