// Synthetic email bodies for the dark-mode tests (no real mail). Each mimics how a
// common sender writes HTML. A <style> that opens the body would be hoisted into
// <head> and dropped by sanitizing, so style blocks here follow some body content,
// as they do in forwarded and web-composed mail. (Outlook's <!-- --> wrapped blocks
// don't survive sanitizing at all, so the Outlook one here is unwrapped.)

/** Outlook desktop: MsoNormal style block, windowtext, a maroon signature, a quoted header. */
export const OUTLOOK = `<div class="WordSection1"><style>
@font-face {font-family:"Cambria Math"; panose-1:2 4 5 3 5 4 6 3 2 4;}
p.MsoNormal, li.MsoNormal, div.MsoNormal {margin:0in; font-size:11.0pt; font-family:"Calibri",sans-serif; color:black;}
a:link, span.MsoHyperlink {mso-style-priority:99; color:#0563C1; text-decoration:underline;}
span.EmailStyle17 {mso-style-type:personal-compose; font-family:"Calibri",sans-serif; color:windowtext;}
.MsoChpDefault {mso-style-type:export-only; font-size:10.0pt;}
@page WordSection1 {size:8.5in 11.0in; margin:1.0in 1.0in 1.0in 1.0in;}
div.WordSection1 {page:WordSection1;}
</style>
<p class="MsoNormal">Hi team,</p>
<p class="MsoNormal">&nbsp;</p>
<p class="MsoNormal">Please review the budget draft before Thursday's meeting. <a href="https://example.org/budget">The shared folder</a> has last year's numbers.</p>
<p class="MsoNormal"><span class="EmailStyle17">I've flagged the travel line.</span></p>
<p class="MsoNormal"><span style="color:#1F497D">Thanks,</span></p>
<p class="MsoNormal"><b><span style="color:#7A0019">Jordan Example</span></b></p>
<p class="MsoNormal"><b><span style="font-size:9.0pt;color:#990033">Director, Office of Example Studies</span></b></p>
<p class="MsoNormal"><font color="#7a0019">Example University &middot; 555-0100</font></p>
<p class="MsoNormal"><span style="font-size:8.0pt;color:gray">Confidentiality notice: this message is an example.</span></p>
<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in">
<p class="MsoNormal"><b><span style="color:windowtext">From:</span></b><span style="color:windowtext"> Casey Sample &lt;casey@example.org&gt;<br><b>Sent:</b> Monday, October 12, 2026 9:14 AM<br><b>To:</b> Jordan Example<br><b>Subject:</b> Budget draft</span></p>
</div>
<p class="MsoNormal">Here is the first draft of the budget.</p>
<p class="MsoNormal" style="background:yellow"><span style="color:black">Highlighted: due Friday.</span></p>
</div>`;

/** Gmail web: rgb() colors, a purple signature, a quoted block with a grey rule. */
export const GMAIL = `<div dir="ltr">Hi Sam,<div><br></div><div>Lunch Friday works. <span style="color:rgb(34,34,34)">See you at noon.</span></div><div><br></div><div><font color="#888888">--&nbsp;</font><div dir="ltr" class="gmail_signature"><div style="color:rgb(80,0,80)">Alex Placeholder</div><div><span style="color:rgb(102,102,102);font-size:12px">Example Co. &middot; Product</span></div></div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Oct 12, 2026 at 9:00 AM Sam Test &lt;<a href="mailto:sam@example.com">sam@example.com</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Are you free for lunch this week?</div></blockquote></div></div>`;

/** Marketing newsletter: nested bgcolor tables, a light callout, a colored button, a dark footer band. */
export const NEWSLETTER = `<div class="wrapper"><style>
.headline { color:#1a1a1a; font-size:26px; }
.muted { color:#999999; font-size:12px; }
.cta a { color:#ffffff !important; text-decoration:none; }
@media (prefers-color-scheme: light) { .rule { border-color:#dddddd !important; } }
@media only screen and (max-width:600px) { .inner { width:100% !important; } }
</style>
<table width="100%" bgcolor="#f4f4f4" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="padding:24px 0">
<table class="inner" width="600" bgcolor="#ffffff" cellpadding="0" cellspacing="0" role="presentation">
<tr><td style="padding:24px 32px">
<h1 class="headline">Fall Product Roundup</h1>
<p style="color:#555555;font-size:15px">Three new things we think you'll like this season, plus a few tips.</p>
<table width="100%" bgcolor="#e8f0fe" cellpadding="0" cellspacing="0" role="presentation"><tr><td style="padding:12px 16px;color:#174ea6">Tip: save your favourites to get a reminder when they're back.</td></tr></table>
<p class="rule" style="border-top:1px solid #eeeeee;padding-top:12px">Our picks are below.</p>
<table class="cta" cellpadding="0" cellspacing="0" role="presentation"><tr><td bgcolor="#e4002b" style="border-radius:4px;padding:12px 20px"><a href="https://shop.example.com/sale">Shop the sale</a></td></tr></table>
<p style="background-color:hsl(48, 100%, 90%);color:hsla(30, 80%, 30%, 1);padding:8px">Limited offer: ends Sunday.</p>
<p style="color:#2e7d32">In stock and ready to ship.</p>
</td></tr>
<tr><td bgcolor="#333333" style="padding:16px 32px;color:#ffffff">Free returns for 30 days.</td></tr>
<tr><td class="muted" style="padding:16px 32px">You're receiving this because you subscribed. <a href="https://shop.example.com/unsubscribe" style="color:#999999">Unsubscribe</a></td></tr>
</table>
</td></tr></table></div>`;

/** Ships its own dark design (prefers-color-scheme: dark rules). */
export const OWN_DARK = `<div class="pre"></div><style>
@media (prefers-color-scheme: light) { .card { background:#ffffff !important; } }
@media screen and (prefers-color-scheme: dark) { .card { background:#121212 !important; } .card p { color:#f5f5f5 !important; } }
</style><div class="card" style="background:#ffffff;padding:16px"><p style="color:#0a0b0d">Your identity is verified.</p></div>`;

/** Sets no colors at all. */
export const PLAIN = `<p>Hi there,</p><p>Just a <b>plain</b> note with a <a href="https://example.com">link</a>.</p>`;

/** A background-image hero with text on it, the rest an ordinary light layout. */
export const HERO = `<table width="100%" bgcolor="#ffffff" cellpadding="0" cellspacing="0" role="presentation">
<tr><td background="https://img.example.com/hero.jpg" style="background-image:url(https://img.example.com/hero.jpg);background-color:#f0e6d2;padding:40px 24px"><h2 style="margin:0;color:#3b2a14">Autumn arrivals</h2></td></tr>
<tr><td style="padding:24px;color:#333333">
<p>New this week: wool scarves, canvas bags and a few surprises for the cold months. Each one is made in small batches, so popular colours sell out quickly.</p>
<p>Members get early access on Thursday morning, and free shipping on every order over fifty dollars through the end of the month.</p>
<p style="color:#8a5a00">See you soon, the Example Goods team.</p>
</td></tr></table>`;

/** The whole layout sits on a background image: keeps the light card. */
export const IMAGE_LAYOUT = `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:url(https://img.example.com/paper.jpg) repeat #fdf8ee"><tr><td style="padding:32px;color:#3a2e1f">
<h1>Holiday card</h1>
<p>Wishing you and yours a warm and restful season. Thank you for a wonderful year working together.</p>
<p>With best wishes from all of us at Example Studio.</p>
</td></tr></table>`;

export const FIXTURES = { OUTLOOK, GMAIL, NEWSLETTER, OWN_DARK, PLAIN, HERO, IMAGE_LAYOUT };
