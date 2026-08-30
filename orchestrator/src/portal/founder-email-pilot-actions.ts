/**
 * Route, notice and form contract for the founder email pilot actions.
 *
 * Notices are HMAC-bound to the session exactly like the permission rail, so a
 * forged or replayed code cannot put words in the portal's mouth about an
 * endpoint that was never verified.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** POST target for attaching one verified email endpoint to an existing contact. */
export const CONTACT_ENDPOINT_ATTACH_ROUTE = '/portal/crm/contacts/endpoint' as const;

export const FOUNDER_EMAIL_PILOT_NOTICE_CODES = Object.freeze([
  'endpoint_attached',
  'endpoint_replayed',
  'endpoint_conflict',
  'endpoint_invalid',
  'endpoint_forbidden',
  'endpoint_unavailable',
] as const);

export type FounderEmailPilotNoticeCode =
  typeof FOUNDER_EMAIL_PILOT_NOTICE_CODES[number];

export interface FounderEmailPilotNotice {
  readonly code: FounderEmailPilotNoticeCode;
  readonly tone: 'success' | 'warning' | 'danger';
  readonly title: string;
  readonly message: string;
}

const NOTICES: Readonly<Record<FounderEmailPilotNoticeCode, FounderEmailPilotNotice>> =
  Object.freeze({
    endpoint_attached: Object.freeze({
      code: 'endpoint_attached', tone: 'success',
      title: 'Email endpoint attached and verified',
      message: 'The endpoint is recorded against this existing contact with its '
        + 'verification evidence. No contact or opportunity was created, no '
        + 'permission was recorded and nothing was sent.',
    }),
    endpoint_replayed: Object.freeze({
      code: 'endpoint_replayed', tone: 'success',
      title: 'Endpoint already attached',
      message: 'That command key was already used for this exact endpoint, so the '
        + 'original record stands. Nothing was duplicated.',
    }),
    endpoint_conflict: Object.freeze({
      code: 'endpoint_conflict', tone: 'warning',
      title: 'Command key conflict',
      message: 'That command key was already used for a different endpoint. Reload '
        + 'the case file and try again. Nothing was changed.',
    }),
    endpoint_invalid: Object.freeze({
      code: 'endpoint_invalid', tone: 'danger',
      title: 'Endpoint refused',
      message: 'The address, evidence or confirmation was incomplete, or the '
        + 'endpoint was previously deleted. Nothing was recorded.',
    }),
    endpoint_forbidden: Object.freeze({
      code: 'endpoint_forbidden', tone: 'danger',
      title: 'Not permitted for this account',
      message: 'Attaching a contact endpoint requires an active owner or admin of '
        + 'this workspace. Nothing was recorded.',
    }),
    endpoint_unavailable: Object.freeze({
      code: 'endpoint_unavailable', tone: 'danger',
      title: 'Endpoint workflow unavailable',
      message: 'The endpoint boundary did not answer. Nothing was recorded, '
        + 'queued or sent.',
    }),
  });

const NOTICE_CONTEXT = 'property-predator:founder-email-pilot-notice:v1\0';

function noticeMac(secret: string, sessionToken: string, code: string): string {
  return createHmac('sha256', secret)
    .update(NOTICE_CONTEXT).update(sessionToken).update('\0').update(code)
    .digest('base64url');
}

export function founderEmailPilotNoticeToken(
  secret: string,
  sessionToken: string,
  code: FounderEmailPilotNoticeCode,
): string {
  return `${code}.${noticeMac(secret, sessionToken, code)}`;
}

export function founderEmailPilotNoticeFromQuery(
  params: URLSearchParams,
  secret: string,
  sessionToken: string,
): FounderEmailPilotNotice | null {
  const raw = params.get('notice');
  if (!raw) return null;
  const separator = raw.indexOf('.');
  if (separator <= 0) return null;
  const code = raw.slice(0, separator);
  const supplied = raw.slice(separator + 1);
  if (!(FOUNDER_EMAIL_PILOT_NOTICE_CODES as readonly string[]).includes(code)) return null;
  const expected = noticeMac(secret, sessionToken, code);
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (suppliedBytes.length !== expectedBytes.length) return null;
  if (!timingSafeEqual(suppliedBytes, expectedBytes)) return null;
  return NOTICES[code as FounderEmailPilotNoticeCode];
}

/** The exact fields the attach form may submit. Anything else is refused. */
export const CONTACT_ENDPOINT_FORM_KEYS: readonly string[] = Object.freeze([
  '_csrf',
  'command_key',
  'contact_id',
  'email',
  'label',
  'evidence_source',
  'evidence_reference',
  'verified_at',
  'confirm_endpoint',
]);

export const CONTACT_ENDPOINT_CONFIRM_VALUE = 'VERIFY' as const;
