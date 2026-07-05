/**
 * S10 · Assembly & strategist gate (Pipeline Spec v1.0).
 *
 * No LLM call. After S1–S9 pass their own gates, S10 runs the GLOBAL lint —
 * banned-phrase re-scan across every deliverable, cross-doc consistency
 * (S3's voice list binds the copy stages; prices in copy come from S4 or the
 * intake; the pack visibly carries the positioning; the emails sell a real
 * offer) — then assembles the portal package and queues it for human
 * sign-off with ALL QA flags attached. S10 issues are strategist-gate flags,
 * not automatic retries: there is no model to critique here, only documents
 * for a human to approve or send back for a targeted re-run.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Intake, QAIssue, RunManifest, S10Result } from '../types.js';
import { normalizeText, extractNumbers } from '../util/text.js';
import {
  GLOBAL_BANNED_PHRASES, customerNeverWords, phraseRegex, scanBannedPhrases, walkStrings,
  type BannedScanOpts,
} from '../qa/banned.js';
import { haystack, intakeNumberSet, tokensOf } from '../qa/checks.js';
import { BUNDLE_NAME, deliverableName } from '../lexicon.js';

/**
 * Compliance line rendered on every delivered document and the portal page
 * (hard rule #5; Offer Spec: "No income/outcome guarantees — compliance +
 * honesty"). DRAFT v0 — founder ratifies exact wording at LS-15 (doc
 * templates) before anything ships to a real customer.
 */
export const COMPLIANCE_LINE =
  'This pack is marketing material prepared from information you provided. It contains no promise of revenue, ' +
  'results or outcomes — what you earn depends on your market, your offer and your follow-through. ' +
  'Review everything before publishing; you are responsible for claims made in your own name.';

/** The same voice scope each stage's own QA used (D-003/D-015/D-018). */
const STAGE_SCAN_OPTS: Record<string, BannedScanOpts> = {
  S1: { includeCustomerWords: false, stripQuotedText: true },
  S2: { includeCustomerWords: false, stripQuotedText: true, excludePathPrefixes: ['verbatims'] },
  S3: { includeCustomerWords: true, stripQuotedText: true, excludePathPrefixes: ['voice.banned_words'] },
  S4: { includeCustomerWords: true, stripQuotedText: true },
  S5: { includeCustomerWords: false, stripQuotedText: true },
  S6: { includeCustomerWords: true, stripQuotedText: true },
  S7: { includeCustomerWords: true, stripQuotedText: true },
  S8: { includeCustomerWords: true, stripQuotedText: true },
  S9: { includeCustomerWords: false, stripQuotedText: true },
};

/**
 * Function words + marketing-generic nouns excluded from the positioning-echo
 * comparison, so overlap means the pack echoes the MESSAGE, not the language.
 */
const POSITIONING_STOP = new Set([
  'that', 'this', 'with', 'from', 'they', 'them', 'their', 'your', 'yours', 'what', 'when', 'where',
  'which', 'have', 'will', 'does', 'into', 'onto', 'over', 'under', 'than', 'then', 'been', 'being',
  'because', 'about', 'after', 'before', 'while', 'would', 'could', 'should', 'there', 'here', 'each',
  'only', 'just', 'also', 'very', 'more', 'most', 'some', 'such', 'stop', 'like', 'gets', 'said',
  'says', 'business', 'customer', 'customers', 'people', 'work', 'service', 'services', 'marketing',
]);

function distinctiveTokens(text: string): Set<string> {
  return new Set([...tokensOf(text)].filter((t) => !POSITIONING_STOP.has(t)));
}

function stripQuoted(s: string): string {
  return s.replace(/"[^"]*"/g, ' ');
}

interface S3Shape {
  positioning_statement: string;
  message_pillars: string[];
  voice: { banned_words: string[] };
}

interface S4Shape {
  lead_offer: string;
  recommended_stack: Array<{ name: string; price: number }>;
}

interface S6Shape {
  home: { hero_variants: Array<{ headline: string; subhead: string }>; sections: Array<{ head: string; body: string }> };
  about: { head: string; body: string };
  sales_page: { head: string; subhead: string };
}

interface S7Shape {
  promo_seq: Array<{ subject_variants: Array<{ subject: string }>; body: string; cta: string }>;
}

interface S9Shape {
  snapshot: string;
  market: string;
  offer: string;
}

/** The deterministic global lint — pure so tests can drive it directly. */
export function s10Lint(intake: Intake, outputs: Record<string, unknown>): QAIssue[] {
  const issues: QAIssue[] = [];

  // 1 · Global banned-phrase re-scan, per-stage voice scope. Belt-and-braces
  // over the per-stage scans: catches anything that slipped through a config
  // drift, on the exact document set that ships.
  for (const [stage, opts] of Object.entries(STAGE_SCAN_OPTS)) {
    if (!(stage in outputs)) continue;
    for (const issue of scanBannedPhrases(outputs[stage], intake, opts)) {
      issues.push({ check: 's10.banned_phrase', message: `${stage}: ${issue.message}` });
    }
  }

  const s3 = outputs.S3 as S3Shape | undefined;
  const s4 = outputs.S4 as S4Shape | undefined;

  // 2 · S3's voice list binds the copy deliverables (S6–S8) in full — the
  // per-stage scans cover the global list + H3; the model's own additions to
  // voice.banned_words must hold across the pack too.
  if (s3) {
    const alreadyCovered = new Set([
      ...GLOBAL_BANNED_PHRASES.map((p) => p.toLowerCase()),
      ...customerNeverWords(intake),
    ]);
    const extras = (s3.voice.banned_words ?? [])
      .map((w) => normalizeText(w).toLowerCase())
      .filter((w) => w.length > 1 && !alreadyCovered.has(w));
    for (const stage of ['S6', 'S7', 'S8']) {
      if (!(stage in outputs)) continue;
      for (const phrase of extras) {
        const re = phraseRegex(phrase);
        for (const [p, text] of walkStrings(outputs[stage], '')) {
          if (re.test(stripQuoted(normalizeText(text)))) {
            issues.push({
              check: 's10.s3_banned_word',
              message: `${stage}.${p}: contains "${phrase}", which S3's voice guide bans — the voice list binds every copy deliverable`,
            });
          }
        }
      }
    }
  }

  // 3 · Same prices everywhere: any currency amount in the copy deliverables
  // (S6–S8) must be an S4 recommended price or a price the intake already
  // states. S5/S9 are excluded — their own QA permits visible B2/B3
  // arithmetic, which this scan cannot distinguish from a rogue price.
  if (s4) {
    const legalPrices = new Set<number>([
      ...s4.recommended_stack.map((i) => i.price),
      ...intakeNumberSet(haystack(intake, ['B1', 'B2', 'B3', 'B6', 'D1', 'D2', 'D3', 'G1', 'G3'])),
    ]);
    for (const stage of ['S6', 'S7', 'S8']) {
      if (!(stage in outputs)) continue;
      for (const [p, text] of walkStrings(outputs[stage], '')) {
        const subject = stripQuoted(normalizeText(text));
        for (const n of extractNumbers(subject)) {
          if (/[£$€]\s*$/.test(n.before) && !legalPrices.has(n.value)) {
            issues.push({
              check: 's10.price_conflict',
              message: `${stage}.${p}: quotes a price of ${n.raw} that is neither an S4 recommended price nor a price the intake states — every price in the pack must agree with the Offer Stack`,
            });
          }
        }
      }
    }
  }

  // 4 · The pack visibly carries the positioning. Conservative zero-overlap
  // detector: a document that shares NOT ONE distinctive token with S3's
  // positioning statement + pillars has drifted off-message.
  if (s3) {
    const positioningTokens = distinctiveTokens(
      [s3.positioning_statement, ...(s3.message_pillars ?? [])].join(' '),
    );
    const docs: Array<[string, string]> = [];
    const s6 = outputs.S6 as S6Shape | undefined;
    if (s6) {
      docs.push([
        'S6 (website pack)',
        [
          ...s6.home.hero_variants.flatMap((h) => [h.headline, h.subhead]),
          ...s6.home.sections.flatMap((s) => [s.head, s.body]),
          s6.about.head, s6.about.body, s6.sales_page.head, s6.sales_page.subhead,
        ].join(' '),
      ]);
    }
    const s9 = outputs.S9 as S9Shape | undefined;
    if (s9) docs.push(['S9 (one-page plan)', [s9.snapshot, s9.market, s9.offer].join(' ')]);
    if (positioningTokens.size > 0) {
      for (const [doc, text] of docs) {
        const docTokens = distinctiveTokens(text);
        if (![...positioningTokens].some((t) => docTokens.has(t))) {
          issues.push({
            check: 's10.positioning_drift',
            message: `${doc} shares no distinctive wording with S3's positioning statement or pillars — the pack must repeat the message, not just gesture at it`,
          });
        }
      }
    }
  }

  // 5 · The emails sell a real offer: at least one promo email names an S4
  // stack offer (the welcome arc may nurture; the promo arc must sell).
  if (s4) {
    // Offer NAMES only — lead_offer prose would make the overlap trivial.
    const offerTokens = tokensOf(s4.recommended_stack.map((o) => o.name).join(' '));
    const s7 = outputs.S7 as S7Shape | undefined;
    if (s7 && offerTokens.size > 0) {
      const promoText = s7.promo_seq
        .flatMap((e) => [e.body, e.cta, ...e.subject_variants.map((v) => v.subject)])
        .join(' ');
      if (![...tokensOf(promoText)].some((t) => offerTokens.has(t))) {
        issues.push({
          check: 's10.lead_offer_unsold',
          message: 'no promo email names an S4 stack offer — the promo sequence must sell a real, named thing',
        });
      }
    }
  }

  return issues;
}

/** Assemble bundle.json + review.md and queue for the strategist gate. */
export function runS10(
  intake: Intake,
  outputs: Record<string, unknown>,
  manifest: RunManifest,
  runDir: string,
): S10Result {
  const issues = s10Lint(intake, outputs);
  const assembledAt = new Date().toISOString();

  const deliverables = manifest.stages
    .filter((s) => s.status === 'passed' && s.output_file)
    .map((s) => ({
      stage: s.stage,
      name: deliverableName(s.stage),
      file: s.output_file as string,
      prompt_version: s.prompt_version,
      model: s.model,
    }));

  const bundle = {
    bundle: BUNDLE_NAME,
    run_id: manifest.run_id,
    source: manifest.source,
    mode: manifest.mode,
    business: typeof intake.A1 === 'string' ? intake.A1 : String(intake.A1 ?? ''),
    assembled_at: assembledAt,
    deliverables,
    qa: {
      stage_flags: Object.fromEntries(manifest.stages.filter((s) => s.flags.length > 0).map((s) => [s.stage, s.flags])),
      s10_issues: issues,
    },
    compliance_line: COMPLIANCE_LINE,
    status: 'awaiting_signoff' as const,
  };
  fs.writeFileSync(path.join(runDir, 'bundle.json'), JSON.stringify(bundle, null, 2), 'utf8');

  const lines: string[] = [
    `# ${BUNDLE_NAME} — strategist review`,
    '',
    `- **Run**: \`${manifest.run_id}\` (${manifest.mode}${manifest.mode === 'mock' ? ' — synthetic, NOT for quality review' : ''})`,
    `- **Business**: ${bundle.business}`,
    `- **Assembled**: ${assembledAt}`,
    `- **Cost**: $${manifest.totals.cost_usd.toFixed(4)} · tokens in/out ${manifest.totals.tokens_in}/${manifest.totals.tokens_out}`,
    '',
    '## Deliverables',
    '',
    '| Stage | Deliverable | File | Prompt | Model |',
    '|---|---|---|---|---|',
    ...deliverables.map((d) => `| ${d.stage} | ${d.name} | \`${d.file}\` | ${d.prompt_version} | ${d.model} |`),
    '',
    '## QA flags for this review',
    '',
  ];
  const stageFlagLines = manifest.stages.flatMap((s) => s.flags.map((f) => `- **${s.stage}**: ${f}`));
  const retryLines = manifest.stages
    .filter((s) => s.attempts.length > 1)
    .map((s) => `- **${s.stage}**: needed ${s.attempts.length} attempts (retry critique applied) — read it with extra care`);
  lines.push(...(stageFlagLines.length + retryLines.length > 0 ? [...stageFlagLines, ...retryLines] : ['- none — every stage passed first attempt']));
  lines.push(
    '',
    '## Global lint (S10)',
    '',
    ...(issues.length > 0 ? issues.map((i) => `- \`${i.check}\` ${i.message}`) : ['- clean']),
    '',
    '## Sign-off',
    '',
    '- [ ] Read every deliverable against the intake — would the owner say "you clearly read my answers"?',
    '- [ ] Quotes spot-checked against C2 / intake (no invented proof anywhere)',
    '- [ ] Prices consistent with the Offer Stack Blueprint everywhere they appear',
    '- [ ] Approve → delivery fires (LS-19) · Reject a stage → targeted re-run with strategist notes',
    '',
    `> ${COMPLIANCE_LINE}`,
    '',
  );
  fs.writeFileSync(path.join(runDir, 'review.md'), lines.join('\n'), 'utf8');

  return {
    issues,
    package_file: 'bundle.json',
    review_file: 'review.md',
    status: 'awaiting_signoff',
    assembled_at: assembledAt,
  };
}
