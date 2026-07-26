import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
});

test('accounts persist across instances (JSON file)', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-')), 'accounts.json');
  await new JsonAccountStore(file).create('a@b.co', 't9', 'pw');
  assert.equal(await new JsonAccountStore(file).verify('a@b.co', 'pw'), 't9');
});

test('provisionTenant creates a working login with a generated brand brain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  const store = new JsonCrmStore(path.join(dir, 'crm.json'));
  const accounts = new JsonAccountStore();

  const r = await provisionTenant(store, accounts, dir, { email: 'new@client.co', name: 'New Client Ltd', intake: validIntake() });
  assert.equal(r.existing, false);
  assert.equal(r.generated, true);
  assert.ok(r.password.length >= 8, 'a temp password was issued');

  // The returned password logs the tenant in.
  assert.equal(await accounts.verify('new@client.co', r.password), r.tenantId);
  // The tenant exists with a run dir, and the dashboard has real artifacts.
  const tenant = await store.getTenant(r.tenantId);
  assert.ok(tenant?.runDir && fs.existsSync(path.join(tenant.runDir, 'cc.json')), 'brand brain + cluster generated');
});

test('provisionTenant is idempotent per email (no duplicate account)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov2-'));
  const store = new JsonCrmStore(path.join(dir, 'crm.json'));
  const accounts = new JsonAccountStore();
  const first = await provisionTenant(store, accounts, dir, { email: 'dup@client.co', name: 'Dup Co', intake: validIntake() });
  const second = await provisionTenant(store, accounts, dir, { email: 'dup@client.co', name: 'Dup Co', intake: validIntake() });
  assert.equal(second.existing, true);
  assert.equal(second.tenantId, first.tenantId);
});
