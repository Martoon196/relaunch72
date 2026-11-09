import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createPropertyPredatorCompanyAssetsReviewPreviewFixture,
  createPropertyPredatorCompanyContentReviewFixture,
  createPropertyPredatorCompanyContentReviewHrefs,
  PROPERTY_PREDATOR_REVIEW_FIXTURE_RELEASE_ITEM_ID,
} from '../src/portal/company-content-review-fixtures.js';
import { presentCompanyAssets } from '../src/portal/company-assets-presenter.js';
import { presentCompanyContentReview } from '../src/portal/company-content-review-presenter.js';
import { renderCompanyContentReviewBody } from '../src/portal/company-content-review-view.js';

test('fictional review fixture keeps canonical copy and Company Assets metadata exact', () => {
  const review = createPropertyPredatorCompanyContentReviewFixture();
  const assets = createPropertyPredatorCompanyAssetsReviewPreviewFixture();
  const matchingAsset = assets.itemPage.items.find(
    (item) => item.releaseItemId === PROPERTY_PREDATOR_REVIEW_FIXTURE_RELEASE_ITEM_ID,
  );

  assert.ok(matchingAsset);
  assert.equal(
    createHash('sha256').update(review.exactContent.canonicalContent!, 'utf8').digest('hex'),
    review.item.contentSha256,
  );
  const canonicalPayload = JSON.parse(review.exactContent.canonicalContent!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(canonicalPayload).sort(), [
    'active', 'body', 'category', 'kind', 'schema', 'title', 'type',
  ]);
  assert.equal(canonicalPayload.active, true);
  assert.equal(matchingAsset.itemId, review.item.itemId);
  assert.equal(matchingAsset.versionId, review.item.sourceVersionId);
  assert.equal(matchingAsset.itemVersion, review.item.itemVersion);
  assert.equal(matchingAsset.contentSha256, review.item.contentSha256);
  assert.equal(matchingAsset.approvalId, review.item.sourceApproval.approvalId);
  assert.deepEqual(matchingAsset.decisions, review.item.decisions);

  const assetView = presentCompanyAssets(assets);
  assert.equal(assetView.metrics.quarantinedItems, 0);
  assert.equal(assetView.release?.quarantined, false);
  assert.equal(assetView.release?.quarantineDecisionComplete, false);
  assert.equal(assetView.release?.founderApproved, false);
  assert.equal(assetView.release?.latestUsable, false);
  assert.deepEqual(assetView.release?.latestGuardReasonCodes, ['quarantine_decision_missing']);
});

test('fictional review renders readable copy with no writable or provider surface', () => {
  const review = createPropertyPredatorCompanyContentReviewFixture();
  const html = renderCompanyContentReviewBody(presentCompanyContentReview(review));
  const hrefs = createPropertyPredatorCompanyContentReviewHrefs();

  assert.match(html, /Most property decisions feel urgent/u);
  assert.match(html, /Provider effects off/u);
  assert.doesNotMatch(html, /<form|method="post"|type="submit"/iu);
  assert.equal(
    hrefs[PROPERTY_PREDATOR_REVIEW_FIXTURE_RELEASE_ITEM_ID],
    `/portal/content/assets/review/${PROPERTY_PREDATOR_REVIEW_FIXTURE_RELEASE_ITEM_ID}`,
  );
});
