import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginEmail } from '../src/portal/emails.js';
import { buildPortalDeps } from '../src/portal/provision.js';
import type { ProvisionResult } from '../src/portal/provision.js';
import { validIntake } from './helpers.js';

test('loginEmail builds a valid message carrying the password + portal link', () => {
  const m = loginEmail({ to: 'a@b.co', tenantName: 'Acme Ltd', loginEmail: 'a@b.co', password: 'PW-123', portalUrl: 'https://r72.test/portal' });
  assert.equal(m.to, 'a@b.co');
  assert.match(m.subject, /ready/i);
  assert.match(m.textBody, /PW-123/);
  assert.match(m.textBody, /r72\.test\/portal/);
  assert.match(m.htmlBody ?? '', /Open your dashboard/);
  assert.equal(m.messageStream, 'outbound');
});

test('loginEmail refuses an invalid recipient', () => {
  assert.throws(() => loginEmail({ to: 'nope', tenantName: 'x', loginEmail: 'x', password: 'p', portalUrl: 'u' }), /valid recipient/);
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
  assert.ok(seen[0]!.password.length >= 8);

  await provision({ email: 'brand@new.co', name: 'Brand New Co', intake: validIntake() });
  assert.equal(seen.length, 1, 'no second email on a repeat signup');
});
