import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCustomerEmailCommandBoundaryReady,
  assertCustomerEmailWebhookBoundaryReady,
  assertCustomerEmailWorkerBoundaryReady,
} from '../src/customer-email-live-pg/readiness.js';

const exact = Object.freeze({
  exactRole: true,
  schemaUsage: true,
  runtimeLedger: true,
  installationIdentity: true,
  requiredFunctions: true,
  forbiddenFunctions: true,
  tableBlind: true,
  elevatedRolesDenied: true,
});

test('command readiness requires enqueue/session guards and denies worker/webhook effects', async () => {
  let sql = '';
  await assertCustomerEmailCommandBoundaryReady({ async query(statement: string) {
    sql = statement; return { rows: [exact] } as never;
  } } as never);
  assert.match(sql, /current_user = 'r72_customer_email_command'/u);
  assert.match(sql, /authorize_and_enqueue_customer_email_live_job/u);
  assert.match(sql, /lock_active_portal_session/u);
  assert.match(
    sql,
    /NOT\s+pg_catalog\.has_function_privilege\(current_user, 'app_private\.active_portal_session/u,
  );
  assert.match(sql, /NOT[\s\S]*claim_customer_email_live_job/u);
  assert.match(sql, /NOT[\s\S]*record_customer_email_signed_receipt/u);
  assert.match(sql, /runtime_schema_migrations/u);
  assert.match(sql, /NOT EXISTS[\s\S]*has_table_privilege/u);
});

test('worker readiness requires only claim/load/begin/settle capabilities', async () => {
  let sql = '';
  await assertCustomerEmailWorkerBoundaryReady({ async query(statement: string) {
    sql = statement; return { rows: [exact] } as never;
  } } as never);
  assert.match(sql, /current_user = 'r72_customer_email_worker_command'/u);
  for (const fn of ['claim_customer_email_live_job', 'load_customer_email_live_job',
    'begin_customer_email_live_call', 'settle_customer_email_live_call']) {
    assert.match(sql, new RegExp(fn, 'u'));
  }
  assert.match(sql, /NOT[\s\S]*authorize_and_enqueue_customer_email_live_job/u);
});

test('webhook readiness requires only the external-event receipt projector', async () => {
  let sql = '';
  await assertCustomerEmailWebhookBoundaryReady({ async query(statement: string) {
    sql = statement; return { rows: [exact] } as never;
  } } as never);
  assert.match(sql, /current_user = 'r72_customer_email_webhook_command'/u);
  assert.match(sql, /record_customer_email_signed_receipt\(uuid,uuid,text\)/u);
  assert.match(sql, /NOT[\s\S]*begin_customer_email_live_call/u);
});

test('every readiness probe fails closed on any widened or missing capability', async () => {
  for (const probe of [assertCustomerEmailCommandBoundaryReady,
    assertCustomerEmailWorkerBoundaryReady, assertCustomerEmailWebhookBoundaryReady]) {
    await assert.rejects(probe({ async query() {
      return { rows: [{ ...exact, tableBlind: false }] } as never;
    } } as never), /database boundary is not exact/u);
  }
});
