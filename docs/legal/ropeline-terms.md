# RopeLine Terms of Service

**DRAFT for review. Not in force.** Written 2026-10-19 from the zMail code on `ropeline-security` at `e70256a`. These pages are not published, not linked from the app, and they do not turn the hosted verdict on. The gate `ROPELINE_TERMS_READY` in `src/lib/ropeline-hosted.ts` stays `false`.

This draft describes RopeLine as that zMail build implements it. It does not describe any other RopeLine job. [MARK TO CONFIRM] whether a published page should also cover other RopeLine work.

Words in brackets are not in the code. They are for Mark to fill or strike.

## Who offers this

[MARK TO CONFIRM] the legal name of the entity that offers RopeLine, and the name the person contracts with.

In this draft, "RopeLine" means the screening described below. "You" means the person using zMail on their Mac. "We" means the entity named above, once Mark confirms it.

## What you get

RopeLine reads inbox mail on the Mac where zMail is running and shows a Check this or Hold line when the on-device reading finds something. The message stays in its folder. Hold is a warning on the message, not a mailbox.

The reading looks at the text of the message, the From name and address, link text, the file name extension of an attachment, and, when the message has them, the `spf`, `dkim`, and `dmarc` results and a single Reply-To address. It does not open links. It does not open attachment bytes. It does not delete mail.

You can answer the questions on a Check this or Hold message. Answering every question on that message releases the hold. Undo puts the hold back. Unchecking a question puts the hold back. The message is not moved.

Trash and Spam ask you first while a message is on Check this or Hold. Nothing is moved until you confirm. The assistant asks you before it changes a message that is on Check this or Hold, and before it changes a message it has not loaded.

## Two switches, both off to start

In Settings → Sorting & Rules, the RopeLine group has two switches. Both start off (`src/lib/settings.ts`).

**Ask RopeLine for a verdict.** Off, no hosted call is made. On, a hosted call is still not made while `ROPELINE_TERMS_READY` is `false`. The app tells you that turning the switch on does not send anything until the Terms and Privacy pages exist. A verdict address can be typed (200 characters at most). It is unused while the gate is off.

**Move confident spam to Spam.** Off, a verdict never moves mail. On, only a stored verdict whose word is `spam`, on a message still in the inbox, is moved to the account's Spam folder. The reason stored is `RopeLine: confident spam`. Undo puts the message back. Verdicts `good` and `unsure` do not move mail. Trash is not used for this move.

## The hosted verdict stays off

A hosted call is allowed only when all three are true (`hostedCallAllowed` in `src/lib/ropeline-hosted.ts`): the Terms and Privacy gate is on, you turned **Ask RopeLine for a verdict** on, and the verdict address is not blank. The gate is the constant `ROPELINE_TERMS_READY`, and it is `false`. This draft does not change it.

If a later version turns the gate on, the call is a POST to the address you typed, with `/v1/verdict` added. What that POST contains is listed in the Privacy draft. The call waits 8 seconds (`HOSTED_TIMEOUT_MS`). If it times out, the connection fails, or the answer is not the word `good`, `unsure`, or `spam`, the result is dropped. Mail stays where it is. That failure does not create a verdict and does not move mail.

There is no RopeLine server address in the code. The only address is the one you type.

## Your own decision provider is a different switch

zMail can already have a decision provider you saved for sorting. RopeLine's spam questions use that provider, and only that provider (`adviseInbox` in `src/lib/ropeline-questions.ts`). If you have not saved one, the offline stand-in is skipped and those questions are not sent anywhere.

That call is not the hosted verdict. It does not go to the RopeLine verdict address. It goes to the address you saved for the decision provider. The Privacy draft says what it carries.

Those answers advise. They do not file the mail and they do not change the sort.

## What RopeLine does not do in this code

This code does not train a model on your mail. This code does not sell mail. This code does not send one customer's signals to another customer. This code does not bill anyone. This code does not set a warranty, a liability cap, or a court.

[MARK TO CONFIRM] any promise you want the published terms to make on training, sale of data, cross-customer sharing, price, warranty, liability, or where a dispute is heard. Those are not in the code, so they are not promised by this draft.

## Acceptance

[MARK TO CONFIRM] what counts as acceptance: installing zMail, turning a switch on, or a separate step. This code has no "I agree" control for these pages.

## Changes

[MARK TO CONFIRM] the effective date, and how a later change to these terms would be shown to you.

## Contact

[MARK TO CONFIRM] the contact email and the postal address for questions about these terms.
