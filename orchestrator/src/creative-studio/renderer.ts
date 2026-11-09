/**
 * Deterministic artwork compositor. Exact copy, the owner's real logo bytes and
 * required disclosures are laid out with HTML/CSS and rasterised by an offline
 * headless Chromium. No model ever draws text or logos. The page can reach no
 * network: every request is either fulfilled from in-memory verified bytes on
 * a private pseudo-origin or aborted. Contrast is measured on the actual pixels
 * under each text box; the scrim is strengthened until WCAG thresholds pass or
 * an issue is reported. Overflowing copy is reported, never silently clipped.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import type { VerifiedImage } from './image-input.js';
import type { Placement } from './placements.js';
import type { ArtworkIssue, Palette } from './types.js';

export const RENDERER_VERSION = 'r72-creative-chromium-v1';
const ORIGIN = 'https://render.invalid';
const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
const FONTS = Object.freeze({ 'display.otf': 'inter-display-bold.otf', 'text.otf': 'inter-regular.otf', 'strong.otf': 'inter-semibold.otf' });
const SCRIM_STEPS = Object.freeze([0.42, 0.55, 0.68, 0.8, 0.9]);
const RENDER_TIMEOUT_MS = 20_000;

export interface ArtworkInput {
  readonly placement: Placement;
  readonly palette: Palette;
  readonly brandName: string;
  readonly logo: VerifiedImage | null;
  readonly background: VerifiedImage | null;
  readonly focal: Readonly<{ x: number; y: number }>;
  readonly hook: string | null;
  readonly headline: string;
  readonly body: string | null;
  readonly cta: string | null;
  readonly disclosure: string | null;
  readonly illustrativeTag: boolean;
  readonly card: Readonly<{ current: number; total: number }> | null;
}

export interface RenderedArtwork {
  readonly mime: 'image/jpeg';
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly contrast: Readonly<Record<string, number>>;
  readonly scrimAlpha: number;
  readonly headlineSize: number;
  readonly issues: readonly ArtworkIssue[];
  readonly bytes: Buffer;
}

export interface ArtworkRenderer {
  readonly version: string;
  available(): boolean;
  /** Renders sequentially in one browser; resolves only with real raster bytes. */
  renderBatch(inputs: readonly ArtworkInput[]): Promise<RenderedArtwork[]>;
}

export class RendererUnavailableError extends Error {
  constructor() { super('The artwork renderer (headless Chromium) is not installed on this server. No artwork was produced.'); this.name = 'RendererUnavailableError'; }
}

// ─── Colour helpers ─────────────────────────────────────────────────────────

export function parseHex(value: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/iu.exec(value.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function channel(v: number): number { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }
export function luminance([r, g, b]: readonly [number, number, number]): number { return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); }
export function contrastRatio(a: number, b: number): number { const [hi, lo] = a > b ? [a, b] : [b, a]; return (hi + 0.05) / (lo + 0.05); }
function rgb(hex: string): string { const c = parseHex(hex) ?? [0, 0, 0]; return `${c[0]},${c[1]},${c[2]}`; }
/** Readable ink for a solid fill: whichever of the brand light/dark colours contrasts more. */
export function inkFor(fill: string, palette: Palette): string {
  const f = luminance(parseHex(fill) ?? [0, 0, 0]);
  const light = luminance(parseHex(palette.light) ?? [255, 255, 255]), dark = luminance(parseHex(palette.dark) ?? [0, 0, 0]);
  return contrastRatio(f, light) >= contrastRatio(f, dark) ? palette.light : palette.dark;
}

const escape = (value: string) => value.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

// ─── Markup ─────────────────────────────────────────────────────────────────

function cover(img: VerifiedImage, w: number, h: number, focal: { x: number; y: number }) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  const left = Math.min(0, Math.max(w - dw, w / 2 - focal.x * dw));
  const top = Math.min(0, Math.max(h - dh, h / 2 - focal.y * dh));
  return { dw, dh, left, top };
}

export function artworkHtml(input: ArtworkInput): string {
  const { placement: pl, palette } = input;
  const W = pl.width, H = pl.height, side = pl.layout === 'side';
  const disclosureSize = Math.max(18, Math.round(W * 0.019));
  const ctaSize = Math.round(pl.body.size * 0.95);
  const ctaInk = inkFor(palette.accent, palette);
  const bg = input.background
    ? (() => { const c = cover(input.background, W, H, input.focal); return `<img id="bg" alt="" src="${ORIGIN}/i/bg" style="width:${c.dw}px;height:${c.dh}px;left:${c.left}px;top:${c.top}px">`; })()
    : `<div id="bg" class="neutral"></div>`;
  const logo = input.logo
    ? `<img class="logo" alt="" src="${ORIGIN}/i/logo">`
    : `<span class="wordmark measure" data-role="wordmark">${escape(input.brandName)}</span>`;
  const copy = [
    input.hook ? `<p class="hook measure" data-role="hook">${escape(input.hook)}</p>` : '',
    `<h1 class="measure" data-role="headline">${escape(input.headline)}</h1>`,
    input.body ? `<p class="body measure" data-role="body">${escape(input.body)}</p>` : '',
    input.cta ? `<p class="cta-row"><span class="cta" data-role="cta">${escape(input.cta)}</span></p>` : '',
    input.disclosure ? `<p class="disc measure" data-role="disclosure">${escape(input.disclosure)}</p>` : '',
  ].join('');
  const tag = input.illustrativeTag && input.background ? '<span class="tag">Illustrative image</span>' : '';
  const card = input.card ? `<span class="card">${input.card.current}/${input.card.total}</span>` : '';
  const s = pl.safe;
  return `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><style>
@font-face{font-family:R72Display;src:url(${ORIGIN}/f/display.otf) format('opentype');font-weight:700}
@font-face{font-family:R72Text;src:url(${ORIGIN}/f/text.otf) format('opentype');font-weight:400}
@font-face{font-family:R72Text;src:url(${ORIGIN}/f/strong.otf) format('opentype');font-weight:600}
*{box-sizing:border-box}html,body{margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden;background:${palette.dark}}
#art{position:relative;width:${W}px;height:${H}px;overflow:hidden;--scrim:0.42;font-family:R72Text;color:${palette.light};-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;font-kerning:normal}
#bg{position:absolute;display:block;max-width:none}
#bg.neutral{inset:0;width:100%;height:100%;background:linear-gradient(140deg,${palette.primary} 0%,${palette.dark} 78%)}
#scrim{position:absolute;inset:0;background:${side
    ? `linear-gradient(to right,rgba(${rgb(palette.dark)},var(--scrim)) 0%,rgba(${rgb(palette.dark)},var(--scrim)) 46%,rgba(${rgb(palette.dark)},0) 78%)`
    : `linear-gradient(to top,rgba(${rgb(palette.dark)},var(--scrim)) 0%,rgba(${rgb(palette.dark)},var(--scrim)) 42%,rgba(${rgb(palette.dark)},0) 80%)`}}
#topscrim{position:absolute;left:0;right:0;top:0;height:${Math.round(H * (side ? 0.3 : 0.22))}px;background:linear-gradient(to bottom,rgba(${rgb(palette.dark)},calc(var(--scrim) * 0.7)),rgba(${rgb(palette.dark)},0))}
#safe{position:absolute;left:${s.left * W}px;right:${s.right * W}px;top:${s.top * H}px;bottom:${s.bottom * H}px;display:flex;flex-direction:column;justify-content:space-between}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;min-height:0}
.logo{display:block;max-height:${Math.round((side ? 0.13 : 0.075) * H)}px;max-width:${Math.round(0.42 * W)}px;object-fit:contain}
.wordmark{font-weight:600;font-size:${Math.round(pl.body.size * 1.05)}px;letter-spacing:.01em;line-height:1.1}
.copy{display:flex;flex-direction:column;align-items:flex-start;gap:${Math.round(pl.body.size * 0.55)}px;${side ? 'max-width:58%;' : ''}min-width:0}
.copy p,.copy h1{margin:0;max-width:100%;overflow-wrap:normal;word-break:normal}
.hook{font-weight:600;font-size:${Math.round(pl.body.size * 0.82)}px;letter-spacing:.08em;text-transform:uppercase;color:${palette.light};line-height:1.2}
h1{font-family:R72Display;font-weight:700;font-size:${pl.headline.max}px;line-height:1.04;letter-spacing:-0.022em}
.body{font-size:${pl.body.size}px;line-height:1.34}
.cta-row{padding-top:${Math.round(pl.body.size * 0.25)}px}
.cta{display:inline-block;font-weight:600;font-size:${ctaSize}px;line-height:1.15;padding:${Math.round(ctaSize * 0.62)}px ${Math.round(ctaSize * 1.05)}px;border-radius:${Math.round(ctaSize * 0.42)}px;background:${palette.accent};color:${ctaInk}}
.disc{font-size:${disclosureSize}px;line-height:1.3;opacity:.92}
.tag{position:absolute;right:${Math.round(W * 0.03)}px;bottom:${Math.round(H * 0.018)}px;font-size:${Math.max(16, Math.round(W * 0.014))}px;padding:4px 10px;border-radius:99px;background:rgba(0,0,0,.62);color:#fff}
.card{font-weight:600;font-size:${Math.round(pl.body.size * 0.8)}px;padding:6px 14px;border-radius:99px;background:rgba(${rgb(palette.dark)},.72);color:${palette.light}}
body.measuring .measure,body.measuring .tag,body.measuring .card,body.measuring .cta,body.measuring .logo{visibility:hidden}
</style></head><body><div id="art">${bg}<div id="scrim"></div><div id="topscrim"></div><div id="safe"><div class="top">${logo}${card}</div><div class="copy">${copy}</div></div>${tag}</div></body></html>`;
}

// ─── Chromium ───────────────────────────────────────────────────────────────

/** Locate Chromium: explicit env, Playwright's own install, then the preinstalled container browsers. */
export function findCreativeChromium(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of ['CREATIVE_STUDIO_CHROMIUM', 'RELAUNCH72_CHROMIUM'] as const) {
    const value = env[key]?.trim();
    if (value && existsSync(value)) return value;
  }
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH?.trim(), '/opt/pw-browsers', path.join(process.cwd(), '.playwright-browsers'), path.join(process.cwd(), '..', '.playwright-browsers')]
    .filter((v): v is string => Boolean(v));
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).sort().reverse();
    for (const prefix of ['chromium_headless_shell-', 'chromium-']) {
      for (const dir of dirs.filter((d) => d.startsWith(prefix))) {
        for (const binary of ['chrome-linux/headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
          const candidate = path.join(root, dir, binary);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return null;
}

function decodeScreenshot(bytes: Buffer): { width: number; height: number; data: Uint8Array } {
  return jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
}

/** Worst-case contrast of `ink` against the brightest and darkest 5% of pixels in the box. */
export function measureBoxContrast(image: { width: number; height: number; data: Uint8Array }, box: { x: number; y: number; w: number; h: number }, ink: string): number {
  const lum: number[] = [];
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.w)), y1 = Math.min(image.height, Math.ceil(box.y + box.h));
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const i = (y * image.width + x) * 4;
    lum.push(luminance([image.data[i]!, image.data[i + 1]!, image.data[i + 2]!]));
  }
  if (!lum.length) return 21;
  lum.sort((a, b) => a - b);
  const low = lum[Math.floor(lum.length * 0.05)]!, high = lum[Math.min(lum.length - 1, Math.floor(lum.length * 0.95))]!;
  const text = luminance(parseHex(ink) ?? [255, 255, 255]);
  return Math.min(contrastRatio(text, low), contrastRatio(text, high));
}

const THRESHOLD: Readonly<Record<string, number>> = Object.freeze({ headline: 3, hook: 4.5, body: 4.5, disclosure: 4.5, wordmark: 4.5 });

// Page scripts are plain source strings: bundler helpers must never leak into the page.
const FIT_SCRIPT = `async ({ max, min, maxLines, bodyLines, bodySize }) => {
  await document.fonts.ready;
  const h = document.querySelector('h1'), safe = document.getElementById('safe'), body = document.querySelector('.body');
  let size = max;
  // Geometric containment: glyph descenders may overhang a line box, which is not a layout overflow.
  const within = () => { const sr = safe.getBoundingClientRect(), cr = document.querySelector('.copy').getBoundingClientRect(), tr = document.querySelector('.top').getBoundingClientRect();
    return cr.bottom <= sr.bottom + 1 && cr.top >= tr.bottom - 1; };
  const bodyOk = () => !body || Math.round(body.getBoundingClientRect().height / (bodySize * 1.34)) <= bodyLines;
  const fits = () => Math.round(h.getBoundingClientRect().height / (size * 1.04)) <= maxLines && bodyOk()
    && [...document.querySelectorAll('.copy > *')].every((el) => el.scrollWidth <= el.clientWidth + 1)
    && within();
  while (size > min && !fits()) { size -= 2; h.style.fontSize = size + 'px'; }
  return { size, fits: fits(), bodyFits: bodyOk() };
}`;
const BOXES_SCRIPT = `[...document.querySelectorAll('.measure')].map((el) => { const r = el.getBoundingClientRect(); return { role: el.dataset.role || 'text', x: r.x, y: r.y, w: r.width, h: r.height }; })`;

let queue: Promise<unknown> = Promise.resolve();
/** One render batch at a time per process: bounded memory on small instances. */
function serialised<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export class ChromiumArtworkRenderer implements ArtworkRenderer {
  readonly version = RENDERER_VERSION;
  private readonly executable: string | null;
  constructor(executable: string | null = findCreativeChromium()) { this.executable = executable; }
  available(): boolean { return this.executable !== null; }

  renderBatch(inputs: readonly ArtworkInput[]): Promise<RenderedArtwork[]> {
    if (!this.executable) return Promise.reject(new RendererUnavailableError());
    if (inputs.length < 1 || inputs.length > 24) return Promise.reject(new Error('Render between 1 and 24 artworks at a time.'));
    const executable = this.executable;
    return serialised(async () => {
      const { chromium } = await import('playwright-core');
      let browser: Awaited<ReturnType<typeof chromium.launch>>;
      try { browser = await chromium.launch({ executablePath: executable, headless: true, chromiumSandbox: process.getuid?.() !== 0, args: ['--disable-gpu', '--font-render-hinting=none', '--disable-lcd-text'] }); }
      catch { throw new RendererUnavailableError(); }
      try {
        const context = await browser.newContext({ javaScriptEnabled: true, serviceWorkers: 'block', deviceScaleFactor: 1, viewport: { width: 1080, height: 1080 }, offline: false });
        const fonts = new Map(Object.entries(FONTS).map(([key, file]) => [key, readFileSync(path.join(FONT_DIR, file))]));
        let images = new Map<string, VerifiedImage>();
        await context.route('**/*', async (route) => {
          const url = route.request().url();
          if (url.startsWith(`${ORIGIN}/f/`)) {
            const font = fonts.get(url.slice(ORIGIN.length + 3));
            return font ? route.fulfill({ status: 200, contentType: 'font/otf', body: font }) : route.abort();
          }
          if (url.startsWith(`${ORIGIN}/i/`)) {
            const image = images.get(url.slice(ORIGIN.length + 3));
            return image ? route.fulfill({ status: 200, contentType: image.mime, body: image.bytes }) : route.abort();
          }
          return route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        page.setDefaultTimeout(RENDER_TIMEOUT_MS);
        const results: RenderedArtwork[] = [];
        for (const input of inputs) {
          const { width: W, height: H } = input.placement;
          images = new Map();
          if (input.background) images.set('bg', input.background);
          if (input.logo) images.set('logo', input.logo);
          await page.setViewportSize({ width: W, height: H });
          await page.setContent(artworkHtml(input), { waitUntil: 'load' });
          const fit = await page.evaluate(`(${FIT_SCRIPT})(${JSON.stringify({ max: input.placement.headline.max, min: input.placement.headline.min, maxLines: input.placement.headline.maxLines, bodyLines: input.placement.body.maxLines, bodySize: input.placement.body.size })})`) as { size: number; fits: boolean; bodyFits: boolean };
          const boxes = await page.evaluate(BOXES_SCRIPT) as { role: string; x: number; y: number; w: number; h: number }[];
          let scrim = SCRIM_STEPS[0]!; let contrast: Record<string, number> = {};
          for (const step of SCRIM_STEPS) {
            scrim = step;
            await page.evaluate(`document.getElementById('art').style.setProperty('--scrim','${step}');document.body.classList.add('measuring')`);
            const shot = decodeScreenshot(await page.screenshot({ type: 'jpeg', quality: 95, animations: 'disabled' }));
            contrast = Object.fromEntries(boxes.map((b) => [b.role, Number(measureBoxContrast(shot, b, input.palette.light).toFixed(2))]));
            if (boxes.every((b) => (contrast[b.role] ?? 0) >= (THRESHOLD[b.role] ?? 4.5))) break;
          }
          await page.evaluate(`document.body.classList.remove('measuring')`);
          const bytes = await page.screenshot({ type: 'jpeg', quality: 90, animations: 'disabled' });
          const issues: ArtworkIssue[] = [];
          if (!fit.fits || !fit.bodyFits) issues.push({ code: 'text_overflow', blocking: true, detail: `The copy does not fit the ${input.placement.label} layout at a legible size. Shorten the headline or body.` });
          for (const b of boxes) {
            const need = THRESHOLD[b.role] ?? 4.5, got = contrast[b.role] ?? 0;
            if (got < need) issues.push({ code: 'low_contrast', blocking: true, detail: `The ${b.role} reaches ${got}:1 contrast against this background (needs ${need}:1). Choose a darker brand dark colour, a calmer background or move the focal point.` });
          }
          if (input.cta) {
            const ratio = contrastRatio(luminance(parseHex(input.palette.accent) ?? [0, 0, 0]), luminance(parseHex(inkFor(input.palette.accent, input.palette)) ?? [0, 0, 0]));
            contrast.cta = Number(ratio.toFixed(2));
            if (ratio < 4.5) issues.push({ code: 'cta_contrast', blocking: true, detail: `The button colours reach only ${ratio.toFixed(2)}:1 contrast. Choose an accent colour that contrasts with the brand light or dark colour.` });
          }
          const owned = Buffer.from(bytes);
          const result = { mime: 'image/jpeg' as const, sha256: createHash('sha256').update(owned).digest('hex'), width: W, height: H, contrast: Object.freeze(contrast), scrimAlpha: scrim, headlineSize: fit.size, issues: Object.freeze(issues) };
          Object.defineProperty(result, 'bytes', { enumerable: false, get: () => Buffer.from(owned) });
          results.push(Object.freeze(result) as RenderedArtwork);
        }
        await context.close();
        return results;
      } finally {
        await browser.close();
      }
    });
  }
}
