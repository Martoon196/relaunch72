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
import type { PpFollowupCommandResult, PpFollowupRun } from '../pp-followup/repository.js';
export interface PortalFlowPageInput { readonly snapshot: PortalFlowSnapshot; readonly csrf: string; readonly commandId: string; readonly draft?: PortalFlowSaveInput;
  readonly detail?: PortalFlowReview; readonly preview?: Awaited<ReturnType<PortalFollowupFlowService['preview']>>; readonly simulation?: ReturnType<typeof simulateFollowupFlow>; readonly message?: string;
  readonly now?: number }
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${e(value)}">`;
const when = (value: string | null) => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }) : '';
const people = (count: number) => `${count} ${count === 1 ? 'person' : 'people'}`;
/** "1 day 2 hours" rather than "1560 minutes". */
function waitText(minutes: number): string {
  const part = (count: number, unit: string) => count ? `${count} ${unit}${count === 1 ? '' : 's'}` : '';
  return [part(Math.floor(minutes / 1440), 'day'), part(Math.floor((minutes % 1440) / 60), 'hour'), part(minutes % 60, 'minute')].filter(Boolean).join(' ');
}

/*
 * Owner copy. The owner is not technical: short sentences, British English, no setting names, no provider or
 * database words in the main text. Anything a developer needs sits in a closed "For your developer" block.
 */
const BLOCKERS: Readonly<Record<string, string>> = {
  email_not_connected: 'Email sending isn’t set up yet.',
  sms_not_connected: 'Text messages can’t be sent from here yet. Remove the text steps to start this flow.',
  whatsapp_not_connected: 'WhatsApp messages can’t be sent from here yet. Remove the WhatsApp steps to start this flow.',
  reply_stop_not_connected: 'Stopping automatically when someone replies isn’t available yet. Turn that option off to start this flow.',
  booked_stop_not_connected: 'Stopping automatically when someone books isn’t available yet. Turn that option off to start this flow.',
  purchased_stop_not_connected: 'Stopping automatically when someone buys isn’t available yet. Turn that option off to start this flow.',
  message_needs_review: 'One of the emails has changed. Save the flow again and check it.',
  message_not_published: 'One of the emails isn’t published yet. Press “Publish flow”.',
};
/** The five words the owner sees for where a person is, plus one for an email that could not be sent. */
const STATE_LABELS: Readonly<Record<PpFollowupRun['state'], string>> = {
  active: 'Running', paused: 'Paused', held: 'Waiting for you', completed: 'Finished', stopped: 'Stopped', cancelled: 'Stopped', failed: 'Couldn’t send',
};
const REASONS: Readonly<Record<string, string>> = {
  newer_sequence: 'You have saved a newer version of this flow. Stop this person here, then start them in the new version.',
  content_changed: 'Something in this flow changed after this person started. Press Resume to carry on. If that doesn’t work, stop this person and start them in the latest version.',
  outcome_unknown: 'We’re not sure the last email went out.',
  unsubscribed: 'Stopped because this person unsubscribed or no longer agrees to marketing emails.',
  delivery_expired: 'This email waited too long and wasn’t sent. Nothing more will go to this person.',
  delivery_failed: 'We couldn’t send this email. Nothing more will go to this person.',
  manual: 'You stopped this person.',
  recovery: 'Paused for safety after an update. Press Resume when you’re ready.',
  test_mode: 'Waiting because email is in test mode and this person isn’t on your test list. They will get nothing until you switch to live and press Resume.',
};

/** What happened after a button press, in one or two plain sentences. */
export function ppFlowCommandMessage(result: PpFollowupCommandResult): string {
  const again = result.replayed ? ' You had already done this, so nothing was done twice.' : '';
  if (result.action === 'enrol') {
    if (result.changed && result.heldForTest) return `Added, but waiting for you. Email is in test mode and this person isn’t on your test list, so they will get nothing yet. Switch to live, then press Resume.${again}`;
    if (result.changed) return `Done: 1 person started.${again}`;
    const why = result.reason === 'not_permitted' ? 'This person hasn’t agreed to marketing emails, has unsubscribed, or their address has changed.'
      : result.reason === 'already_enrolled' ? 'This person has already been started in this version of the flow.'
      : result.reason === 'older_version_open' ? 'This person is still in an older version of this flow. Stop them there first.' : 'Please try again.';
    return `Not started. ${why}${again}`;
  }
  const verb = { pause: 'paused', resume: 'resumed', cancel: 'stopped', stop: 'stopped' }[result.action];
  const parts = [result.changed ? `Done: ${people(result.changed)} ${verb}.` : result.blocked ? `No one was ${verb}.` : `No one needed to be ${verb}.`];
  if (result.blocked) parts.push(`${result.blocked} couldn’t be changed; see below.`);
  if (result.heldForTest) parts.push(`${people(result.heldForTest)} ${result.heldForTest === 1 ? 'isn’t' : 'aren’t'} on your test list and must wait until you switch to live.`);
  const left = result.remaining - result.blocked;
  if (left > 0) parts.push(`${people(left)} still to do. Press the button again.`);
  if (result.inFlight) parts.push(`An email was already going out to ${people(result.inFlight)}. It may still arrive.`);
  return parts.join(' ') + again;
}

/** A small page for a refused action, with a way back to a fresh copy of the flow page. */
export function renderPortalFlowProblem(message: string, back: string = BASE): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Follow-up flows</title><style>body{margin:0;background:#f4f3ef;color:#172b30;font:17px/1.65 system-ui,sans-serif}main{max-width:640px;margin:auto;padding:32px 16px}section{background:#fff;border:1px solid #d2dbdb;border-radius:18px;padding:28px}a{display:inline-block;padding:14px 20px;border-radius:9px;background:#f2b440;color:#172b30;font-weight:700;text-decoration:none}</style></head><body><main><section role="alert"><p>${e(message)}</p><a href="${e(back)}">Back to your follow-ups</a></section></main></body></html>`;
}

function setupNote(problems: readonly string[]): string {
  return `<div class="notice"><p><strong>Email sending isn’t set up yet.</strong> Nothing will be sent. Your flow is saved.</p>
    <details><summary>For your developer</summary><ul>${problems.map(problem => `<li>${e(problem)}</li>`).join('')}</ul></details></div>`;
}
function runCard(run: PpFollowupRun, page: PortalFlowPageInput, detail: PortalFlowReview): string {
  const fields = hidden('csrf', page.csrf) + hidden('commandId', page.commandId) + hidden('itemId', run.contentItemId) + hidden('versionId', run.contentVersionId) + hidden('runId', run.id);
  const control = (action: string, label: string) => `<form method="post" action="${BASE}/${action}">${fields}${hidden('ackProofId', '')}<button class="secondary">${e(label)}</button></form>`;
  const open = ['active', 'paused', 'held'].includes(run.state), unsure = open && Boolean(run.unknownProofId);
  // "Email 2 of 3" only when the person is in the version on screen; an older version may have other steps.
  const sameVersion = run.contentVersionId === detail.review.contentVersionId;
  const emailPositions = detail.definition.steps.map((step, position) => step.kind === 'wait' ? -1 : position).filter(position => position >= 0);
  const emailNumber = (position: number) => sameVersion && emailPositions.includes(position) ? emailPositions.indexOf(position) + 1 : 0;
  const current = emailNumber(run.position);
  const progress = run.state === 'completed' ? 'all emails sent' : !sameVersion ? 'an earlier version of this flow' : current ? `email ${current} of ${emailPositions.length}` : '';
  const waiting = run.steps.find(step => step.position === run.position && !step.acceptedAt && !step.cancelled && !step.failed);
  const tooOld = open && !run.inFlight && Boolean(waiting && Date.parse(waiting.expiresAt) <= (page.now ?? Date.now()));
  const timing = run.state === 'active' ? `<p>Next email: ${e(when(run.dueAt))} (UK time).</p>` : run.state === 'paused' ? '<p>Nothing goes out while paused.</p>' : '';
  // Resume is only offered when it can work: not for an email past its time, and not once a newer version exists.
  const canResume = ['paused', 'held'].includes(run.state) && !tooOld && run.reason !== 'newer_sequence';
  return `<article class="run"><h3>${e(run.displayName || run.email)}</h3><p class="note">${e(run.email)} · <strong>${e(STATE_LABELS[run.state])}</strong>${progress ? ` · ${e(progress)}` : ''}</p>
    ${run.reason && !(unsure && canResume) ? `<p>${e(REASONS[run.reason] ?? 'Have a look at this person before continuing.')}</p>` : ''}
    ${tooOld ? '<p class="notice">This email has waited too long to send now. Stop this person. Start them in a new version of the flow if you still want to reach them.</p>' : ''}
    ${run.inFlight ? '<p class="notice">An email is going out right now. If you stop, this one may still arrive.</p>' : ''}
    ${timing}${run.lastAcceptedAt ? `<p>Last email sent: ${e(when(run.lastAcceptedAt))} (UK time).</p>` : ''}
    ${run.steps.length ? `<ol>${run.steps.map(step => { const number = emailNumber(step.position);
      return `<li>${number ? `Email ${number}` : 'Email'}: ${step.acceptedAt ? `sent ${e(when(step.acceptedAt))}` : step.cancelled ? 'stopped' : step.failed ? 'couldn’t send' : step.inFlight ? 'going out now' : 'waiting'}.</li>`; }).join('')}</ol>` : '<p class="note">Nothing has been sent yet.</p>'}
    <div class="actions">${run.state === 'active' ? control('pause', 'Pause this person') : ''}${canResume && !unsure ? control('resume', 'Resume this person') : ''}
    ${open ? control('stop', 'Stop this person') : ''}</div>
    ${unsure && canResume ? `<form class="notice" method="post" action="${BASE}/resume">${fields}<p><strong>We’re not sure this email went out.</strong> Check Postmark for this person first. Send it again? They might get it twice.</p><label class="check"><input type="checkbox" name="ackProofId" value="${e(run.unknownProofId!)}" required> I’ve checked Postmark. Send it again.</label><button class="secondary" ${run.inFlight ? 'disabled' : ''}>Send it again</button></form>` : ''}</article>`;
}
function searchForm(detail: PortalFlowReview, search: string): string {
  const here = `${BASE}?item=${encodeURIComponent(detail.review.contentItemId)}&version=${encodeURIComponent(detail.review.contentVersionId)}`;
  return `<form method="get" action="${BASE}" role="search">${hidden('item', detail.review.contentItemId)}${hidden('version', detail.review.contentVersionId)}<label>Find a person by name or email<input type="search" name="q" maxlength="100" value="${e(search)}"></label><div class="actions"><button class="secondary">Search</button>${search ? `<a href="${e(here)}">Show everyone</a>` : ''}</div></form>`;
}
function startControls(page: PortalFlowPageInput, detail: PortalFlowReview, published: boolean): string {
  const delivery = page.snapshot.delivery;
  if (!delivery) return `${setupNote(['Follow-up email delivery is not composed on this deployment: migration 0152 is not applied or the Property Predator workspace id is not configured.'])}<button disabled type="button">Start a person</button>`;
  // Real readiness first: a mode of test or live means nothing unless every setting is complete and a sender runs.
  const ready = page.snapshot.readiness.email, database = delivery.database, mode = delivery.mode, search = delivery.search ?? '';
  const modeNote = !ready ? setupNote(delivery.problems.length ? delivery.problems : [mode === 'off' ? 'PP_MARKETING_MODE is off. Set it to test or live once the Postmark settings are in place.' : 'Email delivery did not pass its start-up checks.'])
    : mode === 'test' ? '<p class="notice"><strong>Email sending is in test mode.</strong> Only your test addresses get emails. Anyone else you start waits until you switch to live and press Resume.</p>'
    : '<p><strong>Email sending is on.</strong> People you start will get these emails.</p>';
  const savedFields = hidden('csrf', page.csrf) + hidden('commandId', page.commandId) + hidden('itemId', detail.review.contentItemId) + hidden('versionId', detail.review.contentVersionId);
  if (!database) return `${modeNote}<p class="notice">We can’t show people right now. Nothing was changed. Please refresh this page in a minute.</p>`;
  const blockers = detail.blockers.filter(key => key !== 'email_not_connected' || ready);
  const blocked = !published || detail.blockers.length > 0 || !ready;
  const choices = database.contacts;
  const enrol = blocked ? `<button disabled type="button">Start this person</button><p class="note">${!published ? 'Publish this flow first.' : !ready ? 'Email sending isn’t set up yet.' : 'Sort out the notes above first.'}</p>`
    : choices.length ? `<form method="post" action="${BASE}/enrol">${savedFields}<label>Who do you want to start?<select name="contactPointId" required>${choices.map(contact => `<option value="${e(contact.contactPointId)}">${e(contact.displayName)} · ${e(contact.email)}${contact.inOpenRun ? ' · already in a flow' : ''}</option>`).join('')}</select></label>${database.contactMatches > choices.length ? `<p class="note">Showing the first ${choices.length} of ${database.contactMatches}. Search above to find someone else.</p>` : ''}<button data-saved-required>Start this person</button></form>`
    : search ? `<p>No one who has agreed to marketing emails matches “${e(search)}”.</p>`
    : '<p>No one has agreed to marketing emails yet. Record their permission on the lead first.</p>';
  const everyone = (action: 'pause' | 'resume', label: string) => `<form method="post" action="${BASE}/${action}">${savedFields}${hidden('runId', '')}${hidden('ackProofId', '')}<button class="secondary">${label}</button></form>`;
  return `${modeNote}<h3>Start a person</h3><p>${database.permitted === 1 ? '1 person has' : `${database.permitted} people have`} agreed to marketing emails. Only they can be started.</p><p class="note">We check again before every email. If someone unsubscribes, their emails stop.</p>
    ${blockers.length ? `<div class="notice"><strong>Before you can start anyone</strong><ul>${blockers.map(key => `<li>${e(BLOCKERS[key] ?? 'This flow needs another look before it can start.')}</li>`).join('')}</ul></div>` : ''}${searchForm(detail, search)}${enrol}
    <h3>Everyone in this flow</h3><div class="actions">${everyone('pause', 'Pause everyone')}${everyone('resume', 'Resume everyone')}</div>
    <details><summary>Stop everyone in this flow</summary><p>This stops every person in this flow. It can’t be undone. An email that is already going out may still arrive.</p><form method="post" action="${BASE}/stop">${savedFields}${hidden('runId', '')}${hidden('ackProofId', '')}<button class="secondary">Yes, stop everyone</button></form></details>
    <p class="note">Sent does not always mean it reached their inbox.</p>`;
}
export function renderPortalFlowPage(page: PortalFlowPageInput): string {
  const { snapshot, detail } = page, published = Boolean(detail?.valid && detail.review.isLatest && detail.review.approvalStatus === 'approved' && !detail.review.approvalStale);
  const draft = page.draft ?? (detail ? { commandId: page.commandId, contentItemId: detail.review.contentItemId, previousVersionId: detail.review.contentVersionId, definition: detail.definition } : undefined);
  const definition = page.preview?.definition ?? draft?.definition as FollowupSequenceDefinition | undefined;
  const editor = draft && definition ? renderFlowEditor({ profile: { brand: 'pp', base: BASE, libraryHref: null, futureWebinarEntry: false }, csrf: page.csrf, commandId: draft.commandId,
    contentItemId: draft.contentItemId, previousVersionId: draft.previousVersionId, definition, inlineMessages: draft.inlineMessages as Readonly<Record<string, FlowInlineMessage>> | undefined,
    choices: snapshot.messageChoices, detail: detail ? { versionNumber: detail.review.versionNumber, published, isLatest: detail.review.isLatest } : undefined }) : '';
  const journey = page.preview ?? detail, previews = page.preview?.messagePreviews ?? detail?.messages.map(message => previewFlowMessage(message.channel, message.payload)) ?? [];
  const timeline = journey ? `<section class="card"><h2>Planned journey</h2><p>This is the order your messages go out in.</p><p>Each wait starts when the message before it was sent. A wait at the very start begins when you start the person. If a message can’t be sent, nothing after it goes out.</p>
    <ol>${journey.timeline.map(step => { const first = step === journey.timeline[0], wait = waitText(step.waitMinutes);
      return `<li><strong>${step.step.kind === 'email' ? 'Email' : step.step.kind === 'sms' ? 'Text message' : 'WhatsApp message'}</strong> · ${wait ? `${wait} after ${first ? 'you start the person' : 'the message before it'}` : first ? 'as soon as you start the person' : 'straight after the message before it'}.</li>`; }).join('')}</ol>
    ${journey.blockers.length ? '<p class="notice">You can edit and save this flow now. A few things need sorting before anyone can be started; they are listed further down.</p>' : ''}</section>` : '';
  const controls = detail ? `<section class="card"><h2>${published ? 'Published flow' : 'Publish your flow'}</h2><p>Publishing says “these are the emails I want to send”. It doesn’t send anything or start anyone.</p>
    ${!published && detail.review.isLatest ? `<form method="post" action="${BASE}/publish"><input type="hidden" name="csrf" value="${e(page.csrf)}"><input type="hidden" name="commandId" value="${e(page.commandId)}"><input type="hidden" name="itemId" value="${e(detail.review.contentItemId)}"><input type="hidden" name="versionId" value="${e(detail.review.contentVersionId)}"><button data-saved-required ${!detail.valid ? 'disabled' : ''}>Publish flow</button></form>` : ''}
    ${!detail.valid ? '<p class="notice">Your brand details have changed since this was saved. Save the flow again, then check its emails.</p>' : ''}${startControls(page, detail, published)}</section>` : '';
  const database = detail ? snapshot.delivery?.database : null, search = snapshot.delivery?.search ?? '';
  const runs = detail && database ? database.runs.filter(run => run.contentItemId === detail.review.contentItemId) : [];
  const peopleSection = detail && database ? `<section class="card"><h2>People in this flow</h2><p>${search ? `Showing people who match “${e(search)}”.` : `${people(database.runMatches)} so far.`}${database.runMatches > runs.length ? ` Showing the newest ${runs.length} of ${database.runMatches}. Search by name or email above to find someone else.` : ''}</p>${runs.map(run => runCard(run, page, detail)).join('') || `<p>${search ? 'No one in this flow matches that search.' : 'No one has been started in this flow yet.'}</p>`}</section>` : '';
  const sending = !snapshot.executable ? 'Email sending isn’t set up yet. You can still write, preview and save flows.'
    : snapshot.delivery?.mode === 'test' ? 'Email sending is in test mode. Publish a flow, then choose who to start.' : 'Email sending is on. Publish a flow, then choose who to start.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Follow-up flows · ${e(snapshot.brand.productName)}</title><style>
    body{margin:0;background:#f4f3ef;color:#172b30;font:17px/1.65 system-ui,sans-serif}header,main{max-width:1080px;margin:auto;padding:24px}header,nav,.actions{display:flex;gap:14px;flex-wrap:wrap;align-items:center}header{justify-content:space-between}a{color:${snapshot.brand.primaryColor ?? '#164756'}}h1{font:clamp(34px,5vw,50px)/1.15 Georgia,serif}h2{font-size:27px}h3{font-size:21px}.card{background:#fff;border:1px solid #d2dbdb;border-radius:18px;padding:clamp(20px,4vw,38px);margin:0 0 24px;min-width:0}.eyebrow{font-weight:800;font-size:14px;letter-spacing:.08em;text-transform:uppercase}.note{font-size:17px;color:#465b60}.notice{border-left:4px solid #bd8a31;background:#faf3e5;padding:16px;margin:20px 0}.run{padding:22px 0;border-top:1px solid #d5dddd}label{display:block;font-weight:700;margin:20px 0}input:not([type=hidden]):not([type=checkbox]),select{display:block;box-sizing:border-box;width:100%;max-width:100%;padding:13px;margin-top:7px;border:1px solid #9daeb0;border-radius:8px;font:17px/1.5 system-ui;background:#fff;color:#172b30}.check{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}.check input{margin-top:8px;width:20px;height:20px}button,.button{display:inline-block;max-width:100%;padding:14px 20px;border:0;border-radius:9px;background:${snapshot.brand.accentColor ?? '#f2b440'};color:#172b30;font:700 17px/1.4 system-ui;cursor:pointer;text-decoration:none}.secondary{background:#eaf0ef;border:1px solid #adbdbe}button:disabled{opacity:.55;cursor:not-allowed}details{margin:20px 0}summary{cursor:pointer;font-weight:700}.sequence-step{padding:20px;border:1px solid #bdcbca;border-radius:12px;background:#fafcfa;margin:18px 0;min-width:0}.sequence-step.drag-over{outline:3px solid #bd8a31}.drag-handle{cursor:grab}a,button,input,select,pre{overflow-wrap:anywhere}p{max-width:75ch}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #83510c;outline-offset:3px}@media(max-width:480px){header,main{padding:16px}.actions>*{max-width:100%}.actions button{width:100%}.sequence-step{padding:14px}}
    </style><script src="${BASE}/editor.js" defer></script></head><body><header><strong>${e(snapshot.brand.productName)}</strong><nav aria-label="Workspace navigation"><a href="/portal">Growth HQ workspace</a><a href="/portal/crm/opportunities">Lead board</a><a href="${LIVE_CHANNELS_ROUTE}">Channel setup</a></nav></header><main>
    ${page.message ? `<section class="card notice" role="status">${e(page.message)}</section>` : ''}<section class="card"><div class="eyebrow">Growth HQ · Property Predator</div><h1>Build the follow-up.<br>Start people when you’re ready.</h1><p>Write your follow-up messages in one flow. Preview them and try a practice run before anyone gets anything.</p><p class="notice"><strong>${sending}</strong> Saving, previewing and publishing never send anything.</p><a class="button" href="${BASE}?new=1">Create a flow</a></section>
    ${editor}${timeline}${renderFlowMessagePreviews(previews)}${renderFlowSimulation(page.simulation)}${controls}${peopleSection}
    <section class="card"><h2>Not available yet</h2><p>Only emails can be sent from a flow today. Text messages and WhatsApp messages can be written and saved, but not sent yet.</p><p>Stopping automatically when someone replies, books or buys isn’t available yet either.</p><div class="actions"><a class="button secondary" href="${LIVE_CHANNELS_ROUTE}">Channel setup</a><a class="button secondary" href="${PROVIDER_CONNECTIONS_ROUTE}">Connections</a></div></section>
    <section class="card"><h2>Your saved flows</h2>${snapshot.catalog.items.length ? `<ul>${snapshot.catalog.items.map(item => `<li><a href="${BASE}?item=${e(item.contentItemId)}&version=${e(item.contentVersionId)}">${e(item.title)}</a> · version ${item.versionNumber} · ${item.approvalStatus === 'approved' && !item.approvalStale ? 'published' : 'draft'}</li>`).join('')}</ul>` : '<p>No flows saved yet.</p>'}<p class="note">Your 50 most recent flows are listed here.</p></section></main></body></html>`;
}
