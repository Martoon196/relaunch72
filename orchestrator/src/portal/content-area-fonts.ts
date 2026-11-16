/**
 * The two typefaces of the content area preview, self-hosted (same origin, no font service).
 *
 * - Urbanist 800, Latin subset (display): @fontsource/urbanist 5.3.0, files/urbanist-latin-800-normal.woff2
 * - Hanken Grotesk variable 100-900, Latin subset (body): @fontsource-variable/hanken-grotesk 5.3.0,
 *   files/hanken-grotesk-latin-wght-normal.woff2
 *
 * Both are under the SIL Open Font License 1.1; the licences are beside the files in ./fonts. About 46 KB in all.
 * They are served only while the preview is allowed, and only pages that render the shell declare them (with
 * `font-src 'self'` added to those pages' policy alone). See content-area-preview.ts and the router.
 */
import { readFileSync } from 'node:fs';

/** Published name (versioned, so it can be cached for good) -> file in ./fonts. */
const FILES: Readonly<Record<string, string>> = Object.freeze({
  'urbanist-800-5.3.0.woff2': 'urbanist-latin-800-normal.woff2',
  'hanken-grotesk-wght-5.3.0.woff2': 'hanken-grotesk-latin-wght-normal.woff2',
});
const cache = new Map<string, Buffer>();

export const CONTENT_AREA_FONT_PATH = '/portal/seo-blog/fonts/';

/** The bytes of one published font, or null for any other name. */
export function contentAreaFont(name: string): Buffer | null {
  const file = Object.prototype.hasOwnProperty.call(FILES, name) ? FILES[name]! : null;
  if (!file) return null;
  let bytes = cache.get(file);
  if (!bytes) { bytes = readFileSync(new URL(`./fonts/${file}`, import.meta.url)); cache.set(file, bytes); }
  return bytes;
}

const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

/** The @font-face rules, for pages that render the shell (their policy allows `font-src 'self'`). */
export const CONTENT_AREA_FONT_FACES = `@font-face{font-family:"Urbanist";font-style:normal;font-weight:800;font-display:swap;src:url(${CONTENT_AREA_FONT_PATH}urbanist-800-5.3.0.woff2) format("woff2");unicode-range:${LATIN}}
@font-face{font-family:"Hanken Grotesk";font-style:normal;font-weight:100 900;font-display:swap;src:url(${CONTENT_AREA_FONT_PATH}hanken-grotesk-wght-5.3.0.woff2) format("woff2");unicode-range:${LATIN}}
`;
