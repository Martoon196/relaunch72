import type {
  CompanyContentCatalogItem,
  CompanyContentCatalogPage,
} from '../company-content-pg/types.js';

const SOURCE = 'propertypredator.company-content';
const BRAND_SHA = 'b'.repeat(64);

function item(input: Readonly<{
  index: number;
  title: string;
  kind: CompanyContentCatalogItem['kind'];
  origin?: CompanyContentCatalogItem['origin'];
  sourceItemId: string;
  sourceVersion: string;
  approvalStatus: CompanyContentCatalogItem['approvalStatus'];
  approvalStale?: boolean;
  sourceFresh: boolean;
  publishable: boolean;
}>): CompanyContentCatalogItem {
  const suffix = String(input.index).padStart(12, '0');
  const approved = input.approvalStatus === 'approved' && !input.approvalStale;
  return Object.freeze({
    contentItemId: `81000000-0000-4000-8000-${suffix}`,
    contentVersionId: `82000000-0000-4000-8000-${suffix}`,
    versionNumber: Number(input.sourceVersion),
    origin: input.origin ?? 'imported',
    kind: input.kind,
    title: input.title,
    contentMimeType: input.kind === 'image' ? 'application/json' : 'text/markdown',
    source: Object.freeze({
      system: SOURCE,
      itemId: input.sourceItemId,
      version: input.sourceVersion,
    }),
    contentSha256: input.index.toString(16).padStart(64, '0'),
    blobSha256: (input.index + 10).toString(16).padStart(64, '0'),
    brandSha256: BRAND_SHA,
    approvalRequestId: input.approvalStatus === 'unrequested'
      ? null : `83000000-0000-4000-8000-${suffix}`,
    approvalDecisionId: ['unrequested', 'pending'].includes(input.approvalStatus)
      ? null : `84000000-0000-4000-8000-${suffix}`,
    approvalStatus: input.approvalStatus,
    approvalStale: input.approvalStale ?? false,
    sourceAttestationId: `85000000-0000-4000-8000-${suffix}`,
    sourceCheckedAt: input.sourceFresh
      ? '2026-08-26T08:38:00.000Z' : '2026-08-26T07:10:00.000Z',
    sourceExpiresAt: input.sourceFresh
      ? '2026-08-26T08:48:00.000Z' : '2026-08-26T07:20:00.000Z',
    sourceFresh: input.sourceFresh,
    publishable: input.publishable && approved && input.sourceFresh,
    createdAt: `2026-08-${String(20 + input.index).padStart(2, '0')}T12:00:00.000Z`,
  });
}

/** Fictional, hash-shaped preview data. It never reads Affiliate Stash or a provider. */
export function createPropertyPredatorContentCatalogFixture(): CompanyContentCatalogPage {
  return Object.freeze({
    items: Object.freeze([
      item({
        index: 1,
        title: 'The postcode is not the opportunity. The evidence is.',
        kind: 'social_post',
        sourceItemId: 'media:predator-evidence-post',
        sourceVersion: '3',
        approvalStatus: 'approved',
        sourceFresh: true,
        publishable: true,
      }),
      item({
        index: 2,
        title: 'Predator Briefing: mixed-use intelligence follow-up',
        kind: 'email',
        origin: 'generated',
        sourceItemId: 'generated:mixed-use-follow-up',
        sourceVersion: '1',
        approvalStatus: 'pending',
        sourceFresh: true,
        publishable: false,
      }),
      item({
        index: 3,
        title: 'Development appraisal evidence card',
        kind: 'image',
        sourceItemId: 'asset:appraisal-proof-card',
        sourceVersion: '4',
        approvalStatus: 'stale',
        approvalStale: true,
        sourceFresh: true,
        publishable: false,
      }),
      item({
        index: 4,
        title: 'Agency Growth Briefing replay sequence',
        kind: 'webinar',
        sourceItemId: 'media:agency-briefing-replay',
        sourceVersion: '2',
        approvalStatus: 'approved',
        sourceFresh: false,
        publishable: false,
      }),
      item({
        index: 5,
        title: 'Why comparables need context, not just a radius',
        kind: 'article',
        origin: 'edited',
        sourceItemId: 'media:comparables-context',
        sourceVersion: '5',
        approvalStatus: 'changes_requested',
        sourceFresh: true,
        publishable: false,
      }),
    ]),
    nextCursor: null,
  });
}
