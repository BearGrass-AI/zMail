// House rules for motion, checked over the component source so a new screen can't quietly bring
// back a bounce, a double press or a replaying list.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["/src/**/*.tsx", "!/src/**/__tests__/**"], { query: "?raw", import: "default", eager: true });
const checked = Object.entries(sources).map(([path, text]) => ({ path, text }));

/** Each opening tag that starts with `start`, up to its closing `>` (braces and strings skipped). */
function tags(text: string, start: string): string[] {
  return tagsAt(text, start).map((t) => t.tag);
}

function tagsAt(text: string, start: string): { tag: string; end: number }[] {
  const out: { tag: string; end: number }[] = [];
  for (let i = text.indexOf(start); i >= 0; i = text.indexOf(start, i + 1)) {
    let depth = 0;
    let quote = "";
    let j = i + start.length;
    for (; j < text.length; j++) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && c === '"') quote = c;
      else if (depth === 0 && c === ">") break;
    }
    out.push({ tag: text.slice(i, j + 1), end: j + 1 });
  }
  return out;
}

const motionTags = checked.flatMap((f) => tags(f.text, "<motion.").map((tag) => ({ path: f.path, tag })));

describe("motion conventions", () => {
  it("finds the motion elements it checks", () => {
    expect(motionTags.length).toBeGreaterThan(20);
  });

  it("presses with press.ts only: no active:scale classes stacked on top", () => {
    const hits = checked.filter((f) => /\bactive:scale-/.test(f.text)).map((f) => f.path);
    expect(hits).toEqual([]);
  });

  it("gives every motion element its own transition, so none falls back to the bouncy default", () => {
    const bare = motionTags.filter(({ tag }) => !/\btransition=|\{\.\.\./.test(tag));
    expect(bare).toEqual([]);
  });

  it("never lets a CSS transition fight the transform and opacity motion animates", () => {
    const fighting = motionTags.filter(({ tag }) => /className="[^"]*(?<![\w-])transition(?:-all|-transform|-opacity)?(?![\w[-])/.test(tag));
    expect(fighting).toEqual([]);
  });

  it("keeps the bouncier pill spring for sliding pill indicators", () => {
    const misplaced = motionTags.filter(({ tag }) => tag.includes("SPRING_PILL") && !tag.includes("layoutId"));
    expect(misplaced).toEqual([]);
  });

  it("gives every sliding pill indicator the pill spring", () => {
    const off = motionTags.filter(({ tag }) => /layoutId="[^"]*-(?:pill|active|mode)"/.test(tag) && !tag.includes("SPRING_PILL"));
    expect(off).toEqual([]);
  });

  it("never blanks a region by waiting for the old content to leave first", () => {
    const waiting = checked.filter((f) => tags(f.text, "<AnimatePresence").some((t) => t.includes('mode="wait"'))).map((f) => f.path);
    expect(waiting).toEqual([]);
  });

  it("doesn't replay a list's entrances when the list remounts", () => {
    const replaying = checked.flatMap((f) =>
      tagsAt(f.text, "<AnimatePresence")
        .filter(({ tag }) => !tag.includes("initial={false}"))
        .filter(({ end }) => /^\s*\{[^\n]*\.map\(/.test(f.text.slice(end, end + 200)))
        .map(() => f.path),
    );
    expect(replaying).toEqual([]);
  });
});
