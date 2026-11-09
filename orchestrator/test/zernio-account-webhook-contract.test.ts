import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import {
  PublicSocialOutboundContractError,
  ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION,
  ZERNIO_ACCOUNT_WEBHOOK_MAXIMUM_BYTES,
  createZernioAccountWebhookCredential,
  verifyZernioAccountWebhook,
} from '../src/public-social-outbound/index.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  event: '33333333-3333-4333-8333-333333333333',
});
const PROFILE = 'profile_abc123';
const ACCOUNT = 'account_abc123';
const SECRET = `whsec_${'a'.repeat(64)}`;

function credential() {
  return createZernioAccountWebhookCredential({
    workspaceId: IDS.workspace,
    connectionId: IDS.connection,
    providerProfileId: PROFILE,
    credentialVersion: 'version-1',
    webhookSecret: SECRET,
  });
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.event,
    event: 'account.connected',
    timestamp: '2026-08-31T15:00:00.000Z',
    account: {
      accountId: ACCOUNT,
      profileId: PROFILE,
      platform: 'instagram',
      username: 'propertypredator',
      displayName: 'Property Predator',
    },
    ...overrides,
  };
}

function signed(value: unknown, eventIdHeader: string = IDS.event) {
  const rawBody = Buffer.from(JSON.stringify(value), 'utf8');
  return {
    rawBody,
    signatureHeader: createHmac('sha256', SECRET).update(rawBody).digest('hex'),
    eventIdHeader,
  };
}

test('verifies one exact signed account event into a hash-only receipt', () => {
  const input = signed(payload());
  const result = verifyZernioAccountWebhook(credential(), input);
  assert.deepEqual(result, {
    contract: ZERNIO_ACCOUNT_WEBHOOK_CONTRACT_VERSION,
    workspaceId: IDS.workspace,
    connectionId: IDS.connection,
    eventId: IDS.event,
    event: 'account.connected',
    network: 'instagram',
    occurredAt: '2026-08-31T15:00:00.000Z',
    providerProfileIdSha256: createHash('sha256').update(PROFILE).digest('hex'),
    providerAccountIdSha256: createHash('sha256').update(ACCOUNT).digest('hex'),
    rawBodySha256: createHash('sha256').update(input.rawBody).digest('hex'),
    receiptSha256: result.receiptSha256,
    providerEffects: 'none',
  });
  assert.match(result.receiptSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(result), /profile_abc123|account_abc123|propertypredator/iu);
});

test('credential serialization redacts the signing secret and copies are inauthentic', () => {
  const authentic = credential();
  assert.doesNotMatch(JSON.stringify(authentic), new RegExp(SECRET, 'u'));
  assert.match(JSON.stringify(authentic), /\[REDACTED\]/u);
  assert.throws(() => verifyZernioAccountWebhook({ ...authentic }, signed(payload())),
    PublicSocialOutboundContractError);
});

test('signature verification happens before hostile or malformed payload parsing', () => {
  const rawBody = Buffer.from('{not json', 'utf8');
  assert.throws(() => verifyZernioAccountWebhook(credential(), {
    rawBody,
    signatureHeader: '0'.repeat(64),
    eventIdHeader: IDS.event,
  }), /signature is invalid/u);
});

test('event header, profile and network must match the reviewed binding', () => {
  const cases = [
    signed(payload(), '44444444-4444-4444-8444-444444444444'),
    signed(payload({ account: { ...payload().account, profileId: 'profile_other' } })),
    signed(payload({ account: { ...payload().account, platform: 'twitter' } })),
  ];
  for (const input of cases) {
    assert.throws(() => verifyZernioAccountWebhook(credential(), input),
      PublicSocialOutboundContractError);
  }
});

test('connected and disconnected receipts are deterministic and distinct', () => {
  const connected = verifyZernioAccountWebhook(credential(), signed(payload()));
  const disconnectedInput = signed(payload({
    event: 'account.disconnected',
    account: {
      ...payload().account,
      disconnectionType: 'unintentional',
      reason: 'Token expired or was revoked',
    },
  }));
  const disconnected = verifyZernioAccountWebhook(credential(), disconnectedInput);
  const replay = verifyZernioAccountWebhook(credential(), disconnectedInput);
  assert.equal(disconnected.event, 'account.disconnected');
  assert.deepEqual(disconnected, replay);
  assert.notEqual(connected.receiptSha256, disconnected.receiptSha256);
});

test('unsupported fields, events, disconnect types and noncanonical times fail closed', () => {
  const cases = [
    payload({ surprise: true }),
    payload({ event: 'post.published' }),
    payload({ timestamp: '2026-08-31 15:00:00' }),
    payload({
      event: 'account.disconnected',
      account: { ...payload().account, disconnectionType: 'maybe' },
    }),
    payload({
      event: 'account.disconnected',
      account: { ...payload().account, disconnectionType: 'intentional', reason: 123 },
    }),
    payload({ account: { ...payload().account, secret: 'must-not-pass' } }),
  ];
  for (const value of cases) {
    assert.throws(() => verifyZernioAccountWebhook(credential(), signed(value)),
      PublicSocialOutboundContractError);
  }
});

test('invalid UTF-8 and oversized bodies fail after authentic raw-byte verification', () => {
  for (const rawBody of [
    Buffer.from([0xc3, 0x28]),
    Buffer.alloc(ZERNIO_ACCOUNT_WEBHOOK_MAXIMUM_BYTES + 1, 0x61),
  ]) {
    const signatureHeader = createHmac('sha256', SECRET).update(rawBody).digest('hex');
    assert.throws(() => verifyZernioAccountWebhook(credential(), {
      rawBody, signatureHeader, eventIdHeader: IDS.event,
    }), PublicSocialOutboundContractError);
  }
});

test('raw bytes are copied without consulting an overridable byteLength property', () => {
  const input = signed(payload());
  let byteLengthReads = 0;
  Object.defineProperty(input.rawBody, 'byteLength', {
    configurable: true,
    get() {
      byteLengthReads += 1;
      throw new Error('must not execute');
    },
  });
  const result = verifyZernioAccountWebhook(credential(), input);
  assert.equal(result.event, 'account.connected');
  assert.equal(byteLengthReads, 0);
});
