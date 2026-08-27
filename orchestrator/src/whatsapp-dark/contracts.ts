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
  readonly templateSha256: string;
}

export interface WhatsAppDarkEvidenceBundleInput {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly recipientSha256: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateSha256: string;
  readonly approvalId: string;
  readonly approvalDecision: 'approved_for_test_simulation';
  readonly consentEvidenceId: string;
  readonly consentDecision: 'eligible_for_test_simulation';
  readonly pecrSenderDecisionId: string;
  readonly pecrSenderDecision: 'eligible_for_test_simulation';
  readonly operatorInstigatorDecisionId: string;
  readonly operatorInstigatorDecision: 'eligible_for_test_simulation';
  readonly purpose: 'own_inbox_test';
  readonly evaluatedAt: string;
}

export interface WhatsAppDarkEvidenceBundle extends WhatsAppDarkEvidenceBundleInput {
  readonly evidenceBundleSha256: string;
}

export interface WhatsAppDarkTemplateRequest {
  readonly recipient: string;
  readonly template: WhatsAppDarkTemplate;
  readonly variables: Readonly<Record<string, string>>;
  readonly evidence: WhatsAppDarkEvidenceBundle;
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

export function whatsAppDarkRecipientSha256(recipient: string): string {
  return createHash('sha256')
    .update(assertReservedWhatsAppTestNumber(recipient, 'recipient'), 'utf8')
    .digest('hex');
}

export function assertWhatsAppDarkContext(context: ProviderOperationContext): ProviderOperationContext {
  const exact = Object.freeze({
    workspaceId: context.workspaceId,
    connectionId: context.connectionId,
    providerId: context.providerId,
    operationId: context.operationId,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
  if (exact.providerId !== WHATSAPP_DARK_PROVIDER_ID) fail('provider context is not the dark simulator');
  assertWhatsAppDarkUuid(exact.workspaceId, 'context.workspaceId');
  assertWhatsAppDarkUuid(exact.connectionId, 'context.connectionId');
  assertWhatsAppDarkUuid(exact.operationId, 'context.operationId');
  assertWhatsAppDarkUuid(exact.correlationId, 'context.correlationId');
  exactString(exact.idempotencyKey, 'context.idempotencyKey', 1, 200);
  return exact;
}

export function createWhatsAppDarkTemplate(input: WhatsAppDarkTemplateInput): WhatsAppDarkTemplate {
  const templateId = input.templateId;
  const version = input.version;
  const name = input.name;
  const language = input.language;
  const category = input.category;
  const rawBody = input.body;
  const rawVariableNames = input.variableNames;
  const variableNameSnapshot = Array.isArray(rawVariableNames) ? [...rawVariableNames] : null;
  if (typeof templateId !== 'string' || !TEMPLATE_ID.test(templateId)) fail('templateId is invalid');
  if (!Number.isSafeInteger(version) || version < 1 || version > 1_000_000) {
    fail('template version is invalid');
  }
  if (typeof name !== 'string' || !TEMPLATE_NAME.test(name)) fail('template name is invalid');
  if (typeof language !== 'string' || !TEMPLATE_LANGUAGE.test(language)) fail('template language is invalid');
  if (!(['marketing', 'utility', 'authentication'] as const).includes(category)) {
    fail('template category is invalid');
  }
  const body = exactString(rawBody, 'template body', 1, 4_096);
  if (variableNameSnapshot === null || variableNameSnapshot.length > 20) {
    fail('template variable declaration is invalid');
  }
  const variableNames = variableNameSnapshot.map((variableName) => {
    if (typeof variableName !== 'string' || !VARIABLE_NAME.test(variableName)) {
      fail('template variable name is invalid');
    }
    return variableName;
  });
  if (new Set(variableNames).size !== variableNames.length) fail('template variable names must be unique');
  const placeholders = [...body.matchAll(PLACEHOLDER)].map((match) => match[1]!);
  const residue = body.replace(PLACEHOLDER, '');
  if (residue.includes('{{') || residue.includes('}}')) fail('template contains a malformed placeholder');
  const declared = new Set(variableNames);
  if (new Set(placeholders).size !== declared.size || placeholders.some((name) => !declared.has(name))) {
    fail('template placeholders must exactly match the declared variables');
  }
  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const templateSha256 = createHash('sha256').update(JSON.stringify({
    body,
    category,
    language,
    name,
    templateId,
    variableNames,
    version,
  }), 'utf8').digest('hex');
  return Object.freeze({
    templateId,
    version,
    name,
    language,
    category,
    body,
    variableNames: Object.freeze([...variableNames]),
    lifecycle: 'test_only_draft',
    bodySha256,
    templateSha256,
  });
}

export function createWhatsAppDarkEvidenceBundle(
  input: WhatsAppDarkEvidenceBundleInput,
): WhatsAppDarkEvidenceBundle {
  const snapshot = {
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    recipientSha256: input.recipientSha256,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    templateSha256: input.templateSha256,
    approvalId: input.approvalId,
    approvalDecision: input.approvalDecision,
    consentEvidenceId: input.consentEvidenceId,
    consentDecision: input.consentDecision,
    pecrSenderDecisionId: input.pecrSenderDecisionId,
    pecrSenderDecision: input.pecrSenderDecision,
    operatorInstigatorDecisionId: input.operatorInstigatorDecisionId,
    operatorInstigatorDecision: input.operatorInstigatorDecision,
    purpose: input.purpose,
    evaluatedAt: input.evaluatedAt,
  } as const;
  const workspaceId = assertWhatsAppDarkUuid(snapshot.workspaceId, 'evidence.workspaceId');
  const connectionId = assertWhatsAppDarkUuid(snapshot.connectionId, 'evidence.connectionId');
  const evidenceIds = [
    ['evidence.approvalId', snapshot.approvalId],
    ['evidence.consentEvidenceId', snapshot.consentEvidenceId],
    ['evidence.pecrSenderDecisionId', snapshot.pecrSenderDecisionId],
    ['evidence.operatorInstigatorDecisionId', snapshot.operatorInstigatorDecisionId],
  ] as const;
  for (const [label, value] of evidenceIds) assertWhatsAppDarkUuid(value, label);
  if (typeof snapshot.recipientSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(snapshot.recipientSha256)
      || typeof snapshot.templateId !== 'string' || !TEMPLATE_ID.test(snapshot.templateId)
      || !Number.isSafeInteger(snapshot.templateVersion) || snapshot.templateVersion < 1
      || typeof snapshot.templateSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(snapshot.templateSha256)
      || snapshot.approvalDecision !== 'approved_for_test_simulation'
      || snapshot.consentDecision !== 'eligible_for_test_simulation'
      || snapshot.pecrSenderDecision !== 'eligible_for_test_simulation'
      || snapshot.operatorInstigatorDecision !== 'eligible_for_test_simulation'
      || snapshot.purpose !== 'own_inbox_test'
      || typeof snapshot.evaluatedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(snapshot.evaluatedAt)
      || Number.isNaN(Date.parse(snapshot.evaluatedAt))
      || new Date(snapshot.evaluatedAt).toISOString() !== snapshot.evaluatedAt) {
    fail('evidence bundle is invalid');
  }
  const exact = {
    workspaceId,
    connectionId,
    recipientSha256: snapshot.recipientSha256,
    templateId: snapshot.templateId,
    templateVersion: snapshot.templateVersion,
    templateSha256: snapshot.templateSha256,
    approvalId: snapshot.approvalId,
    approvalDecision: snapshot.approvalDecision,
    consentEvidenceId: snapshot.consentEvidenceId,
    consentDecision: snapshot.consentDecision,
    pecrSenderDecisionId: snapshot.pecrSenderDecisionId,
    pecrSenderDecision: snapshot.pecrSenderDecision,
    operatorInstigatorDecisionId: snapshot.operatorInstigatorDecisionId,
    operatorInstigatorDecision: snapshot.operatorInstigatorDecision,
    purpose: snapshot.purpose,
    evaluatedAt: snapshot.evaluatedAt,
  } as const;
  return Object.freeze({
    ...exact,
    evidenceBundleSha256: createHash('sha256').update(JSON.stringify(exact), 'utf8').digest('hex'),
  });
}

export function renderWhatsAppDarkTemplate(
  context: ProviderOperationContext,
  request: WhatsAppDarkTemplateRequest,
): Readonly<{
  recipient: string;
  renderedBody: string;
  renderedBodySha256: string;
  templateId: string;
  templateVersion: number;
  evidenceBundleSha256: string;
}> {
  const exactContext = assertWhatsAppDarkContext(context);
  const rawRecipient = request.recipient;
  const rawTemplate = request.template;
  const rawVariableNames = rawTemplate.variableNames;
  const templateSnapshot = {
    templateId: rawTemplate.templateId,
    version: rawTemplate.version,
    name: rawTemplate.name,
    language: rawTemplate.language,
    category: rawTemplate.category,
    body: rawTemplate.body,
    variableNames: Array.isArray(rawVariableNames) ? [...rawVariableNames] : rawVariableNames,
    lifecycle: rawTemplate.lifecycle,
    bodySha256: rawTemplate.bodySha256,
    templateSha256: rawTemplate.templateSha256,
  } as const;
  const evidenceSnapshot = { ...request.evidence };
  const variables = request.variables;
  const recipient = assertReservedWhatsAppTestNumber(rawRecipient, 'recipient');
  if (templateSnapshot.lifecycle !== 'test_only_draft') fail('only test-only draft templates are accepted');
  const template = createWhatsAppDarkTemplate(templateSnapshot);
  if (templateSnapshot.bodySha256 !== template.bodySha256) fail('template body hash is invalid');
  if (templateSnapshot.templateSha256 !== template.templateSha256) fail('template metadata hash is invalid');
  const evidence = createWhatsAppDarkEvidenceBundle(evidenceSnapshot);
  if (evidenceSnapshot.evidenceBundleSha256 !== evidence.evidenceBundleSha256
      || evidence.workspaceId !== exactContext.workspaceId
      || evidence.connectionId !== exactContext.connectionId
      || evidence.recipientSha256 !== whatsAppDarkRecipientSha256(recipient)
      || evidence.templateId !== template.templateId
      || evidence.templateVersion !== template.version
      || evidence.templateSha256 !== template.templateSha256) {
    fail('evidence bundle is not bound to this test operation');
  }
  const suppliedKeys = Object.keys(variables).sort();
  const expectedKeys = [...template.variableNames].sort();
  if (suppliedKeys.length !== expectedKeys.length
      || suppliedKeys.some((key, index) => key !== expectedKeys[index])) {
    fail('template variables must exactly match the approved template');
  }
  const values = new Map<string, string>();
  for (const name of expectedKeys) {
    const value = exactString(variables[name], `template variable ${name}`, 1, 1_024);
    if (value.includes('{{') || value.includes('}}')) fail('template variable contains placeholder syntax');
    values.set(name, value);
  }
  const renderedBody = template.body.replace(PLACEHOLDER, (_whole, name: string) => values.get(name)!);
  if (Buffer.byteLength(renderedBody, 'utf8') > 16_384) fail('rendered template exceeds the byte bound');
  return Object.freeze({
    recipient,
    renderedBody,
    renderedBodySha256: createHash('sha256').update(renderedBody, 'utf8').digest('hex'),
    templateId: template.templateId,
    templateVersion: template.version,
    evidenceBundleSha256: evidence.evidenceBundleSha256,
  });
}
