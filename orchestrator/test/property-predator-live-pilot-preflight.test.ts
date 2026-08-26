import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PILOT_PROVIDER_CATALOGUE,
  evaluatePropertyPredatorPilotPreflight,
  formatPropertyPredatorPilotPreflight,
  runPropertyPredatorPilotPreflight,
  sanitizePropertyPredatorPilotEnvironment,
} from '../src/ops/property-predator-live-pilot-preflight.js';

const DB_PASSWORD = 'database-password-that-must-never-escape';
const SESSION_SECRET = 'session-secret-that-must-never-escape-123456';
const MAILGUN_API_KEY = 'mailgun-api-key-that-must-never-escape';
const MAILGUN_SIGNING_KEY = 'mailgun-signing-key-that-must-never-escape';

function databaseUrl(user: string): string {
  return `postgresql://${user}:${DB_PASSWORD}@pilot-db.example/property_predator?sslmode=verify-full`;
}

function firstChannelEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    PORTAL_POSTGRES_ENABLED: 'true',
    PORTAL_PRODUCT_PROFILE: 'property_predator_growth',
    PORTAL_BASE_URL: 'https://app.propertypredator.co.uk',
    PUBLIC_BASE_URL: 'https://propertypredator.co.uk',
    SESSION_SECRET,
    DATABASE_SSL_MODE: 'verify-full',
    DATABASE_WEB_URL: databaseUrl('r72_web'),
    DATABASE_IDENTITY_COMMAND_URL: databaseUrl('r72_identity_command'),
    DATABASE_CRM_COMMAND_URL: databaseUrl('r72_crm_command'),
    DATABASE_CONTENT_COMMAND_URL: databaseUrl('r72_content_command'),
    DATABASE_WORKER_URL: databaseUrl('r72_worker'),
    DATABASE_WEBHOOK_URL: databaseUrl('r72_webhook'),
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: '8a4a838f-9b3b-4f6b-a879-3459aa3771ae',
    PROPERTY_PREDATOR_PILOT_STAGE: 'internal-seed',
    PROPERTY_PREDATOR_PILOT_RECIPIENT_SCOPE: 'owned-internal-seeds-only',
    PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS: '10',
    PROPERTY_PREDATOR_EMAIL_PROVIDER: 'mailgun',
    MAILGUN_API_KEY,
    MAILGUN_SIGNING_KEY,
    MAILGUN_REGION: 'eu',
    MAILGUN_SENDING_DOMAIN: 'mail.propertypredator.co.uk',
    MAILGUN_FROM_EMAIL: 'growth@mail.propertypredator.co.uk',
    MAILGUN_EVENT_WEBHOOK_URL: 'https://app.propertypredator.co.uk/webhooks/mailgun/events',
    MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED: 'true',
    MAILGUN_DNS_VERIFIED: 'true',
    MAILGUN_SUPPRESSION_SYNC_ENABLED: 'true',
  };
}

test('the mandatory first-channel configuration can pass while every later rail remains deferred', () => {
  const report = runPropertyPredatorPilotPreflight(firstChannelEnvironment());

  assert.equal(report.result, 'ready-for-activation-review');
  assert.equal(report.liveEffectsVerified, false);
  assert.equal(report.networkCallsMade, false);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.providers[0]?.rail, 'email');
  assert.equal(report.providers[0]?.phase, 'mandatory-first-channel');
  assert.equal(report.providers[0]?.status, 'configuration-ready');
  assert.ok(report.providers.slice(1).every((provider) => provider.phase === 'deferred'));
  assert.ok(report.providers.slice(1).every((provider) => provider.status === 'not-configured'));
});

test('missing production foundation and Mailgun settings fail closed by name', () => {
  const report = runPropertyPredatorPilotPreflight({});

  assert.equal(report.result, 'blocked');
  assert.ok(report.blockers.some((blocker) => blocker.includes('Production runtime mode')));
  assert.ok(report.blockers.some((blocker) => blocker.includes('Mailgun API key')));
  assert.ok(report.manualProofGates.some((gate) => gate.includes('runtime-enforced provider-effect kill switch')));
  assert.ok(report.manualProofGates.some((gate) => gate.includes('declared maximum recipient count')));
  assert.equal(report.providers.find((provider) => provider.rail === 'whatsapp')?.status, 'not-configured');
  assert.ok(report.blockers.every((blocker) => !/360dialog|Twilio|Ayrshare|Whereby|Nylas/.test(blocker)));
});

test('unsafe cutover shapes stay blocked even when all first-channel credentials exist', () => {
  const env = firstChannelEnvironment();
  env.DATABASE_WEB_URL = databaseUrl('neondb_owner');
  env.DATABASE_SSL_MODE = 'require';
  env.PORTAL_BASE_URL = 'https://user:password@app.propertypredator.co.uk';
  env.PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS = '5000';

  const report = runPropertyPredatorPilotPreflight(env);
  assert.equal(report.result, 'blocked');
  for (const settingName of [
    'DATABASE_WEB_URL',
    'DATABASE_SSL_MODE',
    'PORTAL_BASE_URL',
    'PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS',
  ]) {
    assert.equal(report.foundation.find((check) => check.setting === settingName)?.state, 'invalid');
  }
});

test('raw secrets and URLs are destroyed at the sanitizer boundary and never rendered', () => {
  const env = firstChannelEnvironment();
  const evidence = sanitizePropertyPredatorPilotEnvironment(env);
  const report = evaluatePropertyPredatorPilotPreflight(evidence);
  const serializedEvidence = JSON.stringify(evidence);
  const serializedReport = JSON.stringify(report);
  const rendered = formatPropertyPredatorPilotPreflight(report);

  for (const secret of [DB_PASSWORD, SESSION_SECRET, MAILGUN_API_KEY, MAILGUN_SIGNING_KEY]) {
    assert.doesNotMatch(serializedEvidence, new RegExp(secret));
    assert.doesNotMatch(serializedReport, new RegExp(secret));
    assert.doesNotMatch(rendered, new RegExp(secret));
  }
  assert.doesNotMatch(serializedEvidence, /app\.propertypredator\.co\.uk/);
  assert.doesNotMatch(serializedReport, /growth@mail\.propertypredator\.co\.uk/);
  assert.match(rendered, /MAILGUN_SIGNING_KEY — Mailgun webhook signing key/);
  assert.match(rendered, /no database or provider connection was attempted/i);
});

test('partially prepared deferred rails are visible but cannot block the Mailgun review gate', () => {
  const env = firstChannelEnvironment();
  env.PROPERTY_PREDATOR_WHATSAPP_PROVIDER = '360dialog';
  env.DIALOG360_WABA_ID = 'waba-ready-later';

  const report = runPropertyPredatorPilotPreflight(env);
  const whatsapp = report.providers.find((provider) => provider.rail === 'whatsapp');
  assert.equal(report.result, 'ready-for-activation-review');
  assert.equal(whatsapp?.status, 'incomplete');
  assert.ok(whatsapp?.checks.every((check) => check.blocking === false));
});

test('callback metadata rejects embedded credentials, query tokens and non-HTTPS URLs', () => {
  for (const unsafeUrl of [
    'http://app.propertypredator.co.uk/webhooks/mailgun',
    'https://operator:secret@app.propertypredator.co.uk/webhooks/mailgun',
    'https://app.propertypredator.co.uk/webhooks/mailgun?token=secret',
    'https://app.propertypredator.co.uk/webhooks/mailgun#secret',
  ]) {
    const env = firstChannelEnvironment();
    env.MAILGUN_EVENT_WEBHOOK_URL = unsafeUrl;
    const report = runPropertyPredatorPilotPreflight(env);
    assert.equal(report.result, 'blocked');
    assert.equal(
      report.providers[0]?.checks.find((check) => check.setting === 'MAILGUN_EVENT_WEBHOOK_URL')?.state,
      'invalid',
    );
  }
});

test('the agreed provider catalogue is exact and keeps social listening outside the first pilot', () => {
  assert.deepEqual(
    PILOT_PROVIDER_CATALOGUE.map(({ rail, provider, phase }) => ({ rail, provider, phase })),
    [
      { rail: 'email', provider: 'Mailgun Basic', phase: 'mandatory-first-channel' },
      { rail: 'whatsapp', provider: '360dialog Regular', phase: 'deferred' },
      { rail: 'sms', provider: 'Twilio UK SMS', phase: 'deferred' },
      { rail: 'social', provider: 'Ayrshare Launch', phase: 'deferred' },
      { rail: 'webinar', provider: 'Whereby Embedded Build', phase: 'deferred' },
      { rail: 'calendar', provider: 'Nylas Calendar/Scheduler', phase: 'deferred' },
    ],
  );
});

test('the preflight implementation has no network, provider SDK or database client path', () => {
  const source = readFileSync(
    new URL('../src/ops/property-predator-live-pilot-preflight.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /\bfetch\s*\(|https?\.request\s*\(|createDatabasePool|from ['"]pg['"]/);
  assert.doesNotMatch(
    source,
    /from\s+['"][^'"]*(?:mailgun|twilio|ayrshare|whereby|nylas|360dialog)/i,
    'provider SDKs must not appear in executable imports',
  );
});
