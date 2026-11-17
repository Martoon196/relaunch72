import { randomUUID } from 'node:crypto';
import { escapeHtml as e } from '../portal/ui.js';
import { FOLLOWUP_SEQUENCE_V2_SCHEMA, followupEntryIntent, type FollowupSequenceDefinition } from '../followup-sequences/definition.js';
import type { FollowupRunState } from '../followup-sequences/state.js';
import { renderFlowEditor } from '../followup-sequences/editor-view.js';
import { renderFlowMessagePreviews, renderFlowSimulation } from '../followup-sequences/preview-view.js';
import { previewFlowMessage } from '../followup-sequences/channel-drafts.js';
import type { FlowInlineMessage } from '../followup-sequences/composition.js';
import type { simulateFollowupFlow } from '../followup-sequences/simulation.js';
import type { FollowupEntryRule } from '../followup-sequences/entry.js';
import { followupAudienceCanStart, FOLLOWUP_NO_AUDIENCE_LINE, type FollowupAudience } from '../followup-sequences/audience.js';
import { marketingReturnControl } from './marketing-workspace-view.js';
import { MHP_OWNER_NAV, MHP_OWNER_STYLES } from './owner-frame.js';
import { mhpRunResumable, MHP_UNRESUMABLE_REASONS } from './followup-sequence-service.js';
import type { MhpResumePlan, MhpSequenceReview, MhpSequenceSaveInput, MhpSequenceSnapshot, MhpSequenceRun, MhpStartPlan, MhpStartRecipient } from './followup-sequence-service.js';

/** A short, signed record of what the owner's last action did, carried across the redirect after it. Never names or addresses. */
export type MhpSequenceNote =
  | { c: 'p'; a: 'pause' | 'resume' | 'stop' | 'cancel'; o: 'done' | 'already' | 'used' | 'blocked' | 'not_ready' | 'unchanged' | 'gone' | 'no_audience' | 'newer_version'; r: string; f: number }
  | { c: 'b'; a: 'pause' | 'resume' | 'stop'; n: number; m: number; k: number; f: number; r: number }
  /** Start: n started of e confirmed; x added unseen, y of them paused (z: everyone paused instead); o started from another tab; q no longer able to receive it. */
  | { c: 's'; n: number; e: number; x: number; y: number; z: number; o: number; q: number; w: number; r: number; f: number }
  | { c: 'a'; n: number }
  | { c: 'e'; a: 'on' | 'off'; u: string; r: number }
  | { c: 'pub' };
export interface MhpSequencePageInput {
  snapshot: MhpSequenceSnapshot; csrf: string; commandId: string; returnCommandId: string;
  detail?: MhpSequenceReview; draft?: MhpSequenceSaveInput;
  preview?: { definition: FollowupSequenceDefinition; timeline: MhpSequenceReview['timeline']; blockers: readonly string[]; messagePreviews?: readonly ReturnType<typeof previewFlowMessage>[] };
  simulation?: ReturnType<typeof simulateFollowupFlow>;
  /** Plain-English status line (preview/simulate results). */
  message?: string;
  note?: MhpSequenceNote;
  now?: number;
}
const BASE = '/hq/marketing/sequences';
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${e(value)}">`;
const time = (value: string | null) => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const waitWords = (minutes: number) => minutes === 0 ? 'straight away' : minutes % 1440 === 0 ? plural(minutes / 1440, 'day') : minutes % 60 === 0 ? plural(minutes / 60, 'hour') : plural(minutes, 'minute');
export const sequenceHref = (itemId: string, versionId: string, extra = '') => `${BASE}?item=${encodeURIComponent(itemId)}&version=${encodeURIComponent(versionId)}${extra}`;
const blockers: Readonly<Record<string, string>> = {
  email_not_connected: 'Email sending is switched off or not connected, so nothing can be sent yet.',
  email_version_not_ready: 'One of the emails in this sequence is not published, or has changed since. Open the email library, publish the current wording of each email, then come back.',
  sms_not_connected: 'Text messages are not set up for Martin Howard Property yet.',
  whatsapp_not_connected: 'WhatsApp is not set up for Martin Howard Property yet.',
  reply_stop_not_connected: '“Stop when they reply” cannot be detected yet. Untick it to start this sequence.',
  booked_stop_not_connected: '“Stop when they book” cannot be detected yet. Untick it to start this sequence.',
  purchased_stop_not_connected: '“Stop when they buy” cannot be detected yet. Untick it to start this sequence.',
};
const REASONS: Readonly<Record<string, string>> = {
  newer_sequence: 'You saved a newer version of this sequence, so this person is on hold. Stop them, then start the new version, if they should get the new emails.',
  content_changed: 'One of the emails changed after this person started, so they are on hold until you check it.',
  outcome_unknown: 'We could not confirm whether their last email went. Check before retrying, because retrying could send it twice.',
  unsubscribed: 'Stopped because this person unsubscribed or no longer agrees to emails.',
  delivery_expired: 'Their email could not be sent in time, so nothing more was sent.',
  delivery_failed: 'Their email could not be sent, so nothing more was sent.',
  manual: 'You stopped this person.', recovery: 'Put on hold during a system check. Resume them when you are ready.',
};
const STATES: Readonly<Record<FollowupRunState, { label: string; tone: string }>> = {
  active: { label: 'Active', tone: 'active' }, paused: { label: 'Paused', tone: 'paused' }, held: { label: 'On hold', tone: 'paused' },
  completed: { label: 'Finished', tone: 'done' }, stopped: { label: 'Stopped', tone: 'stopped' }, cancelled: { label: 'Removed', tone: 'stopped' }, failed: { label: 'Could not send', tone: 'failed' },
};
const badge = (state: FollowupRunState) => `<span class="badge badge-${STATES[state]?.tone ?? 'stopped'}">${e(STATES[state]?.label ?? 'Unknown')}</span>`;
const PAGE_STYLES = `${MHP_OWNER_STYLES}summary{min-height:44px;display:flex;align-items:center}.card p>a:only-child{display:inline-flex;align-items:center;min-height:44px}.library a{display:inline-flex;align-items:center;min-height:44px}.toplinks a{display:inline-flex;align-items:center;min-height:44px}label{display:block;font-weight:700;margin:20px 0}input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select{display:block;box-sizing:border-box;max-width:100%;width:100%;margin-top:7px;padding:13px;border:1px solid #9da99b;border-radius:8px;font:17px/1.5 system-ui;background:white;color:#142019}.check{display:flex;gap:12px;align-items:flex-start}.check input{margin-top:6px;width:22px;height:22px;flex:none}.sequence-step{padding:20px;border:1px solid #c7d0c4;border-radius:12px;background:#fafbf8;margin:18px 0;min-width:0}.sequence-step.drag-over{outline:3px solid #e8a33d}.sequence-step h3{margin-top:0}.drag-handle{cursor:grab}.run{padding:24px 0;border-top:1px solid #d9ded4;min-width:0}.library{list-style:none;padding:0}.library li{padding:16px 0;border-top:1px solid #d9ded4}.people{list-style:none;padding:0;margin:0}.person{border-top:1px solid #d9ded4;padding:18px 0;min-width:0;scroll-margin-top:16px}.person:target{background:#fffaf0;box-shadow:0 0 0 3px #e8a33d;border-radius:12px;padding:18px 14px}.person-head{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}.person-head h3{margin:0;font-size:20px;overflow-wrap:anywhere}.badge{display:inline-block;border-radius:999px;padding:4px 12px;font-size:15px;font-weight:800;white-space:nowrap}.badge-active{background:#dff1e5;color:#174d2e}.badge-paused{background:#fbe9c8;color:#6b4206}.badge-done{background:#e3e9f3;color:#21385c}.badge-stopped{background:#ecebe6;color:#3d443e}.badge-failed{background:#f8dcd8;color:#7a1f14}.counts{font-size:19px;font-weight:700}.person p{margin:6px 0}.person .actions{margin-top:10px}details{margin-top:10px}summary{cursor:pointer;font-weight:700;color:#215c3d;padding:6px 0}.list{border:1px solid #d9ded4;border-radius:12px;padding:0;margin:12px 0;list-style:none}.list li{padding:10px 14px;border-top:1px solid #eceee8;overflow-wrap:anywhere}.list li:first-child{border-top:0}.confirm-box{border:2px solid #e8a33d;border-radius:12px;padding:16px;margin:20px 0;background:#fffaf0}.toplinks{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:0 0 16px}`;
function frame(title: string, body: string, script = true): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)} · MHP Growth HQ</title><style>${PAGE_STYLES}</style>${script ? `<script src="${BASE}/editor.js" defer></script>` : ''}</head><body>${MHP_OWNER_NAV}<main>${body}</main></body></html>`;
}
export function mhpSequenceNewDraft(campaign: string, commandId: string): MhpSequenceSaveInput {
  return { commandId, contentItemId: '', previousVersionId: '', audience: 'none_yet', definition: { schema: FOLLOWUP_SEQUENCE_V2_SCHEMA, entry: { mode: 'manual', source: 'manual_owner' }, brand: 'mhp', campaign,
    title: 'New follow-up sequence', expiryHours: 24, stopOn: { reply: false, booked: false, purchased: false }, steps: [] } };
}
/** "people who registered for “Label” (the webinar on Tuesday 3 November 2026) and agreed to emails". */
export const webinarWords = (webinar?: { label: string | null; date: string | null }) => webinar?.label ? `“${webinar.label}”${webinar.date ? ` (the webinar on ${webinar.date})` : ''}` : webinar?.date ? `the webinar on ${webinar.date}` : 'the current webinar';
export function audienceWords(audience: FollowupAudience, webinar?: { label: string | null; date: string | null }): string {
  if (audience.kind === 'none_yet') return 'No one yet. This sequence has no audience that can be started.';
  return `People who registered for ${webinarWords(webinar)} and agreed to emails`;
}
/** When the page cannot see everyone (it reads the 100 most recent people of the whole webinar), every count is a minimum and says so. */
function counts(runs: readonly MhpSequenceRun[], atLeast = false): string {
  const n = (states: readonly FollowupRunState[]) => runs.filter(run => states.includes(run.state)).length;
  const main = `${atLeast ? 'At least ' : ''}${n(['active'])} active, ${n(['paused', 'held'])} paused, ${n(['completed'])} finished, ${n(['stopped', 'cancelled'])} stopped`;
  const failed = n(['failed']);
  return failed ? `${main}, ${failed} could not be sent` : main;
}
const truncatedOf = (page: MhpSequencePageInput) => page.snapshot.database.runs.length < page.snapshot.database.runCount;
const personName = (run: { firstName: string | null; email: string }) => run.firstName?.trim() || run.email;
function personNote(note: Extract<MhpSequenceNote, { c: 'p' }>, run: MhpSequenceRun | undefined): string {
  const name = run ? personName(run) : 'This person';
  const state = run ? (STATES[run.state]?.label ?? 'changed').toLowerCase() : 'no longer listed';
  const verb = { pause: 'paused', resume: 'resumed', stop: 'stopped', cancel: 'removed' }[note.a];
  const lines: Record<typeof note.o, string> = {
    done: note.a === 'pause' ? `Paused. Nothing more is sent to ${name} until you resume them.` : note.a === 'resume' ? `Resumed. ${name}'s next email goes when it is due.`
      : note.a === 'stop' ? `Stopped. Nothing more will be sent to ${name}.` : `Removed from this version. Nothing more from it will be sent to ${name}.`,
    already: `${name} was already ${verb}. Nothing was changed.`,
    used: `That button had already been used earlier. ${name} is ${state} now. Press the button again if you still want them ${verb}.`,
    blocked: `${name} could not be resumed: their permission, an email or an earlier send needs checking first. Nothing was sent.`,
    no_audience: `${name} was not restarted: this sequence has no audience yet, so nobody in it can be restarted here. Nothing was sent. You can stop them.`,
    newer_version: `${name} was not restarted: they are on hold because you saved a newer version of this sequence. Nothing was sent. Stop them here, then start the new version if it is meant for them.`,
    not_ready: `${name} could not be resumed because this sequence is not ready to send. See the setup notes at the top.`,
    unchanged: `${name} had already changed before your press, so nothing was done. They are ${state} now.`,
    gone: 'That person is no longer listed in this sequence, so nothing was done.',
  };
  return `${lines[note.o]}${note.f && note.o === 'done' && note.a !== 'resume' ? ' An email that was already on its way to them may still arrive.' : ''}`;
}
const SUCCESS: readonly string[] = ['done', 'already'];
const noteBox = (note: Extract<MhpSequenceNote, { c: 'p' }>, run: MhpSequenceRun | undefined) =>
  `<p class="${SUCCESS.includes(note.o) ? 'good' : 'notice'}" role="status">${e(personNote(note, run))}</p>`;
function topNote(note: MhpSequenceNote | undefined): string {
  if (!note || note.c === 'p') return '';
  let text: string, details = '';
  if (note.c === 'pub') text = 'Published. Nobody was emailed. When you are ready, press Start: you will see exactly who gets it before anything is sent.';
  else if (note.c === 'a') text = `This sequence had already been started for these ${plural(note.n, 'person', 'people')}. Pressing the button again sent nothing new.`;
  else if (note.c === 'e') text = note.r ? `That ${note.a === 'on' ? 'switch-on' : 'switch-off'} had already been done earlier; nothing new happened. The current setting is shown below.`
    : note.a === 'on' ? `Automatic sign-ups are on. New webinar sign-ups who agree to emails will be added until ${time(note.u)} (UK time). Nobody who registered earlier was added.`
      : 'Automatic sign-ups are off. Nobody new will be added. People already in the sequence carry on; pause them if you want them to stop.';
  else if (note.c === 'b') {
    text = note.r && !note.n ? `That button had already been used earlier, so nothing new happened. Here is where everyone is now.`
      : note.a === 'pause' ? (note.n ? `Paused ${plural(note.n, 'person', 'people')}. Nothing more is sent until you resume them.` : 'Nobody was active, so nobody needed pausing.')
        : note.a === 'stop' ? (note.n ? `Stopped ${plural(note.n, 'person', 'people')}. Nothing more from this sequence will ever be sent to them.` : 'Nobody needed stopping.')
          : (note.n ? `Resumed ${plural(note.n, 'person', 'people')}. Their next emails go when they are due.` : 'Nobody was resumed.');
    if (note.m) text += ` ${plural(note.m, 'more person', 'more people')} could not be ${note.a === 'pause' ? 'paused' : note.a === 'stop' ? 'stopped' : 'resumed'} in one go. Press the button again.`;
    if (note.k) text += ` ${plural(note.k, 'person', 'people')} need checking on their own card first.`;
    if (note.f && note.a === 'pause') text += ` ${note.f === 1 ? 'One email that was' : `${note.f} emails that were`} already on the way may still arrive.`;
    details = `${note.n} changed · ${note.m} left · ${note.k} need checking · ${note.f} already being sent`;
  } else {
    text = note.r ? 'This sequence had already been started with this confirmation. Nothing new was sent.'
      : note.n === 0 && note.o === note.e ? 'These people had already been started from another tab. Nothing new was sent.'
      : `Started for ${plural(Math.max(0, note.n - note.x), 'person', 'people')}. ${note.w === 0 ? `Their first email is going now.` : `Their first email goes in ${waitWords(note.w)}.`}`;
    if (note.o && !(note.n === 0 && note.o === note.e)) text += ` ${note.o === 1 ? 'One of these people had' : `${note.o} of these people had`} already been started from another tab.`;
    if (note.q) text += ` ${plural(note.q, 'person', 'people')} you confirmed were not started, because they can no longer receive it (for example they unsubscribed).`;
    if (note.x) text += note.z
      ? ` ${plural(note.x, 'person', 'people')} not on your list ${note.x === 1 ? 'was' : 'were'} added to this sequence at the same moment (a new sign-up, or the automatic sign-up rule), and this page could not see exactly who. To be safe, everyone active in this sequence has been paused (${note.y}); a first email may already have gone. Check the list, then resume everyone you meant to start.`
      : ` ${plural(note.x, 'person', 'people')} not on your list ${note.x === 1 ? 'was' : 'were'} added to this sequence at the same moment (a new sign-up, or the automatic sign-up rule). ${note.y ? `${note.y === 1 ? 'They have' : `${note.y} of them have`} been paused straight away, so nothing more is sent until you decide; a first email may already have gone.` : 'They were not active, so nothing more is sent to them.'}`;
    details = `${Math.max(0, note.n - note.x)} started of ${note.e} confirmed · ${note.o} already started from another tab · ${note.q} no longer able to receive it · ${note.x} added without your confirmation (${note.y} paused) · ${note.f} already being sent`;
  }
  return `<section class="card good" role="status" id="result"><p><strong>${e(text)}</strong></p>${details ? `<details><summary>Details</summary><p class="note">${e(details)}</p></details>` : ''}</section>`;
}
function messageLabel(detail: MhpSequenceReview | undefined, run: MhpSequenceRun): string {
  if (!detail || run.contentVersionId !== detail.review.contentVersionId) return 'their next email';
  const index = detail.timeline.findIndex(step => step.position === run.position);
  if (index < 0) return 'their next email';
  const step = detail.timeline[index]!, subject = detail.subjects?.[step.step.contentVersionId];
  return `${step.step.kind === 'email' ? 'email' : 'message'} ${index + 1} of ${detail.timeline.length}${subject ? ` (“${subject}”)` : ''}`;
}
function personCard(run: MhpSequenceRun, page: MhpSequencePageInput, detail: MhpSequenceReview): string {
  const fields = () => hidden('csrf', page.csrf) + hidden('commandId', randomUUID()) + hidden('itemId', detail.review.contentItemId)
    + hidden('versionId', detail.review.contentVersionId) + hidden('runId', run.id);
  const control = (action: string, label: string, secondary = false) => `<form method="post" action="${BASE}/${action}">${fields()}${hidden('ackProofId', '')}<button${secondary ? ' class="secondary"' : ''}>${e(label)}</button></form>`;
  const open = ['active', 'paused', 'held'].includes(run.state), now = page.now ?? Date.now();
  const what = messageLabel(detail, run);
  const next = run.state === 'active' ? `Next: ${what}, ${Date.parse(run.dueAt) <= now ? 'due now' : `${time(run.dueAt)} (UK time)`}.`
    : run.state === 'paused' || run.state === 'held' ? `Paused before ${what}. Nothing is sent to them.`
      : run.state === 'completed' ? 'Finished: every email in the sequence has gone.' : 'Nothing more will be sent.';
  const note = page.note?.c === 'p' && page.note.r === run.id ? noteBox(page.note, run) : '';
  const canStart = followupAudienceCanStart(detail.audience, page.snapshot.database.campaign), waiting = run.state === 'paused' || run.state === 'held';
  // Resume is only offered when it can work: the sequence has a startable audience and the person is not held for a reason the database refuses.
  const main = run.state === 'active' ? control('pause', 'Pause this person') : waiting && canStart && mhpRunResumable(run) ? control('resume', 'Resume this person')
    : waiting && !run.unknownProofId ? control('stop', 'Stop this person', true) : '';
  const why = waiting && !canStart ? 'This sequence has no audience yet, so they cannot be restarted here. You can stop them.'
    : waiting && MHP_UNRESUMABLE_REASONS.includes(run.reason ?? '') ? 'They cannot be resumed in this version.' : '';
  const history = run.steps.length ? `<ol>${run.steps.map(step => `<li>Email ${step.position + 1}: ${step.acceptedAt ? `sent ${e(time(step.acceptedAt))}` : step.cancelled ? 'not sent (cancelled)' : step.failed ? 'could not be sent' : step.inFlight ? 'being sent now' : step.held ? 'on hold' : `waiting, due ${e(time(step.dueAt))}`}</li>`).join('')}</ol>` : '<p class="note">Nothing has been sent yet.</p>';
  return `<li class="person" id="run-${e(run.id)}" tabindex="-1"><div class="person-head"><h3>${e(personName(run))}</h3>${badge(run.state)}</div>${note}
    <p class="note wrap">${e(run.email)}</p><p>${e(next)}</p>
    ${run.reason ? `<p class="note">${e(REASONS[run.reason] ?? 'Check this person before continuing.')}</p>` : ''}${why ? `<p class="note">${e(why)}</p>` : ''}
    ${run.inFlight ? '<p class="note">An email to them is being sent right now. Pausing or stopping cannot call it back.</p>' : ''}
    ${main ? `<div class="actions">${main}</div>` : ''}
    <details><summary>More for ${e(personName(run))}</summary>${history}<p class="note">“Sent” means our email service accepted it; it does not prove it reached their inbox.</p>
      ${open ? `<div class="actions">${control('stop', 'Stop this person', true)}${control('cancel', 'Remove from this version', true)}</div><p class="note">Stop: nothing more is ever sent to them from this sequence. Remove: takes them out of this version so a newer version can start them.</p>` : ''}
      ${open && run.unknownProofId ? `<form class="notice" method="post" action="${BASE}/resume">${fields()}<label class="check"><input type="checkbox" name="ackProofId" value="${e(run.unknownProofId)}" required> I checked whether their last email arrived. I understand retrying may send it twice.</label><button class="secondary" ${run.inFlight ? 'disabled' : ''}>Retry their last email</button></form>` : ''}</details></li>`;
}
function entryRuleCard(rule: FollowupEntryRule, page: MhpSequencePageInput): string {
  const fields = hidden('csrf', page.csrf) + hidden('commandId', randomUUID()) + hidden('itemId', rule.contentItemId) + hidden('versionId', rule.contentVersionId) + hidden('ruleId', rule.id);
  const reason = rule.heldReason === 'newer_sequence' ? 'A newer version of this sequence exists. Publish it and switch automatic sign-ups on for that version instead.'
    : rule.heldReason === 'content_changed' ? 'One of the emails changed. Check the current wording before switching automatic sign-ups on again.'
      : rule.heldReason === 'recovery' ? 'Paused during a system check. Switching on again only adds people who sign up from then on.' : null;
  const state = { active: 'On', held: 'On hold', off: 'Off', expired: 'Ended' }[rule.state];
  return `<article class="run"><h3>Automatic sign-ups: ${e(state)}</h3><p>Switched on ${e(time(rule.activatedAt))}. Stops adding people ${e(time(rule.expiresAt))} (UK time).</p>
    ${reason ? `<p class="notice">${e(reason)}</p>` : ''}<p>${plural(rule.enrolled, 'person', 'people')} added automatically · ${rule.skipped} skipped · ${rule.blocked} not allowed.</p>
    ${rule.state !== 'off' ? `<form method="post" action="${BASE}/entry-off">${fields}<button class="secondary">Switch off automatic sign-ups</button></form><p class="note">Switching off stops new people being added. People already in the sequence carry on; pause them if they should stop too.</p>` : ''}</article>`;
}
function publishedOf(detail: MhpSequenceReview): boolean {
  return Boolean(detail.review.isLatest && detail.review.approvalStatus === 'approved' && !detail.review.approvalStale && detail.local.valid);
}
function sequenceSummary(page: MhpSequencePageInput, detail: MhpSequenceReview): string {
  const { snapshot } = page, campaign = snapshot.database.campaign, published = publishedOf(detail);
  const runs = snapshot.database.runs.filter(run => run.contentItemId === detail.review.contentItemId);
  const savedFields = () => hidden('csrf', page.csrf) + hidden('commandId', randomUUID()) + hidden('itemId', detail.review.contentItemId) + hidden('versionId', detail.review.contentVersionId);
  const canStart = followupAudienceCanStart(detail.audience, campaign);
  const active = runs.filter(run => run.state === 'active').length, paused = runs.filter(run => run.state === 'paused' || run.state === 'held').length;
  const resumable = runs.filter(mhpRunResumable).length, open = active + paused, atLeast = truncatedOf(page), least = atLeast ? 'at least ' : '';
  const justStarted = page.note?.c === 's' || page.note?.c === 'a';
  let start: string;
  if (!detail.review.isLatest) start = '<p class="notice">This is an older version. It cannot be started. Open the latest version from your saved sequences.</p>';
  else if (!canStart && open) start = `<p class="notice"><strong>${e(active
    ? `This sequence has no audience yet, so it cannot be started or restarted here. ${least}${plural(active, 'person', 'people')} in it ${active === 1 ? 'is' : 'are'} still active and will be sent its next emails unless you pause or stop them.`
    : `This sequence has no audience yet. The ${least}${plural(paused, 'person', 'people')} in it ${paused === 1 ? 'is' : 'are'} paused and will not be sent anything. You can stop them, but not restart them here.`)}</strong></p>`
  else if (!canStart) start = `<p class="notice"><strong>${e(detail.audience.kind === 'webinar_signups' ? 'This sequence is for the sign-ups of a different webinar, so it cannot be started from here.'
    : published ? FOLLOWUP_NO_AUDIENCE_LINE : 'This sequence has no audience yet, so it cannot be started. It is saved, ready for when its audience is connected.')}</strong></p>`
    + (published ? '' : `<form method="post" action="${BASE}/publish">${savedFields()}<button class="secondary">Publish this version</button></form><p class="note">Publishing records the wording you approved. It sends nothing.</p>`);
  else if (!published) start = `<p>Publish this version first. Publishing records the wording you approved. It sends nothing and adds nobody.</p><form method="post" action="${BASE}/publish">${savedFields()}<button>Publish this version</button></form>`;
  else if (detail.blockers.length) start = `<div class="notice"><strong>Before this can start</strong><ul>${detail.blockers.map(key => `<li>${e(blockers[key] ?? 'Something in this sequence needs setting up first.')}</li>`).join('')}</ul></div>`;
  else start = justStarted
    ? `<div class="actions"><a class="button secondary" href="${e(sequenceHref(detail.review.contentItemId, detail.review.contentVersionId, '&confirm=start'))}">Check for anyone new…</a></div>`
    : `<div class="actions"><a class="button" href="${e(sequenceHref(detail.review.contentItemId, detail.review.contentVersionId, '&confirm=start'))}">Start this sequence…</a></div><p class="note">Next you will see exactly who gets it, and when, before anything is sent.</p>`;
  const link = (confirm: string, label: string) => `<a class="button secondary" href="${e(sequenceHref(detail.review.contentItemId, detail.review.contentVersionId, `&confirm=${confirm}`))}">${e(label)}</a>`;
  const bulk = [active || (atLeast && open) ? link('pause-all', `Pause everyone (${atLeast ? 'at least ' : ''}${active})`) : '',
    canStart && resumable && !atLeast ? link('resume-all', `Resume everyone (${resumable})`) : '',
    !canStart && open ? link('stop-all', `Stop everyone (${atLeast ? 'at least ' : ''}${open})`) : ''].join('');
  return `<section class="card" id="summary"><div class="eyebrow">Follow-up sequence · Version ${detail.review.versionNumber} · ${published ? 'Published' : detail.review.isLatest ? 'Draft' : 'Older version'}</div>
    <h1>${e(detail.definition.title)}</h1><p><strong>Who it is for:</strong> ${e(audienceWords(detail.audience).replace(/\.?$/u, '.'))}</p>
    <p class="counts">${runs.length ? e(counts(runs, atLeast)) : atLeast ? 'Nobody in this sequence is among the most recent people this page can see.' : 'Nobody is in this sequence yet.'}</p>
    ${atLeast ? `<p class="note">This page can see the 100 most recent people across all sequences for this webinar (${page.snapshot.database.runCount} in total), so these numbers are minimums.</p>` : ''}${start}${bulk ? `<div class="actions">${bulk}</div>` : ''}
    ${snapshot.mode === 'test' ? '<p class="note">Email is in test mode: only your test addresses actually receive anything.</p>' : snapshot.mode === 'off' ? '<p class="note">Email sending is switched off: nothing is sent until it is switched back on.</p>' : ''}</section>`;
}
function peopleSection(page: MhpSequencePageInput, detail: MhpSequenceReview): string {
  const runs = page.snapshot.database.runs.filter(run => run.contentItemId === detail.review.contentItemId);
  const truncated = truncatedOf(page);
  const order: Readonly<Record<string, number>> = { active: 0, paused: 1, held: 1, failed: 2, completed: 3, stopped: 4, cancelled: 5 };
  const sorted = [...runs].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || personName(a).localeCompare(personName(b)));
  const gone = page.note?.c === 'p' && !runs.some(run => run.id === (page.note as { r: string }).r) ? noteBox(page.note, undefined) : '';
  return `<section class="card" id="people"><h2>People in this sequence</h2>${gone}${runs.length ? `<p>${e(counts(runs, truncated))}.</p><ul class="people">${sorted.map(run => personCard(run, page, detail)).join('')}</ul>` : '<p>Nobody is in this sequence yet.</p>'}
    ${truncated ? '<p class="note">Only the most recent people are listed here; there may be more in this sequence.</p>' : ''}</section>`;
}
function entrySection(page: MhpSequencePageInput, detail: MhpSequenceReview): string {
  const { snapshot } = page, rules = (snapshot.database.entryRules ?? []).filter(rule => rule.contentItemId === detail.review.contentItemId);
  const future = followupEntryIntent(detail.definition).mode === 'webinar_signup', canStart = followupAudienceCanStart(detail.audience, snapshot.database.campaign);
  if (!future && !rules.length) return '';
  const published = publishedOf(detail);
  const control = !snapshot.entryAvailable ? '<p class="notice">Automatic sign-ups are not available in this release.</p>'
    : !canStart ? `<p class="notice">${e(FOLLOWUP_NO_AUDIENCE_LINE)}</p>`
      : !future ? '<p>To add new sign-ups automatically, choose “Future webinar sign-ups” under How people join, save, and publish that version.</p>'
        : !published || detail.blockers.length ? '<p class="notice">Publish the latest version and each of its emails, and sort out any setup notes, before switching automatic sign-ups on.</p>'
          : `<form method="get" action="${BASE}">${hidden('item', detail.review.contentItemId)}${hidden('version', detail.review.contentVersionId)}${hidden('confirm', 'entry')}<label for="entry-until">Stop adding people after (UTC; UK winter time is the same)<input id="entry-until" type="datetime-local" name="until" required></label><button>Next: check who will be added</button></form><p class="note">Nothing switches on until you confirm on the next page.</p>`;
  return `<section class="card" id="automatic"><h2>Add new webinar sign-ups automatically</h2><p>When this is on, each new person who registers for the webinar and agrees to emails is added and sent the first email. People who registered before you switch it on are never added this way.</p>
    ${rules.map(rule => entryRuleCard(rule, page)).join('')}${control}</section>`;
}
function libraryList(page: MhpSequencePageInput): string {
  const runs = page.snapshot.database.runs;
  return page.snapshot.catalog.items.map(item => {
    const mine = runs.filter(run => run.contentItemId === item.contentItemId);
    return `<li><a href="${e(sequenceHref(item.contentItemId, item.contentVersionId))}"><strong>${e(item.title)}</strong></a><br><span class="note">Version ${item.versionNumber} · ${item.approvalStatus === 'approved' && !item.approvalStale ? 'Published' : 'Draft'}${mine.length ? ` · ${e(counts(mine))}` : ''}</span></li>`;
  }).join('');
}

export function mhpSequencePage(page: MhpSequencePageInput): string {
  const { snapshot, detail } = page;
  const draft = page.draft ?? (detail ? { commandId: page.commandId, contentItemId: detail.review.contentItemId,
    previousVersionId: detail.review.contentVersionId, definition: detail.definition,
    // Only an explicit earlier choice is carried into the editor; a guess must never become a choice by saving.
    audience: detail.audience.origin === 'chosen' ? detail.audience.kind : 'none_yet' } : undefined);
  const definition = draft?.definition as FollowupSequenceDefinition | undefined;
  const published = detail ? publishedOf(detail) : false;
  const emailChoices = snapshot.emailCatalog.items.map(item => ({ itemId: item.contentItemId, versionId: item.contentVersionId, sha256: item.contentSha256,
    label: `${item.title} · v${item.versionNumber}${item.approvalStatus === 'approved' && !item.approvalStale ? ' · published' : ' · draft'}` }));
  const audienceValue = draft?.audience === 'webinar_signups' ? 'webinar_signups' : 'none_yet';
  const editor = draft && definition ? renderFlowEditor({ profile: { brand: 'mhp', base: BASE, libraryHref: '/hq/marketing/emails', futureWebinarEntry: true, audience: { value: audienceValue } },
    csrf: page.csrf, commandId: draft.commandId, contentItemId: draft.contentItemId, previousVersionId: draft.previousVersionId,
    definition: page.preview?.definition ?? definition, choices: snapshot.messageChoices ?? emailChoices.map(choice => ({ ...choice, channel: 'email' as const })),
    inlineMessages: draft.inlineMessages as Readonly<Record<string, FlowInlineMessage>> | undefined,
    detail: detail ? { versionNumber: detail.review.versionNumber, published, isLatest: detail.review.isLatest } : undefined }) : '';
  const preview = page.preview ?? detail;
  const timeline = preview ? `<section class="card"><h2>Sequence timeline</h2>${followupEntryIntent(preview.definition).mode === 'manual' ? '<p>How people join: <strong>you start it yourself</strong>, after checking the list of people who will get it.</p>' : '<p>How people join: <strong>new webinar sign-ups are added automatically</strong>, but only once you switch that on and confirm it. Saving or publishing does not switch it on.</p>'}
    <p>Each wait starts once the previous email has gone. If an email cannot be sent, the next one does not go.</p>
    <ol>${preview.timeline.map((step, index) => `<li><strong>${step.step.kind === 'email' ? 'Email' : step.step.kind === 'sms' ? 'Text message' : 'WhatsApp'} ${index + 1}</strong>: ${index === 0 ? (step.waitMinutes === 0 ? 'straight away when someone starts' : `${waitWords(step.waitMinutes)} after someone starts`) : `${waitWords(step.waitMinutes)} after the previous one`}</li>`).join('')}</ol>
    ${preview.blockers.length ? `<div class="notice"><strong>Setup needed before this can start</strong><ul>${preview.blockers.map(key => `<li>${e(blockers[key] ?? 'Something in this sequence needs setting up first.')}</li>`).join('')}</ul></div>` : ''}</section>` : '';
  const copyPreviews = page.preview?.messagePreviews ?? detail?.messages?.map(message => previewFlowMessage(message.channel, message.payload)) ?? [];
  const catalog = libraryList(page);
  const returnControl = `<div class="toplinks">${detail || page.draft ? `<a href="${BASE}">← All sequences</a>` : ''}${marketingReturnControl(page.csrf, page.returnCommandId)}</div>`;
  const hero = detail ? '' : `<section class="card"><div class="eyebrow">Growth HQ · MHP brand</div><h1>The right follow-up.<br>At the right moment.</h1><p>Write a sequence of emails with waits between them. Nothing is ever sent until you start it, and Start always shows you exactly who will get it first.</p><p><strong>Email: ${snapshot.readiness.email ? e(snapshot.mode === 'live' ? 'on' : snapshot.mode) : 'setup needed'}</strong> · Text messages: setup needed · WhatsApp: setup needed</p><div class="actions"><a class="button" href="${BASE}?new=1">Create a sequence</a></div></section>`;
  const status = page.message ? `<section class="card notice" role="status">${e(page.message)}</section>` : '';
  const body = `${returnControl}${topNote(page.note)}${status}${hero}${detail ? sequenceSummary(page, detail) + peopleSection(page, detail) + entrySection(page, detail) : ''}
  ${editor}${timeline}${renderFlowMessagePreviews(copyPreviews)}${renderFlowSimulation(page.simulation)}<section class="card"><h2>Your saved sequences</h2>${catalog ? `<ul class="library">${catalog}</ul>` : '<p>No sequences saved yet. Start with one email, add a wait, then choose the next email.</p>'}<p class="note">Showing up to 50 latest sequences.</p></section>`;
  return frame(detail ? detail.definition.title : 'Follow-up sequences', body);
}

/* ---------- Confirmation pages (read-only views; the button on each posts the confirmed action) ---------- */
const recipientList = (people: readonly MhpStartRecipient[]) => `${people.length > 30 ? `<p class="note">Showing all ${people.length}, in the order they will be started.</p>` : ''}<ul class="list" aria-label="People who will receive it">${people.map(person => `<li><strong>${e(person.firstName?.trim() || '(no first name)')}</strong> · <span class="wrap">${e(person.email)}</span></li>`).join('')}</ul>`;
export interface MhpStartConfirmInput { csrf: string; plan: MhpStartPlan; token: Readonly<Record<string, string>>; commandId: string;
  changed?: { previousCount: number; added: readonly MhpStartRecipient[]; removed: readonly MhpStartRecipient[]; reason?: string }; problem?: string }
export function mhpSequenceStartConfirmPage(input: MhpStartConfirmInput): string {
  const { plan } = input, back = sequenceHref(plan.itemId, plan.versionId);
  const first = plan.messages[0], later = plan.messages.slice(1);
  const subject = (m: MhpStartPlan['messages'][number]) => m.subject ? `“${m.subject}”` : `${m.channel === 'email' ? 'Email' : 'Message'} ${m.number}`;
  const held = [plan.heldBack.noConsent ? `${plural(plan.heldBack.noConsent, 'person')} did not agree to emails` : '', plan.heldBack.unsubscribed ? `${plural(plan.heldBack.unsubscribed, 'person', 'people')} unsubscribed` : '',
    plan.heldBack.alreadyIn ? `${plural(plan.heldBack.alreadyIn, 'person is', 'people are')} already in this sequence` : '', plan.heldBack.earlierVersion ? `${plural(plan.heldBack.earlierVersion, 'person is', 'people are')} still in an earlier version of it (stop them there first)` : ''].filter(Boolean);
  const changed = input.changed ? `<section class="card notice" role="alert"><h2>The list changed, so nothing was sent</h2><p>${e(input.changed.reason ?? `When you looked, this was ${plural(input.changed.previousCount, 'person', 'people')}. It is now ${plural(plan.count, 'person', 'people')}.`)}</p>
    ${input.changed.added.length ? `<p><strong>New since you looked:</strong> ${input.changed.added.map(person => e(`${person.firstName?.trim() || '(no first name)'} (${person.email})`)).join(', ')}</p>` : ''}
    ${input.changed.removed.length ? `<p><strong>No longer on the list:</strong> ${input.changed.removed.map(person => e(`${person.firstName?.trim() || '(no first name)'} (${person.email})`)).join(', ')}</p>` : ''}
    <p>Check the list below again before confirming.</p></section>` : '';
  const problem = input.problem ? `<section class="card notice" role="alert"><p><strong>${e(input.problem)}</strong></p></section>` : '';
  if (!plan.ready) {
    return frame('Start this sequence', `<div class="toplinks"><a href="${e(back)}">← Back to the sequence</a></div>${changed}${problem}<section class="card"><div class="eyebrow">Start · ${e(plan.title)}</div><h1>This sequence cannot be started</h1>
      <p><strong>${e(plan.refusal?.message ?? 'It cannot be started right now.')}</strong></p><p>Nothing has been sent and nobody was added.</p>
      ${held.length ? `<p class="note">${e(held.join('; '))}.</p>` : ''}<div class="actions"><a class="button" href="${e(back)}">Back to the sequence</a></div></section>`, false);
  }
  const fields = hidden('csrf', input.csrf) + hidden('commandId', input.commandId) + hidden('itemId', plan.itemId) + hidden('versionId', plan.versionId)
    + Object.entries(input.token).map(([key, value]) => hidden(key, value)).join('');
  return frame('Start this sequence', `<div class="toplinks"><a href="${e(back)}">← Back without sending</a></div>${changed}${problem}<section class="card"><div class="eyebrow">Start · ${e(plan.title)}</div>
    <h1>You are about to email ${plural(plan.count, 'person', 'people')}</h1>
    <p><strong>Who:</strong> ${e(audienceWords(plan.audience, plan.webinar).replace(/^People/u, 'people'))}.</p>
    <p><strong>First email:</strong> ${e(first ? subject(first) : 'the first message')}, sent <strong>${e(first ? (first.waitMinutes === 0 ? 'straight away' : `${waitWords(first.waitMinutes)} after you start`) : 'straight away')}</strong>.</p>
    ${later.length ? `<h2>Then</h2><ol>${later.map(m => `<li>${e(subject(m))}: ${e(waitWords(m.waitMinutes))} after the previous email${m.offsetMinutes >= 1440 ? ` (about day ${Math.round(m.offsetMinutes / 1440)})` : ''}</li>`).join('')}</ol><p class="note">Each wait starts once the previous email has gone. Anyone who unsubscribes gets nothing more.</p>` : ''}
    ${plan.mode === 'test' ? '<p class="notice">Email is in test mode: only your test addresses actually receive anything. Everyone listed is still added to the sequence.</p>' : ''}
    <h2>The ${plural(plan.count, 'person', 'people')}</h2>${recipientList(plan.recipients)}
    <h2>Held back</h2>${held.length ? `<ul>${held.map(line => `<li>${e(line)}</li>`).join('')}</ul><p class="note">These people are not emailed.</p>` : '<p>Nobody is held back.</p>'}
    <form method="post" action="${BASE}/start">${fields}<div class="confirm-box"><label class="check" for="start-confirm"><input id="start-confirm" type="checkbox" name="confirm" value="yes" required> Yes, send to these ${plural(plan.count, 'person', 'people')}</label></div>
      <div class="actions"><button>Start for ${plural(plan.count, 'person', 'people')}</button><a class="button secondary" href="${e(back)}">Cancel</a></div></form></section>`, false);
}
/** Short confirmation for pausing (undone by resuming) or stopping (final) everyone in a sequence. */
export function mhpSequencePauseAllPage(input: { csrf: string; commandId: string; detail: MhpSequenceReview; kind: 'pause' | 'stop'; count: number; atLeast: boolean }): string {
  const back = sequenceHref(input.detail.review.contentItemId, input.detail.review.contentVersionId), stop = input.kind === 'stop';
  const fields = hidden('csrf', input.csrf) + hidden('commandId', input.commandId) + hidden('itemId', input.detail.review.contentItemId) + hidden('versionId', input.detail.review.contentVersionId);
  const any = input.count > 0 || input.atLeast, who = input.atLeast ? `everyone in this sequence (at least ${plural(input.count, 'person', 'people')})` : `all ${plural(input.count, 'person', 'people')} in this sequence`;
  return frame(stop ? 'Stop everyone' : 'Pause everyone', `<div class="toplinks"><a href="${e(back)}">← Back to the sequence</a></div><section class="card"><div class="eyebrow">${stop ? 'Stop' : 'Pause'} · ${e(input.detail.definition.title)}</div>
    <h1>${any ? `${stop ? 'Stop' : 'Pause'} ${who}?` : `Nobody in this sequence needs ${stop ? 'stopping' : 'pausing'}`}</h1>
    <p>${!any ? 'There is nobody to change.' : stop ? 'Stopping is final: nothing more from this sequence will ever be sent to them, and they cannot be restarted. An email already on its way cannot be called back.'
      : 'Nothing more is sent until you resume them. An email already on its way cannot be called back.'}</p>
    <form method="post" action="${BASE}/${stop ? 'stop-all' : 'pause-all'}">${fields}<div class="actions">${any ? `<button>${stop ? 'Stop everyone' : 'Pause everyone'}</button>` : ''}<a class="button secondary" href="${e(back)}">Cancel</a></div></form></section>`, false);
}
export function mhpSequenceResumeAllPage(input: { csrf: string; commandId: string; plan: MhpResumePlan; token: Readonly<Record<string, string>>; changed?: number }): string {
  const { plan } = input, back = sequenceHref(plan.itemId, plan.versionId);
  const fields = hidden('csrf', input.csrf) + hidden('commandId', input.commandId) + hidden('itemId', plan.itemId) + hidden('versionId', plan.versionId) + Object.entries(input.token).map(([k, v]) => hidden(k, v)).join('');
  const changed = input.changed !== undefined ? `<section class="card notice" role="alert"><p><strong>The list changed, so nobody was resumed.</strong> When you looked it was ${plural(input.changed, 'person', 'people')}; it is now ${plural(plan.people.length, 'person', 'people')}. Check it again below.</p></section>` : '';
  return frame('Resume everyone', `<div class="toplinks"><a href="${e(back)}">← Back to the sequence</a></div>${changed}<section class="card"><div class="eyebrow">Resume · ${e(plan.title)}</div>
    <h1>${plan.ready ? `Resume ${plural(plan.people.length, 'person', 'people')}?` : 'Nobody can be resumed from here'}</h1>
    ${plan.ready ? `<p>Their next emails go when they are due, which is straight away for anyone whose next email was already due.</p>${recipientList(plan.people.map(run => ({ prospectId: run.id, firstName: run.firstName, email: run.email })))}
      ${plan.needsCheck ? `<p class="note">${plural(plan.needsCheck, 'person needs', 'people need')} checking on their own card first and will not be resumed here.</p>` : ''}
      <form method="post" action="${BASE}/resume-all">${fields}<div class="confirm-box"><label class="check" for="resume-confirm"><input id="resume-confirm" type="checkbox" name="confirm" value="yes" required> Yes, resume these ${plural(plan.people.length, 'person', 'people')}</label></div><div class="actions"><button>Resume ${plural(plan.people.length, 'person', 'people')}</button><a class="button secondary" href="${e(back)}">Cancel</a></div></form>`
      : `<p><strong>${e(plan.refusal ?? '')}</strong></p><div class="actions"><a class="button" href="${e(back)}">Back to the sequence</a></div>`}</section>`, false);
}
export function mhpSequenceEntryConfirmPage(input: { csrf: string; commandId: string; detail: MhpSequenceReview; expiresAt: string; until: string; webinar: { label: string | null; date: string | null } }): string {
  const { detail } = input, back = sequenceHref(detail.review.contentItemId, detail.review.contentVersionId);
  const first = detail.timeline[0], subject = first ? detail.subjects?.[first.step.contentVersionId] : undefined;
  const fields = hidden('csrf', input.csrf) + hidden('commandId', input.commandId) + hidden('itemId', detail.review.contentItemId) + hidden('versionId', detail.review.contentVersionId) + hidden('expiresAt', input.until);
  return frame('Switch on automatic sign-ups', `<div class="toplinks"><a href="${e(back)}">← Back without switching on</a></div><section class="card"><div class="eyebrow">Automatic sign-ups · ${e(detail.definition.title)}</div>
    <h1>Add new sign-ups automatically until ${e(time(input.expiresAt))}?</h1>
    <p>From the moment you confirm until <strong>${e(time(input.expiresAt))} (UK time)</strong>, every new person who registers for ${e(webinarWords(input.webinar))} and agrees to emails will be added to this sequence automatically and sent ${e(subject ? `“${subject}”` : 'the first email')} <strong>${e(first && first.waitMinutes > 0 ? `${waitWords(first.waitMinutes)} after they sign up` : 'straight away')}</strong>.</p>
    <p>Nobody who registered before now is added. You can switch this off at any time.</p>
    <form method="post" action="${BASE}/entry-activate">${fields}<div class="confirm-box"><label class="check" for="entry-confirm"><input id="entry-confirm" type="checkbox" name="confirm" value="yes" required> Yes, add new sign-ups automatically until ${e(time(input.expiresAt))}</label></div>
      <div class="actions"><button>Switch on automatic sign-ups</button><a class="button secondary" href="${e(back)}">Cancel</a></div></form></section>`, false);
}
