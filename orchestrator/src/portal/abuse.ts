import { createHash } from 'node:crypto';
import type { PortalSessionIdentity } from './auth-service.js';
import { portalAbuseHash, type PortalRequestContext } from './request-context.js';

export type PortalAbuseRouteClass =
  | 'auth.login'
  | 'auth.setup'
  | 'auth.sso'
  | 'read.overview'
  | 'read.page'
  | 'command';

export type PortalAbuseDimensionName =
  | 'source'
  | 'source_daily'
  | 'auth'
  | 'account'
  | 'account_daily'
  | 'workspace'
  | 'workspace_daily'
  | 'route_account'
  | 'route_workspace';

export interface PortalAbuseDimension {
  readonly name: PortalAbuseDimensionName;
  readonly subjectHash: Buffer;
  readonly capacity: number;
  readonly windowSeconds: number;
  readonly maxConcurrency: number;
}

export interface PortalAbuseAdmission {
  readonly routeClass: PortalAbuseRouteClass;
  readonly dimensions: readonly PortalAbuseDimension[];
  readonly requestHash: Buffer;
  readonly cost: number;
  readonly now: number;
}

export type PortalAbuseDecision =
  | Readonly<{ allowed: true; retryAfterSeconds: 0; leaseHash: Buffer | null }>
  | Readonly<{ allowed: false; retryAfterSeconds: number; leaseHash: null }>;

export type PortalAbuseOutcome = 'success' | 'auth_failure' | 'service_error';

export interface PortalAbuseGuard {
  admit(input: PortalAbuseAdmission): Promise<PortalAbuseDecision>;
  complete(leaseHash: Buffer, outcome: PortalAbuseOutcome): Promise<void>;
  assertReady(): Promise<void>;
  close(): Promise<void>;
}

export function classifyPortalAbuseRoute(pathname: string, method: string): PortalAbuseRouteClass {
  if (pathname === '/portal/login') return 'auth.login';
  if (pathname === '/portal/setup') return 'auth.setup';
  if (pathname === '/portal/auth/property-predator'
      || pathname === '/portal/auth/property-predator/callback') return 'auth.sso';
  if (method !== 'GET' && method !== 'HEAD') return 'command';
  if (pathname === '/portal' || pathname === '/portal/') return 'read.overview';
  return 'read.page';
}

function dimension(
  name: PortalAbuseDimensionName,
  subjectHash: Buffer,
  capacity: number,
  windowSeconds: number,
  maxConcurrency: number,
): PortalAbuseDimension {
  return Object.freeze({ name, subjectHash, capacity, windowSeconds, maxConcurrency });
}

export function sourceAbuseAdmission(
  context: PortalRequestContext,
  routeClass: PortalAbuseRouteClass,
  now: number,
): PortalAbuseAdmission | null {
  if (!context.sourceHash) return null;
  // Per-route source policies have different windows/capacities. Derive their
  // subjects from the already-keyed source so the storage key is stable and
  // non-enumerable without making the global daily source budget route-local.
  const routeSourceHash = createHash('sha256')
    .update('relaunch72/portal-abuse/route-source/v1\u0000')
    .update(routeClass)
    .update(context.sourceHash)
    .digest();
  const policy = routeClass === 'auth.login'
    ? { capacity: 30, windowSeconds: 15 * 60, maxConcurrency: 2 }
    : routeClass === 'auth.setup'
      ? { capacity: 20, windowSeconds: 15 * 60, maxConcurrency: 2 }
      : routeClass === 'auth.sso'
        ? { capacity: 20, windowSeconds: 5 * 60, maxConcurrency: 2 }
        : routeClass === 'command'
          ? { capacity: 60, windowSeconds: 60, maxConcurrency: 2 }
          : { capacity: 120, windowSeconds: 60, maxConcurrency: 4 };
  return Object.freeze({
    routeClass,
    requestHash: context.requestHash,
    cost: 1,
    now,
    dimensions: Object.freeze([
      dimension('source', routeSourceHash, policy.capacity, policy.windowSeconds, policy.maxConcurrency),
      dimension('source_daily', context.sourceHash, 20_000, 24 * 60 * 60, 0),
    ]),
  });
}

export function authSubjectAbuseAdmission(
  context: PortalRequestContext,
  routeClass: Extract<PortalAbuseRouteClass, 'auth.login' | 'auth.setup' | 'auth.sso'>,
  hashSecret: string,
  subject: string,
  now: number,
): PortalAbuseAdmission {
  return Object.freeze({
    routeClass,
    requestHash: context.requestHash,
    cost: 1,
    now,
    dimensions: Object.freeze([
      dimension('auth', portalAbuseHash(hashSecret, `auth/${routeClass}`, subject || 'unknown'), 5, 15 * 60, 1),
    ]),
  });
}

export function principalAbuseAdmission(
  context: PortalRequestContext,
  routeClass: Exclude<PortalAbuseRouteClass, 'auth.login' | 'auth.setup' | 'auth.sso'>,
  hashSecret: string,
  identity: PortalSessionIdentity,
  now: number,
): PortalAbuseAdmission {
  const accountHash = portalAbuseHash(hashSecret, 'account', identity.userId);
  const workspaceHash = portalAbuseHash(hashSecret, 'workspace', identity.workspaceId);
  const routeAccountHash = portalAbuseHash(hashSecret, `route-account/${routeClass}`, identity.userId);
  const routeWorkspaceHash = portalAbuseHash(hashSecret, `route-workspace/${routeClass}`, identity.workspaceId);
  const routePolicy = routeClass === 'read.overview'
    ? { account: 60, workspace: 300, accountConcurrency: 2, workspaceConcurrency: 4 }
    : routeClass === 'read.page'
      ? { account: 20, workspace: 100, accountConcurrency: 2, workspaceConcurrency: 4 }
      : { account: 20, workspace: 100, accountConcurrency: 1, workspaceConcurrency: 3 };
  return Object.freeze({
    routeClass,
    requestHash: context.requestHash,
    cost: 1,
    now,
    dimensions: Object.freeze([
      dimension('account', accountHash, 120, 60, 4),
      dimension('account_daily', accountHash, 10_000, 24 * 60 * 60, 0),
      dimension('workspace', workspaceHash, 600, 60, 12),
      dimension('workspace_daily', workspaceHash, 50_000, 24 * 60 * 60, 0),
      dimension('route_account', routeAccountHash, routePolicy.account, 60, routePolicy.accountConcurrency),
      dimension('route_workspace', routeWorkspaceHash, routePolicy.workspace, 60, routePolicy.workspaceConcurrency),
    ]),
  });
}
