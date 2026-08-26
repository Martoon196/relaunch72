import { createHmac, timingSafeEqual } from 'node:crypto';

export type OperatorActionNoticeCode =
  | 'snoozed'
  | 'unsnoozed'
  | 'assigned'
  | 'released'
  | 'replayed'
  | 'forbidden'
  | 'conflict'
  | 'missing'
  | 'invalid'
  | 'unavailable';

export interface OperatorActionNoticeView {
  readonly kind: 'success' | 'info' | 'error';
  readonly title: string;
  readonly message: string;
}

const NOTICE_CODES = new Set<OperatorActionNoticeCode>([
  'snoozed', 'unsnoozed', 'assigned', 'released', 'replayed',
  'forbidden', 'conflict', 'missing', 'invalid', 'unavailable',
]);
const NOTICE_CONTEXT = 'relaunch72:operator-action-notice:v1\0';
const SNOOZE_CHOICE_CONTEXT = 'relaunch72:operator-action-snooze-choice:v1\0';
const ACTION_KEY = /^[a-z][a-z0-9._:-]{2,159}$/u;
const COMMAND_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function exactInstant(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function sameMac(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function noticeMac(secret: string, sessionToken: string, code: OperatorActionNoticeCode): string {
  return createHmac('sha256', secret)
    .update(NOTICE_CONTEXT)
    .update(sessionToken)
    .update('\0')
    .update(code)
    .digest('base64url');
}

export function operatorActionNoticeToken(
  secret: string,
  sessionToken: string,
  code: OperatorActionNoticeCode,
): string {
  if (!secret || !sessionToken || !NOTICE_CODES.has(code)) return '';
  return `${code}.${noticeMac(secret, sessionToken, code)}`;
}

function snoozeChoiceMac(
  secret: string,
  sessionToken: string,
  actionId: string,
  commandKey: string,
  snoozedUntil: string,
): string {
  return createHmac('sha256', secret)
    .update(SNOOZE_CHOICE_CONTEXT)
    .update(sessionToken)
    .update('\0')
    .update(actionId)
    .update('\0')
    .update(commandKey)
    .update('\0')
    .update(snoozedUntil)
    .digest('base64url');
}

/** Create one opaque, session/action/command-bound absolute snooze choice. */
export function operatorActionSnoozeChoiceToken(
  secret: string,
  sessionToken: string,
  actionId: string,
  commandKey: string,
  snoozedUntil: string,
): string {
  if (!secret || !sessionToken || !ACTION_KEY.test(actionId)
      || !COMMAND_KEY.test(commandKey) || !exactInstant(snoozedUntil)) return '';
  const instant = Buffer.from(snoozedUntil, 'utf8').toString('base64url');
  return `${instant}.${snoozeChoiceMac(
    secret, sessionToken, actionId, commandKey, snoozedUntil,
  )}`;
}

/** Verify one rendered choice and recover the exact instant unchanged for safe retries. */
export function operatorActionSnoozeInstantFromToken(
  token: string,
  secret: string,
  sessionToken: string,
  actionId: string,
  commandKey: string,
): string | null {
  if (!secret || !sessionToken || !ACTION_KEY.test(actionId)
      || !COMMAND_KEY.test(commandKey) || token.length > 256) return null;
  const separator = token.indexOf('.');
  if (separator <= 0 || token.indexOf('.', separator + 1) !== -1) return null;
  const encodedInstant = token.slice(0, separator);
  const suppliedMac = token.slice(separator + 1);
  let snoozedUntil: string;
  try {
    snoozedUntil = Buffer.from(encodedInstant, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (Buffer.from(snoozedUntil, 'utf8').toString('base64url') !== encodedInstant
      || !exactInstant(snoozedUntil)) return null;
  const expected = snoozeChoiceMac(
    secret, sessionToken, actionId, commandKey, snoozedUntil,
  );
  return sameMac(suppliedMac, expected) ? snoozedUntil : null;
}

function noticeFor(code: OperatorActionNoticeCode): OperatorActionNoticeView {
  if (code === 'snoozed') return {
    kind: 'success', title: 'Action snoozed',
    message: 'The action is out of the active queue until the selected time. Its source record was not changed.',
  };
  if (code === 'unsnoozed') return {
    kind: 'success', title: 'Action returned',
    message: 'The action is eligible for the active queue again. Its source record was not changed.',
  };
  if (code === 'assigned') return {
    kind: 'success', title: 'Owner saved',
    message: 'The operator assignment was recorded with audit history. The originating record remains authoritative.',
  };
  if (code === 'released') return {
    kind: 'info', title: 'Action released',
    message: 'The operator assignment was cleared. No task, journey, approval or provider operation was completed.',
  };
  if (code === 'replayed') return {
    kind: 'info', title: 'Safe replay confirmed',
    message: 'This exact protected command had already completed, so no duplicate control event was created.',
  };
  if (code === 'forbidden') return {
    kind: 'error', title: 'Action access required',
    message: 'Your current workspace role cannot make that queue change. Nothing was altered.',
  };
  if (code === 'conflict') return {
    kind: 'error', title: 'Queue conflict protected',
    message: 'The action changed after this page loaded. Refresh and review its current owner and state.',
  };
  if (code === 'missing') return {
    kind: 'error', title: 'Action no longer active',
    message: 'The server-derived action is no longer in this workspace queue. No orphan control was created.',
  };
  if (code === 'invalid') return {
    kind: 'error', title: 'Action rejected safely',
    message: 'The protected request was incomplete or invalid. Refresh before trying again.',
  };
  return {
    kind: 'error', title: 'Action Centre unavailable',
    message: 'The queue change could not complete safely. No source record, message, post or provider was changed.',
  };
}

export function operatorActionNoticeFromQuery(
  query: URLSearchParams,
  secret: string,
  sessionToken: string,
): OperatorActionNoticeView | undefined {
  const supplied = query.get('notice') ?? '';
  const separator = supplied.indexOf('.');
  if (separator <= 0 || supplied.indexOf('.', separator + 1) !== -1) return undefined;
  const code = supplied.slice(0, separator) as OperatorActionNoticeCode;
  const mac = supplied.slice(separator + 1);
  if (!NOTICE_CODES.has(code) || !mac || mac.length > 128) return undefined;
  const expected = noticeMac(secret, sessionToken, code);
  if (!sameMac(mac, expected)) return undefined;
  return noticeFor(code);
}
