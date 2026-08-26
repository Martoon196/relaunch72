import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPropertyPredatorSocialComposerFixture,
  PROPERTY_PREDATOR_SOCIAL_COMPOSER_AS_OF,
} from '../src/portal/social-composer-fixtures.js';
import {
  normaliseSocialComposerFilters,
  presentSocialComposer,
  SOCIAL_COMPOSER_MAX_ARTWORK,
  SOCIAL_COMPOSER_MAX_VARIANTS,
  SOCIAL_COMPOSER_ROUTE,
  type SocialComposerSnapshot,
} from '../src/portal/social-composer-presenter.js';
import { renderSocialComposerBody } from '../src/portal/social-composer-view.js';

const OPTIONS = Object.freeze({
  workspaceName: 'Property Predator Growth HQ',
  asOf: PROPERTY_PREDATOR_SOCIAL_COMPOSER_AS_OF,
});

function present(snapshot = createPropertyPredatorSocialComposerFixture(), filters: Readonly<{
  channel?: unknown;
  preview?: unknown;
}> = {}) {
  return presentSocialComposer(snapshot, { ...OPTIONS, filters });
}

test('Social Composer makes five native placements from one illustrative Affiliate Stash adapter payload', () => {
  const view = present();
  assert.equal(SOCIAL_COMPOSER_ROUTE, '/portal/content/compose');
  assert.equal(view.source.sourceSystem, 'propertypredator.company-content');
  assert.equal(view.source.sourceItemId, 'media:predator-evidence-post');
  assert.equal(view.source.versionNumber, 3);
  assert.equal(view.source.eligible, true);
  assert.deepEqual(view.variants.map((variant) => variant.channel), [
    'linkedin', 'instagram', 'facebook', 'x', 'email',
  ]);
  assert.ok(view.variants.every((variant) => variant.exactSourceVersion));
  assert.ok(view.variants.every((variant) => variant.readyForReview));
  assert.deepEqual(view.metrics, {
    variants: 5,
    reviewReady: 5,
    artworkSlots: 4,
    checksPassed: 25,
    checksTotal: 25,
  });
  assert.equal(view.commandBoundaryAvailable, false);
});

test('Social Composer selects channel and preview deterministically and carries exact UTMs', () => {
  const view = present(undefined, { channel: 'instagram', preview: 'desktop' });
  assert.equal(view.filters.channel, 'instagram');
  assert.equal(view.filters.preview, 'desktop');
  assert.equal(view.selected.channelLabel, 'Instagram');
  assert.equal(view.selected.artworkAspectRatio, '4:5');
  const tracking = new URL(view.selected.trackingUrl);
  assert.equal(tracking.searchParams.get('utm_source'), 'instagram');
  assert.equal(tracking.searchParams.get('utm_medium'), 'organic_social');
  assert.equal(tracking.searchParams.get('utm_campaign'), 'opportunity_autopsy_launch');
  assert.equal(tracking.searchParams.get('utm_content'), 'evidence_over_postcode_v3');
  assert.equal(view.association.offerLabel, 'Opportunity Autopsy');
  assert.equal(view.association.milestoneLabel, 'Evidence-first education');
});

test('Social Composer format checks understand X and email placement rules', () => {
  const view = present();
  const x = view.variants.find((variant) => variant.channel === 'x');
  const email = view.variants.find((variant) => variant.channel === 'email');
  assert.ok(x);
  assert.ok(email);
  assert.equal(x.characterLimit, 280);
  assert.ok(x.characterCount <= 256);
  assert.equal(x.checks.find((check) => check.key === 'x-link')?.passed, true);
  assert.equal(email.characterLimit, 10_000);
  assert.equal(email.checks.find((check) => check.key === 'email-envelope')?.passed, true);
  assert.match(email.checks.find((check) => check.key === 'email-envelope')?.detail ?? '', /Subject \d+\/60/);
});

test('Social Composer fails all derived placements closed when exact approval proof expires', () => {
  const fixture = createPropertyPredatorSocialComposerFixture();
  const snapshot: SocialComposerSnapshot = {
    ...fixture,
    catalogItem: {
      ...fixture.catalogItem,
      sourceExpiresAt: '2026-08-26T08:41:59.000Z',
      sourceFresh: true,
      publishable: true,
    },
  };
  const view = present(snapshot);
  assert.equal(view.source.eligible, false);
  assert.equal(view.source.sourceFreshnessLabel, 'Source proof expired');
  assert.equal(view.metrics.reviewReady, 0);
  assert.ok(view.variants.every((variant) => !variant.readyForReview));
  assert.ok(view.variants.every((variant) => variant.checks.find((check) => check.key === 'source')?.passed === false));
});

test('Social Composer fails one variant closed when its immutable version lineage differs', () => {
  const fixture = createPropertyPredatorSocialComposerFixture();
  const first = fixture.variants[0];
  assert.ok(first);
  const snapshot: SocialComposerSnapshot = {
    ...fixture,
    variants: [{ ...first, derivedFromContentSha256: 'f'.repeat(64) }, ...fixture.variants.slice(1)],
  };
  const view = present(snapshot);
  assert.equal(view.source.eligible, true);
  assert.equal(view.variants[0]?.exactSourceVersion, false);
  assert.equal(view.variants[0]?.readyForReview, false);
  assert.equal(view.metrics.reviewReady, 4);
});

test('Social Composer renders premium touch-responsive editing and preview without an outbound boundary', () => {
  const html = renderSocialComposerBody(present());
  assert.match(html, /<article class="scomp" aria-labelledby="scomp-title" data-provider-effects="none" data-command-boundary="absent">/);
  assert.match(html, /One truth\. <em>Five perfect cuts\.<\/em>/);
  assert.match(html, /Illustrative Affiliate Stash adapter contract/);
  assert.match(html, /fictional preview input, not content fetched from Affiliate Stash/);
  assert.match(html, /No AI generation, source adapter or asset copy runs here/);
  assert.match(html, /aria-label="Choose channel variant"/);
  assert.match(html, /aria-label="Illustrative Affiliate Stash adapter proof contract"/);
  assert.match(html, /Placeholder artwork slots/);
  assert.match(html, /aria-label="Channel format and safety checks"/);
  assert.match(html, /aria-label="Preview mode"/);
  assert.match(html, /<textarea class="scomp-textarea"/);
  assert.match(html, /Save TEST draft · unavailable/);
  assert.match(html, /Request review · unavailable/);
  assert.match(html, /disabled aria-disabled="true"/);
  assert.match(html, /No provider calls/);
  assert.match(html, /min-height:46px/);
  assert.match(html, /@media\(max-width:820px\)/);
  assert.match(html, /@media\(max-width:540px\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.doesNotMatch(html, /<form|method="post"|Publish now|Schedule now|Generate with AI|Connect provider/i);
  assert.equal((html.match(/providerToken|accessToken|apiKey|secretKey/g) ?? []).length, 0);
});

test('Social Composer escapes hostile copy, labels, artwork and workspace values', () => {
  const fixture = createPropertyPredatorSocialComposerFixture();
  const first = fixture.variants[0];
  const firstArtwork = fixture.artwork[0];
  assert.ok(first);
  assert.ok(firstArtwork);
  const hostile: SocialComposerSnapshot = {
    ...fixture,
    catalogItem: { ...fixture.catalogItem, title: '<img src=x onerror=alert(1)> A&B' },
    sourceCopy: { ...fixture.sourceCopy, body: '</textarea><script>alert(2)</script>' },
    variants: [{
      ...first,
      headline: '"><script>alert(3)</script>',
      body: '</textarea><img src=x onerror=alert(4)>',
      ctaLabel: '<CTA & Co>',
    }],
    artwork: [{
      ...firstArtwork,
      title: '"><script>alert(5)</script>',
      altText: '<img src=x onerror=alert(6)>',
    }],
    association: { ...fixture.association, offerLabel: '<Offer & Co>' },
  };
  const html = renderSocialComposerBody(presentSocialComposer(hostile, {
    ...OPTIONS,
    workspaceName: '<script>alert(7)</script>',
  }));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; A&amp;B/);
  assert.match(html, /&lt;\/textarea&gt;&lt;img src=x onerror=alert\(4\)&gt;/);
  assert.match(html, /&lt;Offer &amp; Co&gt;/);
  assert.match(html, /&lt;script&gt;alert\(7\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<(?:script|img)\b/i);
});

test('Social Composer bounds untrusted collections and normalises unknown navigation', () => {
  assert.deepEqual(normaliseSocialComposerFilters({
    channel: 'tiktok<script>', preview: 'provider<script>',
  }), { channel: 'linkedin', preview: 'mobile' });

  const fixture = createPropertyPredatorSocialComposerFixture();
  const first = fixture.variants[0];
  const firstArtwork = fixture.artwork[0];
  assert.ok(first);
  assert.ok(firstArtwork);
  const snapshot: SocialComposerSnapshot = {
    ...fixture,
    variants: Array.from({ length: SOCIAL_COMPOSER_MAX_VARIANTS + 5 }, (_, index) => ({
      ...first,
      variantId: `variant-${index}`,
    })),
    artwork: Array.from({ length: SOCIAL_COMPOSER_MAX_ARTWORK + 5 }, (_, index) => ({
      ...firstArtwork,
      assetId: `asset-${index}`,
    })),
  };
  const view = present(snapshot);
  assert.equal(view.variants.length, SOCIAL_COMPOSER_MAX_VARIANTS);
  assert.equal(view.artwork.length, SOCIAL_COMPOSER_MAX_ARTWORK);
  assert.equal(view.inputTruncated, true);
  assert.match(renderSocialComposerBody(view), /Bounded safety limits were applied/);
});
