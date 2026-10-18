// The synchronous SHA-256 used for draft signature fingerprints gives the standard digests.
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/sha256";

const webDigest = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");

describe("sha256Hex", () => {
  it("matches the FIPS 180-4 examples", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("matches Web Crypto across block boundaries and for non-ASCII text", async () => {
    for (const n of [55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const text = "Ann Rivera · ✉ ".repeat(n).slice(0, n);
      expect(sha256Hex(text)).toBe(await webDigest(text));
    }
  });
});
