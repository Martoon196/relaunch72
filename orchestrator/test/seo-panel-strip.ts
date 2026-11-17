/**
 * The SEO report is the only addition to the article page. For the "unchanged apart from the panel" proof, a recorded
 * response is compared with the SEO report lifted out (both marker-wrapped pieces) and the length header recomputed.
 */
import { SEO_PANEL_END, SEO_PANEL_START } from '../src/portal/seo-blog-seo-panel.js';

const PIECE = new RegExp(`${SEO_PANEL_START}[\\s\\S]*?${SEO_PANEL_END}\\n?`, 'g');

/** The body without the SEO report. The fold piece is followed by its own line break in the folds list. */
export function withoutSeoPanel(body: string): string {
  return body.replace(PIECE, '');
}

export function withoutSeoPanelResponse<T extends { status: number; headers: Record<string, string>; body: string }>(r: T): T {
  if (!r || typeof r.body !== 'string' || !r.body.includes(SEO_PANEL_START)) return r;
  const body = withoutSeoPanel(r.body);
  return { ...r, headers: { ...r.headers, ...(r.headers['content-length'] !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}) }, body };
}

/** How many SEO report pieces a body carries (the top line and the fold: 2 on a written article page in reading mode). */
export const seoPanelPieces = (body: string) => (body.match(PIECE) ?? []).length;
