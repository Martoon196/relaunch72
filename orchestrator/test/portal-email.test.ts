import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginEmail } from '../src/portal/emails.js';
import { buildPortalDeps, buildPostgresPortalDeps } from '../src/portal/provision.js';
import type { ProvisionResult } from '../src/portal/provision.js';
import { validIntake } from './helpers.js';
import { JsonCrmStore } from '../src/crm/store.js';
import { JsonAccountStore } from '../src/portal/accounts.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';

test('PostgreSQL portal composition has no JSON dashboard, login or campaign dependency', () => {
  const auth: PortalAuthService = {
    resolve: async () => null,
    login: async () => null,
    revoke: async () => undefined,
  };
  const crm: PortalCrmService = {
    snapshot: async () => null,
    createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  };

  const portal = buildPostgresPortalDeps({ sessionSecret: 'secret', secure: true, auth, crm });

  assert.equal(portal.kind, 'postgres');
  assert.equal(portal.auth, auth);
  assert.equal(portal.crm, crm);
  assert.equal('login' in portal, false);
  assert.equal('dashboard' in portal, false);
  assert.equal('runTick' in portal, false);
  assert.equal('billing' in portal, false);
});

test('loginEmail builds a truthful generated-draft message carrying a one-time setup link, not a password', () => {
  const m = loginEmail({ to: 'a@b.co', tenantName: 'Acme Ltd', setupUrl: 'https://r72.test/portal/setup?token=one-use', generated: true });
  assert.equal(m.to, 'a@b.co');
  assert.match(m.subject, /set up/i);
  assert.match(m.textBody, /token=one-use/);
  assert.match(m.textBody, /only be used once/i);
  assert.match(m.textBody, /draft content cluster/i);
  assert.match(m.textBody, /simulated keyword research/i);
  assert.match(m.textBody, /paused ad drafts/i);
  assert.doesNotMatch(m.textBody, /temporary password|change your password/i);
  assert.match(m.htmlBody ?? '', /Choose your password/);
  assert.equal(m.messageStream, 'outbound');
});

test('loginEmail says the draft pack is unavailable when generation was deferred', () => {
  const m = loginEmail({ to: 'a@b.co', tenantName: 'Acme Ltd', setupUrl: 'https://r72.test/portal/setup?token=one-use', generated: false });
  assert.match(m.textBody, /could not be generated automatically/i);
  assert.match(m.textBody, /not available yet/i);
  assert.doesNotMatch(m.textBody, /already built|ready for you to review/i);
});

test('loginEmail refuses an invalid recipient', () => {
  assert.throws(() => loginEmail({ to: 'nope', tenantName: 'x', setupUrl: 'u', generated: false }), /valid recipient/);
});

test('provision fires onProvisioned once for a new signup, never for a repeat', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-'));
  const emptyRun = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-demo-')); // skips demo brand-brain generation
  const seen: ProvisionResult[] = [];
  const { provision } = await buildPortalDeps({
    dataDir, sessionSecret: 's', secure: false, demoRunDir: emptyRun,
    onProvisioned: async (r) => { seen.push(r); },
  });

  const r = await provision({ email: 'brand@new.co', name: 'Brand New Co', intake: validIntake() });
  assert.equal(r.existing, false);
  assert.equal(seen.length, 1, 'emailed once');
  assert.equal(seen[0]!.email, 'brand@new.co');
  assert.equal(seen[0]!.name, 'Brand New Co');
  assert.ok(seen[0]!.setupToken.length >= 40);

  await provision({ email: 'brand@new.co', name: 'Brand New Co', intake: validIntake() });
  assert.equal(seen.length, 1, 'no second email on a repeat signup');
});

test('portal boot defaults to no demo tenant unless a caller explicitly enables seeding', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-prod-'));
  await buildPortalDeps({ dataDir, sessionSecret: 's', secure: true });
  const store = new JsonCrmStore(path.join(dataDir, 'portal-crm.json'));
  assert.deepEqual(await store.listTenants(), []);
});

test('required setup delivery failure rolls back the pending login instead of orphaning it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-delivery-'));
  const { provision } = await buildPortalDeps({
    dataDir,
    sessionSecret: 's',
    secure: true,
    requireSetupDelivery: true,
    onProvisioned: async () => { throw new Error('Postmark unavailable'); },
  });
  await assert.rejects(
    provision({ email: 'delivery@new.co', name: 'Delivery Co', intake: validIntake() }),
    /account setup delivery failed/,
  );
  const accounts = new JsonAccountStore(path.join(dataDir, 'portal-accounts.json'));
  assert.equal(await accounts.has('delivery@new.co'), false);
});
