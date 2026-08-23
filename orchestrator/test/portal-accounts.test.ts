import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonAccountStore } from '../src/portal/accounts.js';
import { provisionTenant } from '../src/portal/provision.js';
import { JsonCrmStore } from '../src/crm/store.js';
import { validIntake } from './helpers.js';

test('accounts: create + verify (right vs wrong password), case-insensitive email', async () => {
  const acc = new JsonAccountStore(); // in-memory
  await acc.create('Owner@Frayne.co', 't1', 'hunter2');
  assert.equal(await acc.verify('owner@frayne.co', 'hunter2'), 't1');
  assert.equal(await acc.verify('owner@frayne.co', 'wrong'), null);
  assert.equal(await acc.verify('nobody@x.co', 'hunter2'), null);
  assert.equal(await acc.has('OWNER@FRAYNE.CO'), true);
  assert.match((await acc.findByEmail('owner@frayne.co'))!.passHash, /^scrypt\$v1\$/);
  assert.doesNotMatch((await acc.findByEmail('owner@frayne.co'))!.passHash, /hunter2/);
});

test('accounts persist across instances (JSON file)', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-')), 'accounts.json');
  await new JsonAccountStore(file).create('a@b.co', 't9', 'pw');
  assert.equal(await new JsonAccountStore(file).verify('a@b.co', 'pw'), 't9');
});

test('accounts: corrupt credential storage fails loudly instead of becoming an empty account table', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-corrupt-')), 'accounts.json');
  fs.writeFileSync(file, '{truncated', 'utf8');
  assert.throws(() => new JsonAccountStore(file), /refusing to load corrupt portal account store/);
});

test('accounts: a legacy SHA-256 password verifies once and is upgraded to scrypt', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-old-')), 'accounts.json');
  const legacy = crypto.createHash('sha256').update('old-password').digest('hex');
  fs.writeFileSync(file, JSON.stringify([{ email: 'legacy@b.co', tenantId: 't-old', passHash: legacy }]), 'utf8');
  const accounts = new JsonAccountStore(file);
  assert.equal(await accounts.verify('legacy@b.co', 'wrong'), null);
  assert.equal(await accounts.verify('legacy@b.co', 'old-password'), 't-old');
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8'))[0].passHash as string, /^scrypt\$v1\$/);
});

test('accounts: setup token is expiring, single-use and never stored in clear', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-setup-')), 'accounts.json');
  const accounts = new JsonAccountStore(file);
  const expires = new Date(2_000_000).toISOString();
  await accounts.createPending('setup@b.co', 't-setup', 'private-token', expires);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /private-token/);
  assert.equal(await accounts.verify('setup@b.co', 'a-strong-password'), null, 'pending accounts cannot log in');
  assert.equal(await accounts.completeSetup('wrong-token', 'a-strong-password', 1_000_000), null);
  assert.equal(await accounts.completeSetup('private-token', 'a-strong-password', 1_000_000), 't-setup');
  assert.equal(await accounts.completeSetup('private-token', 'another-password', 1_000_000), null, 'token was consumed');
  assert.equal(await accounts.verify('setup@b.co', 'a-strong-password'), 't-setup');
});

test('accounts: concurrent setup submissions allow exactly one password to win', async () => {
  const accounts = new JsonAccountStore();
  await accounts.createPending('race@b.co', 't-race', 'race-token', new Date(2_000_000).toISOString());
  const results = await Promise.all([
    accounts.completeSetup('race-token', 'first-strong-password', 1_000_000),
    accounts.completeSetup('race-token', 'second-strong-password', 1_000_000),
  ]);
  assert.deepEqual(results, ['t-race', null]);
  assert.equal(await accounts.verify('race@b.co', 'first-strong-password'), 't-race');
  assert.equal(await accounts.verify('race@b.co', 'second-strong-password'), null);
});

test('accounts: malformed persisted setup expiry never becomes a non-expiring token', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-expiry-')), 'accounts.json');
  const tokenHash = crypto.createHash('sha256').update('bad-expiry-token').digest('hex');
  fs.writeFileSync(file, JSON.stringify([{
    email: 'expiry@b.co', tenantId: 't-expiry', passHash: '', setupTokenHash: tokenHash, setupExpiresAt: 'not-a-date',
  }]), 'utf8');
  const accounts = new JsonAccountStore(file);
  assert.equal(await accounts.completeSetup('bad-expiry-token', 'a-strong-password', 1_000_000), null);
});

test('provisionTenant creates a working login with a generated brand brain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  const store = new JsonCrmStore(path.join(dir, 'crm.json'));
  const accounts = new JsonAccountStore();

  const r = await provisionTenant(store, accounts, dir, { email: 'new@client.co', name: 'New Client Ltd', intake: validIntake() });
  assert.equal(r.existing, false);
  assert.equal(r.generated, true);
  assert.ok(r.setupToken.length >= 40, 'a high-entropy setup token was issued');

  // The account cannot log in until the one-time setup link chooses a password.
  assert.equal(await accounts.verify('new@client.co', r.setupToken), null);
  assert.equal(await accounts.completeSetup(r.setupToken, 'correct-horse-battery', Date.now()), r.tenantId);
  assert.equal(await accounts.verify('new@client.co', 'correct-horse-battery'), r.tenantId);
  // The tenant exists with a run dir, and the dashboard has real artifacts.
  const tenant = await store.getTenant(r.tenantId);
  assert.ok(tenant?.runDir && fs.existsSync(path.join(tenant.runDir, 'cc.json')), 'brand brain + cluster generated');
});

test('provisionTenant is idempotent per email (no duplicate account)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov2-'));
  const store = new JsonCrmStore(path.join(dir, 'crm.json'));
  const accounts = new JsonAccountStore();
  const first = await provisionTenant(store, accounts, dir, { email: 'dup@client.co', name: 'Dup Co', intake: validIntake() });
  const second = await provisionTenant(store, accounts, dir, { email: 'dup@client.co', name: 'Renamed Caller Value', intake: validIntake() });
  assert.equal(second.existing, true);
  assert.equal(second.tenantId, first.tenantId);
  assert.equal(second.name, 'Dup Co');
});
