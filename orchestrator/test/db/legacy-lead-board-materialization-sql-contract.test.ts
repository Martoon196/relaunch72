import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0020_legacy_lead_journey_board_materialization.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

test('0020 exposes only a manager-validated materializer through a no-login definer', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE ROLE r72_legacy_materializer_definer NOLOGIN NOINHERIT/);
  assert.match(sql, /NOT rolbypassrls/);
  assert.match(sql, /Unsafe legacy materializer membership/);
  assert.match(sql, /Unsafe legacy materializer grant/);
  assert.match(sql, /CREATE FUNCTION app_private\.ensure_legacy_lead_board_opportunity/);
  assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(sql, /trusted_actor_kind IS DISTINCT FROM 'user'/);
  assert.match(sql, /app_private\.can_manage_workspace/);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION app_private\.ensure_legacy_lead_board_opportunity\( uuid, text, text \) TO r72_import_command/,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION app_private\.materialize_legacy_lead_board_opportunity\( uuid, uuid, text, text \) FROM PUBLIC, r72_import_command/,
  );
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*app\.opportunities[^;]*TO r72_import_command/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*legacy_lead_board_materializations[^;]*TO r72_import_command/);
});

test('0020 is contact-idempotent, source-provenance-bound and adopts before inserting', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const table = /CREATE TABLE app_private\.legacy_lead_board_materializations \((.*?)\);/.exec(sql)?.[1];
  const core = /CREATE FUNCTION app_private\.materialize_legacy_lead_board_opportunity\((.*?)\$function\$;/.exec(sql)?.[1];
  assert.ok(table && core);
  assert.match(table, /PRIMARY KEY \(workspace_id, contact_id\)/);
  assert.match(table, /UNIQUE \(workspace_id, opportunity_id\)/);
  assert.match(table, /source_provenance_id uuid NOT NULL/);
  assert.match(table, /REFERENCES app\.contact_import_provenance/);
  assert.match(core, /provenance\.workspace_id = p_workspace_id/);
  assert.match(core, /provenance\.contact_id = p_contact_id/);
  assert.match(core, /provenance\.source_system = p_source_system/);
  assert.match(core, /provenance\.source_record_id = p_source_record_id/);
  assert.match(core, /JOIN app\.workspaces AS workspace ON workspace\.id = provenance\.workspace_id/);
  assert.match(core, /0, workspace_currency, 0, NULL/);
  assert.doesNotMatch(core, /'GBP'/);
  assert.match(core, /pg_advisory_xact_lock/);
  const existingLookup = core.indexOf('FROM app.opportunities AS opportunity');
  const opportunityInsert = core.indexOf('INSERT INTO app.opportunities');
  assert.ok(existingLookup >= 0 && opportunityInsert > existingLookup);
  assert.match(core, /ON CONFLICT \(workspace_id, contact_id\) DO UPDATE/);
});

test('0020 uses configured default topology and records a blocked outcome instead of inventing it', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /pipeline\.is_default AND pipeline\.status = 'active'/);
  assert.match(sql, /stage\.stage_type = 'open' AND NOT stage\.is_terminal ORDER BY stage\.position, stage\.id LIMIT 1/);
  assert.match(sql, /'default_pipeline_missing'/);
  assert.match(sql, /'first_open_stage_missing'/);
  assert.match(sql, /last_disposition IN \('created', 'existing', 'blocked'\)/);
  assert.match(sql, /ALTER TABLE app_private\.legacy_lead_board_materializations FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /\('app_private', 'legacy_lead_board_materializations', 'workspace_id'\)/);
  assert.doesNotMatch(sql, /INSERT INTO app\.pipelines/);
  assert.doesNotMatch(sql, /INSERT INTO app\.pipeline_stages/);
  assert.doesNotMatch(sql, /INSERT INTO app\.outbox_events/);
  assert.doesNotMatch(sql, /INSERT INTO app\.opportunity_stage_history/);
  assert.doesNotMatch(sql, /INSERT INTO app\.activities/);
});

test('0020 backfills the earliest exact provenance for every already imported contact', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  const backfill = /DO \$legacy_board_backfill\$(.*?)\$legacy_board_backfill\$;/.exec(sql)?.[1];
  assert.ok(backfill);
  assert.match(backfill, /SELECT DISTINCT ON \(provenance\.workspace_id, provenance\.contact_id\)/);
  assert.match(backfill, /FROM app\.contact_import_provenance AS provenance/);
  assert.match(backfill, /ORDER BY provenance\.workspace_id, provenance\.contact_id, provenance\.original_created_at, provenance\.id/);
  assert.match(backfill, /app_private\.materialize_legacy_lead_board_opportunity/);
});
