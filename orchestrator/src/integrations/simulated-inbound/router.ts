import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  InboxCommandInProgressError,
  InboxIdempotencyConflictError,
  InboxNotFoundError,
  InboxValidationError,
  type RecordTestInboundCommand,
} from '../../inbox-pg/types.js';
import {
  SOCIAL_DM_DARK_PROVIDER_ID,
  SocialDmDarkContractError,
} from '../../social-dm-dark/contracts.js';
import {
  toSocialDmOwnInboxCommand,
  verifySocialDmDarkInbound,
  type SocialDmOwnInboxBinding,
  type VerifiedSocialDmDarkInbound,
} from '../../social-dm-dark/webhook.js';
import {
  WHATSAPP_DARK_PROVIDER_ID,
} from '../../whatsapp-dark/contracts.js';
import {
  toOwnInboxTestInbound,
  verifySimulatedWhatsAppWebhook,
  type OwnInboxWhatsAppBinding,
  type SimulatedWhatsAppInboundEvent,
} from '../../whatsapp-dark/webhook.js';

export const PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOUND_PATH =
  '/api/test-provider-webhooks/whatsapp/inbound' as const;
export const PROPERTY_PREDATOR_SIMULATED_META_DM_INBOUND_PATH =
  '/api/test-provider-webhooks/meta-dm/inbound' as const;
export const SIMULATED_INBOUND_SIGNATURE_HEADER =
  'x-property-predator-test-signature' as const;
export const SIMULATED_INBOUND_MAX_BODY_BYTES = 64 * 1024;
export const SIMULATED_INBOUND_MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

type SimulatedInboundProviderId =
  | typeof WHATSAPP_DARK_PROVIDER_ID
  | typeof SOCIAL_DM_DARK_PROVIDER_ID;

export type SimulatedInboundSafeOutcome =
  | 'accepted'
  | 'replayed'
  | 'authentication_failed'
  | 'event_rejected'
  | 'event_conflict'
  | 'temporarily_unavailable';

export interface VerifiedSimulatedInboundIdentity {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly externalEventId: string;
  readonly externalMessageId: string;
  readonly occurredAt: string;
  readonly sourceTestAddress: string;
  readonly destinationTestAddress: string;
}

export interface AuthenticatedSimulatedInboundCommand {
  readonly schemaVersion: 1;
  readonly environment: 'test';
  readonly providerId: SimulatedInboundProviderId;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly externalEventId: string;
  readonly externalMessageId: string;
  readonly occurredAt: string;
  /** Digests are derived from the single exact authenticated HTTP snapshot. */
  readonly payloadSha256: Uint8Array;
  readonly eventIdentitySha256: Uint8Array;
  readonly signatureSha256: Uint8Array;
  readonly sourceIdentitySha256: Uint8Array;
  readonly destinationIdentitySha256: Uint8Array;
  readonly command: RecordTestInboundCommand;
}

/**
 * Injected durable boundary. Implementations must atomically fence
 * (workspaceId, connectionId, providerId, externalEventId) to payloadSha256
 * before applying the inbox command, returning replayed only for the exact
 * same authenticated bytes. This module deliberately owns no database or
 * in-memory replay cache.
 */
export interface DurableSimulatedInboundCommandService {
  recordAuthenticatedTestInbound(
    input: AuthenticatedSimulatedInboundCommand,
  ): Promise<Readonly<{ disposition: 'applied' | 'replayed' }>>;
}

export class SimulatedInboundEventConflictError extends Error {
  constructor() {
    super('Authenticated simulated inbound event conflicts with its durable receipt');
    this.name = 'SimulatedInboundEventConflictError';
  }
}

export class SimulatedInboundCommandInProgressError extends Error {
  constructor() {
    super('Authenticated simulated inbound event is already being recorded');
    this.name = 'SimulatedInboundCommandInProgressError';
  }
}

export class SimulatedInboundBindingUnavailableError extends Error {
  constructor() {
    super('Authenticated simulated inbound binding is unavailable');
    this.name = 'SimulatedInboundBindingUnavailableError';
  }
}

export interface SimulatedInboundEnvelopeAdapter<TEvent, TBinding> {
  readonly providerId: SimulatedInboundProviderId;
  verify(input: Readonly<{
    rawBody: Uint8Array;
    signature: string;
    contentType: string;
    testSecret: string;
  }>): TEvent;
  identity(event: TEvent): VerifiedSimulatedInboundIdentity;
  toCommand(event: TEvent, binding: TBinding): RecordTestInboundCommand;
}

export type FacebookInstagramDmOwnInboxBinding = Omit<SocialDmOwnInboxBinding, 'network'> &
  Readonly<{ network: 'facebook' | 'instagram' }>;

export interface FacebookInstagramDmOwnInboxBindings {
  readonly facebook: Omit<SocialDmOwnInboxBinding, 'network'> &
    Readonly<{ network: 'facebook' }>;
  readonly instagram: Omit<SocialDmOwnInboxBinding, 'network'> &
    Readonly<{ network: 'instagram' }>;
}

export interface SimulatedInboundWebhookHandlerOptions<TEvent, TBinding> {
  readonly path: `/api/test-provider-webhooks/${string}`;
  readonly testSecret: string;
  readonly binding?: TBinding;
  /** Selects one trusted binding after authentication (used by the FB/IG seam). */
  readonly resolveBinding?: (event: TEvent) => TBinding;
  readonly adapter: SimulatedInboundEnvelopeAdapter<TEvent, TBinding>;
  readonly commandService?: DurableSimulatedInboundCommandService;
  /** Selects a separately bound durable service after authentication. */
  readonly resolveCommandService?: (event: TEvent) => DurableSimulatedInboundCommandService;
  readonly now?: () => Date;
  /** Fixed-vocabulary observation hook. It never receives payloads, IDs or errors. */
  readonly onSafeOutcome?: (outcome: SimulatedInboundSafeOutcome) => void;
}

export interface PropertyPredatorSimulatedWhatsAppInboundMount {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly blockers: readonly string[];
  readonly handle?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

export type PropertyPredatorSimulatedMetaDmInboundMount =
  PropertyPredatorSimulatedWhatsAppInboundMount;

class SimulatedInboundRequestBodyTooLargeError extends Error {}
class SimulatedInboundRequestBodyUnavailableError extends Error {}
class SimulatedInboundFreshnessError extends Error {}

function exactTestSecret(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32
      || Buffer.byteLength(value, 'utf8') > 256 || /[^\x21-\x7e]/u.test(value)) {
    throw new Error('Simulated inbound test secret is invalid');
  }
  return value;
}

function exactSingleHeader(req: IncomingMessage, name: string): string | undefined {
  if (Array.isArray(req.rawHeaders) && req.rawHeaders.length > 0) {
    const matches: string[] = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index]?.toLowerCase() === name) {
        const value = req.rawHeaders[index + 1];
        if (value !== undefined) matches.push(value);
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function hasExactJsonContentType(req: IncomingMessage): boolean {
  const raw = exactSingleHeader(req, 'content-type');
  if (!raw) return false;
  const segments = raw.split(';').map((segment) => segment.trim().toLowerCase());
  return segments[0] === 'application/json'
    && segments.slice(1).every((segment) => segment === 'charset=utf-8');
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
  retryAfter = false,
): void {
  const encoded = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(encoded)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(retryAfter ? { 'retry-after': '30' } : {}),
  });
  res.end(encoded);
}

function readBoundedRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declaredValue = exactSingleHeader(req, 'content-length');
    const declared = declaredValue === undefined ? undefined : Number(declaredValue);
    if (declared !== undefined && (!Number.isSafeInteger(declared)
        || declared < 0 || declared > SIMULATED_INBOUND_MAX_BODY_BYTES)) {
      req.resume();
      reject(new SimulatedInboundRequestBodyTooLargeError());
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (value: Buffer | string): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > SIMULATED_INBOUND_MAX_BODY_BYTES) {
        fail(new SimulatedInboundRequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      if (declared !== undefined && declared !== total) {
        fail(new SimulatedInboundRequestBodyUnavailableError());
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onError = (): void => fail(new SimulatedInboundRequestBodyUnavailableError());
    const onAborted = (): void => fail(new SimulatedInboundRequestBodyUnavailableError());
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function assertFresh(occurredAt: string, now: Date): void {
  const eventTime = Date.parse(occurredAt);
  const nowTime = now.getTime();
  if (!Number.isFinite(eventTime) || !Number.isFinite(nowTime)
      || Math.abs(nowTime - eventTime) > SIMULATED_INBOUND_MAX_CLOCK_SKEW_MS) {
    throw new SimulatedInboundFreshnessError();
  }
}

function sha256Bytes(value: string | Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(value).digest());
}

function authenticatedIdentitySha256(
  providerId: SimulatedInboundProviderId,
  identity: VerifiedSimulatedInboundIdentity,
): Uint8Array {
  // Canonical v1 identity tuple: provider + tenant + connection + both provider IDs.
  // JSON array order is fixed and all values were produced by the HMAC verifier.
  return sha256Bytes(JSON.stringify([
    1,
    providerId,
    identity.workspaceId,
    identity.connectionId,
    identity.externalEventId,
    identity.externalMessageId,
  ]));
}

function safeOutcome(
  observer: ((outcome: SimulatedInboundSafeOutcome) => void) | undefined,
  outcome: SimulatedInboundSafeOutcome,
): void {
  try {
    observer?.(outcome);
  } catch {
    // Observability is value-only and cannot change an authenticated receipt.
  }
}

function isContractError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'WhatsAppDarkContractError'
    || error.name === 'SocialDmDarkContractError'
  );
}

export const SIMULATED_WHATSAPP_INBOUND_ENVELOPE_ADAPTER:
SimulatedInboundEnvelopeAdapter<SimulatedWhatsAppInboundEvent, OwnInboxWhatsAppBinding> =
  Object.freeze({
    providerId: WHATSAPP_DARK_PROVIDER_ID,
    verify: verifySimulatedWhatsAppWebhook,
    identity: (event: SimulatedWhatsAppInboundEvent) => Object.freeze({
      workspaceId: event.workspaceId,
      connectionId: event.connectionId,
      externalEventId: event.eventId,
      externalMessageId: event.event.messageId,
      occurredAt: event.occurredAt,
      sourceTestAddress: event.event.from,
      destinationTestAddress: event.event.to,
    }),
    toCommand: toOwnInboxTestInbound,
  });

/** Reusable authenticated envelope seam for the two Meta DM networks only. */
export const SIMULATED_FACEBOOK_INSTAGRAM_DM_ENVELOPE_ADAPTER:
SimulatedInboundEnvelopeAdapter<VerifiedSocialDmDarkInbound, FacebookInstagramDmOwnInboxBinding> =
  Object.freeze({
    providerId: SOCIAL_DM_DARK_PROVIDER_ID,
    verify: verifySocialDmDarkInbound,
    identity: (event: VerifiedSocialDmDarkInbound) => {
      if (event.event.network !== 'facebook' && event.event.network !== 'instagram') {
        throw new SocialDmDarkContractError('simulated DM inbound is not a Meta network');
      }
      return Object.freeze({
        workspaceId: event.workspaceId,
        connectionId: event.connectionId,
        externalEventId: event.eventId,
        externalMessageId: event.event.messageRef,
        occurredAt: event.occurredAt,
        sourceTestAddress: event.event.from,
        destinationTestAddress: event.event.to,
      });
    },
    toCommand: (
      event: VerifiedSocialDmDarkInbound,
      binding: FacebookInstagramDmOwnInboxBinding,
    ) => {
      if (event.event.network !== 'facebook' && event.event.network !== 'instagram') {
        throw new SocialDmDarkContractError('simulated DM inbound is not a Meta network');
      }
      return toSocialDmOwnInboxCommand(event, binding);
    },
  });

/**
 * Generic signed TEST ingress. Only adapters declared above are accepted by its
 * public types. The server exposes optional dark mounts, while production
 * composition remains deliberately absent.
 */
export function createSimulatedInboundWebhookHandler<TEvent, TBinding>(
  options: SimulatedInboundWebhookHandlerOptions<TEvent, TBinding>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const path = options.path;
  if (!path.startsWith('/api/test-provider-webhooks/') || path.includes('?') || path.includes('#')) {
    throw new Error('Simulated inbound webhook path is invalid');
  }
  const testSecret = exactTestSecret(options.testSecret);
  const now = options.now ?? (() => new Date());
  const adapter = options.adapter;
  if ((options.binding === undefined) === (options.resolveBinding === undefined)) {
    throw new Error('Simulated inbound webhook requires exactly one trusted binding source');
  }
  if ((options.commandService === undefined) === (options.resolveCommandService === undefined)) {
    throw new Error('Simulated inbound webhook requires exactly one durable command service source');
  }
  const resolveBinding = options.resolveBinding
    ?? (() => options.binding as TBinding);
  const resolveCommandService = options.resolveCommandService
    ?? (() => options.commandService as DurableSimulatedInboundCommandService);
  const observer = options.onSafeOutcome;

  return async (req, res): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'POST' || requestUrl.pathname !== path || requestUrl.search !== '') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (!hasExactJsonContentType(req)) {
      sendJson(res, 415, { error: 'unsupported_media_type' });
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readBoundedRawBody(req);
    } catch (error) {
      if (error instanceof SimulatedInboundRequestBodyTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large' });
      } else {
        safeOutcome(observer, 'temporarily_unavailable');
        sendJson(res, 503, { error: 'simulated_inbound_temporarily_unavailable' }, true);
      }
      return;
    }

    const signature = exactSingleHeader(req, SIMULATED_INBOUND_SIGNATURE_HEADER);
    if (!signature) {
      safeOutcome(observer, 'authentication_failed');
      sendJson(res, 401, { error: 'authentication_failed' });
      return;
    }

    let event: TEvent;
    let identity: VerifiedSimulatedInboundIdentity;
    try {
      event = adapter.verify({
        rawBody,
        signature,
        contentType: exactSingleHeader(req, 'content-type') ?? '',
        testSecret,
      });
      identity = adapter.identity(event);
    } catch {
      safeOutcome(observer, 'authentication_failed');
      sendJson(res, 401, { error: 'authentication_failed' });
      return;
    }

    try {
      assertFresh(identity.occurredAt, now());
    } catch {
      safeOutcome(observer, 'event_rejected');
      sendJson(res, 409, { error: 'event_rejected' });
      return;
    }

    let command: RecordTestInboundCommand;
    let commandService: DurableSimulatedInboundCommandService;
    try {
      command = adapter.toCommand(event, resolveBinding(event));
      commandService = resolveCommandService(event);
    } catch (error) {
      const contractError = isContractError(error);
      safeOutcome(observer, contractError ? 'event_rejected' : 'temporarily_unavailable');
      sendJson(res, contractError ? 422 : 503, {
        error: contractError
          ? 'invalid_event_binding'
          : 'simulated_inbound_temporarily_unavailable',
      }, !contractError);
      return;
    }

    try {
      const result = await commandService.recordAuthenticatedTestInbound(Object.freeze({
        schemaVersion: 1,
        environment: 'test',
        providerId: adapter.providerId,
        workspaceId: identity.workspaceId,
        connectionId: identity.connectionId,
        externalEventId: identity.externalEventId,
        externalMessageId: identity.externalMessageId,
        occurredAt: identity.occurredAt,
        payloadSha256: sha256Bytes(rawBody),
        eventIdentitySha256: authenticatedIdentitySha256(adapter.providerId, identity),
        signatureSha256: sha256Bytes(signature),
        sourceIdentitySha256: sha256Bytes(identity.sourceTestAddress),
        destinationIdentitySha256: sha256Bytes(identity.destinationTestAddress),
        command,
      }));
      if (result.disposition !== 'applied' && result.disposition !== 'replayed') {
        throw new Error('Durable simulated inbound command returned an invalid disposition');
      }
      const replayed = result.disposition === 'replayed';
      safeOutcome(observer, replayed ? 'replayed' : 'accepted');
      sendJson(res, replayed ? 200 : 202, {
        accepted: true,
        replayed,
        environment: 'test',
      });
    } catch (error) {
      if (error instanceof SimulatedInboundEventConflictError
          || error instanceof InboxIdempotencyConflictError) {
        safeOutcome(observer, 'event_conflict');
        sendJson(res, 409, { error: 'event_conflict' });
      } else if (error instanceof SimulatedInboundCommandInProgressError
          || error instanceof SimulatedInboundBindingUnavailableError
          || error instanceof InboxCommandInProgressError
          || error instanceof InboxNotFoundError) {
        safeOutcome(observer, 'temporarily_unavailable');
        sendJson(res, 503, { error: 'simulated_inbound_temporarily_unavailable' }, true);
      } else if (error instanceof InboxValidationError) {
        safeOutcome(observer, 'event_rejected');
        sendJson(res, 422, { error: 'invalid_event' });
      } else {
        safeOutcome(observer, 'temporarily_unavailable');
        sendJson(res, 503, { error: 'simulated_inbound_temporarily_unavailable' }, true);
      }
    }
  };
}

export function createSimulatedWhatsAppInboundWebhookHandler(
  options: Omit<
    SimulatedInboundWebhookHandlerOptions<SimulatedWhatsAppInboundEvent, OwnInboxWhatsAppBinding>,
    'path' | 'adapter' | 'commandService' | 'resolveCommandService'
  > & Readonly<{ commandService: DurableSimulatedInboundCommandService }>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return createSimulatedInboundWebhookHandler({
    ...options,
    path: PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOUND_PATH,
    adapter: SIMULATED_WHATSAPP_INBOUND_ENVELOPE_ADAPTER,
  });
}

export function createSimulatedMetaDmInboundWebhookHandler(
  options: Omit<
    SimulatedInboundWebhookHandlerOptions<
      VerifiedSocialDmDarkInbound,
      FacebookInstagramDmOwnInboxBinding
    >,
    'path' | 'adapter' | 'binding' | 'resolveBinding' | 'commandService' | 'resolveCommandService'
  > & Readonly<{
    bindings: FacebookInstagramDmOwnInboxBindings;
    commandServices: Readonly<{
      facebook: DurableSimulatedInboundCommandService;
      instagram: DurableSimulatedInboundCommandService;
    }>;
  }>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  if (options.commandServices.facebook === options.commandServices.instagram) {
    throw new Error('Simulated Meta DM networks require separately bound command services');
  }
  if (options.bindings.facebook.connectionId === options.bindings.instagram.connectionId) {
    throw new Error('Simulated Meta DM networks require distinct provider connections');
  }
  const bindings = Object.freeze({
    facebook: Object.freeze({ ...options.bindings.facebook }),
    instagram: Object.freeze({ ...options.bindings.instagram }),
  });
  const commandServices = Object.freeze({
    facebook: options.commandServices.facebook,
    instagram: options.commandServices.instagram,
  });
  return createSimulatedInboundWebhookHandler({
    ...options,
    path: PROPERTY_PREDATOR_SIMULATED_META_DM_INBOUND_PATH,
    adapter: SIMULATED_FACEBOOK_INSTAGRAM_DM_ENVELOPE_ADAPTER,
    resolveBinding: (event) => event.event.network === 'facebook'
      ? bindings.facebook
      : bindings.instagram,
    resolveCommandService: (event) => event.event.network === 'facebook'
      ? commandServices.facebook
      : commandServices.instagram,
  });
}
