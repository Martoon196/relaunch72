import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMhpCrmBody } from '../src/mhp/crm-view.js';

test('MHP pipeline has readable type and direct actions for the owner pilot', () => {
  const html = renderMhpCrmBody('<div class="crm-page" data-crm-page="pipeline">Saved opportunity</div>', 'pipeline', true);
  assert.match(html, /href="\/portal\/crm\/contacts">Investors<\/a>/);
  assert.match(html, /href="\/portal\/crm\/opportunities" aria-current="page">Pipeline<\/a>/);
  assert.match(html, /href="\/portal\/crm\/tasks">Follow-ups<\/a>/);
  assert.match(html, /href="\/portal\/investors\/email">Conversations<\/a>/);
  assert.match(html, /\.mhp-crm \.crm-opportunity h3[^}]*font-size:18px/);
  assert.match(html, /\.mhp-crm \.crm-move-field select[^}]*font-size:15px;min-height:44px/);
  assert.match(html, /Saved opportunity/);
});

test('MHP navigation marks only the current CRM section', () => {
  const html = renderMhpCrmBody('Follow-up records', 'tasks');
  assert.equal((html.match(/<a [^>]*aria-current="page"/g) ?? []).length, 1);
  assert.match(html, /href="\/portal\/crm\/tasks" aria-current="page">Follow-ups<\/a>/);
});

test('Conversations is hidden when the member has no email entitlement', () => {
  const html = renderMhpCrmBody('Saved contacts', 'contacts');
  assert.doesNotMatch(html, /href="\/portal\/investors\/email"/);
});
