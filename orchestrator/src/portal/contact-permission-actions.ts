/**
 * Route, notice and form contract for the founder contact permission workflow.
 *
 * Notices are HMAC-bound to the session exactly like the other founder rails,
 * so a forged or replayed notice code cannot put words in the portal's mouth
 * about a legal permission record.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** POST target for one permission decision on one exact endpoint. */
export const CONTACT_PERMISSION_ROUTE = '/portal/crm/contacts/permission' as const;

/** Return address for the case file this workflow always comes back to. */
export function contactCaseFileRoute(contactId: string): string {
  return `/portal/crm/contacts/${contactId}`;
}

export const CONTACT_PERMISSION_NOTICE_CODES = Object.freeze([
  'permission_recorded',
  'permission_replayed',
  'permission_conflict',
  'permission_invalid',
  'permission_forbidden',
  'permission_unavailable',
] as const);

export type ContactPermissionNoticeCode = typeof CONTACT_PERMISSION_NOTICE_CODES[number];

export interface ContactPermissionNotice {
  readonly code: ContactPermissionNoticeCode;
  readonly tone: 'success' | 'warning' | 'danger';
  readonly title: string;
  readonly message: string;
}

const NOTICES: Readonly<Record<ContactPermissionNoticeCode, ContactPermissionNotice>> =
  Object.freeze({
    permission_recorded: Object.freeze({
      code: 'permission_recorded', tone: 'success',
      title: 'Permission decision recorded',
      message: 'The decision is appended to this contact’s permission history. '
        + 'No message was queued or sent, and any existing suppression is unchanged.',
    }),
    permission_replayed: Object.freeze({
      code: 'permission_replayed', tone: 'success',
      title: 'Decision already recorded',
      message: 'That command key was already used for this exact decision, so the '
        + 'original record stands. Nothing was duplicated.',
    }),
    permission_conflict: Object.freeze({
      code: 'permission_conflict', tone: 'warning',
      title: 'Command key conflict',
      message: 'That command key was already used for a different decision. Reload '
        + 'the case file and record the decision again. Nothing was changed.',
    }),
    permission_invalid: Object.freeze({
      code: 'permission_invalid', tone: 'danger',
      title: 'Permission decision refused',
      message: 'The decision, endpoint, purpose, evidence or confirmation was '
        + 'incomplete. Nothing was recorded.',
    }),
    permission_forbidden: Object.freeze({
      code: 'permission_forbidden', tone: 'danger',
      title: 'Not permitted for this account',
      message: 'Recording contact permission requires an active owner or admin of '
        + 'this workspace. Nothing was recorded.',
    }),
    permission_unavailable: Object.freeze({
      code: 'permission_unavailable', tone: 'danger',
      title: 'Permission workflow unavailable',
      message: 'The permission boundary did not answer. Nothing was recorded, '
        + 'queued or sent.',
    }),
  });

const NOTICE_CONTEXT = 'property-predator:contact-permission-notice:v1\0';

function noticeMac(secret: string, sessionToken: string, code: string): string {
  return createHmac('sha256', secret)
    .update(NOTICE_CONTEXT).update(sessionToken).update('\0').update(code)
    .digest('base64url');
}

/** `${code}.${mac}`, bound to this session so another session's token is useless. */
export function contactPermissionNoticeToken(
  secret: string,
  sessionToken: string,
  code: ContactPermissionNoticeCode,
): string {
  return `${code}.${noticeMac(secret, sessionToken, code)}`;
}

export function contactPermissionNoticeFromQuery(
  params: URLSearchParams,
  secret: string,
  sessionToken: string,
): ContactPermissionNotice | null {
  const raw = params.get('notice');
  if (!raw) return null;
  const separator = raw.indexOf('.');
  if (separator <= 0) return null;
  const code = raw.slice(0, separator);
  const supplied = raw.slice(separator + 1);
  if (!(CONTACT_PERMISSION_NOTICE_CODES as readonly string[]).includes(code)) return null;
  const expected = noticeMac(secret, sessionToken, code);
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (suppliedBytes.length !== expectedBytes.length) return null;
  if (!timingSafeEqual(suppliedBytes, expectedBytes)) return null;
  return NOTICES[code as ContactPermissionNoticeCode];
}

/** The exact fields the permission form may submit. Anything else is refused. */
export const CONTACT_PERMISSION_FORM_KEYS: readonly string[] = Object.freeze([
  '_csrf',
  'command_key',
  'contact_id',
  'contact_point_id',
  'channel',
  'purpose',
  'decision',
  'lawful_basis',
  'evidence_source',
  'policy_version',
  'policy_text_sha256',
  'source_event_id',
  'occurred_at',
  'confirm_permission',
]);

export const CONTACT_PERMISSION_CONFIRM_VALUE = 'RECORD' as const;
