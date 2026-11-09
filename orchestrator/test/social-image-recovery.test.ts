import test from 'node:test';
import assert from 'node:assert/strict';
import { socialImageCreationPaused } from '../src/portal/social-image-recovery.js';
import { PgPortalCompanyContentService } from '../src/portal/company-content-pg-service.js';

test('image recovery pause is explicit and leaves normal operation unchanged', () => {
  assert.equal(socialImageCreationPaused({}), false);
  assert.equal(socialImageCreationPaused({PROPERTY_PREDATOR_POST_IMAGE_CREATION_PAUSED:' TRUE '}), true);
  assert.equal(socialImageCreationPaused({PROPERTY_PREDATOR_POST_IMAGE_CREATION_PAUSED:'false'}), false);
});

test('recovery pause rejects an image write before reaching persistence', async () => {
  const previous = process.env.PROPERTY_PREDATOR_POST_IMAGE_CREATION_PAUSED;
  process.env.PROPERTY_PREDATOR_POST_IMAGE_CREATION_PAUSED = 'true';
  try {
    const service = new PgPortalCompanyContentService({} as never);
    const result = await service.createSocialRevision({} as never, {imageDataUrl:'image'} as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'unavailable');
  } finally {
    if (previous === undefined) delete process.env.PROPERTY_PREDATOR_POST_IMAGE_CREATION_PAUSED;
    else process.env.PROPERTY_PREDATOR_POST_IMAGE_CREATION_PAUSED = previous;
  }
});
