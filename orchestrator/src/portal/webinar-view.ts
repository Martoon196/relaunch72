/**
 * Server-rendered portal pages for /portal/webinars. Bodies only: the router
 * wraps them in the standard appShell so Webinars sits in the existing menu.
 * Every control that cannot work on this deployment is rendered disabled with
 * the exact reason and the named setting that enables it.
 */

import { escapeHtml as e } from './ui.js';
import type { WebinarConfig } from '../webinars/config.js';
import { WEBINAR_ENV } from '../webinars/config.js';
import { formatInZone, utcToLocalInput, type RoomState } from '../webinars/schedule.js';
import type { MessageStatusRow, QuestionRow, RegistrationRow, WebinarCounts, WebinarResults, WebinarSummary, WorkspaceProfile } from '../webinars/service.js';
import { KIND_LABEL, type WebinarEvent, type WebinarSettings } from '../webinars/types.js';

export const WEBINARS_BASE = '/portal/webinars';
export const WEBINARS_ASSET = '/portal/webinars/_assets/portal.js';

export type WebinarTab = 'details' | 'video' | 'host' | 'people' | 'questions' | 'messages' | 'results';

export interface SetupStatus {
  readonly database: boolean;
  readonly databaseDetail: string;
  readonly config: WebinarConfig | null;
  readonly crmAvailable: boolean;
  readonly workspaceId: string | null;
}

const CSS = `<style>
.wb-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 16px}.wb-tabs a{padding:7px 12px;border-radius:999px;border:1px solid var(--line,#dfe4eb);text-decoration:none;color:inherit;font-weight:600;font-size:.88rem}
.wb-tabs a[aria-current=page]{background:var(--accent,#ed9c24);border-color:var(--accent,#ed9c24);color:#fff}
.wb-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}.wb-form{display:grid;gap:14px;max-width:760px}
.wb-form label{display:block;font-weight:600;margin-bottom:5px}.wb-form input,.wb-form select,.wb-form textarea{width:100%;padding:9px 11px;border:1px solid var(--line,#cbd3df);border-radius:8px;font:inherit;background:var(--panel,#fff);color:inherit}
.wb-form textarea{min-height:90px}.wb-row{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}.wb-help{color:var(--muted,#657187);font-size:.85rem;margin:4px 0 0}
.wb-check{display:flex;gap:8px;align-items:flex-start;font-weight:500!important}.wb-check input{width:auto!important;margin-top:3px}
.wb-status{display:inline-flex;align-items:center;gap:6px;font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:3px 9px;border-radius:999px;background:var(--panelStrong,#edf1f5)}
.wb-status.live{background:#dc2626;color:#fff}.wb-status.ok{background:#dcfce7;color:#166534}.wb-status.warn{background:#fef3c7;color:#92400e}.wb-status.bad{background:#fee2e2;color:#991b1b}
.wb-checklist{list-style:none;padding:0;margin:0;display:grid;gap:8px}.wb-checklist li{display:flex;gap:10px;align-items:flex-start}.wb-checklist code{font-size:.82rem}
.wb-video{width:100%;aspect-ratio:16/9;background:#000;border-radius:10px}.wb-secret{font-family:ui-monospace,monospace;word-break:break-all;background:var(--panelStrong,#edf1f5);padding:8px 10px;border-radius:8px}
[hidden]{display:none!important}.wb-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.wb-actions form{margin:0}.wb-meter{height:10px;background:var(--panelStrong,#edf1f5);border-radius:5px;overflow:hidden}.wb-meter span{display:block;height:100%;width:0;background:#16a34a;transition:width .1s}
.wb-progress{height:8px;background:var(--panelStrong,#edf1f5);border-radius:4px;overflow:hidden}.wb-progress span{display:block;height:100%;width:0;background:var(--accent,#ed9c24)}
.wb-q{border:1px solid var(--line,#dfe4eb);border-radius:10px;padding:12px;margin-bottom:10px}.wb-q p{margin:4px 0}.wb-muted{color:var(--muted,#657187)}
</style>`;

function csrfField(csrf: string): string {
  return `<input type="hidden" name="_csrf" value="${e(csrf)}">`;
}

function statusPill(ev: WebinarEvent): string {
  if (ev.status === 'published' && ev.sessionState === 'live') return '<span class="wb-status live">● Live now</span>';
  const map: Record<string, string> = { draft: '', published: 'ok', cancelled: 'bad', archived: '' };
  return `<span class="wb-status ${map[ev.status] ?? ''}">${e(ev.status)}</span>`;
}

function when(ev: WebinarEvent): string {
  if (ev.kind === 'on_demand') return 'On demand';
  return ev.startsAt ? e(formatInZone(ev.startsAt, ev.timezone)) : '<span class="wb-muted">No start time yet</span>';
}

function notice(notice: string | null, error: string | null): string {
  return `${notice ? `<p class="notice" role="status">${e(notice)}</p>` : ''}${error ? `<p class="notice" role="alert" style="border-color:#dc2626">${e(error)}</p>` : ''}`;
}

export function setupChecklist(setup: SetupStatus): string {
  const c = setup.config;
  const item = (ok: boolean, title: string, detail: string) => `<li><span class="wb-status ${ok ? 'ok' : 'warn'}">${ok ? 'Ready' : 'Setup'}</span><div><strong>${e(title)}</strong><div class="wb-help">${detail}</div></div></li>`;
  const sender = c && setup.workspaceId ? c.senders.get(setup.workspaceId.toLowerCase()) : undefined;
  const items = [
    item(setup.database, 'Webinar database', setup.database ? 'Migration 0144 is applied and the content identity is connected.' : e(setup.databaseDetail)),
    item(Boolean(c?.stream), 'Cloudflare Stream video', c?.stream ? `Account connected; playback is served from <code>customer-${e(c.stream.customerCode)}.cloudflarestream.com</code> with signed URLs.`
      : `Needed for uploads, live inputs and playback. Missing: ${(c?.streamBlockers ?? ['configuration']).map((b) => e(b)).join(' ')}`),
    item(Boolean(c?.stream?.webhookSecret), 'Cloudflare Stream webhook', c?.stream?.webhookSecret ? 'Ready notifications are verified with the webhook secret.'
      : `Optional but recommended: set <code>${WEBINAR_ENV.webhookSecret}</code> after registering <code>/api/webinars/stream-webhook</code> as the Stream webhook URL. Without it the worker still polls Cloudflare.`),
    item(Boolean(c?.accessSecret), 'Attendee access links', c?.accessSecret ? 'Personal links are signed.' : `Set <code>${WEBINAR_ENV.accessSecret}</code> (32+ random characters). Registration is closed until it is set.`),
    item(Boolean(c?.defaultPublicOrigin || (setup.workspaceId && c?.workspaceOrigins.get(setup.workspaceId.toLowerCase()))), 'Public link origin',
      `Emailed links use <code>${WEBINAR_ENV.publicOrigin}</code> (or this brand's entry in <code>${WEBINAR_ENV.workspaceOrigins}</code>).`),
    item(Boolean(c && c.emailMode !== 'off' && sender), 'Confirmation and reminder emails',
      !c || c.emailMode === 'off' ? `Email is off. Set <code>${WEBINAR_ENV.emailMode}</code> to <code>test</code> (only <code>${WEBINAR_ENV.emailTestRecipients}</code>) or <code>live</code>. Messages wait in the queue until then; reminders whose time passes are skipped, never sent late.`
        : sender ? `Mode <strong>${e(c.emailMode)}</strong>, sending as <code>${e(sender.from)}</code> on Postmark stream <code>${e(sender.messageStream)}</code>.`
        : `No sender for this brand. Add this workspace to <code>${WEBINAR_ENV.senders}</code>; another brand's sender is never used.`),
    item(setup.crmAvailable, 'CRM handoff', setup.crmAvailable ? 'Registrants can be sent to the CRM through the existing lead command.' : 'The CRM command identity is not connected on this deployment.'),
  ];
  return `<ul class="wb-checklist">${items.join('')}</ul>`;
}

export function unavailablePage(setup: SetupStatus): string {
  return `${CSS}<header class="page-heading"><div><div class="eyebrow">Webinars</div><h1>Webinars need a little setup</h1>
<p>Native webinars run on this workspace's database with Cloudflare Stream for video. Nothing is simulated: each item below names exactly what enables it.</p></div></header>
<section class="panel"><div class="panel-body" style="padding-top:18px">${setupChecklist(setup)}</div></section>`;
}

export function listPage(input: { profile: WorkspaceProfile; webinars: readonly WebinarSummary[]; setup: SetupStatus; notice: string | null; error: string | null }): string {
  const rows = input.webinars.map(({ event: ev, counts }) => `<tr>
<td><a href="${WEBINARS_BASE}/${e(ev.id)}"><strong>${e(ev.title)}</strong></a><div class="wb-help">${e(KIND_LABEL[ev.kind])}</div></td>
<td>${when(ev)}</td><td>${statusPill(ev)}</td><td>${counts.registered}</td><td>${counts.pendingQuestions ? `<strong>${counts.pendingQuestions}</strong> pending` : '—'}</td></tr>`).join('');
  const ready = Boolean(input.setup.config?.stream);
  return `${CSS}<header class="page-heading"><div><div class="eyebrow">${e(input.profile.name)} · Webinars</div><h1>Webinars</h1>
<p>Live, on-demand and scheduled presentations for this brand, watched on your own branded pages.</p></div>
<div class="page-heading-actions"><a class="button" href="${WEBINARS_BASE}/new">New webinar</a></div></header>${notice(input.notice, input.error)}
${ready ? '' : `<section class="panel"><div class="panel-head"><div class="panel-title-wrap"><h2>Finish video setup</h2><p class="panel-subtitle">You can create and edit webinars now; video controls unlock when Cloudflare Stream is configured.</p></div></div><div class="panel-body">${setupChecklist(input.setup)}</div></section>`}
<section class="panel"><div class="panel-body">${input.webinars.length ? `<table class="data-table"><thead><tr><th>Webinar</th><th>When</th><th>Status</th><th>Registered</th><th>Questions</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="empty-state"><h3>No webinars yet</h3><p>Create your first webinar for ${e(input.profile.name)}.</p><a class="button" href="${WEBINARS_BASE}/new">New webinar</a></div>`}</div></section>
${ready ? `<details class="panel" style="padding:14px 18px"><summary><strong>Setup status</strong></summary><div style="margin-top:12px">${setupChecklist(input.setup)}</div></details>` : ''}`;
}

function settingsFields(s: WebinarSettings): string {
  const q = s.questions.map((x) => `${x.label}${x.required ? ' *' : ''}${x.type === 'select' ? ` | ${x.options.join(', ')}` : ''}`).join('\n');
  const cta = s.cta;
  return `<fieldset class="wb-form" style="border:0;padding:0;margin:0"><legend class="eyebrow">Registration</legend>
<div><label for="questions">Extra questions (optional)</label><textarea id="questions" name="questions" placeholder="One per line. End with * if required. Add choices after |, e.g.&#10;Investment budget * | Under £50k, £50k–£150k, Over £150k">${e(q)}</textarea><p class="wb-help">Name and email are always asked. Up to five extra questions.</p></div>
<div><label for="serviceNotice">What registering signs people up for</label><textarea id="serviceNotice" name="serviceNotice">${e(s.serviceNotice)}</textarea></div>
<div><label for="marketingConsentText">Optional marketing opt-in wording</label><input id="marketingConsentText" name="marketingConsentText" value="${e(s.marketingConsentText ?? '')}" placeholder="Leave blank for no marketing checkbox"><p class="wb-help">Shown as an unticked checkbox. Registration alone never grants marketing permission.</p></div>
<div class="wb-row"><div><label for="privacyUrl">Privacy policy URL</label><input id="privacyUrl" name="privacyUrl" type="url" value="${e(s.privacyUrl ?? '')}" placeholder="https://"></div>
<div><label for="consentVersion">Consent wording version</label><input id="consentVersion" name="consentVersion" value="${e(s.consentVersion)}" maxlength="40"></div></div>
<legend class="eyebrow" style="margin-top:8px">Call to action</legend>
<div class="wb-row"><div><label for="ctaLabel">Button text</label><input id="ctaLabel" name="ctaLabel" value="${e(cta?.label ?? '')}" maxlength="80" placeholder="e.g. Book a call"></div>
<div><label for="ctaUrl">Destination (https)</label><input id="ctaUrl" name="ctaUrl" type="url" value="${e(cta?.url ?? '')}" placeholder="https://"></div></div>
<div><label for="ctaBody">Supporting line (optional)</label><input id="ctaBody" name="ctaBody" value="${e(cta?.body ?? '')}" maxlength="400"></div>
<div class="wb-row"><div><label for="ctaMode">When it appears</label><select id="ctaMode" name="ctaMode"><option value="manual"${cta?.mode !== 'timed' ? ' selected' : ''}>When the host reveals it</option><option value="timed"${cta?.mode === 'timed' ? ' selected' : ''}>At a set time into the session</option></select></div>
<div><label for="ctaAtMinutes">Minutes into the session (timed only)</label><input id="ctaAtMinutes" name="ctaAtMinutes" type="number" min="0" max="1440" value="${cta?.atSeconds != null ? Math.round(cta.atSeconds / 60) : ''}"></div></div>
<p class="wb-help">Use only owner-approved copy and destinations. A click is recorded as a click — not a purchase or booking.</p>
<legend class="eyebrow" style="margin-top:8px">Replay, reminders and questions</legend>
<div class="wb-row"><div><label class="wb-check"><input type="checkbox" name="replayEnabled" value="1"${s.replay.enabled ? ' checked' : ''}> Offer a replay</label></div>
<div><label for="replayDays">Replay available for (days, blank = no limit)</label><input id="replayDays" name="replayDays" type="number" min="1" max="3650" value="${s.replay.availableDays ?? ''}"></div></div>
<div class="wb-row"><div><label for="reminders">Reminders (minutes before start)</label><input id="reminders" name="reminders" value="${e(s.reminderOffsetsMinutes.join(', '))}" placeholder="1440, 60"><p class="wb-help">Up to four. Reminders whose time has passed are skipped, never sent late.</p></div>
<div><label for="roomOpens">Room opens (minutes before start)</label><input id="roomOpens" name="roomOpens" type="number" min="0" max="120" value="${s.roomOpensMinutesBefore}"></div></div>
<div class="wb-row"><div><label class="wb-check"><input type="checkbox" name="questionsEnabled" value="1"${s.questionsEnabled ? ' checked' : ''}> Attendees can ask questions</label></div>
<div><label class="wb-check"><input type="checkbox" name="questionsModerated" value="1"${s.questionsModerated ? ' checked' : ''}> Hold questions for approval before others see them</label></div></div>
<div class="wb-row"><div><label for="accentColor">Accent colour (optional)</label><input id="accentColor" name="accentColor" value="${e(s.accentColor ?? '')}" placeholder="#2563eb" maxlength="7"><p class="wb-help">Defaults to the brand colour.</p></div>
<div><label for="crmPrefix">CRM opportunity prefix</label><input id="crmPrefix" name="crmPrefix" value="${e(s.crmOpportunityPrefix)}" maxlength="40"></div></div></fieldset>`;
}

export function editPage(input: { profile: WorkspaceProfile; csrf: string; event: (WebinarEvent & { rowVersion: number }) | null; settings: WebinarSettings; error: string | null; notice: string | null; values?: Record<string, string> }): string {
  const ev = input.event;
  const v = (k: string, fallback: string) => input.values?.[k] ?? fallback;
  const tz = v('timezone', ev?.timezone ?? input.profile.timezone);
  const kind = v('kind', ev?.kind ?? 'live');
  const locked = ev !== null && ev.status !== 'draft';
  const action = ev ? `${WEBINARS_BASE}/${e(ev.id)}` : WEBINARS_BASE;
  const zones = ['Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney', 'UTC'];
  if (!zones.includes(tz)) zones.unshift(tz);
  return `${ev ? '' : CSS}<form class="wb-form" method="post" action="${action}">${csrfField(input.csrf)}${ev ? `<input type="hidden" name="rowVersion" value="${ev.rowVersion}">` : ''}
${notice(input.notice, input.error)}
<div><label for="kind">Type</label><select id="kind" name="kind"${locked ? ' disabled' : ''}>
<option value="live"${kind === 'live' ? ' selected' : ''}>Live webinar — you broadcast at the start time; the recording becomes the replay</option>
<option value="scheduled_recording"${kind === 'scheduled_recording' ? ' selected' : ''}>Scheduled presentation of a recording — shown at a set time, clearly labelled as recorded</option>
<option value="on_demand"${kind === 'on_demand' ? ' selected' : ''}>On-demand recording — watch any time</option></select>
${locked ? `<input type="hidden" name="kind" value="${e(kind)}"><p class="wb-help">The type cannot change after publishing.</p>` : ''}</div>
<div><label for="title">Title</label><input id="title" name="title" required minlength="2" maxlength="160" value="${e(v('title', ev?.title ?? ''))}"></div>
<div><label for="summary">Description</label><textarea id="summary" name="summary" maxlength="4000">${e(v('summary', ev?.summary ?? ''))}</textarea></div>
<div class="wb-row"><div><label for="presenterName">Presenter</label><input id="presenterName" name="presenterName" maxlength="120" value="${e(v('presenterName', ev?.presenterName ?? ''))}"></div>
<div><label for="presenterTitle">Presenter's role</label><input id="presenterTitle" name="presenterTitle" maxlength="160" value="${e(v('presenterTitle', ev?.presenterTitle ?? ''))}"></div></div>
<div class="wb-row"><div><label for="startsLocal">Start (local time)</label><input id="startsLocal" name="startsLocal" type="datetime-local" value="${e(v('startsLocal', ev ? utcToLocalInput(ev.startsAt, ev.timezone) : ''))}"><p class="wb-help">Not used for on-demand. Stored in UTC; daylight saving is handled for you.</p></div>
<div><label for="timezone">Timezone</label><select id="timezone" name="timezone">${zones.map((z) => `<option${z === tz ? ' selected' : ''}>${e(z)}</option>`).join('')}</select></div></div>
<div class="wb-row"><div><label for="durationMinutes">Duration (minutes)</label><input id="durationMinutes" name="durationMinutes" type="number" min="5" max="480" required value="${e(v('durationMinutes', String(ev?.durationMinutes ?? 60)))}"></div>
<div><label for="capacity">Capacity (optional)</label><input id="capacity" name="capacity" type="number" min="1" max="100000" value="${e(v('capacity', ev?.capacity != null ? String(ev.capacity) : ''))}"><p class="wb-help">Registration closes when reached.</p></div></div>
${settingsFields(input.settings)}
<div class="wb-actions"><button class="button" type="submit">${ev ? 'Save changes' : 'Create webinar'}</button>${ev ? '' : `<a class="button secondary" href="${WEBINARS_BASE}">Cancel</a>`}</div>
${ev && ev.status === 'published' && ev.kind !== 'on_demand' ? '<p class="wb-help">Changing the start time tells every registrant, replaces their pending reminders and never sends reminders for the old time.</p>' : ''}
</form>`;
}

export function newPage(input: { profile: WorkspaceProfile; csrf: string; settings: WebinarSettings; error: string | null; values?: Record<string, string> }): string {
  return `${CSS}<header class="page-heading"><div><div class="eyebrow"><a href="${WEBINARS_BASE}">Webinars</a> · ${e(input.profile.name)}</div><h1>New webinar</h1><p>It stays a private draft until you publish it.</p></div></header>
<section class="panel"><div class="panel-body" style="padding-top:18px">${editPage({ ...input, event: null, notice: null })}</div></section>`;
}

export function eventFrame(input: { profile: WorkspaceProfile; event: WebinarEvent; counts: WebinarCounts; tab: WebinarTab; csrf: string; publicUrl: string | null; notice: string | null; error: string | null; body: string }): string {
  const ev = input.event;
  const tabs: [WebinarTab, string][] = [['details', 'Details'], ['video', ev.kind === 'live' ? 'Broadcast setup' : 'Video'], ['host', ev.kind === 'live' ? 'Host controls' : 'Preview & CTA'],
    ['people', `People (${input.counts.registered})`], ['questions', `Questions${input.counts.pendingQuestions ? ` (${input.counts.pendingQuestions})` : ''}`], ['messages', 'Reminders'], ['results', 'Results']];
  const statusActions = ev.status === 'draft'
    ? `<form method="post" action="${WEBINARS_BASE}/${e(ev.id)}/status">${csrfField(input.csrf)}<input type="hidden" name="action" value="publish"><button class="button" type="submit">Publish</button></form>`
    : ev.status === 'published'
      ? `<form method="post" action="${WEBINARS_BASE}/${e(ev.id)}/status" data-confirm="Cancel this webinar and email every registrant?">${csrfField(input.csrf)}<input type="hidden" name="action" value="cancel"><button class="button secondary" type="submit">Cancel webinar</button></form>`
      : '';
  return `${CSS}<header class="page-heading"><div><div class="eyebrow"><a href="${WEBINARS_BASE}">Webinars</a> · ${e(input.profile.name)}</div>
<h1>${e(ev.title)}</h1><p>${statusPill(ev)} <span class="wb-muted">${e(KIND_LABEL[ev.kind])} · ${when(ev)}</span></p></div>
<div class="page-heading-actions wb-actions"><a class="button secondary" href="${WEBINARS_BASE}/${e(ev.id)}/preview" target="_blank" rel="noopener">Preview registration page</a>${statusActions}</div></header>
${input.publicUrl && ev.status === 'published' ? `<p class="notice" role="note">Public registration link: <a href="${e(input.publicUrl)}" target="_blank" rel="noopener">${e(input.publicUrl)}</a></p>` : ''}
${notice(input.notice, input.error)}
<nav class="wb-tabs" aria-label="Webinar sections">${tabs.map(([t, label]) => `<a href="${WEBINARS_BASE}/${e(ev.id)}${t === 'details' ? '' : `/${t}`}"${t === input.tab ? ' aria-current="page"' : ''}>${e(label)}</a>`).join('')}</nav>
${input.body}<script src="${WEBINARS_ASSET}" defer></script>`;
}

export function detailsTab(input: { profile: WorkspaceProfile; event: WebinarEvent & { rowVersion: number }; csrf: string }): string {
  const ev = input.event;
  const archive = ev.status === 'cancelled' || (ev.status === 'published' && ev.sessionState !== 'live')
    ? `<form method="post" action="${WEBINARS_BASE}/${e(ev.id)}/status" data-confirm="Archive this webinar? It disappears from the list and its public page closes.">${csrfField(input.csrf)}<input type="hidden" name="action" value="archive"><button class="button secondary compact" type="submit">Archive</button></form>` : '';
  const unpublish = ev.status === 'published'
    ? `<form method="post" action="${WEBINARS_BASE}/${e(ev.id)}/status">${csrfField(input.csrf)}<input type="hidden" name="action" value="unpublish"><button class="button secondary compact" type="submit">Return to draft</button></form>` : '';
  return `<section class="panel"><div class="panel-body" style="padding-top:18px">${ev.status === 'cancelled' || ev.status === 'archived'
    ? `<p>This webinar is ${e(ev.status)} and can no longer be edited.</p>`
    : editPage({ profile: input.profile, csrf: input.csrf, event: ev, settings: ev.settings, error: null, notice: null })}
${archive || unpublish ? `<div class="wb-actions" style="margin-top:18px">${unpublish}${archive}</div><p class="wb-help">Returning to draft is only possible before anyone registers.</p>` : ''}</div></section>`;
}

function streamBlocked(setup: SetupStatus): string {
  return `<div class="notice" role="note"><strong>Video controls are unavailable.</strong> ${(setup.config?.streamBlockers ?? []).map((b) => e(b)).join(' ')}</div>`;
}

export function videoTab(input: { event: WebinarEvent; csrf: string; setup: SetupStatus; credentials: { rtmpsUrl: string | null; rtmpsStreamKey: string | null; srtUrl: string | null; srtStreamId: string | null; srtPassphrase: string | null } | null; provisionState: string | null }): string {
  const ev = input.event;
  const stream = Boolean(input.setup.config?.stream);
  const id = e(ev.id);
  if (ev.kind !== 'live') {
    const state: Record<string, string> = { none: 'No video yet', awaiting_upload: 'Waiting for the upload to finish', processing: 'Cloudflare is processing the video', ready: 'Ready to play', failed: 'Cloudflare could not process this video' };
    return `<section class="panel"><div class="panel-head"><div class="panel-title-wrap"><h2>Recording</h2><p class="panel-subtitle">Uploaded straight from your browser to Cloudflare Stream in resumable 50 MB pieces — large files survive a dropped connection.</p></div></div>
<div class="panel-body"><p><span class="wb-status ${ev.videoState === 'ready' ? 'ok' : ev.videoState === 'failed' ? 'bad' : 'warn'}">${e(state[ev.videoState] ?? ev.videoState)}</span>
${ev.videoDurationSeconds ? ` <span class="wb-muted">${Math.round(ev.videoDurationSeconds / 60)} minutes</span>` : ''}</p>
${stream ? `<div data-upload data-event="${id}" data-csrf="${e(input.csrf)}" data-max-minutes="${input.setup.config!.limits.maxUploadMinutes}">
<label for="video-file"><strong>${ev.videoState === 'ready' ? 'Replace' : 'Choose'} a video file</strong></label><input id="video-file" type="file" accept="video/*">
<div class="wb-progress" style="margin:10px 0" aria-hidden="true"><span></span></div><p class="wb-help" data-upload-status role="status">Videos up to ${input.setup.config!.limits.maxUploadMinutes} minutes (WEBINAR_MAX_UPLOAD_MINUTES). Stream stores and bills by minute.</p>
<button class="button" type="button" data-upload-start disabled>Upload to Cloudflare</button></div>` : streamBlocked(input.setup)}
${ev.status === 'published' && ev.videoState === 'ready' ? '<p class="wb-help">To replace the video of a published webinar, return it to draft first.</p>' : ''}</div></section>`;
  }
  const provisionUnknown = input.provisionState === 'unknown' || ev.liveState === 'unknown' && !ev.liveInputUid;
  const creds = input.credentials;
  return `<section class="panel"><div class="panel-head"><div class="panel-title-wrap"><h2>Broadcast setup</h2><p class="panel-subtitle">Broadcast from OBS, StreamYard or Restream over RTMPS (or SRT). Cloudflare records the session automatically and the recording becomes the replay.</p></div></div>
<div class="panel-body">
${!stream ? streamBlocked(input.setup) : !ev.liveInputUid ? (provisionUnknown
  ? `<p class="notice" role="alert">A previous request may have created a live input at Cloudflare but we did not get the answer. Check before creating another one, so you are never billed twice.</p>
<form method="post" action="${WEBINARS_BASE}/${id}/live-input/reconcile">${csrfField(input.csrf)}<button class="button" type="submit">Check Cloudflare</button></form>`
  : `<p>This webinar does not have a live input yet. Creating one reserves a Cloudflare Stream live input for this brand (limit ${input.setup.config!.limits.maxLiveInputsPerWorkspace} per brand).</p>
<form method="post" action="${WEBINARS_BASE}/${id}/live-input">${csrfField(input.csrf)}<button class="button" type="submit"${ev.liveState === 'provisioning' ? ' disabled' : ''}>${ev.liveState === 'provisioning' ? 'Creating…' : 'Create live input'}</button></form>`)
  : `<p><span class="wb-status ok">Live input ready</span> <span class="wb-muted">Cloudflare live input <code>${e(ev.liveInputUid.slice(0, 8))}…</code></span></p>
${creds ? `<div class="wb-grid"><div><h3>RTMPS (OBS, StreamYard, Restream)</h3><p class="wb-help">Server / URL</p><div class="wb-secret">${e(creds.rtmpsUrl ?? '—')}</div><p class="wb-help">Stream key — treat like a password</p><div class="wb-secret">${e(creds.rtmpsStreamKey ?? '—')}</div></div>
<div><h3>SRT (optional)</h3><p class="wb-help">URL</p><div class="wb-secret">${e(creds.srtUrl ?? '—')}</div><p class="wb-help">Stream ID / passphrase</p><div class="wb-secret">${e(creds.srtStreamId ?? '—')} / ${e(creds.srtPassphrase ?? '—')}</div></div></div>
<p class="wb-help">Shown once on this page and never stored by us. Reload to hide.</p>`
    : `<form method="post" action="${WEBINARS_BASE}/${id}/live-input/credentials">${csrfField(input.csrf)}<button class="button secondary" type="submit">Show encoder settings</button></form>`}
<ol class="wb-help" style="margin-top:16px;line-height:1.6"><li>Paste the RTMPS URL and key into OBS (Settings → Stream → Custom) or StreamYard (Destinations → Custom RTMP).</li>
<li>Start streaming. Host controls shows "Encoder connected" and a private preview — attendees still see the waiting room.</li>
<li>When ready, press <strong>Go live</strong>. Press <strong>End session</strong> when you finish; the recording becomes the replay once Cloudflare has processed it.</li></ol>`}
<h3 style="margin-top:20px">Broadcasting from the browser</h3>
<p class="wb-help"><span class="wb-status warn">Not available</span> Cloudflare Stream's browser (WebRTC/WHIP) ingest does not record and cannot be played as signed HLS, so it would give no replay and no access control. Use an encoder above. Host controls includes a camera and microphone check.</p>
</div></section>`;
}

export function hostTab(input: { event: WebinarEvent; csrf: string; setup: SetupStatus; room: RoomState }): string {
  const ev = input.event;
  const id = e(ev.id);
  const cta = ev.settings.cta;
  const live = ev.kind === 'live';
  const conn: Record<string, [string, string]> = {
    not_provisioned: ['warn', 'No live input'], provisioning: ['warn', 'Creating live input'], idle: ['warn', 'Encoder not connected'],
    connected: ['ok', 'Encoder connected'], reconnecting: ['warn', 'Encoder reconnecting'], disconnected: ['bad', 'Encoder disconnected'], unknown: ['warn', 'Status unknown'],
  };
  const [cc, cl] = conn[ev.liveState] ?? ['warn', ev.liveState];
  const rec: Record<string, string> = { none: 'Not started', processing: 'Processing at Cloudflare', ready: 'Replay ready', failed: 'Recording failed', not_recorded: 'No recording was made' };
  const sessionControls = !live ? '' : ev.status !== 'published' ? '<p class="wb-help">Publish the webinar to go live.</p>'
    : ev.sessionState === 'scheduled' ? `<form method="post" action="${WEBINARS_BASE}/${id}/session" data-confirm="Open the broadcast to attendees now?">${csrfField(input.csrf)}<input type="hidden" name="action" value="start"><button class="button" type="submit"${ev.liveInputUid ? '' : ' disabled'}>Go live</button></form>`
    : ev.sessionState === 'live' ? `<form method="post" action="${WEBINARS_BASE}/${id}/session" data-confirm="End the session for everyone? The recording becomes the replay.">${csrfField(input.csrf)}<input type="hidden" name="action" value="end"><button class="button" type="submit" style="background:#dc2626;border-color:#dc2626">End session</button></form>`
    : '<p class="wb-help">This session has ended.</p>';
  return `<div class="wb-grid" data-host data-event="${id}">
<section class="panel"><div class="panel-head"><div class="panel-title-wrap"><h2>${live ? 'Broadcast' : 'Preview'}</h2><p class="panel-subtitle">${live ? 'Private preview of what Cloudflare is receiving. Attendees see it only after Go live.' : 'The video attendees will see.'}</p></div></div>
<div class="panel-body"><video class="wb-video" data-preview controls playsinline muted></video><p class="wb-help" data-preview-status role="status">${input.setup.config?.stream ? 'Loading preview…' : 'Preview needs Cloudflare Stream configuration.'}</p></div></section>
<section class="panel"><div class="panel-head"><div class="panel-title-wrap"><h2>Status</h2><p class="panel-subtitle">Refreshes every 10 seconds.</p></div></div><div class="panel-body">
<p><strong>Attendees see:</strong> <span class="wb-status ${input.room.state === 'live' ? 'live' : ''}" data-room-label>${e(input.room.label)}</span></p>
${live ? `<p><strong>Encoder:</strong> <span class="wb-status ${cc}" data-live-state>${e(cl)}</span></p><p><strong>Session:</strong> <span class="wb-status">${e(ev.sessionState)}</span></p>
<p><strong>Recording:</strong> <span class="wb-status ${ev.recordingState === 'ready' ? 'ok' : ev.recordingState === 'failed' || ev.recordingState === 'not_recorded' ? 'bad' : ''}">${e(rec[ev.recordingState] ?? ev.recordingState)}</span></p>` : ''}
<div class="wb-actions">${sessionControls}</div></div></section>
<section class="panel"><div class="panel-head"><div class="panel-title-wrap"><h2>Call to action</h2></div></div><div class="panel-body">
${cta ? `<p><strong>${e(cta.label)}</strong> → <span class="wb-muted">${e(cta.url)}</span></p>
${cta.mode === 'timed' ? `<p class="wb-help">Appears automatically ${cta.atSeconds != null ? `${Math.round(cta.atSeconds / 60)} minutes` : ''} into the session (and at the same point of the replay).</p>`
  : `<p>Currently <strong>${ev.ctaRevealedAt ? 'visible to attendees' : 'hidden'}</strong>.</p><form method="post" action="${WEBINARS_BASE}/${id}/cta">${csrfField(input.csrf)}<input type="hidden" name="action" value="${ev.ctaRevealedAt ? 'hide' : 'reveal'}"><button class="button${ev.ctaRevealedAt ? ' secondary' : ''}" type="submit">${ev.ctaRevealedAt ? 'Hide' : 'Reveal to attendees'}</button></form>`}`
  : '<p class="wb-help">No call to action configured. Add one in Details.</p>'}</div></section>
${live ? `<section class="panel"><div class="panel-head"><div class="panel-title-wrap"><h2>Camera and microphone check</h2><p class="panel-subtitle">Local check only — nothing is broadcast from this page.</p></div></div><div class="panel-body">
<video class="wb-video" data-camera playsinline muted style="transform:scaleX(-1)"></video><div class="wb-meter" style="margin:10px 0" aria-label="Microphone level"><span data-meter></span></div>
<div class="wb-actions"><button class="button secondary" type="button" data-camera-start>Start check</button><button class="button secondary" type="button" data-camera-stop disabled>Stop</button></div><p class="wb-help" data-camera-status role="status"></p></div></section>` : ''}
</div>`;
}

export function peopleTab(input: { event: WebinarEvent; rows: readonly RegistrationRow[]; csrf: string; crmAvailable: boolean }): string {
  const ev = input.event;
  const unlinked = input.rows.filter((r) => r.status === 'registered' && !r.crmContactId).length;
  const yes = (b: boolean) => (b ? 'Yes' : '—');
  const rows = input.rows.map((r) => `<tr><td><strong>${e(r.name)}</strong><div class="wb-help">${e(r.email)}</div></td><td>${e(new Date(r.createdAt).toLocaleString('en-GB', { timeZone: ev.timezone }))}</td>
<td>${r.status === 'registered' ? '' : 'Cancelled'}${yes(r.accessedRoom)}</td><td>${yes(r.playerStarted)}</td><td>${r.watchedSeconds ? `${Math.round(r.watchedSeconds / 60)} min` : '—'}</td><td>${yes(r.ctaClicked)}</td><td>${r.questions || '—'}</td>
<td>${r.marketingConsent ? 'Opted in' : 'No'}</td><td>${r.crmContactId ? 'Linked' : '—'}</td></tr>`).join('');
  return `<section class="panel"><div class="panel-head"><div class="panel-title-wrap"><h2>Registrants</h2>
<p class="panel-subtitle">"Opened room" is a page visit, not attendance. "Started player" and "Watched" come from the player itself, in 30-second intervals.</p></div>
<div class="wb-actions"><a class="button secondary compact" href="${WEBINARS_BASE}/${e(ev.id)}/people.csv">Download CSV</a>
${input.crmAvailable ? `<form method="post" action="${WEBINARS_BASE}/${e(ev.id)}/crm">${csrfField(input.csrf)}<button class="button compact" type="submit"${unlinked ? '' : ' disabled'}>Send ${unlinked ? `${Math.min(unlinked, 25)} ` : ''}to CRM</button></form>` : '<span class="wb-help">CRM handoff is not connected on this deployment.</span>'}</div></div>
<div class="panel-body">${input.rows.length ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Person</th><th>Registered</th><th>Opened room</th><th>Started player</th><th>Watched</th><th>CTA click</th><th>Questions</th><th>Marketing</th><th>CRM</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<div class="empty-state"><p>No registrations yet.</p></div>'}
<p class="wb-help">Sending to the CRM creates or updates the contact through the existing lead command (one idempotent command per registration). Email permission is recorded as unknown; registration is not marketing consent.</p></div></section>`;
}

export function questionsTab(input: { event: WebinarEvent; rows: readonly QuestionRow[]; csrf: string }): string {
  const ev = input.event;
  const label: Record<string, string> = { pending: 'Awaiting approval', approved: 'Visible to attendees', answered: 'Answered', dismissed: 'Dismissed' };
  const card = (q: QuestionRow) => `<div class="wb-q"><p><strong>${e(q.askedBy)}</strong> <span class="wb-status ${q.status === 'pending' ? 'warn' : q.status === 'answered' ? 'ok' : ''}">${e(label[q.status] ?? q.status)}</span> <span class="wb-muted">${e(new Date(q.createdAt).toLocaleString('en-GB', { timeZone: ev.timezone }))}</span></p>
<p>${e(q.body)}</p>${q.answer ? `<p class="wb-muted"><strong>Answer:</strong> ${e(q.answer)}</p>` : ''}
${q.status !== 'dismissed' ? `<form method="post" action="${WEBINARS_BASE}/${e(ev.id)}/questions/${e(q.id)}" class="wb-actions" style="margin-top:8px">${csrfField(input.csrf)}
${q.status === 'pending' ? '<button class="button compact" name="action" value="approve">Show to attendees</button>' : ''}
<input name="answer" placeholder="Type an answer" maxlength="2000" style="flex:1;min-width:200px;padding:7px 9px;border:1px solid var(--line,#cbd3df);border-radius:8px">
<button class="button secondary compact" name="action" value="answer">Answer</button><button class="button secondary compact" name="action" value="dismiss">Dismiss</button></form>` : ''}</div>`;
  return `<section class="panel"><div class="panel-head"><div class="panel-title-wrap"><h2>Questions</h2><p class="panel-subtitle">${ev.settings.questionsModerated ? 'Questions wait here until you show them. Attendees always see their own.' : 'Questions appear to attendees immediately.'} Up to 3 questions per person every 5 minutes.</p></div>
<a class="button secondary compact" href="${WEBINARS_BASE}/${e(ev.id)}/questions">Refresh</a></div>
<div class="panel-body">${input.rows.length ? input.rows.map(card).join('') : '<div class="empty-state"><p>No questions yet.</p></div>'}</div></section>`;
}

export function messagesTab(input: { event: WebinarEvent; rows: readonly MessageStatusRow[]; setup: SetupStatus }): string {
  const purpose: Record<string, string> = { confirmation: 'Confirmation', reminder: 'Reminders', reschedule: 'New-time notices', cancellation: 'Cancellation notices', replay_available: 'Replay ready', access_link: 'Access links' };
  const state: Record<string, string> = { queued: 'Waiting', leased: 'Sending', calling: 'Sending', done: 'Sent', unknown: 'Outcome unknown (not resent)', failed: 'Failed', cancelled: 'Cancelled', expired: 'Skipped (too late)', blocked: 'Blocked' };
  const rows = input.rows.map((r) => `<tr><td>${e(purpose[r.purpose] ?? r.purpose)}</td><td>${e(state[r.state] ?? r.state)}</td><td>${r.count}</td><td class="wb-help">${e(r.lastDetail ?? '')}</td></tr>`).join('');
  return `<section class="panel"><div class="panel-head"><div class="panel-title-wrap"><h2>Reminders and follow-up</h2><p class="panel-subtitle">Event-service emails only. Marketing follow-up stays in your existing sequences and needs the registrant's opt-in.</p></div></div>
<div class="panel-body">${rows ? `<table class="data-table"><thead><tr><th>Message</th><th>State</th><th>Count</th><th>Latest note</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty-state"><p>Nothing queued yet. Messages are queued when people register.</p></div>'}
<details style="margin-top:14px"><summary><strong>Delivery setup</strong></summary><div style="margin-top:10px">${setupChecklist(input.setup)}</div></details></div></section>`;
}

export function resultsTab(input: { event: WebinarEvent; results: WebinarResults }): string {
  const r = input.results;
  const metric = (label: string, value: string | number, note: string) => `<div class="metric"><div class="metric-head">${e(label)}</div><div class="n" style="font-size:1.8rem;font-weight:700">${e(String(value))}</div><div class="metric-context">${e(note)}</div></div>`;
  return `<section class="panel"><div class="panel-head"><div class="panel-title-wrap"><h2>Results</h2><p class="panel-subtitle">Each number says where it comes from. Nothing is estimated from aggregate video analytics.</p></div></div>
<div class="panel-body"><div class="metric-grid">${metric('Registered', r.registered, 'Registration records')}${metric('Opened the room', r.accessedRoom, 'Page visits — not attendance')}
${metric('Started the player', r.playerStarted, 'Player reported playback')}${metric('Observed viewing', `${r.totalObservedMinutes} min`, 'Sum of 30-second player intervals')}
${metric('CTA clicks', r.ctaClickers, 'People who clicked — not purchases')}${metric('Questions', r.questions, 'Submitted in the room')}${metric('In CRM', r.crmLinked, 'Registrations linked to a CRM contact')}</div>
<h3 style="margin-top:18px">Watched at least…</h3><table class="data-table"><thead><tr>${r.watchedAtLeast.map((w) => `<th>${w.minutes} min</th>`).join('')}</tr></thead><tbody><tr>${r.watchedAtLeast.map((w) => `<td>${w.people}</td>`).join('')}</tr></tbody></table>
${r.byMode.length ? `<h3 style="margin-top:18px">Started the player during</h3><table class="data-table"><tbody>${r.byMode.map((m) => `<tr><td>${e({ live: 'Live session', scheduled_recording: 'Scheduled presentation', replay: 'Replay', on_demand: 'On demand', waiting: 'Waiting room' }[m.mode] ?? m.mode)}</td><td>${m.people}</td></tr>`).join('')}</tbody></table>` : ''}
${r.bySource.length ? `<h3 style="margin-top:18px">By source</h3><table class="data-table"><thead><tr><th>Source (utm_source or referrer)</th><th>Registered</th><th>Started player</th></tr></thead><tbody>${r.bySource.map((s) => `<tr><td>${e(s.source)}</td><td>${s.registered}</td><td>${s.playerStarted}</td></tr>`).join('')}</tbody></table>` : ''}
<p class="wb-help" style="margin-top:14px">Applications, bookings and purchases are recorded in the CRM, not inferred here.</p></div></section>`;
}
