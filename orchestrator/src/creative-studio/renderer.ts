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
import { remuxFragmentedMp4 } from './mp4-remux.js';
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
  /** Video scenes: also capture the measured text/scrim/logo layer as a transparent PNG. */
  readonly captureOverlay?: boolean;
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
  /** Transparent PNG of the exact overlay layer, present only when requested. */
  readonly overlay?: Buffer;
}

export type MotionId = 'none' | 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right';
export const MOTIONS: readonly MotionId[] = Object.freeze(['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'none']);
export interface VideoScene {
  readonly background: VerifiedImage | null;
  readonly focal: Readonly<{ x: number; y: number }>;
  /** Transparent PNG produced by renderBatch({ captureOverlay: true }) for the same layout. */
  readonly overlay: Buffer;
  readonly durationMs: number;
  readonly motion: MotionId;
}
export interface VideoInput {
  readonly width: number;
  readonly height: number;
  readonly palette: Palette;
  readonly scenes: readonly VideoScene[];
}
export interface RenderedVideo {
  readonly mime: 'video/mp4' | 'video/webm';
  readonly codec: string;
  /** progressive: index-first standard MP4 (losslessly rewritten); fragmented/webm: as recorded. */
  readonly container: 'progressive' | 'fragmented' | 'webm';
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  /** Planned timeline length. */
  readonly durationMs: number;
  /** Duration reported by an independent playback check, or null when the container does not state it. */
  readonly measuredDurationMs: number | null;
  readonly playable: boolean;
  readonly byteLength: number;
  readonly bytes: Buffer;
}
export interface ContactSheetFrame { readonly image: Buffer; readonly caption: string; readonly script: string | null }
export const VIDEO_LIMITS = Object.freeze({ scenes: 8, sceneMs: [1500, 8000] as const, totalMs: 30_000, fps: 30, bitsPerSecond: 5_000_000, bytes: 20 * 1024 * 1024 });

export interface ArtworkRenderer {
  readonly version: string;
  available(): boolean;
  /** Renders sequentially in one browser; resolves only with real raster bytes. */
  renderBatch(inputs: readonly ArtworkInput[]): Promise<RenderedArtwork[]>;
  /** Storyboard sheet: still frames plus captions, clearly labelled as not a video. */
  renderContactSheet?(frames: readonly ContactSheetFrame[], title: string): Promise<{ bytes: Buffer; sha256: string; width: number; height: number }>;
  /** Records the scenes to a real video file and verifies it plays back. */
  renderVideo?(input: VideoInput): Promise<RenderedVideo>;
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

/** Canvas timeline recorded in real time by the browser's own MediaRecorder (H.264 MP4 preferred). */
const VIDEO_SCRIPT = `async ({ scenes, palette, fps, bits }) => {
  const c = document.getElementById('c'), ctx = c.getContext('2d'), W = c.width, H = c.height;
  const load = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('image')); i.src = src; });
  const items = [];
  for (const s of scenes) items.push({ ...s, bgImg: s.bg ? await load(s.bg) : null, ovImg: await load(s.ov) });
  const draw = (s, p) => {
    if (s.bgImg) {
      const base = Math.max(W / s.bgImg.width, H / s.bgImg.height);
      const z = s.motion === 'zoom_in' ? 1 + 0.08 * p : s.motion === 'zoom_out' ? 1.08 - 0.08 * p : 1.06;
      const dw = s.bgImg.width * base * z, dh = s.bgImg.height * base * z;
      let x = Math.min(0, Math.max(W - dw, W / 2 - s.focal.x * dw)), y = Math.min(0, Math.max(H - dh, H / 2 - s.focal.y * dh));
      const slack = dw - W;
      if (s.motion === 'pan_left') x = -slack * (0.15 + 0.7 * p); if (s.motion === 'pan_right') x = -slack * (0.85 - 0.7 * p);
      ctx.drawImage(s.bgImg, x, y, dw, dh);
    } else {
      const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, palette.primary); g.addColorStop(0.78, palette.dark); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    ctx.drawImage(s.ovImg, 0, 0, W, H);
  };
  const types = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d0028', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) throw new Error('No supported video encoder');
  const stream = c.captureStream(fps), rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bits }), chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  const total = items.reduce((n, s) => n + s.ms, 0); let frames = 0;
  draw(items[0], 0); rec.start(250);
  const t0 = performance.now();
  await new Promise((done) => { const tick = () => {
    const t = performance.now() - t0; if (t >= total) return done();
    let start = 0, i = 0; while (i < items.length - 1 && t >= start + items[i].ms) { start += items[i].ms; i++; }
    const s = items[i], p = Math.min(1, (t - start) / s.ms);
    draw(s, p);
    const q = (t - start) / 350;
    if (i > 0 && q < 1) { ctx.globalAlpha = 1 - q; draw(items[i - 1], 1); ctx.globalAlpha = 1; }
    frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  rec.stop(); await stopped;
  const buf = new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { mime: mimeType, b64: btoa(bin), frames };
}`;
/** Independent playback check of the recorded bytes: metadata, real dimensions, a decodable non-blank frame. */
const PLAYBACK_CHECK = `async ({ src, w, h }) => {
  const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = src; document.body.appendChild(v);
  const wait = (ev, ms = 20000) => new Promise((ok, fail) => { const t = setTimeout(() => fail(new Error('timeout ' + ev)), ms); v.addEventListener(ev, () => { clearTimeout(t); ok(); }, { once: true }); v.addEventListener('error', () => { clearTimeout(t); fail(new Error('decode')); }, { once: true }); });
  try {
    await wait('loadeddata');
    // A decodable, non-blank frame near the start.
    v.currentTime = 0.8; await wait('seeked');
    const k = document.createElement('canvas'); k.width = 64; k.height = 64; const x = k.getContext('2d'); x.drawImage(v, 0, 0, 64, 64);
    const px = x.getImageData(0, 0, 64, 64).data; let min = 255, max = 0;
    for (let i = 0; i < px.length; i += 4) { const l = (px[i] + px[i + 1] + px[i + 2]) / 3; if (l < min) min = l; if (l > max) max = l; }
    // Recorder output is fragmented and under-reports its length until read: play it all (fast) to the end.
    v.currentTime = 0; await wait('seeked'); v.playbackRate = 16; await v.play(); await wait('ended', 30000);
    const ends = [v.duration, v.currentTime].filter(Number.isFinite);
    return { ok: max - min > 8, duration: ends.length ? Math.max(...ends) : null, width: v.videoWidth, height: v.videoHeight };
  } catch (e) { return { ok: false, duration: null, width: v.videoWidth, height: v.videoHeight }; }
}`;

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
          let overlay: Buffer | null = null;
          if (input.captureOverlay) {
            await page.evaluate(`(() => { const bg = document.getElementById('bg'); if (bg) bg.style.visibility = 'hidden'; document.documentElement.style.background = 'transparent'; document.body.style.background = 'transparent'; })()`);
            overlay = Buffer.from(await page.screenshot({ type: 'png', omitBackground: true, animations: 'disabled' }));
          }
          const owned = Buffer.from(bytes);
          const result = { mime: 'image/jpeg' as const, sha256: createHash('sha256').update(owned).digest('hex'), width: W, height: H, contrast: Object.freeze(contrast), scrimAlpha: scrim, headlineSize: fit.size, issues: Object.freeze(issues) };
          Object.defineProperty(result, 'bytes', { enumerable: false, get: () => Buffer.from(owned) });
          if (overlay) { const layer = overlay; Object.defineProperty(result, 'overlay', { enumerable: false, get: () => Buffer.from(layer) }); }
          results.push(Object.freeze(result) as RenderedArtwork);
        }
        await context.close();
        return results;
      } finally {
        await browser.close();
      }
    });
  }

  /** One offline browser page serving only in-memory files from the private pseudo-origin. */
  private session<T>(work: (page: import('playwright-core').Page, files: Map<string, { type: string; body: Buffer }>) => Promise<T>): Promise<T> {
    if (!this.executable) return Promise.reject(new RendererUnavailableError());
    const executable = this.executable;
    return serialised(async () => {
      const { chromium } = await import('playwright-core');
      let browser: Awaited<ReturnType<typeof chromium.launch>>;
      try { browser = await chromium.launch({ executablePath: executable, headless: true, chromiumSandbox: process.getuid?.() !== 0, args: ['--disable-gpu', '--font-render-hinting=none', '--autoplay-policy=no-user-gesture-required'] }); }
      catch { throw new RendererUnavailableError(); }
      try {
        const context = await browser.newContext({ javaScriptEnabled: true, serviceWorkers: 'block', deviceScaleFactor: 1, viewport: { width: 1280, height: 900 } });
        const files = new Map<string, { type: string; body: Buffer }>();
        for (const [key, file] of Object.entries(FONTS)) files.set(`/f/${key}`, { type: 'font/otf', body: readFileSync(path.join(FONT_DIR, file)) });
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          const file = url.origin === ORIGIN ? files.get(url.pathname) : undefined;
          return file ? route.fulfill({ status: 200, contentType: file.type, body: file.body, headers: { 'accept-ranges': 'none' } }) : route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        page.setDefaultTimeout(RENDER_TIMEOUT_MS + VIDEO_LIMITS.totalMs);
        const result = await work(page, files);
        await context.close();
        return result;
      } finally { await browser.close(); }
    });
  }

  renderContactSheet(frames: readonly ContactSheetFrame[], title: string): Promise<{ bytes: Buffer; sha256: string; width: number; height: number }> {
    if (!frames.length || frames.length > VIDEO_LIMITS.scenes + 1) return Promise.reject(new Error('A storyboard has one to nine frames.'));
    return this.session(async (page, files) => {
      frames.forEach((f, i) => files.set(`/sb/${i}.jpg`, { type: 'image/jpeg', body: f.image }));
      const cards = frames.map((f, i) => `<figure><img src="${ORIGIN}/sb/${i}.jpg" alt=""><figcaption><b>Scene ${i + 1}</b> · ${escape(f.caption)}${f.script ? `<span class="script">Script only — no audio produced: ${escape(f.script)}</span>` : ''}</figcaption></figure>`).join('');
      files.set('/sheet', { type: 'text/html; charset=utf-8', body: Buffer.from(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@font-face{font-family:R72Text;src:url(${ORIGIN}/f/text.otf);font-weight:400}@font-face{font-family:R72Text;src:url(${ORIGIN}/f/strong.otf);font-weight:600}
body{margin:0;width:1600px;background:#f3f4f6;font-family:R72Text;color:#111827}header{background:#111827;color:#fff;padding:22px 32px;font-weight:600;font-size:26px;display:flex;justify-content:space-between}
header span{background:#fbbf24;color:#111827;padding:4px 12px;border-radius:6px;font-size:18px}main{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;padding:24px 32px 32px}
figure{margin:0;background:#fff;border-radius:10px;padding:10px;box-shadow:0 1px 3px rgba(0,0,0,.12)}img{width:100%;display:block;border-radius:6px}figcaption{font-size:15px;line-height:1.35;margin-top:8px}
.script{display:block;margin-top:6px;color:#4b5563;font-size:14px;border-left:3px solid #fbbf24;padding-left:8px}</style></head><body><header>${escape(title)}<span>STORYBOARD — NOT A VIDEO</span></header><main>${cards}</main></body></html>`) });
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`${ORIGIN}/sheet`, { waitUntil: 'load' });
      await page.evaluate('document.fonts.ready');
      const bytes = Buffer.from(await page.screenshot({ type: 'jpeg', quality: 85, fullPage: true }));
      const size = await page.evaluate('[document.documentElement.scrollWidth, document.documentElement.scrollHeight]') as [number, number];
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), width: size[0], height: size[1] };
    });
  }

  renderVideo(input: VideoInput): Promise<RenderedVideo> {
    const total = input.scenes.reduce((n, s) => n + s.durationMs, 0);
    if (!input.scenes.length || input.scenes.length > VIDEO_LIMITS.scenes || total > VIDEO_LIMITS.totalMs
      || input.scenes.some((s) => s.durationMs < VIDEO_LIMITS.sceneMs[0] || s.durationMs > VIDEO_LIMITS.sceneMs[1] || !MOTIONS.includes(s.motion))) {
      return Promise.reject(new Error('A video has one to eight scenes of 1.5–8 seconds, at most 30 seconds in total.'));
    }
    return this.session(async (page, files) => {
      const scenes = input.scenes.map((s, i) => {
        if (s.background) files.set(`/v/bg${i}`, { type: s.background.mime, body: s.background.bytes });
        files.set(`/v/ov${i}`, { type: 'image/png', body: s.overlay });
        return { bg: s.background ? `${ORIGIN}/v/bg${i}` : null, ov: `${ORIGIN}/v/ov${i}`, focal: s.focal, ms: s.durationMs, motion: s.motion };
      });
      files.set('/video', { type: 'text/html; charset=utf-8', body: Buffer.from(`<!DOCTYPE html><html><body style="margin:0;background:#000"><canvas id="c" width="${input.width}" height="${input.height}"></canvas></body></html>`) });
      await page.setViewportSize({ width: input.width, height: input.height });
      await page.goto(`${ORIGIN}/video`, { waitUntil: 'load' });
      const recorded = await page.evaluate(`(${VIDEO_SCRIPT})(${JSON.stringify({ scenes, palette: input.palette, fps: VIDEO_LIMITS.fps, bits: VIDEO_LIMITS.bitsPerSecond })})`) as { mime: string; b64: string; frames: number };
      const recordedBytes = Buffer.from(recorded.b64, 'base64');
      const mime = recorded.mime.startsWith('video/mp4') ? 'video/mp4' as const : 'video/webm' as const;
      // Same encoded samples, standard index-first layout with real durations; unknown shapes stay as recorded.
      const progressive = mime === 'video/mp4' ? remuxFragmentedMp4(recordedBytes) : null;
      const bytes = progressive ?? recordedBytes;
      const container = mime === 'video/webm' ? 'webm' as const : progressive ? 'progressive' as const : 'fragmented' as const;
      if (!bytes.length || bytes.length > VIDEO_LIMITS.bytes) throw new Error('The recorded video is empty or exceeds the 20 MB limit.');
      files.set('/v/out', { type: mime, body: bytes });
      files.set('/check', { type: 'text/html; charset=utf-8', body: Buffer.from('<!DOCTYPE html><html><body></body></html>') });
      await page.goto(`${ORIGIN}/check`, { waitUntil: 'load' });
      const check = await page.evaluate(`(${PLAYBACK_CHECK})(${JSON.stringify({ src: `${ORIGIN}/v/out`, w: input.width, h: input.height })})`) as { ok: boolean; duration: number | null; width: number; height: number };
      const result = { mime, codec: recorded.mime, container, sha256: createHash('sha256').update(bytes).digest('hex'), width: input.width, height: input.height, durationMs: total,
        measuredDurationMs: check.duration === null ? null : Math.round(check.duration * 1000),
        playable: check.ok && check.width === input.width && check.height === input.height, byteLength: bytes.length };
      Object.defineProperty(result, 'bytes', { enumerable: false, get: () => Buffer.from(bytes) });
      return Object.freeze(result) as RenderedVideo;
    });
  }
}
