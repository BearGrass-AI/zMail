// What counts as one email address. A header can carry `<alice@example.com; bob@example.org>`
// inside one pair of angle brackets; kept whole, that string reads as one recipient on screen
// but splits into two when the composer separates its fields on commas and semicolons. So
// addresses from headers and every recipient at send must be exactly one mailbox.

/** Characters an address never contains but a list of addresses (or padding to hide one) does. */
const NOT_IN_ADDRESS = /[\s,;<>]/;

/** One bare address: not empty, and no whitespace, comma, semicolon or angle bracket. */
export function isSingleMailbox(address: string): boolean {
  return address.length > 0 && !NOT_IN_ADDRESS.test(address);
}

/**
 * The address of one recipient as typed: `jane@example.com` or `Jane Appleseed <jane@example.com>`.
 * Undefined when the entry isn't exactly one address.
 */
function recipientAddress(entry: string): string | undefined {
  const lt = entry.lastIndexOf("<");
  if (lt < 0) return isSingleMailbox(entry) ? entry : undefined;
  if (!entry.endsWith(">") || /[<>]/.test(entry.slice(0, lt))) return undefined;
  const address = entry.slice(lt + 1, -1).trim();
  return isSingleMailbox(address) ? address : undefined;
}

/**
 * The recipients in a To, Cc or Bcc field, separated by commas or semicolons. A typed
 * `Name <address>` sends to the address alone. Throws, naming the entry, when one isn't
 * exactly one address, so nothing goes to someone the field didn't plainly show.
 */
export function splitRecipients(field: string): string[] {
  const out: string[] = [];
  for (const raw of field.split(/[,;]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const address = recipientAddress(entry);
    if (address === undefined) {
      const shown = entry.replace(/\s+/g, " ");
      throw new Error(`"${shown.length > 60 ? `${shown.slice(0, 57)}…` : shown}" isn't a single email address. Separate addresses with commas.`);
    }
    out.push(address);
  }
  return out;
}
