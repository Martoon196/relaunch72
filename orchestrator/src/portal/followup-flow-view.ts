import { escapeHtml as e } from './ui.js';
import { PROVIDER_CONNECTIONS_ROUTE } from './provider-connections-presenter.js';
import { LIVE_CHANNELS_ROUTE } from './live-channels-presenter.js';
import { renderFlowEditor } from '../followup-sequences/editor-view.js';
import { renderFlowMessagePreviews, renderFlowSimulation } from '../followup-sequences/preview-view.js';
import { previewFlowMessage } from '../followup-sequences/channel-drafts.js';
import type { FlowInlineMessage } from '../followup-sequences/composition.js';
import type { FollowupSequenceDefinition } from '../followup-sequences/definition.js';
import type { simulateFollowupFlow } from '../followup-sequences/simulation.js';
import { PP_FOLLOWUP_ROUTE as BASE, type PortalFlowSaveInput, type PortalFlowReview, type PortalFlowSnapshot, type PortalFollowupFlowService } from './followup-flow-service.js';
import { FOLLOWUP_REASON_LABELS } from '../followup-sequences/state.js';
import type { PpFollowupRun } from '../pp-followup/repository.js';
export interface PortalFlowPageInput { readonly snapshot: PortalFlowSnapshot; readonly csrf: string; readonly commandId: string; readonly draft?: PortalFlowSaveInput;
  readonly detail?: PortalFlowReview; readonly preview?: Awaited<ReturnType<PortalFollowupFlowService['preview']>>; readonly simulation?: ReturnType<typeof simulateFollowupFlow>; readonly message?: string }
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${e(value)}">`;
const when = (value: string | null) => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }) : '—';
const BLOCKERS: Readonly<Record<string, string>> = {
  email_not_connected: 'PP email delivery is off or its Postmark sender is not fully configured.',
  sms_not_connected: 'Text messages are not connected for PP flows yet. Remove text steps to start this flow.',
  whatsapp_not_connected: 'WhatsApp is not connected for PP flows yet. Remove WhatsApp steps to start this flow.',
  reply_stop_not_connected: 'Automatic reply detection is not connected yet. Turn off the reply stop to start this flow.',
  booked_stop_not_connected: 'Automatic booking detection is not connected yet. Turn off the booking stop to start this flow.',
  purchased_stop_not_connected: 'Automatic purchase detection is not connected yet. Turn off the purchase stop to start this flow.',
  message_needs_review: 'A selected message is not its latest version, or the brand changed. Save a fresh version and review it.',
  message_not_published: 'A selected email is not published yet. Publish the flow to approve its exact messages.',
};
function runCard(run: PpFollowupRun, page: PortalFlowPageInput): string {
  const fields = hidden('csrf', page.csrf) + hidden('commandId', page.commandId) + hidden('itemId', run.contentItemId) + hidden('versionId', run.contentVersionId) + hidden('runId', run.id);
  const control = (action: string, label: string) => `<form method="post" action="${BASE}/${action}">${fields}${hidden('ackProofId', '')}<button class="secondary">${e(label)}</button></form>`;
  const open = ['active', 'paused', 'held'].includes(run.state);
  return `<article class="run"><h3>${e(run.displayName || run.email)}</h3><p class="note">${e(run.email)} · <strong>${e(run.state)}</strong> · step ${run.position + 1}</p>
    ${run.reason ? `<p>${e(FOLLOWUP_REASON_LABELS[run.reason] ?? 'Review this run before continuing.')}</p>` : ''}
    ${run.inFlight ? '<p class="notice">A message is being handed to Postmark. A handoff already verified before pausing or stopping may still finish.</p>' : ''}
    <p>Next due: ${e(when(run.dueAt))} UK time. Last accepted by Postmark: ${e(when(run.lastAcceptedAt))}.</p>
    ${run.steps.length ? `<ol>${run.steps.map(step => `<li>Step ${step.position + 1}: ${step.acceptedAt ? `accepted by Postmark ${e(when(step.acceptedAt))}` : step.cancelled ? 'cancelled' : step.failed ? 'failed' : step.inFlight ? 'being processed' : step.held ? 'held' : 'waiting'}.</li>`).join('')}</ol>` : '<p class="note">No message has been handed off yet.</p>'}
    <div class="actions">${run.state === 'active' ? control('pause', 'Pause this person') : ''}${['paused', 'held'].includes(run.state) && !run.unknownProofId ? control('resume', 'Resume this person') : ''}
    ${open ? control('stop', 'Stop this person') + control('cancel', 'Cancel this run') : ''}</div>
    ${open && run.unknownProofId ? `<form class="notice" method="post" action="${BASE}/resume">${fields}<label class="check"><input type="checkbox" name="ackProofId" value="${e(run.unknownProofId)}" required> I checked this exact attempt in Postmark. I understand retrying may send the same email twice.</label><button class="secondary" ${run.inFlight ? 'disabled' : ''}>Retry this unknown attempt</button></form>` : ''}</article>`;
}
function startControls(page: PortalFlowPageInput, detail: PortalFlowReview, published: boolean): string {
  const delivery = page.snapshot.delivery;
  if (!delivery) return '<button disabled type="button">Start · connect and test first</button><p>PP email delivery is not connected on this deployment. Your flow remains saved.</p>';
  const database = delivery.database, mode = delivery.mode;
  const modeNote = mode === 'live' ? '<p><strong>Email delivery is live.</strong> Each started person receives the published emails on this timeline.</p>'
    : mode === 'test' ? '<p class="notice"><strong>Email delivery is in test mode.</strong> Only the configured test addresses can receive anything; other runs wait until live mode.</p>'
    : `<p class="notice"><strong>Email delivery is off.</strong> Started runs wait and nothing is sent.${delivery.problems.length ? ` Setup needed: ${e(delivery.problems.join('; '))}.` : ''}</p>`;
  const savedFields = hidden('csrf', page.csrf) + hidden('commandId', page.commandId) + hidden('itemId', detail.review.contentItemId) + hidden('versionId', detail.review.contentVersionId);
  if (!database) return `${modeNote}<p class="notice">Run controls are temporarily unavailable. Nothing was changed.</p>`;
  const blocked = !published || detail.blockers.length > 0 || !page.snapshot.readiness.email;
  const choices = database.contacts;
  const enrol = blocked ? `<button disabled type="button">Start a person · ${!published ? 'publish first' : 'setup needed'}</button>`
    : choices.length ? `<form method="post" action="${BASE}/enrol">${savedFields}<label>CRM contact with email permission (first 200)<select name="contactPointId" required>${choices.map(contact => `<option value="${e(contact.contactPointId)}">${e(contact.displayName)} · ${e(contact.email)}${contact.inOpenRun ? ' · already in a flow' : ''}</option>`).join('')}</select></label><button data-saved-required>Start this person</button></form>`
    : '<p>No CRM contact currently has email marketing permission. Record email permission (channel email, purpose “marketing”) on the lead first.</p>';
  return `${modeNote}<h3>Start a person</h3><p>${database.permitted} CRM contact${database.permitted === 1 ? '' : 's'} currently have email marketing permission and no suppression. Starting checks permission again and every send checks it once more. Unsubscribing stops the run.</p>
    ${detail.blockers.length ? `<div class="notice"><strong>Setup needed before Start</strong><ul>${detail.blockers.map(key => `<li>${e(BLOCKERS[key] ?? key)}</li>`).join('')}</ul></div>` : ''}${enrol}
    <div class="actions">${(['pause', 'resume', 'cancel'] as const).map(action => `<form method="post" action="${BASE}/${action}">${savedFields}${hidden('runId', '')}${hidden('ackProofId', '')}<button class="secondary">${action === 'pause' ? 'Pause active runs' : action === 'resume' ? 'Resume ready runs' : 'Cancel open runs'}</button></form>`).join('')}</div>
    <p class="note">Resume rechecks approval and permission. Unknown attempts need their own explicit decision below. Postmark acceptance does not prove inbox delivery.</p>`;
}
export function renderPortalFlowPage(page: PortalFlowPageInput): string {
  const { snapshot, detail } = page, published = Boolean(detail?.valid && detail.review.isLatest && detail.review.approvalStatus === 'approved' && !detail.review.approvalStale);
  const draft = page.draft ?? (detail ? { commandId: page.commandId, contentItemId: detail.review.contentItemId, previousVersionId: detail.review.contentVersionId, definition: detail.definition } : undefined);
  const definition = page.preview?.definition ?? draft?.definition as FollowupSequenceDefinition | undefined;
  const editor = draft && definition ? renderFlowEditor({ profile: { brand: 'pp', base: BASE, libraryHref: null, futureWebinarEntry: false }, csrf: page.csrf, commandId: draft.commandId,
    contentItemId: draft.contentItemId, previousVersionId: draft.previousVersionId, definition, inlineMessages: draft.inlineMessages as Readonly<Record<string, FlowInlineMessage>> | undefined,
    choices: snapshot.messageChoices, detail: detail ? { versionNumber: detail.review.versionNumber, published, isLatest: detail.review.isLatest } : undefined }) : '';
  const journey = page.preview ?? detail, previews = page.preview?.messagePreviews ?? detail?.messages.map(message => previewFlowMessage(message.channel, message.payload)) ?? [];
  const timeline = journey ? `<section class="card"><h2>Planned journey</h2><p>Your PP flow is ready to plan. Choose who can receive it when delivery is connected.</p><p>Waits start after the previous provider acceptance; a leading wait starts at enrolment. Failure or unknown outcomes never advance.</p>
    <ol>${journey.timeline.map(step => `<li><strong>${step.step.kind === 'email' ? 'Email' : step.step.kind === 'sms' ? 'Text message' : 'WhatsApp template draft'}</strong> · ${step.waitMinutes} minutes after ${step === journey.timeline[0] ? 'enrolment' : 'the previous accepted message'}. Earliest planned offset: ${step.earliestOffsetMinutes} minutes.</li>`).join('')}</ol>
    ${journey.blockers.length ? '<p class="notice">You can edit and save this flow now. Connect its channels, check permission and test the selected stop rules before starting.</p>' : ''}</section>` : '';
  const controls = detail ? `<section class="card"><h2>${published ? 'Published flow' : 'Publish your flow'}</h2><p>Publish approves the messages and flow you reviewed. It does not start them. WhatsApp templates still need approval from the provider.</p>
    ${!published && detail.review.isLatest ? `<form method="post" action="${BASE}/publish"><input type="hidden" name="csrf" value="${e(page.csrf)}"><input type="hidden" name="commandId" value="${e(page.commandId)}"><input type="hidden" name="itemId" value="${e(detail.review.contentItemId)}"><input type="hidden" name="versionId" value="${e(detail.review.contentVersionId)}"><button data-saved-required ${!detail.valid ? 'disabled' : ''}>Publish flow</button></form>` : ''}
    ${!detail.valid ? '<p class="notice">The current brand or source changed. Save a fresh version and review the selected message references.</p>' : ''}${startControls(page, detail, published)}</section>` : '';
  const runs = detail && snapshot.delivery?.database ? snapshot.delivery.database.runs.filter(run => run.contentItemId === detail.review.contentItemId) : [];
  const people = detail && snapshot.delivery?.database ? `<section class="card"><h2>People and progress</h2><p>${snapshot.delivery.database.runCount} total runs across PP flows. Showing this flow’s runs among the latest 100.</p>${runs.map(run => runCard(run, page)).join('') || '<p>No one has been started in this flow yet.</p>'}</section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Follow-up flows · ${e(snapshot.brand.productName)}</title><style>
    body{margin:0;background:#f4f3ef;color:#172b30;font:17px/1.65 system-ui,sans-serif}header,main{max-width:1080px;margin:auto;padding:24px}header,nav,.actions{display:flex;gap:14px;flex-wrap:wrap;align-items:center}header{justify-content:space-between}a{color:${snapshot.brand.primaryColor ?? '#164756'}}h1{font:clamp(34px,5vw,50px)/1.15 Georgia,serif}h2{font-size:27px}h3{font-size:21px}.card{background:#fff;border:1px solid #d2dbdb;border-radius:18px;padding:clamp(20px,4vw,38px);margin:0 0 24px;min-width:0}.eyebrow{font-weight:800;font-size:14px;letter-spacing:.08em;text-transform:uppercase}.note{font-size:17px;color:#465b60}.notice{border-left:4px solid #bd8a31;background:#faf3e5;padding:16px;margin:20px 0}.run{padding:22px 0;border-top:1px solid #d5dddd}label{display:block;font-weight:700;margin:20px 0}input:not([type=hidden]):not([type=checkbox]),select{display:block;box-sizing:border-box;width:100%;max-width:100%;padding:13px;margin-top:7px;border:1px solid #9daeb0;border-radius:8px;font:17px/1.5 system-ui;background:#fff;color:#172b30}.check{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}.check input{margin-top:8px;width:20px;height:20px}button,.button{display:inline-block;max-width:100%;padding:14px 20px;border:0;border-radius:9px;background:${snapshot.brand.accentColor ?? '#f2b440'};color:#172b30;font:700 17px/1.4 system-ui;cursor:pointer;text-decoration:none}.secondary{background:#eaf0ef;border:1px solid #adbdbe}button:disabled{opacity:.55;cursor:not-allowed}.sequence-step{padding:20px;border:1px solid #bdcbca;border-radius:12px;background:#fafcfa;margin:18px 0;min-width:0}.sequence-step.drag-over{outline:3px solid #bd8a31}.drag-handle{cursor:grab}a,button,input,select,pre{overflow-wrap:anywhere}p{max-width:75ch}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #83510c;outline-offset:3px}@media(max-width:480px){header,main{padding:16px}.actions>*{max-width:100%}.actions button{width:100%}.sequence-step{padding:14px}}
    </style><script src="${BASE}/editor.js" defer></script></head><body><header><strong>${e(snapshot.brand.productName)}</strong><nav aria-label="Workspace navigation"><a href="/portal">Growth HQ workspace</a><a href="/portal/crm/opportunities">Lead board</a><a href="${LIVE_CHANNELS_ROUTE}">Channel setup</a></nav></header><main>
    ${page.message ? `<section class="card notice" role="status">${e(page.message)}</section>` : ''}<section class="card"><div class="eyebrow">Growth HQ · Property Predator</div><h1>Build the follow-up.<br>Connect it when you’re ready.</h1><p>Write the emails, texts and WhatsApp template drafts in one flow. Preview the copy and simulate each step before connecting delivery.</p><p class="notice"><strong>${snapshot.executable ? `Email delivery is ${e(snapshot.delivery?.mode ?? 'off')}. Publish a flow, then start people from its page.` : 'Drafting and simulation are ready. Connect and test delivery before starting this flow.'}</strong> Saving, simulation and publication send nothing.</p><a class="button" href="${BASE}?new=1">Create a flow</a></section>
    ${editor}${timeline}${renderFlowMessagePreviews(previews)}${renderFlowSimulation(page.simulation)}${controls}${people}
    <section class="card"><h2>Connections to complete later</h2><p>Email, SMS and WhatsApp each need their own real sender, recipient permission and joint delivery test for these flows. WhatsApp also needs a matching provider-approved template; template variables need a supported parameter connection.</p><p>Reply, booking and purchase stops need their event connections. Connecting a provider account alone does not switch those stops on.</p><div class="actions"><a class="button secondary" href="${LIVE_CHANNELS_ROUTE}">Open existing channel setup</a><a class="button secondary" href="${PROVIDER_CONNECTIONS_ROUTE}">Provider connections</a></div></section>
    <section class="card"><h2>Saved PP flows</h2>${snapshot.catalog.items.length ? `<ul>${snapshot.catalog.items.map(item => `<li><a href="${BASE}?item=${e(item.contentItemId)}&version=${e(item.contentVersionId)}">${e(item.title)}</a> · v${item.versionNumber} · ${item.approvalStatus === 'approved' && !item.approvalStale ? 'published flow' : 'draft / review needed'}</li>`).join('')}</ul>` : '<p>No flows saved yet.</p>'}<p class="note">Up to 50 latest flows and 50 saved choices per channel. Existing historical message versions stay unchanged.</p></section></main></body></html>`;
}
