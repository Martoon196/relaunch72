/**
 * Operator API configuration: lets Claude (claude.ai connectors, Claude Desktop,
 * Claude Code) read and, when enabled, change workspace data through MCP, acting
 * as one configured portal user. Names only; never log a value.
 */
import { MHP_MARKETING_WORKSPACE_ID } from '../mhp/marketing-workspace-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const OPERATOR_ENV = Object.freeze({
  token: 'R72_OPERATOR_TOKEN',
  oauthSecret: 'R72_OPERATOR_OAUTH_SECRET',
  userId: 'R72_OPERATOR_USER_ID',
  writes: 'R72_OPERATOR_WRITES',
  ppWorkspace: 'R72_GROUP_HQ_CRM_PP_WORKSPACE_ID',
});

export const OPERATOR_MCP_PATH = '/api/operator/mcp';
export const OPERATOR_OAUTH_PATHS = Object.freeze({
  register: '/api/operator/oauth/register',
  authorize: '/api/operator/oauth/authorize',
  token: '/api/operator/oauth/token',
  protectedResource: '/.well-known/oauth-protected-resource',
  authorizationServer: '/.well-known/oauth-authorization-server',
});

export type OperatorBrand = 'pp' | 'mhp';

export interface OperatorConfig {
  /** Static bearer for Claude Code / Desktop; null = OAuth only. */
  readonly token: string | null;
  /** Signs OAuth client ids, codes, access and refresh tokens; null = static token only. */
  readonly oauthSecret: string | null;
  /** The portal user every operator call acts as (must own the brand workspaces). */
  readonly userId: string;
  readonly writes: boolean;
  readonly workspaces: Readonly<Record<OperatorBrand, string | null>>;
}

/** Undefined when nothing is configured; throws on a partial or malformed configuration. */
export function loadOperatorConfig(env: NodeJS.ProcessEnv): OperatorConfig | undefined {
  const token = env[OPERATOR_ENV.token]?.trim() ?? '';
  const oauthSecret = env[OPERATOR_ENV.oauthSecret]?.trim() ?? '';
  const userId = env[OPERATOR_ENV.userId]?.trim().toLowerCase() ?? '';
  if (!token && !oauthSecret && !userId) return undefined;
  if (!token && !oauthSecret) throw new Error(`${OPERATOR_ENV.token} or ${OPERATOR_ENV.oauthSecret} must be set with ${OPERATOR_ENV.userId}`);
  if (token && (token.length < 32 || token.length > 256)) throw new Error(`${OPERATOR_ENV.token} must be 32–256 characters`);
  if (oauthSecret && (oauthSecret.length < 32 || oauthSecret.length > 256)) throw new Error(`${OPERATOR_ENV.oauthSecret} must be 32–256 characters`);
  if (token && oauthSecret && token === oauthSecret) throw new Error(`${OPERATOR_ENV.token} and ${OPERATOR_ENV.oauthSecret} must differ`);
  if (!UUID.test(userId)) throw new Error(`${OPERATOR_ENV.userId} must be the portal user id the operator acts as`);
  const pp = env[OPERATOR_ENV.ppWorkspace]?.trim().toLowerCase() ?? '';
  return Object.freeze({
    token: token || null,
    oauthSecret: oauthSecret || null,
    userId,
    writes: env[OPERATOR_ENV.writes]?.trim() === 'enabled',
    workspaces: Object.freeze({ pp: UUID.test(pp) ? pp : null, mhp: MHP_MARKETING_WORKSPACE_ID }),
  });
}
