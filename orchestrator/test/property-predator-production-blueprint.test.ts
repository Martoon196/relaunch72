import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(repositoryRoot, 'render.property-predator.production.yaml');
const manifest = fs.readFileSync(manifestPath, 'utf8').replace(/\r\n?/g, '\n');

function serviceSection(type: 'web' | 'worker', name: string): string {
  const marker = `\n  - type: ${type}\n    name: ${name}\n`;
  const start = manifest.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist in the production Blueprint`);
  const end = manifest.indexOf('\n  - type: ', start + marker.length);
  return manifest.slice(start + 1, end === -1 ? manifest.length : end);
}

const webManifest = serviceSection('web', 'property-predator-growth-hq');
const emailWorkerManifest = serviceSection('worker', 'property-predator-email-worker');
const revalidatorWorkerManifest = serviceSection(
  'worker', 'property-predator-public-social-revalidator',
);
const socialTestWorkerManifest = serviceSection(
  'worker', 'property-predator-public-social-test-rail',
);
const ownedSocialLiveWorkerManifest = serviceSection(
  'worker', 'property-predator-owned-public-social-live',
);
const whatsAppLiveWorkerManifest = serviceSection(
  'worker', 'property-predator-meta-whatsapp-live-worker',
);
const whatsAppLiveWebhookManifest = serviceSection(
  'web', 'property-predator-meta-whatsapp-live-webhook',
);
const customerEmailLiveWorkerManifest = serviceSection(
  'worker', 'property-predator-customer-email-live',
);
const smsLiveWorkerManifest = serviceSection(
  'worker', 'property-predator-twilio-sms-live',
);
const smsLiveWebhookManifest = serviceSection(
  'web', 'property-predator-twilio-sms-live-webhook',
);
const workerManifests = [
  emailWorkerManifest, revalidatorWorkerManifest, socialTestWorkerManifest,
  ownedSocialLiveWorkerManifest, whatsAppLiveWorkerManifest,
  customerEmailLiveWorkerManifest, smsLiveWorkerManifest,
] as const;

function literalValue(key: string, value: string): void {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    manifest,
    new RegExp(`- key: ${escapedKey}\\r?\\n\\s+value: ["']?${escapedValue}["']?(?:\\r?\\n|$)`),
    `${key} must remain ${value}`,
  );
}

function secretSlot(key: string): void {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    manifest,
    new RegExp(`- key: ${escapedKey}\\r?\\n\\s+sync: false(?:\\r?\\n|$)`),
    `${key} must be a value-less Render secret slot`,
  );
}

function secretSlotIn(section: string, key: string): void {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    section,
    new RegExp(`- key: ${escapedKey}\\r?\\n\\s+sync: false(?:\\r?\\n|$)`),
    `${key} must be a value-less Render secret slot in its isolated service`,
  );
  assert.doesNotMatch(
    section,
    new RegExp(`- key: ${escapedKey}\\r?\\n\\s+value:`),
  );
}

function dashboardControlledSlot(key: string): void {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    webManifest,
    new RegExp(`- key: ${escapedKey}\\r?\\n\\s+sync: false(?:\\r?\\n|$)`),
    `${key} must remain dashboard-controlled so Blueprint syncs preserve the operator value`,
  );
  assert.doesNotMatch(
    webManifest,
    new RegExp(`- key: ${escapedKey}\\r?\\n\\s+value:`),
    `${key} must not regain a Blueprint-owned literal value`,
  );
}

function literalValueIn(section: string, key: string, value: string): void {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    section,
    new RegExp(`- key: ${escapedKey}\\r?\\n\\s+value: ["']?${escapedValue}["']?(?:\\r?\\n|$)`),
    `${key} must remain ${value} in each isolated service`,
  );
}

function databaseUrlKeys(section: string): string[] {
  return [...section.matchAll(/- key: (DATABASE_[A-Z0-9_]+_URL)\b/g)]
    .map((match) => match[1]!)
    .sort();
}

test('production Blueprint is isolated, manually deployed and narrowly fail-closed', () => {
  assert.match(manifest, /name: property-predator-growth-hq/);
  assert.match(manifest, /region: frankfurt/);
  assert.match(manifest, /plan: starter/);
  assert.match(manifest, /branch: codex\/relaunch72-platform-foundation/);
  assert.match(manifest, /numInstances: 1/);
  assert.match(manifest, /autoDeployTrigger: off/);
  assert.match(manifest, /healthCheckPath: \/ready/);
  assert.match(manifest, /renderSubdomainPolicy: disabled/);
  assert.match(manifest, /- hq\.propertypredator\.com/);
  assert.doesNotMatch(manifest, /propertypredator\.co\.uk/);
  assert.equal(
    (manifest.match(/buildCommand: npm ci --ignore-scripts --include=dev && node scripts\/supply-chain\.mjs --check && npm run typecheck && npm test/g) ?? []).length,
    10,
    'all ten isolated production processes must install the locked checked toolchain',
  );
  assert.match(manifest, /startCommand: npm run serve/);
  assert.match(emailWorkerManifest, /name: property-predator-email-worker/);
  assert.match(emailWorkerManifest, /plan: starter/);
  assert.match(emailWorkerManifest, /region: frankfurt/);
  assert.match(emailWorkerManifest, /autoDeployTrigger: off/);
  assert.match(
    emailWorkerManifest,
    /startCommand: npm run --workspace orchestrator serve:property-predator-email-worker/,
  );
  assert.match(
    revalidatorWorkerManifest,
    /startCommand: npm run --workspace orchestrator serve:public-social-revalidator/,
  );
  assert.match(
    socialTestWorkerManifest,
    /startCommand: npm run --workspace orchestrator serve:public-social-test-rail/,
  );
  assert.match(
    ownedSocialLiveWorkerManifest,
    /startCommand: npm run --workspace orchestrator serve:zernio-calendar-live/,
  );
  assert.match(whatsAppLiveWorkerManifest,
    /startCommand: npm run --workspace orchestrator serve:meta-whatsapp-live-worker/);
  assert.match(whatsAppLiveWebhookManifest,
    /startCommand: npm run --workspace orchestrator serve:meta-whatsapp-live-webhook/);
  assert.match(customerEmailLiveWorkerManifest,
    /startCommand: npm run --workspace orchestrator serve:customer-email-live/);
  assert.match(smsLiveWorkerManifest,
    /startCommand: npm run --workspace orchestrator serve:twilio-sms-live(?:\r?\n|$)/);
  assert.match(smsLiveWebhookManifest,
    /startCommand: npm run --workspace orchestrator serve:twilio-sms-live-webhook/);

  literalValue('PORTAL_POSTGRES_ENABLED', 'true');
  literalValue('PORTAL_PRODUCT_PROFILE', 'property_predator_growth');
  literalValue('PORTAL_BASE_URL', 'https://hq.propertypredator.com');
  literalValue('PUBLIC_BASE_URL', 'https://propertypredator.com');
  literalValue('PORTAL_PROXY_MODE', 'render');
  assert.match(
    webManifest,
    /- key: PORTAL_ABUSE_HASH_SECRET\r?\n\s+generateValue: true/,
    'the abuse HMAC secret must be generated independently in the web service',
  );
  secretSlot('ADMIN_PASSWORD');
  secretSlot('ADMIN_TOTP_SECRET');
  dashboardControlledSlot('ADMIN_SESSION_EPOCH');
  literalValue(
    'ALLOWED_ORIGINS',
    'https://hq.propertypredator.com,https://propertypredator.com,https://www.propertypredator.com',
  );
  literalValue('PLATFORM_SUBSCRIPTIONS_ENABLED', 'false');
  literalValue('PUBLIC_LEAD_CAPTURE_ENABLED', 'false');
  literalValue('PORTAL_DEMO_SEED', 'false');
  dashboardControlledSlot('PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED');
  // The receiver's dedicated source key is operator-owned. A Blueprint value
  // for any of these would either overwrite a bound production key on the next
  // sync or commit a secret to the repository.
  dashboardControlledSlot('PROPERTY_PREDATOR_EXTERNAL_EVENTS_KEY_ID');
  dashboardControlledSlot('PROPERTY_PREDATOR_EXTERNAL_EVENTS_WORKSPACE_ID');
  dashboardControlledSlot('PROPERTY_PREDATOR_EXTERNAL_EVENTS_HMAC_SECRET_BASE64URL');
  dashboardControlledSlot('PROPERTY_PREDATOR_EXTERNAL_EVENTS_TRUSTED_PROXY_ADDRESSES');
  dashboardControlledSlot('DATABASE_EXTERNAL_EVENT_COMMAND_URL');
  dashboardControlledSlot('DATABASE_WEBHOOK_URL');
  dashboardControlledSlot('PROPERTY_PREDATOR_SSO_ENABLED');
  literalValue('PROPERTY_PREDATOR_SSO_ISSUER', 'https://propertypredator.com');
  literalValue('PROPERTY_PREDATOR_SSO_AUTHORIZE_URL', 'https://propertypredator.com/sso.html');
  literalValue('PROPERTY_PREDATOR_SSO_TOKEN_URL', 'https://propertypredator.com/api/auth/sso/token');
  literalValue(
    'PROPERTY_PREDATOR_SSO_REDIRECT_URI',
    'https://hq.propertypredator.com/portal/auth/property-predator/callback',
  );
  for (const key of [
    'PROPERTY_PREDATOR_SSO_CLIENT_ID',
    'PROPERTY_PREDATOR_SSO_CLIENT_SECRET',
    'PROPERTY_PREDATOR_SSO_BOOTSTRAP_USER_ID',
    'PROPERTY_PREDATOR_SSO_BOOTSTRAP_EMAILS',
  ]) secretSlot(key);
  for (const key of [
    'PROPERTY_PREDATOR_SSO_ENABLED',
    'PROPERTY_PREDATOR_SSO_ISSUER',
    'PROPERTY_PREDATOR_SSO_AUTHORIZE_URL',
    'PROPERTY_PREDATOR_SSO_TOKEN_URL',
    'PROPERTY_PREDATOR_SSO_CLIENT_ID',
    'PROPERTY_PREDATOR_SSO_CLIENT_SECRET',
    'PROPERTY_PREDATOR_SSO_REDIRECT_URI',
    'PROPERTY_PREDATOR_SSO_BOOTSTRAP_USER_ID',
    'PROPERTY_PREDATOR_SSO_BOOTSTRAP_EMAILS',
  ]) {
    for (const worker of workerManifests) {
      assert.doesNotMatch(worker, new RegExp(`- key: ${key}\\b`));
    }
  }
  literalValueIn(webManifest, 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'true');
  literalValueIn(webManifest, 'PROPERTY_PREDATOR_CAMPAIGN_GENERATION_ENABLED', 'true');
  literalValueIn(
    webManifest,
    'PROPERTY_PREDATOR_CAMPAIGN_GENERATION_PROVIDER_EFFECTS_ENABLED',
    'true',
  );
  literalValueIn(
    webManifest,
    'PROPERTY_PREDATOR_CAMPAIGN_GENERATION_EMERGENCY_PAUSED',
    'false',
  );
  secretSlotIn(webManifest, 'PROPERTY_PREDATOR_COMPANY_CONTENT_GENERATE_TOKEN');
  assert.equal(
    (manifest.match(/- key: PROPERTY_PREDATOR_COMPANY_CONTENT_GENERATE_TOKEN\b/g) ?? []).length,
    1,
    'the scoped generation credential must exist only in the Growth HQ web service',
  );
  for (const worker of workerManifests) {
    assert.doesNotMatch(
      worker,
      /- key: PROPERTY_PREDATOR_(?:CAMPAIGN_GENERATION_[A-Z0-9_]+|COMPANY_CONTENT_GENERATE_TOKEN)\b/,
    );
  }
  assert.doesNotMatch(
    manifest,
    /- key: PROPERTY_PREDATOR_CONTENT_(?:READ|SYNC)_CREDENTIAL_SHA256\b/,
    'credential separation hashes are derived from existing web-only secrets',
  );
  literalValueIn(webManifest, 'PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED', 'false');
  literalValueIn(webManifest, 'PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED', 'true');
  literalValueIn(emailWorkerManifest, 'PROPERTY_PREDATOR_EMAIL_WORKER_MODE', 'internal-seed-live');
  literalValueIn(emailWorkerManifest, 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'true');
  literalValueIn(emailWorkerManifest, 'PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED', 'true');
  literalValueIn(emailWorkerManifest, 'PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED', 'false');
  literalValueIn(customerEmailLiveWorkerManifest,
    'PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_MODE', 'disabled');
  literalValueIn(customerEmailLiveWorkerManifest,
    'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'false');
  literalValueIn(customerEmailLiveWorkerManifest,
    'PROPERTY_PREDATOR_CUSTOMER_EMAIL_DELIVERY_ENABLED', 'false');
  literalValueIn(customerEmailLiveWorkerManifest,
    'PROPERTY_PREDATOR_CUSTOMER_EMAIL_EMERGENCY_PAUSED', 'true');
  literalValueIn(customerEmailLiveWorkerManifest,
    'PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_CONFIRMED', 'false');
  literalValueIn(smsLiveWorkerManifest, 'PROPERTY_PREDATOR_SMS_LIVE_MODE', 'disabled');
  literalValueIn(smsLiveWorkerManifest, 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'false');
  literalValueIn(smsLiveWorkerManifest, 'PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED', 'false');
  literalValueIn(smsLiveWorkerManifest, 'PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED', 'true');
  literalValueIn(smsLiveWorkerManifest, 'PROPERTY_PREDATOR_SMS_RECEIPTS_CONFIRMED', 'false');
  literalValueIn(smsLiveWorkerManifest, 'PROPERTY_PREDATOR_SMS_PROVIDER_ID', 'twilio_messaging');
  literalValueIn(smsLiveWorkerManifest, 'TWILIO_KEY_SCOPE', 'restricted-api-key');
  literalValueIn(smsLiveWebhookManifest, 'PROPERTY_PREDATOR_SMS_WEBHOOK_MODE', 'disabled');
  literalValueIn(smsLiveWebhookManifest, 'PROPERTY_PREDATOR_SMS_PROVIDER_ID', 'twilio_messaging');
  literalValueIn(webManifest,
    'PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_ENABLED', 'false');
  literalValueIn(webManifest, 'PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED', 'false');
  literalValueIn(webManifest, 'PROPERTY_PREDATOR_SOCIAL_PROVIDER', 'zernio');
  secretSlotIn(webManifest, 'DATABASE_ZERNIO_SOCIAL_COMMAND_URL');
  secretSlotIn(webManifest, 'DATABASE_DAILY_OUTREACH_READ_URL');
  secretSlotIn(webManifest, 'DATABASE_DAILY_OUTREACH_COMMAND_URL');
  secretSlotIn(webManifest, 'DATABASE_ZERNIO_INBOUND_WEBHOOK_URL');
  secretSlotIn(webManifest, 'PROPERTY_PREDATOR_ZERNIO_LIVE_CONNECTION_ID');
  secretSlotIn(webManifest, 'PROPERTY_PREDATOR_ZERNIO_PROVIDER_PROFILE_ID');
  secretSlotIn(webManifest, 'PROPERTY_PREDATOR_ZERNIO_INSTAGRAM_ACCOUNT_ID');
  secretSlotIn(webManifest, 'PROPERTY_PREDATOR_ZERNIO_LINKEDIN_ACCOUNT_ID');
  secretSlotIn(webManifest, 'PROPERTY_PREDATOR_ZERNIO_MESSAGING_ACCOUNT_IDS');
  secretSlotIn(webManifest, 'PROPERTY_PREDATOR_ZERNIO_COMMENT_ACCOUNT_BINDINGS');
  secretSlotIn(webManifest, 'ZERNIO_API_KEY');
  literalValueIn(webManifest, 'PROPERTY_PREDATOR_DAILY_OUTREACH_PROGRAMME_KEY',
    'founder_daily_linkedin');
  literalValueIn(webManifest, 'PROPERTY_PREDATOR_ZERNIO_INBOUND_ENABLED', 'false');
  secretSlotIn(webManifest, 'PROPERTY_PREDATOR_ZERNIO_INBOUND_CONNECTION_ID');
  secretSlotIn(webManifest, 'PROPERTY_PREDATOR_ZERNIO_INBOUND_PROVIDER_PROFILE_ID');
  secretSlotIn(webManifest, 'ZERNIO_INBOUND_WEBHOOK_CREDENTIAL_VERSION');
  secretSlotIn(webManifest, 'ZERNIO_INBOUND_WEBHOOK_SECRET');
  for (const section of [revalidatorWorkerManifest, socialTestWorkerManifest]) {
    literalValueIn(section, 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'false');
    literalValueIn(section, 'PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED', 'true');
    assert.doesNotMatch(section, /- key: PROPERTY_PREDATOR_EMAIL_(?:DELIVERY_ENABLED|EMERGENCY_PAUSED)\b/);
  }
  literalValueIn(
    ownedSocialLiveWorkerManifest, 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'true',
  );
  literalValueIn(
    ownedSocialLiveWorkerManifest, 'PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED', 'false',
  );
  literalValueIn(
    ownedSocialLiveWorkerManifest, 'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE', 'zernio_live',
  );
  literalValueIn(
    ownedSocialLiveWorkerManifest, 'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID', 'zernio',
  );
  for (const section of [webManifest, emailWorkerManifest]) {
    literalValueIn(section, 'PROPERTY_PREDATOR_PILOT_STAGE', 'internal-seed');
    literalValueIn(section, 'PROPERTY_PREDATOR_PILOT_RECIPIENT_SCOPE', 'owned-internal-seeds-only');
  }
  literalValueIn(webManifest, 'PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS', '10');
  literalValueIn(emailWorkerManifest, 'PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS', '1');
  literalValueIn(emailWorkerManifest, 'PROPERTY_PREDATOR_EMAIL_RUN_MESSAGE_CAP', '1');
  literalValueIn(emailWorkerManifest, 'PROPERTY_PREDATOR_EMAIL_MONTHLY_MESSAGE_CAP', '3');
  literalValueIn(
    emailWorkerManifest,
    'PROPERTY_PREDATOR_EMAIL_ESTIMATED_RECIPIENT_COST_USD_MICROS',
    '1000',
  );
  literalValueIn(emailWorkerManifest, 'PROPERTY_PREDATOR_EMAIL_RUN_SPEND_CAP_USD_MICROS', '1000');
  literalValueIn(emailWorkerManifest, 'PROPERTY_PREDATOR_EMAIL_MONTHLY_SPEND_CAP_USD_MICROS', '3000');
});

test('production Blueprint keeps web and worker database identities process-isolated', () => {
  for (const key of [
    'DATABASE_WEB_URL',
    'DATABASE_IDENTITY_COMMAND_URL',
    'DATABASE_CRM_COMMAND_URL',
    'DATABASE_ABUSE_COMMAND_URL',
    'DATABASE_CONTENT_COMMAND_URL',
    'DATABASE_CONTENT_ADAPTER_URL',
    'DATABASE_EXTERNAL_EVENT_COMMAND_URL',
    'DATABASE_WEBHOOK_URL',
    'DATABASE_PUBLIC_SOCIAL_COMMAND_URL',
    'DATABASE_OWNED_SOCIAL_COMMAND_URL',
    'DATABASE_WHATSAPP_LIVE_COMMAND_URL',
    'DATABASE_CUSTOMER_EMAIL_COMMAND_URL',
    'DATABASE_SMS_COMMAND_URL',
    'DATABASE_MAILGUN_WEBHOOK_URL',
    'DATABASE_CUSTOMER_EMAIL_WEBHOOK_URL',
    'DATABASE_DAILY_OUTREACH_READ_URL',
    'DATABASE_DAILY_OUTREACH_COMMAND_URL',
    'DATABASE_ZERNIO_INBOUND_WEBHOOK_URL',
  ]) secretSlot(key);
  secretSlot('DATABASE_MAILGUN_WORKER_URL');
  secretSlot('DATABASE_PUBLIC_SOCIAL_REVALIDATOR_URL');
  secretSlot('DATABASE_PUBLIC_SOCIAL_WORKER_URL');
  secretSlot('DATABASE_OWNED_SOCIAL_WORKER_URL');
  secretSlot('DATABASE_WHATSAPP_LIVE_WORKER_URL');
  secretSlot('DATABASE_WHATSAPP_LIVE_WEBHOOK_URL');
  secretSlot('DATABASE_CUSTOMER_EMAIL_WORKER_URL');
  secretSlot('DATABASE_SMS_WORKER_URL');
  secretSlot('DATABASE_SMS_WEBHOOK_URL');
  assert.equal(
    (manifest.match(/- key: PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID\b/g) ?? []).length,
    10,
  );
  secretSlot('PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID');

  assert.deepEqual(databaseUrlKeys(webManifest), [
    'DATABASE_ABUSE_COMMAND_URL',
    // The 0032 receipt identity. It is append-only into three compliance
    // ledgers and holds nothing else, which is why it gets its own slot
    // instead of borrowing the CRM or customer-email credentials.
    'DATABASE_AFFILIATE_RECEIPT_COMMAND_URL',
    'DATABASE_CONTENT_ADAPTER_URL',
    'DATABASE_CONTENT_COMMAND_URL',
    'DATABASE_CRM_COMMAND_URL',
    'DATABASE_CUSTOMER_EMAIL_COMMAND_URL',
    'DATABASE_CUSTOMER_EMAIL_WEBHOOK_URL',
    'DATABASE_DAILY_OUTREACH_COMMAND_URL',
    'DATABASE_DAILY_OUTREACH_READ_URL',
    'DATABASE_EXTERNAL_EVENT_COMMAND_URL',
    // The 0065 evidence identity. It records the policy publication and PECR
    // route decisions the founder attests and holds exactly one function.
    'DATABASE_FOUNDER_PILOT_EVIDENCE_COMMAND_URL',
    'DATABASE_IDENTITY_COMMAND_URL',
    'DATABASE_MAILGUN_WEBHOOK_URL',
    'DATABASE_OWNED_SOCIAL_COMMAND_URL',
    'DATABASE_PUBLIC_SOCIAL_COMMAND_URL',
    'DATABASE_SMS_COMMAND_URL',
    'DATABASE_WEBHOOK_URL',
    'DATABASE_WEB_URL',
    'DATABASE_WHATSAPP_LIVE_COMMAND_URL',
    'DATABASE_ZERNIO_INBOUND_WEBHOOK_URL',
    'DATABASE_ZERNIO_SOCIAL_COMMAND_URL',
  ]);
  assert.deepEqual(databaseUrlKeys(emailWorkerManifest), ['DATABASE_MAILGUN_WORKER_URL']);
  assert.deepEqual(databaseUrlKeys(revalidatorWorkerManifest), [
    'DATABASE_PUBLIC_SOCIAL_REVALIDATOR_URL',
  ]);
  assert.deepEqual(databaseUrlKeys(socialTestWorkerManifest), [
    'DATABASE_PUBLIC_SOCIAL_WORKER_URL',
  ]);
  assert.deepEqual(databaseUrlKeys(ownedSocialLiveWorkerManifest), [
    'DATABASE_OWNED_SOCIAL_WORKER_URL',
  ]);
  assert.deepEqual(databaseUrlKeys(whatsAppLiveWorkerManifest), [
    'DATABASE_WHATSAPP_LIVE_WORKER_URL',
  ]);
  assert.deepEqual(databaseUrlKeys(whatsAppLiveWebhookManifest), [
    'DATABASE_WHATSAPP_LIVE_WEBHOOK_URL',
  ]);
  assert.deepEqual(databaseUrlKeys(customerEmailLiveWorkerManifest), [
    'DATABASE_CUSTOMER_EMAIL_WORKER_URL',
  ]);
  assert.deepEqual(databaseUrlKeys(smsLiveWorkerManifest), [
    'DATABASE_SMS_WORKER_URL',
  ]);
  assert.deepEqual(databaseUrlKeys(smsLiveWebhookManifest), [
    'DATABASE_SMS_WEBHOOK_URL',
  ]);

  assert.doesNotMatch(webManifest, /- key: DATABASE_MAILGUN_WORKER_URL\b/);
  assert.doesNotMatch(
    webManifest,
    /- key: DATABASE_PUBLIC_SOCIAL_(?:REVALIDATOR|WORKER)_URL\b/,
  );
  assert.match(emailWorkerManifest, /- key: DATABASE_MAILGUN_WORKER_URL\b/);
  assert.match(webManifest, /- key: DATABASE_MAILGUN_WEBHOOK_URL\b/);
  assert.doesNotMatch(webManifest, /- key: DATABASE_CUSTOMER_EMAIL_WORKER_URL\b/);
  assert.doesNotMatch(
    emailWorkerManifest,
    /- key: DATABASE_(?:WEB|IDENTITY_COMMAND|CRM_COMMAND|ABUSE_COMMAND|CONTENT_COMMAND|CONTENT_ADAPTER|MAILGUN_WEBHOOK)_URL\b/,
  );
  assert.doesNotMatch(
    revalidatorWorkerManifest,
    /- key: DATABASE_(?:WEB|IDENTITY_COMMAND|CRM_COMMAND|ABUSE_COMMAND|CONTENT_COMMAND|MAILGUN_WEBHOOK|MAILGUN_WORKER|PUBLIC_SOCIAL_COMMAND|PUBLIC_SOCIAL_WORKER)_URL\b/,
  );
  assert.doesNotMatch(
    socialTestWorkerManifest,
    /- key: DATABASE_(?:WEB|IDENTITY_COMMAND|CRM_COMMAND|ABUSE_COMMAND|CONTENT_COMMAND|CONTENT_ADAPTER|MAILGUN_WEBHOOK|MAILGUN_WORKER|PUBLIC_SOCIAL_COMMAND|PUBLIC_SOCIAL_REVALIDATOR)_URL\b/,
  );
  assert.doesNotMatch(
    ownedSocialLiveWorkerManifest,
    /- key: DATABASE_(?:WEB|IDENTITY_COMMAND|CRM_COMMAND|ABUSE_COMMAND|CONTENT_COMMAND|CONTENT_ADAPTER|MAILGUN_WEBHOOK|MAILGUN_WORKER|PUBLIC_SOCIAL_COMMAND|PUBLIC_SOCIAL_REVALIDATOR|PUBLIC_SOCIAL_WORKER)_URL\b/,
  );
  assert.doesNotMatch(
    customerEmailLiveWorkerManifest,
    /- key: DATABASE_(?:WEB|IDENTITY_COMMAND|CRM_COMMAND|ABUSE_COMMAND|CONTENT_COMMAND|CONTENT_ADAPTER|MAILGUN_WEBHOOK|MAILGUN_WORKER|CUSTOMER_EMAIL_COMMAND|CUSTOMER_EMAIL_WEBHOOK)_URL\b/,
  );

  literalValue('DATABASE_SSL_MODE', 'verify-full');
  literalValue('DATABASE_ABUSE_COMMAND_POOL_MAX', '2');
  literalValue('DATABASE_ABUSE_COMMAND_STATEMENT_TIMEOUT_MS', '1000');
  assert.doesNotMatch(manifest, /- key: (?:DATABASE_URL|DATABASE_MIGRATOR_URL|TEST_DATABASE_URL)\b/);
  assert.doesNotMatch(manifest, /postgres(?:ql)?:\/\//i);
  assert.doesNotMatch(manifest, /(?:preDeployCommand|initialDeployHook|afterFirstDeployCommand):/);
  assert.doesNotMatch(manifest, /^databases:/m);
  assert.doesNotMatch(manifest, /^\s+disk:/m);
});

test('Mailgun ingress and controlled internal-seed egress use disjoint exact secrets', () => {
  secretSlot('MAILGUN_SIGNING_KEY');

  assert.doesNotMatch(webManifest, /- key: MAILGUN_API_KEY\b/);
  assert.doesNotMatch(webManifest, /- key: MAILGUN_DOMAIN_SENDING_KEY\b/);
  assert.doesNotMatch(webManifest, /- key: DATABASE_MAILGUN_WORKER_URL\b/);
  assert.match(webManifest, /- key: MAILGUN_SIGNING_KEY\b/);
  assert.doesNotMatch(emailWorkerManifest, /- key: MAILGUN_API_KEY\b/);
  literalValueIn(emailWorkerManifest, 'MAILGUN_REGION', 'eu');
  literalValueIn(emailWorkerManifest, 'MAILGUN_SENDING_DOMAIN', 'mg.propertypredator.com');
  literalValueIn(emailWorkerManifest, 'MAILGUN_KEY_SCOPE', 'domain-sending');
  secretSlotIn(emailWorkerManifest, 'MAILGUN_DOMAIN_SENDING_KEY');
  secretSlotIn(emailWorkerManifest, 'MAILGUN_FROM_EMAIL');
  assert.doesNotMatch(emailWorkerManifest, /- key: MAILGUN_SIGNING_KEY\b/);
  assert.doesNotMatch(emailWorkerManifest, /- key: MAILGUN_EVENT_WEBHOOK_URL\b/);
  assert.doesNotMatch(
    emailWorkerManifest,
    /- key: MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED\b/,
  );
  assert.doesNotMatch(emailWorkerManifest, /- key: SESSION_SECRET\b/);
  assert.doesNotMatch(emailWorkerManifest, /- key: DATABASE_MAILGUN_WEBHOOK_URL\b/);
  assert.match(emailWorkerManifest, /- key: PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS\b/);
  assert.doesNotMatch(
    emailWorkerManifest,
    /stage_property_predator_mailgun_job|PROPERTY_PREDATOR_MAILGUN_JOB|(?:preDeployCommand|initialDeployHook|afterFirstDeployCommand):/,
    'Blueprint activation must not stage a provider job',
  );
  assert.doesNotMatch(customerEmailLiveWorkerManifest, /- key: MAILGUN_API_KEY\b/);
  literalValueIn(customerEmailLiveWorkerManifest, 'MAILGUN_REGION', 'eu');
  literalValueIn(customerEmailLiveWorkerManifest,
    'MAILGUN_SENDING_DOMAIN', 'mg.propertypredator.com');
  literalValueIn(customerEmailLiveWorkerManifest, 'MAILGUN_KEY_SCOPE', 'domain-sending');
  secretSlotIn(customerEmailLiveWorkerManifest, 'MAILGUN_DOMAIN_SENDING_KEY');
  secretSlotIn(customerEmailLiveWorkerManifest, 'MAILGUN_FROM_EMAIL');
  assert.doesNotMatch(customerEmailLiveWorkerManifest, /- key: MAILGUN_SIGNING_KEY\b/);
  assert.doesNotMatch(customerEmailLiveWorkerManifest, /- key: MAILGUN_EVENT_WEBHOOK_URL\b/);
  assert.doesNotMatch(customerEmailLiveWorkerManifest, /- key: SESSION_SECRET\b/);
  assert.doesNotMatch(customerEmailLiveWorkerManifest,
    /stage_customer_email|authorize_and_enqueue_customer_email|(?:preDeployCommand|initialDeployHook|afterFirstDeployCommand):/,
    'Blueprint activation must not enqueue or stage a customer email',
  );
  for (const worker of [
    revalidatorWorkerManifest, socialTestWorkerManifest, ownedSocialLiveWorkerManifest,
    whatsAppLiveWorkerManifest, whatsAppLiveWebhookManifest,
    smsLiveWorkerManifest, smsLiveWebhookManifest,
  ]) {
    assert.doesNotMatch(worker, /- key: MAILGUN_[A-Z0-9_]+\b/);
    assert.doesNotMatch(worker, /- key: PROPERTY_PREDATOR_EMAIL_[A-Z0-9_]+\b/);
  }

  literalValue('PROPERTY_PREDATOR_EMAIL_PROVIDER', 'mailgun');
  literalValue('PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED', 'true');
  literalValue('PROPERTY_PREDATOR_MAILGUN_INBOUND_ENABLED', 'true');
  literalValue('MAILGUN_REGION', 'eu');
  literalValue(
    'MAILGUN_EVENT_WEBHOOK_URL',
    'https://hq.propertypredator.com/api/provider-webhooks/mailgun/events',
  );
  literalValue('MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED', 'true');
  assert.doesNotMatch(
    manifest,
    /- key: (?:STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|POSTMARK_SERVER_TOKEN|BREVO_API_KEY|ANTHROPIC_API_KEY|DATABASE_IMPORT_COMMAND_URL)\b/,
  );
  assert.doesNotMatch(
    manifest,
    /- key: (?:WHEREBY_[A-Z0-9_]+|META_(?:ACCESS_TOKEN|APP_SECRET)|PROPERTY_PREDATOR_(?:WHATSAPP_PROVIDER|META_WHATSAPP_INGRESS_ENABLED|WHEREBY_INGRESS_ENABLED))\b/,
    'WhatsApp, social-DM and webinar provider rails must remain credential-free and dark',
  );
  secretSlotIn(smsLiveWebhookManifest, 'TWILIO_AUTH_TOKEN');
  for (const section of [
    webManifest, emailWorkerManifest, revalidatorWorkerManifest, socialTestWorkerManifest,
    ownedSocialLiveWorkerManifest, whatsAppLiveWorkerManifest, whatsAppLiveWebhookManifest,
    customerEmailLiveWorkerManifest, smsLiveWorkerManifest,
  ]) {
    assert.doesNotMatch(
      section,
      /- key: TWILIO_AUTH_TOKEN\b/,
      'the Twilio signature auth token must exist only in the SMS webhook service',
    );
  }
  for (const key of [
    'TWILIO_API_KEY_SECRET', 'TWILIO_API_KEY_SID', 'TWILIO_MESSAGING_SERVICE_SID',
  ]) {
    secretSlotIn(smsLiveWorkerManifest, key);
    for (const section of [
      webManifest, emailWorkerManifest, revalidatorWorkerManifest, socialTestWorkerManifest,
      ownedSocialLiveWorkerManifest, whatsAppLiveWorkerManifest, whatsAppLiveWebhookManifest,
      customerEmailLiveWorkerManifest, smsLiveWebhookManifest,
    ]) {
      assert.doesNotMatch(
        section,
        new RegExp(`- key: ${key}\\b`),
        `${key} must exist only in the isolated SMS worker`,
      );
    }
  }
  for (const section of [
    webManifest, emailWorkerManifest, revalidatorWorkerManifest, socialTestWorkerManifest,
    ownedSocialLiveWorkerManifest,
  ]) assert.doesNotMatch(section, /- key: AYRSHARE_[A-Z0-9_]+\b/);
  for (const key of [
    'ZERNIO_API_KEY', 'PROPERTY_PREDATOR_ZERNIO_INSTAGRAM_ACCOUNT_ID',
    'PROPERTY_PREDATOR_ZERNIO_LINKEDIN_ACCOUNT_ID',
    'PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_ORIGIN',
    'PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_SIGNING_KEY_BASE64URL',
  ]) secretSlotIn(ownedSocialLiveWorkerManifest, key);
  secretSlotIn(
    webManifest,
    'PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_SIGNING_KEY_BASE64URL',
  );
  assert.doesNotMatch(
    ownedSocialLiveWorkerManifest,
    /- key: PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN\b/,
  );
  assert.doesNotMatch(ownedSocialLiveWorkerManifest, /- key: AYRSHARE_[A-Z0-9_]+/);
  assert.doesNotMatch(manifest, /MAILGUN_(?:API_KEY|SIGNING_KEY):\s*\S+/);
});

test('deployment requires a dedicated controlled worker entrypoint without a web fallback', () => {
  const deploymentGuide = fs.readFileSync(
    path.join(repositoryRoot, 'docs/property-predator-production-deployment.md'),
    'utf8',
  );
  const orchestratorPackage = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'orchestrator/package.json'),
    'utf8',
  )) as { scripts?: Record<string, unknown> };
  assert.match(
    emailWorkerManifest,
    /startCommand: npm run --workspace orchestrator serve:property-predator-email-worker/,
  );
  for (const worker of workerManifests) {
    assert.doesNotMatch(worker, /startCommand: npm run serve(?:\s|$)/);
  }
  const workerEntrypoint = orchestratorPackage.scripts?.['serve:property-predator-email-worker'];
  if (typeof workerEntrypoint !== 'string' || workerEntrypoint.trim() === '') {
    assert.match(
      deploymentGuide,
      /Deployment blocker while absent:[^\n]*serve:property-predator-email-worker/i,
    );
  }
  assert.match(deploymentGuide, /r72_mailgun_worker_command/);
  assert.match(deploymentGuide, /r72_mailgun_webhook_command/);
});
