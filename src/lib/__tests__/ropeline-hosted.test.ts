// The hosted verdict is gated, and the body of the message is not in the request.
import { describe, expect, it, vi } from "vitest";
import { ROPELINE_TERMS_READY, askHosted, attachVerdicts, hostedBody, hostedCallAllowed } from "@/lib/ropeline-hosted";
import { flagFor } from "@/lib/ropeline";
import type { Email } from "@/lib/types";

const mail = (): Email =>
  ({
    id: "e1",
    accountId: "g",
    threadId: "e1",
    folderId: "g:INBOX",
    from: { name: "Pat Example", address: "pat@example.com" },
    to: [],
    subject: "UniqueSubjectPhrase",
    snippet: "",
    text: "UniqueBodyPhrase about a shortener https://bit.ly/q for the reader.",
    date: "2026-10-01T00:00:00Z",
    unread: true,
    starred: false,
    labels: [],
  }) as Email;

describe("hosted verdict", () => {
  it("stays off until the Terms and Privacy pages exist", () => {
    expect(ROPELINE_TERMS_READY).toBe(false);
    expect(hostedCallAllowed({ ropeLineHosted: true, ropeLineHostedUrl: "https://verdict.example" })).toBe(false);
    expect(hostedCallAllowed({ ropeLineHosted: true, ropeLineHostedUrl: "https://verdict.example" }, true)).toBe(true);
    expect(hostedCallAllowed({ ropeLineHosted: false, ropeLineHostedUrl: "https://verdict.example" }, true)).toBe(false);
  });

  it("posts a fingerprint and signals, and not the message", async () => {
    const email = mail();
    const flag = flagFor(email, []);
    const body = hostedBody(flag);
    expect(Object.keys(body).sort()).toEqual(["fingerprint", "signals"]);
    const posted = JSON.stringify(body);
    expect(posted).not.toContain("UniqueSubjectPhrase");
    expect(posted).not.toContain("UniqueBodyPhrase");
    expect(posted).not.toContain("pat@example.com");
    const post = vi.fn<(url: string, body: { fingerprint: string | null; signals: unknown[] }) => Promise<{ verdict: "spam" }>>(async () => ({ verdict: "spam" }));
    expect(await askHosted({ enabled: true, termsReady: false, baseUrl: "https://verdict.example", flag, post })).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(await askHosted({ enabled: true, termsReady: true, baseUrl: "https://verdict.example", flag, post })).toBe("spam");
    expect(post).toHaveBeenCalledOnce();
    const [url, sent] = post.mock.calls[0];
    expect(url).toBe("https://verdict.example/v1/verdict");
    expect(sent).toEqual(body);
  });

  it("fails open when the verdict service does not answer", async () => {
    const flag = flagFor(mail(), []);
    const verdict = await askHosted({
      enabled: true,
      termsReady: true,
      baseUrl: "https://verdict.example",
      flag,
      post: () => new Promise(() => {}),
      timeoutMs: 30,
    });
    expect(verdict).toBeNull();
  });

  it("does not call out from sort's helper while the pages are missing", async () => {
    const email = mail();
    const post = vi.fn(async () => ({ verdict: "good" }));
    const flags = { e1: flagFor(email, []) };
    expect(await attachVerdicts(flags, [email], { ropeLineHosted: true, ropeLineHostedUrl: "https://verdict.example" }, post)).toBeNull();
    expect(post).not.toHaveBeenCalled();
    const next = await attachVerdicts(flags, [email], { ropeLineHosted: true, ropeLineHostedUrl: "https://verdict.example" }, post, true);
    expect(next?.e1.verdict).toBe("good");
  });
});
