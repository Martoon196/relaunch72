import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMhpContactBody } from '../src/mhp/contact-view.js';
import type { Lead360View } from '../src/portal/lead-360-view.js';

const contact: Lead360View = {
  identity: { contactId: 'f2e4b537-c7bb-4f5a-b09c-96cdb1a51b1d', displayName: 'Martin <Test>', companyName: 'Example Co', primaryEmail: 'martin@example.test', primaryPhone: null, ownerName: 'Martin' },
  score: null, scoreExplanation: null, journey: { label: 'None', stages: [] }, evidence: [], nextMove: null, offers: [], consent: [], suppressionReason: null,
  crm: { opportunities: [{ id: '00000000-0000-4000-8000-000000000001', title: 'TEST — email and reply', stageLabel: 'New enquiry', state: 'open', valueLabel: null }],
    tasks: [{ id: '00000000-0000-4000-8000-000000000002', title: 'Follow up', state: 'open', dueAt: '2026-10-30T12:00:00Z' }] },
  asOf: '2026-10-29T11:46:00Z',
};

test('MHP contact gives the owner a readable opportunity and email path without PP case-file controls', () => {
  const html = renderMhpContactBody(contact);
  assert.match(html, /font:400 17px\/1\.6/);
  assert.match(html, /Open pipeline/);
  assert.match(html, /TEST — email and reply/);
  assert.match(html, /href="\/portal\/investors\/email"/);
  assert.match(html, /href="\/portal\/investors\?contact=f2e4b537-c7bb-4f5a-b09c-96cdb1a51b1d"/);
  assert.match(html, /Martin &lt;Test&gt;/);
  assert.doesNotMatch(html, /#0b0d0e|Prepare approved email|Mailgun/);
});

test('MHP contact keeps empty opportunities and tasks clear', () => {
  const html = renderMhpContactBody({ ...contact, crm: { opportunities: [], tasks: [] } });
  assert.match(html, /No opportunity has been recorded/);
  assert.match(html, /No follow-up has been recorded/);
  assert.match(html, /View and move opportunities/);
});
