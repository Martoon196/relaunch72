import { createHash } from 'node:crypto';
import type { ProviderOperationContext } from '../providers/contracts.js';
import {
  WHATSAPP_DARK_PROVIDER_ID,
  WhatsAppDarkContractError,
  assertWhatsAppDarkContext,
  renderWhatsAppDarkTemplate,
  type WhatsAppDarkAdapter,
  type WhatsAppDarkResult,
  type WhatsAppDarkTemplateRequest,
} from './contracts.js';

const TEST_REFERENCE = /^wa_test_[a-f0-9]{32}$/u;

export interface WhatsAppSimulationAudit {
  readonly mode: 'simulate' | 'reconcile';
  readonly operationId: string;
  readonly templateId: string | null;
  readonly templateVersion: number | null;
  readonly recipientSha256: string | null;
  readonly renderedBodySha256: string | null;
  readonly testReference: string;
  readonly externalDeliveryAttempted: false;
}

function reference(context: ProviderOperationContext): string {
  return `wa_test_${createHash('sha256')
    .update([
      context.workspaceId,
      context.connectionId,
      context.providerId,
      context.operationId,
      context.idempotencyKey,
      context.correlationId,
    ].join('\n'), 'utf8')
    .digest('hex').slice(0, 32)}`;
}

function result(testReference: string, now: () => Date): WhatsAppDarkResult {
  return Object.freeze({
    effectMode: 'simulated_test_only',
    status: 'simulated',
    testReference,
    occurredAt: now().toISOString(),
    providerOperationCreated: false,
    externalDeliveryAttempted: false,
    summary: 'Reserved WhatsApp test operation simulated',
  });
}

/**
 * Deterministic in-memory simulator. It has no transport, credentials, provider
 * SDK or registry entry and refuses every address outside the UK drama range.
 */
export class SimulatedWhatsAppDarkAdapter implements WhatsAppDarkAdapter {
  readonly providerId = WHATSAPP_DARK_PROVIDER_ID;
  readonly mode = 'simulated_test_only' as const;
  readonly #audit: WhatsAppSimulationAudit[] = [];
  readonly #results = new Map<string, Readonly<{ requestSha256: string; result: WhatsAppDarkResult }>>();
  readonly #now: () => Date;

  constructor(options: Readonly<{ now?: () => Date }> = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  get audit(): readonly WhatsAppSimulationAudit[] {
    return Object.freeze(this.#audit.map((entry) => Object.freeze({ ...entry })));
  }

  async simulateTemplate(
    context: ProviderOperationContext,
    request: WhatsAppDarkTemplateRequest,
  ): Promise<WhatsAppDarkResult> {
    const exactContext = assertWhatsAppDarkContext(context);
    const rendered = renderWhatsAppDarkTemplate(exactContext, request);
    const recipientSha256 = createHash('sha256').update(rendered.recipient, 'utf8').digest('hex');
    const requestSha256 = createHash('sha256').update(JSON.stringify({
      connectionId: exactContext.connectionId,
      correlationId: exactContext.correlationId,
      evidenceBundleSha256: rendered.evidenceBundleSha256,
      idempotencyKey: exactContext.idempotencyKey,
      providerId: exactContext.providerId,
      recipientSha256,
      renderedBodySha256: rendered.renderedBodySha256,
      templateId: rendered.templateId,
      templateVersion: rendered.templateVersion,
      workspaceId: exactContext.workspaceId,
    }), 'utf8').digest('hex');
    const existing = this.#results.get(exactContext.operationId);
    if (existing) {
      if (existing.requestSha256 !== requestSha256) {
        throw new WhatsAppDarkContractError('operation id was reused with different test input');
      }
      return existing.result;
    }
    const testReference = reference(exactContext);
    const simulatedResult = result(testReference, this.#now);
    this.#audit.push(Object.freeze({
      mode: 'simulate',
      operationId: exactContext.operationId,
      templateId: rendered.templateId,
      templateVersion: rendered.templateVersion,
      recipientSha256,
      renderedBodySha256: rendered.renderedBodySha256,
      testReference,
      externalDeliveryAttempted: false,
    }));
    this.#results.set(exactContext.operationId, Object.freeze({ requestSha256, result: simulatedResult }));
    return simulatedResult;
  }

  async reconcileSimulation(
    context: ProviderOperationContext,
    testReference: string,
  ): Promise<WhatsAppDarkResult> {
    const exactContext = assertWhatsAppDarkContext(context);
    const stored = this.#results.get(exactContext.operationId);
    if (!stored || !TEST_REFERENCE.test(testReference) || testReference !== reference(exactContext)
        || stored.result.testReference !== testReference) {
      throw new WhatsAppDarkContractError('WhatsApp simulation reference is invalid');
    }
    if (!this.#audit.some((entry) => entry.mode === 'reconcile' && entry.operationId === exactContext.operationId)) {
      this.#audit.push(Object.freeze({
        mode: 'reconcile', operationId: exactContext.operationId,
        templateId: null, templateVersion: null, recipientSha256: null,
        renderedBodySha256: null, testReference, externalDeliveryAttempted: false,
      }));
    }
    return stored.result;
  }
}
