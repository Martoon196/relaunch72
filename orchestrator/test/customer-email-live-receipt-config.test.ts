import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCustomerEmailSignedReceiptConfig } from '../src/integrations/mailgun-webhook/customer-email-receipts.js';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';

test('customer-email receipt projection is dark by default', () => {
  assert.deepEqual(loadCustomerEmailSignedReceiptConfig({}), {
    enabled: false,
    configurationReady: true,
    blockers: [],
    workspaceId: null,
    providerConnectionId: null,
  });
});

test('customer-email receipts require the exact signed canonical route binding', () => {
  const ready = loadCustomerEmailSignedReceiptConfig({
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_ENABLED: 'true',
    PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED: 'true',
    MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED: 'true',
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: WORKSPACE,
    PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID: CONNECTION,
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_WORKSPACE_ID: WORKSPACE,
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_CONNECTION_ID: CONNECTION,
  });
  assert.equal(ready.enabled, true);
  assert.equal(ready.configurationReady, true);
  assert.equal(ready.workspaceId, WORKSPACE);
  assert.equal(ready.providerConnectionId, CONNECTION);

  for (const patch of [
    { PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_ENABLED: 'yes' },
    { PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED: 'false' },
    { MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED: 'false' },
    { PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_WORKSPACE_ID: 'not-a-uuid' },
    { PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_CONNECTION_ID: '' },
    { PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: '44444444-4444-4444-8444-444444444444' },
    { PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID:
      '55555555-5555-4555-8555-555555555555' },
  ]) {
    const blocked = loadCustomerEmailSignedReceiptConfig({
      PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_ENABLED: 'true',
      PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED: 'true',
      MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED: 'true',
      PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: WORKSPACE,
      PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID: CONNECTION,
      PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_WORKSPACE_ID: WORKSPACE,
      PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_CONNECTION_ID: CONNECTION,
      ...patch,
    });
    assert.equal(blocked.enabled, true);
    assert.equal(blocked.configurationReady, false);
    assert.ok(blocked.blockers.length > 0);
  }
});
