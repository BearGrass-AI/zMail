import { describe, expect, it } from "vitest";
import { MockGenerativeProvider } from "@/lib/ai/mock-generative";
import { labelKinds } from "@/lib/ai/assistant/kinds";
import type { Email } from "@/lib/types";

const mail = (id: string, name: string, subject: string) => ({ id, from: { name, address: "x@y.com" }, subject }) as Email;

describe("offline kind labelling", () => {
  it("labels order, receipt and promo mail by subject", async () => {
    const got = await labelKinds(new MockGenerativeProvider(), [
      mail("a", "Amazon", "Your package has shipped"),
      mail("b", "Stripe", "Receipt for your payment"),
      mail("c", "Shop", "Big sale: 30% off"),
      mail("d", "Mom", "Dinner Sunday?"),
    ]);
    expect(got).toEqual({ a: "order_delivery", b: "receipt_bill", c: "promotion", d: "other" });
  });
});
