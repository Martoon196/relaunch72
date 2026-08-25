import '../config.js';

export const DATABASE_ROLES = [
  'migrator',
  'web',
  'identityCommand',
  'provisioningCommand',
  'setupDeliveryCommand',
  'setupReissueCommand',
  'crmCommand',
  'importCommand',
  'externalEventCommand',
  'worker',
  'webhook',
  'public',
  'readonly',
] as const;

export type DatabaseRole = (typeof DATABASE_ROLES)[number];
export type DatabaseSslMode = 'disable' | 'require' | 'verify-full';

const ROLE_URL_ENV: Record<DatabaseRole, string> = {
  migrator: 'DATABASE_MIGRATOR_URL',
  web: 'DATABASE_WEB_URL',
  identityCommand: 'DATABASE_IDENTITY_COMMAND_URL',
  provisioningCommand: 'DATABASE_PROVISIONING_COMMAND_URL',
  setupDeliveryCommand: 'DATABASE_SETUP_DELIVERY_COMMAND_URL',
  setupReissueCommand: 'DATABASE_SETUP_REISSUE_COMMAND_URL',
  crmCommand: 'DATABASE_CRM_COMMAND_URL',
  importCommand: 'DATABASE_IMPORT_COMMAND_URL',
  externalEventCommand: 'DATABASE_EXTERNAL_EVENT_COMMAND_URL',
  worker: 'DATABASE_WORKER_URL',
  webhook: 'DATABASE_WEBHOOK_URL',
  public: 'DATABASE_PUBLIC_URL',
  readonly: 'DATABASE_READONLY_URL',
};

const EXPECTED_RUNTIME_USER: Partial<Record<DatabaseRole, string>> = {
  web: 'r72_web',
  identityCommand: 'r72_identity_command',
  provisioningCommand: 'r72_provisioning_command',
  setupDeliveryCommand: 'r72_setup_delivery_command',
  setupReissueCommand: 'r72_setup_reissue_command',
  crmCommand: 'r72_crm_command',
  importCommand: 'r72_import_command',
  externalEventCommand: 'r72_external_event_command',
  worker: 'r72_worker',
  webhook: 'r72_webhook',
  public: 'r72_public',
  readonly: 'r72_readonly',
};

export interface DatabaseConfig {
  role: DatabaseRole;
  /** Secret. Never include this value in logs or error messages. */
  connectionString: string;
  sourceEnv: string;
  production: boolean;
  sslMode: DatabaseSslMode;
  sslCa?: string;
  /** Ask node-postgres to use SCRAM-SHA-256-PLUS when the server offers it. */
  enableChannelBinding: boolean;
  maxConnections: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
  applicationName: string;
  /** Verified by the pool before a newly connected client can be checked out. */
  expectedDatabaseUser?: string;
}

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function defaultSslMode(url: URL, production: boolean): DatabaseSslMode {
  const isLoopback = /^(?:localhost|127(?:\.\d{1,3}){3}|::1)$/i.test(url.hostname);
  return production || !isLoopback ? 'verify-full' : 'disable';
}

function parseSslMode(raw: string | undefined, fallback: DatabaseSslMode): DatabaseSslMode {
  const value = raw?.trim().toLowerCase() || fallback;
  if (value !== 'disable' && value !== 'require' && value !== 'verify-full') {
    throw new Error('DATABASE_SSL_MODE must be disable, require, or verify-full');
  }
  return value;
}

/**
 * Load one least-privilege database identity. Production never falls back to the
 * generic DATABASE_URL: every process must receive the URL for its exact role.
 */
export function loadDatabaseConfig(
  role: DatabaseRole,
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const production = env.NODE_ENV?.trim().toLowerCase() === 'production';
  const roleEnv = ROLE_URL_ENV[role];
  const roleUrl = env[roleEnv]?.trim();
  const developmentUrl = production ? undefined : env.DATABASE_URL?.trim();
  const rawUrl = roleUrl || developmentUrl;
  const sourceEnv = roleUrl ? roleEnv : 'DATABASE_URL';

  if (!rawUrl) {
    const suffix = production
      ? `; production does not accept the generic DATABASE_URL fallback`
      : ` (or DATABASE_URL for local development)`;
    throw new Error(`${roleEnv} is required${suffix}`);
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${sourceEnv} must be a valid PostgreSQL URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${sourceEnv} must use the postgres or postgresql protocol`);
  }
  if (!url.hostname || !url.username || url.pathname === '/' || !url.pathname) {
    throw new Error(`${sourceEnv} must include a host, database, and database user`);
  }
  if (role === 'migrator' && /-pooler\./i.test(url.hostname)) {
    throw new Error(`${sourceEnv} must use a direct, non-pooled connection for migrations`);
  }
  const expectedDatabaseUser = EXPECTED_RUNTIME_USER[role];
  const enforceRuntimeIdentity = Boolean(expectedDatabaseUser) && (production || Boolean(roleUrl));
  if (enforceRuntimeIdentity && decodeURIComponent(url.username) !== expectedDatabaseUser) {
    throw new Error(`${roleEnv} must authenticate as the least-privilege ${expectedDatabaseUser} role`);
  }

  // pg's connection-string parser can silently override a separately supplied
  // TLS object. Resolve sslmode here, then remove it so pool.ts is authoritative.
  const urlSslMode = url.searchParams.get('sslmode') ?? undefined;
  const allowedConnectionOptions = new Set(['sslmode', 'sslnegotiation', 'channel_binding']);
  for (const key of url.searchParams.keys()) {
    if (!allowedConnectionOptions.has(key)) {
      throw new Error(`${sourceEnv} contains unsupported connection option: ${key}`);
    }
  }
  const sslMode = parseSslMode(
    env.DATABASE_SSL_MODE ?? urlSslMode,
    defaultSslMode(url, production),
  );
  const channelBinding = url.searchParams.get('channel_binding');
  if (channelBinding !== null && channelBinding !== 'require') {
    throw new Error(`${sourceEnv} channel_binding must be require when specified`);
  }
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  if (production && sslMode === 'disable') {
    throw new Error('DATABASE_SSL_MODE=disable is forbidden in production');
  }
  if (url.searchParams.get('sslnegotiation') === 'direct' && sslMode === 'disable') {
    throw new Error(`${sourceEnv} cannot use direct TLS negotiation when TLS is disabled`);
  }
  if (channelBinding === 'require' && sslMode === 'disable') {
    throw new Error(`${sourceEnv} cannot require channel binding when TLS is disabled`);
  }

  const rolePoolKey = role === 'crmCommand'
    ? 'DATABASE_CRM_COMMAND_POOL_MAX'
    : role === 'importCommand'
      ? 'DATABASE_IMPORT_COMMAND_POOL_MAX'
      : role === 'externalEventCommand'
        ? 'DATABASE_EXTERNAL_EVENT_COMMAND_POOL_MAX'
        : role === 'setupDeliveryCommand'
          ? 'DATABASE_SETUP_DELIVERY_COMMAND_POOL_MAX'
          : role === 'setupReissueCommand'
            ? 'DATABASE_SETUP_REISSUE_COMMAND_POOL_MAX'
            : role === 'provisioningCommand'
              ? 'DATABASE_PROVISIONING_COMMAND_POOL_MAX'
              : role === 'identityCommand'
                ? 'DATABASE_IDENTITY_COMMAND_POOL_MAX'
                : `DATABASE_${role.toUpperCase()}_POOL_MAX`;
  return {
    role,
    connectionString: url.toString(),
    sourceEnv,
    production,
    sslMode,
    sslCa: env.DATABASE_SSL_CA?.replace(/\\n/g, '\n').trim() || undefined,
    enableChannelBinding: channelBinding === 'require',
    maxConnections: parseBoundedInteger(
      env[rolePoolKey] ?? env.DATABASE_POOL_MAX,
      role === 'worker' ? 10 : 5,
      1,
      100,
      rolePoolKey,
    ),
    connectionTimeoutMs: parseBoundedInteger(
      env.DATABASE_CONNECTION_TIMEOUT_MS,
      5_000,
      250,
      120_000,
      'DATABASE_CONNECTION_TIMEOUT_MS',
    ),
    idleTimeoutMs: parseBoundedInteger(
      env.DATABASE_IDLE_TIMEOUT_MS,
      30_000,
      1_000,
      600_000,
      'DATABASE_IDLE_TIMEOUT_MS',
    ),
    statementTimeoutMs: parseBoundedInteger(
      env.DATABASE_STATEMENT_TIMEOUT_MS,
      role === 'migrator' ? 120_000 : 15_000,
      500,
      600_000,
      'DATABASE_STATEMENT_TIMEOUT_MS',
    ),
    applicationName: role === 'crmCommand'
      ? 'relaunch72-crm-command'
      : role === 'importCommand'
        ? 'relaunch72-import-command'
        : role === 'externalEventCommand'
          ? 'relaunch72-external-event-command'
          : role === 'setupDeliveryCommand'
            ? 'relaunch72-setup-delivery-command'
            : role === 'setupReissueCommand'
              ? 'relaunch72-setup-reissue-command'
              : role === 'provisioningCommand'
                ? 'relaunch72-provisioning-command'
                : role === 'identityCommand'
                  ? 'relaunch72-identity-command'
                  : `relaunch72-${role}`,
    expectedDatabaseUser: enforceRuntimeIdentity ? expectedDatabaseUser : undefined,
  };
}
