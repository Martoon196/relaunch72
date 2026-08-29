import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = fs.readFileSync(
  path.join(repositoryRoot, 'render.property-predator.production.yaml'),
  'utf8',
);

function serviceSection(type: 'web' | 'worker', name: string): string {
  const marker = `\n  - type: ${type}\n    name: ${name}\n`;
  const start = manifest.indexOf(marker);
  assert.notEqual(start, -1, `${name} must be present in the production Blueprint`);
  const end = manifest.indexOf('\n  - type: ', start + marker.length);
  return manifest.slice(start + 1, end === -1 ? manifest.length : end);
}

function literal(section: string, key: string, value: string): void {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    section,
    new RegExp(`- key: ${escapedKey}\\r?\\n\\s+value: ["']?${escapedValue}["']?(?:\\r?\\n|$)`),
    `${key} must remain exactly ${value}`,
  );
}

function valueLessSlot(section: string, key: string): void {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    section,
    new RegExp(`- key: ${escapedKey}\\r?\\n\\s+sync: false(?:\\r?\\n|$)`),
    `${key} must be a value-less Render secret/config slot`,
  );
  assert.doesNotMatch(
    section,
    new RegExp(`- key: ${escapedKey}\\r?\\n\\s+value:`),
  );
}

function databaseUrlKeys(section: string): string[] {
  return [...section.matchAll(/- key: (DATABASE_[A-Z0-9_]+_URL)\b/gu)]
    .map((match) => match[1]!)
    .sort();
}

function assertWorkerEnvelope(section: string, startCommand: string): void {
  assert.match(section, /runtime: node/);
  assert.match(section, /region: frankfurt/);
  assert.match(section, /plan: starter/);
  assert.match(section, /branch: codex\/relaunch72-platform-foundation/);
  assert.match(section, /numInstances: 1/);
  assert.match(section, /autoDeployTrigger: off/);
  assert.match(section, /maxShutdownDelaySeconds: 120/);
  assert.match(section, new RegExp(`startCommand: ${startCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(
    section,
    /buildCommand: npm ci --ignore-scripts --include=dev && node scripts\/supply-chain\.mjs --check && npm run typecheck && npm test/,
  );
  literal(section, 'NODE_VERSION', '22');
  literal(section, 'NODE_ENV', 'production');
  literal(section, 'DATABASE_SSL_MODE', 'verify-full');
  literal(section, 'DATABASE_CONNECTION_TIMEOUT_MS', '5000');
  literal(section, 'DATABASE_IDLE_TIMEOUT_MS', '30000');
  literal(section, 'DATABASE_STATEMENT_TIMEOUT_MS', '15000');
  literal(section, 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'false');
  literal(section, 'PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED', 'true');
  valueLessSlot(section, 'PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID');
  assert.doesNotMatch(section, /(?:preDeployCommand|initialDeployHook|afterFirstDeployCommand):/);
}

const web = serviceSection('web', 'property-predator-growth-hq');
const revalidator = serviceSection('worker', 'property-predator-public-social-revalidator');
const testRail = serviceSection('worker', 'property-predator-public-social-test-rail');
const ownedLiveRail = serviceSection('worker', 'property-predator-owned-public-social-live');

test('Growth HQ web receives the planner identity and one exact read-only company-content source', () => {
  valueLessSlot(web, 'DATABASE_PUBLIC_SOCIAL_COMMAND_URL');
  literal(web, 'DATABASE_PUBLIC_SOCIAL_COMMAND_POOL_MAX', '2');
  literal(web, 'PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN', 'https://propertypredator.com');
  literal(web, 'PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID', 'relaunch72');
  valueLessSlot(web, 'PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN');
  literal(web, 'PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS', '8000');
  literal(web, 'PROPERTY_PREDATOR_CAMPAIGN_GENERATION_ENABLED', 'true');
  literal(web, 'PROPERTY_PREDATOR_CAMPAIGN_GENERATION_PROVIDER_EFFECTS_ENABLED', 'true');
  literal(web, 'PROPERTY_PREDATOR_CAMPAIGN_GENERATION_EMERGENCY_PAUSED', 'false');
  valueLessSlot(web, 'PROPERTY_PREDATOR_COMPANY_CONTENT_GENERATE_TOKEN');
  literal(web, 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'false');
  literal(web, 'PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED', 'true');
  assert.doesNotMatch(
    web,
    /- key: DATABASE_PUBLIC_SOCIAL_(?:REVALIDATOR|WORKER)_URL\b/,
  );
  assert.doesNotMatch(
    web,
    /- key: PROPERTY_PREDATOR_(?:PUBLIC_SOCIAL_REVALIDATOR|PUBLIC_SOCIAL_RAIL)_/,
  );
  assert.doesNotMatch(web, /- key: (?:COMPANY_CONTENT_GENERATE_TOKEN|ADMIN_TOKEN)\b/);
  for (const worker of [revalidator, testRail, ownedLiveRail]) {
    assert.doesNotMatch(
      worker,
      /- key: PROPERTY_PREDATOR_(?:CAMPAIGN_GENERATION_[A-Z0-9_]+|COMPANY_CONTENT_GENERATE_TOKEN)\b/,
    );
  }
});

test('0052 owned-profile worker is deployable dark with one exact live identity', () => {
  assertWorkerEnvelope(
    ownedLiveRail,
    'npm run --workspace orchestrator serve:owned-public-social-live',
  );
  assert.deepEqual(databaseUrlKeys(ownedLiveRail), [
    'DATABASE_OWNED_SOCIAL_WORKER_URL',
  ]);
  valueLessSlot(ownedLiveRail, 'DATABASE_OWNED_SOCIAL_WORKER_URL');
  literal(ownedLiveRail, 'DATABASE_OWNED_SOCIAL_WORKER_POOL_MAX', '1');
  literal(ownedLiveRail, 'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE', 'disabled');
  literal(ownedLiveRail, 'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID', 'ayrshare');
  literal(ownedLiveRail, 'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK', 'x');
  literal(ownedLiveRail, 'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_POLL_MS', '5000');
  for (const key of [
    'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_WORKSPACE_ID',
    'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID',
    'PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_BASE64',
    'PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_VERSION',
    'AYRSHARE_API_KEY',
    'AYRSHARE_X_OAUTH1_API_KEY',
    'AYRSHARE_X_OAUTH1_API_SECRET',
  ]) valueLessSlot(ownedLiveRail, key);
  assert.doesNotMatch(
    ownedLiveRail,
    /- key: (?:DATABASE_URL|TEST_DATABASE_URL|DATABASE_MIGRATOR_URL|DATABASE_WEB_URL|DATABASE_PUBLIC_SOCIAL_(?:COMMAND|REVALIDATOR|WORKER)_URL|SESSION_SECRET|MAILGUN_[A-Z0-9_]+|STRIPE_[A-Z0-9_]+|META_[A-Z0-9_]+|LINKEDIN_[A-Z0-9_]+)\b/,
  );
});

test('0040 JIT revalidator has one function-only database identity and one read-only source credential', () => {
  assertWorkerEnvelope(
    revalidator,
    'npm run --workspace orchestrator serve:public-social-revalidator',
  );
  assert.deepEqual(databaseUrlKeys(revalidator), [
    'DATABASE_PUBLIC_SOCIAL_REVALIDATOR_URL',
  ]);
  valueLessSlot(revalidator, 'DATABASE_PUBLIC_SOCIAL_REVALIDATOR_URL');
  literal(revalidator, 'DATABASE_PUBLIC_SOCIAL_REVALIDATOR_POOL_MAX', '1');
  literal(revalidator, 'PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN', 'https://propertypredator.com');
  literal(revalidator, 'PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID', 'relaunch72');
  valueLessSlot(revalidator, 'PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN');
  literal(revalidator, 'PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS', '8000');
  literal(revalidator, 'PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_ENVIRONMENT', 'test');
  literal(revalidator, 'PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_POLL_MS', '1000');
  assert.doesNotMatch(
    revalidator,
    /- key: (?:DATABASE_URL|TEST_DATABASE_URL|DATABASE_MIGRATOR_URL|DATABASE_PUBLIC_SOCIAL_WORKER_URL|DATABASE_CONTENT_ADAPTER_URL|DATABASE_CONTENT_ADAPTER_POOL_MAX|PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_USER_ID|COMPANY_CONTENT_GENERATE_TOKEN|ADMIN_TOKEN|SESSION_SECRET|MAILGUN_[A-Z0-9_]+|STRIPE_[A-Z0-9_]+|AYRSHARE_[A-Z0-9_]+|META_[A-Z0-9_]+|LINKEDIN_[A-Z0-9_]+)\b/,
  );
});

test('materialized public-social operations reach only the deterministic TEST simulator worker', () => {
  assertWorkerEnvelope(
    testRail,
    'npm run --workspace orchestrator serve:public-social-test-rail',
  );
  assert.deepEqual(databaseUrlKeys(testRail), ['DATABASE_PUBLIC_SOCIAL_WORKER_URL']);
  valueLessSlot(testRail, 'DATABASE_PUBLIC_SOCIAL_WORKER_URL');
  literal(testRail, 'DATABASE_PUBLIC_SOCIAL_WORKER_POOL_MAX', '1');
  literal(testRail, 'PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_ENVIRONMENT', 'test');
  literal(
    testRail,
    'PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_PROVIDER_ID',
    'public_social_dark_simulator',
  );
  literal(testRail, 'PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_POLL_MS', '1000');
  assert.doesNotMatch(
    testRail,
    /- key: (?:DATABASE_URL|TEST_DATABASE_URL|DATABASE_MIGRATOR_URL|DATABASE_PUBLIC_SOCIAL_REVALIDATOR_URL|DATABASE_CONTENT_ADAPTER_URL|SESSION_SECRET|MAILGUN_[A-Z0-9_]+|STRIPE_[A-Z0-9_]+|AYRSHARE_[A-Z0-9_]+|META_[A-Z0-9_]+|LINKEDIN_[A-Z0-9_]+)\b/,
  );
});

test('social launch additions preserve the existing services and add no database or deployment mutation', () => {
  const services = [...manifest.matchAll(/^  - type: (?:web|worker)$/gmu)];
  assert.equal(services.length, 5);
  assert.match(manifest, /name: property-predator-growth-hq/);
  assert.match(manifest, /name: property-predator-email-worker/);
  assert.match(manifest, /name: property-predator-public-social-revalidator/);
  assert.match(manifest, /name: property-predator-public-social-test-rail/);
  assert.match(manifest, /name: property-predator-owned-public-social-live/);
  assert.doesNotMatch(manifest, /^databases:/mu);
  assert.doesNotMatch(manifest, /(?:preDeployCommand|initialDeployHook|afterFirstDeployCommand):/);
  assert.doesNotMatch(manifest, /postgres(?:ql)?:\/\//iu);
});
