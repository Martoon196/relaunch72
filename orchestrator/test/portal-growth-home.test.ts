import assert from 'node:assert/strict';
import test from 'node:test';
import { renderGrowthHomeBody } from '../src/portal/growth-home.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import type { CrmWorkspaceSnapshot } from '../src/portal/crm-views.js';
import type { GrowthIntelligenceView } from '../src/portal/growth-intelligence.js';

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

function growth(): GrowthIntelligenceView {
  return {
    dataState: 'preview',
    asOf: '2026-08-25T12:00:00.000Z',
    windowLabel: 'Last 30 days',
    funnels: [
      {
        track: 'self_serve', label: 'Self-serve conversion',
        description: 'Captured identity to first weapon, priced intent and paid sale.',
        stages: [
          { key: 'lead', label: 'Lead', count: 5, stepConversionPercent: null, movedInWindow: 2 },
          { key: 'activated', label: 'Activated', count: 3, stepConversionPercent: null, movedInWindow: 2 },
          { key: 'priced', label: 'Priced', count: 2, stepConversionPercent: null, movedInWindow: 1 },
          { key: 'sale', label: 'Sale', count: 1, stepConversionPercent: null, movedInWindow: 1 },
        ],
      },
      {
        track: 'agency', label: 'Agency LAPS',
        description: 'Named agency lead to appointment, presentation and collected sale.',
        stages: [
          { key: 'lead', label: 'Lead', count: 2, stepConversionPercent: null, movedInWindow: 1 },
          { key: 'appointment', label: 'Appointment', count: 1, stepConversionPercent: null, movedInWindow: 1 },
          { key: 'presentation', label: 'Presentation', count: 1, stepConversionPercent: null, movedInWindow: 1 },
          { key: 'sale', label: 'Sale', count: 1, stepConversionPercent: null, movedInWindow: 1 },
        ],
      },
    ],
    hotLeads: [{
      contactId: '11111111-1111-4111-8111-111111111111', displayName: 'Avery <North>', companyName: 'Avery & Co',
      track: 'self_serve', stage: 'Priced', score: 76, band: 'burning',
      lastEvidence: {
        kind: 'watched', label: 'Predator Briefing <Replay>', detail: '92% complete',
        occurredAt: '2026-08-25T10:15:00.000Z',
      },
      contentSummary: 'Predator Briefing · 92%', offerSummary: 'Apex annual · shown',
      nextMove: 'Call while the offer is fresh.',
    }],
    evidenceTotals: { contentStarted: 8, contentCompleted: 4, offersShown: 3, replies: 2, appointments: 1 },
  };
}

test('Growth HQ separates measured journey evidence from saved CRM facts', () => {
  const html = renderGrowthHomeBody(snapshot(), PROPERTY_PREDATOR_GROWTH_PROFILE, growth());
  assert.match(html, /<small>Route leads<\/small><strong>7<\/strong>/);
  assert.match(html, /Distinct within each journey · routes may overlap/);
  assert.match(html, /<small>Activated<\/small><strong>3<\/strong>/);
  assert.match(html, /Distinct self-serve contacts with recorded activation evidence/);
  assert.match(html, /Distinct people/);
  assert.match(html, /Last 30 days <strong>\+2<\/strong>/);
  assert.doesNotMatch(html, /Activation rate|>Step </);
  assert.match(html, /<small>Priced \/ presented<\/small><strong>3<\/strong>/);
  assert.match(html, /<small>Sales<\/small><strong>2<\/strong>/);
  assert.match(html, /<small>CRM leads loaded<\/small><strong>1<\/strong>/);
  assert.match(html, /bounded overview snapshot · not a workspace total/);
  assert.match(html, /Demo evidence/);
  assert.match(html, /Call &lt;Avery&gt;/);
  assert.doesNotMatch(html, /Call <Avery>/);
  assert.match(html, /Avery &lt;North&gt;/);
  assert.match(html, /Predator Briefing &lt;Replay&gt;/);
  assert.doesNotMatch(html, /Predator Briefing <Replay>/);
});

test('Growth HQ advertises the Action Centre only when its route is mounted', () => {
  const unavailable = renderGrowthHomeBody(snapshot(), PROPERTY_PREDATOR_GROWTH_PROFILE, growth());
  assert.doesNotMatch(unavailable, /href="\/portal\/actions"/);
  assert.doesNotMatch(unavailable, /Open Action Centre|Action Centre →/);
  assert.match(unavailable, /href="#hot-list">Work the hot list/);
  assert.match(unavailable, /href="\/portal\/crm\/contacts">Open CRM/);
  assert.match(unavailable, /href="\/portal\/crm\/tasks">Tasks →/);

  const available = renderGrowthHomeBody(snapshot(), PROPERTY_PREDATOR_GROWTH_PROFILE, growth(), {
    actionCentreAvailable: true,
  });
  assert.equal((available.match(/href="\/portal\/actions"/g) ?? []).length, 2);
  assert.match(available, /Open Action Centre/);
  assert.match(available, /Action Centre →/);
  assert.doesNotMatch(available, /href="\/portal\/crm\/tasks">Tasks →/);
});

test('Growth HQ treats sparse direct-entry stages as evidence, not upcoming or cohort conversion', () => {
  const base = growth();
  const selfServe = base.funnels[0]!;
  const sparse: GrowthIntelligenceView = {
    ...base,
    dataState: 'live',
    funnels: [{
      ...selfServe,
      stages: selfServe.stages.map((stage) => stage.key === 'lead'
        ? { ...stage, count: 0, movedInWindow: 0 }
        : stage),
    }, base.funnels[1]!],
  };
  const html = renderGrowthHomeBody(snapshot(), PROPERTY_PREDATOR_GROWTH_PROFILE, sparse);

  assert.doesNotMatch(html, /No journey evidence is recorded yet/);
  assert.match(
    html,
    /pp-stage-label">Lead<\/span>[\s\S]*?pp-stage-count">0<\/strong>[\s\S]*?No evidence[\s\S]*?pp-stage-label">Activated<\/span>[\s\S]*?pp-stage-count">3<\/strong>[\s\S]*?Distinct people/,
  );
  assert.doesNotMatch(html, /upcoming|Activation rate|>Step /i);
});

test('Growth HQ distinguishes self-serve conversion from literal agency LAPS', () => {
  const html = renderGrowthHomeBody(snapshot(), PROPERTY_PREDATOR_GROWTH_PROFILE, growth());
  assert.match(html, /Self-serve conversion/);
  assert.match(html, /pp-stage-label">Lead<\/span>[\s\S]*pp-stage-label">Activated<\/span>/);
  assert.match(html, /Agency LAPS/);
  assert.match(html, /Appointment/);
  assert.match(html, /Presentation/);
  assert.match(html, /Two routes\. No fake stages\./);
  assert.match(html, /Sale requires collected payment/);
  assert.match(html, /Journey runtime/);
  assert.match(html, /pp-rail-state ready">Foundation/);
  assert.match(html, /Affiliate Stash content machine[\s\S]{0,200}pp-rail-state ready">Foundation/);
  assert.match(html, /Growth HQ will orchestrate reviewed items instead of rebuilding it/);
  assert.doesNotMatch(html, /href="https:\/\/propertypredator\.com\/affiliate"/);
});

test('Growth HQ empty state invents no activity or provider readiness', () => {
  const empty = snapshot();
  empty.contacts = [];
  empty.opportunities = [];
  empty.tasks = [];
  const html = renderGrowthHomeBody(empty, PROPERTY_PREDATOR_GROWTH_PROFILE);
  assert.match(html, /No urgent CRM work/);
  assert.match(html, /No journey evidence is recorded yet/);
  assert.match(html, /Not connected/);
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
  assert.match(html, /No urgent CRM work/);
  assert.doesNotMatch(html, /Completed sale/);
  assert.doesNotMatch(html, /No task/);
});

test('Growth HQ makes bounded overview counts and priority queue semantics explicit', () => {
  const bounded = snapshot();
  bounded.contacts = Array.from({ length: 50 }, (_, index) => ({
    id: `contact-${index}`,
    displayName: `Loaded lead ${index}`,
    lifecycle: 'lead' as const,
    openOpportunityCount: 1,
    createdAt: '2026-08-20T09:00:00.000Z',
  }));
  bounded.tasks = [
    {
      id: 'future', title: 'Nearest due task', status: 'open', dueAt: '2026-08-26T09:00:00.000Z',
      rowVersion: 1, completeCommandKey: 'task-future',
    },
    {
      id: 'recent-overdue', title: 'Recently overdue task', status: 'open', dueAt: '2026-08-25T11:00:00.000Z',
      rowVersion: 1, completeCommandKey: 'task-recent',
    },
    {
      id: 'old-overdue', title: 'Most overdue task', status: 'open', dueAt: '2026-08-20T09:00:00.000Z',
      rowVersion: 1, completeCommandKey: 'task-old',
    },
  ];
  bounded.opportunities = [
    {
      id: 'recent-opportunity', contactId: 'contact-1', contactName: 'Recent lead', title: 'Recently unworked opportunity',
      stageId: 's1', updatedAt: '2026-08-24T10:00:00.000Z', rowVersion: 1, moveCommandKey: 'move-recent',
    },
    {
      id: 'old-opportunity', contactId: 'contact-2', contactName: 'Older lead', title: 'Longest-unworked opportunity',
      stageId: 's1', updatedAt: '2026-08-10T10:00:00.000Z', rowVersion: 1, moveCommandKey: 'move-old',
    },
  ];

  const html = renderGrowthHomeBody(bounded, PROPERTY_PREDATOR_GROWTH_PROFILE, growth());
  assert.match(html, /<small>CRM leads loaded<\/small><strong>50<\/strong>/);
  assert.match(html, /not a workspace total/);
  assert.match(html, /bounded overview preview, not the complete workspace queue/i);
  assert.match(html, /most overdue, then nearest due, then longest-unworked open opportunities/i);
  assert.doesNotMatch(html, /<small>CRM leads<\/small>/);

  const mostOverdue = html.indexOf('Most overdue task');
  const recentlyOverdue = html.indexOf('Recently overdue task');
  const nearestDue = html.indexOf('Nearest due task');
  const longestUnworked = html.indexOf('Longest-unworked opportunity');
  assert.ok(mostOverdue > -1);
  assert.ok(mostOverdue < recentlyOverdue);
  assert.ok(recentlyOverdue < nearestDue);
  assert.ok(nearestDue < longestUnworked);
  assert.doesNotMatch(html, /Recently unworked opportunity/);
});

test('Growth HQ fills the bounded attention preview with overdue work before lower-priority items', () => {
  const urgent = snapshot();
  urgent.tasks = [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `overdue-${index}`,
      title: `Overdue priority ${index}`,
      status: 'open' as const,
      dueAt: `2026-08-${String(20 + index).padStart(2, '0')}T09:00:00.000Z`,
      rowVersion: 1,
      completeCommandKey: `task-overdue-${index}`,
    })),
    {
      id: 'future', title: 'Lower-priority future task', status: 'open', dueAt: '2026-08-26T09:00:00.000Z',
      rowVersion: 1, completeCommandKey: 'task-future',
    },
  ];

  const html = renderGrowthHomeBody(urgent, PROPERTY_PREDATOR_GROWTH_PROFILE, growth());
  assert.equal((html.match(/Overdue priority \d/g) ?? []).length, 4);
  assert.doesNotMatch(html, /Lower-priority future task/);
  assert.doesNotMatch(html, /Apex annual/);
});
