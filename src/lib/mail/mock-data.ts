// Seeded mailbox for the prototype: two accounts, user folders with filing
// history (so habits can be learned) and an inbox that exercises every bucket.

import type { Account, Email, Folder } from "@/lib/types";

export const ME = { name: "Alex Rivera", address: "alex.rivera@example.com" };

export const ACCOUNTS: Account[] = [
  { id: "personal", kind: "mock", name: "Personal", address: "alex.rivera@example.com" },
  { id: "work", kind: "mock", name: "Work", address: "alex.rivera@example.org" },
];

type F = [id: string, name: string, parent?: string, unread?: number];

function tree(accountId: string, rows: F[], system: [string, Folder["system"], string, number?][]): Folder[] {
  return [
    ...system.map(([id, kind, name, unread]) => ({ id: `${accountId}:${id}`, accountId, name, system: kind, unread })),
    ...rows.map(([id, name, parent, unread]) => ({
      id: `${accountId}:${id}`,
      accountId,
      name,
      parentId: parent ? `${accountId}:${parent}` : undefined,
      unread,
    })),
  ];
}

// Gmail: labels (nestable with "/"), plus Gmail's system boxes.
const PERSONAL = tree(
  "personal",
  [
    ["finance", "Finance"],
    ["finance-taxes", "Taxes", "finance"],
    ["receipts", "Receipts"],
    ["golf", "Golf"],
    ["travel", "Travel"],
    ["dev", "Dev Tools"],
  ],
  [
    ["inbox", "inbox", "Inbox"],
    ["drafts", "drafts", "Drafts", 2],
    ["sent", "sent", "Sent"],
    ["archive", "archive", "All Mail"],
    ["spam", "spam", "Spam", 14],
    ["trash", "trash", "Trash"],
  ],
);

// Outlook: deep folder tree under Inbox, mirroring a real CIO mailbox.
const WORK = tree(
  "work",
  [
    ["chatgpt", "ChatGPT EDU License Renewal", "inbox", 131],
    ["consortiums", "Consortiums", "inbox"],
    ["consortiums-accreditation", "Accreditation", "consortiums"],
    ["consortiums-i2", "Internet2", "consortiums", 3],
    ["coursework", "Coursework", "inbox", 1],
    ["junk-folder", "Junk", "inbox"],
    ["chancellor", "Chancellor", "inbox", 1],
    ["depts", "Campus Departments", "inbox", 28],
    ["students", "Associated Students", "depts"],
    ["athletics", "Athletics", "depts"],
    ["bizsvc", "Business Services", "depts", 10],
    ["bizsvc-procurement", "Procurement", "bizsvc", 6],
    ["bizsvc-payroll", "Payroll", "bizsvc", 4],
    ["affiliates", "Campus Affiliates", "depts"],
    ["affiliates-tech", "Ridge Tech", "affiliates"],
    ["senate", "Faculty Senate", "depts"],
    ["cob", "COB", "depts", 2],
    ["enrollment", "Enrollment", "depts", 2],
    ["hr", "HR", "depts", 8],
    ["audit", "Internal Audit / Risk Management", "depts", 4],
    ["law", "Law", "depts", 1],
    ["legal", "Legal Counsel", "depts", 2],
    ["mc", "City College", "depts", 11],
    ["operations", "Operations", "depts", 1745],
    ["budget", "Budget", "operations", 6],
    ["operations-facilities", "Facilities", "operations", 1739],
    ["orsp", "ORSP", "depts", 13],
    ["k12", "K-12 Partnerships", "depts", 7],
    ["presoffice", "President's Office", "depts"],
    ["presoffice-cabinet", "Cabinet", "presoffice"],
    ["leadership", "Provost Office", "depts", 3],
    ["registrar", "Registrars", "depts"],
    ["sustain", "Sustainability Office", "depts"],
    ["foundation", "Campus Foundation", "depts", 10],
    ["campus-it", "Campus IT", "inbox", 12],
    ["security", "IT Security", "campus-it"],
    ["campus-it-network", "Networking", "campus-it", 5],
    ["campus-it-servicedesk", "Service Desk", "campus-it", 7],
    ["campus-it-apps", "Enterprise Apps", "campus-it"],
    ["vendors", "Vendors", "inbox", 480],
    ["vendors-microsoft", "Microsoft", "vendors", 212],
    ["vendors-ellucian", "Ellucian", "vendors", 268],
    ["listservs", "ListServs", "inbox", 242],
    ["listservs-educause", "EDUCAUSE", "listservs", 180],
    ["listservs-cio", "Regional CIOs", "listservs", 62],
  ],
  [
    ["inbox", "inbox", "Inbox"],
    ["clutter", "clutter", "Clutter"],
    ["archive", "archive", "Archive"],
    ["drafts", "drafts", "Drafts", 151],
    ["snoozed", "snoozed", "Snoozed"],
    ["sent", "sent", "Sent Items"],
    ["trash", "trash", "Deleted Items", 4551],
    ["history", "history", "Conversation History"],
    ["spam", "spam", "Junk Email", 2602],
  ],
);

export const FOLDERS: Folder[] = [...PERSONAL, ...WORK];

let seq = 0;
const ago = (hours: number) => new Date(Date.now() - hours * 36e5).toISOString();

function mail(
  accountId: string,
  folder: string,
  hours: number,
  from: [string, string],
  subject: string,
  text: string,
  extra: Partial<Email> = {},
): Email {
  const id = `m${++seq}`;
  const acct = ACCOUNTS.find((a) => a.id === accountId)!;
  return {
    id,
    accountId,
    threadId: id,
    folderId: `${accountId}:${folder}`,
    from: { name: from[0], address: from[1] },
    to: [{ name: ME.name, address: acct.address }],
    subject,
    snippet: text.replace(/\s+/g, " ").slice(0, 140),
    text,
    date: ago(hours),
    unread: folder === "inbox" && hours < 30,
    starred: false,
    labels: [],
    ...extra,
  };
}

// ---- filing history --------------------------------------------------------

const CHASE: [string, string] = ["Chase", "no-reply@alertsp.chase.com"];
const RAMP: [string, string] = ["Danielle from Ramp", "danielle@ramp.com"];
const PAR: [string, string] = ["Golf League", "scores@golfleague.example.com"];
const DELTA: [string, string] = ["Delta Air Lines", "deltaairlines@t.delta.com"];
const GITHUB: [string, string] = ["GitHub", "noreply@github.com"];
const AMAZON: [string, string] = ["Amazon.com", "auto-confirm@amazon.com"];
const PROVOST: [string, string] = ["Office of the Provost", "provost@example.org"];
const ISO: [string, string] = ["Information Security", "infosec@example.org"];
const BUDGET: [string, string] = ["Budget Office", "budget@example.org"];
const DELL: [string, string] = ["Mark Ellis (Dell Technologies)", "mark.ellis@dell.com"];

function history(): Email[] {
  const out: Email[] = [];
  const file = (n: number, acct: string, folder: string, from: [string, string], subj: string, body: string) => {
    for (let i = 0; i < n; i++)
      out.push(mail(acct, folder, 48 + i * 70 + seq, from, `${subj}`, body, { unread: false }));
  };
  file(14, "personal", "finance", CHASE, "Your statement is ready", "Your monthly statement is now available. Log in to view your balance and payment due date.");
  file(1, "personal", "archive", CHASE, "Security alert", "A new device signed in to your account.");
  file(9, "personal", "golf", PAR, "Round posted", "Your round at Pine Hollow has been posted. Handicap index updated.");
  file(7, "personal", "travel", DELTA, "Your trip confirmation", "Thanks for booking with Delta. Your confirmation number and itinerary are below.");
  file(11, "personal", "dev", GITHUB, "[alexr/SwarmBar] Run failed", "The workflow run failed on main. View the logs for details.");
  file(2, "personal", "archive", GITHUB, "Your personal access token expires soon", "A token on your account expires in 7 days.");
  file(16, "personal", "receipts", AMAZON, "Your Amazon.com order has shipped", "Your package is on the way. Track your package for delivery updates.");
  file(8, "work", "leadership", PROVOST, "Deans & Directors agenda", "Attached is the agenda for this week's Deans and Directors meeting.");
  file(12, "work", "security", ISO, "Weekly vulnerability summary", "This week's scan summary: 4 critical, 19 high findings across campus networks.");
  file(6, "work", "budget", BUDGET, "FY27 budget call", "Please review the FY27 budget call materials and submit your unit's requests.");
  file(5, "work", "vendors", DELL, "Quote follow-up", "Following up on the refresh quote for the lab replacements. Happy to set up a call.");
  file(3, "personal", "finance", RAMP, "Your Ramp card statement", "Your Ramp statement for last month is ready.");
  return out;
}

// ---- sample HTML bodies (exercise the sanitizer and image blocking) --------

const HTML_CLOUDFLARE = `
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;font-family:Helvetica,Arial,sans-serif">
  <tr><td style="padding:24px 0"><img src="https://www.cloudflare.com/img/logo-cloudflare-dark.svg" width="180" alt="Cloudflare"></td></tr>
  <tr><td style="background:#f6821f;color:#fff;padding:36px 28px;border-radius:12px">
    <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;opacity:.85">Connect 2026 · San Francisco · Oct 19–21</div>
    <h1 style="font-size:34px;line-height:1.1;margin:12px 0 0">We are down to the final 100 seats.</h1>
  </td></tr>
  <tr><td style="padding:22px 4px;font-size:15px;line-height:1.6;color:#333">
    Use your code for <b>$100 off</b> before passes sell out.
    <p><a href="https://www.cloudflare.com/connect2026/" style="display:inline-block;background:#f6821f;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Claim your discount</a></p>
    <img src="https://tracking.example.com/open.gif?u=123" width="1" height="1" alt="">
    <script>alert("this must never run")</script>
  </td></tr>
</table>`;

const HTML_STRATECHERY = `
<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif;color:#222">
  <p style="font-size:13px;color:#888;font-family:Helvetica,sans-serif">Stratechery · Issue #412</p>
  <h1 style="font-size:28px;line-height:1.2">The decision model moment</h1>
  <p style="font-size:17px;line-height:1.65">Cloudflare's <a href="https://huggingface.co/Cloudflare/clef">Clef</a> and TypeSafe's Jev point to a new layer in the AI stack — models that <i>decide</i> rather than write.</p>
  <blockquote style="border-left:3px solid #ddd;margin:0;padding:4px 16px;color:#555;font-size:16px">The interesting question isn't whether they replace LLMs. It's how much of today's LLM traffic was really a decision in disguise.</blockquote>
  <p style="font-size:17px;line-height:1.65" onclick="steal()">Read the full piece on the web.</p>
</div>`;

// ---- inbox -----------------------------------------------------------------

function inbox(): Email[] {
  return [
    mail("work", "inbox", 0.4, ["Sarah Kim", "sarah.kim@example.org"], "Can you approve the Banner upgrade window?",
      "Hi Alex,\n\nWe're targeting Saturday 10pm–2am for the Banner 9.4 upgrade. Registrar signed off this morning. Can you approve the change window by end of day today so I can send the campus notice?\n\nThanks,\nSarah"),
    mail("personal", "inbox", 0.2, ["Anthropic", "no-reply@mail.anthropic.com"], "Your secure link to Claude.ai is here",
      "Sign in to Claude.ai. Click the button below to sign in. This secure link will expire in 15 minutes. If you didn't request this, you can ignore this email."),
    mail("work", "inbox", 0.9, PROVOST, "Invitation: AI Governance working group",
      "You're invited to the AI Governance working group kickoff next Tuesday, 3:00–4:00 PM, Admin Building 210. Please RSVP so we can plan materials."),
    mail("work", "inbox", 1.2, PROVOST, "Deans & Directors agenda — Oct 14",
      "Attached is the agenda for next Tuesday's Deans and Directors meeting. Items: enrollment update, AI governance policy draft, and the FY27 budget timeline."),
    mail("personal", "inbox", 2.1, CHASE, "Your statement is ready",
      "Your October statement for the card ending in 4417 is now available. Minimum payment due Nov 3.",
      { attachments: [{ id: "a-chase", filename: "Statement-Oct-2026.pdf", mimeType: "application/pdf", size: 184_320 }] }),
    mail("work", "inbox", 2.6, ["Dana Whitfield", "dana.whitfield@example.org"], "Quick question on the AI pilot budget",
      "Alex — quick one. For the AI pilot, are we funding the Clef inference box out of central IT or the innovation fund? I need to tell the vendor by tomorrow. Let me know your thoughts."),
    mail("personal", "inbox", 3.4, ["Cloudflare", "connectevents@cloudflare.com"], "100 left. $100 off.",
      "Cloudflare Connect 2026 · San Francisco · Oct 19–21. We are down to the final 100 seats. Use your code for $100 off — register now before passes sell out. Last chance.",
      { html: HTML_CLOUDFLARE }),
    mail("personal", "inbox", 4.0, RAMP, "Alex, two free tools to fix AI spend",
      "Hey — hope you enjoyed the cheatsheet. Here are two free tools to help manage AI spend across your team. Unsubscribe anytime."),
    mail("personal", "inbox", 5.2, PAR, "Round posted: Pine Hollow, 41 on the front",
      "Your round at Pine Hollow has been posted. Front nine 41, back 39. Handicap index now 9.8."),
    mail("work", "inbox", 6.0, ISO, "Weekly vulnerability summary — week 41",
      "This week's scan summary: 2 critical, 14 high findings. Critical items are on the Ellen Theatre ticketing kiosks; patching is scheduled for Thursday."),
    mail("personal", "inbox", 7.5, GITHUB, "[alexr/zPDF-engine-spike] Run failed: CI - main",
      "The workflow run 'CI' failed on main. 1 failing job: build-macos. View the logs for details."),
    mail("personal", "inbox", 9.0, AMAZON, "Your Amazon.com order has shipped",
      "Your package with Logitech MX Master 4 is on the way. Arriving Saturday. Track your package for delivery updates."),
    mail("work", "inbox", 10.5, DELL, "Lab refresh quote — revised",
      "Hi Alex, attached is the revised quote for the Liberal Arts lab refresh with the education discount applied. Happy to walk through it.",
      {
        attachments: [
          { id: "a-dell-1", filename: "LA-Lab-Refresh-Quote-v2.pdf", mimeType: "application/pdf", size: 412_800 },
          { id: "a-dell-2", filename: "Config-Matrix.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 58_900 },
        ],
      }),
    mail("personal", "inbox", 12.0, ["Superhuman", "hello@superhuman.com"], "The fastest email experience ever made",
      "This week: new AI features, keyboard shortcuts you missed, and a special offer — 20% off annual plans. Unsubscribe.",
      { unsubscribe: { http: "https://unsubscribe.example/superhuman/u/8f2c1a", oneClick: true } }),
    mail("personal", "inbox", 14.0, ["Stratechery", "newsletter@stratechery.com"], "The decision model moment",
      "This week's newsletter: Cloudflare's Clef and TypeSafe's Jev point to a new layer in the AI stack — models that decide rather than write. Issue #412.",
      { html: HTML_STRATECHERY }),
    mail("work", "inbox", 16.0, ["Marcus Lee", "marcus.lee@example.org"], "Re: Tailnet access for research cluster",
      "Thanks for the quick turnaround yesterday. Everything's working on our side. No action needed — just wanted to close the loop."),
    mail("personal", "inbox", 20.0, DELTA, "Your trip confirmation: DEN → SFO",
      "Thanks for booking with Delta. Confirmation GX7TQ2. Denver to San Francisco, Oct 18, 6:05am. Check in opens 24 hours before departure."),
    mail("work", "inbox", 22.0, BUDGET, "Reminder: FY27 budget submissions due Oct 24",
      "A reminder that FY27 budget submissions are due Friday, October 24. Please use the updated template."),
    mail("personal", "inbox", 26.0, ["Anthropic", "no-reply@mail.anthropic.com"], "Your seat was upgraded",
      "Your seat was upgraded. Your admin has upgraded your seat to Max. Enjoy higher usage limits."),
    mail("personal", "inbox", 30.0, ["Vercel", "notifications@vercel.com"], "Deployment ready: alex-portfolio",
      "Your deployment for alex-portfolio is ready. Preview available at the link below."),
    mail("personal", "inbox", 34.0, ["Mom", "mom@example.com"], "Thanksgiving plans?",
      "Hi honey, are you and the kids coming for Thanksgiving this year? Let me know soon so I can plan. Love, Mom"),
    mail("personal", "inbox", 40.0, ["Notion", "team@makenotion.com"], "Notion Mail is here",
      "Introducing Notion Mail — the inbox that thinks like you. Try it free. Unsubscribe.",
      { unsubscribe: { http: "https://unsubscribe.example/notion/preferences?u=41d7", oneClick: false } }),
    mail("personal", "inbox", 46.0, ["Anthropic", "no-reply@mail.anthropic.com"], "Your secure link to Claude.ai is here",
      "Sign in to Claude.ai. Click the button below to sign in. This secure link will expire in 15 minutes."),
    mail("personal", "inbox", 52.0, ["Raycast", "hello@raycast.com"], "Raycast Monthly: October",
      "Our monthly newsletter: new extensions, AI commands, and community highlights. Unsubscribe.",
      { unsubscribe: { mailto: "mailto:raycast-unsubscribe@example.com?subject=unsubscribe", oneClick: false } }),
    mail("work", "inbox", 55.0, ["Jen Alvarez", "jen.alvarez@example.org"], "Board of Trustees slides — your section",
      "Hi Alex, can you send me your 3 slides for the Trustees deck by Monday? Template attached. Thanks!",
      { attachments: [{ id: "a-jen", filename: "Trustees-Oct-Template.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 2_310_000 }] }),
  ];
}

const AMAZON_SHIP: [string, string] = ["Amazon.com", "shipment-tracking@amazon.com"];
const AMAZON_ORDERS: [string, string] = ["Amazon.com", "auto-confirm@amazon.com"];
const AMAZON_DEALS: [string, string] = ["Amazon", "store-news@amazon.com"];

/** Two years of Amazon mail for the assistant demo: mostly orders and deliveries, some receipts and promos. */
function amazon(): Email[] {
  const items = ["USB-C hub", "Kids' rain boots", "Coffee filters", "Trail running socks", "Golf balls (12)", "Desk lamp", "HDMI cable", "Birthday card"];
  const out: Email[] = [];
  for (let i = 0; i < 30; i++) {
    const item = items[i % items.length];
    const kind = i % 3;
    const [from, subject, text] =
      kind === 0
        ? [AMAZON_ORDERS, `Ordered: "${item}"`, `Thanks for your order. We'll let you know when "${item}" ships.`]
        : kind === 1
          ? [AMAZON_SHIP, `Shipped: ${item}`, `Your package with ${item} is on the way. Track your package.`]
          : [AMAZON_SHIP, "Your package was delivered", `Your package was delivered. It was left at the front door.`];
    out.push(mail("personal", i < 4 ? "inbox" : "archive", 20 + i * 560, from as [string, string], subject as string, text as string, { unread: i < 2 }));
  }
  for (let i = 0; i < 6; i++)
    out.push(mail("personal", "receipts", 300 + i * 2400, AMAZON_ORDERS, i % 2 ? "Your Prime Video receipt" : "Your Amazon.com order receipt", "Order total: $24.17. Thank you for shopping with us.", { unread: false }));
  for (let i = 0; i < 4; i++)
    out.push(mail("personal", "inbox", 60 + i * 900, AMAZON_DEALS, i % 2 ? "Deals picked for you" : "Review your recent purchase", "Top deals based on your shopping. Unsubscribe.", { unread: i === 0 }));
  return out;
}

export function seed(): Email[] {
  seq = 0;
  return [...history(), ...inbox(), ...amazon()];
}
