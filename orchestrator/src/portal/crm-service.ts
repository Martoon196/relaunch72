import crypto from 'node:crypto';
import type { CrmNotice, CrmWorkspaceSnapshot, CreateLeadField } from './crm-views.js';

/**
 * Request identity passed to the CRM boundary. The raw cookie is deliberately
 * kept opaque here: a PostgreSQL implementation resolves it to the stored user
 * session before constructing a database request context.
 */
export interface PortalCrmRequestIdentity {
  sessionToken: string;
  requestId: string;
}

export interface PortalCreateLeadInput {
  commandKey: string;
  displayName: string;
  companyName: string;
  email: string;
  phone: string;
  opportunityTitle: string;
  stageId: string;
  taskTitle: string;
  /** Browser `datetime-local` text; the service resolves it in workspace time. */
  taskDueAt: string;
}

export interface PortalMoveOpportunityInput {
  commandKey: string;
  opportunityId: string;
  targetStageId: string;
  expectedRowVersion: string;
}

export interface PortalCompleteTaskInput {
  commandKey: string;
  taskId: string;
  expectedRowVersion: string;
}

export type PortalCrmMutationOutcome =
  | { ok: true; disposition: 'applied' | 'replayed' }
  | {
      ok: false;
      kind: 'validation';
      message: string;
      fieldErrors?: Partial<Record<CreateLeadField, readonly string[]>>;
    }
  | { ok: false; kind: 'conflict' | 'not_found' | 'forbidden' | 'unavailable'; message: string };

/**
 * Router-facing CRM application boundary. Implementations own authentication,
 * authorization, transaction context and command error sanitisation.
 */
export interface PortalCrmService {
  snapshot(identity: PortalCrmRequestIdentity): Promise<CrmWorkspaceSnapshot | null>;
  createLead(identity: PortalCrmRequestIdentity, input: PortalCreateLeadInput): Promise<PortalCrmMutationOutcome>;
  moveOpportunity(identity: PortalCrmRequestIdentity, input: PortalMoveOpportunityInput): Promise<PortalCrmMutationOutcome>;
  completeTask(identity: PortalCrmRequestIdentity, input: PortalCompleteTaskInput): Promise<PortalCrmMutationOutcome>;
}

export type PortalCrmNoticeCode = 'created' | 'moved' | 'completed' | 'replayed' | 'conflict' | 'missing';

const NOTICE_CODES = new Set<PortalCrmNoticeCode>(['created', 'moved', 'completed', 'replayed', 'conflict', 'missing']);
const NOTICE_CONTEXT = 'relaunch72:portal-crm-notice:v1\0';

function noticeMac(secret: string, sessionToken: string, code: PortalCrmNoticeCode): string {
  return crypto.createHmac('sha256', secret)
    .update(NOTICE_CONTEXT)
    .update(sessionToken)
    .update('\0')
    .update(code)
    .digest('base64url');
}

/** Session-bound status token; query strings cannot invent a successful mutation. */
export function crmNoticeToken(secret: string, sessionToken: string, code: PortalCrmNoticeCode): string {
  if (!secret || !sessionToken || !NOTICE_CODES.has(code)) return '';
  return `${code}.${noticeMac(secret, sessionToken, code)}`;
}

export function crmNoticeFromQuery(query: URLSearchParams, secret: string, sessionToken: string): CrmNotice | undefined {
  const supplied = query.get('notice') ?? '';
  const separator = supplied.indexOf('.');
  if (separator <= 0 || supplied.indexOf('.', separator + 1) !== -1) return undefined;
  const code = supplied.slice(0, separator) as PortalCrmNoticeCode;
  const mac = supplied.slice(separator + 1);
  if (!NOTICE_CODES.has(code) || !mac || mac.length > 128) return undefined;
  const expected = noticeMac(secret, sessionToken, code);
  const suppliedBuffer = Buffer.from(mac);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return undefined;
  }

  if (code === 'created') {
    return { kind: 'success', title: 'Lead saved', message: 'The contact, opportunity and optional task were saved in this workspace. No message was sent.' };
  }
  if (code === 'moved') {
    return { kind: 'success', title: 'Stage updated', message: 'The opportunity stage and CRM activity were saved. The contact was not notified.' };
  }
  if (code === 'completed') {
    return { kind: 'success', title: 'Task completed', message: 'The task completion was saved to the CRM timeline. No external action was triggered.' };
  }
  if (code === 'replayed') {
    return { kind: 'info', title: 'Already saved', message: 'This command had already completed, so Relaunch72 returned its saved result without applying it twice.' };
  }
  if (code === 'conflict') {
    return { kind: 'conflict', title: 'Record changed', message: 'Someone changed this record after the page loaded. Review the refreshed values before trying again.' };
  }
  if (code === 'missing') {
    return { kind: 'error', title: 'Record not found', message: 'The requested CRM record is no longer available in this workspace.' };
  }
  return undefined;
}
