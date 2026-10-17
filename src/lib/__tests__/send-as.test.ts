import { describe, expect, it } from "vitest";
import { defaultSignatureLabel } from "@/lib/send-as";

const sigs = [{ id: "s1", name: "CIO" }, { id: "s2", name: "Short" }];
const defaults = { a: { new: "s1", reply: "s2" }, b: { new: null, reply: null }, c: { new: "gone", reply: null } };

describe("defaultSignatureLabel", () => {
  it("names the new-mail default", () => expect(defaultSignatureLabel("a", false, defaults, sigs)).toBe("signature: CIO"));
  it("names the reply default for replies", () => expect(defaultSignatureLabel("a", true, defaults, sigs)).toBe("signature: Short"));
  it("says none when unset, unknown account, or missing signature", () => {
    expect(defaultSignatureLabel("b", false, defaults, sigs)).toBe("no signature");
    expect(defaultSignatureLabel("zz", false, defaults, sigs)).toBe("no signature");
    expect(defaultSignatureLabel("c", false, defaults, sigs)).toBe("no signature");
  });
});
