import { escapeHtml as e } from '../portal/ui.js';
import { FOLLOWUP_SEQUENCE_V2_SCHEMA, followupEntryIntent, type FollowupSequenceDefinition } from '../followup-sequences/definition.js';
import { FOLLOWUP_REASON_LABELS } from '../followup-sequences/state.js';
import type { FollowupEntryRule } from '../followup-sequences/entry.js';
import { marketingReturnControl } from './marketing-workspace-view.js';
import type { MhpSequenceReview, MhpSequenceSaveInput, MhpSequenceSnapshot, MhpSequenceRun } from './followup-sequence-service.js';

export interface MhpSequencePageInput {
  snapshot: MhpSequenceSnapshot; csrf: string; commandId: string; returnCommandId: string;
  detail?: MhpSequenceReview; draft?: MhpSequenceSaveInput;
  preview?: { definition: FollowupSequenceDefinition; timeline: MhpSequenceReview['timeline']; blockers: readonly string[] };
  message?: string;
}
const BASE = '/hq/marketing/sequences';
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${e(value)}">`;
const time = (value: string | null) => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }) : '—';
const wait = (minutes: number) => minutes === 0 ? 'Immediately' : minutes % 1440 === 0 ? `${minutes / 1440} day${minutes === 1440 ? '' : 's'}` : minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`;
const blockers: Readonly<Record<string, string>> = {
  email_not_connected: 'Email delivery is off or its Postmark connection is unavailable.',
  email_version_not_ready: 'Publish every selected email in the email library. Older versions and changed brand details cannot be used for a new handoff.',
  sms_not_connected: 'MHP SMS needs its own sender and purpose-specific permission connection.',
  whatsapp_not_connected: 'MHP WhatsApp needs its own business sender, approved templates and permission connection.',
  reply_stop_not_connected: 'Automatic reply detection is not connected to this webinar audience yet.',
  booked_stop_not_connected: 'Automatic booking detection is not connected yet.', purchased_stop_not_connected: 'Automatic purchase detection is not connected yet.',
};
export function mhpSequenceNewDraft(campaign: string, commandId: string): MhpSequenceSaveInput {
  return { commandId, contentItemId: '', previousVersionId: '', definition: { schema: FOLLOWUP_SEQUENCE_V2_SCHEMA, entry: { mode: 'manual', source: 'manual_owner' }, brand: 'mhp', campaign,
    title: 'New follow-up sequence', expiryHours: 24, stopOn: { reply: false, booked: false, purchased: false }, steps: [] } };
}
function runCard(run: MhpSequenceRun, page: MhpSequencePageInput): string {
  const fields = hidden('csrf', page.csrf) + hidden('commandId', page.commandId) + hidden('itemId', run.contentItemId)
    + hidden('versionId', run.contentVersionId) + hidden('runId', run.id);
  const control = (action: string, label: string) => `<form method="post" action="${BASE}/${action}">${fields}${hidden('ackProofId', '')}<button class="secondary">${e(label)}</button></form>`;
  const active = ['active', 'paused', 'held'].includes(run.state);
  return `<article class="run"><h3>${e(run.firstName || run.email)}</h3><p class="note wrap">${e(run.email)} · <strong>${e(run.state)}</strong> · step ${run.position + 1}</p>
    ${run.reason ? `<p>${e(FOLLOWUP_REASON_LABELS[run.reason] ?? 'Review this run before continuing.')}</p>` : ''}
    ${run.inFlight ? '<p class="notice">A message is being processed. A handoff already verified before pausing or stopping may still finish.</p>' : ''}
    <p>Next due: ${e(time(run.dueAt))} UK time. Last accepted: ${e(time(run.lastAcceptedAt))}.</p>
    ${run.steps.length ? `<ol>${run.steps.map(step => `<li>Step ${step.position + 1}: ${step.acceptedAt ? `accepted by provider ${e(time(step.acceptedAt))}` : step.cancelled ? 'cancelled' : step.failed ? 'failed' : step.inFlight ? 'being processed' : step.held ? 'held' : 'waiting'}.</li>`).join('')}</ol>` : '<p class="note">No message has been handed off yet.</p>'}
    <div class="actions">${run.state === 'active' ? control('pause', 'Pause this person') : ''}${['paused', 'held'].includes(run.state) && !run.unknownProofId ? control('resume', 'Resume this person') : ''}
    ${active ? control('stop', 'Stop this person') + control('cancel', 'Cancel this run') : ''}</div>
    ${active && run.unknownProofId ? `<form class="notice" method="post" action="${BASE}/resume">${fields}<label class="check"><input type="checkbox" name="ackProofId" value="${e(run.unknownProofId)}" required> I checked this exact attempt. I understand retrying may send the same message twice.</label><button class="secondary" ${run.inFlight ? 'disabled' : ''}>Retry this unknown attempt</button></form>` : ''}</article>`;
}
function entryRuleCard(rule: FollowupEntryRule, page: MhpSequencePageInput): string {
  const fields = hidden('csrf', page.csrf) + hidden('commandId', page.commandId) + hidden('itemId', rule.contentItemId)
    + hidden('versionId', rule.contentVersionId) + hidden('ruleId', rule.id);
  const reason = rule.heldReason === 'newer_sequence' ? 'A newer sequence draft exists. Publish and explicitly enable the version you want.'
    : rule.heldReason === 'content_changed' ? 'A selected email, approval or brand changed. Review the current version before enabling entry.'
      : rule.heldReason === 'recovery' ? 'Entry is held after recovery. Enabling a new rule starts with future sign-ups only.' : null;
  return `<article class="run"><h3>Future webinar sign-ups · ${e(rule.state)}</h3><p>Enabled ${e(time(rule.activatedAt))}. Stops adding people ${e(time(rule.expiresAt))} UK time.</p>
    ${reason ? `<p class="notice">${e(reason)}</p>` : ''}<p>${rule.enrolled} enrolled · ${rule.skipped} skipped · ${rule.blocked} blocked · ${rule.processed} events processed.</p>
    <p class="note">Last processed sign-up: ${e(time(rule.cursorAt))}. Last checked: ${e(time(rule.lastSweptAt))}.</p>
    ${rule.state !== 'off' ? `<form method="post" action="${BASE}/entry-off">${fields}<button class="secondary">Turn off future entry</button></form>` : ''}
    <p class="note">Turning this off stops new entry. It does not stop or recall messages in existing runs; use their separate controls.</p></article>`;
}

export function mhpSequencePage(page: MhpSequencePageInput): string {
  const { snapshot, detail } = page;
  const draft = page.draft ?? (detail ? { commandId: page.commandId, contentItemId: detail.review.contentItemId,
    previousVersionId: detail.review.contentVersionId, definition: detail.definition } : undefined);
  const definition = draft?.definition as FollowupSequenceDefinition | undefined;
  const published = detail?.review.isLatest && detail.review.approvalStatus === 'approved' && !detail.review.approvalStale && detail.local.valid;
  const fields = hidden('csrf', page.csrf) + hidden('commandId', page.commandId);
  const savedFields = detail ? fields + hidden('itemId', detail.review.contentItemId) + hidden('versionId', detail.review.contentVersionId) : '';
  const emailChoices = snapshot.emailCatalog.items.map(item => ({ itemId: item.contentItemId, versionId: item.contentVersionId, sha256: item.contentSha256,
    label: `${item.title} · v${item.versionNumber}${item.approvalStatus === 'approved' && !item.approvalStale ? ' · published' : ' · draft'}` }));
  const editor = draft && definition ? `<section class="card"><div class="eyebrow">${detail ? `Version ${detail.review.versionNumber} · ${published ? 'Published' : detail.review.isLatest ? 'Draft' : 'Older version'}` : 'New sequence'}</div>
    <h2>${detail ? 'Edit your sequence' : 'Build the next conversation'}</h2><p>Add messages and waits, then drag steps or use Move up / Move down. Choose copy from your existing email library.</p>
    <p><a href="/hq/marketing/emails?new=blank">Create an email in the email editor</a> · <a href="/hq/marketing/emails">Review or test saved emails</a></p>
    <form method="post" action="${BASE}/save" data-sequence-editor data-initial="${e(JSON.stringify(definition))}" data-emails="${e(JSON.stringify(emailChoices))}">
    ${hidden('csrf', page.csrf)}${hidden('commandId', draft.commandId)}${hidden('contentItemId', draft.contentItemId)}${hidden('previousVersionId', draft.previousVersionId)}${hidden('definition', JSON.stringify(definition))}
    <label>Sequence name<input data-field="title" maxlength="180" value="${e(definition.title)}" required></label>
    <label>How people join<select data-entry-mode><option value="manual" ${followupEntryIntent(definition).mode === 'manual' ? 'selected' : ''}>Manual start — current webinar sign-ups</option><option value="webinar_signup" ${followupEntryIntent(definition).mode === 'webinar_signup' ? 'selected' : ''}>Future opted-in webinar sign-ups</option></select></label>
    <p class="note">Choosing future sign-ups saves your intent. Publish this version, then explicitly enable its future-signup rule below. Existing registrations stay on the separate manual Start action.</p>
    <label>Retry window for each message (hours)<input data-field="expiryHours" type="number" min="1" max="168" value="${definition.expiryHours}" required></label>
    <p class="note">The retry window starts when that message is due. Expired work is shown; it is never silently extended.</p>
    <div data-steps></div><div class="actions"><button type="button" data-add="email" class="secondary">+ Email</button><button type="button" data-add="wait" class="secondary">+ Wait</button><button type="button" data-add="sms" class="secondary">+ Text message</button><button type="button" data-add="whatsapp" class="secondary">+ WhatsApp</button></div>
    <h3>When should this stop?</h3><p>Unsubscribe and your manual Stop action always stop future handoffs.</p>
    ${(['reply', 'booked', 'purchased'] as const).map(key => `<label class="check"><input type="checkbox" data-stop="${key}" ${definition.stopOn[key] ? 'checked' : ''}> ${key === 'reply' ? 'When they reply' : key === 'booked' ? 'When they book' : 'When they buy'} <span class="note">— event connection pending; selecting this blocks Start</span></label>`).join('')}
    <p data-editor-status role="status" class="note"></p><noscript><p>The visual step editor needs JavaScript. Existing saved sequences can still be reviewed and controlled below.</p></noscript>
    <div class="actions"><button formaction="${BASE}/preview" class="secondary">Preview timeline</button><button ${detail && !detail.review.isLatest ? 'disabled' : ''}>Save draft</button></div></form>
    <p class="note">Saving an edit holds unsent runs on the older sequence. Those runs keep their original history; cancel them before a fresh start on a new version. A fresh start begins at the first step and can repeat earlier messages.</p></section>` : '';
  const preview = page.preview ?? detail;
  const timeline = preview ? `<section class="card"><h2>Sequence timeline</h2>${followupEntryIntent(preview.definition).mode === 'manual' ? '<p>Entry: <strong>manual start with the current webinar sign-ups</strong>. Future new sign-ups are not automatically enrolled.</p>' : '<p>Entry intent: <strong>future opted-in webinar sign-ups</strong>. This needs its own enabled rule; saving or publishing does not switch it on. Current registrants can be started separately.</p>'}
    <p>Each wait starts after the previous message is accepted by its provider; a wait before the first message starts at enrolment. Failed or unknown attempts do not advance.</p>
    <ol>${preview.timeline.map(step => `<li><strong>${step.step.kind === 'email' ? 'Email' : step.step.kind === 'sms' ? 'Text message' : 'WhatsApp'}</strong> — ${wait(step.waitMinutes)}${step.position === preview.timeline[0]?.position ? ' after enrolment' : ' after the previous accepted message'}<br><span class="note">Earliest possible: ${step.earliestOffsetMinutes === 0 ? 'at enrolment' : '+' + wait(step.earliestOffsetMinutes).toLowerCase()}.</span></li>`).join('')}</ol>
    ${preview.blockers.length ? `<div class="notice"><strong>Setup needed before Start</strong><ul>${preview.blockers.map(key => `<li>${e(blockers[key] ?? key)}</li>`).join('')}</ul></div>` : '<p>Channels and selected stop sources are available. Saved email versions must also remain published and current.</p>'}</section>` : '';
  const controls = detail ? `<section class="card"><h2>Publish, then start</h2><p>Publication records the exact version you reviewed. It does not enrol anyone or send a message.</p>
    ${!published && detail.review.isLatest ? `<form method="post" action="${BASE}/publish">${savedFields}<button data-saved-required>Publish this version</button></form>` : published ? '<p><strong>This version is published.</strong></p>' : '<p>This older version cannot be started or resumed. Open the latest version from your saved sequences.</p>'}
    ${published ? `<h3>Start with eligible sign-ups</h3><p>${snapshot.database.eligible} currently have email permission; ${snapshot.database.blocked} are excluded. Each click adds up to 500 people who are not already enrolled in this version. Existing open runs of an older version must be cancelled first.</p><p class="notice"><strong>A new version starts from the first step and can repeat earlier emails.</strong> Completed steps are not migrated. Review the previous run history before starting again.</p><form method="post" action="${BASE}/enrol">${savedFields}${hidden('runId', '')}${hidden('ackProofId', '')}<button data-saved-required ${detail.blockers.length ? 'disabled' : ''}>Start remaining eligible sign-ups</button></form>` : ''}
    <div class="actions">${(['pause', 'resume', 'cancel'] as const).map(action => `<form method="post" action="${BASE}/${action}">${savedFields}${hidden('runId', '')}${hidden('ackProofId', '')}<button class="secondary">${action === 'pause' ? 'Pause active runs' : action === 'resume' ? 'Resume ready runs' : 'Cancel open runs'}</button></form>`).join('')}</div>
    <p class="note">Resume rechecks approval and permission. Unknown attempts need their own explicit decision below. A message already verified for handoff may still finish.</p></section>` : '';
  const entryRules = detail ? (snapshot.database.entryRules ?? []).filter(rule => rule.contentItemId === detail.review.contentItemId) : [];
  const futureIntent = detail && followupEntryIntent(detail.definition).mode === 'webinar_signup';
  const entryControls = detail && (futureIntent || entryRules.length) ? `<section class="card"><h2>Follow up future webinar sign-ups</h2>
    <p>Only genuine new opted-in registrations for this configured webinar can enter. Existing registrations are not backfilled; the separate manual Start action remains available.</p>
    ${entryRules.map(rule => entryRuleCard(rule, page)).join('')}
    ${!snapshot.entryAvailable ? '<p class="notice">The exact capture-entry connection is not available in this release.</p>' : !futureIntent ? '<p>Choose future webinar entry in the editor, save and publish that version before enabling a rule.</p>'
      : !published || detail.blockers.length ? '<p class="notice">Publish the latest sequence and every selected email, then resolve any setup notes before enabling future entry.</p>'
        : `<h3>${entryRules.length ? 'Enable a new rule from now' : 'Enable future sign-ups'}</h3><p>Enabling starts after this action. Re-enabling closes the old rule and starts a new future-only window; pending events from before the new action are not backfilled.</p>
          <form method="post" action="${BASE}/entry-activate">${savedFields}<label>Stop adding new sign-ups at (UTC)<input type="datetime-local" name="expiresAt" required></label><button data-saved-required>Enable future sign-ups</button></form>`}
    <p class="note">Entry stops adding people when its rule is off or expired. Existing accepted runs keep their own waits and stop controls. Delivery mode remains ${e(snapshot.mode)}${snapshot.mode === 'test' ? ' and only the configured test recipients can receive messages' : snapshot.mode === 'off' ? '; both entry processing and sending are paused' : ''}.</p></section>` : '';
  const catalog = snapshot.catalog.items.map(item => `<li><a href="${BASE}?item=${encodeURIComponent(item.contentItemId)}&version=${encodeURIComponent(item.contentVersionId)}"><strong>${e(item.title)}</strong></a><span class="note">Version ${item.versionNumber} · ${item.approvalStatus === 'approved' && !item.approvalStale ? 'Published' : 'Draft / review needed'}</span></li>`).join('');
  const runs = detail ? snapshot.database.runs.filter(run => run.contentItemId === detail.review.contentItemId) : snapshot.database.runs;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Follow-up sequences · MHP Growth HQ</title><style>
  body{margin:0;background:#f5f3ed;color:#142019;font:17px/1.65 system-ui,sans-serif}header,main{max-width:1080px;margin:auto;padding:24px}header,nav,.actions{display:flex;gap:14px;flex-wrap:wrap;align-items:center}header{justify-content:space-between}a{color:#215c3d}h1{font:clamp(34px,5vw,50px)/1.15 Georgia,serif}h2{font-size:27px}h3{font-size:21px}.card{background:#fff;border:1px solid #d9ded4;border-radius:18px;padding:clamp(20px,4vw,38px);margin:0 0 24px;min-width:0}.eyebrow{font-size:13px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#83510c}.note{font-size:16px;color:#526154}.notice{border-left:4px solid #b57212;background:#fbf4e5;padding:16px;margin:20px 0}.wrap{overflow-wrap:anywhere}label{display:block;font-weight:700;margin:20px 0}input:not([type=hidden]):not([type=checkbox]),select{display:block;box-sizing:border-box;max-width:100%;width:100%;margin-top:7px;padding:13px;border:1px solid #9da99b;border-radius:8px;font:17px/1.5 system-ui;background:white;color:#142019}.check{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}.check input{margin-top:8px;width:20px;height:20px}button,.button{display:inline-block;max-width:100%;border:0;border-radius:9px;padding:14px 20px;background:#e8a33d;color:#142019;font:700 17px/1.4 system-ui;cursor:pointer;text-decoration:none}.secondary{background:#eeeee7;border:1px solid #bac5b8}button:disabled{opacity:.55;cursor:not-allowed}.sequence-step{padding:20px;border:1px solid #c7d0c4;border-radius:12px;background:#fafbf8;margin:18px 0;min-width:0}.sequence-step.drag-over{outline:3px solid #e8a33d}.sequence-step h3{margin-top:0}.drag-handle{cursor:grab}.run{padding:24px 0;border-top:1px solid #d9ded4;min-width:0}.library{list-style:none;padding:0}.library li{padding:16px 0;border-top:1px solid #d9ded4}p{max-width:75ch}a,button,input,select{overflow-wrap:anywhere}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #83510c;outline-offset:3px}@media(max-width:480px){header,main{padding:16px}.actions>*{max-width:100%}.actions button{width:100%}.sequence-step{padding:14px}}
  </style><script src="${BASE}/editor.js" defer></script></head><body><header><strong>Martin Howard Property</strong><nav aria-label="Owner navigation"><a href="/hq/marketing">Marketing workspace</a><a href="/hq/marketing/emails">Email library</a><a href="/portal/crm/opportunities">Enquiry board</a></nav></header><main>
  ${page.message ? `<section class="card notice" role="status">${e(page.message)}</section>` : ''}<section class="card"><div class="eyebrow">Growth HQ · MHP brand</div><h1>The right follow-up.<br>At the right moment.</h1><p>Build a sequence using saved messages and relative waits. Keep every person's next step, pause and outcome in view.</p><p><strong>Email: ${snapshot.readiness.email ? e(snapshot.mode) : 'setup needed'}</strong> · SMS: setup needed · WhatsApp: setup needed</p><div class="actions"><a class="button" href="${BASE}?new=1">Create a sequence</a>${marketingReturnControl(page.csrf, page.returnCommandId)}</div></section>
  ${editor}${timeline}${controls}${entryControls}<section class="card"><h2>Your saved sequences</h2>${catalog ? `<ul class="library">${catalog}</ul>` : '<p>No sequences saved yet. Start with one email, add a wait, then choose the next email.</p>'}<p class="note">Showing up to 50 latest sequences and 50 saved email choices.</p></section>
  <section class="card"><h2>People and progress</h2><p>${snapshot.database.runCount} total runs. Showing the latest ${snapshot.database.runs.length}${detail ? ' with this sequence filtered below' : ''}. Provider acceptance does not prove inbox delivery.</p>${runs.map(run => runCard(run, page)).join('') || '<p>No matching runs yet.</p>'}</section></main></body></html>`;
}
