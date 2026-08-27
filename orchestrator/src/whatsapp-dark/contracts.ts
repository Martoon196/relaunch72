import { createHash } from 'node:crypto';
import type { ProviderOperationContext } from '../providers/contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TEMPLATE_ID = /^wa_test_template_[a-z0-9_]{1,64}$/u;
const TEMPLATE_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const TEMPLATE_LANGUAGE = /^[a-z]{2}(?:_[A-Z]{2})?$/u;
const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,31}$/u;
const RESERVED_TEST_NUMBER = /^\+447700900[0-9]{3}$/u;
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]{0,31})\}\}/gu;
const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;

export const WHATSAPP_DARK_PROVIDER_ID = 'whatsapp_dark_simulator';
export const WHATSAPP_DARK_CONTRACT_VERSION = 'property-predator.whatsapp-dark/v1';

export type WhatsAppTemplateCategory = 'marketing' | 'utility' | 'authentication';

export interface WhatsAppDarkTemplateInput {
  readonly templateId: string;
  readonly version: number;
  readonly name: string;
  readonly language: string;
  readonly category: WhatsAppTemplateCategory;
  readonly body: string;
  readonly variableNames: readonly string[];
}

export interface WhatsAppDarkTemplate extends WhatsAppDarkTemplateInput {
  readonly lifecycle: 'test_only_draft';
  readonly bodySha256: string;
}

export interface WhatsAppDarkTemplateRequest {
  readonly recipient: string;
  readonly template: WhatsAppDarkTemplate;
  readonly variables: Readonly<Record<string, string>>;
  readonly approvalId: string;
  readonly consentEvidenceId: string;
  readonly pecrSenderDecisionId: string;
  readonly operatorInstigatorDecisionId: string;
}

export interface WhatsAppDarkResult {
  readonly effectMode: 'simulated_test_only';
  readonly status: 'simulated';
  readonly testReference: string;
  readonly occurredAt: string;
  readonly providerOperationCreated: false;
  readonly externalDeliveryAttempted: false;
  readonly summary: 'Reserved WhatsApp test operation simulated';
}

export interface WhatsAppDarkAdapter {
  readonly providerId: typeof WHATSAPP_DARK_PROVIDER_ID;
  readonly mode: 'simulated_test_only';
  simulateTemplate(
    context: ProviderOperationContext,
    request: WhatsAppDarkTemplateRequest,
  ): Promise<WhatsAppDarkResult>;
  reconcileSimulation(
    context: ProviderOperationContext,
    testReference: string,
  ): Promise<WhatsAppDarkResult>;
}

export class WhatsAppDarkContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppDarkContractError';
  }
}

function fail(message: string): never {
  throw new WhatsAppDarkContractError(message);
}

function exactString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum
      || !SAFE_TEXT.test(value) || Buffer.byteLength(value, 'utf8') > maximum * 4) {
    fail(`${label} is invalid`);
  }
  return value;
}

export function assertWhatsAppDarkUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a canonical UUID`);
  return value;
}

export function assertReservedWhatsAppTestNumber(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RESERVED_TEST_NUMBER.test(value)) {
    fail(`${label} must use the reserved non-routable WhatsApp test range`);
  }
  return value;
}

export function assertWhatsAppDarkContext(context: ProviderOperationContext): void {
  if (context.providerId !== WHATSAPP_DARK_PROVIDER_ID) fail('provider context is not the dark simulator');
  assertWhatsAppDarkUuid(context.workspaceId, 'context.workspaceId');
  assertWhatsAppDarkUuid(context.connectionId, 'context.connectionId');
  assertWhatsAppDarkUuid(context.operationId, 'context.operationId');
  assertWhatsAppDarkUuid(context.correlationId, 'context.correlationId');
  exactString(context.idempotencyKey, 'context.idempotencyKey', 1, 200);
}

export function createWhatsAppDarkTemplate(input: WhatsAppDarkTemplateInput): WhatsAppDarkTemplate {
  if (!TEMPLATE_ID.test(input.templateId)) fail('templateId is invalid');
  if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version > 1_000_000) {
    fail('template version is invalid');
  }
  if (!TEMPLATE_NAME.test(input.name)) fail('template name is invalid');
  if (!TEMPLATE_LANGUAGE.test(input.language)) fail('template language is invalid');
  if (!(['marketing', 'utility', 'authentication'] as const).includes(input.category)) {
    fail('template category is invalid');
  }
  const body = exactString(input.body, 'template body', 1, 4_096);
  if (!Array.isArray(input.variableNames) || input.variableNames.length > 20) {
    fail('template variable declaration is invalid');
  }
  const variableNames = input.variableNames.map((name) => {
    if (typeof name !== 'string' || !VARIABLE_NAME.test(name)) fail('template variable name is invalid');
    return name;
  });
  if (new Set(variableNames).size !== variableNames.length) fail('template variable names must be unique');
  const placeholders = [...body.matchAll(PLACEHOLDER)].map((match) => match[1]!);
  const residue = body.replace(PLACEHOLDER, '');
  if (residue.includes('{{') || residue.includes('}}')) fail('template contains a malformed placeholder');
  const declared = new Set(variableNames);
  if (new Set(placeholders).size !== declared.size || placeholders.some((name) => !declared.has(name))) {
    fail('template placeholders must exactly match the declared variables');
  }
  return Object.freeze({
    templateId: input.templateId,
    version: input.version,
    name: input.name,
    language: input.language,
    category: input.category,
    body,
    variableNames: Object.freeze([...variableNames]),
    lifecycle: 'test_only_draft',
    bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
  });
}

export function renderWhatsAppDarkTemplate(request: WhatsAppDarkTemplateRequest): Readonly<{
  recipient: string;
  renderedBody: string;
  renderedBodySha256: string;
}> {
  const recipient = assertReservedWhatsAppTestNumber(request.recipient, 'recipient');
  const evidence = [
    ['approvalId', request.approvalId],
    ['consentEvidenceId', request.consentEvidenceId],
    ['pecrSenderDecisionId', request.pecrSenderDecisionId],
    ['operatorInstigatorDecisionId', request.operatorInstigatorDecisionId],
  ] as const;
  for (const [label, value] of evidence) assertWhatsAppDarkUuid(value, label);
  if (request.template.lifecycle !== 'test_only_draft') fail('only test-only draft templates are accepted');
  const template = createWhatsAppDarkTemplate(request.template);
  if (request.template.bodySha256 !== template.bodySha256) fail('template body hash is invalid');
  const suppliedKeys = Object.keys(request.variables).sort();
  const expectedKeys = [...template.variableNames].sort();
  if (suppliedKeys.length !== expectedKeys.length
      || suppliedKeys.some((key, index) => key !== expectedKeys[index])) {
    fail('template variables must exactly match the approved template');
  }
  const values = new Map<string, string>();
  for (const name of expectedKeys) {
    const value = exactString(request.variables[name], `template variable ${name}`, 1, 1_024);
    if (value.includes('{{') || value.includes('}}')) fail('template variable contains placeholder syntax');
    values.set(name, value);
  }
  const renderedBody = template.body.replace(PLACEHOLDER, (_whole, name: string) => values.get(name)!);
  if (Buffer.byteLength(renderedBody, 'utf8') > 16_384) fail('rendered template exceeds the byte bound');
  return Object.freeze({
    recipient,
    renderedBody,
    renderedBodySha256: createHash('sha256').update(renderedBody, 'utf8').digest('hex'),
  });
}
