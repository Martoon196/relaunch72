import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ControlledPropertyPredatorEmailPilot,
  propertyPredatorEmailContentSha256,
  type ControlledEmailPilotBoundary,
  type ControlledEmailPilotBoundaryDecision,
  type ControlledEmailPilotBoundaryInput,
  type ControlledEmailPilotCommand,
  type ControlledEmailPilotCurrentEvidence,
} from '../src/providers/controlled-property-predator-email-pilot.js';
import {
  createMailgunEuHttpAdapterFromDomainSendingKeyEnvironment,
  MailgunEuHttpAdapter,
  MailgunOutcomeUnknownError,
  type MailgunEuEmailRequest,
  type MailgunEuEmailTransport,
} from '../src/providers/mailgun-eu-http-adapter.js';
import {
  loadPropertyPredatorEmailPilotPolicy,
  normalizeOwnedInternalSeedEmail,
  PROPERTY_PREDATOR_EMAIL_PROVIDER_ID,
  type PropertyPredatorEmailPilotPolicy,
} from '../src/providers/property-predator-email-pilot-config.js';
import type {
  ProviderOperationContext,
  ProviderOperationResult,
} from '../src/providers/contracts.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  operation: '33333333-3333-4333-8333-333333333333',
  correlation: '44444444-4444-4444-8444-444444444444',
  run: '55555555-5555-4555-8555-555555555555',
  version: '66666666-6666-4666-8666-666666666666',
  approvalRequest: '77777777-7777-4777-8777-777777777777',
  approvalDecision: '88888888-8888-4888-8888-888888888888',
  contactPoint: '99999999-9999-4999-8999-999999999999',
  consent: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  reservation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
});

const NOW = new Date('2026-08-26T12:00:00.000Z');
const SUBJECT = 'Your Property Predator pilot result';
const BODY = 'This is a controlled internal-seed email. 🐆';

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED: 'true',
    PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_EMAIL_PROVIDER: 'mailgun',
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: IDS.workspace,
    PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID: IDS.connection,
    PROPERTY_PREDATOR_PILOT_STAGE: 'internal-seed',
    PROPERTY_PREDATOR_PILOT_RECIPIENT_SCOPE: 'owned-internal-seeds-only',
    PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS: '10',
    PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS: 'seed@example.com,second@café.example',
    PROPERTY_PREDATOR_EMAIL_RUN_MESSAGE_CAP: '10',
    PROPERTY_PREDATOR_EMAIL_MONTHLY_MESSAGE_CAP: '100',
    PROPERTY_PREDATOR_EMAIL_ESTIMATED_RECIPIENT_COST_USD_MICROS: '1000',
    PROPERTY_PREDATOR_EMAIL_RUN_SPEND_CAP_USD_MICROS: '10000',
    PROPERTY_PREDATOR_EMAIL_MONTHLY_SPEND_CAP_USD_MICROS: '100000',
    ...overrides,
  };
}

function policy(overrides: Partial<PropertyPredatorEmailPilotPolicy> = {}): PropertyPredatorEmailPilotPolicy {
  return Object.freeze({ ...loadPropertyPredatorEmailPilotPolicy(environment()), ...overrides });
}

function context(overrides: Partial<ProviderOperationContext> = {}): ProviderOperationContext {
  return Object.freeze({
    workspaceId: IDS.workspace,
    connectionId: IDS.connection,
    providerId: PROPERTY_PREDATOR_EMAIL_PROVIDER_ID,
    operationId: IDS.operation,
    idempotencyKey: 'controlled-pilot-operation-1',
    correlationId: IDS.correlation,
    ...overrides,
  });
}

function command(overrides: Partial<ControlledEmailPilotCommand> = {}): ControlledEmailPilotCommand {
  const subject = overrides.subject ?? SUBJECT;
  const text = overrides.text ?? BODY;
  return Object.freeze({
    runId: IDS.run,
    stage: 'internal-seed',
    recipientScope: 'owned-internal-seeds-only',
    subject,
    text,
    recipients: Object.freeze([Object.freeze({
      email: ' Seed@Example.com ',
      contactPointId: IDS.contactPoint,
      consentEventId: IDS.consent,
    })]),
    approval: Object.freeze({
      messageVersionId: IDS.version,
      approvalRequestId: IDS.approvalRequest,
      approvalDecisionId: IDS.approvalDecision,
      approvedContentSha256: propertyPredatorEmailContentSha256(subject, text),
    }),
    ...overrides,
  });
}

function currentEvidence(input: ControlledEmailPilotBoundaryInput): ControlledEmailPilotCurrentEvidence {
  return Object.freeze({
    workspaceId: input.workspaceId,
    providerConnectionId: input.providerConnectionId,
    stage: input.stage,
    recipientScope: input.recipientScope,
    providerEffectsEnabled: true,
    emailDeliveryEnabled: true,
    emergencyPaused: false,
    approval: Object.freeze({ ...input.approval, decision: 'approved', immutable: true }),
    recipients: Object.freeze(input.recipients.map((recipient) => Object.freeze({
      contactPointId: recipient.contactPointId,
      consentEventId: recipient.consentEventId,
      emailSha256: recipient.emailSha256,
      consentState: 'granted' as const,
      suppressed: false,
      ownedInternalSeed: true,
    }))),
    usageAfterReservation: Object.freeze({
      runMessages: input.requestedMessages,
      runSpendUsdMicros: input.estimatedSpendUsdMicros,
      monthMessages: input.requestedMessages,
      monthSpendUsdMicros: input.estimatedSpendUsdMicros,
      utcMonth: input.utcMonth,
    }),
  });
}

class MemoryBoundary implements ControlledEmailPilotBoundary {
  authorizeCalls = 0;
  cancelCalls = 0;
  settleCalls = 0;
  forcedBlock: string | null = null;
  evidence: ((input: ControlledEmailPilotBoundaryInput) => ControlledEmailPilotCurrentEvidence)
    = currentEvidence;
  readonly #operations = new Map<string, Readonly<{
    requestSha256: string;
    result: ProviderOperationResult | null;
  }>>();

  async authorizeImmediatelyBeforeProviderCall(
    input: ControlledEmailPilotBoundaryInput,
  ): Promise<ControlledEmailPilotBoundaryDecision> {
    this.authorizeCalls += 1;
    if (this.forcedBlock) return Object.freeze({ disposition: 'blocked', reason: this.forcedBlock });
    const prior = this.#operations.get(input.idempotencyKeySha256);
    if (prior) {
      if (prior.requestSha256 !== input.requestSha256) {
        return Object.freeze({ disposition: 'blocked', reason: 'idempotency_conflict' });
      }
      if (!prior.result) return Object.freeze({ disposition: 'blocked', reason: 'operation_in_progress' });
      return Object.freeze({
        disposition: 'replay', requestSha256: input.requestSha256, result: prior.result,
      });
    }
    this.#operations.set(input.idempotencyKeySha256, Object.freeze({
      requestSha256: input.requestSha256, result: null,
    }));
    return Object.freeze({
      disposition: 'authorized', reservationId: IDS.reservation,
      requestSha256: input.requestSha256, evidence: this.evidence(input),
    });
  }

  async cancelBeforeProviderCall(
    _reservationId: string,
    requestSha256: string,
    _reason: string,
  ): Promise<void> {
    this.cancelCalls += 1;
    for (const [key, operation] of this.#operations) {
      if (operation.requestSha256 === requestSha256 && operation.result === null) {
        this.#operations.delete(key);
      }
    }
  }

  async settleProviderCall(
    _reservationId: string,
    requestSha256: string,
    result: ProviderOperationResult,
  ): Promise<void> {
    this.settleCalls += 1;
    for (const [key, operation] of this.#operations) {
      if (operation.requestSha256 === requestSha256) {
        this.#operations.set(key, Object.freeze({ requestSha256, result }));
        return;
      }
    }
    throw new Error('reservation not found');
  }
}

class RecordingTransport implements MailgunEuEmailTransport {
  calls = 0;
  lastContext: ProviderOperationContext | null = null;
  lastRequest: MailgunEuEmailRequest | null = null;
  error: Error | null = null;

  async send(
    providerContext: ProviderOperationContext,
    request: MailgunEuEmailRequest,
  ): Promise<ProviderOperationResult> {
    this.calls += 1;
    this.lastContext = providerContext;
    this.lastRequest = request;
    if (this.error) throw this.error;
    return Object.freeze({
      status: 'accepted', externalId: '<pilot-message@example.com>',
      occurredAt: NOW.toISOString(), retryable: false, errorCode: null,
      summary: 'Mailgun accepted the controlled internal-seed email',
    });
  }
}

function pilot(options: Readonly<{
  policy?: PropertyPredatorEmailPilotPolicy;
  boundary?: MemoryBoundary;
  transport?: MailgunEuEmailTransport;
}> = {}): Readonly<{
  service: ControlledPropertyPredatorEmailPilot;
  boundary: MemoryBoundary;
  transport: MailgunEuEmailTransport;
}> {
  const boundary = options.boundary ?? new MemoryBoundary();
  const transport = options.transport ?? new RecordingTransport();
  return Object.freeze({
    boundary,
    transport,
    service: new ControlledPropertyPredatorEmailPilot({
      policy: options.policy ?? policy(), boundary, transport, now: () => NOW,
    }),
  });
}

test('policy switches default OFF and emergency pause defaults ON exactly', () => {
  const safeDefault = loadPropertyPredatorEmailPilotPolicy(environment({
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: undefined,
    PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED: 'TRUE',
    PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED: undefined,
  }));
  assert.equal(safeDefault.providerEffectsEnabled, false);
  assert.equal(safeDefault.emailDeliveryEnabled, false);
  assert.equal(safeDefault.emergencyPaused, true);
  assert.deepEqual(safeDefault.internalSeedAllowlist, [
    'seed@example.com', 'second@xn--caf-dma.example',
  ]);
});

test('recipient normalisation accepts IDNA domains and rejects Unicode-local and injection bypasses', () => {
  assert.equal(normalizeOwnedInternalSeedEmail(' SEED@CAFÉ.Example '), 'seed@xn--caf-dma.example');
  for (const unsafe of [
    'séed@example.com',
    'seed@example.com\r\nBcc:outside@example.com',
    'seed@example.com,other@example.com',
    'seed@example.com\u200b',
    'seed..name@example.com',
    'seed@localhost',
  ]) {
    assert.throws(() => normalizeOwnedInternalSeedEmail(unsafe));
  }
});

test('policy rejects recipient-count, duplicate-canonical, stage and budget bypasses', () => {
  assert.throws(() => loadPropertyPredatorEmailPilotPolicy(environment({
    PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS: '11',
  })), /between 1 and 10/);
  assert.throws(() => loadPropertyPredatorEmailPilotPolicy(environment({
    PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS: 'Seed@example.com,seed@example.com',
  })), /duplicate canonical recipient/);
  assert.throws(() => loadPropertyPredatorEmailPilotPolicy(environment({
    PROPERTY_PREDATOR_PILOT_STAGE: 'customer-live',
  })), /internal-seed/);
  assert.throws(() => loadPropertyPredatorEmailPilotPolicy(environment({
    PROPERTY_PREDATOR_EMAIL_RUN_SPEND_CAP_USD_MICROS: '5000',
  })), /cannot cover/);
});

test('both kill switches and the emergency pause block before boundary access', async () => {
  for (const unsafePolicy of [
    policy({ providerEffectsEnabled: false }),
    policy({ emailDeliveryEnabled: false }),
    policy({ emergencyPaused: true }),
  ]) {
    const run = pilot({ policy: unsafePolicy });
    const result = await run.service.dispatch(context(), command());
    assert.equal(result.disposition, 'blocked');
    assert.equal(run.boundary.authorizeCalls, 0);
    assert.equal((run.transport as RecordingTransport).calls, 0);
  }
});

test('workspace, connection, provider, stage and scope cannot be forged', async () => {
  const attempts: readonly [ProviderOperationContext, ControlledEmailPilotCommand, string][] = [
    [context({ workspaceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }), command(), 'wrong_workspace'],
    [context({ connectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }), command(), 'wrong_connection'],
    [context({ providerId: 'mailgun' }), command(), 'wrong_provider'],
    [context(), { ...command(), stage: 'customer-live' } as unknown as ControlledEmailPilotCommand, 'wrong_stage'],
    [context(), { ...command(), recipientScope: 'all-contacts' } as unknown as ControlledEmailPilotCommand, 'wrong_scope'],
  ];
  for (const [providerContext, dispatchCommand, reason] of attempts) {
    const run = pilot();
    assert.equal((await run.service.dispatch(providerContext, dispatchCommand)).reason, reason);
    assert.equal(run.boundary.authorizeCalls, 0);
  }
});

test('only unique allowlisted owned seeds can reach the final boundary', async () => {
  const outside = pilot();
  const outsideResult = await outside.service.dispatch(context(), command({
    recipients: [{
      email: 'customer@example.com', contactPointId: IDS.contactPoint, consentEventId: IDS.consent,
    }],
  }));
  assert.equal(outsideResult.reason, 'recipient_not_allowlisted');
  assert.equal(outside.boundary.authorizeCalls, 0);

  const duplicate = pilot();
  const duplicateResult = await duplicate.service.dispatch(context(), command({
    recipients: [
      { email: 'Seed@example.com', contactPointId: IDS.contactPoint, consentEventId: IDS.consent },
      { email: 'seed@example.com', contactPointId: IDS.contactPoint, consentEventId: IDS.consent },
    ],
  }));
  assert.equal(duplicateResult.reason, 'duplicate_recipient');
  assert.equal(duplicate.boundary.authorizeCalls, 0);

  const bulk = pilot();
  const bulkResult = await bulk.service.dispatch(context(), command({
    recipients: [
      { email: 'seed@example.com', contactPointId: IDS.contactPoint, consentEventId: IDS.consent },
      {
        email: 'second@xn--caf-dma.example',
        contactPointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        consentEventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
    ],
  }));
  assert.equal(bulkResult.reason, 'single_recipient_operation_required');
  assert.equal(bulk.boundary.authorizeCalls, 0);
});

test('the exact immutable approval hash covers Unicode subject and body bytes', async () => {
  assert.equal(
    propertyPredatorEmailContentSha256('Cafe\u0301', BODY),
    propertyPredatorEmailContentSha256('Café', BODY),
  );
  assert.notEqual(
    propertyPredatorEmailContentSha256(SUBJECT, 'é'),
    propertyPredatorEmailContentSha256(SUBJECT, 'e\u0301'),
  );
  const run = pilot();
  const forged = command({ text: `${BODY} altered` });
  const result = await run.service.dispatch(context(), {
    ...forged,
    approval: command().approval,
  });
  assert.equal(result.reason, 'approval_content_mismatch');
  assert.equal(run.boundary.authorizeCalls, 0);
});

test('final-boundary approval, consent, suppression, ownership and usage evidence fail closed', async () => {
  const mutations: readonly ((value: ControlledEmailPilotCurrentEvidence) => ControlledEmailPilotCurrentEvidence)[] = [
    (value) => ({ ...value, emergencyPaused: true }),
    (value) => ({ ...value, approval: { ...value.approval, approvalDecisionId: IDS.consent } }),
    (value) => ({ ...value, recipients: [{ ...value.recipients[0]!, consentState: 'withdrawn' }] }),
    (value) => ({ ...value, recipients: [{ ...value.recipients[0]!, suppressed: true }] }),
    (value) => ({ ...value, recipients: [{ ...value.recipients[0]!, ownedInternalSeed: false }] }),
    (value) => ({
      ...value,
      usageAfterReservation: { ...value.usageAfterReservation, monthMessages: 101 },
    }),
  ];
  for (const mutate of mutations) {
    const boundary = new MemoryBoundary();
    boundary.evidence = (input) => mutate(currentEvidence(input));
    const run = pilot({ boundary });
    const result = await run.service.dispatch(context(), command());
    assert.equal(result.reason, 'authorization_evidence_invalid');
    assert.equal(boundary.cancelCalls, 1);
    assert.equal((run.transport as RecordingTransport).calls, 0);
  }
});

test('durable boundary cap and emergency decisions never invoke Mailgun', async () => {
  for (const reason of ['run_message_cap', 'monthly_message_cap', 'monthly_spend_cap', 'emergency_paused']) {
    const boundary = new MemoryBoundary();
    boundary.forcedBlock = reason;
    const run = pilot({ boundary });
    const result = await run.service.dispatch(context(), command());
    assert.equal(result.reason, reason);
    assert.equal((run.transport as RecordingTransport).calls, 0);
  }
});

test('successful operation is deterministic and a replay cannot call the provider twice', async () => {
  const run = pilot();
  const first = await run.service.dispatch(context(), command());
  const second = await run.service.dispatch(context(), command());
  assert.equal(first.disposition, 'settled');
  assert.equal(second.disposition, 'replayed');
  assert.equal(first.requestSha256, second.requestSha256);
  assert.deepEqual(first.providerResult, second.providerResult);
  assert.equal((run.transport as RecordingTransport).calls, 1);
  assert.equal(run.boundary.settleCalls, 1);
  assert.match((run.transport as RecordingTransport).lastContext?.idempotencyKey ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual((run.transport as RecordingTransport).lastRequest?.recipients, ['seed@example.com']);
});

test('reusing one idempotency key with different approved content is blocked', async () => {
  const run = pilot();
  assert.equal((await run.service.dispatch(context(), command())).disposition, 'settled');
  const changedBody = `${BODY}\nSecond approved revision.`;
  const changed = command({
    text: changedBody,
    approval: {
      ...command().approval,
      approvedContentSha256: propertyPredatorEmailContentSha256(SUBJECT, changedBody),
    },
  });
  const conflict = await run.service.dispatch(context(), changed);
  assert.equal(conflict.reason, 'idempotency_conflict');
  assert.equal((run.transport as RecordingTransport).calls, 1);
});

test('an unknown or aborted transport outcome is settled once for manual reconciliation', async () => {
  const boundary = new MemoryBoundary();
  const transport = new RecordingTransport();
  transport.error = new MailgunOutcomeUnknownError();
  const run = pilot({ boundary, transport });
  const first = await run.service.dispatch(context(), command());
  assert.equal(first.disposition, 'settled');
  assert.equal(first.providerResult?.status, 'needs_attention');
  assert.equal(first.providerResult?.retryable, false);
  assert.equal(first.providerResult?.errorCode, 'mailgun_outcome_unknown');
  const replay = await run.service.dispatch(context(), command());
  assert.equal(replay.disposition, 'replayed');
  assert.equal(transport.calls, 1);
});

test('Mailgun adapter uses only the EU API, deterministic message identity and redacted credentials', async () => {
  const secret = 'key-mailgun-secret-must-never-render';
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ id: '<mailgun-id@example.com>', message: 'Queued. Thank you.' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const adapter = new MailgunEuHttpAdapter({
    apiKey: secret,
    sendingDomain: 'mail.propertypredator.co.uk',
    fromEmail: 'growth@mail.propertypredator.co.uk',
    fetch: fakeFetch,
    now: () => NOW,
  });
  const digest = 'd'.repeat(64);
  const result = await adapter.send(context({ idempotencyKey: digest }), {
    recipients: ['Seed@Example.com'], subject: SUBJECT, text: BODY, idempotencySha256: digest,
  });
  assert.equal(capturedUrl, 'https://api.eu.mailgun.net/v3/mail.propertypredator.co.uk/messages');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.redirect, 'error');
  assert.equal(result.status, 'accepted');
  assert.equal(JSON.stringify(adapter), '{"provider":"mailgun","region":"eu","credentials":"[REDACTED]"}');
  assert.doesNotMatch(JSON.stringify(adapter), new RegExp(secret));
  const headers = new Headers(capturedInit?.headers);
  assert.equal(Buffer.from(headers.get('authorization')!.slice(6), 'base64').toString('utf8'), `api:${secret}`);
  const form = capturedInit?.body as FormData;
  assert.deepEqual(form.getAll('to'), ['seed@example.com']);
  assert.equal(form.get('h:Message-Id'), `<pp-${digest}@mail.propertypredator.co.uk>`);
  assert.equal(form.get('v:pp-idempotency-sha256'), digest);
});

test('production factory accepts only an EU Domain Sending Key and the persisted Message-ID', async () => {
  let calls = 0;
  const digest = 'c'.repeat(64);
  const adapter = createMailgunEuHttpAdapterFromDomainSendingKeyEnvironment({
    MAILGUN_REGION: 'eu',
    MAILGUN_KEY_SCOPE: 'domain-sending',
    MAILGUN_DOMAIN_SENDING_KEY: 'domain-sending-secret',
    MAILGUN_SENDING_DOMAIN: 'mg.propertypredator.com',
    MAILGUN_FROM_EMAIL: 'growth@mg.propertypredator.com',
  }, {
    now: () => NOW,
    fetch: (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        id: `<pp-${digest}@mg.propertypredator.com>`, message: 'Queued',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  await assert.rejects(adapter.send(context({ idempotencyKey: digest }), {
    recipients: ['office@propertypredator.com'], subject: SUBJECT, text: BODY,
    idempotencySha256: digest,
    expectedMessageId: `<pp-${'d'.repeat(64)}@mg.propertypredator.com>`,
  }), /does not match durable worker evidence/);
  assert.equal(calls, 0);
  const result = await adapter.send(context({ idempotencyKey: digest }), {
    recipients: ['office@propertypredator.com'], subject: SUBJECT, text: BODY,
    idempotencySha256: digest,
    expectedMessageId: `<pp-${digest}@mg.propertypredator.com>`,
  });
  assert.equal(result.status, 'accepted');
  assert.equal(calls, 1);
  assert.throws(() => createMailgunEuHttpAdapterFromDomainSendingKeyEnvironment({
    MAILGUN_REGION: 'eu', MAILGUN_KEY_SCOPE: 'domain-sending',
    MAILGUN_DOMAIN_SENDING_KEY: 'domain-sending-secret',
    MAILGUN_API_KEY: 'broad-account-key',
    MAILGUN_SENDING_DOMAIN: 'mg.propertypredator.com',
    MAILGUN_FROM_EMAIL: 'growth@mg.propertypredator.com',
  }), /must not receive a broad account API key/);
});

test('Mailgun adapter classifies HTTP failures without leaking provider response bodies', async () => {
  const secretBody = 'upstream-secret-body-must-never-escape';
  for (const [status, expectedStatus, retryable] of [
    [400, 'failed', false],
    [429, 'failed', true],
    [408, 'needs_attention', false],
    [503, 'needs_attention', false],
  ] as const) {
    const adapter = new MailgunEuHttpAdapter({
      apiKey: 'key-redacted', sendingDomain: 'mail.propertypredator.co.uk',
      fromEmail: 'growth@mail.propertypredator.co.uk', now: () => NOW,
      fetch: (async () => new Response(secretBody, { status })) as typeof fetch,
    });
    const digest = 'e'.repeat(64);
    const result = await adapter.send(context({ idempotencyKey: digest }), {
      recipients: ['seed@example.com'], subject: SUBJECT, text: BODY, idempotencySha256: digest,
    });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.retryable, retryable);
    if (expectedStatus === 'needs_attention') {
      assert.match(result.errorCode ?? '', /_outcome_unknown$/);
    }
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secretBody));
  }
});

test('Mailgun adapter converts fetch aborts and exceptions into outcome-unknown without a live call', async () => {
  let calls = 0;
  const adapter = new MailgunEuHttpAdapter({
    apiKey: 'key-redacted', sendingDomain: 'mail.propertypredator.co.uk',
    fromEmail: 'growth@mail.propertypredator.co.uk',
    fetch: (async () => {
      calls += 1;
      throw new DOMException('aborted', 'AbortError');
    }) as typeof fetch,
  });
  const digest = 'f'.repeat(64);
  await assert.rejects(adapter.send(context({ idempotencyKey: digest }), {
    recipients: ['seed@example.com'], subject: SUBJECT, text: BODY, idempotencySha256: digest,
  }), MailgunOutcomeUnknownError);
  assert.equal(calls, 1);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(adapter.send(context({ idempotencyKey: digest }), {
    recipients: ['seed@example.com'], subject: SUBJECT, text: BODY,
    idempotencySha256: digest, signal: controller.signal,
  }), MailgunOutcomeUnknownError);
  assert.equal(calls, 1, 'an already-aborted request never reaches fetch');
});
