import { escapeHtml as e } from '../portal/ui.js';
import { MHP_OWNER_NAV, MHP_OWNER_STYLES } from './owner-frame.js';
import type { MhpEmailRecipient, MhpEmailSchedulePlan, MhpEmailUnsentPlan } from './owner-email-service.js';

/** Confirmation pages for the owner email screen: nothing is scheduled, replaced or cancelled until the owner confirms here. */
const BASE = '/hq/marketing/emails';
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${e(value)}">`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const time = (value: string) => new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const emailHref = (itemId: string, versionId: string, extra = '') => `${BASE}?item=${encodeURIComponent(itemId)}&version=${encodeURIComponent(versionId)}${extra}`;
const STYLES = `${MHP_OWNER_STYLES}label{display:block;font-weight:700;margin:20px 0}.check{display:flex;gap:12px;align-items:flex-start}.check input{margin-top:6px;width:22px;height:22px;flex:none}.list{border:1px solid #d9ded4;border-radius:12px;padding:0;margin:12px 0;list-style:none}.list li{padding:10px 14px;border-top:1px solid #eceee8;overflow-wrap:anywhere}.list li:first-child{border-top:0}.confirm-box{border:2px solid #e8a33d;border-radius:12px;padding:16px;margin:20px 0;background:#fffaf0}.toplinks{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:0 0 16px}.toplinks a{display:inline-flex;align-items:center;min-height:44px}`;
function frame(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${e(title)} · MHP Growth HQ</title><style>${STYLES}</style></head><body>${MHP_OWNER_NAV}<main>${body}</main></body></html>`;
}
const people = (list: readonly MhpEmailRecipient[]) => `${list.length > 30 ? `<p class="note">Showing all ${list.length}.</p>` : ''}<ul class="list" aria-label="People who will receive it">${list.map(person => `<li><strong>${e(person.firstName?.trim() || '(no first name)')}</strong> · <span class="wrap">${e(person.email)}</span></li>`).join('')}</ul>`;

export interface MhpEmailScheduleConfirmInput { csrf: string; commandId: string; plan: MhpEmailSchedulePlan; token: Readonly<Record<string, string>>; now: number;
  changed?: { previousCount: number; reason?: string }; problem?: string }
export function mhpEmailScheduleConfirmPage(input: MhpEmailScheduleConfirmInput): string {
  const { plan } = input, back = emailHref(plan.itemId, plan.versionId);
  const when = Date.parse(plan.dueAt) <= input.now + 60_000 ? 'straight away' : `${time(plan.dueAt)} (UK time)`;
  const held = [plan.heldBack.noConsent ? `${plural(plan.heldBack.noConsent, 'person')} did not agree to emails` : '', plan.heldBack.unsubscribed ? `${plural(plan.heldBack.unsubscribed, 'person', 'people')} unsubscribed` : ''].filter(Boolean);
  const changed = input.changed ? `<section class="card notice" role="alert"><h2>The list changed, so nothing was scheduled</h2><p>${e(input.changed.reason ?? `When you looked, this was ${plural(input.changed.previousCount, 'person', 'people')}. It is now ${plural(plan.count, 'person', 'people')}.`)}</p><p>Check the list below again before confirming.</p></section>` : '';
  const problem = input.problem ? `<section class="card notice" role="alert"><p><strong>${e(input.problem)}</strong></p></section>` : '';
  if (!plan.ready) return frame('Schedule this email', `<div class="toplinks"><a href="${e(back)}">← Back to the email</a></div>${changed}${problem}<section class="card"><div class="eyebrow">Schedule · ${e(plan.title)}</div>
    <h1>This email cannot be scheduled from here</h1><p><strong>${e(plan.refusal ?? 'It cannot be scheduled right now.')}</strong></p><p>Nobody was emailed.</p><div class="actions"><a class="button" href="${e(back)}">Back to the email</a></div></section>`);
  const fields = hidden('csrf', input.csrf) + hidden('commandId', input.commandId) + hidden('itemId', plan.itemId) + hidden('versionId', plan.versionId)
    + Object.entries(input.token).map(([key, value]) => hidden(key, value)).join('');
  return frame('Schedule this email', `<div class="toplinks"><a href="${e(back)}">← Back without scheduling</a></div>${changed}${problem}<section class="card"><div class="eyebrow">Schedule · ${e(plan.title)}</div>
    <h1>You are about to email ${plural(plan.count, 'person', 'people')}</h1>
    <p><strong>Who:</strong> people who registered for ${e(plan.webinar.label ? `“${plan.webinar.label}”` : 'the current webinar')} and agreed to emails.</p>
    <p><strong>Email:</strong> “${e(plan.subject)}”, sent <strong>${e(when)}</strong>. If it cannot go by ${e(time(plan.expiresAt))} (UK time), it is not sent.</p>
    ${plan.mode === 'test' ? '<p class="notice">Email is in test mode: only your test addresses actually receive anything.</p>' : ''}
    <h2>The ${plural(plan.count, 'person', 'people')}</h2>${people(plan.recipients)}
    <h2>Held back</h2>${held.length ? `<ul>${held.map(line => `<li>${e(line)}</li>`).join('')}</ul><p class="note">These people are not emailed.</p>` : '<p>Nobody is held back.</p>'}
    <form method="post" action="${BASE}/schedule">${fields}<div class="confirm-box"><label class="check" for="schedule-confirm"><input id="schedule-confirm" type="checkbox" name="confirm" value="yes" required> Yes, send to these ${plural(plan.count, 'person', 'people')}</label></div>
      <div class="actions"><button>Schedule for ${plural(plan.count, 'person', 'people')}</button><a class="button secondary" href="${e(back)}">Cancel</a></div></form></section>`);
}
export function mhpEmailUnsentConfirmPage(input: { csrf: string; commandId: string; action: 'replace' | 'cancel'; plan: MhpEmailUnsentPlan; dueAt: string; expiresAt: string; token: Readonly<Record<string, string>>; changed?: boolean }): string {
  const { plan } = input, back = emailHref(plan.itemId, plan.versionId), replace = input.action === 'replace';
  const fields = hidden('csrf', input.csrf) + hidden('commandId', input.commandId) + hidden('itemId', plan.itemId) + hidden('versionId', plan.versionId)
    + (replace ? hidden('dueAt', input.dueAt.slice(0, 16)) + hidden('expiresAt', input.expiresAt.slice(0, 16)) : '') + Object.entries(input.token).map(([key, value]) => hidden(key, value)).join('');
  const changed = input.changed ? '<section class="card notice" role="alert"><p><strong>The unsent emails changed while you were looking, so nothing was changed.</strong> Check the numbers below again.</p></section>' : '';
  const heading = !plan.ready ? (replace ? 'Nothing to replace' : 'Nothing to cancel')
    : replace ? `Change ${plural(plan.unsent, 'unsent email')} to this version and time?` : `Cancel ${plural(plan.unsent, 'unsent email')}?`;
  const text = !plan.ready ? plan.refusal ?? ''
    : replace ? `Up to ${plural(plan.unsent, 'person', 'people')} who already have this email scheduled and not yet sent will get “${plan.subject}” at ${time(input.dueAt)} (UK time) instead. Nobody new is added; anyone who has since unsubscribed is left out.`
      : `They will not be sent. Nobody is added or emailed.${plan.inFlight ? ` ${plural(plan.inFlight, 'email is', 'emails are')} already being sent and cannot be called back.` : ''}`;
  return frame(replace ? 'Replace unsent emails' : 'Cancel unsent emails', `<div class="toplinks"><a href="${e(back)}">← Back to the email</a></div>${changed}<section class="card"><div class="eyebrow">${replace ? 'Replace' : 'Cancel'} · ${e(plan.title)}</div>
    <h1>${e(heading)}</h1><p>${e(text)}</p>
    ${plan.ready ? `<form method="post" action="${BASE}/${input.action}">${fields}${replace ? `<div class="confirm-box"><label class="check" for="replace-confirm"><input id="replace-confirm" type="checkbox" name="confirm" value="yes" required> Yes, change these ${plural(plan.unsent, 'unsent email')}</label></div>` : ''}
      <div class="actions"><button>${replace ? `Change ${plural(plan.unsent, 'email')}` : `Cancel ${plural(plan.unsent, 'email')}`}</button><a class="button secondary" href="${e(back)}">${replace ? 'Cancel' : 'Keep them'}</a></div></form>`
      : `<div class="actions"><a class="button" href="${e(back)}">Back to the email</a></div>`}</section>`);
}
