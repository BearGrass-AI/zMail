import type { MailSignature, SignatureDefaults } from "@/lib/signature";

/** What the From menu says about an account's signature: "signature: CIO" or "no signature". */
export function defaultSignatureLabel(
  accountId: string,
  isReply: boolean,
  defaults: Record<string, SignatureDefaults>,
  signatures: Pick<MailSignature, "id" | "name">[],
): string {
  const id = defaults[accountId]?.[isReply ? "reply" : "new"];
  const name = id ? signatures.find((s) => s.id === id)?.name : undefined;
  return name ? `signature: ${name}` : "no signature";
}
