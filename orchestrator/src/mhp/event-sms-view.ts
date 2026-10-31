import { escapeHtml as esc } from '../portal/ui.js';
import { twilioSmsSegmentCount } from '../sms-live/foundation.js';
import { MHP_EVENT_SMS_CONSENT_TEXT, MHP_EVENT_SMS_OWNER_AGREEMENT, type MhpEventSmsOwnerSnapshot,
  type MhpEventSmsRecipientStatus, type MhpEventSmsSendResult } from './event-sms-service.js';

export const MHP_EVENT_SMS_PUBLIC_ROUTE = '/webinar/texts';
export const MHP_EVENT_SMS_OWNER_ROUTE = '/hq/marketing/event-texts';
const STYLE = 'body{margin:0;background:#f5f3ed;color:#142019;font:17px/1.6 system-ui,sans-serif}header,main{max-width:720px;margin:auto;padding:24px}'
  + 'section{background:#fff;border:1px solid #d9dfd5;border-radius:18px;padding:clamp(20px,4vw,36px);margin:20px 0}h1{font:clamp(30px,5vw,40px)/1.15 Georgia,serif;margin:8px 0 14px}'
  + 'label{display:block;margin:18px 0}input,button{font:inherit;box-sizing:border-box}input:not([type=checkbox]):not([type=hidden]){display:block;width:100%;padding:12px;border:1px solid #75846f;border-radius:8px;margin-top:8px}'
  + 'button{background:#e8a33d;border:0;border-radius:9px;padding:14px 20px;font-weight:700;cursor:pointer}button:disabled{opacity:.5;cursor:default}.check{display:flex;gap:12px;align-items:flex-start}.check input{flex:0 0 auto;margin-top:7px}'
  + '.small{font-size:15px;color:#4c5a51}.status{padding:14px 16px;background:#eaf0e5;border-radius:10px}blockquote{white-space:pre-wrap;overflow-wrap:anywhere;border-left:4px solid #e8a33d;padding:16px 20px;margin:16px 0;background:#f6f4ed}'
  + 'table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-top:1px solid #d9dfd5;vertical-align:top}a{color:inherit}nav{display:flex;gap:18px;flex-wrap:wrap}';
const page = (title: string, body: string, owner = false): string => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
  + `<meta name="robots" content="noindex"><title>${esc(title)} · Martin Howard Property</title><style>${STYLE}${owner ? 'header,main{max-width:980px}' : ''}</style></head><body><header><strong>Martin Howard Property${owner ? ' · Growth HQ' : ''}</strong>`
  + `${owner ? '<nav><a href="/hq/marketing">Marketing workspace</a><a href="/hq/marketing/phone-test">Phone test</a></nav>' : ''}</header><main>${body}</main></body></html>`;
const hidden = (name: string, value: string): string => `<input type="hidden" name="${name}" value="${esc(value)}">`;

export function mhpEventSmsOptinPage(input: { requestKey: string; notice?: string; email?: string }): string {
  return page('Webinar texts', `<span class="small">Optional</span><h1>Get a text before the webinar starts.</h1>`
    + `<p>Already registered? Add your mobile and we'll text you a reminder and the link to watch. Your email reminders carry on either way.</p>`
    + `${input.notice ? `<p role="status" class="status">${esc(input.notice)}</p>` : ''}`
    + `<section><form method="post" action="${MHP_EVENT_SMS_PUBLIC_ROUTE}">${hidden('requestKey', input.requestKey)}`
    + `<label for="email">The email you registered with<input id="email" name="email" type="email" autocomplete="email" maxlength="254" required value="${esc(input.email ?? '')}"></label>`
    + `<label for="mobile">Your UK mobile<input id="mobile" name="mobile" type="tel" inputmode="tel" autocomplete="tel" maxlength="32" placeholder="07123 456789" required></label>`
    + `<label class="check" for="consent"><input id="consent" type="checkbox" name="consent" value="yes" required>${esc(MHP_EVENT_SMS_CONSENT_TEXT)}</label>`
    + `<button>Text me a code</button><p class="small">We'll text a six-digit code to check the number is yours. Martin Howard Property is a trading name of MH196 Ltd. We only use this number for this webinar.</p></form></section>`);
}
export function mhpEventSmsCodePage(input: { optinId: string; notice?: string }): string {
  return page('Check your phone', `<h1>Check your phone.</h1><p>If that email is registered for the webinar, we've just texted a six-digit code to your mobile. It expires in 10 minutes.</p>`
    + `${input.notice ? `<p role="status" class="status">${esc(input.notice)}</p>` : ''}`
    + `<section><form method="post" action="${MHP_EVENT_SMS_PUBLIC_ROUTE}/confirm">${hidden('optinId', input.optinId)}`
    + `<label for="code">Six-digit code<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>`
    + `<button>Confirm my number</button></form><p class="small">No text? Check the email matches the one you registered with, or <a href="${MHP_EVENT_SMS_PUBLIC_ROUTE}">start again</a>.</p></section>`);
}
export function mhpEventSmsDonePage(): string {
  return page('You are on the list', `<h1>You're on the text list.</h1><p>We'll text you about this webinar only. Reply STOP to any text and we'll stop straight away.</p>`
    + `<p><a href="https://martinhowardproperty.co.uk/">&larr; Back to Martin Howard Property</a></p>`);
}
export function mhpEventSmsMessagePage(title: string, message: string): string {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="${MHP_EVENT_SMS_PUBLIC_ROUTE}">Try again</a></p>`);
}

const STATUS_TEXT: Record<MhpEventSmsRecipientStatus, string> = {
  ready: 'Ready', email_unsubscribed: 'Unsubscribed from emails, so not texted', phone_shared: 'Number also claimed by someone else, so not texted',
  needs_import: 'Import webinar sign-ups to the CRM first', contact_ambiguous: 'More than one CRM contact has this email', opted_out: 'Replied STOP before, so never texted',
  consent_changed: 'Text permission changed since they opted in', already_sent: 'Already sent this text',
};
export function mhpEventSmsOwnerPage(input: { snapshot: MhpEventSmsOwnerSnapshot; csrf: string; commandId: string; result?: MhpEventSmsSendResult; notice?: string }): string {
  const { database, detail, choices } = input.snapshot;
  const segments = detail ? twilioSmsSegmentCount(detail.payload.bodyText) : 0;
  const total = segments * database.readyCount;
  const dayLeft = Math.max(0, 10 - database.daySegmentsUsed), monthLeft = Math.max(0, 50 - database.monthSegmentsUsed);
  const fits = detail && database.readyCount > 0 && total <= dayLeft && total <= monthLeft && database.bindingReady && database.batchSha256;
  const rows = database.recipients.map(r => `<tr><td>${esc(r.firstName ?? '')}<br><span class="small">${esc(r.email)}</span></td><td>&bull;&bull;&bull;&bull; ${esc(r.phoneLast4)}</td>`
    + `<td>${esc(new Date(r.verifiedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }))}</td><td>${esc(STATUS_TEXT[r.status])}</td></tr>`).join('');
  const send = detail && database.batchSha256 ? `<form method="post" action="${MHP_EVENT_SMS_OWNER_ROUTE}/send">${hidden('csrf', input.csrf)}${hidden('commandId', input.commandId)}`
    + `${hidden('itemId', detail.review.contentItemId)}${hidden('versionId', detail.review.contentVersionId)}${hidden('sha256', detail.review.contentSha256)}${hidden('batchSha256', database.batchSha256)}`
    + `<label class="check"><input type="checkbox" name="agreed" value="yes" required>${esc(MHP_EVENT_SMS_OWNER_AGREEMENT)}</label>`
    + `<button${fits ? '' : ' disabled'}>Send to ${esc(database.readyCount)} ${database.readyCount === 1 ? 'person' : 'people'} now</button></form>` : '';
  const batches = database.batches.length ? `<section><h2>Recorded batches</h2><table><thead><tr><th>When</th><th>People</th><th>Status</th></tr></thead><tbody>${database.batches.map(b =>
    `<tr><td>${esc(new Date(b.createdAt).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }))}</td><td>${esc(b.recipientCount)}</td>`
    + `<td>${esc(Object.entries(b.jobStates).map(([state, count]) => `${count} ${state.replace('_', ' ')}`).join(', '))}</td></tr>`).join('')}</tbody></table>`
    + `<p class="small">Queued is not delivered. If an outcome is unknown, check the provider record. This page never resends automatically.</p><p><a href="${MHP_EVENT_SMS_OWNER_ROUTE}">Refresh recorded status</a></p></section>` : '';
  return page('Webinar texts', `<h1>Webinar texts</h1><p>Registrants who added and confirmed their own mobile for <strong>${esc(database.campaign)}</strong>. `
    + `You review this exact list and text, then send once. Anyone who confirms after you look waits for your next review.</p>`
    + `${input.notice ? `<p role="status" class="status">${esc(input.notice)}</p>` : ''}${input.result ? `<p role="status" class="status">${input.result.replayed ? 'This is the saved outcome of your earlier send. Nothing new was queued.' : `${esc(input.result.recipientCount)} texts queued.`}</p>` : ''}`
    + `${database.bindingReady ? '' : '<p class="status">The MHP sender is not connected. Connect it on the phone test page first.</p>'}`
    + `<section><h2>1. Choose the saved text</h2>${choices.length ? `<p>${choices.map(c => `<a href="${MHP_EVENT_SMS_OWNER_ROUTE}?item=${encodeURIComponent(c.itemId)}&amp;version=${encodeURIComponent(c.versionId)}">${esc(c.label)}</a>`).join(' · ')}</p>` : '<p>Save a text on the phone test page first.</p>'}`
    + `${detail ? `<blockquote>${esc(detail.payload.bodyText)}</blockquote><p class="small">${esc(segments)} segment(s) each · ${esc(total)} for this batch · ${esc(dayLeft)} left today · ${esc(monthLeft)} left this month.</p>` : ''}</section>`
    + `<section><h2>2. Check who gets it</h2>${rows ? `<table><thead><tr><th>Registrant</th><th>Mobile</th><th>Confirmed</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>Nobody has confirmed a mobile yet.</p>'}`
    + `<p class="small">Each person proved the number is theirs with a code. The phone step does not prove they own the email address. This is your owner review, not external legal advice.</p></section>`
    + `${detail ? `<section><h2>3. Send</h2>${database.readyCount === 0 ? '<p>Nobody is ready for this text.</p>' : total > dayLeft || total > monthLeft ? '<p class="status">This batch is bigger than the remaining text allowance. It cannot be sent today.</p>' : ''}${send}</section>` : ''}`
    + batches, true);
}
