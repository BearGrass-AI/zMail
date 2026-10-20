# RopeLine security design

On-device first. The hosted verdict stays off until the Terms and Privacy pages exist, and even then it sends a fingerprint and signal names, not the message. Nothing in this design deletes mail. Trash is never used automatically. A move to Spam, when the user has turned that on, still has Undo.

## What we are protecting

zMail holds a person's real mailbox and an assistant that can change mail. RopeLine's job here is to notice risky mail and to stop the assistant from acting on it without a confirmation. The person still decides.

## Threats

**Phishing.** A message pushes the reader to sign in, open a file, or follow a link. On this Mac, RopeLine already reads links as text (shorteners, bare IP hosts, punycode, look-alike domains) and can ask the saved decision provider whether the message asks for a sign-in or a file. Those answers advise. They do not file the mail.

**Spoofing.** The visible From can disagree with what the mail server checked. When the message carries an Authentication-Results header, RopeLine reads `spf`, `dkim`, and `dmarc` and nothing else from that header. A DMARC fail is a hold. An SPF or DKIM fail is a warning. A missing header is not treated as a pass and not treated as a fail. Malformed or huge header text is cut and ignored. It never throws.

**Look-alike and homoglyph domains.** A link or a display name can use letters from another alphabet, or a domain a couple of edits from one the person owns. Mixed-script words and punycode are findings. Hidden characters (zero-width, direction overrides) are stripped before a comparison and counted as findings when they sit inside a word.

**Malicious links and attachments.** Links are not opened and not fetched. An attachment whose name ends in a program or script type (for example exe, js, html, iso, lnk) is a hold. The file is not opened.

**Reply-To mismatch.** If Reply-To is a single mailbox and its domain is not the From domain, that is a finding. A line break in the header is refused, so a header cannot smuggle a second line.

**Invoice and payroll fraud.** Words about an invoice, payroll, a wire, or a direct deposit, together with a look-alike domain, a Reply-To mismatch, or a DMARC fail, are a hold. The questions ask whether the invoice was expected and whether to verify on another channel before paying. Checking a question records the answer. It does not release the hold and it does not move the mail.

**Prompt injection.** Mail is data for the assistant, not instructions. Phrases aimed at an automated reader ("ignore previous instructions", "system prompt", "archive all emails") put the message on hold. The assistant's act tool can otherwise archive or relabel up to three emails with no confirm card. Mail that RopeLine marks warn or hold always gets that card, including archive and set-lane. The text shown to the model has direction and zero-width characters removed and is labeled as untrusted data.

## Levels

- **Clear.** No finding. A quiet RopeLine line.
- **Warn.** Something to look at. The message stays where it is.
- **Hold.** Quarantine as a warning state, not a folder. The message stays where it is. The assistant must ask before it changes the message. Nothing is trashed.

## What stays on this Mac

Signals, the fingerprint, the authentication reading, the questions and the person's checks, and the warn or hold level. The decision-provider questions go only to the provider the person already saved (on this Mac, that is Ollama at `localhost` unless they set another address). Clef, when used, is a Cloudflare decision model served through that Ollama decision provider. zMail does not bundle it.

## What may leave, later

Only after the Terms and Privacy pages exist, and only if the hosted switch is on: a fingerprint and the signal names. No subject, no body, no address. The call gives up after eight seconds and fails open: no verdict, mail stays, no move. A network failure is the same. The switch defaults off.

## What this does not do

It does not open links, scan file bytes, or replace the provider's Spam folder. It does not auto-trash. A confident spam verdict moves to Spam only when the person turns that on, and Undo puts it back.
