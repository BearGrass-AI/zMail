import { describe, expect, it } from "vitest";
import { liveMentions, splitMentions, withMentions } from "@/lib/ai/assistant/mentions";

const tyler = { name: "Tyler Smith", address: "tyler@x.edu" };
const ann = { name: "Ann Lee", address: "ann@x.edu" };

describe("withMentions", () => {
  it("is unchanged when nobody is mentioned", () => {
    expect(withMentions("hi", [])).toBe("hi");
    expect(withMentions("hi", undefined)).toBe("hi");
  });
  it("appends the address note for a present mention", () => {
    expect(withMentions("email @Tyler Smith", [tyler]).endsWith("[People I @mentioned: Tyler Smith <tyler@x.edu>. Use these addresses; no need to look them up.]")).toBe(true);
  });
  it("leaves out a person whose @Name was deleted", () => {
    expect(withMentions("email Tyler", [tyler])).toBe("email Tyler");
  });
  it("orders by position and collapses duplicate addresses", () => {
    const out = liveMentions("@Ann Lee and @Tyler Smith", [tyler, ann, { name: "Ann Lee", address: "ANN@x.edu" }]);
    expect(out.map((m) => m.address)).toEqual(["ann@x.edu", "tyler@x.edu"]);
  });
});

describe("splitMentions", () => {
  it("splits text before, between and after two mentions", () => {
    expect(splitMentions("hi @Tyler Smith and @Ann Lee, thanks", [ann, tyler])).toEqual([
      { text: "hi ", mention: false },
      { text: "@Tyler Smith", mention: true },
      { text: " and ", mention: false },
      { text: "@Ann Lee", mention: true },
      { text: ", thanks", mention: false },
    ]);
  });
  it("returns one plain part with no mentions", () => {
    expect(splitMentions("plain", [])).toEqual([{ text: "plain", mention: false }]);
  });
});

describe("whole-name matching", () => {
  const tom = { name: "Tom", address: "tom@x.edu" };
  const tomSmith = { name: "Tom Smith", address: "tsmith@x.edu" };
  it("does not count Tom when only @Tom Smith remains", () => {
    expect(liveMentions("email @Tom Smith", [tom, tomSmith])).toEqual([tomSmith]);
  });
  it("keeps both, in order, for '@Tom, @Tom Smith'", () => {
    expect(liveMentions("@Tom, @Tom Smith", [tomSmith, tom])).toEqual([tom, tomSmith]);
  });
  it("does not match @Tomas against Tom", () => {
    expect(liveMentions("hi @Tomas", [tom])).toEqual([]);
  });
  it("bolds only real spans", () => {
    expect(splitMentions("@Tomas and @Tom!", [tom])).toEqual([
      { text: "@Tomas and ", mention: false },
      { text: "@Tom", mention: true },
      { text: "!", mention: false },
    ]);
  });
});
