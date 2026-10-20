# Pointing the gate at the final URLs

Internal note. Not a page to publish. This branch does not change the gate.

## Where the gate is today

`ROPELINE_TERMS_READY` in `src/lib/ropeline-hosted.ts` is `false`. `hostedCallAllowed` returns true only when that constant is true, **Ask RopeLine for a verdict** is on, and the verdict address is not blank. `askHosted` then POSTs `hostedBody` to `{that address}/v1/verdict`.

The constant is not a URL. The app does not fetch a terms page. A non-empty verdict address does not mean the pages exist. The verdict address and the page URLs are different things.

`src/components/settings/rules-page.tsx` reads the same constant. While it is false, the switch hint says turning it on does not send anything yet. The footer says a hosted verdict would send a fingerprint and the signal names, not the message.

That "signal names" sentence is looser than the code. `hostedBody` sends `fingerprint` and `signals`, and each signal is `kind` plus `value`. Values include link hostnames and, in the cases listed in the privacy draft, a sender domain or a short mixed-alphabet word. Subject and body are not fields of the POST.

## What a later commit would change

Do this only after Mark accepts the pages and names the live URLs. Do not do it on this branch.

1. Publish `docs/legal/ropeline-terms.md` and `docs/legal/ropeline-privacy.md` at the URLs Mark names. [MARK TO CONFIRM] those URLs. Putting the files in git does not publish them and does not flip the gate.
2. In `src/lib/ropeline-hosted.ts`, set `ROPELINE_TERMS_READY` to `true`. That is the whole gate. No other flag starts a hosted call.
3. In the same commit, edit the RopeLine footer and hint in `src/components/settings/rules-page.tsx`. When the constant is true, the hint today would say "Sends a fingerprint and the signal names." Change it so it matches `hostedBody`: a fingerprint, and each signal's kind and value, not the message. Link the two final URLs from that footer.
4. Leave both switches defaulting off (`ropeLineHosted` and `ropeLineAct` in `src/lib/settings.ts`). Leave `hostedBody` as it is. Do not treat the verdict address as the terms URL.

Optional, and not required for the gate: a pair of URL constants beside `ROPELINE_TERMS_READY`, used only so the settings footer can open the pages.

## [MARK TO CONFIRM]

1. Legal name of the entity that would offer RopeLine.
2. Contact email and postal address.
3. Governing law and courts.
4. Effective date, and how a later change to the pages would be told to people.
5. What counts as acceptance. The code has no "I agree" control.
6. Warranty, liability cap, and indemnity. The code defines none.
7. Price or contract term. The code defines none.
8. Hosted retention. The client defines none. The period is TBD until Mark sets it.
9. Whether a verdict service would store the fingerprint and the signals, and who would operate it.
10. Subprocessors, if a RopeLine-run address is offered later.
11. The final public URLs of the two pages.
12. Whether the published pages should also cover RopeLine work outside this zMail build. This draft does not.
13. Whether the published policy should promise that mail is not used for training. This code has no training path.
14. Whether threat signals will be shared across customers. This code does not share them. This draft does not authorize sharing.
15. An age rule, which privacy statutes to name, and how a person asks for access or deletion. The code has none of these.
16. That the public description of the hosted payload says kind and value, matching `hostedBody`, rather than "signal names" alone.
