// The Move to… search puts the folder you named first, not one of its many children.
import { describe, expect, it } from "vitest";
import { rankFolderMatches } from "@/lib/folder-search";

const f = (path: string) => ({ id: path, path });
const FOLDERS = [
  "Campus Departments › Campus Affiliates › ANC",
  "Campus Departments › Associated Students",
  "Campus Departments › Athletics",
  "Campus Departments › Business Services › Campus Store",
  "Campus Departments",
  "Campus Departments › Campus Foundation",
  "Projects › Department reviews",
  "Vendors › Dell",
].map(f);
const paths = (q: string) => rankFolderMatches(FOLDERS, q).map((x) => x.path);

describe("rankFolderMatches", () => {
  it("puts the folder whose own name matches before its children", () => {
    const r = paths("Campus Depa");
    expect(r[0]).toBe("Campus Departments");
    // Children follow, shallower first, then A–Z.
    expect(r.slice(1)).toEqual([
      "Campus Departments › Associated Students",
      "Campus Departments › Athletics",
      "Campus Departments › Campus Foundation",
      "Campus Departments › Business Services › Campus Store",
      "Campus Departments › Campus Affiliates › ANC",
    ]);
  });

  it("ranks an exact name, then a name that starts with it, then a word inside a name", () => {
    // "Department reviews" starts with it; in "Campus Departments" it's the second word.
    expect(paths("department")).toEqual([
      "Projects › Department reviews",
      "Campus Departments",
      "Campus Departments › Associated Students",
      "Campus Departments › Athletics",
      "Campus Departments › Campus Foundation",
      "Campus Departments › Business Services › Campus Store",
      "Campus Departments › Campus Affiliates › ANC",
    ]);
    expect(paths("foundation")[0]).toBe("Campus Departments › Campus Foundation");
    expect(paths("athletics")).toEqual(["Campus Departments › Athletics"]);
  });

  it("matches across the path and ignores case and spaces around the query", () => {
    expect(paths("  departments › ath ")).toEqual(["Campus Departments › Athletics"]);
    expect(paths("DELL")).toEqual(["Vendors › Dell"]);
    expect(paths("nothing like this")).toEqual([]);
  });
});
