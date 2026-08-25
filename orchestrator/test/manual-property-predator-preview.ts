/**
 * Local, read-only Property Predator product preview.
 *
 * It serves explicit preview fixtures only: no database, provider, message,
 * social post, payment or production service is touched.
 */
import { createServer } from 'node:http';
import { appShell } from '../src/portal/ui.js';
import { renderGrowthHomeBody } from '../src/portal/growth-home.js';
import { renderLead360Body, type Lead360View } from '../src/portal/lead-360-view.js';
import {
  renderCrmContactsBody,
  renderCrmPipelineBody,
  renderCrmTasksBody,
  type CrmWorkspaceSnapshot,
} from '../src/portal/crm-views.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import type { GrowthIntelligenceView } from '../src/portal/growth-intelligence.js';

const PORT = Number.parseInt(process.env.PROPERTY_PREDATOR_PREVIEW_PORT ?? '43172', 10);
const CONTACT_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_CONTACT_ID = '55555555-5555-4555-8555-555555555555';
const SNAPSHOT_AT = '2026-08-25T15:30:00.000Z';

const snapshot: CrmWorkspaceSnapshot = {
  workspace: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Property Predator Launch',
    timezone: 'Europe/London',
    snapshotAt: SNAPSHOT_AT,
    canWrite: true,
  },
  contacts: [
    {
      id: CONTACT_ID, displayName: 'Amelia Hart', companyName: 'Hart Property Group',
      primaryEmail: 'amelia@example.test', primaryPhone: '+44 7700 900001', lifecycle: 'lead',
      openOpportunityCount: 1, nextTaskAt: '2026-08-25T16:30:00.000Z',
      lastActivityAt: '2026-08-25T15:18:00.000Z', createdAt: '2026-08-14T09:20:00.000Z',
    },
    {
      id: SECOND_CONTACT_ID, displayName: 'Marcus Reed', companyName: 'Reed Acquisitions',
      primaryEmail: 'marcus@example.test', primaryPhone: null, lifecycle: 'prospect',
      openOpportunityCount: 1, nextTaskAt: null, lastActivityAt: '2026-08-25T13:06:00.000Z',
      createdAt: '2026-08-19T11:42:00.000Z',
    },
    {
      id: '66666666-6666-4666-8666-666666666666', displayName: 'Priya Shah', companyName: null,
      primaryEmail: 'priya@example.test', primaryPhone: null, lifecycle: 'lead',
      openOpportunityCount: 0, nextTaskAt: null, lastActivityAt: '2026-08-24T10:00:00.000Z',
      createdAt: '2026-08-22T08:10:00.000Z',
    },
  ],
  stages: [
    { id: '77777777-7777-4777-8777-777777777777', name: 'New signal', position: 1, isClosed: false },
    { id: '88888888-8888-4888-8888-888888888888', name: 'Qualified', position: 2, isClosed: false },
    { id: '99999999-9999-4999-8999-999999999999', name: 'Proposal', position: 3, isClosed: false },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Won', position: 4, isClosed: true },
  ],
  opportunities: [
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', contactId: CONTACT_ID, contactName: 'Amelia Hart',
      companyName: 'Hart Property Group', title: 'Apex annual membership',
      stageId: '99999999-9999-4999-8999-999999999999', valueMinor: 9900, currency: 'GBP',
      ownerName: 'Martin', expectedCloseDate: '2026-08-29', nextTaskAt: '2026-08-25T16:30:00.000Z',
      updatedAt: '2026-08-25T15:18:00.000Z', rowVersion: 4, moveCommandKey: 'preview-move-amelia',
    },
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', contactId: SECOND_CONTACT_ID, contactName: 'Marcus Reed',
      companyName: 'Reed Acquisitions', title: 'Agency pilot',
      stageId: '88888888-8888-4888-8888-888888888888', valueMinor: 250000, currency: 'GBP',
      ownerName: 'Martin', expectedCloseDate: '2026-09-08', nextTaskAt: null,
      updatedAt: '2026-08-25T13:06:00.000Z', rowVersion: 2, moveCommandKey: 'preview-move-marcus',
    },
  ],
  tasks: [
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', title: 'Review Amelia’s requested contact',
      status: 'open', contactName: 'Amelia Hart', opportunityTitle: 'Apex annual membership',
      assigneeName: 'Martin', dueAt: '2026-08-25T16:30:00.000Z', rowVersion: 2,
      completeCommandKey: 'preview-task-amelia',
    },
    {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', title: 'Prepare agency pilot discovery',
      status: 'open', contactName: 'Marcus Reed', opportunityTitle: 'Agency pilot', assigneeName: 'Martin',
      dueAt: '2026-08-26T09:00:00.000Z', rowVersion: 1, completeCommandKey: 'preview-task-marcus',
    },
  ],
  timeline: [
    { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'stage_moved', summary: 'Apex annual moved to Proposal', actorName: 'Martin', occurredAt: '2026-08-25T15:18:00.000Z' },
    { id: '12121212-1212-4212-8212-121212121212', kind: 'lead_created', summary: 'Marcus Reed entered the CRM', actorName: null, occurredAt: '2026-08-25T13:06:00.000Z' },
  ],
};

const growth: GrowthIntelligenceView = {
  dataState: 'preview',
  asOf: SNAPSHOT_AT,
  windowLabel: 'Last 30 days · preview evidence',
  funnels: [
    {
      track: 'self_serve', label: 'Self-serve conversion',
      description: 'Captured identity to meaningful product use, priced intent and paid sale.',
      stages: [
        { key: 'lead', label: 'Lead', count: 184, stepConversionPercent: null, movedInWindow: 47 },
        { key: 'activated', label: 'Activated', count: 93, stepConversionPercent: 50.5, movedInWindow: 28 },
        { key: 'priced', label: 'Priced', count: 41, stepConversionPercent: 44.1, movedInWindow: 13 },
        { key: 'sale', label: 'Sale', count: 17, stepConversionPercent: 41.5, movedInWindow: 6 },
      ],
    },
    {
      track: 'agency', label: 'Agency LAPS',
      description: 'Named agency lead to appointment, presentation and collected sale.',
      stages: [
        { key: 'lead', label: 'Lead', count: 52, stepConversionPercent: null, movedInWindow: 11 },
        { key: 'appointment', label: 'Appointment', count: 24, stepConversionPercent: 46.2, movedInWindow: 7 },
        { key: 'presentation', label: 'Presentation', count: 13, stepConversionPercent: 54.2, movedInWindow: 4 },
        { key: 'sale', label: 'Sale', count: 5, stepConversionPercent: 38.5, movedInWindow: 2 },
      ],
    },
  ],
  hotLeads: [
    {
      contactId: CONTACT_ID, displayName: 'Amelia Hart', companyName: 'Hart Property Group',
      track: 'self_serve', stage: 'Priced', score: 82, band: 'burning',
      lastEvidence: { kind: 'reply', label: 'Requested a call', detail: 'Apex Annual offer', occurredAt: '2026-08-25T15:18:00.000Z' },
      contentSummary: 'Predator Briefing · 94%', offerSummary: 'Apex Annual · requested contact',
      nextMove: 'Review the requested contact and current permission before any outreach.',
    },
    {
      contactId: SECOND_CONTACT_ID, displayName: 'Marcus Reed', companyName: 'Reed Acquisitions',
      track: 'agency', stage: 'Appointment', score: 61, band: 'hot',
      lastEvidence: { kind: 'watched', label: 'Agency Partner Briefing', detail: '78% complete', occurredAt: '2026-08-25T13:06:00.000Z' },
      contentSummary: 'Agency Partner Briefing · 78%', offerSummary: null,
      nextMove: 'Prepare the discovery around the exact briefing sections Marcus completed.',
    },
  ],
  evidenceTotals: { contentStarted: 126, contentCompleted: 71, offersShown: 39, replies: 18, appointments: 11 },
};

const lead360: Lead360View = {
  identity: {
    contactId: CONTACT_ID, displayName: 'Amelia Hart', companyName: 'Hart Property Group',
    primaryEmail: 'amelia@example.test', primaryPhone: '+44 7700 900001', ownerName: 'Martin',
  },
  score: 82,
  scoreExplanation: 'Completed the Predator Briefing · Returned to pricing twice · Requested personal contact · Engagement 57 · Intent 25',
  journey: {
    label: 'Self-serve conversion',
    stages: [
      { key: 'lead', label: 'Lead', state: 'complete', reachedAt: '2026-08-14T09:20:00.000Z' },
      { key: 'activated', label: 'Activated', state: 'complete', reachedAt: '2026-08-19T14:02:00.000Z' },
      { key: 'priced', label: 'Priced', state: 'current', reachedAt: '2026-08-25T15:10:00.000Z' },
      { key: 'sale', label: 'Sale', state: 'upcoming', reachedAt: null },
    ],
  },
  evidence: [
    { id: '1', kind: 'reply', title: 'Requested a personal call', detail: 'Response to Apex Annual offer', percentage: null, occurredAt: '2026-08-25T15:18:00.000Z', sourceLabel: 'Offer response' },
    { id: '2', kind: 'offer', title: 'Apex Annual presented', detail: '£99.00 · pricing result', percentage: null, occurredAt: '2026-08-25T15:10:00.000Z', sourceLabel: 'Property Predator' },
    { id: '3', kind: 'watched', title: 'Predator Briefing replay', detail: '47 minutes consumed', percentage: 94, occurredAt: '2026-08-25T14:54:00.000Z', sourceLabel: 'Video' },
    { id: '4', kind: 'listened', title: 'Deal Stack audio lesson', detail: '18 minutes consumed', percentage: 100, occurredAt: '2026-08-24T18:21:00.000Z', sourceLabel: 'Audio' },
    { id: '5', kind: 'read', title: 'Funding the first acquisition', detail: 'Article completed', percentage: 100, occurredAt: '2026-08-23T11:43:00.000Z', sourceLabel: 'Academy' },
  ],
  nextMove: {
    label: 'Review the requested contact personally',
    reason: 'Amelia completed the core briefing, revisited pricing and explicitly requested contact. Check the saved channel permission before acting.',
    dueAt: '2026-08-25T16:30:00.000Z',
  },
  offers: [{
    id: 'offer-1', title: 'Apex Annual', valueLabel: '£99.00', state: 'requested_contact',
    presentedAt: '2026-08-25T15:10:00.000Z', responseAt: '2026-08-25T15:18:00.000Z',
    responseDetail: 'Requested contact',
  }],
  consent: [
    { channelLabel: 'Email · amelia@example.test', state: 'permitted', basis: 'Property Predator marketing · Consent · Verified endpoint', updatedAt: '2026-08-14T09:20:00.000Z' },
    { channelLabel: 'SMS · +44 7700 900001', state: 'unknown', basis: 'No verified permission evidence', updatedAt: null },
  ],
  suppressionReason: null,
  crm: {
    opportunities: [{ id: 'opp-1', title: 'Apex annual membership', stageLabel: 'Proposal', state: 'open', valueLabel: '£99.00' }],
    tasks: [{ id: 'task-1', title: 'Review Amelia’s requested contact', state: 'open', dueAt: '2026-08-25T16:30:00.000Z' }],
  },
  asOf: SNAPSHOT_AT,
};

function shell(body: string, active: 'overview' | 'crm', title: string): string {
  return appShell({
    title, tenantName: snapshot.workspace.name, active, body,
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    capabilities: new Set(['workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read']),
    crmAvailable: true, mode: 'crm', csrfToken: 'preview-only-csrf-token-0000000000000000',
  });
}

function page(path: string): { status: number; html: string } {
  if (path === '/portal') return {
    status: 200,
    html: shell(renderGrowthHomeBody(snapshot, PROPERTY_PREDATOR_GROWTH_PROFILE, growth), 'overview', 'Property Predator — Growth HQ'),
  };
  if (path === `/portal/crm/contacts/${CONTACT_ID}`) return {
    status: 200,
    html: shell(`<nav aria-label="Lead 360 breadcrumb" style="margin-bottom:14px"><a class="button secondary compact" href="/portal/crm/contacts">← All contacts</a></nav>${renderLead360Body(lead360)}`, 'crm', 'Amelia Hart — Lead 360'),
  };
  if (path === '/portal/crm/contacts') return {
    status: 200,
    html: shell(renderCrmContactsBody(snapshot, {
      csrfToken: 'preview-only-csrf-token-0000000000000000',
      createLeadCommandKey: 'preview-create-lead-command',
    }), 'crm', 'Property Predator — Leads'),
  };
  if (path === '/portal/crm/opportunities') return {
    status: 200,
    html: shell(renderCrmPipelineBody(snapshot, { csrfToken: 'preview-only-csrf-token-0000000000000000' }), 'crm', 'Property Predator — Pipeline'),
  };
  if (path === '/portal/crm/tasks') return {
    status: 200,
    html: shell(renderCrmTasksBody(snapshot, {
      csrfToken: 'preview-only-csrf-token-0000000000000000', filter: 'open',
    }), 'crm', 'Property Predator — Tasks'),
  };
  return { status: 404, html: shell('<h1>Preview page not found</h1><p><a href="/portal">Return to Growth HQ</a></p>', 'overview', 'Not found') };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/portal', 'http://127.0.0.1');
  const rendered = page(url.pathname.replace(/\/+$/, '') || '/portal');
  response.writeHead(rendered.status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(rendered.html);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Property Predator preview ready at http://127.0.0.1:${PORT}/portal\n`);
});
