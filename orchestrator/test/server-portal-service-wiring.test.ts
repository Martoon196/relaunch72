import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The PostgreSQL platform composes portal services, and the server hands them
 * to the portal router. Those are two separate lists, and nothing previously
 * checked that the second contains the first.
 *
 * That gap is invisible in every other test. The platform composes the service,
 * the router reads `deps.<service>` and finds it undefined, and the founder
 * sees an honest "not composed" panel for a boundary that is in fact composed.
 * A live founder walkthrough is what caught it for contact permission; this
 * test is what stops the next one reaching production.
 */

const serverIndexUrl = new URL('../src/server/index.ts', import.meta.url);
const platformUrl = new URL('../src/portal/postgres-platform.ts', import.meta.url);

/**
 * Services the platform always composes. Each must be forwarded, because an
 * unforwarded one is silently missing rather than a type error: the portal
 * config declares them optional so legacy and partial compositions stay valid.
 */
const REQUIRED_SERVICES: readonly string[] = Object.freeze([
  'crm',
  'inbox',
  'inboxCommands',
  'inboxOperations',
  'liveChannelTruth',
  'liveChannelPause',
  'campaignMachine',
  'contactPermission',
]);

/** Services the platform composes only when their identity is configured. */
const OPTIONAL_SERVICES: readonly string[] = Object.freeze([
  'ownedSocialBinding',
  'smsBinding',
  'founderEmailPilot',
  'ownedSeedCampaign',
  'ownedSeedMessages',
]);

async function serverSource(): Promise<string> {
  return readFile(serverIndexUrl, 'utf8');
}

test('every always-composed portal service is forwarded to the portal', async () => {
  const source = await serverSource();
  const missing = REQUIRED_SERVICES.filter(
    (service) => !source.includes(`${service}: postgresPortal.${service},`),
  );
  assert.deepEqual(
    missing, [],
    `the server composes the platform but never forwards: ${missing.join(', ')}`,
  );
});

test('optionally composed services are forwarded too, so a bound one is reachable', async () => {
  const source = await serverSource();
  const missing = OPTIONAL_SERVICES.filter(
    (service) => !source.includes(`${service}: postgresPortal.${service},`),
  );
  assert.deepEqual(missing, [], `bound but unreachable: ${missing.join(', ')}`);
});

test('contact permission is composed by the platform and reaches the portal', async () => {
  // The exact regression: composed in one file, dropped in the other, and
  // reported to the founder as an uncomposed boundary.
  const [server, platform] = await Promise.all([
    serverSource(),
    readFile(platformUrl, 'utf8'),
  ]);
  assert.match(platform, /contactPermission: createPgPortalContactPermissionService\(\{/);
  assert.match(platform, /contactPermission: PgPortalContactPermissionService;/);
  assert.ok(
    server.includes('contactPermission: postgresPortal.contactPermission,'),
    'server/index.ts must forward the composed contact permission service',
  );
});

test('the forwarded names match what the platform actually exposes', async () => {
  // Guards this test against itself: a service renamed on the platform but not
  // here would leave the assertions above passing against a stale name.
  const platform = await readFile(platformUrl, 'utf8');
  for (const service of [...REQUIRED_SERVICES, ...OPTIONAL_SERVICES]) {
    assert.match(
      platform,
      new RegExp(`\\b${service}\\b`),
      `${service} is no longer exposed by the platform; update this list`,
    );
  }
});
