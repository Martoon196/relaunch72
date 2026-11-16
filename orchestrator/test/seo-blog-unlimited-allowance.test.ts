/** An operator's "Unlimited" monthly allowance is stored as the largest safe number; pages must say Unlimited. */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER } from './seo-blog-fixtures.js';
import { BRAND_ID, call, identity, NOW, showcase } from './content-area-shell-fixtures.js';

const B = `/portal/seo-blog/b/${BRAND_ID}`;
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');

test('an "unlimited" monthly allowance reads Unlimited, never 9,007,199,254,740,991', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  try {
    const settings = { operatorLimits: { modelTokens: null, searchCalls: null, images: null, studioImages: null, configuredBy: OWNER.userId, configuredAt: NOW },
      budgets: { modelTokensPerMonth: Number.MAX_SAFE_INTEGER, searchCallsPerMonth: Number.MAX_SAFE_INTEGER, imagesPerMonth: Number.MAX_SAFE_INTEGER } };
    const r = await call(showcase('busy', settings).service, identity(), 'GET', `${B}/overview`);
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /9,007,199,254,740,991|9007199254740991/);
    assert.match(visible(r.body), /Writing left this month\s+Unlimited\s+No monthly limit on writing/);
    assert.match(visible(r.body), /37 used · Unlimited/);
    assert.match(visible(r.body), /Writing: There is no monthly limit on writing\./);
    assert.match(visible(r.body), /Research: 37 research attempts used · Unlimited/);
    assert.doesNotMatch(visible(r.body), /of Unlimited/);
  } finally { mock.timers.reset(); }
});
