import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCrmContactsBody,
  renderCrmPipelineBody,
  renderCrmTasksBody,
  type CrmWorkspaceSnapshot,
} from '../src/portal/crm-views.js';

function snapshot(overrides: Partial<CrmWorkspaceSnapshot> = {}): CrmWorkspaceSnapshot {
  return {
    workspace: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Northstar Property',
      timezone: 'Europe/London',
      snapshotAt: '2026-08-23T12:00:00.000Z',
      canWrite: true,
    },
    contacts: [{
      id: '21111111-1111-4111-8111-111111111111',
      displayName: 'Avery Stone',
      companyName: 'Stone Developments',
      primaryEmail: 'avery@example.test',
      primaryPhone: '+44 7700 900000',
      lifecycle: 'lead',
      openOpportunityCount: 1,
      nextTaskAt: '2026-08-24T09:00:00.000Z',
      lastActivityAt: '2026-08-23T10:15:00.000Z',
      createdAt: '2026-08-23T09:00:00.000Z',
    }],
    stages: [
      { id: '31111111-1111-4111-8111-111111111111', name: 'New lead', position: 0, isClosed: false },
      { id: '32222222-2222-4222-8222-222222222222', name: 'Qualified', position: 1, isClosed: false },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Won', position: 2, isClosed: true },
    ],
    opportunities: [{
      id: '41111111-1111-4111-8111-111111111111',
      contactId: '21111111-1111-4111-8111-111111111111',
      contactName: 'Avery Stone',
      companyName: 'Stone Developments',
      title: 'Riverside acquisition',
      stageId: '31111111-1111-4111-8111-111111111111',
      valueMinor: 125_000_00,
      currency: 'GBP',
      ownerName: 'Morgan Lee',
      expectedCloseDate: '2026-09-30',
      nextTaskAt: '2026-08-22T09:00:00.000Z',
      updatedAt: '2026-08-23T10:15:00.000Z',
      rowVersion: 4,
      moveCommandKey: 'move-opp-4',
    }],
    tasks: [
      {
        id: '51111111-1111-4111-8111-111111111111',
        title: 'Call about the acquisition pack',
        status: 'open',
        contactName: 'Avery Stone',
        opportunityTitle: 'Riverside acquisition',
        assigneeName: 'Morgan Lee',
        dueAt: '2026-08-22T09:00:00.000Z',
        rowVersion: 2,
        completeCommandKey: 'complete-task-2',
      },
      {
        id: '52222222-2222-4222-8222-222222222222',
        title: 'Review prospectus',
        status: 'completed',
        completedAt: '2026-08-21T16:00:00.000Z',
        rowVersion: 3,
        completeCommandKey: 'already-complete',
      },
    ],
    timeline: [{
      id: '61111111-1111-4111-8111-111111111111',
      kind: 'lead_created',
      summary: 'Avery Stone was added as a lead',
      actorName: 'Morgan Lee',
      occurredAt: '2026-08-23T10:15:00.000Z',
    }],
    ...overrides,
  };
}

function occurrences(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

test('contacts body is a labelled CRM page with a real create-lead POST form', () => {
  const html = renderCrmContactsBody(snapshot(), {
    csrfToken: 'csrf<&"token',
    createLeadCommandKey: 'create:lead-001',
  });

  assert.match(html, /data-crm-page="contacts"/);
  assert.match(html, /<nav class="crm-subnav" aria-label="CRM sections">/);
  assert.match(html, /href="\/portal\/crm\/contacts" aria-current="page"/);
  assert.match(html, /<section class="crm-panel" aria-labelledby="crm-contacts-title">/);
  assert.match(html, /href="#crm-create-lead">Create a lead<\/a>/);
  assert.match(html, /id="crm-create-lead" aria-labelledby="crm-create-lead-title"/);
  assert.match(html, /<table class="crm-table"><caption>Contacts saved in Northstar Property<\/caption>/);
  assert.match(html, /<th scope="col">Contact<\/th>/);
  assert.match(html, /data-label="Primary reach"/);

  assert.match(html, /<form class="crm-form" method="post" action="\/portal\/crm\/leads">/);
  assert.match(html, /<label for="crm-lead-display-name">Contact name<\/label>/);
  assert.match(html, /name="display_name"[^>]* required/);
  assert.match(html, /name="opportunity_title"[^>]* required/);
  assert.match(html, /name="stage_id" required/);
  assert.match(html, /name="_csrf" value="csrf&lt;&amp;&quot;token"/);
  assert.match(html, /name="command_key" value="create:lead-001"/);
  assert.match(html, /Europe\/London workspace time/);
  assert.match(html, />Create lead in CRM<\/button>/);
  assert.match(html, /does not send a message, schedule content or notify the contact/);
  assert.doesNotMatch(html, /Published successfully|Message sent|Contact notified/i);
});

test('contacts body escapes all workspace, contact, stage, timeline and retained form content', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const base = snapshot();
  const html = renderCrmContactsBody(snapshot({
    workspace: { ...base.workspace, name: malicious },
    contacts: [{ ...base.contacts[0]!, displayName: '<script>alert(1)</script>', companyName: malicious, primaryEmail: 'a&b@example.test' }],
    stages: [{ ...base.stages[0]!, name: '<svg onload=alert(1)>' }],
    timeline: [{ ...base.timeline[0]!, summary: malicious, actorName: '<b>owner</b>' }],
  }), {
    csrfToken: 'csrf-token',
    createLeadCommandKey: 'create-lead',
    form: { values: { displayName: malicious, opportunityTitle: 'A & B', taskTitle: '"quoted"' } },
  });

  assert.doesNotMatch(html, /<script>|<img src=x|<svg onload|<b>owner<\/b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /a&amp;b@example\.test/);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(html, /value="A &amp; B"/);
  assert.match(html, /value="&quot;quoted&quot;"/);
});

test('create-lead validation errors are linked, announced and preserve safe values', () => {
  const html = renderCrmContactsBody(snapshot(), {
    csrfToken: 'csrf-token',
    createLeadCommandKey: 'create-lead',
    form: {
      values: { displayName: 'Avery & Co', email: 'not-an-email', opportunityTitle: 'Riverside' },
      fieldErrors: {
        email: ['Enter a valid email address.'],
        phone: ['Add an email or phone number.'],
      },
    },
    notice: { kind: 'error', title: 'Lead not saved', message: 'Review the highlighted details and try again.' },
  });

  assert.match(html, /class="crm-notice error" role="alert"/);
  assert.match(html, /class="crm-error-summary" role="alert" tabindex="-1"/);
  assert.match(html, /href="#crm-lead-email">Email address: Enter a valid email address\.<\/a>/);
  assert.match(html, /id="crm-lead-email"[^>]*aria-invalid="true" aria-describedby="crm-lead-email-error" autofocus/);
  assert.doesNotMatch(html, /id="crm-lead-phone"[^>]*autofocus/);
  assert.match(html, /id="crm-lead-email-error">Enter a valid email address\.<\/p>/);
  assert.match(html, /value="Avery &amp; Co"/);
  assert.match(html, /value="not-an-email"/);
});

test('create-lead form is honestly unavailable until a stage and command key exist', () => {
  const noStages = renderCrmContactsBody(snapshot({ stages: [] }), {
    csrfToken: 'csrf-token', createLeadCommandKey: 'create-lead',
  });
  assert.match(noStages, /Lead creation is not available yet/);
  assert.match(noStages, /needs at least one open pipeline stage/);
  assert.doesNotMatch(noStages, /<form class="crm-form"/);

  const noCommand = renderCrmContactsBody(snapshot(), {
    csrfToken: 'csrf-token', createLeadCommandKey: '',
  });
  assert.match(noCommand, /Refresh needed/);
  assert.match(noCommand, /command key is required/);
  assert.doesNotMatch(noCommand, /<form class="crm-form"/);
});

test('viewer snapshots render CRM data without mutation forms', () => {
  const base = snapshot();
  const readOnly = snapshot({ workspace: { ...base.workspace, canWrite: false } });
  const contacts = renderCrmContactsBody(readOnly, {
    csrfToken: 'csrf-token', createLeadCommandKey: 'create-lead',
  });
  const pipeline = renderCrmPipelineBody(readOnly, { csrfToken: 'csrf-token' });
  const tasks = renderCrmTasksBody(readOnly, { csrfToken: 'csrf-token' });

  assert.match(contacts, /Read-only CRM access/);
  assert.match(pipeline, /Read-only access · stage changes are unavailable/);
  assert.match(tasks, /Read-only access · task changes are unavailable/);
  assert.doesNotMatch(contacts, /<form class="crm-form"/);
  assert.doesNotMatch(contacts, /href="#crm-create-lead"/);
  assert.doesNotMatch(pipeline, /<form class="crm-move-form"/);
  assert.doesNotMatch(tasks, /<form class="crm-complete-form"/);
});

test('empty CRM states respect workspace permissions', () => {
  const base = snapshot();
  const writable = renderCrmContactsBody(snapshot({ contacts: [] }), {
    csrfToken: 'csrf-token', createLeadCommandKey: 'create-lead',
  });
  const readOnlySnapshot = snapshot({
    workspace: { ...base.workspace, canWrite: false }, contacts: [], stages: [], opportunities: [],
  });
  const readOnlyContacts = renderCrmContactsBody(readOnlySnapshot, {
    csrfToken: 'csrf-token', createLeadCommandKey: 'create-lead',
  });
  const readOnlyPipeline = renderCrmPipelineBody(readOnlySnapshot, { csrfToken: 'csrf-token' });

  assert.match(writable, /Use the create lead form to add the first private CRM record/);
  assert.match(readOnlyContacts, /Ask a workspace owner or sales user to add the first lead/);
  assert.doesNotMatch(readOnlyContacts, /Use the create lead form/);
  assert.match(readOnlyPipeline, /Ask a workspace owner or administrator to finish the pipeline setup/);
});

test('pipeline uses accessible server-rendered move forms with concurrency and CSRF fields', () => {
  const base = snapshot();
  const html = renderCrmPipelineBody(snapshot({
    opportunities: [
      base.opportunities[0]!,
      {
        ...base.opportunities[0]!,
        id: 'opportunity/with path?bits',
        title: 'Second <deal>',
        stageId: 'stage-that-no-longer-exists',
        rowVersion: 7,
        moveCommandKey: 'move-second',
      },
    ],
  }), {
    csrfToken: 'pipeline-csrf',
    notice: {
      kind: 'conflict',
      title: 'A newer change won',
      message: 'We did not overwrite the saved stage. Review the board and try again.',
    },
  });

  assert.match(html, /data-crm-page="pipeline"/);
  assert.match(html, /href="\/portal\/crm\/opportunities" aria-current="page"/);
  assert.match(html, /class="crm-notice conflict" role="alert"/);
  assert.match(html, /We did not overwrite the saved stage/);
  assert.match(html, /<div class="crm-board" role="region" tabindex="0" aria-label="Opportunity stages" aria-describedby="crm-board-keyboard-help">/);
  assert.match(html, /Stage needs review/);
  assert.match(html, /Second &lt;deal&gt;/);
  assert.match(html, /action="\/portal\/crm\/opportunities\/opportunity%2Fwith%20path%3Fbits\/stage"/);
  assert.match(html, /aria-label="Move Riverside acquisition to another stage"/);
  assert.match(html, /<label for="crm-move-stage-0">Move to<\/label>/);
  assert.match(html, /name="target_stage_id" required/);
  assert.equal(occurrences(html, /name="_csrf" value="pipeline-csrf"/g), 2);
  assert.match(html, /name="command_key" value="move-opp-4"/);
  assert.match(html, /name="expected_version" value="4"/);
  assert.match(html, /<time datetime="2026-09-30">30 Sept 2026<\/time>/);
  assert.match(html, /no contact is notified/);
  assert.match(html, /focus the board and use arrow keys/);
  assert.match(html, /there is no pretend drag and drop/);
  assert.doesNotMatch(html, /\sdraggable=|ondrag|onclick=|role="button"/i);
  assert.doesNotMatch(html, /Stage updated successfully|Contact notified/i);
});

test('pipeline with malformed action metadata shows a refresh state instead of a fake control', () => {
  const base = snapshot();
  const html = renderCrmPipelineBody(snapshot({
    opportunities: [{ ...base.opportunities[0]!, rowVersion: -1, moveCommandKey: '' }],
  }), { csrfToken: 'pipeline-csrf' });

  assert.match(html, /Refresh this page before moving this opportunity/);
  assert.doesNotMatch(html, /class="crm-move-form"/);
  assert.doesNotMatch(html, /name="expected_version"/);
});

test('pipeline empty and error states describe saved state without invented totals or controls', () => {
  const noStages = renderCrmPipelineBody(snapshot({ stages: [], opportunities: [] }), {
    csrfToken: 'pipeline-csrf',
    notice: { kind: 'error', title: 'Pipeline unavailable', message: 'Saved stages could not be loaded.' },
  });
  assert.match(noStages, /role="alert"/);
  assert.match(noStages, /No pipeline stages have been saved/);
  assert.doesNotMatch(noStages, /class="crm-move-form"/);

  const emptyStages = renderCrmPipelineBody(snapshot({ opportunities: [] }), { csrfToken: 'pipeline-csrf' });
  assert.match(emptyStages, /0 saved opportunities across 3 stages/);
  assert.equal(occurrences(emptyStages, /No opportunities in this stage\./g), 3);
  assert.doesNotMatch(emptyStages, /name="target_stage_id"/);
});

test('tasks have real filter links and only open records get completion POST forms', () => {
  const html = renderCrmTasksBody(snapshot(), { csrfToken: 'task-csrf' });

  assert.match(html, /data-crm-page="tasks"/);
  assert.match(html, /href="\/portal\/crm\/tasks" aria-current="page"/);
  assert.match(html, /<nav class="crm-filterlinks" aria-label="Task status filter">/);
  assert.match(html, /href="\/portal\/crm\/tasks\?status=open" aria-current="page"/);
  assert.match(html, /href="\/portal\/crm\/tasks\?status=all">All/);
  assert.match(html, /href="\/portal\/crm\/tasks\?status=completed">Completed/);
  assert.match(html, /Call about the acquisition pack/);
  assert.doesNotMatch(html, /Review prospectus/);
  assert.match(html, /class="crm-due-state overdue">Overdue/);
  assert.match(html, /<form class="crm-complete-form" method="post" action="\/portal\/crm\/tasks\/51111111-1111-4111-8111-111111111111\/complete"/);
  assert.match(html, /name="_csrf" value="task-csrf"/);
  assert.match(html, /name="command_key" value="complete-task-2"/);
  assert.match(html, /name="expected_version" value="2"/);
  assert.match(html, /Updates this CRM task only · no message is sent/);
  assert.equal(occurrences(html, /<form class="crm-complete-form"/g), 1);
});

test('completed task view is read-only and escapes task, contact and timeline content', () => {
  const base = snapshot();
  const malicious = '<img src=x onerror=alert(1)>';
  const html = renderCrmTasksBody(snapshot({
    tasks: [{ ...base.tasks[1]!, title: malicious, contactName: '<script>bad()</script>', completedAt: 'not-a-date' }],
    timeline: [{ ...base.timeline[0]!, summary: malicious, actorName: '<b>actor</b>' }],
  }), { csrfToken: 'task-csrf', filter: 'completed' });

  assert.match(html, /href="\/portal\/crm\/tasks\?status=completed" aria-current="page"/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;actor&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<img src=x|<script>|<b>actor<\/b>/);
  assert.doesNotMatch(html, /class="crm-complete-form"/);
  assert.doesNotMatch(html, /name="_csrf"/);
  assert.match(html, /Completed/);
});

test('task empty state and invalid mutation metadata are explicit', () => {
  const empty = renderCrmTasksBody(snapshot({ tasks: [] }), { csrfToken: 'task-csrf' });
  assert.match(empty, /No open tasks/);
  assert.match(empty, /There are no open tasks in this workspace/);
  assert.doesNotMatch(empty, /class="crm-complete-form"/);

  const base = snapshot();
  const invalid = renderCrmTasksBody(snapshot({
    tasks: [{ ...base.tasks[0]!, rowVersion: Number.NaN, completeCommandKey: '' }],
  }), { csrfToken: 'task-csrf' });
  assert.match(invalid, /Refresh this page before completing this task/);
  assert.doesNotMatch(invalid, /class="crm-complete-form"/);
});

test('bounded collection pages expose honest, accessible continuation controls', () => {
  const first = {
    continuation: false,
    hasNextPage: true,
    nextCursor: 'opaque.cursor+/=',
    pageSize: 50,
  } as const;
  const contacts = renderCrmContactsBody(snapshot({
    pagination: { contacts: first },
  }), { csrfToken: 'csrf', createLeadCommandKey: 'create' });
  assert.match(contacts, /aria-label="1\+ contacts shown">1\+<\/span>/);
  assert.match(contacts, /<nav class="crm-pagination" aria-label="Saved record pages">/);
  assert.match(contacts, /rel="next" href="\/portal\/crm\/contacts\?after=opaque.cursor%2B%2F%3D">Next 50<\/a>/);
  assert.doesNotMatch(contacts, />First page<\/a>/);

  const pipeline = renderCrmPipelineBody(snapshot({
    pagination: { pipeline: first },
  }), { csrfToken: 'csrf' });
  assert.match(pipeline, /1\+ saved opportunities shown across 3 stages/);
  assert.match(pipeline, /aria-label="1 opportunities shown on this page"/);

  const tasks = renderCrmTasksBody(snapshot({
    pagination: {
      tasks: { ...first, continuation: true, hasNextPage: false, nextCursor: null },
    },
  }), { csrfToken: 'csrf', filter: 'open' });
  assert.match(tasks, /href="\/portal\/crm\/tasks\?status=open">First page<\/a>/);
  assert.match(tasks, /End of saved records/);
  assert.doesNotMatch(tasks, /[?&]after=/);
});

test('CRM bodies use responsive and forced-colour hooks without scripted fake interactions', () => {
  const contacts = renderCrmContactsBody(snapshot(), { csrfToken: 'csrf', createLeadCommandKey: 'create' });
  const pipeline = renderCrmPipelineBody(snapshot(), { csrfToken: 'csrf' });
  const tasks = renderCrmTasksBody(snapshot(), { csrfToken: 'csrf' });

  for (const html of [contacts, pipeline, tasks]) {
    assert.match(html, /<style data-relaunch72-crm>/);
    assert.match(html, /@media\(max-width:640px\)/);
    assert.match(html, /@media\(forced-colors:active\)/);
    assert.doesNotMatch(html, /<script|javascript:|onclick=|onchange=|\sdraggable=/i);
    assert.doesNotMatch(html, /href="#"/);
  }
  assert.doesNotMatch(contacts, /\.crm-create-panel\{order:-1\}/);
  assert.match(pipeline, /\.crm-board\{grid-auto-columns:minmax\(270px,82vw\)\}/);
});
