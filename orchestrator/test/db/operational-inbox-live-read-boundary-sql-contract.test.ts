import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../../src/db/migrations/0062_operational_inbox_live_evidence_read_boundary.sql',
  import.meta.url,
);
const readModelUrl = new URL('../../src/inbox-pg/read-model.ts', import.meta.url);
const threadServiceUrl = new URL(
  '../../src/portal/conversion-inbox-thread-pg-service.ts',
  import.meta.url,
);

/** The four tables r72_web has never been granted, which broke the whole query. */
const PROTECTED_TABLES = [
  'property_predator_customer_email_jobs',
  'property_predator_whatsapp_live_inbox_projections',
  'property_predator_sms_inbox_projections',
  'property_predator_sms_jobs',
] as const;

const GRANTED_FUNCTIONS = [
  'operational_inbox_live_conversation_visible',
  'operational_inbox_live_message_provenance',
  'operational_inbox_live_delivery_linked',
] as const;

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

async function migration(): Promise<string> {
  return normalise(await readFile(migrationUrl, 'utf8'));
}

test('0062 creates every inbox read function as a definer-owned stable reader', async () => {
  const sql = await migration();
  assert.match(sql, /SET LOCAL ROLE r72_operational_inbox_definer;/);
  for (const name of [...GRANTED_FUNCTIONS, 'operational_inbox_live_read_allowed']) {
    const declaration = new RegExp(
      `CREATE FUNCTION app_private\\.${name}\\(([^)]*)\\)[^$]*?`
      + 'LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog',
    );
    assert.match(sql, declaration, `${name} must be a stable definer reader`);
  }
  // A read boundary that could write would be a far worse defect than the one
  // it repairs, so the migration must contain no data mutation at all.
  assert.doesNotMatch(sql, /INSERT INTO app\./);
  assert.doesNotMatch(sql, /UPDATE app\./);
  assert.doesNotMatch(sql, /DELETE FROM app\./);
  assert.doesNotMatch(sql, /LANGUAGE plpgsql VOLATILE/);
});

test('0062 requires workspace, user and active membership on every read', async () => {
  const sql = await migration();
  assert.match(
    sql,
    /CREATE FUNCTION app_private\.operational_inbox_live_read_allowed\(\s*p_workspace_id uuid\s*\)/,
  );
  for (const guard of [
    /p_workspace_id = app_private\.current_workspace_id\(\)/,
    /app_private\.current_actor_kind\(\) = 'user'/,
    /app_private\.current_user_id\(\) IS NOT NULL/,
    /app_private\.has_active_workspace_membership\(\s*app_private\.current_user_id\(\), p_workspace_id\s*\)/,
  ]) {
    assert.match(sql, guard);
  }
  // Each granted function must route through the one shared gate, so no reader
  // can drift into checking less than the others.
  for (const name of GRANTED_FUNCTIONS) {
    const body = sql.slice(sql.indexOf(`CREATE FUNCTION app_private.${name}(`));
    const end = body.indexOf('$function$;');
    assert.ok(end > 0, `${name} body not found`);
    assert.match(
      body.slice(0, end),
      /app_private\.operational_inbox_live_read_allowed\(p_workspace_id\)/,
      `${name} must call the shared gate`,
    );
  }
});

test('0062 grants r72_web the three inbox questions and never the shared gate', async () => {
  const sql = await migration();
  for (const name of GRANTED_FUNCTIONS) {
    assert.match(
      sql,
      new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.${name}\\([^)]*\\) TO r72_web`),
    );
    assert.match(
      sql,
      new RegExp(`REVOKE ALL ON FUNCTION app_private\\.${name}\\([^)]*\\) FROM PUBLIC`),
    );
  }
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION app_private\.operational_inbox_live_read_allowed\(uuid\) FROM PUBLIC/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.operational_inbox_live_read_allowed\(uuid\) TO r72_web/,
  );
  // The migration proves both halves at apply time rather than trusting review.
  assert.match(sql, /has_function_privilege\(\s*'r72_web'/);
  assert.match(sql, /The shared inbox gate must not be callable by r72_web/);
});

test('0062 gives r72_web no new table privilege and audits that it stays blind', async () => {
  const sql = await migration();
  for (const table of PROTECTED_TABLES) {
    assert.doesNotMatch(
      sql,
      new RegExp(`GRANT[^;]*ON app\\.${table}[^;]*TO r72_web`),
      `${table} must never be granted to r72_web`,
    );
    assert.match(sql, new RegExp(`'${table}'`), `${table} must be audited`);
  }
  assert.match(sql, /has_table_privilege\(\s*'r72_web'/);
  assert.match(sql, /r72_web must stay table-blind on app\.%/);
});

test('0062 gives the definer column-scoped reads and denies evidence payloads', async () => {
  const sql = await migration();
  // Every definer grant must name its columns; a bare table grant would hand the
  // definer the bodies and digests this boundary exists to withhold.
  const definerGrants = sql.match(/GRANT SELECT[^;]*TO r72_operational_inbox_definer/g) ?? [];
  assert.ok(definerGrants.length >= 6, 'expected column-scoped definer grants');
  for (const grant of definerGrants) {
    assert.match(grant, /GRANT SELECT \(/, `definer grant must be column-scoped: ${grant}`);
  }
  for (const forbidden of [
    'body_sha256', 'sender_identity_sha256', 'payload_sha256',
    // 0050 names this signature_token_sha256. The invented signature_sha256
    // failed the disposable-Neon apply with 42703, so the exact name matters.
    'signature_token_sha256', 'recipient_sha256', 'request_sha256',
    'idempotency_key_sha256', 'opt_evidence',
  ]) {
    assert.match(sql, new RegExp(`'${forbidden}'`), `${forbidden} must be audited`);
  }
  assert.match(sql, /has_column_privilege\(\s*'r72_operational_inbox_definer'/);
  assert.match(sql, /Operational inbox definer must not read app/);
});

test('0062 exposes only identifiers, provider family, network and timestamps', async () => {
  const sql = await migration();
  const start = sql.indexOf(
    'CREATE FUNCTION app_private.operational_inbox_live_message_provenance(',
  );
  const body = sql.slice(start, sql.indexOf('$function$;', start));
  assert.match(
    body,
    /RETURNS TABLE \( receipt_id uuid, provider_family text, network text, verified_at timestamptz \)/,
  );
  for (const family of ['mailgun_email', 'meta_whatsapp_live', 'twilio_sms_live']) {
    assert.match(body, new RegExp(`'${family}'`));
  }
  // No body, digest or payload column may appear in the returned projection.
  for (const leak of ['body_sha256', 'sender_identity_sha256', 'body_text', 'opt_evidence']) {
    assert.doesNotMatch(body, new RegExp(`\\b${leak}\\b`), `${leak} must not cross the boundary`);
  }
  // Ranked and limited so a transcript row can never fan out into duplicates.
  assert.match(body, /ORDER BY provenance\.rail_rank LIMIT 1/);
});

test('0062 pins the exact SMS provider operation for rail activity', async () => {
  const sql = await migration();
  const start = sql.indexOf(
    'CREATE FUNCTION app_private.operational_inbox_live_delivery_linked(',
  );
  const body = sql.slice(start, sql.indexOf('$function$;', start));
  assert.match(body, /live_sms\.message_delivery_id = p_message_delivery_id/);
  assert.match(body, /live_sms\.operation_id = p_provider_operation_id/);
  assert.match(body, /live_email\.message_delivery_id = p_message_delivery_id/);
  // An unknown channel must not fall through to visible.
  assert.match(body, /ELSE false END/);
});

test('the inbox read paths no longer touch protected live evidence tables', async () => {
  for (const [label, url] of [
    ['inbox read model', readModelUrl],
    ['conversion inbox thread service', threadServiceUrl],
  ] as const) {
    const source = await readFile(url, 'utf8');
    for (const table of PROTECTED_TABLES) {
      assert.doesNotMatch(
        source,
        new RegExp(`app\\.${table}`),
        `${label} must not read app.${table} under r72_web`,
      );
    }
    // Mailgun receipts are readable by r72_web from 0050 and Lead 360 still uses
    // that grant, but the inbox paths route through the boundary regardless.
    assert.doesNotMatch(source, /app\.property_predator_mailgun_inbound_receipts/);
  }
});

test('the inbox read paths call the bounded functions instead', async () => {
  const readModel = await readFile(readModelUrl, 'utf8');
  const threadService = await readFile(threadServiceUrl, 'utf8');
  assert.match(
    readModel,
    /app_private\.operational_inbox_live_conversation_visible\(\s*conversation\.workspace_id, conversation\.id, conversation\.channel/,
  );
  for (const call of [
    /app_private\.operational_inbox_live_conversation_visible\(/,
    /app_private\.operational_inbox_live_message_provenance\(/,
    /app_private\.operational_inbox_live_delivery_linked\(/,
  ]) {
    assert.match(threadService, call);
  }
  // Test conversations must bypass the live gate entirely, which is what keeps
  // the existing test rail visible and unaffected by this repair.
  assert.match(
    readModel,
    /conversation\.environment = 'test'\s*OR \(\s*conversation\.environment = 'live'\s*AND app_private\.operational_inbox_live_conversation_visible/,
  );
});
