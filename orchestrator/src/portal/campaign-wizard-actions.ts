import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * UI-facing command boundary for the TEST campaign wizard.
 *
 * The router owns authentication, CSRF verification, idempotency and command
 * execution. These types let it inject that authority without the presenter or
 * view inventing a writable route or exposing provider credentials.
 */

export const CAMPAIGN_WIZARD_ROUTE = '/portal/campaigns/new' as const;
export const CAMPAIGN_WIZARD_CREATE_TEST_ROUTE = '/portal/campaigns/test-planning-intents' as const;

export interface CampaignWizardCreateAction {
  readonly actionUrl: string;
  readonly csrfToken: string;
  readonly commandKey: string;
  /** GET destination restored after the POST/redirect/GET cycle. */
  readonly returnTo?: string;
}

export type CampaignWizardOutcomeKind = 'success' | 'info' | 'error';

/** Allowlisted command result; raw errors and provider payloads have no shape here. */
export interface CampaignWizardOperationOutcome {
  readonly kind: CampaignWizardOutcomeKind;
  readonly title: string;
  readonly detail: string;
  readonly disposition?: 'applied' | 'replayed';
  readonly intentId?: string;
}

export type CampaignWizardNoticeCode =
  | 'planned'
  | 'replayed'
  | 'cancelled'
  | 'rescheduled'
  | 'forbidden'
  | 'conflict'
  | 'invalid'
  | 'missing'
  | 'unavailable';

const NOTICE_CODES = new Set<CampaignWizardNoticeCode>([
  'planned', 'replayed', 'cancelled', 'rescheduled', 'forbidden',
  'conflict', 'invalid', 'missing', 'unavailable',
]);
const NOTICE_CONTEXT = 'relaunch72:campaign-wizard-notice:v1\0';

function noticeMac(secret: string, sessionToken: string, code: CampaignWizardNoticeCode): string {
  return createHmac('sha256', secret)
    .update(NOTICE_CONTEXT)
    .update(sessionToken)
    .update('\0')
    .update(code)
    .digest('base64url');
}

export function campaignWizardNoticeToken(
  secret: string,
  sessionToken: string,
  code: CampaignWizardNoticeCode,
): string {
  if (!secret || !sessionToken || !NOTICE_CODES.has(code)) return '';
  return `${code}.${noticeMac(secret, sessionToken, code)}`;
}

function noticeFor(code: CampaignWizardNoticeCode): CampaignWizardOperationOutcome {
  if (code === 'planned') return Object.freeze({
    kind: 'success', title: 'Durable TEST campaign planned',
    detail: 'The exact copy, approved media, targets and desired time were recorded. No provider was called.',
    disposition: 'applied',
  });
  if (code === 'replayed') return Object.freeze({
    kind: 'info', title: 'Safe replay confirmed',
    detail: 'This exact protected TEST command had already completed, so no duplicate intent was created.',
    disposition: 'replayed',
  });
  if (code === 'cancelled') return Object.freeze({
    kind: 'success', title: 'TEST target cancelled',
    detail: 'The exact planning target was stopped. No external cancellation or provider call ran.',
    disposition: 'applied',
  });
  if (code === 'rescheduled') return Object.freeze({
    kind: 'success', title: 'New TEST time saved',
    detail: 'A new immutable planning intent superseded the prior desired time. Provider effects remain none.',
    disposition: 'applied',
  });
  if (code === 'forbidden') return Object.freeze({
    kind: 'error', title: 'Campaign access required',
    detail: 'Your current workspace role cannot run that protected TEST command. Nothing changed.',
  });
  if (code === 'conflict') return Object.freeze({
    kind: 'error', title: 'Campaign state changed safely',
    detail: 'The immutable intent, target or command key no longer matched. Refresh before trying again.',
  });
  if (code === 'invalid') return Object.freeze({
    kind: 'error', title: 'Campaign command rejected',
    detail: 'The protected form was incomplete or invalid. Nothing was planned, changed or sent.',
  });
  if (code === 'missing') return Object.freeze({
    kind: 'error', title: 'Campaign target unavailable',
    detail: 'The exact workspace-owned content, campaign, intent or TEST target was not found. Nothing changed.',
  });
  return Object.freeze({
    kind: 'error', title: 'Campaign command unavailable',
    detail: 'The command could not complete safely. No provider, publication or external schedule ran.',
  });
}

/** Verify a session-bound PRG token before showing any mutation outcome. */
export function campaignWizardNoticeFromQuery(
  query: URLSearchParams,
  secret: string,
  sessionToken: string,
): CampaignWizardOperationOutcome | undefined {
  const supplied = query.get('notice') ?? '';
  const separator = supplied.indexOf('.');
  if (separator <= 0 || supplied.indexOf('.', separator + 1) !== -1) return undefined;
  const code = supplied.slice(0, separator) as CampaignWizardNoticeCode;
  const mac = supplied.slice(separator + 1);
  if (!NOTICE_CODES.has(code) || !mac || mac.length > 128) return undefined;
  const expected = noticeMac(secret, sessionToken, code);
  const actualBytes = Buffer.from(mac);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length
      || !timingSafeEqual(actualBytes, expectedBytes)) return undefined;
  return noticeFor(code);
}

const PORTAL_PATH = /^\/portal(?:\/|$)[^\u0000-\u001f\u007f]*$/u;
const COMMAND_KEY = /^[\x21-\x7e]{8,200}$/u;

/** Prevent a forged render option from turning a protected form into exfiltration. */
export function isSafeCampaignWizardPortalPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500 || !PORTAL_PATH.test(value)) return false;
  if (value.startsWith('//') || value.includes('\\')) return false;
  try {
    const parsed = new URL(value, 'https://growth-hq.invalid');
    return parsed.origin === 'https://growth-hq.invalid' && parsed.pathname.startsWith('/portal/');
  } catch {
    return false;
  }
}

export function isCampaignWizardCreateActionReady(
  action: CampaignWizardCreateAction | undefined,
): action is CampaignWizardCreateAction {
  return Boolean(action
    && isSafeCampaignWizardPortalPath(action.actionUrl)
    && typeof action.csrfToken === 'string'
    && action.csrfToken.length >= 16
    && action.csrfToken.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(action.csrfToken)
    && COMMAND_KEY.test(action.commandKey)
    && (action.returnTo === undefined || isSafeCampaignWizardPortalPath(action.returnTo)));
}
