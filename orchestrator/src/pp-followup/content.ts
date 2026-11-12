import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFlowMessage } from '../followup-sequences/channel-drafts.js';

export const PP_FOLLOWUP_UNSUBSCRIBE_ROUTE = '/email/follow-up/unsubscribe';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const escape = (value: string): string => value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** One link per CRM email contact point, signed with the portal session secret; it can only ever suppress Property Predator marketing email. */
export function ppUnsubscribeToken(secret: string, contactPointId: string): string {
  if (!secret || !UUID.test(contactPointId)) throw new Error('Invalid PP unsubscribe subject');
  return createHmac('sha256', secret).update('relaunch72/pp-followup-unsubscribe/v1\u0000').update(contactPointId).digest('base64url');
}
export function verifyPpUnsubscribeToken(secret: string, contactPointId: string, token: string): boolean {
  if (!secret || !UUID.test(contactPointId) || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  const expected = Buffer.from(ppUnsubscribeToken(secret, contactPointId)), actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function ppUnsubscribeUrl(origin: string, secret: string, contactPointId: string): string {
  const base = new URL(origin);
  if (base.protocol !== 'https:') throw new Error('PP unsubscribe links need an https origin');
  return `${base.origin}${PP_FOLLOWUP_UNSUBSCRIBE_ROUTE}?p=${encodeURIComponent(contactPointId)}&t=${ppUnsubscribeToken(secret, contactPointId)}`;
}

export interface PpFollowupRendered { readonly subject: string; readonly text: string; readonly html: string; readonly unsubscribe: string }

/** Renders the exact approved PP email bytes. Placeholder values are inserted once and never re-scanned. */
export function renderPpFollowupEmail(input: { canonicalContent: string; contentSha256: string; displayName: string | null;
  label: string; link: string; unsubscribe: string; productName: string; unsubscribeOrigin: string }): PpFollowupRendered {
  if (createHash('sha256').update(input.canonicalContent, 'utf8').digest('hex') !== input.contentSha256) throw new Error('PP follow-up content digest mismatch');
  const unsubscribe = new URL(input.unsubscribe), expectedOrigin = new URL(input.unsubscribeOrigin).origin;
  if (unsubscribe.origin !== expectedOrigin || unsubscribe.pathname !== PP_FOLLOWUP_UNSUBSCRIBE_ROUTE || unsubscribe.username || unsubscribe.password) throw new Error('PP unsubscribe link is invalid');
  const draft = readFlowMessage('email', input.canonicalContent);
  if (!('subject' in draft)) throw new Error('PP follow-up step is not an email');
  let link: string;
  try { const url = new URL(input.link); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe'); link = url.href; }
  catch { throw new Error('PP follow-up link is invalid'); }
  const values: Record<string, string> = { FIRSTNAME: (input.displayName ?? '').trim().split(/\s+/u)[0]?.slice(0, 60) || 'there',
    LABEL: input.label.slice(0, 200), LINK: link, UNSUBSCRIBE: input.unsubscribe };
  const fill = (value: string) => value.replace(/\{\{(FIRSTNAME|LABEL|LINK|UNSUBSCRIBE)\}\}/gu, (_match, name: string) => values[name]!.replace(/[\r\n]+/gu, ' '));
  const subject = fill(draft.subject).replace(/[\r\n]+/gu, ' ');
  const body = fill(draft.bodyText), footer = `Unsubscribe: ${input.unsubscribe}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(subject)}</title></head><body style="margin:0;background:#f4f3ef;color:#172b30;font:16px/1.7 Arial,sans-serif"><main style="max-width:640px;margin:auto;padding:32px;background:#fff"><h1 style="font-size:20px;color:#123b48">${escape(input.productName)}</h1><div style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(body)}</div><p style="margin-top:32px;font-size:12px"><a href="${escape(input.unsubscribe)}">Unsubscribe</a> from these emails.</p></main></body></html>`;
  return Object.freeze({ subject, text: `${body}\n\n${footer}`, html, unsubscribe: input.unsubscribe });
}
