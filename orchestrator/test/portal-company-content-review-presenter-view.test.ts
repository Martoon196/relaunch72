import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import {
  CompanyContentReviewPresentationError,
  presentCompanyContentReview,
} from '../src/portal/company-content-review-presenter.js';
import type { PortalCompanyContentReviewSnapshot } from '../src/portal/company-content-review-service.js';
import { renderCompanyContentReviewBody } from '../src/portal/company-content-review-view.js';

const RELEASE_ITEM_ID = 'a7100000-0000-4000-8000-000000000001';
const SOURCE_RELEASE_ID = 'a7200000-0000-4000-8000-000000000001';
const SOURCE_VERSION_ID = 'a7300000-0000-4000-8000-000000000001';
const APPROVAL_ID = 'a7400000-0000-4000-8000-000000000001';
const BRAND_SHA256 = 'c'.repeat(64);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function generatedSnapshot(
  body = 'Stop guessing at property numbers.\n\nRun the deal through a repeatable evidence trail.',
): PortalCompanyContentReviewSnapshot {
  const sourcePayload = {
    body,
    cta_url: 'https://propertypredator.co.uk/analyse',
    kind: 'post',
    platform: 'linkedin',
    schema: 'propertypredator.company-content/v1',
    title: 'The evidence-first property check',
    type: 'generated',
  };
  const canonicalContent = canonicalCompanyContentJson(sourcePayload);
  const snapshot: PortalCompanyContentReviewSnapshot = {
    workspace: Object.freeze({
      workspaceId: 'a7000000-0000-4000-8000-000000000001',
      workspaceName: 'Property Predator Growth HQ',
      snapshotAt: '2026-08-28T12:00:00.000Z',
      canManage: true,
    }),
    item: Object.freeze({
      releaseItemId: RELEASE_ITEM_ID,
      sourceReleaseId: SOURCE_RELEASE_ID,
      itemType: 'generated',
      itemId: 'generated:linkedin-evidence-check',
      itemVersion: 3,
      sourceVersionId: SOURCE_VERSION_ID,
      contentSha256: sha256(canonicalContent),
      blobSha256: null,
      brandSha256: BRAND_SHA256,
      sourceApproval: Object.freeze({
        approvalId: APPROVAL_ID,
        approvedAt: '2026-08-27T15:30:00.000Z',
        meaning: 'source_provenance_only',
        expiresAt: null,
      }),
      hqUseStatus: 'review_required',
      decisions: Object.freeze([{
        dimension: 'visual_policy',
        outcome: 'clear',
        reasonCode: 'visual_policy_match',
        evidenceSha256: sha256(canonicalContent),
        recordedAt: '2026-08-28T10:00:00.000Z',
      } as const]),
      pendingDimensions: Object.freeze(['claim', 'asset'] as const),
      quarantined: false,
    }),
    exactContent: Object.freeze({
      mediaType: 'application/json',
      canonicalContent,
      payload: Object.freeze({
        title: sourcePayload.title,
        body: sourcePayload.body,
        kind: sourcePayload.kind,
        platform: sourcePayload.platform,
        ctaUrl: sourcePayload.cta_url,
      }),
      verified: true,
    }),
    artwork: null,
    safety: Object.freeze({
      providerEffects: false,
      customerPrivateDataAccepted: false,
      affiliateContentAccepted: false,
      sourceApprovalPromotedToHqApproval: false,
    }),
  };
  return Object.freeze(snapshot);
}

function assetSnapshot(): PortalCompanyContentReviewSnapshot {
  const blobSha256 = 'b'.repeat(64);
  const snapshot: PortalCompanyContentReviewSnapshot = {
    workspace: Object.freeze({
      workspaceId: 'a7000000-0000-4000-8000-000000000001',
      workspaceName: 'Property Predator Growth HQ',
      snapshotAt: '2026-08-28T12:00:00.000Z',
      canManage: true,
    }),
    item: Object.freeze({
      releaseItemId: RELEASE_ITEM_ID,
      sourceReleaseId: SOURCE_RELEASE_ID,
      itemType: 'asset',
      itemId: 'asset:deal-evidence-cover',
      itemVersion: 2,
      sourceVersionId: SOURCE_VERSION_ID,
      contentSha256: 'a'.repeat(64),
      blobSha256,
      brandSha256: BRAND_SHA256,
      sourceApproval: Object.freeze({
        approvalId: APPROVAL_ID,
        approvedAt: '2026-08-27T15:30:00.000Z',
        meaning: 'source_provenance_only',
        expiresAt: null,
      }),
      hqUseStatus: 'review_required',
      decisions: Object.freeze([
        {
          dimension: 'visual_policy', outcome: 'clear', reasonCode: 'visual_policy_match',
          evidenceSha256: '1'.repeat(64), recordedAt: '2026-08-28T10:00:00.000Z',
        } as const,
        {
          dimension: 'claim', outcome: 'clear', reasonCode: 'no_claims_present',
          evidenceSha256: '2'.repeat(64), recordedAt: '2026-08-28T10:01:00.000Z',
        } as const,
        {
          dimension: 'asset', outcome: 'clear', reasonCode: 'asset_integrity_verified',
          evidenceSha256: '3'.repeat(64), recordedAt: '2026-08-28T10:02:00.000Z',
        } as const,
      ]),
      pendingDimensions: Object.freeze([]),
      quarantined: false,
    }),
    exactContent: Object.freeze({
      mediaType: 'application/json',
      canonicalContent: null,
      payload: Object.freeze({
        title: 'Deal evidence cover',
        caption: 'Property decisions deserve a visible evidence trail.',
        category: 'campaign',
        mediaType: 'image/png',
        bytes: 246_810,
      }),
      verified: true,
    }),
    artwork: Object.freeze({
      mediaType: 'image/png',
      expectedByteLength: 246_810,
      blobSha256,
      fileHref: `/portal/content/assets/review/${RELEASE_ITEM_ID}/file`,
      verification: 'verified_at_response_boundary',
    }),
    safety: Object.freeze({
      providerEffects: false,
      customerPrivateDataAccepted: false,
      affiliateContentAccepted: false,
      sourceApprovalPromotedToHqApproval: false,
    }),
  };
  return Object.freeze(snapshot);
}

test('exact-content review presents readable copy, canonical proof and honest blocked state', () => {
  const snapshot = generatedSnapshot();
  const view = presentCompanyContentReview(snapshot);
  assert.equal(view.exactContent.readableBody, snapshot.exactContent.payload.body);
  assert.equal(view.exactContent.canonicalContent, snapshot.exactContent.canonicalContent);
  assert.equal(view.exactContent.canonicalByteLength, Buffer.byteLength(
    snapshot.exactContent.canonicalContent!,
    'utf8',
  ));
  assert.equal(view.item.state, 'pending');
  assert.equal(view.item.hqUseLabel, 'Review required');
  assert.deepEqual(
    view.item.pendingDimensions.map((entry) => entry.dimension),
    ['claim', 'asset'],
  );
  assert.equal('payload' in view.exactContent, false);

  const html = renderCompanyContentReviewBody(view);
  assert.match(html, /Property Predator · Growth HQ/);
  assert.match(html, /Actual reviewed copy/);
  assert.match(html, /Stop guessing at property numbers/);
  assert.match(html, /Call-to-action destination · shown as evidence only/);
  assert.match(html, /Canonical JSON hash evidence/);
  assert.match(html, /Source provenance ≠ HQ approval/);
  assert.match(html, /Not Growth HQ approval/);
  assert.match(html, /Claims · pending/);
  assert.match(html, /Asset integrity · pending/);
  assert.match(html, new RegExp(snapshot.item.contentSha256));
  assert.match(html, /href="\/portal\/content\/assets"/);
  assert.doesNotMatch(html, /<form\b|<button\b|method="post"|name="outcome"/i);
});

test('review HTML escapes hostile exact copy and hostile presentation labels', () => {
  const hostileBody = '</code><script>globalThis.owned=true</script>\n<img src=x onerror=alert(1)>&"';
  const hostileTitle = '<iframe srcdoc="hostile">Title</iframe>';
  const base = generatedSnapshot(hostileBody);
  const canonicalContent = canonicalCompanyContentJson({
    body: hostileBody,
    cta_url: base.exactContent.payload.ctaUrl,
    kind: base.exactContent.payload.kind,
    platform: base.exactContent.payload.platform,
    schema: 'propertypredator.company-content/v1',
    title: hostileTitle,
    type: 'generated',
  });
  const poisoned = {
    ...base,
    workspace: { ...base.workspace, workspaceName: '<svg onload=alert(2)>Growth HQ</svg>' },
    item: { ...base.item, contentSha256: sha256(canonicalContent) },
    exactContent: {
      ...base.exactContent,
      canonicalContent,
      payload: {
        ...base.exactContent.payload,
        title: hostileTitle,
      },
    },
  } as PortalCompanyContentReviewSnapshot;
  const html = renderCompanyContentReviewBody(presentCompanyContentReview(poisoned));

  assert.doesNotMatch(html, /<script>|<img src=x|<svg onload|<iframe srcdoc/i);
  assert.match(html, /&lt;script&gt;globalThis\.owned=true&lt;\/script&gt;/);
  assert.match(html, /&lt;svg onload=alert\(2\)&gt;Growth HQ&lt;\/svg&gt;/);
  assert.match(html, /&lt;iframe srcdoc=&quot;hostile&quot;&gt;Title&lt;\/iframe&gt;/);
});

test('presenter drops unrecognised source/private fields and rejects payload expansion', () => {
  const base = generatedSnapshot();
  const poisoned = {
    ...base,
    sourcePath: 'DO-NOT-RENDER-SOURCE-PATH',
    storageKey: 'DO-NOT-RENDER-STORAGE-KEY',
    readToken: 'DO-NOT-RENDER-SECRET',
    workspace: { ...base.workspace, databaseUrl: 'DO-NOT-RENDER-DATABASE' },
    item: { ...base.item, rawSourceEnvelope: 'DO-NOT-RENDER-ENVELOPE' },
  } as unknown as PortalCompanyContentReviewSnapshot;
  const view = presentCompanyContentReview(poisoned);
  const rendered = `${JSON.stringify(view)}${renderCompanyContentReviewBody(view)}`;
  assert.doesNotMatch(rendered, /DO-NOT-RENDER|databaseUrl|rawSourceEnvelope/);

  assert.throws(() => presentCompanyContentReview({
    ...base,
    exactContent: {
      ...base.exactContent,
      payload: { ...base.exactContent.payload, storageKey: 'private/source/file.json' },
    },
  } as unknown as PortalCompanyContentReviewSnapshot), /review allowlist/);
});

test('presenter enforces canonical hash, payload and response-size bounds without effects', () => {
  const base = generatedSnapshot();
  assert.throws(() => presentCompanyContentReview({
    ...base,
    item: { ...base.item, contentSha256: 'f'.repeat(64) },
  }), /does not match its SHA-256/);
  const oversizedCanonical = 'x'.repeat(128 * 1024 + 1);
  assert.throws(() => presentCompanyContentReview({
    ...base,
    item: { ...base.item, contentSha256: sha256(oversizedCanonical) },
    exactContent: { ...base.exactContent, canonicalContent: oversizedCanonical },
  }), /exceeds the exact review bound/);
  assert.throws(() => presentCompanyContentReview({
    ...base,
    safety: { ...base.safety, providerEffects: true },
  } as unknown as PortalCompanyContentReviewSnapshot), CompanyContentReviewPresentationError);
  assert.throws(() => presentCompanyContentReview({
    ...base,
    item: { ...base.item, pendingDimensions: ['claim'] },
  } as unknown as PortalCompanyContentReviewSnapshot), /do not cover the exact item/);

  assert.throws(() => presentCompanyContentReview({
    ...base,
    exactContent: {
      ...base.exactContent,
      payload: {
        ...base.exactContent.payload,
        body: 'Different visible copy that is not covered by the canonical digest.',
      },
    },
  } as unknown as PortalCompanyContentReviewSnapshot), /does not match canonical content/);
});

test('asset review exposes only a verified exact image response and omits filename/path payloads', () => {
  const snapshot = assetSnapshot();
  const view = presentCompanyContentReview(snapshot);
  assert.equal(view.exactContent.canonicalContent, null);
  assert.equal(view.exactContent.readableBody, null);
  assert.equal(view.artwork?.fileHref, `/portal/content/assets/review/${RELEASE_ITEM_ID}/file`);
  assert.equal(view.item.state, 'evidence_complete');
  assert.match(view.item.whyBlocked, /source provenance is not Growth HQ approval/i);

  const html = renderCompanyContentReviewBody(view);
  assert.match(html, /Verified artwork preview/);
  assert.match(html, new RegExp(`<img src="/portal/content/assets/review/${RELEASE_ITEM_ID}/file"`));
  assert.match(html, /Text metadata that could disclose a file name is deliberately not reproduced/);
  assert.doesNotMatch(html, /filename|assetFilePath|storageKey|<form\b|<button\b/i);

  assert.throws(() => presentCompanyContentReview({
    ...snapshot,
    artwork: { ...snapshot.artwork!, fileHref: '/portal/content/assets/review/another/file' },
  }), /escaped its exact item boundary/);
  assert.throws(() => presentCompanyContentReview({
    ...snapshot,
    exactContent: {
      ...snapshot.exactContent,
      payload: { ...snapshot.exactContent.payload, filename: 'private-artwork.png' },
    },
  } as unknown as PortalCompanyContentReviewSnapshot), /review allowlist/);
});
