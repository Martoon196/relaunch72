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
    .update(`${context.workspaceId}\n${context.connectionId}\n${context.operationId}\n${context.idempotencyKey}`, 'utf8')
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
    assertWhatsAppDarkContext(context);
    const rendered = renderWhatsAppDarkTemplate(context, request);
    const testReference = reference(context);
    this.#audit.push(Object.freeze({
      mode: 'simulate',
      operationId: context.operationId,
      templateId: request.template.templateId,
      templateVersion: request.template.version,
      recipientSha256: createHash('sha256').update(rendered.recipient, 'utf8').digest('hex'),
      renderedBodySha256: rendered.renderedBodySha256,
      testReference,
      externalDeliveryAttempted: false,
    }));
    return result(testReference, this.#now);
  }

  async reconcileSimulation(
    context: ProviderOperationContext,
    testReference: string,
  ): Promise<WhatsAppDarkResult> {
    assertWhatsAppDarkContext(context);
    if (!TEST_REFERENCE.test(testReference) || testReference !== reference(context)) {
      throw new WhatsAppDarkContractError('WhatsApp simulation reference is invalid');
    }
    this.#audit.push(Object.freeze({
      mode: 'reconcile', operationId: context.operationId,
      templateId: null, templateVersion: null, recipientSha256: null,
      renderedBodySha256: null, testReference, externalDeliveryAttempted: false,
    }));
    return result(testReference, this.#now);
  }
}
