/**
 * Relaunch72 Lexicon v1 — RATIFIED by founder 2026-07-04 (Notion: "Relaunch72
 * Lexicon v1"). The single source for customer-facing deliverable names.
 * Internal contracts (stage IDs S0–S10, field IDs A1–H4, schema keys) stay
 * canonical — this is the display layer only. Change the Notion page first,
 * then mirror here.
 */

export interface LexiconEntry {
  /** Customer-facing deliverable name. */
  name: string;
  /** Generic/industry term it replaces (never customer-facing). */
  replaces: string;
}

export const LEXICON: Record<string, LexiconEntry> = {
  S1: { name: 'Relaunch Scorecard', replaces: 'marketing audit & scorecard' },
  S2: { name: 'True Buyer Profile', replaces: 'ICP / customer avatar / dream buyer profile' },
  S3: { name: 'Message Spine + Voiceprint', replaces: 'core message + brand voice guide' },
  S4: { name: 'Offer Stack Blueprint', replaces: 'offer architecture' },
  S5: { name: 'Relaunch Roadmap', replaces: '90-day growth plan' },
  S6: { name: 'Shopfront Pack', replaces: 'website copy pack' },
  S7: { name: 'Follow-Up Engine', replaces: 'email pack' },
  S8: { name: '30-Day Content Engine', replaces: '30 days of social content' },
  S9: { name: 'Relaunch On A Page', replaces: 'one-page business plan' },
};

/** The full 9-document bundle. */
export const BUNDLE_NAME = 'Your Relaunch Stack';

export function deliverableName(stage: string): string {
  return LEXICON[stage]?.name ?? stage;
}
