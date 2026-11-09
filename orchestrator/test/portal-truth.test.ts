import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardPage } from '../src/portal/views.js';
import type { DashboardData } from '../src/portal/data.js';

test('dashboard labels generated artifacts as drafts and mock metrics as simulated', () => {
  const data: DashboardData = {
    tenant: { id: 't1', name: 'Truthful Co', createdAt: '2026-08-23T00:00:00Z' },
    contacts: [],
    pipeline: { lead: 0, contacted: 0, qualified: 0, won: 0, lost: 0 },
    activity: [],
    artifacts: {
      cluster: {
        topic: 'truthful marketing',
        articles: [
          { title: 'A pillar brief', intent: 'informational', role: 'pillar' },
          { title: 'A supporting brief', intent: 'commercial', role: 'supporting' },
        ],
      },
      keywords: [{ query: 'truthful marketing', volume: 1234 }],
      post: { platform: 'LinkedIn', hook: 'Draft hook', body: 'Draft body' },
      ad: { headlines: ['Draft headline'], primary: 'Draft copy', cta: 'Learn more' },
    },
  };

  const html = dashboardPage(data);
  assert.match(html, />2<\/div><div class="l">article briefs drafted/);
  assert.match(html, />1<\/div><div class="l">social draft samples/);
  assert.match(html, />1<\/div><div class="l">ad-set drafts \(paused\)/);
  assert.match(html, /Simulated keyword estimates/);
  assert.match(html, /not live search volumes/);
  assert.match(html, /not published/);
  assert.doesNotMatch(html, /posts scheduled|articles written|ranked by search volume/i);
  assert.doesNotMatch(html, />30<\/div><div class="l">social/i);
});
