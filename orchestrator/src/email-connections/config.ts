/**
 * Whether "Connect email" is switched on.
 *
 * On only when ALL of these hold; otherwise it is off, the page says so plainly and start-up carries on:
 *   EMAIL_CONNECT           exactly "enabled"
 *   POSTMARK_ACCOUNT_TOKEN  the Postmark account token (a UUID, from Postmark's "API Tokens" tab of the account)
 *   EMAIL_CONNECTION_KEY    32 random bytes, base64 (seals the saved server token and webhook secret)
 *   PORTAL_BASE_URL         an https origin (the bounce webhook address Postmark posts to is built from it)
 * Problems name settings only, never a value.
 *
 * WHICH businesses may connect is decided in eligibility.ts (the allow-list seam), not here.
 */
import { EMAIL_CONNECTION_KEY_ENV, EmailConnectionVault } from './vault.js';

export const EMAIL_CONNECT_ENV = 'EMAIL_CONNECT';
export const POSTMARK_ACCOUNT_TOKEN_ENV = 'POSTMARK_ACCOUNT_TOKEN';

export interface EmailConnectBusiness {
  readonly workspaceId: string;
  readonly name: string;
  /** Path segment of this connection's bounce webhook, and its Basic user name. */
  readonly sourceKey: string;
  /**
   * An env-configured bounce source this stored connection replaces when both exist. None in this release: PP's
   * env-configured source ('pp') keeps answering and being swept, because PP's sends still use the env server.
   */
  readonly replacesSourceKey: string | null;
}

/** The Postmark bounce source key of a stored connection: "conn-" and all 32 hex digits of the workspace id (37 characters). */
export const connectionSourceKey = (workspaceId: string): string => `conn-${workspaceId.toLowerCase().replace(/-/gu, '')}`;

export type EmailConnectConfig =
  | { readonly enabled: true; readonly accountToken: string; readonly vault: EmailConnectionVault; readonly webhookOrigin: string; readonly problems: readonly [] }
  | { readonly enabled: false; readonly vault: EmailConnectionVault | null; readonly problems: readonly string[] };

const UUID_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The https origin of the portal (no path), or null. */
export function emailConnectWebhookOrigin(portalBaseUrl: string | undefined): string | null {
  try {
    const url = new URL(portalBaseUrl ?? '');
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

export function loadEmailConnectConfig(env: NodeJS.ProcessEnv, options: { portalBaseUrl?: string | undefined; bounceHandling?: boolean } = {}): EmailConnectConfig {
  const problems: string[] = [];
  // Without bounce handling a connection could not hear about bounces, so connecting is not offered either.
  if (options.bounceHandling === false) problems.push('EMAIL_BOUNCE_HANDLING is off, so Connect email stays off.');
  const vault = (() => { try { return EmailConnectionVault.fromEnv(env); } catch { return null; } })();
  if (env[EMAIL_CONNECT_ENV] !== 'enabled') problems.push(`${EMAIL_CONNECT_ENV} is not set to enabled.`);
  const token = env[POSTMARK_ACCOUNT_TOKEN_ENV]?.trim() ?? '';
  if (!token) problems.push(`${POSTMARK_ACCOUNT_TOKEN_ENV} is not set.`);
  else if (!UUID_TOKEN.test(token)) problems.push(`${POSTMARK_ACCOUNT_TOKEN_ENV} is not a Postmark account token.`);
  if (!env[EMAIL_CONNECTION_KEY_ENV]?.trim()) problems.push(`${EMAIL_CONNECTION_KEY_ENV} is not set.`);
  else if (!vault) problems.push(`${EMAIL_CONNECTION_KEY_ENV} must be 32 random bytes, base64.`);
  const webhookOrigin = emailConnectWebhookOrigin(options.portalBaseUrl);
  if (!webhookOrigin) problems.push('PORTAL_BASE_URL must be the https address of this portal.');
  if (problems.length || !vault || !webhookOrigin) return Object.freeze({ enabled: false, vault, problems: Object.freeze(problems) });
  // The token is attached non-enumerable, so logging or serialising the config never shows it.
  const config = { enabled: true, vault, webhookOrigin, problems: Object.freeze([]) as readonly [] } as { enabled: true; accountToken: string; vault: EmailConnectionVault; webhookOrigin: string; problems: readonly [] };
  Object.defineProperty(config, 'accountToken', { value: token, enumerable: false });
  return Object.freeze(config);
}
