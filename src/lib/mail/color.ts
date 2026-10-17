// Color parsing and the dark-mode color mapping for email bodies. Parsing is
// defensive: email CSS is hostile, so anything odd returns null and is left alone.
// The mapping works in OKLCH, so hue survives and lightness steps look even.

export type Rgba = { r: number; g: number; b: number; a: number };
type Lch = { l: number; c: number; h: number };

/** The dark card and its text; the frame CSS in email-frame.ts is built from these. */
export const DARK_CARD = "#16181c";
export const DARK_TEXT = "#e6e7ea";
export const DARK_LINK = "#7fb2ff";
/** The light card's defaults: what an email's uncolored text and links look like as authored. */
export const LIGHT_TEXT = "#1d1d1f";
export const LIGHT_LINK = "#0a66ff";
export const MIN_CONTRAST = 4.5;

// CSS named colors (CSS Color 4), plus the system colors Outlook writes.
const NAMED: Record<string, string> = {
  aliceblue: "f0f8ff", antiquewhite: "faebd7", aqua: "00ffff", aquamarine: "7fffd4", azure: "f0ffff",
  beige: "f5f5dc", bisque: "ffe4c4", black: "000000", blanchedalmond: "ffebcd", blue: "0000ff",
  blueviolet: "8a2be2", brown: "a52a2a", burlywood: "deb887", cadetblue: "5f9ea0", chartreuse: "7fff00",
  chocolate: "d2691e", coral: "ff7f50", cornflowerblue: "6495ed", cornsilk: "fff8dc", crimson: "dc143c",
  cyan: "00ffff", darkblue: "00008b", darkcyan: "008b8b", darkgoldenrod: "b8860b", darkgray: "a9a9a9",
  darkgreen: "006400", darkgrey: "a9a9a9", darkkhaki: "bdb76b", darkmagenta: "8b008b", darkolivegreen: "556b2f",
  darkorange: "ff8c00", darkorchid: "9932cc", darkred: "8b0000", darksalmon: "e9967a", darkseagreen: "8fbc8f",
  darkslateblue: "483d8b", darkslategray: "2f4f4f", darkslategrey: "2f4f4f", darkturquoise: "00ced1",
  darkviolet: "9400d3", deeppink: "ff1493", deepskyblue: "00bfff", dimgray: "696969", dimgrey: "696969",
  dodgerblue: "1e90ff", firebrick: "b22222", floralwhite: "fffaf0", forestgreen: "228b22", fuchsia: "ff00ff",
  gainsboro: "dcdcdc", ghostwhite: "f8f8ff", gold: "ffd700", goldenrod: "daa520", gray: "808080",
  green: "008000", greenyellow: "adff2f", grey: "808080", honeydew: "f0fff0", hotpink: "ff69b4",
  indianred: "cd5c5c", indigo: "4b0082", ivory: "fffff0", khaki: "f0e68c", lavender: "e6e6fa",
  lavenderblush: "fff0f5", lawngreen: "7cfc00", lemonchiffon: "fffacd", lightblue: "add8e6", lightcoral: "f08080",
  lightcyan: "e0ffff", lightgoldenrodyellow: "fafad2", lightgray: "d3d3d3", lightgreen: "90ee90", lightgrey: "d3d3d3",
  lightpink: "ffb6c1", lightsalmon: "ffa07a", lightseagreen: "20b2aa", lightskyblue: "87cefa",
  lightslategray: "778899", lightslategrey: "778899", lightsteelblue: "b0c4de", lightyellow: "ffffe0",
  lime: "00ff00", limegreen: "32cd32", linen: "faf0e6", magenta: "ff00ff", maroon: "800000",
  mediumaquamarine: "66cdaa", mediumblue: "0000cd", mediumorchid: "ba55d3", mediumpurple: "9370db",
  mediumseagreen: "3cb371", mediumslateblue: "7b68ee", mediumspringgreen: "00fa9a", mediumturquoise: "48d1cc",
  mediumvioletred: "c71585", midnightblue: "191970", mintcream: "f5fffa", mistyrose: "ffe4e1", moccasin: "ffe4b5",
  navajowhite: "ffdead", navy: "000080", oldlace: "fdf5e6", olive: "808000", olivedrab: "6b8e23",
  orange: "ffa500", orangered: "ff4500", orchid: "da70d6", palegoldenrod: "eee8aa", palegreen: "98fb98",
  paleturquoise: "afeeee", palevioletred: "db7093", papayawhip: "ffefd5", peachpuff: "ffdab9", peru: "cd853f",
  pink: "ffc0cb", plum: "dda0dd", powderblue: "b0e0e6", purple: "800080", rebeccapurple: "663399",
  red: "ff0000", rosybrown: "bc8f8f", royalblue: "4169e1", saddlebrown: "8b4513", salmon: "fa8072",
  sandybrown: "f4a460", seagreen: "2e8b57", seashell: "fff5ee", sienna: "a0522d", silver: "c0c0c0",
  skyblue: "87ceeb", slateblue: "6a5acd", slategray: "708090", slategrey: "708090", snow: "fffafa",
  springgreen: "00ff7f", steelblue: "4682b4", tan: "d2b48c", teal: "008080", thistle: "d8bfd8",
  tomato: "ff6347", turquoise: "40e0d0", violet: "ee82ee", wheat: "f5deb3", white: "ffffff",
  whitesmoke: "f5f5f5", yellow: "ffff00", yellowgreen: "9acd32",
  windowtext: "000000", window: "ffffff", canvas: "ffffff", canvastext: "000000", buttontext: "000000",
  buttonface: "f0f0f0", graytext: "6d6d6d", linktext: "0000ee",
};

/** Words that look like colors to a tokenizer but must be left exactly as written. */
const KEEP = new Set(["transparent", "currentcolor", "inherit", "initial", "unset", "revert", "revert-layer", "none", "auto"]);

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

function hexToRgba(hex: string): Rgba | null {
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  let h = hex;
  if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

/** A number or percentage; `scale` is what 100% means. NaN when it isn't one. */
function num(s: string, scale: number) {
  const t = s.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?%?$/i.test(t)) return NaN;
  return t.endsWith("%") ? (parseFloat(t) / 100) * scale : parseFloat(t);
}

function hue(s: string) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/i.exec(s.trim());
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  const unit = (m[2] ?? "deg").toLowerCase();
  const deg = unit === "turn" ? v * 360 : unit === "rad" ? (v * 180) / Math.PI : unit === "grad" ? v * 0.9 : v;
  return ((deg % 360) + 360) % 360;
}

/** Split rgb()/hsl() arguments in either the comma or the space-and-slash syntax. */
function args(inner: string): { parts: string[]; alpha?: string } | null {
  const [main, alpha, extra] = inner.split("/");
  if (extra !== undefined) return null;
  const parts = main.includes(",") ? main.split(",").map((p) => p.trim()) : main.trim().split(/\s+/);
  if (alpha === undefined && parts.length === 4) return { parts: parts.slice(0, 3), alpha: parts[3] };
  if (alpha !== undefined && main.includes(",")) return null;
  return { parts, alpha };
}

function hslToRgb(h: number, s: number, l: number) {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}

/**
 * Parse one CSS color (hex 3/4/6/8, rgb()/rgba(), hsl()/hsla(), a named or system
 * color). `legacy` also takes bare hex as HTML attributes write it ("ffffff").
 * Returns null for anything else, including keywords like transparent.
 */
export function parseColor(input: string, legacy = false): Rgba | null {
  if (typeof input !== "string" || input.length > 120) return null;
  const s = input.trim().toLowerCase();
  if (!s || KEEP.has(s)) return null;
  if (s[0] === "#") return hexToRgba(s.slice(1));
  if (NAMED[s]) return hexToRgba(NAMED[s]);
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(s);
  if (fn) {
    const a = args(fn[2]);
    if (!a || a.parts.length !== 3) return null;
    const alpha = a.alpha === undefined ? 1 : num(a.alpha, 1);
    if (Number.isNaN(alpha)) return null;
    let rgb: { r: number; g: number; b: number };
    if (fn[1].startsWith("rgb")) {
      const [r, g, b] = a.parts.map((p) => num(p, 255));
      rgb = { r, g, b };
    } else {
      const h = hue(a.parts[0]);
      const sat = num(a.parts[1].endsWith("%") ? a.parts[1] : `${a.parts[1]}%`, 1);
      const lig = num(a.parts[2].endsWith("%") ? a.parts[2] : `${a.parts[2]}%`, 1);
      if ([h, sat, lig].some(Number.isNaN)) return null;
      rgb = hslToRgb(h, clamp(sat, 0, 1), clamp(lig, 0, 1));
    }
    if ([rgb.r, rgb.g, rgb.b].some((v) => !Number.isFinite(v))) return null;
    return { r: clamp(rgb.r, 0, 255), g: clamp(rgb.g, 0, 255), b: clamp(rgb.b, 0, 255), a: clamp(alpha, 0, 1) };
  }
  if (legacy && /^[0-9a-f]{6}$|^[0-9a-f]{3}$/.test(s)) return hexToRgba(s);
  return null;
}

export function formatColor(c: Rgba) {
  const r = Math.round(clamp(c.r, 0, 255));
  const g = Math.round(clamp(c.g, 0, 255));
  const b = Math.round(clamp(c.b, 0, 255));
  if (c.a < 1) return `rgba(${r}, ${g}, ${b}, ${Math.round(c.a * 1000) / 1000})`;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// sRGB <-> OKLab (Björn Ottosson's matrices).
const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function toOklch({ r, g, b }: Rgba): Lch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) };
}

/** OKLCH to linear sRGB, unclamped (components outside 0..1 mean out of gamut). */
function lchToLinear({ l: L, c, h }: Lch) {
  const A = c * Math.cos(h);
  const B = c * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (lin: number[]) => lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH to sRGB, lowering chroma (same lightness and hue) until it fits. */
function fromOklch(lch: Lch, a = 1): Rgba {
  const L = clamp(lch.l, 0, 1);
  let lin = lchToLinear({ l: L, c: lch.c, h: lch.h });
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = lch.c;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(lchToLinear({ l: L, c: mid, h: lch.h }))) lo = mid;
      else hi = mid;
    }
    lin = lchToLinear({ l: L, c: lo, h: lch.h });
  }
  const [r, g, b] = lin.map((v) => fromLinear(clamp(v, 0, 1)));
  return { r, g, b, a };
}

export const oklch = (c: Rgba) => toOklch(c);

/** WCAG relative luminance. */
export function luminance({ r, g, b }: Rgba) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrast(x: Rgba, y: Rgba) {
  const a = luminance(x);
  const b = luminance(y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** `top` drawn over the opaque `under`. */
export function over(top: Rgba, under: Rgba): Rgba {
  if (top.a >= 1) return top;
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

const CARD = hexToRgba(DARK_CARD.slice(1)) as Rgba;
const CARD_LCH = toOklch(CARD);
const TEXT = hexToRgba(DARK_TEXT.slice(1)) as Rgba;
const TEXT_LCH = toOklch(TEXT);
export const CARD_RGBA = CARD;
export const TEXT_RGBA = TEXT;

// Emails repeat the same few colors many times; remember recent answers (bounded).
const memoMap = new Map<string, Rgba>();
const key = (c: Rgba) => `${c.r},${c.g},${c.b},${c.a}`;
function memo(k: string, f: () => Rgba): Rgba {
  const hit = memoMap.get(k);
  if (hit) return hit;
  const v = f();
  if (memoMap.size >= 4096) memoMap.clear();
  memoMap.set(k, v);
  return v;
}

/** Backgrounds at or below this OKLCH lightness are already dark and stay as they are. */
const DARK_BG = 0.5;
const ACHROMATIC = 0.012;

/**
 * A background for the dark card. Already-dark colors stay; lighter ones mirror
 * into the dark range (white lands on the card itself, light tints become dark
 * tints of the same hue, mid tones like a button settle near the top of the range).
 */
export function adaptBackground(c: Rgba): Rgba {
  return memo(`b${key(c)}`, () => mapBackground(c));
}

function mapBackground(c: Rgba): Rgba {
  const lch = toOklch(c);
  if (lch.l <= DARK_BG) return c;
  if (lch.c < ACHROMATIC && lch.l >= 0.98) return { ...CARD, a: c.a };
  const l = CARD_LCH.l + ((1 - lch.l) / (1 - DARK_BG)) * (DARK_BG - CARD_LCH.l);
  // Near-greys take the card's own slight tint so they sit with it.
  if (lch.c < ACHROMATIC) return fromOklch({ l, c: CARD_LCH.c, h: CARD_LCH.h }, c.a);
  // Strong colors (a yellow highlight, a brand band) stay a little lighter, so they still show.
  return fromOklch({ l: Math.min(DARK_BG, l + lch.c * 0.8), c: lch.c, h: lch.h }, c.a);
}

/** Lightest-first search for the lightness (same hue) that reaches the contrast target on `bg`. */
function liftTo(lch: Lch, bg: Rgba, target: number, from: number): Rgba | null {
  const at = (l: number) => fromOklch({ l, c: lch.c, h: lch.h });
  if (contrast(at(from), bg) >= target) return at(from);
  if (contrast(at(1), bg) < target) return null;
  let lo = from;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(at(mid), bg) >= target) hi = mid;
    else lo = mid;
  }
  return at(hi);
}

/**
 * A text (or border) color for the opaque background it ends up on. Colors that
 * already read on it stay. Darker ones flip lighter with their hue kept (a maroon
 * signature becomes a light maroon-pink, not grey; black becomes the card's text),
 * then rise further if they still miss the contrast target.
 */
export function adaptForeground(c: Rgba, bg: Rgba, target = MIN_CONTRAST): Rgba {
  return memo(`f${key(c)}|${key(bg)}|${target}`, () => mapForeground(c, bg, target));
}

function mapForeground(c: Rgba, bg: Rgba, target: number): Rgba {
  const shown = over(c, bg);
  if (contrast(shown, bg) >= target) return c;
  const lch = toOklch(shown);
  if (lch.c < ACHROMATIC && lch.l < 0.3 && contrast(TEXT, bg) >= target) return TEXT;
  // Colored text flips a little less far than grey, so it keeps more of its color.
  const flipped = (lch.c < 0.04 ? TEXT_LCH.l : 0.84) - 0.35 * lch.l;
  // A hair over the target, so rounding to 8-bit channels can't drop it below.
  const lifted = liftTo(lch, bg, target + 0.04, Math.max(flipped, lch.l));
  if (lifted) return lifted;
  // The background is too light to lift against; fall back to whichever extreme reads.
  const black: Rgba = { r: 0, g: 0, b: 0, a: 1 };
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  return contrast(black, bg) >= contrast(white, bg) ? black : white;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
export const WHITE_RGBA = WHITE;
/** Borders at least this colorful are signals (an alert bar), not separators. */
const STRONG_BORDER = 0.08;

/**
 * A border or separator color for the dark card. Lines are decorative, not text:
 * on an area that was already dark as authored they stay; a strongly colored line
 * keeps its hue and stays clearly visible (3:1); any other line mirrors into a quiet
 * line of the same hue just lighter than what's behind it, about as subtle as it was
 * on the light design (1.3 to 2:1). `authoredBg` is the opaque background it sat on.
 */
export function adaptBorder(c: Rgba, bg: Rgba, authoredBg: Rgba = WHITE): Rgba {
  return memo(`l${key(c)}|${key(bg)}|${key(authoredBg)}`, () => mapBorder(c, bg, authoredBg));
}

function mapBorder(c: Rgba, bg: Rgba, authoredBg: Rgba): Rgba {
  if (toOklch(authoredBg).l <= DARK_BG) return c;
  const lch = toOklch(c);
  if (lch.c >= STRONG_BORDER) {
    if (contrast(over(c, bg), bg) >= 3) return c;
    return liftTo(lch, bg, 3.04, lch.l) ?? c;
  }
  const target = clamp(contrast(over(c, authoredBg), authoredBg), 1.3, 2);
  const tint = lch.c < ACHROMATIC ? { c: CARD_LCH.c, h: CARD_LCH.h } : { c: lch.c, h: lch.h };
  const at = (l: number) => fromOklch({ l, ...tint });
  if (contrast(at(1), bg) < target) return at(1);
  let lo = toOklch(bg).l;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(at(mid), bg) >= target) hi = mid;
    else lo = mid;
  }
  return at(hi);
}
