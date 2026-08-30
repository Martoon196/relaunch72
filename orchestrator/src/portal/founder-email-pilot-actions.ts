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

/** POST target for the founder's final capped enqueue authorisation. */
export const EMAIL_PILOT_AUTHORISE_ROUTE = '/portal/crm/contacts/email-pilot' as const;

export const FOUNDER_EMAIL_PILOT_NOTICE_CODES = Object.freeze([
  'endpoint_attached',
  'endpoint_replayed',
  'endpoint_conflict',
  'endpoint_invalid',
  'endpoint_forbidden',
  'endpoint_unavailable',
  'pilot_queued',
  'pilot_replayed',
  'pilot_conflict',
  'pilot_blocked',
  'pilot_stale_preview',
  'pilot_invalid',
  'pilot_forbidden',
  'pilot_unavailable',
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
    pilot_queued: Object.freeze({
      code: 'pilot_queued', tone: 'success',
      title: 'Authorised and queued',
      message: 'The approved message is queued against the capped live rail. '
        + 'Mailgun was not called here: the existing worker owns dispatch, and '
        + 'the receipt will appear in the Conversion Inbox.',
    }),
    pilot_replayed: Object.freeze({
      code: 'pilot_replayed', tone: 'success',
      title: 'Already authorised',
      message: 'That command key already queued this exact message, so the '
        + 'original job stands. Nothing was queued twice and nothing was sent.',
    }),
    pilot_conflict: Object.freeze({
      code: 'pilot_conflict', tone: 'warning',
      title: 'Evidence changed under this command key',
      message: 'The approved evidence no longer matches what this command key '
        + 'first authorised. Nothing was queued. Reload the case file to see '
        + 'the current message and authorise that instead.',
    }),
    pilot_blocked: Object.freeze({
      code: 'pilot_blocked', tone: 'warning',
      title: 'Not every piece of evidence is present',
      message: 'The exact tuple the capped enqueue requires did not resolve. The '
        + 'blockers listed on this page name what is missing. Nothing was queued.',
    }),
    pilot_stale_preview: Object.freeze({
      code: 'pilot_stale_preview', tone: 'warning',
      title: 'That preview no longer matches',
      message: 'The message, approvals or permission changed after the preview '
        + 'was shown, or the authorisation window closed. Nothing was queued. '
        + 'Reload and read the current message before authorising.',
    }),
    pilot_invalid: Object.freeze({
      code: 'pilot_invalid', tone: 'danger',
      title: 'Authorisation refused',
      message: 'The confirmation, command key or preview was incomplete or '
        + 'malformed. Nothing was queued and no provider was called.',
    }),
    pilot_forbidden: Object.freeze({
      code: 'pilot_forbidden', tone: 'danger',
      title: 'Not permitted for this account',
      message: 'Authorising a live customer email requires an active owner or '
        + 'admin of this workspace. Nothing was queued.',
    }),
    pilot_unavailable: Object.freeze({
      code: 'pilot_unavailable', tone: 'danger',
      title: 'Authorisation boundary unavailable',
      message: 'The enqueue boundary did not answer. Nothing was queued and '
        + 'Mailgun was not called.',
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

/** The exact fields the authorisation form may submit. Anything else is refused. */
export const EMAIL_PILOT_AUTHORISE_FORM_KEYS: readonly string[] = Object.freeze([
  '_csrf',
  'command_key',
  'contact_id',
  'contact_point_id',
  'purpose',
  'preview_token',
  'confirm_send',
]);

/** Deliberately not the endpoint word: this one authorises a live send. */
export const EMAIL_PILOT_CONFIRM_VALUE = 'SEND LIVE EMAIL' as const;

/**
 * How long a preview stays authorisable.
 *
 * The enqueue refuses an authority more than fifteen minutes out, and a
 * permission-use receipt expires within five minutes of being evaluated. Five
 * minutes is the window both accept.
 */
export const EMAIL_PILOT_PREVIEW_TTL_MS = 5 * 60 * 1000;

const PREVIEW_CONTEXT = 'property-predator:founder-email-pilot-preview:v1\0';

export interface FounderEmailPilotPreviewClaims {
  readonly commandKey: string;
  /** Canonical ISO instant the authority expires, folded into the enqueue digest. */
  readonly authorityValidUntil: string;
  /** Digest of the exact evidence, recipient, subject and body that were shown. */
  readonly evidenceDigest: string;
}

function previewMac(secret: string, sessionToken: string, payload: string): string {
  return createHmac('sha256', secret)
    .update(PREVIEW_CONTEXT).update(sessionToken).update('\0').update(payload)
    .digest('base64url');
}

/**
 * Mint a session-bound preview token.
 *
 * It is not a bearer capability: it authorises nothing on its own. It states
 * which command key, which authority window and which exact evidence a founder
 * was shown, so the POST can prove it is acting on the message that was read
 * rather than whatever the database happens to say a minute later. Binding the
 * MAC to the session token makes it useless in anyone else's hands, and binding
 * it to one command key makes a second submission a replay of the same job
 * rather than a second send.
 */
export function founderEmailPilotPreviewToken(
  secret: string,
  sessionToken: string,
  claims: FounderEmailPilotPreviewClaims,
): string {
  const payload = Buffer.from(
    [claims.commandKey, claims.authorityValidUntil, claims.evidenceDigest].join('\0'),
    'utf8',
  ).toString('base64url');
  return `${payload}.${previewMac(secret, sessionToken, payload)}`;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const TOKEN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Verify a preview token against this session, returning its claims or null.
 *
 * A forged MAC, another session's token, a malformed payload or an expired
 * authority all return null. The caller still has to match the claims against
 * freshly resolved evidence: this proves only that the portal minted it.
 */
export function founderEmailPilotPreviewClaims(
  token: string,
  secret: string,
  sessionToken: string,
  now: number,
): FounderEmailPilotPreviewClaims | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const supplied = Buffer.from(token.slice(separator + 1), 'utf8');
  const expected = Buffer.from(previewMac(secret, sessionToken, payload), 'utf8');
  if (supplied.length !== expected.length) return null;
  if (!timingSafeEqual(supplied, expected)) return null;
  const parts = Buffer.from(payload, 'base64url').toString('utf8').split('\0');
  if (parts.length !== 3) return null;
  const [commandKey, authorityValidUntil, evidenceDigest] = parts as [string, string, string];
  if (!TOKEN_UUID.test(commandKey) || !SHA256.test(evidenceDigest)) return null;
  const expiry = Date.parse(authorityValidUntil);
  if (!Number.isFinite(expiry)
      || new Date(expiry).toISOString() !== authorityValidUntil) {
    return null;
  }
  // Expired, or minted with a window this build would never issue.
  if (expiry <= now || expiry > now + EMAIL_PILOT_PREVIEW_TTL_MS) return null;
  return Object.freeze({ commandKey, authorityValidUntil, evidenceDigest });
}
