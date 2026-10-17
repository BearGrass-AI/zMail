import { describe, expect, it } from "vitest";
import { markParts, resultLine } from "@/lib/mail/search-text";
import { searchWords } from "@/lib/store/selectors";

describe("searchWords", () => {
  it("lowercases, splits on whitespace and drops repeats", () => {
    expect(searchWords("  Parking  LOT parking ")).toEqual(["parking", "lot"]);
    expect(searchWords("")).toEqual([]);
  });
});

describe("resultLine", () => {
  const e = (snippet: string, text: string) => ({ snippet, text });

  it("uses the snippet when a word is in it", () => {
    expect(resultLine(e("Renew your parking permit", "whatever"), ["parking"])).toBe("Renew your parking permit");
  });

  it("otherwise shows the body around the first match, starting on a word", () => {
    const text = `${"Lorem ipsum dolor sit amet consectetur adipiscing ".repeat(4)}the north lot parking garage\nopens at 7`;
    const line = resultLine(e("Hello there", text), ["parking"]);
    expect(line.startsWith("…")).toBe(true);
    expect(line).toContain("the north lot parking garage opens at 7");
    expect(line).not.toMatch(/^…\S*[a-z]psum/);
  });

  it("falls back to the snippet when the words are only in the subject or sender", () => {
    expect(resultLine(e("Hi", "nothing here"), ["parking"])).toBe("Hi");
    expect(resultLine(e("Hi  there\n", "x"), [])).toBe("Hi there");
  });
});

describe("markParts", () => {
  it("marks every word, case-insensitively, longest first", () => {
    expect(markParts("Parking at the park", ["park", "parking"])).toEqual([
      { text: "Parking", hit: true },
      { text: " at the ", hit: false },
      { text: "park", hit: true },
    ]);
  });

  it("treats words as text, not patterns", () => {
    expect(markParts("a.b (c) a*b", ["(c)", "a*b"])).toEqual([
      { text: "a.b ", hit: false },
      { text: "(c)", hit: true },
      { text: " ", hit: false },
      { text: "a*b", hit: true },
    ]);
  });

  it("leaves text without words alone", () => {
    expect(markParts("plain", [])).toEqual([{ text: "plain", hit: false }]);
    expect(markParts("", ["x"])).toEqual([]);
  });
});
