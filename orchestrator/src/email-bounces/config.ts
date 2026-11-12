/**
 * Which Postmark servers and message streams belong to which workspace.
 *
 * A source is one Postmark server used by one workspace. Brands are added by
 * configuration only: a built-in default supplied by the brand's own module
 * (MHP today), or an entry in EMAIL_BOUNCE_SOURCES for the next brand, e.g.
 *
 *   [{"key":"pp","workspaceId":"<uuid>","tokenEnv":"PP_POSTMARK_SERVER_TOKEN",
 *     "webhookSecretEnv":"PP_POSTMARK_WEBHOOK_SECRET",
 *     "marketingStreams":["broadcast"],"serviceStreams":["outbound"]}]
 *
 * Secrets are only ever named here; their values come from the named variables.
 */

import type { EmailStreamKind } from './registry.js';

export const EMAIL_BOUNCE_SOURCES_ENV = 'EMAIL_BOUNCE_SOURCES';
export const EMAIL_BOUNCE_HANDLING_ENV = 'EMAIL_BOUNCE_HANDLING';

/**
 * The switch someone reaches for in a hurry: any usual spelling of "off" disables the whole feature
 * (no webhook, no reads, nothing refused). Anything else, including unset, leaves it on.
 */
export function emailBounceHandlingDisabled(env: NodeJS.ProcessEnv): boolean {
  return ['off', 'false', '0', 'no', 'disabled'].includes(env[EMAIL_BOUNCE_HANDLING_ENV]?.trim().toLowerCase() ?? '');
}

export interface EmailBounceSource {
  /** Path segment of this source's webhook address. */
  readonly key: string;
  readonly workspaceId: string;
  /** Server token for the catch-up sweep; null means webhook-only. */
  readonly token: string | null;
  /** Shared secret Postmark sends with every webhook; null means the webhook stays closed. */
  readonly webhookSecret: string | null;
  /** Optional Postmark ServerID pin: events from any other server are refused. */
  readonly serverId: string | null;
  readonly streams: ReadonlyMap<string, EmailStreamKind>;
}
export interface EmailBounceSourceDefault {
  readonly key: string; readonly workspaceId: string; readonly tokenEnv: string; readonly webhookSecretEnv: string;
  readonly marketingStreams: readonly string[]; readonly serviceStreams: readonly string[];
}
export interface EmailBounceConfig { readonly sources: readonly EmailBounceSource[]; readonly blockers: readonly string[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const STREAM = /^[a-z0-9-]{1,60}$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,80}$/u;
const SECRET = /^[\x21-\x7e]{24,200}$/u;

const value = (env: NodeJS.ProcessEnv, name: string): string | null => env[name]?.trim() || null;
const streamList = (input: unknown): string[] | null =>
  Array.isArray(input) && input.length <= 10 && input.every(item => typeof item === 'string' && STREAM.test(item)) ? input as string[] : null;

export function loadEmailBounceConfig(env: NodeJS.ProcessEnv, options: {
  defaults?: readonly EmailBounceSourceDefault[];
  /** Webinar senders already configured per workspace; their stream is an event/service stream. */
  webinarSenders?: Iterable<{ readonly workspaceId: string; readonly token: string; readonly messageStream: string }>;
} = {}): EmailBounceConfig {
  const blockers: string[] = [];
  const entries: (EmailBounceSourceDefault & { serverId: string | null })[] = [];
  const raw = value(env, EMAIL_BOUNCE_SOURCES_ENV);
  if (raw) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(raw); } catch { blockers.push(`${EMAIL_BOUNCE_SOURCES_ENV} is not valid JSON.`); }
    if (parsed !== null && !Array.isArray(parsed)) blockers.push(`${EMAIL_BOUNCE_SOURCES_ENV} must be a JSON array.`);
    for (const [index, item] of (Array.isArray(parsed) ? parsed.slice(0, 20) : []).entries()) {
      const source = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
      const marketingStreams = source.marketingStreams === undefined ? [] : streamList(source.marketingStreams);
      const serviceStreams = source.serviceStreams === undefined ? [] : streamList(source.serviceStreams);
      const serverId = source.serverId === undefined ? null : typeof source.serverId === 'string' && /^[0-9]{1,20}$/u.test(source.serverId) ? source.serverId : undefined;
      if (typeof source.key !== 'string' || !KEY.test(source.key) || typeof source.workspaceId !== 'string' || !UUID.test(source.workspaceId)
          || typeof source.tokenEnv !== 'string' || !ENV_NAME.test(source.tokenEnv)
          || typeof source.webhookSecretEnv !== 'string' || !ENV_NAME.test(source.webhookSecretEnv)
          || !marketingStreams || !serviceStreams || marketingStreams.length + serviceStreams.length < 1 || serverId === undefined) {
        blockers.push(`${EMAIL_BOUNCE_SOURCES_ENV}[${index}] needs key, workspaceId, tokenEnv, webhookSecretEnv and at least one stream.`);
        continue;
      }
      entries.push({ key: source.key, workspaceId: source.workspaceId, tokenEnv: source.tokenEnv, webhookSecretEnv: source.webhookSecretEnv,
        marketingStreams, serviceStreams, serverId });
    }
  }
  for (const fallback of options.defaults ?? []) {
    // A brand's built-in source applies only while its token exists and nothing configured replaces it.
    if (!entries.some(entry => entry.key === fallback.key) && value(env, fallback.tokenEnv)) entries.push({ ...fallback, serverId: null });
  }
  const sources: { key: string; workspaceId: string; token: string | null; webhookSecret: string | null; serverId: string | null; streams: Map<string, EmailStreamKind> }[] = [];
  for (const entry of entries) {
    if (sources.some(source => source.key === entry.key)) { blockers.push(`Email bounce source ${entry.key} is listed twice.`); continue; }
    const token = value(env, entry.tokenEnv), secret = value(env, entry.webhookSecretEnv);
    if (!token) blockers.push(`${entry.tokenEnv} is not set, so past bounces for ${entry.key} cannot be read.`);
    if (!secret) blockers.push(`${entry.webhookSecretEnv} is not set, so the ${entry.key} bounce webhook stays closed.`);
    else if (!SECRET.test(secret)) blockers.push(`${entry.webhookSecretEnv} must be 24 to 200 characters with no spaces; the ${entry.key} bounce webhook stays closed.`);
    const streams = new Map<string, EmailStreamKind>();
    for (const stream of entry.serviceStreams) streams.set(stream, 'service');
    for (const stream of entry.marketingStreams) streams.set(stream, 'marketing');
    sources.push({ key: entry.key, workspaceId: entry.workspaceId.toLowerCase(), token, webhookSecret: secret && SECRET.test(secret) ? secret : null,
      serverId: entry.serverId, streams });
  }
  for (const sender of options.webinarSenders ?? []) {
    const workspaceId = sender.workspaceId.toLowerCase();
    if (!STREAM.test(sender.messageStream)) continue;
    const same = sources.find(source => source.workspaceId === workspaceId && source.token === sender.token);
    if (same) { if (!same.streams.has(sender.messageStream)) same.streams.set(sender.messageStream, 'service'); continue; }
    // A webinar sender on its own Postmark server is still swept; it needs an EMAIL_BOUNCE_SOURCES entry to receive webhooks.
    const key = `webinar-${workspaceId.slice(0, 8)}`;
    if (sources.some(source => source.key === key)) continue;
    sources.push({ key, workspaceId, token: sender.token, webhookSecret: null, serverId: null, streams: new Map([[sender.messageStream, 'service']]) });
    blockers.push(`Webinar email for workspace ${workspaceId} uses its own Postmark server; add it to ${EMAIL_BOUNCE_SOURCES_ENV} to receive its bounce webhooks.`);
  }
  return Object.freeze({ sources: Object.freeze(sources.map(source => Object.freeze({ ...source, streams: new Map(source.streams) as ReadonlyMap<string, EmailStreamKind> }))),
    blockers: Object.freeze(blockers) });
}
