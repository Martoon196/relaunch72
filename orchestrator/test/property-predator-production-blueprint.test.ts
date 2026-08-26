import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(repositoryRoot, 'render.property-predator.production.yaml');
const manifest = fs.readFileSync(manifestPath, 'utf8');
const workerMarker = '\n  - type: worker\n';
const workerOffset = manifest.indexOf(workerMarker);
assert.notEqual(workerOffset, -1, 'production Blueprint must isolate outbound work');
const webManifest = manifest.slice(0, workerOffset);
const workerManifest = manifest.slice(workerOffset + 1);

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

test('production Blueprint is isolated, manually deployed and fail-closed', () => {
  assert.match(manifest, /name: property-predator-growth-hq/);
  assert.match(manifest, /region: frankfurt/);
  assert.match(manifest, /plan: starter/);
  assert.match(manifest, /branch: codex\/relaunch72-platform-foundation/);
  assert.match(manifest, /numInstances: 1/);
  assert.match(manifest, /autoDeployTrigger: off/);
  assert.match(manifest, /healthCheckPath: \/ready/);
  assert.match(manifest, /renderSubdomainPolicy: disabled/);
  assert.match(manifest, /- hq\.propertypredator\.co\.uk/);
  assert.equal(
    (manifest.match(/buildCommand: npm ci --include=dev && npm run typecheck && npm test/g) ?? []).length,
    2,
    'both production processes must install the locked dev toolchain used by build checks and TS entrypoints',
  );
  assert.match(manifest, /startCommand: npm run serve/);
  assert.match(workerManifest, /name: property-predator-email-worker/);
  assert.match(workerManifest, /plan: starter/);
  assert.match(workerManifest, /region: frankfurt/);
  assert.match(workerManifest, /autoDeployTrigger: off/);
  assert.match(
    workerManifest,
    /startCommand: npm run --workspace orchestrator serve:property-predator-email-worker/,
  );

  literalValue('PORTAL_POSTGRES_ENABLED', 'true');
  literalValue('PORTAL_PRODUCT_PROFILE', 'property_predator_growth');
  literalValue('PLATFORM_SUBSCRIPTIONS_ENABLED', 'false');
  literalValue('PUBLIC_LEAD_CAPTURE_ENABLED', 'false');
  literalValue('PORTAL_DEMO_SEED', 'false');
  literalValue('PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED', 'false');
  for (const section of [webManifest, workerManifest]) {
    literalValueIn(section, 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'false');
    literalValueIn(section, 'PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED', 'false');
    literalValueIn(section, 'PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED', 'true');
  }
  literalValue('PROPERTY_PREDATOR_PILOT_STAGE', 'internal-seed');
  literalValue('PROPERTY_PREDATOR_PILOT_RECIPIENT_SCOPE', 'owned-internal-seeds-only');
  literalValue('PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS', '10');
});

test('production Blueprint keeps web and worker database identities process-isolated', () => {
  for (const key of [
    'DATABASE_WEB_URL',
    'DATABASE_IDENTITY_COMMAND_URL',
    'DATABASE_CRM_COMMAND_URL',
    'DATABASE_CONTENT_COMMAND_URL',
    'DATABASE_MAILGUN_WEBHOOK_URL',
  ]) secretSlot(key);
  secretSlot('DATABASE_MAILGUN_WORKER_URL');
  assert.equal(
    (manifest.match(/- key: PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID\b/g) ?? []).length,
    2,
  );
  secretSlot('PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID');

  assert.deepEqual(databaseUrlKeys(webManifest), [
    'DATABASE_CONTENT_COMMAND_URL',
    'DATABASE_CRM_COMMAND_URL',
    'DATABASE_IDENTITY_COMMAND_URL',
    'DATABASE_MAILGUN_WEBHOOK_URL',
    'DATABASE_WEB_URL',
  ]);
  assert.deepEqual(databaseUrlKeys(workerManifest), ['DATABASE_MAILGUN_WORKER_URL']);

  assert.doesNotMatch(webManifest, /- key: DATABASE_MAILGUN_WORKER_URL\b/);
  assert.match(workerManifest, /- key: DATABASE_MAILGUN_WORKER_URL\b/);
  assert.match(webManifest, /- key: DATABASE_MAILGUN_WEBHOOK_URL\b/);
  assert.doesNotMatch(
    workerManifest,
    /- key: DATABASE_(?:WEB|IDENTITY_COMMAND|CRM_COMMAND|CONTENT_COMMAND|MAILGUN_WEBHOOK)_URL\b/,
  );

  literalValue('DATABASE_SSL_MODE', 'verify-full');
  assert.doesNotMatch(manifest, /- key: (?:DATABASE_URL|DATABASE_MIGRATOR_URL|TEST_DATABASE_URL)\b/);
  assert.doesNotMatch(manifest, /postgres(?:ql)?:\/\//i);
  assert.doesNotMatch(manifest, /(?:preDeployCommand|initialDeployHook|afterFirstDeployCommand):/);
  assert.doesNotMatch(manifest, /^databases:/m);
  assert.doesNotMatch(manifest, /^\s+disk:/m);
});

test('Mailgun ingress is isolated and the dark worker receives no outbound secret', () => {
  secretSlot('MAILGUN_SIGNING_KEY');

  assert.doesNotMatch(webManifest, /- key: MAILGUN_API_KEY\b/);
  assert.doesNotMatch(webManifest, /- key: DATABASE_MAILGUN_WORKER_URL\b/);
  assert.match(webManifest, /- key: MAILGUN_SIGNING_KEY\b/);
  assert.doesNotMatch(workerManifest, /- key: MAILGUN_API_KEY\b/);
  assert.doesNotMatch(workerManifest, /- key: MAILGUN_SENDING_DOMAIN\b/);
  assert.doesNotMatch(workerManifest, /- key: MAILGUN_FROM_EMAIL\b/);
  assert.doesNotMatch(workerManifest, /- key: MAILGUN_SIGNING_KEY\b/);
  assert.doesNotMatch(workerManifest, /- key: MAILGUN_EVENT_WEBHOOK_URL\b/);
  assert.doesNotMatch(
    workerManifest,
    /- key: MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED\b/,
  );
  assert.doesNotMatch(workerManifest, /- key: SESSION_SECRET\b/);
  assert.doesNotMatch(workerManifest, /- key: DATABASE_MAILGUN_WEBHOOK_URL\b/);
  assert.match(workerManifest, /- key: PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS\b/);

  literalValue('PROPERTY_PREDATOR_EMAIL_PROVIDER', 'mailgun');
  literalValue('PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED', 'true');
  literalValue('MAILGUN_REGION', 'eu');
  literalValue(
    'MAILGUN_EVENT_WEBHOOK_URL',
    'https://hq.propertypredator.co.uk/api/provider-webhooks/mailgun/events',
  );
  literalValue('MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED', 'true');
  assert.doesNotMatch(
    manifest,
    /- key: (?:STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|POSTMARK_SERVER_TOKEN|BREVO_API_KEY|ANTHROPIC_API_KEY|DATABASE_IMPORT_COMMAND_URL)\b/,
  );
  assert.doesNotMatch(manifest, /MAILGUN_(?:API_KEY|SIGNING_KEY):\s*\S+/);
});

test('deployment requires a dedicated dormant worker entrypoint without a web fallback', () => {
  const deploymentGuide = fs.readFileSync(
    path.join(repositoryRoot, 'docs/property-predator-production-deployment.md'),
    'utf8',
  );
  const orchestratorPackage = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'orchestrator/package.json'),
    'utf8',
  )) as { scripts?: Record<string, unknown> };
  assert.match(
    workerManifest,
    /startCommand: npm run --workspace orchestrator serve:property-predator-email-worker/,
  );
  assert.doesNotMatch(workerManifest, /startCommand: npm run serve(?:\s|$)/);
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
