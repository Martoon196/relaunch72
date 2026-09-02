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
const ABUSE_SECRET = 'abuse-secret-that-must-never-escape-12345678';
const MAILGUN_DOMAIN_SENDING_KEY = 'mailgun-domain-key-that-must-never-escape';
const MAILGUN_SIGNING_KEY = 'mailgun-signing-key-that-must-never-escape';
const ZERNIO_API_KEY = `sk_${'a'.repeat(64)}`;
const MEDIA_SIGNING_KEY = Buffer.alloc(32, 7).toString('base64url');

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
    PORTAL_PROXY_MODE: 'render',
    PORTAL_ABUSE_HASH_SECRET: ABUSE_SECRET,
    DATABASE_SSL_MODE: 'verify-full',
    DATABASE_WEB_URL: databaseUrl('r72_web'),
    DATABASE_IDENTITY_COMMAND_URL: databaseUrl('r72_identity_command'),
    DATABASE_CRM_COMMAND_URL: databaseUrl('r72_crm_command'),
    DATABASE_ABUSE_COMMAND_URL: databaseUrl('r72_abuse_command'),
    DATABASE_CONTENT_COMMAND_URL: databaseUrl('r72_content_command'),
    DATABASE_CONTENT_ADAPTER_URL: databaseUrl('r72_content_adapter'),
    DATABASE_WORKER_URL: databaseUrl('r72_worker'),
    DATABASE_WEBHOOK_URL: databaseUrl('r72_webhook'),
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: '7b4a838f-9b3b-4f6b-a879-3459aa3771ae',
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: '8a4a838f-9b3b-4f6b-a879-3459aa3771ae',
    PROPERTY_PREDATOR_PILOT_STAGE: 'internal-seed',
    PROPERTY_PREDATOR_PILOT_RECIPIENT_SCOPE: 'owned-internal-seeds-only',
    PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS: '10',
    DATABASE_CUSTOMER_EMAIL_COMMAND_URL: databaseUrl('r72_customer_email_command'),
    DATABASE_CUSTOMER_EMAIL_WORKER_URL: databaseUrl('r72_customer_email_worker_command'),
    DATABASE_CUSTOMER_EMAIL_WEBHOOK_URL: databaseUrl('r72_customer_email_webhook_command'),
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_MODE: 'customer_live',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_PROVIDER_ID: 'mailgun_eu',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_DELIVERY_ENABLED: 'true',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_ENABLED: 'true',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_CONFIRMED: 'true',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_WORKSPACE_ID: '8a4a838f-9b3b-4f6b-a879-3459aa3771ae',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_CONNECTION_ID: '6a4a838f-9b3b-4f6b-a879-3459aa3771ae',
    MAILGUN_SIGNING_KEY,
    MAILGUN_REGION: 'eu',
    MAILGUN_SENDING_DOMAIN: 'mg.propertypredator.com',
    MAILGUN_KEY_SCOPE: 'domain-sending',
    MAILGUN_DOMAIN_SENDING_KEY,
    MAILGUN_FROM_EMAIL: 'growth@mg.propertypredator.com',
    MAILGUN_EVENT_WEBHOOK_URL: 'https://app.propertypredator.co.uk/webhooks/mailgun/events',
    PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED: 'true',
    MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED: 'true',
    MAILGUN_DNS_VERIFIED: 'true',
    MAILGUN_SUPPRESSION_SYNC_ENABLED: 'true',
    DATABASE_ZERNIO_SOCIAL_COMMAND_URL: databaseUrl('r72_zernio_social_command'),
    DATABASE_OWNED_SOCIAL_WORKER_URL: databaseUrl('r72_owned_social_worker_command'),
    PROPERTY_PREDATOR_SOCIAL_PROVIDER: 'zernio',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'zernio_live',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID: 'zernio',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK: 'instagram_linkedin',
    PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_WORKSPACE_ID: '8a4a838f-9b3b-4f6b-a879-3459aa3771ae',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID: '5a4a838f-9b3b-4f6b-a879-3459aa3771ae',
    PROPERTY_PREDATOR_ZERNIO_INSTAGRAM_ACCOUNT_ID: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    PROPERTY_PREDATOR_ZERNIO_LINKEDIN_ACCOUNT_ID: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    ZERNIO_API_KEY,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_ORIGIN: 'https://hq.propertypredator.com',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_SIGNING_KEY_BASE64URL: MEDIA_SIGNING_KEY,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_URL_TTL_SECONDS: '900',
  };
}

test('the mandatory email and owned-social configuration can pass while later rails remain deferred', () => {
  const report = runPropertyPredatorPilotPreflight(firstChannelEnvironment());

  assert.equal(report.result, 'ready-for-activation-review');
  assert.equal(report.liveEffectsVerified, false);
  assert.equal(report.networkCallsMade, false);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.providers[0]?.rail, 'customer_email');
  assert.equal(report.providers[0]?.phase, 'mandatory-first-channel');
  assert.equal(report.providers[0]?.status, 'configuration-ready');
  assert.equal(report.providers.find((provider) => provider.rail === 'owned_social')?.phase, 'mandatory-first-channel');
  assert.equal(report.providers.find((provider) => provider.rail === 'owned_social')?.status, 'configuration-ready');
  assert.ok(report.providers.filter((provider) => ['whatsapp', 'sms', 'social_dm'].includes(provider.rail))
    .every((provider) => provider.phase === 'deferred'));
  assert.ok(report.providers.filter((provider) => ['whatsapp', 'sms'].includes(provider.rail))
    .every((provider) => provider.status === 'not-configured'));
  assert.equal(report.providers.at(-1)?.status, 'not-composed');
});

test('missing production foundation and Mailgun settings fail closed by name', () => {
  const report = runPropertyPredatorPilotPreflight({});

  assert.equal(report.result, 'blocked');
  assert.ok(report.blockers.some((blocker) => blocker.includes('Production runtime mode')));
  assert.ok(report.blockers.some((blocker) => blocker.includes('Mailgun domain-sending key')));
  assert.ok(report.manualProofGates.some((gate) => gate.includes('durable pre-call pause/effects fences')));
  assert.ok(report.manualProofGates.some((gate) => gate.includes('owned test email')));
  assert.ok(report.manualProofGates.some((gate) => gate.includes('must never share a process')));
  assert.equal(report.providers.find((provider) => provider.rail === 'whatsapp')?.status, 'not-configured');
  assert.ok(report.blockers.some((blocker) => /Zernio/.test(blocker)));
  assert.ok(report.blockers.every((blocker) => !/Meta WhatsApp|Ayrshare/.test(blocker)));
});

test('unsafe cutover shapes stay blocked even when all first-channel credentials exist', () => {
  const env = firstChannelEnvironment();
  env.DATABASE_WEB_URL = databaseUrl('neondb_owner');
  env.DATABASE_CONTENT_ADAPTER_URL = databaseUrl('r72_content_command');
  env.DATABASE_ABUSE_COMMAND_URL = databaseUrl('r72_web');
  env.DATABASE_SSL_MODE = 'require';
  env.PORTAL_PROXY_MODE = 'direct';
  env.PORTAL_ABUSE_HASH_SECRET = SESSION_SECRET;
  env.PORTAL_BASE_URL = 'https://user:password@app.propertypredator.co.uk';
  env.PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS = '5000';

  const report = runPropertyPredatorPilotPreflight(env);
  assert.equal(report.result, 'blocked');
  for (const settingName of [
    'DATABASE_WEB_URL',
    'DATABASE_CONTENT_ADAPTER_URL',
    'DATABASE_ABUSE_COMMAND_URL',
    'DATABASE_SSL_MODE',
    'PORTAL_PROXY_MODE',
    'PORTAL_ABUSE_HASH_SECRET',
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

  for (const secret of [
    DB_PASSWORD, SESSION_SECRET, ABUSE_SECRET, MAILGUN_DOMAIN_SENDING_KEY,
    MAILGUN_SIGNING_KEY, ZERNIO_API_KEY,
  ]) {
    assert.doesNotMatch(serializedEvidence, new RegExp(secret));
    assert.doesNotMatch(serializedReport, new RegExp(secret));
    assert.doesNotMatch(rendered, new RegExp(secret));
  }
  assert.doesNotMatch(serializedEvidence, /app\.propertypredator\.co\.uk/);
  assert.doesNotMatch(serializedReport, /growth@mg\.propertypredator\.com/);
  assert.match(rendered, /MAILGUN_SIGNING_KEY — Mailgun webhook signing key/);
  assert.match(rendered, /no database or provider connection was attempted/i);
});

test('partially prepared deferred rails are visible but cannot block the Mailgun review gate', () => {
  const env = firstChannelEnvironment();
  env.PROPERTY_PREDATOR_WHATSAPP_LIVE_PROVIDER_ID = 'meta_whatsapp_cloud';
  env.PROPERTY_PREDATOR_META_WHATSAPP_WABA_ID = '1234567890';
  env.PROPERTY_PREDATOR_SMS_PROVIDER_ID = 'twilio_messaging';

  const report = runPropertyPredatorPilotPreflight(env);
  const whatsapp = report.providers.find((provider) => provider.rail === 'whatsapp');
  const sms = report.providers.find((provider) => provider.rail === 'sms');
  assert.equal(report.result, 'ready-for-activation-review');
  assert.equal(whatsapp?.status, 'incomplete');
  assert.ok(whatsapp?.checks.every((check) => check.blocking === false));
  assert.equal(sms?.status, 'incomplete');
  assert.ok(sms?.checks.every((check) => check.blocking === false));
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
      { rail: 'customer_email', provider: 'Mailgun EU customer email', phase: 'mandatory-first-channel' },
      { rail: 'whatsapp', provider: 'Meta WhatsApp Cloud', phase: 'deferred' },
      { rail: 'owned_social', provider: 'Zernio Instagram + LinkedIn', phase: 'mandatory-first-channel' },
      { rail: 'sms', provider: 'Twilio Messaging UK SMS', phase: 'deferred' },
      { rail: 'social_dm', provider: 'Meta Facebook and Instagram DMs', phase: 'deferred' },
    ],
  );
  const settings = PILOT_PROVIDER_CATALOGUE.flatMap((provider) => provider.settings.map((item) => item.setting));
  for (const stale of ['MAILGUN_API_KEY', 'DIALOG360_API_KEY', 'TWILIO_ACCOUNT_SID', 'AYRSHARE_PROFILE_KEY']) {
    assert.equal(settings.includes(stale), false);
  }
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
