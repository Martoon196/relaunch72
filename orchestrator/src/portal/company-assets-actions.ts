import { createHmac, timingSafeEqual } from 'node:crypto';

export const COMPANY_ASSETS_ROUTE = '/portal/content/assets' as const;
export const COMPANY_ASSET_QUARANTINE_ROUTE = '/portal/content/assets/quarantine' as const;

export type CompanyAssetsNoticeCode =
  | 'quarantined'
  | 'replayed'
  | 'forbidden'
  | 'conflict'
  | 'missing'
  | 'invalid'
  | 'review_unavailable'
  | 'unavailable';

export interface CompanyAssetsNoticeView {
  readonly kind: 'success' | 'info' | 'error';
  readonly title: string;
  readonly message: string;
}

const NOTICE_CODES = new Set<CompanyAssetsNoticeCode>([
  'quarantined', 'replayed', 'forbidden', 'conflict', 'missing',
  'invalid', 'review_unavailable', 'unavailable',
]);
const NOTICE_CONTEXT = 'relaunch72:company-assets-notice:v1\0';

function noticeMac(secret: string, sessionToken: string, code: CompanyAssetsNoticeCode): string {
  return createHmac('sha256', secret)
    .update(NOTICE_CONTEXT).update(sessionToken).update('\0').update(code)
    .digest('base64url');
}

export function companyAssetsNoticeToken(
  secret: string,
  sessionToken: string,
  code: CompanyAssetsNoticeCode,
): string {
  if (!secret || !sessionToken || !NOTICE_CODES.has(code)) return '';
  return `${code}.${noticeMac(secret, sessionToken, code)}`;
}

function noticeFor(code: CompanyAssetsNoticeCode): CompanyAssetsNoticeView {
  if (code === 'quarantined') return {
    kind: 'success',
    title: 'Exact item quarantined',
    message: 'The restrictive decision was pinned to this immutable item and its hashes. Nothing was cleared, approved, generated or sent.',
  };
  if (code === 'replayed') return {
    kind: 'info',
    title: 'Safe replay confirmed',
    message: 'This exact protected quarantine command had already completed, so no duplicate decision was created.',
  };
  if (code === 'forbidden') return {
    kind: 'error',
    title: 'Founder access required',
    message: 'Only a workspace owner or admin can record this restrictive decision. Nothing changed.',
  };
  if (code === 'conflict') return {
    kind: 'error',
    title: 'Exact item conflict protected',
    message: 'The immutable item tuple or command key did not match. Refresh before reviewing again.',
  };
  if (code === 'missing') return {
    kind: 'error',
    title: 'Asset target unavailable',
    message: 'The exact workspace-scoped release item was not found. Nothing changed.',
  };
  if (code === 'review_unavailable') return {
    kind: 'error',
    title: 'Clear and approval remain locked',
    message: 'The exact content or artwork is not available here, so this surface accepts quarantine only.',
  };
  if (code === 'invalid') return {
    kind: 'error',
    title: 'Quarantine action rejected',
    message: 'The protected form, evidence digest or reason code was incomplete or invalid. Nothing changed.',
  };
  return {
    kind: 'error',
    title: 'Company assets unavailable',
    message: 'The command could not complete safely. No provider, schedule, generation or publishing action ran.',
  };
}

export function companyAssetsNoticeFromQuery(
  query: URLSearchParams,
  secret: string,
  sessionToken: string,
): CompanyAssetsNoticeView | undefined {
  const supplied = query.get('notice') ?? '';
  const separator = supplied.indexOf('.');
  if (separator <= 0 || supplied.indexOf('.', separator + 1) !== -1) return undefined;
  const code = supplied.slice(0, separator) as CompanyAssetsNoticeCode;
  const mac = supplied.slice(separator + 1);
  if (!NOTICE_CODES.has(code) || !mac || mac.length > 128) return undefined;
  const expected = noticeMac(secret, sessionToken, code);
  const actualBytes = Buffer.from(mac);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length
      || !timingSafeEqual(actualBytes, expectedBytes)) return undefined;
  return noticeFor(code);
}
