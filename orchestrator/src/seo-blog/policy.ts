/**
 * Publishing policy — the single execution-time gate.
 *
 * Truth table (brand auto publish × article "needs my approval"):
 *   Off × either → the exact current version must be approved.
 *   On  × off    → publish at the diary time when every other control passes.
 *   On  × on     → the exact current version must be approved.
 *
 * The dispatcher calls `evaluatePublication` immediately before it records a
 * publication operation, using freshly read brand settings, article, version,
 * checks and destination. Nothing about an earlier evaluation is trusted.
 */

import type {
  Article, ArticleHold, ArticleVersion, Brand, CheckReport, Destination, IsoInstant, PolicySnapshot,
} from './types.js';

/** Work that is due but older than this is held instead of being published late in a bunch. */
export const DEFAULT_MISSED_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface PublicationGateInput {
  readonly brand: Pick<Brand, 'settings'>;
  readonly article: Article;
  readonly version: ArticleVersion | null;
  readonly checks: CheckReport | null;
  /** The brand profile's current factual hash; a mismatch makes the check report stale. */
  readonly currentFactsSha: string;
  readonly destination: Destination | null;
  readonly now: IsoInstant;
  readonly missedWindowMs?: number;
}

export type PublicationDecision =
  | { readonly decision: 'not_due' }
  | { readonly decision: 'skip'; readonly why: string }
  | { readonly decision: 'hold'; readonly hold: Omit<ArticleHold, 'at'> }
  | { readonly decision: 'publish'; readonly policy: PolicySnapshot };

export function approvalRequired(autoPublish: boolean, requiresApproval: boolean): boolean {
  return !autoPublish || requiresApproval;
}

/** True when the stored approval is for exactly the article's current immutable version. */
export function approvalIsCurrent(article: Article, version: ArticleVersion | null): boolean {
  return Boolean(
    version
    && article.approval
    && article.currentVersionId === version.id
    && article.approval.versionId === version.id
    && article.approval.contentSha === version.contentSha,
  );
}

export function checksAreCurrent(checks: CheckReport | null, version: ArticleVersion | null, currentFactsSha: string): boolean {
  return Boolean(
    checks && version
    && checks.versionId === version.id
    && checks.contentSha === version.contentSha
    && checks.factsSha === currentFactsSha,
  );
}

export function evaluatePublication(input: PublicationGateInput): PublicationDecision {
  const { article, version, checks, destination, brand } = input;
  const settings = brand.settings;
  if (article.delivery === 'published' && article.publishedVersionId === article.currentVersionId) {
    return { decision: 'skip', why: 'This exact version is already published.' };
  }
  if (article.delivery === 'publishing' || article.delivery === 'unknown') {
    return { decision: 'skip', why: 'A publication for this article is already in progress or awaiting reconciliation.' };
  }
  if (!article.schedule) return { decision: 'not_due' };
  if (article.hold) return { decision: 'skip', why: 'The article is held.' };
  const now = Date.parse(input.now);
  const due = Date.parse(article.schedule.publishAtUtc);
  if (!Number.isFinite(now) || !Number.isFinite(due)) {
    return { decision: 'hold', hold: { reason: 'owner', detail: 'The scheduled time could not be read. Choose a new time.' } };
  }
  if (due > now) return { decision: 'not_due' };

  // Late work is never replayed in a burst: hold and ask for a new time.
  if (now - due > (input.missedWindowMs ?? DEFAULT_MISSED_WINDOW_MS)) {
    return {
      decision: 'hold',
      hold: { reason: 'missed_window', detail: 'The scheduled time passed before this article could be published. Choose a new time.' },
    };
  }
  if (settings.pauseAll) {
    return { decision: 'hold', hold: { reason: 'paused', detail: 'All blog publishing was paused at the scheduled time. Choose a new time after resuming.' } };
  }
  if (!version || article.currentVersionId !== version.id) {
    return { decision: 'hold', hold: { reason: 'stale_version', detail: 'The current article version could not be confirmed.' } };
  }
  if (!checksAreCurrent(checks, version, input.currentFactsSha)) {
    return {
      decision: 'hold',
      hold: { reason: 'checks_failed', detail: 'Quality checks have not run on this exact version and the current brand facts. Run checks, then choose a new time.' },
    };
  }
  if (checks!.status === 'critical') {
    return { decision: 'hold', hold: { reason: 'checks_failed', detail: 'A critical quality or factual issue must be fixed before publication.' } };
  }
  if (!destination || destination.status !== 'connected' || destination.id !== article.schedule.destinationId) {
    return { decision: 'hold', hold: { reason: 'destination', detail: 'The website connection is not connected and verified.' } };
  }
  const needsApproval = approvalRequired(settings.autoPublish, article.requiresApproval);
  if (needsApproval && !approvalIsCurrent(article, version)) {
    return {
      decision: 'hold',
      hold: { reason: 'missing_approval', detail: 'This version was not approved before its scheduled time. Approve it and choose a new time.' },
    };
  }
  return {
    decision: 'publish',
    policy: {
      autoPublish: settings.autoPublish,
      requiresApproval: article.requiresApproval,
      approvedVersionId: approvalIsCurrent(article, version) ? version.id : null,
      rule: needsApproval ? 'approved' : 'auto_unflagged',
      decidedAt: input.now,
    },
  };
}

export type ArticleStatusLabel =
  | 'Researching' | 'Writing' | 'Draft' | 'Needs approval' | 'Approved' | 'Scheduled'
  | 'Publishing' | 'Published' | 'Held' | 'Failed' | 'Outcome unknown';

/** Owner-facing status. A diary slot never implies the website scheduled anything. */
export function articleStatusLabel(article: Article, settings: Pick<Brand['settings'], 'autoPublish'>): ArticleStatusLabel {
  if (article.delivery === 'published' && article.publishedVersionId === article.currentVersionId) return 'Published';
  if (article.delivery === 'publishing') return 'Publishing';
  if (article.delivery === 'unknown') return 'Outcome unknown';
  if (article.editorialState === 'researching') return 'Researching';
  if (article.editorialState === 'writing') return 'Writing';
  if (article.editorialState === 'failed' || article.delivery === 'failed') return 'Failed';
  if (article.hold) return 'Held';
  const needsApproval = approvalRequired(settings.autoPublish, article.requiresApproval);
  const approved = article.approval !== null && article.approval.versionId === article.currentVersionId;
  if (needsApproval && !approved) return 'Needs approval';
  if (article.schedule) return 'Scheduled';
  return approved ? 'Approved' : 'Draft';
}
