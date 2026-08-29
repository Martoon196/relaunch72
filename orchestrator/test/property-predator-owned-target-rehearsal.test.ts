import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  evaluateOwnedTargetRehearsal,
  formatOwnedTargetRehearsal,
  runOwnedTargetRehearsal,
  sanitizeOwnedTargetRehearsalEnvironment,
} from '../src/ops/property-predator-owned-target-rehearsal.js';

const UUIDS = {
  workspace: '11111111-1111-4111-8111-111111111111',
  operator: '22222222-2222-4222-8222-222222222222',
  person: '33333333-3333-4333-8333-333333333333',
  endpoint: '44444444-4444-4444-8444-444444444444',
  consent: '55555555-5555-4555-8555-555555555555',
  approval: '66666666-6666-4666-8666-666666666666',
} as const;

function completeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID: UUIDS.workspace,
    PROPERTY_PREDATOR_REHEARSAL_OPERATOR_USER_ID: UUIDS.operator,
    PROPERTY_PREDATOR_REHEARSAL_EMAIL_RECIPIENT: 'office@propertypredator.com',
    PROPERTY_PREDATOR_REHEARSAL_EMAIL_MESSAGE_SHA256: 'a'.repeat(64),
    PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT: '+447700900001',
    PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED: 'true',
    PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_NAME: 'property_predator_owned_test',
    PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_SHA256: 'b'.repeat(64),
    PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_PARAMETER_COUNT: '0',
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_NETWORK: 'x',
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_URL: 'https://x.com/OwnedProfile',
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED: 'true',
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_POST_SHA256: 'c'.repeat(64),
    PROPERTY_PREDATOR_REHEARSAL_SOCIAL_APPROVAL_ID: UUIDS.approval,
    PROPERTY_PREDATOR_REHEARSAL_SMS_RECIPIENT: '+447700900001',
    PROPERTY_PREDATOR_REHEARSAL_SMS_RECIPIENT_OWNED: 'true',
    PROPERTY_PREDATOR_REHEARSAL_SMS_MESSAGE_SHA256: 'd'.repeat(64),
  };
  for (const prefix of ['EMAIL', 'WHATSAPP', 'SMS']) {
    env[`PROPERTY_PREDATOR_REHEARSAL_${prefix}_PERSON_ID`] = UUIDS.person;
    env[`PROPERTY_PREDATOR_REHEARSAL_${prefix}_ENDPOINT_ID`] = UUIDS.endpoint;
    env[`PROPERTY_PREDATOR_REHEARSAL_${prefix}_CONSENT_EVIDENCE_ID`] = UUIDS.consent;
    env[`PROPERTY_PREDATOR_REHEARSAL_${prefix}_SUPPRESSION_CLEAR`] = 'true';
    env[`PROPERTY_PREDATOR_REHEARSAL_${prefix}_APPROVAL_ID`] = UUIDS.approval;
  }
  return env;
}

test('one redacted pack proves every composed rail and keeps social DMs unavailable', () => {
  const report = runOwnedTargetRehearsal(completeEnvironment());
  assert.equal(report.result, 'ready-for-composed-rail-rehearsal');
  assert.equal(report.providerEffects, false);
  assert.equal(report.networkCallsMade, false);
  assert.equal(report.databaseCallsMade, false);
  assert.equal(report.customerDataAccessed, false);
  assert.ok(report.rails.slice(0, 4).every((rail) => rail.status === 'ready-for-command-rehearsal'));
  assert.deepEqual(report.rails.at(-1), { rail: 'social_dm', status: 'not-composed', checks: [] });
});

test('wrong recipients, mutable templates and missing evidence fail closed by setting name', () => {
  const env = completeEnvironment();
  env.PROPERTY_PREDATOR_REHEARSAL_EMAIL_RECIPIENT = 'customer@example.com';
  env.PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_PARAMETER_COUNT = '1';
  delete env.PROPERTY_PREDATOR_REHEARSAL_SMS_CONSENT_EVIDENCE_ID;
  const report = runOwnedTargetRehearsal(env);
  assert.equal(report.result, 'blocked');
  assert.ok(report.blockers.some((item) => item.startsWith('PROPERTY_PREDATOR_REHEARSAL_EMAIL_RECIPIENT: invalid')));
  assert.ok(report.blockers.some((item) => item.startsWith('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_PARAMETER_COUNT: invalid')));
  assert.ok(report.blockers.some((item) => item.startsWith('PROPERTY_PREDATOR_REHEARSAL_SMS_CONSENT_EVIDENCE_ID: missing')));
});

test('raw addresses and identifiers do not survive sanitization or formatting', () => {
  const env = completeEnvironment();
  const evidence = sanitizeOwnedTargetRehearsalEnvironment(env);
  const report = evaluateOwnedTargetRehearsal(evidence);
  const output = `${JSON.stringify(evidence)}\n${JSON.stringify(report)}\n${formatOwnedTargetRehearsal(report)}`;
  for (const raw of ['office@propertypredator.com', '+447700900001', 'https://x.com/OwnedProfile', UUIDS.workspace]) {
    assert.doesNotMatch(output, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('the rehearsal implementation cannot enqueue, query a database or call a provider', () => {
  const source = readFileSync(
    new URL('../src/ops/property-predator-owned-target-rehearsal.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /\bfetch\s*\(|createDatabasePool|from ['"]pg['"]|\benqueue[A-Z_a-z]*\s*\(|authorize_and_enqueue/u);
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:mailgun|twilio|ayrshare|meta)/iu);
});
