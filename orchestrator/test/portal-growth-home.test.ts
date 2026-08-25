import assert from 'node:assert/strict';
import test from 'node:test';
import { renderGrowthHomeBody } from '../src/portal/growth-home.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import type { CrmWorkspaceSnapshot } from '../src/portal/crm-views.js';

function snapshot(): CrmWorkspaceSnapshot {
  return {
    workspace: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Predator Partners <North>',
      timezone: 'Europe/London',
      snapshotAt: '2026-08-25T12:00:00.000Z',
      canWrite: true,
    },
    contacts: [
      { id: 'c1', displayName: 'Avery & Co', lifecycle: 'lead', openOpportunityCount: 1, createdAt: '2026-08-20T09:00:00.000Z' },
      { id: 'c2', displayName: 'Paid customer', lifecycle: 'customer', openOpportunityCount: 0, createdAt: '2026-08-21T09:00:00.000Z' },
    ],
    stages: [
      { id: 's1', name: 'New <lead>', position: 1, isClosed: false },
      { id: 's2', name: 'Won', position: 2, isClosed: true },
    ],
    opportunities: [
      {
        id: 'o1', contactId: 'c1', contactName: 'Avery & Co', title: 'Apex annual', stageId: 's1',
        valueMinor: 125_000, currency: 'GBP', updatedAt: '2026-08-24T10:00:00.000Z', rowVersion: 1,
        moveCommandKey: 'move-1',
      },
    ],
    tasks: [
      {
        id: 't1', title: 'Call <Avery>', status: 'open', contactName: 'Avery & Co',
        dueAt: '2026-08-24T09:00:00.000Z', rowVersion: 1, completeCommandKey: 'task-1',
      },
    ],
    timeline: [],
  };
}

test('Growth HQ renders only saved CRM counts, value and priority facts', () => {
  const html = renderGrowthHomeBody(snapshot(), PROPERTY_PREDATOR_GROWTH_PROFILE);
  assert.match(html, /<small>Leads<\/small><strong>1<\/strong>/);
  assert.match(html, /<small>Open opportunities<\/small><strong>1<\/strong>/);
  assert.match(html, /£1,250/);
  assert.match(html, /Potential value, not collected revenue/);
  assert.match(html, /<small>Needs attention<\/small><strong>1<\/strong>/);
  assert.match(html, /Call &lt;Avery&gt;/);
  assert.doesNotMatch(html, /Call <Avery>/);
  assert.match(html, /Predator Partners &lt;North&gt;/);
});

test('Growth HQ distinguishes self-serve conversion from literal agency LAPS', () => {
  const html = renderGrowthHomeBody(snapshot(), PROPERTY_PREDATOR_GROWTH_PROFILE);
  assert.match(html, /Self-serve conversion/);
  assert.match(html, /Lead<\/span><span class="milestone">Activated/);
  assert.match(html, /Agency LAPS/);
  assert.match(html, /Appointment/);
  assert.match(html, /Presentation/);
  assert.match(html, /Profile blueprints · live milestone facts come next/);
});

test('Growth HQ empty state invents no activity or provider readiness', () => {
  const empty = snapshot();
  empty.contacts = [];
  empty.opportunities = [];
  empty.tasks = [];
  const html = renderGrowthHomeBody(empty, PROPERTY_PREDATOR_GROWTH_PROFILE);
  assert.match(html, /No urgent work is recorded/);
  assert.match(html, /Not connected/);
  assert.match(html, /Growth HQ channels are not connected/);
  assert.doesNotMatch(html, /href="[^"]+">Social machine/);
  assert.doesNotMatch(html, /revenue generated|messages sent|posts published/i);
});

test('Growth HQ attention queue excludes opportunities in closed stages', () => {
  const closed = snapshot();
  closed.tasks = [];
  closed.opportunities = [{
    id: 'o2', contactId: 'c2', contactName: 'Paid customer', title: 'Completed sale', stageId: 's2',
    valueMinor: 250_000, currency: 'GBP', updatedAt: '2026-08-25T10:00:00.000Z', rowVersion: 1,
    moveCommandKey: 'move-2',
  }];
  const html = renderGrowthHomeBody(closed, PROPERTY_PREDATOR_GROWTH_PROFILE);
  assert.match(html, /No urgent work is recorded/);
  assert.doesNotMatch(html, /Completed sale/);
  assert.doesNotMatch(html, /No task/);
});
