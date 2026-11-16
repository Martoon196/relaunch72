/**
 * Who may see technical detail in the content area. There is one rule: the founder is whoever may manage account
 * limits (the "Usage and limits" page, `limits.allowed()` in the router), which every page's shell already carries
 * as `limitsAvailable`. A client sees the neutral sentence only; the founder also gets a collapsed "Technical detail".
 */
import { escapeHtml as e } from './ui.js';

/** True only on the founder's own screens. */
export function founderView(shell: { readonly limitsAvailable?: boolean }): boolean {
  return shell.limitsAvailable === true;
}

/**
 * A collapsed "Technical detail" block for the founder, or nothing for anyone else. Raw text that says nothing
 * beyond the neutral sentence is not repeated.
 */
export function technicalDetail(shell: { readonly limitsAvailable?: boolean }, raw: readonly (string | null | undefined)[], shown = ''): string {
  if (!founderView(shell)) return '';
  const lines = raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '' && x !== shown);
  return lines.length ? `<details class="technical-detail"><summary>Technical detail</summary>${lines.map((x) => `<p class="muted">${e(x)}</p>`).join('')}</details>` : '';
}
