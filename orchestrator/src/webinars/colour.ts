/**
 * Contrast-safe colours derived from a brand accent. The accent itself stays the
 * brand's (button fills, borders); text on it and accent-coloured text are
 * adjusted until they meet WCAG AA (4.5:1), so a bright brand colour such as
 * #00e5cc never produces unreadable white-on-teal buttons or teal-on-white text.
 */

type Rgb = readonly [number, number, number];

function parse(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as Rgb;
}

function hex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

function luminance([r, g, b]: Rgb): number {
  const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrast(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return 1;
  const [l1, l2] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

function mix(c: Rgb, target: number, t: number): Rgb {
  return c.map((v) => v + (target - v) * t) as unknown as Rgb;
}

/** Moves a colour toward black (or white) until it reaches `ratio` against `background`. */
function readableOn(colour: Rgb, background: string, ratio: number, toward: 0 | 255): string {
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const candidate = hex(mix(colour, toward, t));
    if (contrast(candidate, background) >= ratio) return candidate;
  }
  return toward === 0 ? '#000000' : '#ffffff';
}

export interface AccentPalette {
  /** The brand accent, normalised; used for fills and borders. */
  readonly accent: string;
  /** Text and icons placed on the accent fill. */
  readonly onAccent: string;
  /** Accent-coloured text on a light (#ffffff) surface. */
  readonly textOnLight: string;
  /** Accent-coloured text on a dark (#161922) surface. */
  readonly textOnDark: string;
}

export function accentPalette(raw: string | null | undefined, fallback = '#2563eb'): AccentPalette {
  const rgb = parse(raw ?? '') ?? parse(fallback)!;
  const accent = hex(rgb);
  const onAccent = contrast('#ffffff', accent) >= contrast('#111827', accent) ? '#ffffff' : '#111827';
  return Object.freeze({
    accent, onAccent,
    textOnLight: readableOn(rgb, '#ffffff', 4.5, 0),
    textOnDark: readableOn(rgb, '#161922', 4.5, 255),
  });
}
