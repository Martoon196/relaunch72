/**
 * Deterministic keyword metrics for mechanics testing + £0 dry runs. Volumes are
 * derived from the keyword string by a stable hash (no Date/random), so a run is
 * reproducible. ALWAYS labelled source:'mock' — plausible-looking but NOT real,
 * and never to be shown to a customer or written into copy as fact.
 */

import type { KeywordMetric, KeywordProvider } from './types.js';

/** Stable 32-bit hash of a string (FNV-1a) — deterministic across runs/machines. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class MockKeywordProvider implements KeywordProvider {
  readonly mode = 'mock' as const;

  async metrics(keywords: string[]): Promise<KeywordMetric[]> {
    return keywords.map((keyword) => {
      const h = hash(keyword.trim().toLowerCase());
      // Shape into plausible-but-fake ranges; shorter/head-ish terms trend higher.
      const lengthPenalty = Math.min(keyword.split(/\s+/).length, 8);
      const volume = Math.max(10, Math.round((h % 9000) / lengthPenalty) * 10);
      const difficulty = h % 100;
      const cpc = Math.round((h >>> 8) % 900) / 100; // 0.00–8.99 (unsigned shift: never negative)
      return { keyword, volume, difficulty, cpc, source: 'mock' as const };
    });
  }
}
