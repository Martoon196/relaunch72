import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0016_property_predator_growth_evidence.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

const evidenceTables = [
  'contact_source_identities',
  'content_consumption_facts',
  'offer_presentation_facts',
  'offer_response_facts',
  'contact_attribution_facts',
] as const;

test('0016 creates and registers one forced-RLS Growth HQ evidence boundary', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const createdAppTables = [...sql.matchAll(/CREATE TABLE app\.([a-z_]+) \(/g)]
    .map((match) => match[1]!);
  assert.deepEqual(createdAppTables, evidenceTables);
  assert.match(sql, /CREATE TABLE app_private\.external_event_projection_receipts \(/);

  const rls = /DO \$evidence_rls\$(.*?)\$evidence_rls\$;/.exec(sql)?.[1];
  assert.ok(rls);
  assert.match(rls, /ALTER TABLE app\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(rls, /ALTER TABLE app\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(rls, /FOR ALL TO r72_owner USING \(true\) WITH CHECK \(true\)/);
  assert.match(rls, /FOR SELECT TO r72_web USING/);
  assert.match(rls, /app_private\.has_active_workspace_membership/);
  assert.match(rls, /FOR SELECT TO r72_webhook/);
  assert.match(rls, /FOR INSERT TO r72_webhook/);
  assert.match(rls, /app_private\.current_actor_kind\(\) = ''webhook''/);

  for (const table of evidenceTables) {
    const definition = new RegExp(`CREATE TABLE app\\.${table} \\((.*?)\\);`)
      .exec(sql)?.[1];
    assert.ok(definition, `${table} has a table definition`);
    assert.match(definition, /workspace_id uuid NOT NULL/);
    assert.match(definition, /UNIQUE \(workspace_id, id\)/);
    assert.match(rls, new RegExp(`'${table}'`));
    assert.match(sql, new RegExp(`\\('app', '${table}', 'workspace_id'\\)`));
  }

  assert.match(sql, /ALTER TABLE app_private\.external_event_projection_receipts ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE app_private\.external_event_projection_receipts FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /\('app_private', 'external_event_projection_receipts', 'workspace_id'\)/);
});

test('0016 pins every projection and evidence fact to exact authenticated source bytes', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const recorder = /CREATE OR REPLACE FUNCTION app_private\.record_external_event_shadow_receipt\((.*?)\$function\$;/
    .exec(sql)?.[1];
  const projection = /CREATE TABLE app_private\.external_event_projection_receipts \((.*?)\);/
    .exec(sql)?.[1];
  assert.ok(recorder);
  assert.ok(projection);
  for (const eventType of [
    'content.consumption.progressed',
    'content.consumption.completed',
    'offer.presented',
    'offer.responded',
  ]) {
    assert.match(sql, new RegExp(`'${eventType.replaceAll('.', '\\.')}'`));
    assert.match(recorder, new RegExp(`'${eventType.replaceAll('.', '\\.')}'`));
    assert.match(projection, new RegExp(`'${eventType.replaceAll('.', '\\.')}'`));
  }
  assert.match(recorder, /SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(recorder, /INSERT INTO app_private\.external_event_shadow_receipts/);
  assert.doesNotMatch(recorder, /(?:INSERT INTO|UPDATE|DELETE FROM) app\./);
  assert.match(sql, /GRANT CREATE ON SCHEMA app_private TO r72_external_event_definer/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private FROM r72_external_event_definer/);
  assert.match(projection, /UNIQUE \(workspace_id, source, event_id\)/);
  assert.match(
    projection,
    /FOREIGN KEY \( workspace_id, source, event_id, event_type, subject_kind, subject_id, payload_sha256 \) REFERENCES app_private\.external_event_shadow_receipts \( workspace_id, source, event_id, event_type, subject_kind, subject_id, payload_sha256 \) ON DELETE RESTRICT/,
  );
  assert.match(sql, /ADD CONSTRAINT external_event_shadow_receipts_projection_identity_uq UNIQUE \( workspace_id, source, event_id, event_type, subject_kind, subject_id, payload_sha256 \)/);
  assert.match(projection, /payload_sha256 bytea NOT NULL CHECK \(octet_length\(payload_sha256\) = 32\)/);
  assert.match(projection, /request_id text NOT NULL CHECK/);

  for (const table of evidenceTables) {
    const definition = new RegExp(`CREATE TABLE app\\.${table} \\((.*?)\\);`)
      .exec(sql)?.[1];
    assert.ok(definition);
    assert.match(definition, /projection_receipt_id uuid NOT NULL/);
    assert.match(definition, /source_system text NOT NULL CHECK/);
    assert.match(definition, /source_event_id uuid NOT NULL/);
    assert.match(definition, /source_event_type text NOT NULL/);
    assert.match(
      definition,
      /source_payload_sha256 bytea NOT NULL CHECK \(octet_length\(source_payload_sha256\) = 32\)/,
    );
    assert.match(
      definition,
      /REFERENCES app_private\.external_event_projection_receipts/,
    );
    assert.match(
      definition,
      /projection_receipt_id, source_system, source_event_id, source_event_type/,
    );
    assert.match(
      definition,
      /id, source, event_id, event_type/,
    );
  }

  assert.match(
    sql,
    /CREATE POLICY external_event_projection_receipts_webhook_insert[^;]+request_id = app_private\.current_request_id\(\)/,
  );
});

test('0016 records exact content, offer, response, and attribution evidence', async () => {
  const rawSql = await readFile(migrationUrl, 'utf8');
  const sql = normalise(rawSql);
  const sourceIdentity = /CREATE TABLE app\.contact_source_identities \((.*?)\);/
    .exec(sql)?.[1];
  const content = /CREATE TABLE app\.content_consumption_facts \((.*?)\);/
    .exec(sql)?.[1];
  const presentation = /CREATE TABLE app\.offer_presentation_facts \((.*?)\);/
    .exec(sql)?.[1];
  const response = /CREATE TABLE app\.offer_response_facts \((.*?)\);/
    .exec(sql)?.[1];
  const attribution = /CREATE TABLE app\.contact_attribution_facts \((.*?)\);/
    .exec(sql)?.[1];
  assert.ok(sourceIdentity);
  assert.ok(content);
  assert.ok(presentation);
  assert.ok(response);
  assert.ok(attribution);

  assert.match(content, /medium IN \('video', 'audio', 'article', 'document', 'other'\)/);
  assert.match(content, /action IN \('started', 'progressed', 'completed', 'downloaded'\)/);
  assert.match(content, /progress_basis_points smallint CHECK \( progress_basis_points BETWEEN 0 AND 10000 \)/);
  assert.match(content, /progress_seconds integer CHECK \(progress_seconds >= 0\)/);
  assert.match(content, /action <> 'completed' OR progress_basis_points IS NOT NULL AND progress_basis_points = 10000/);
  assert.match(sourceIdentity, /source_event_type text NOT NULL CHECK \(source_event_type = 'identity\.account\.created'\)/);
  assert.match(content, /source_event_type IN \( 'content\.consumption\.progressed', 'content\.consumption\.completed' \)/);
  const contentEventGate = /CHECK \( \(source_event_type = 'content\.consumption\.progressed'(.*?)\) \)/
    .exec(content)?.[0];
  assert.ok(contentEventGate);
  assert.match(contentEventGate, /action = 'progressed'/);
  assert.match(contentEventGate, /source_event_type = 'content\.consumption\.completed'/);
  assert.match(contentEventGate, /action = 'completed'/);
  assert.doesNotMatch(contentEventGate, /action = '(?:started|downloaded)'/);
  for (const field of ['content_key', 'content_version', 'content_label']) {
    assert.match(content, new RegExp(`${field} text NOT NULL`));
  }
  assert.match(content, /content_key ~ '\^\[a-z0-9\]/, 'database accepts the contract’s digit-leading keys');

  for (const field of [
    'offer_key', 'offer_version', 'product_key', 'offer_label', 'price_minor', 'currency', 'placement',
  ]) {
    assert.match(presentation, new RegExp(`${field} (?:text|bigint) NOT NULL`));
  }
  assert.match(presentation, /price_minor bigint NOT NULL CHECK \(price_minor >= 0\)/);
  assert.match(presentation, /offer_key ~ '\^\[a-z0-9\]/);
  assert.match(presentation, /product_key ~ '\^\[a-z0-9\]/);
  assert.match(presentation, /placement ~ '\^\[a-z0-9\]/);
  assert.match(presentation, /currency text NOT NULL CHECK \(currency ~ '\^\[A-Z\]\{3\}\$'\)/);
  assert.match(rawSql, /wire contract is canonical lowercase; the projector must normalize/);
  assert.match(presentation, /source_event_type text NOT NULL CHECK \(source_event_type = 'offer\.presented'\)/);
  assert.match(
    response,
    /response IN \('accepted', 'declined', 'deferred', 'requested_contact'\)/,
  );
  assert.doesNotMatch(response, /response IN \([^)]*'presented'/);
  assert.match(response, /source_event_type text NOT NULL CHECK \(source_event_type = 'offer\.responded'\)/);
  assert.match(
    response,
    /FOREIGN KEY \( workspace_id, offer_presentation_id, contact_id, contact_source_identity_id, source_system, source_subject_id \) REFERENCES app\.offer_presentation_facts \( workspace_id, id, contact_id, contact_source_identity_id, source_system, source_subject_id \) ON DELETE RESTRICT/,
  );

  assert.match(attribution, /attribution_type IN \( 'first_touch', 'last_touch', 'lead_creation', 'conversion_touch', 'self_reported', 'affiliate_referral', 'other' \)/);
  for (const field of [
    'channel', 'attribution_model', 'referral_code',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
    'utm_content', 'referrer_url', 'landing_url',
  ]) {
    assert.match(attribution, new RegExp(`${field} text`));
  }
  assert.match(attribution, /affiliate_id uuid/);
  assert.match(attribution, /attribution_model = 'last_click'/);
  assert.match(attribution, /source_event_type text NOT NULL CHECK \(source_event_type = 'affiliate\.referral\.attributed'\)/);
});

test('0016 is append-only for runtimes and leaves the 0015 ingress role table-blind', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));

  for (const table of [...evidenceTables, 'external_event_projection_receipts']) {
    assert.doesNotMatch(
      sql,
      new RegExp(`GRANT (?:UPDATE|DELETE)[^;]*(?:app|app_private)\\.${table}`),
    );
    assert.doesNotMatch(
      sql,
      new RegExp(`CREATE POLICY [^;]+ ON (?:app|app_private)\\.${table} FOR (?:UPDATE|DELETE)`),
    );
  }

  assert.match(sql, /GRANT SELECT ON[^;]+TO r72_web, r72_webhook/);
  assert.match(sql, /GRANT INSERT ON[^;]+TO r72_webhook/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE)[^;]+TO [^;]*\br72_web\b/);
  assert.doesNotMatch(
    sql,
    /GRANT [^;]+app_private\.external_event_projection_receipts[^;]+TO [^;]*\br72_web\b/,
  );
  assert.doesNotMatch(sql, /GRANT [^;]+ TO [^;]*\br72_external_event_command\b/);
  assert.doesNotMatch(
    sql,
    /GRANT [^;]+app_private\.external_event_shadow_receipts[^;]+TO [^;]*\br72_webhook\b/,
  );
  assert.match(sql, /DO \$external_event_command_table_audit\$/);
  assert.match(sql, /has_schema_privilege\( 'r72_external_event_command', 'app', 'USAGE' \)/);
  assert.match(sql, /unexpectedly has table privilege/);
});
