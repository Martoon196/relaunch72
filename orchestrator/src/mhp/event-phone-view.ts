import { escapeHtml as esc } from '../portal/ui.js';
import { MHP_EVENT_PHONE_CONSENT_TEXT, MHP_EVENT_PHONE_OWNER_ROUTE, MHP_EVENT_PHONE_ROUTE, type MhpEventPhoneStatus,
  type MhpEventProgrammeSummary, type MhpEventReview } from './event-phone-service.js';

const STYLE = 'body{margin:0;background:#f5f3ed;color:#142019;font:17px/1.6 system-ui,sans-serif}header,main{max-width:720px;margin:auto;padding:24px}'
  + 'section{background:#fff;border:1px solid #d9dfd5;border-radius:18px;padding:clamp(20px,4vw,36px);margin:20px 0}h1{font:clamp(30px,5vw,40px)/1.15 Georgia,serif;margin:8px 0 14px}'
  + 'label{display:block;margin:18px 0}input,button{font:inherit;box-sizing:border-box}input:not([type=checkbox]):not([type=hidden]){display:block;width:100%;padding:12px;border:1px solid #75846f;border-radius:8px;margin-top:8px}'
  + 'button{background:#e8a33d;border:0;border-radius:9px;padding:14px 20px;font-weight:700;cursor:pointer}.check{display:flex;gap:12px;align-items:flex-start}.check input{flex:0 0 auto;margin-top:7px}'
  + '.small{font-size:15px;color:#4c5a51}.status{padding:14px 16px;background:#eaf0e5;border-radius:10px}.code{font:700 22px/1.4 ui-monospace,monospace;letter-spacing:1px;overflow-wrap:anywhere}'
  + 'blockquote{white-space:pre-wrap;overflow-wrap:anywhere;border-left:4px solid #e8a33d;padding:16px 20px;margin:16px 0;background:#f6f4ed}'
  + 'table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-top:1px solid #d9dfd5;vertical-align:top}a{color:inherit}nav{display:flex;gap:18px;flex-wrap:wrap}';
const page = (title: string, body: string, owner = false): string => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
  + `<meta name="robots" content="noindex"><meta name="referrer" content="same-origin"><title>${esc(title)} · Martin Howard Property</title><style>${STYLE}${owner ? 'header,main{max-width:1000px}' : ''}</style></head>`
  + `<body><header><strong>Martin Howard Property${owner ? ' · Growth HQ' : ''}</strong>${owner ? '<nav><a href="/hq/marketing">Marketing workspace</a><a href="/hq/marketing/phone-test">Phone test</a></nav>' : ''}</header><main>${body}</main></body></html>`;
const hidden = (name: string, value: string): string => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const notice = (text?: string): string => text ? `<p role="status" class="status">${esc(text)}</p>` : '';
const ukTime = (iso: string | null | undefined): string => iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(Date.parse(iso)) + ' (UK time)' : '';

export function mhpEventPhoneRequestPage(input: { notice?: string; email?: string } = {}): string {
  return page('Webinar text reminder', `<span class="small">Optional</span><h1>Get a text reminder for the webinar.</h1>`
    + `<p>Already registered? Enter the email you registered with. We'll send a one-time link so only you can add your mobile. Your email reminders carry on either way.</p>${notice(input.notice)}`
    + `<section><form method="post" action="${MHP_EVENT_PHONE_ROUTE}"><label for="email">The email you registered with<input id="email" name="email" type="email" autocomplete="email" maxlength="254" required value="${esc(input.email ?? '')}"></label>`
    + `<button>Email me a link</button></form></section>`);
}
export function mhpEventPhoneSentPage(): string {
  return page('Check your email', `<h1>Check your email.</h1><p>If that email is registered for the webinar, a link is on its way. It works once and expires in 15 minutes.</p>`
    + `<p class="small">Nothing arrived? Check the address matches the one you registered with, wait a minute and <a href="${MHP_EVENT_PHONE_ROUTE}">try again</a>.</p>`);
}
export function mhpEventPhoneOpenPage(token: string): string {
  // GET never consumes the link (mail scanners follow links); this explicit button does.
  return page('Continue', `<h1>Add a text reminder.</h1><p>Press continue to choose your mobile number.</p><section><form method="post" action="${MHP_EVENT_PHONE_ROUTE}/open">`
    + `${hidden('t', token)}<button>Continue</button></form></section>`);
}
export function mhpEventPhoneChoosePage(input: { status: MhpEventPhoneStatus; csrf: string; join?: { nonce: string; joinExpiresAt: string; sender: string }; notice?: string; sender: string }): string {
  const { status } = input, sms = status.sms;
  const greeting = `<h1>${status.firstName ? `${esc(status.firstName)}, your` : 'Your'} webinar text reminder</h1>`
    + (status.startsAt ? `<p>The webinar starts ${esc(ukTime(status.startsAt))}.</p>` : '');
  const join = input.join;
  if (join) {
    const body = `JOIN ${join.nonce.toUpperCase()}`;
    return page('Text JOIN to confirm', `${greeting}${notice(input.notice)}<section><h2>One last step: text us from that mobile.</h2>`
      + `<p>Send this exact text from the mobile you entered, before ${esc(ukTime(join.joinExpiresAt))}:</p><p class="code">${esc(body)}</p>`
      + `<p>to <strong>${esc(join.sender)}</strong>.</p><p><a href="sms:${esc(join.sender)}?&amp;body=${encodeURIComponent(body)}">Open my messages with this text</a></p>`
      + `<p class="small">Texting us proves the number is yours. We don't text you until you do. Standard network rates apply.</p></section>`);
  }
  if (sms?.state === 'verified' && sms.grantReceiptId) {
    return page('You are on the list', `${greeting}${notice(input.notice)}<section><p>${esc(sms.phoneMasked)} is confirmed. If Martin includes you in the reminder list, we'll text you about this webinar only. Reply STOP to any text to stop.</p>`
      + `<form method="post" action="${MHP_EVENT_PHONE_ROUTE}/withdraw">${hidden('csrf', input.csrf)}${hidden('receiptId', sms.grantReceiptId)}<button>Stop webinar texts</button></form></section>`
      + `<section><p>Changed number? Enter a new one below. Your old number gets no reminder.</p>${form(input.csrf, input.sender)}</section>`);
  }
  if (!status.open) return page('Reminders closed', `${greeting}<p>Text reminders for this webinar are closed. Your email reminders carry on.</p>`);
  const prior = sms?.state === 'withdrawn' ? 'You stopped webinar texts. You can opt in again below.'
    : sms?.state === 'awaiting_join' ? `We're still waiting for your JOIN text from ${sms.phoneMasked}. Lost the code? Enter your number again for a new one.`
    : sms?.state === 'held' ? 'We could not match that number automatically. Martin will check it; you can also try a different mobile.' : '';
  return page('Choose your mobile', `${greeting}${notice(input.notice)}${prior ? `<p class="status">${esc(prior)}</p>` : ''}`
    + `<section>${form(input.csrf, input.sender)}</section>`);
}
function form(csrf: string, sender: string): string {
  return `<form method="post" action="${MHP_EVENT_PHONE_ROUTE}/choose">${hidden('csrf', csrf)}`
    + `<label for="mobile">Your UK mobile<input id="mobile" name="mobile" type="tel" inputmode="tel" autocomplete="tel" maxlength="32" placeholder="07700 900123" required></label>`
    + `<label class="check" for="consent"><input id="consent" type="checkbox" name="consent" value="yes" required>${esc(MHP_EVENT_PHONE_CONSENT_TEXT)}</label>`
    + `<button>Continue</button><p class="small">Next you'll text JOIN from that mobile to ${esc(sender)} so we know it's yours. Martin Howard Property is a trading name of MH196 Ltd. This number is used for this webinar only.</p></form>`;
}
export function mhpEventPhoneMessagePage(title: string, message: string): string {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="${MHP_EVENT_PHONE_ROUTE}">Start again</a></p>`);
}

export function mhpEventPhoneOwnerPage(input: { programmes: MhpEventProgrammeSummary[]; selected: MhpEventProgrammeSummary | null; review: MhpEventReview | null;
  reviewError?: string; csrf: string; commandId: string; campaign: string; notice?: string; result?: Record<string, unknown> }): string {
  const { review, selected } = input;
  const programmes = input.programmes.length === 0 ? '<p>No programme saved yet.</p>' : `<table><tr><th>Programme</th><th>Approval</th><th></th></tr>${input.programmes.map(p =>
    `<tr><td>${esc(p.title)}</td><td>${esc(p.approvalStale ? 'changed since approval' : p.approvalStatus)}</td><td><a href="${MHP_EVENT_PHONE_OWNER_ROUTE}?programme=${esc(p.contentVersionId)}">Open</a></td></tr>`).join('')}</table>`;
  const publish = selected && (selected.approvalStatus !== 'approved' || selected.approvalStale)
    ? `<form method="post" action="${MHP_EVENT_PHONE_OWNER_ROUTE}/publish">${hidden('csrf', input.csrf)}${hidden('commandId', input.commandId)}${hidden('itemId', selected.contentItemId)}${hidden('versionId', selected.contentVersionId)}`
      + `<button>Approve this programme</button><p class="small">Approval schedules nobody. Recipients get their own review below.</p></form>` : '';
  const editor = `<details><summary>Save a programme</summary><form method="post" action="${MHP_EVENT_PHONE_OWNER_ROUTE}/save">${hidden('csrf', input.csrf)}${hidden('commandId', input.commandId)}`
    + `${hidden('previousItemId', selected?.contentItemId ?? '')}${hidden('previousVersionId', selected?.contentVersionId ?? '')}`
    + ['startsAt', 'dueAt', 'providerDeadline', 'admissionUntil'].map(name => `<label for="${name}">${esc(name)} (UTC, e.g. ${esc(input.campaign.slice(8))}T19:30:00Z)<input id="${name}" name="${name}" required pattern="20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00Z"></label>`).join('')
    + ['sourceItemId', 'sourceVersionId', 'sourceSha256'].map(name => `<label for="${name}">Saved MHP text ${esc(name)}<input id="${name}" name="${name}" required></label>`).join('')
    + `<button>Save programme</button></form></details>`;
  let batch = input.reviewError ? `<p class="status">${esc(input.reviewError)}</p>` : '';
  if (review) {
    const p = review.programme;
    batch += `<p>Event <strong>${esc(p.event)}</strong>. Text goes at ${esc(ukTime(p.dueAt))}; Twilio drops it if not sent by ${esc(ukTime(p.providerDeadline))}.</p>`
      + `<blockquote>${esc(review.bodyText)}</blockquote><p class="small">From ${esc(review.senderNumber)}. Caps: ${esc(String(review.budget.dayAvailable))} segments left that day, ${esc(String(review.budget.monthAvailable))} that month.</p>`
      + `<table><tr><th>Recipient</th><th>Mobile</th><th>In this batch</th></tr>${review.recipients.map(r => `<tr><td>${esc(r.firstName ?? 'Registrant')}</td><td>${esc(r.phoneMasked)}</td><td>${r.selected ? 'Yes' : 'Awaiting owner review'}</td></tr>`).join('')}</table>`
      + (review.selectedReceiptIds.length ? `<form method="post" action="${MHP_EVENT_PHONE_OWNER_ROUTE}/activate">${hidden('csrf', input.csrf)}${hidden('commandId', input.commandId)}`
        + `${hidden('programmeVersionId', p.programmeVersionId)}${hidden('programmeSha256', p.programmeSha256)}${hidden('reviewSha256', review.reviewSha256)}`
        + `${hidden('receipts', JSON.stringify(review.selectedRevisions))}`
        + `<label class="check" for="agreed"><input id="agreed" type="checkbox" name="agreed" value="yes" required>I have reviewed this exact text, these ${review.selectedReceiptIds.length} recipients and the send time. Schedule it. (Owner operational review, not legal advice.)</label>`
        + `<button>Schedule ${review.selectedReceiptIds.length} reminder${review.selectedReceiptIds.length === 1 ? '' : 's'}</button></form>` : '<p>No new verified recipients to schedule.</p>')
      + `<p class="small">Held: ${esc(String(review.excluded.held ?? 0))} · waiting for JOIN: ${esc(String(review.excluded.awaitingJoin ?? 0))} · withdrawn: ${esc(String(review.excluded.withdrawn ?? 0))} · not eligible: ${esc(String(review.excluded.notEligible ?? 0))}</p>`
      + `<h2>Scheduled</h2>${review.schedule.length === 0 ? '<p>Nothing scheduled.</p>' : `<table><tr><th>Mobile</th><th>Status</th><th></th></tr>${review.schedule.map(row => {
        const state = row.cancelled ? 'cancelled' : row.held ? `held (${row.held})` : row.jobState ? `${row.jobState}${row.deliveryStatus ? ` / ${row.deliveryStatus}` : ''}` : 'scheduled';
        const control = row.cancelled || (row.jobState && row.jobState !== 'queued') ? '' : `<form method="post" action="${MHP_EVENT_PHONE_OWNER_ROUTE}/control">${hidden('csrf', input.csrf)}${hidden('commandId', input.commandId)}`
          + `${hidden('calendarId', row.calendarId)}${hidden('programmeVersionId', p.programmeVersionId)}<button name="action" value="${row.held ? 'cancel' : 'hold'}">${row.held ? 'Cancel' : 'Hold'}</button></form>`;
        return `<tr><td>${esc(row.phoneMasked)}</td><td>${esc(state)}</td><td>${control}</td></tr>`; }).join('')}</table>`}`;
  }
  return page('Webinar texts', `<h1>Webinar text reminders</h1>${notice(input.notice)}<p>Registrants confirm their email, then text JOIN from their own mobile. Nobody gets a text until you review them here.</p>`
    + `<section><h2>Programme</h2>${programmes}${publish}${editor}</section><section><h2>Review and schedule</h2>${batch || '<p>Open an approved programme to review recipients.</p>'}</section>`, true);
}
