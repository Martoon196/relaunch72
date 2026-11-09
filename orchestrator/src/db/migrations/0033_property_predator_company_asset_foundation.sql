-- Property Predator company assets: immutable, workspace-scoped metadata-only
-- releases, hash-only offline evaluation evidence, founder decisions and dark
-- reconciliation facts. No content, prompt, knowledge, customer/private body,
-- asset bytes, credentials or provider-operation capability is stored here.

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app_private FROM r72_content_adapter, r72_content_command;
GRANT USAGE ON SCHEMA app_private TO r72_content_adapter, r72_content_command;
GRANT EXECUTE ON FUNCTION
  app_private.current_workspace_id(),
  app_private.current_user_id(),
  app_private.current_request_id(),
  app_private.has_active_workspace_membership(uuid, uuid),
  app_private.can_manage_workspace(uuid, uuid)
TO r72_content_adapter, r72_content_command;

CREATE TABLE app_private.company_asset_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  release_id text NOT NULL CHECK (
    release_id = 'property-predator.company-content-growth-hq/v1'
  ),
  source_system text NOT NULL CHECK (source_system = 'property-predator'),
  source_commit text NOT NULL CHECK (
    source_commit = 'b5986c94d0f8690236c9f290ba14b49cc978e887'
  ),
  generated_at timestamptz NOT NULL,
  release_sha256 bytea NOT NULL CHECK (octet_length(release_sha256) = 32),
  source_catalog_sha256 bytea NOT NULL CHECK (octet_length(source_catalog_sha256) = 32),
  scope_sha256 bytea NOT NULL CHECK (octet_length(scope_sha256) = 32),
  runtime_brand_sha256 bytea NOT NULL CHECK (octet_length(runtime_brand_sha256) = 32),
  brand_brain_package_sha256 bytea NOT NULL CHECK (
    octet_length(brand_brain_package_sha256) = 32
  ),
  approved_item_count integer NOT NULL CHECK (approved_item_count BETWEEN 0 AND 500),
  generation_mode text NOT NULL DEFAULT 'simulated_draft_only' CHECK (
    generation_mode = 'simulated_draft_only'
  ),
  ownership_mode text NOT NULL DEFAULT 'company_owned' CHECK (
    ownership_mode = 'company_owned'
  ),
  affiliate_input text NOT NULL DEFAULT 'forbidden' CHECK (affiliate_input = 'forbidden'),
  session_input text NOT NULL DEFAULT 'forbidden' CHECK (session_input = 'forbidden'),
  customer_input text NOT NULL DEFAULT 'forbidden' CHECK (customer_input = 'forbidden'),
  customer_private_data_input text NOT NULL DEFAULT 'forbidden' CHECK (
    customer_private_data_input = 'forbidden'
  ),
  private_data_input text NOT NULL DEFAULT 'forbidden' CHECK (
    private_data_input = 'forbidden'
  ),
  raw_prompt_input text NOT NULL DEFAULT 'forbidden' CHECK (raw_prompt_input = 'forbidden'),
  raw_knowledge_input text NOT NULL DEFAULT 'forbidden' CHECK (
    raw_knowledge_input = 'forbidden'
  ),
  hq_human_approval_required boolean NOT NULL DEFAULT true CHECK (
    hq_human_approval_required IS TRUE
  ),
  model_calls boolean NOT NULL DEFAULT false CHECK (model_calls IS FALSE),
  source_calls boolean NOT NULL DEFAULT false CHECK (source_calls IS FALSE),
  provider_effects boolean NOT NULL DEFAULT false CHECK (provider_effects IS FALSE),
  publish_effects boolean NOT NULL DEFAULT false CHECK (publish_effects IS FALSE),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (
    workspace_id, id, release_sha256, source_catalog_sha256, scope_sha256,
    runtime_brand_sha256, brand_brain_package_sha256
  ),
  UNIQUE (workspace_id, release_sha256, scope_sha256),
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (generated_at <= recorded_at + interval '30 seconds')
);

CREATE TABLE app_private.company_asset_release_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  release_sha256 bytea NOT NULL CHECK (octet_length(release_sha256) = 32),
  source_catalog_sha256 bytea NOT NULL CHECK (octet_length(source_catalog_sha256) = 32),
  scope_sha256 bytea NOT NULL CHECK (octet_length(scope_sha256) = 32),
  runtime_brand_sha256 bytea NOT NULL CHECK (octet_length(runtime_brand_sha256) = 32),
  brand_brain_package_sha256 bytea NOT NULL CHECK (
    octet_length(brand_brain_package_sha256) = 32
  ),
  item_ordinal integer NOT NULL CHECK (item_ordinal BETWEEN 1 AND 500),
  item_id text NOT NULL CHECK (
    item_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  item_type text NOT NULL CHECK (item_type IN ('asset', 'generated', 'media')),
  item_version integer NOT NULL CHECK (item_version BETWEEN 1 AND 2147483647),
  version_id text NOT NULL CHECK (
    version_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  ),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  blob_sha256 bytea CHECK (blob_sha256 IS NULL OR octet_length(blob_sha256) = 32),
  brand_sha256 bytea NOT NULL CHECK (octet_length(brand_sha256) = 32),
  content_resource_path text NOT NULL CHECK (
    content_resource_path = '/api/internal/company-content/versions/' || version_id
  ),
  asset_resource_path text,
  affiliate_mode text NOT NULL CHECK (affiliate_mode = 'forbidden'),
  approval_id text NOT NULL CHECK (
    approval_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  approved_at timestamptz NOT NULL,
  approval_expires_at timestamptz CHECK (approval_expires_at IS NULL),
  approval_expiry_status text NOT NULL CHECK (approval_expiry_status = 'missing'),
  content_mode text NOT NULL CHECK (content_mode = 'company-owned'),
  hq_use_status text NOT NULL CHECK (hq_use_status = 'review-required'),
  ownership_status text NOT NULL CHECK (
    ownership_status = 'source-asserted-company-owned'
  ),
  privacy_status text NOT NULL CHECK (
    privacy_status = 'customer-private-data-forbidden'
  ),
  quarantine_status text NOT NULL CHECK (
    quarantine_status = 'not-recorded-at-source'
  ),
  source_approval_status text NOT NULL CHECK (
    source_approval_status = 'source-approved-exact-version'
  ),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_release_id, id),
  UNIQUE (workspace_id, source_release_id, item_ordinal),
  UNIQUE (workspace_id, source_release_id, item_type, item_id),
  UNIQUE (workspace_id, source_release_id, version_id),
  UNIQUE (
    workspace_id, source_release_id, id, content_sha256, brand_sha256
  ),
  FOREIGN KEY (
    workspace_id, source_release_id, release_sha256, source_catalog_sha256,
    scope_sha256, runtime_brand_sha256, brand_brain_package_sha256
  ) REFERENCES app_private.company_asset_releases (
    workspace_id, id, release_sha256, source_catalog_sha256, scope_sha256,
    runtime_brand_sha256, brand_brain_package_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (approval_expiry_status IN ('current', 'expired') AND approval_expires_at IS NOT NULL)
    OR (approval_expiry_status IN ('missing', 'unknown') AND approval_expires_at IS NULL)
  ),
  CHECK (
    (item_type = 'asset'
      AND blob_sha256 IS NOT NULL
      AND asset_resource_path = '/api/internal/company-content/assets/' || version_id || '/file')
    OR (item_type <> 'asset' AND blob_sha256 IS NULL AND asset_resource_path IS NULL)
  )
);

CREATE TABLE app_private.company_asset_source_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  release_sha256 bytea NOT NULL CHECK (octet_length(release_sha256) = 32),
  source_catalog_sha256 bytea NOT NULL CHECK (octet_length(source_catalog_sha256) = 32),
  scope_sha256 bytea NOT NULL CHECK (octet_length(scope_sha256) = 32),
  runtime_brand_sha256 bytea NOT NULL CHECK (octet_length(runtime_brand_sha256) = 32),
  brand_brain_package_sha256 bytea NOT NULL CHECK (
    octet_length(brand_brain_package_sha256) = 32
  ),
  source_commit text NOT NULL CHECK (
    source_commit = 'b5986c94d0f8690236c9f290ba14b49cc978e887'
  ),
  attestation_sha256 bytea NOT NULL CHECK (octet_length(attestation_sha256) = 32),
  checked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  command_key_sha256 bytea NOT NULL CHECK (octet_length(command_key_sha256) = 32),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  UNIQUE (
    workspace_id, source_release_id, release_sha256, source_catalog_sha256,
    scope_sha256, runtime_brand_sha256, brand_brain_package_sha256, checked_at
  ),
  FOREIGN KEY (
    workspace_id, source_release_id, release_sha256, source_catalog_sha256,
    scope_sha256, runtime_brand_sha256, brand_brain_package_sha256
  ) REFERENCES app_private.company_asset_releases (
    workspace_id, id, release_sha256, source_catalog_sha256, scope_sha256,
    runtime_brand_sha256, brand_brain_package_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (checked_at >= recorded_at - interval '5 minutes'),
  CHECK (checked_at <= recorded_at + interval '30 seconds'),
  CHECK (expires_at > checked_at),
  CHECK (expires_at <= checked_at + interval '15 minutes')
);

CREATE TABLE app_private.company_asset_eval_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  release_sha256 bytea NOT NULL CHECK (octet_length(release_sha256) = 32),
  source_catalog_sha256 bytea NOT NULL CHECK (octet_length(source_catalog_sha256) = 32),
  scope_sha256 bytea NOT NULL CHECK (octet_length(scope_sha256) = 32),
  runtime_brand_sha256 bytea NOT NULL CHECK (octet_length(runtime_brand_sha256) = 32),
  brand_brain_package_sha256 bytea NOT NULL CHECK (
    octet_length(brand_brain_package_sha256) = 32
  ),
  suite_id text NOT NULL CHECK (suite_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  runner_version text NOT NULL CHECK (
    runner_version = 'property-predator-company-asset-offline-eval/v1'
  ),
  case_count integer NOT NULL CHECK (case_count BETWEEN 10 AND 100),
  golden_case_count integer NOT NULL CHECK (golden_case_count BETWEEN 5 AND 100),
  rejected_case_count integer NOT NULL CHECK (rejected_case_count BETWEEN 5 AND 100),
  passed_case_count integer NOT NULL CHECK (passed_case_count BETWEEN 0 AND 100),
  report_sha256 bytea NOT NULL CHECK (octet_length(report_sha256) = 32),
  model_calls boolean NOT NULL DEFAULT false CHECK (model_calls IS FALSE),
  provider_effects boolean NOT NULL DEFAULT false CHECK (provider_effects IS FALSE),
  command_key_sha256 bytea NOT NULL CHECK (octet_length(command_key_sha256) = 32),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_release_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  UNIQUE (workspace_id, source_release_id, report_sha256),
  FOREIGN KEY (
    workspace_id, source_release_id, release_sha256, source_catalog_sha256,
    scope_sha256, runtime_brand_sha256, brand_brain_package_sha256
  ) REFERENCES app_private.company_asset_releases (
    workspace_id, id, release_sha256, source_catalog_sha256, scope_sha256,
    runtime_brand_sha256, brand_brain_package_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (case_count = golden_case_count + rejected_case_count),
  CHECK (passed_case_count <= case_count)
);

CREATE TABLE app_private.company_asset_eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  eval_report_id uuid NOT NULL,
  case_id text NOT NULL CHECK (case_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  case_kind text NOT NULL CHECK (case_kind IN ('golden', 'rejected')),
  dimension text NOT NULL CHECK (
    dimension IN ('brand', 'avatar', 'claims', 'disclosure', 'visual_policy')
  ),
  input_sha256 bytea NOT NULL CHECK (octet_length(input_sha256) = 32),
  output_sha256 bytea NOT NULL CHECK (octet_length(output_sha256) = 32),
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  expected_disposition text NOT NULL CHECK (expected_disposition IN ('accept', 'reject')),
  observed_disposition text NOT NULL CHECK (observed_disposition IN ('accept', 'reject')),
  reason_code text NOT NULL CHECK (reason_code IN (
    'brand_style_match', 'brand_style_violation',
    'avatar_fit_match', 'avatar_fit_violation',
    'claims_supported', 'claims_unsubstantiated',
    'disclosure_present', 'disclosure_missing',
    'visual_policy_match', 'visual_policy_conflict'
  )),
  passed boolean GENERATED ALWAYS AS (
    expected_disposition = observed_disposition
  ) STORED,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, eval_report_id, case_id),
  FOREIGN KEY (workspace_id, source_release_id, eval_report_id)
    REFERENCES app_private.company_asset_eval_reports (
      workspace_id, source_release_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (case_kind = 'golden' AND expected_disposition = 'accept')
    OR (case_kind = 'rejected' AND expected_disposition = 'reject')
  ),
  CHECK (reason_code = CASE dimension
    WHEN 'brand' THEN CASE observed_disposition
      WHEN 'accept' THEN 'brand_style_match' ELSE 'brand_style_violation' END
    WHEN 'avatar' THEN CASE observed_disposition
      WHEN 'accept' THEN 'avatar_fit_match' ELSE 'avatar_fit_violation' END
    WHEN 'claims' THEN CASE observed_disposition
      WHEN 'accept' THEN 'claims_supported' ELSE 'claims_unsubstantiated' END
    WHEN 'disclosure' THEN CASE observed_disposition
      WHEN 'accept' THEN 'disclosure_present' ELSE 'disclosure_missing' END
    WHEN 'visual_policy' THEN CASE observed_disposition
      WHEN 'accept' THEN 'visual_policy_match' ELSE 'visual_policy_conflict' END
  END)
);

CREATE TABLE app_private.company_asset_founder_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  release_sha256 bytea NOT NULL CHECK (octet_length(release_sha256) = 32),
  source_catalog_sha256 bytea NOT NULL CHECK (octet_length(source_catalog_sha256) = 32),
  scope_sha256 bytea NOT NULL CHECK (octet_length(scope_sha256) = 32),
  runtime_brand_sha256 bytea NOT NULL CHECK (octet_length(runtime_brand_sha256) = 32),
  brand_brain_package_sha256 bytea NOT NULL CHECK (
    octet_length(brand_brain_package_sha256) = 32
  ),
  approval_id text NOT NULL CHECK (
    approval_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  approval_status text NOT NULL DEFAULT 'founder_approved' CHECK (
    approval_status = 'founder_approved'
  ),
  approval_authority text NOT NULL DEFAULT 'growth_hq_founder' CHECK (
    approval_authority = 'growth_hq_founder'
  ),
  hq_human_approval boolean NOT NULL DEFAULT true CHECK (hq_human_approval IS TRUE),
  approved_at timestamptz NOT NULL,
  approval_expires_at timestamptz NOT NULL,
  command_key_sha256 bytea NOT NULL CHECK (octet_length(command_key_sha256) = 32),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_release_id, id, scope_sha256),
  UNIQUE (workspace_id, approval_id),
  UNIQUE (workspace_id, command_key_sha256),
  FOREIGN KEY (
    workspace_id, source_release_id, release_sha256, source_catalog_sha256,
    scope_sha256, runtime_brand_sha256, brand_brain_package_sha256
  ) REFERENCES app_private.company_asset_releases (
    workspace_id, id, release_sha256, source_catalog_sha256, scope_sha256,
    runtime_brand_sha256, brand_brain_package_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (approval_expires_at > approved_at),
  CHECK (approved_at <= recorded_at + interval '5 minutes')
);

CREATE TABLE app_private.company_asset_quarantine_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  release_sha256 bytea NOT NULL CHECK (octet_length(release_sha256) = 32),
  scope_sha256 bytea NOT NULL CHECK (octet_length(scope_sha256) = 32),
  release_item_id uuid NOT NULL,
  item_content_sha256 bytea NOT NULL CHECK (octet_length(item_content_sha256) = 32),
  item_brand_sha256 bytea NOT NULL CHECK (octet_length(item_brand_sha256) = 32),
  decision_dimension text NOT NULL CHECK (
    decision_dimension IN ('visual_policy', 'claim', 'asset')
  ),
  decision_outcome text NOT NULL CHECK (decision_outcome IN ('clear', 'quarantined')),
  reason_code text NOT NULL CHECK (reason_code IN (
    'visual_policy_match', 'visual_policy_conflict',
    'claims_supported', 'claims_unsubstantiated', 'no_claims_present',
    'asset_integrity_verified', 'asset_integrity_failed', 'no_asset_payload'
  )),
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  command_key_sha256 bytea NOT NULL CHECK (octet_length(command_key_sha256) = 32),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  UNIQUE (workspace_id, source_release_id, release_item_id, decision_dimension),
  FOREIGN KEY (workspace_id, source_release_id)
    REFERENCES app_private.company_asset_releases (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, source_release_id, release_item_id,
    item_content_sha256, item_brand_sha256
  ) REFERENCES app_private.company_asset_release_items (
    workspace_id, source_release_id, id, content_sha256, brand_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (decision_dimension = 'visual_policy'
      AND (
        (decision_outcome = 'clear' AND reason_code = 'visual_policy_match')
        OR (decision_outcome = 'quarantined' AND reason_code = 'visual_policy_conflict')
      ))
    OR (decision_dimension = 'claim'
      AND (
        (decision_outcome = 'clear' AND reason_code IN ('claims_supported', 'no_claims_present'))
        OR (decision_outcome = 'quarantined' AND reason_code = 'claims_unsubstantiated')
      ))
    OR (decision_dimension = 'asset'
      AND (
        (decision_outcome = 'clear'
          AND reason_code IN ('asset_integrity_verified', 'no_asset_payload'))
        OR (decision_outcome = 'quarantined' AND reason_code = 'asset_integrity_failed')
      ))
  )
);

CREATE TABLE app_private.company_asset_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  release_sha256 bytea NOT NULL CHECK (octet_length(release_sha256) = 32),
  source_catalog_sha256 bytea NOT NULL CHECK (octet_length(source_catalog_sha256) = 32),
  scope_sha256 bytea NOT NULL CHECK (octet_length(scope_sha256) = 32),
  runtime_brand_sha256 bytea NOT NULL CHECK (octet_length(runtime_brand_sha256) = 32),
  brand_brain_package_sha256 bytea NOT NULL CHECK (
    octet_length(brand_brain_package_sha256) = 32
  ),
  founder_approval_id uuid,
  eval_report_id uuid,
  evaluated_at timestamptz NOT NULL,
  domain_reconciliation_sha256 bytea NOT NULL CHECK (
    octet_length(domain_reconciliation_sha256) = 32
  ),
  status text NOT NULL DEFAULT 'review_required' CHECK (
    status IN ('reconciled', 'review_required')
  ),
  reconciliation_reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (
    reconciliation_reason_codes <@ ARRAY[
      'founder_approval_missing', 'founder_approval_not_yet_effective',
      'founder_approval_expired'
    ]::text[]
  ),
  usability_reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (
    usability_reason_codes <@ ARRAY[
      'hq_human_approval_required', 'source_material_missing',
      'source_approval_missing', 'source_approval_unknown',
      'source_approval_unapproved', 'source_approval_expired',
      'source_approval_expiry_missing', 'source_approval_expiry_unknown',
      'source_approval_expired_by_time', 'source_quarantine_unknown',
      'source_quarantined'
    ]::text[]
  ),
  guard_reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (
    guard_reason_codes <@ ARRAY[
      'release_projection_incomplete', 'source_attestation_missing_or_expired',
      'evaluation_missing_or_failed', 'quarantine_decision_missing',
      'quarantine_decision_quarantined'
    ]::text[]
  ),
  approved_scope_sha256 bytea CHECK (
    approved_scope_sha256 IS NULL OR octet_length(approved_scope_sha256) = 32
  ),
  usable boolean NOT NULL DEFAULT false,
  generation_mode text NOT NULL DEFAULT 'simulated_draft_only' CHECK (
    generation_mode = 'simulated_draft_only'
  ),
  model_calls boolean NOT NULL DEFAULT false CHECK (model_calls IS FALSE),
  source_calls boolean NOT NULL DEFAULT false CHECK (source_calls IS FALSE),
  provider_effects boolean NOT NULL DEFAULT false CHECK (provider_effects IS FALSE),
  publish_effects boolean NOT NULL DEFAULT false CHECK (publish_effects IS FALSE),
  command_key_sha256 bytea NOT NULL CHECK (octet_length(command_key_sha256) = 32),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  UNIQUE (workspace_id, source_release_id, domain_reconciliation_sha256, evaluated_at),
  FOREIGN KEY (
    workspace_id, source_release_id, release_sha256, source_catalog_sha256,
    scope_sha256, runtime_brand_sha256, brand_brain_package_sha256
  ) REFERENCES app_private.company_asset_releases (
    workspace_id, id, release_sha256, source_catalog_sha256, scope_sha256,
    runtime_brand_sha256, brand_brain_package_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, source_release_id, founder_approval_id, scope_sha256)
    REFERENCES app_private.company_asset_founder_approvals (
      workspace_id, source_release_id, id, scope_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, source_release_id, eval_report_id)
    REFERENCES app_private.company_asset_eval_reports (
      workspace_id, source_release_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE FUNCTION app_private.stamp_company_asset_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  NEW.workspace_id := app_private.current_workspace_id();
  NEW.recorded_by_user_id := app_private.current_user_id();
  NEW.recorded_request_id := app_private.current_request_id();
  NEW.recorded_at := statement_timestamp();
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.reject_company_asset_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Company asset metadata, evidence and decisions are append-only'
    USING ERRCODE = '55000';
END;
$function$;

CREATE FUNCTION app_private.guard_company_asset_item_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  parent app_private.company_asset_releases%ROWTYPE;
  existing_count bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'company-asset-release:' || NEW.workspace_id::text || ':' || NEW.source_release_id::text,
      7200331
    )
  );
  SELECT * INTO parent
  FROM app_private.company_asset_releases
  WHERE workspace_id = NEW.workspace_id AND id = NEW.source_release_id;
  IF parent.id IS NULL THEN
    RAISE EXCEPTION 'Company asset item release is missing' USING ERRCODE = '23503';
  END IF;
  IF NEW.brand_sha256 <> parent.runtime_brand_sha256
     OR NEW.runtime_brand_sha256 <> parent.runtime_brand_sha256 THEN
    RAISE EXCEPTION 'Company asset item brand hash is not the exact release brand'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO existing_count
  FROM app_private.company_asset_release_items
  WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id;
  IF existing_count >= parent.approved_item_count THEN
    RAISE EXCEPTION 'Company asset release cannot gain added material'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_company_asset_attestation_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  expected_count integer;
  actual_count bigint;
  minimum_ordinal integer;
  maximum_ordinal integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'company-asset-release:' || NEW.workspace_id::text || ':' || NEW.source_release_id::text,
      7200331
    )
  );
  SELECT approved_item_count INTO expected_count
  FROM app_private.company_asset_releases
  WHERE workspace_id = NEW.workspace_id AND id = NEW.source_release_id;
  SELECT count(*), min(item_ordinal), max(item_ordinal)
    INTO actual_count, minimum_ordinal, maximum_ordinal
  FROM app_private.company_asset_release_items
  WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id;
  IF expected_count IS NULL
     OR actual_count <> expected_count
     OR (expected_count > 0 AND (minimum_ordinal <> 1 OR maximum_ordinal <> expected_count))
     OR (expected_count = 0 AND (minimum_ordinal IS NOT NULL OR maximum_ordinal IS NOT NULL)) THEN
    RAISE EXCEPTION 'Company asset source attestation requires the exact complete item projection'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_company_asset_eval_case_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  expected_count integer;
  existing_count bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'company-asset-eval:' || NEW.workspace_id::text || ':' || NEW.eval_report_id::text,
      7200332
    )
  );
  SELECT case_count INTO expected_count
  FROM app_private.company_asset_eval_reports
  WHERE workspace_id = NEW.workspace_id
    AND source_release_id = NEW.source_release_id
    AND id = NEW.eval_report_id;
  IF expected_count IS NULL THEN
    RAISE EXCEPTION 'Company asset evaluation report is missing'
      USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_private.company_asset_reconciliations
    WHERE workspace_id = NEW.workspace_id AND eval_report_id = NEW.eval_report_id
  ) THEN
    RAISE EXCEPTION 'Company asset evaluation is sealed by reconciliation'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO existing_count
  FROM app_private.company_asset_eval_cases
  WHERE workspace_id = NEW.workspace_id AND eval_report_id = NEW.eval_report_id;
  IF existing_count >= expected_count THEN
    RAISE EXCEPTION 'Company asset evaluation cannot gain added cases'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_company_asset_quarantine_decision_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  item_record app_private.company_asset_release_items%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'company-asset-release:' || NEW.workspace_id::text || ':' || NEW.source_release_id::text,
      7200331
    )
  );
  SELECT * INTO item_record
  FROM app_private.company_asset_release_items
  WHERE workspace_id = NEW.workspace_id
    AND source_release_id = NEW.source_release_id
    AND id = NEW.release_item_id;
  IF item_record.id IS NULL
     OR item_record.release_sha256 <> NEW.release_sha256
     OR item_record.scope_sha256 <> NEW.scope_sha256
     OR item_record.content_sha256 <> NEW.item_content_sha256
     OR item_record.brand_sha256 <> NEW.item_brand_sha256 THEN
    RAISE EXCEPTION 'Company asset quarantine decision is not bound to the exact item tuple'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.decision_dimension = 'asset' THEN
    IF item_record.item_type = 'asset' AND NEW.reason_code = 'no_asset_payload' THEN
      RAISE EXCEPTION 'Asset items require exact asset integrity evidence'
        USING ERRCODE = '23514';
    END IF;
    IF item_record.item_type <> 'asset' AND NEW.reason_code <> 'no_asset_payload' THEN
      RAISE EXCEPTION 'Non-asset items cannot claim asset payload evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_company_asset_reconciliation_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  release_record app_private.company_asset_releases%ROWTYPE;
  approval_record app_private.company_asset_founder_approvals%ROWTYPE;
  report_record app_private.company_asset_eval_reports%ROWTYPE;
  item_count bigint;
  minimum_ordinal integer;
  maximum_ordinal integer;
  domain_reasons text[] := ARRAY[]::text[];
  usability_reasons text[] := ARRAY[]::text[];
  guard_reasons text[] := ARRAY[]::text[];
  expected_status text;
  evaluation_complete boolean := false;
  quarantine_missing boolean := false;
  quarantine_blocked boolean := false;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'company-asset-release:' || NEW.workspace_id::text || ':' || NEW.source_release_id::text,
      7200331
    )
  );
  IF NEW.eval_report_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'company-asset-eval:' || NEW.workspace_id::text || ':' || NEW.eval_report_id::text,
        7200332
      )
    );
  END IF;
  SELECT * INTO release_record
  FROM app_private.company_asset_releases
  WHERE workspace_id = NEW.workspace_id AND id = NEW.source_release_id;
  IF release_record.id IS NULL THEN
    RAISE EXCEPTION 'Company asset reconciliation release is missing'
      USING ERRCODE = '23503';
  END IF;

  SELECT count(*), min(item_ordinal), max(item_ordinal)
    INTO item_count, minimum_ordinal, maximum_ordinal
  FROM app_private.company_asset_release_items
  WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id;
  IF item_count <> release_record.approved_item_count
     OR (release_record.approved_item_count > 0
       AND (minimum_ordinal <> 1 OR maximum_ordinal <> release_record.approved_item_count))
     OR (release_record.approved_item_count = 0
       AND (minimum_ordinal IS NOT NULL OR maximum_ordinal IS NOT NULL)) THEN
    RAISE EXCEPTION 'Company asset reconciliation rejects missing or added material'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.founder_approval_id IS NULL THEN
    domain_reasons := array_append(domain_reasons, 'founder_approval_missing');
    NEW.approved_scope_sha256 := NULL;
  ELSE
    SELECT * INTO approval_record
    FROM app_private.company_asset_founder_approvals
    WHERE workspace_id = NEW.workspace_id
      AND source_release_id = NEW.source_release_id
      AND id = NEW.founder_approval_id
      AND release_sha256 = NEW.release_sha256
      AND source_catalog_sha256 = NEW.source_catalog_sha256
      AND scope_sha256 = NEW.scope_sha256
      AND runtime_brand_sha256 = NEW.runtime_brand_sha256
      AND brand_brain_package_sha256 = NEW.brand_brain_package_sha256;
    IF approval_record.id IS NULL THEN
      RAISE EXCEPTION 'Company asset reconciliation rejects changed, missing or unapproved scope'
        USING ERRCODE = '23514';
    END IF;
    NEW.approved_scope_sha256 := approval_record.scope_sha256;
    IF approval_record.approved_at > NEW.evaluated_at + interval '5 minutes' THEN
      domain_reasons := array_append(domain_reasons, 'founder_approval_not_yet_effective');
    END IF;
    IF approval_record.approval_expires_at <= NEW.evaluated_at THEN
      domain_reasons := array_append(domain_reasons, 'founder_approval_expired');
    END IF;
  END IF;
  expected_status := CASE WHEN cardinality(domain_reasons) = 0
    THEN 'reconciled' ELSE 'review_required' END;

  IF expected_status <> 'reconciled' THEN
    usability_reasons := array_append(usability_reasons, 'hq_human_approval_required');
  END IF;
  IF release_record.approved_item_count = 0 THEN
    usability_reasons := array_append(usability_reasons, 'source_material_missing');
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.company_asset_release_items
    WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id
      AND source_approval_status = 'missing') THEN
    usability_reasons := array_append(usability_reasons, 'source_approval_missing');
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.company_asset_release_items
    WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id
      AND source_approval_status = 'unknown') THEN
    usability_reasons := array_append(usability_reasons, 'source_approval_unknown');
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.company_asset_release_items
    WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id
      AND source_approval_status = 'unapproved') THEN
    usability_reasons := array_append(usability_reasons, 'source_approval_unapproved');
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.company_asset_release_items
    WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id
      AND source_approval_status IN ('expired', 'revoked')) THEN
    usability_reasons := array_append(usability_reasons, 'source_approval_expired');
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.company_asset_release_items
    WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id
      AND approval_expiry_status = 'missing') THEN
    usability_reasons := array_append(usability_reasons, 'source_approval_expiry_missing');
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.company_asset_release_items
    WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id
      AND approval_expiry_status = 'unknown') THEN
    usability_reasons := array_append(usability_reasons, 'source_approval_expiry_unknown');
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.company_asset_release_items
    WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id
      AND (approval_expiry_status = 'expired'
        OR (approval_expires_at IS NOT NULL AND approval_expires_at <= NEW.evaluated_at))) THEN
    usability_reasons := array_append(usability_reasons, 'source_approval_expired_by_time');
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.company_asset_release_items
    WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id
      AND quarantine_status IN ('not-recorded-at-source', 'unknown')) THEN
    usability_reasons := array_append(usability_reasons, 'source_quarantine_unknown');
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.company_asset_release_items
    WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id
      AND quarantine_status = 'quarantined') THEN
    usability_reasons := array_append(usability_reasons, 'source_quarantined');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.company_asset_source_attestations AS attestation
    WHERE attestation.workspace_id = NEW.workspace_id
      AND attestation.source_release_id = NEW.source_release_id
      AND attestation.release_sha256 = NEW.release_sha256
      AND attestation.source_catalog_sha256 = NEW.source_catalog_sha256
      AND attestation.scope_sha256 = NEW.scope_sha256
      AND attestation.runtime_brand_sha256 = NEW.runtime_brand_sha256
      AND attestation.brand_brain_package_sha256 = NEW.brand_brain_package_sha256
      AND attestation.checked_at <= NEW.evaluated_at
      AND attestation.expires_at > NEW.evaluated_at
  ) THEN
    guard_reasons := array_append(guard_reasons, 'source_attestation_missing_or_expired');
  END IF;

  IF NEW.eval_report_id IS NOT NULL THEN
    SELECT * INTO report_record
    FROM app_private.company_asset_eval_reports
    WHERE workspace_id = NEW.workspace_id
      AND source_release_id = NEW.source_release_id
      AND id = NEW.eval_report_id
      AND release_sha256 = NEW.release_sha256
      AND scope_sha256 = NEW.scope_sha256
      AND brand_brain_package_sha256 = NEW.brand_brain_package_sha256;
    IF report_record.id IS NULL THEN
      RAISE EXCEPTION 'Company asset reconciliation evaluation tuple changed'
        USING ERRCODE = '23514';
    END IF;
    SELECT
      count(*) = report_record.case_count
      AND count(*) FILTER (WHERE case_kind = 'golden') = report_record.golden_case_count
      AND count(*) FILTER (WHERE case_kind = 'rejected') = report_record.rejected_case_count
      AND count(*) FILTER (WHERE passed) = report_record.passed_case_count
      AND count(*) FILTER (WHERE passed) = report_record.case_count
      AND count(DISTINCT dimension || ':' || case_kind) = 10
      INTO evaluation_complete
    FROM app_private.company_asset_eval_cases
    WHERE workspace_id = NEW.workspace_id AND eval_report_id = NEW.eval_report_id;
  END IF;
  IF NOT evaluation_complete THEN
    guard_reasons := array_append(guard_reasons, 'evaluation_missing_or_failed');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.company_asset_release_items AS item
    CROSS JOIN (VALUES ('visual_policy'), ('claim'), ('asset')) AS required(dimension)
    WHERE item.workspace_id = NEW.workspace_id
      AND item.source_release_id = NEW.source_release_id
      AND NOT EXISTS (
        SELECT 1 FROM app_private.company_asset_quarantine_decisions AS decision
        WHERE decision.workspace_id = item.workspace_id
          AND decision.source_release_id = item.source_release_id
          AND decision.release_item_id = item.id
          AND decision.decision_dimension = required.dimension
      )
  ) INTO quarantine_missing;
  SELECT EXISTS (
    SELECT 1 FROM app_private.company_asset_quarantine_decisions
    WHERE workspace_id = NEW.workspace_id
      AND source_release_id = NEW.source_release_id
      AND decision_outcome = 'quarantined'
  ) INTO quarantine_blocked;
  IF quarantine_missing THEN
    guard_reasons := array_append(guard_reasons, 'quarantine_decision_missing');
  END IF;
  IF quarantine_blocked THEN
    guard_reasons := array_append(guard_reasons, 'quarantine_decision_quarantined');
  END IF;

  NEW.status := expected_status;
  NEW.reconciliation_reason_codes := domain_reasons;
  NEW.usability_reason_codes := usability_reasons;
  NEW.guard_reason_codes := guard_reasons;
  NEW.usable := expected_status = 'reconciled'
    AND cardinality(usability_reasons) = 0
    AND cardinality(guard_reasons) = 0;
  NEW.generation_mode := 'simulated_draft_only';
  NEW.model_calls := false;
  NEW.source_calls := false;
  NEW.provider_effects := false;
  NEW.publish_effects := false;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.stamp_company_asset_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reject_company_asset_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_company_asset_item_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_company_asset_attestation_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_company_asset_eval_case_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_company_asset_quarantine_decision_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_company_asset_reconciliation_insert() FROM PUBLIC;

DO $company_asset_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'company_asset_releases', 'company_asset_release_items',
    'company_asset_source_attestations', 'company_asset_eval_reports',
    'company_asset_eval_cases', 'company_asset_founder_approvals',
    'company_asset_quarantine_decisions', 'company_asset_reconciliations'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON app_private.%I
       FOR EACH ROW EXECUTE FUNCTION app_private.stamp_company_asset_insert()',
      table_name || '_stamp_insert', table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app_private.%I
       FOR EACH ROW EXECUTE FUNCTION app_private.reject_company_asset_mutation()',
      table_name || '_immutable', table_name
    );
  END LOOP;
END;
$company_asset_triggers$;

CREATE TRIGGER company_asset_release_item_exact_guard
BEFORE INSERT ON app_private.company_asset_release_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_asset_item_insert();

CREATE TRIGGER company_asset_source_attestation_projection_guard
BEFORE INSERT ON app_private.company_asset_source_attestations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_asset_attestation_insert();

CREATE TRIGGER company_asset_eval_case_projection_guard
BEFORE INSERT ON app_private.company_asset_eval_cases
FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_asset_eval_case_insert();

CREATE TRIGGER company_asset_quarantine_exact_guard
BEFORE INSERT ON app_private.company_asset_quarantine_decisions
FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_asset_quarantine_decision_insert();

CREATE TRIGGER company_asset_reconciliation_fact_guard
BEFORE INSERT ON app_private.company_asset_reconciliations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_asset_reconciliation_insert();

DO $company_asset_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'company_asset_releases', 'company_asset_release_items',
    'company_asset_source_attestations', 'company_asset_eval_reports',
    'company_asset_eval_cases', 'company_asset_founder_approvals',
    'company_asset_quarantine_decisions', 'company_asset_reconciliations'
  ]
  LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I FOR ALL TO r72_owner
       USING (true) WITH CHECK (true)',
      table_name || '_owner_all', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I
       FOR SELECT TO r72_content_adapter, r72_content_command
       USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), workspace_id
         )
       )',
      table_name || '_manager_select', table_name
    );
  END LOOP;
END;
$company_asset_rls$;

DO $company_asset_adapter_insert$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'company_asset_releases', 'company_asset_release_items',
    'company_asset_source_attestations', 'company_asset_eval_reports',
    'company_asset_eval_cases', 'company_asset_reconciliations'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I FOR INSERT TO r72_content_adapter
       WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND recorded_by_user_id = app_private.current_user_id()
         AND recorded_request_id = app_private.current_request_id()
         AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
       )',
      table_name || '_adapter_insert', table_name
    );
  END LOOP;
END;
$company_asset_adapter_insert$;

DO $company_asset_command_insert$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'company_asset_founder_approvals', 'company_asset_quarantine_decisions'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I FOR INSERT TO r72_content_command
       WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND recorded_by_user_id = app_private.current_user_id()
         AND recorded_request_id = app_private.current_request_id()
         AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
       )',
      table_name || '_command_insert', table_name
    );
  END LOOP;
END;
$company_asset_command_insert$;

GRANT SELECT ON
  app_private.company_asset_releases,
  app_private.company_asset_release_items,
  app_private.company_asset_source_attestations,
  app_private.company_asset_eval_reports,
  app_private.company_asset_eval_cases,
  app_private.company_asset_founder_approvals,
  app_private.company_asset_quarantine_decisions,
  app_private.company_asset_reconciliations
TO r72_content_adapter, r72_content_command;

GRANT INSERT ON
  app_private.company_asset_releases,
  app_private.company_asset_release_items,
  app_private.company_asset_source_attestations,
  app_private.company_asset_eval_reports,
  app_private.company_asset_eval_cases,
  app_private.company_asset_reconciliations
TO r72_content_adapter;

GRANT INSERT ON
  app_private.company_asset_founder_approvals,
  app_private.company_asset_quarantine_decisions
TO r72_content_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app_private', 'company_asset_releases', 'workspace_id'),
  ('app_private', 'company_asset_release_items', 'workspace_id'),
  ('app_private', 'company_asset_source_attestations', 'workspace_id'),
  ('app_private', 'company_asset_eval_reports', 'workspace_id'),
  ('app_private', 'company_asset_eval_cases', 'workspace_id'),
  ('app_private', 'company_asset_founder_approvals', 'workspace_id'),
  ('app_private', 'company_asset_quarantine_decisions', 'workspace_id'),
  ('app_private', 'company_asset_reconciliations', 'workspace_id');

DO $company_asset_capability_check$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'company_asset_releases', 'company_asset_release_items',
    'company_asset_source_attestations', 'company_asset_eval_reports',
    'company_asset_eval_cases', 'company_asset_founder_approvals',
    'company_asset_quarantine_decisions', 'company_asset_reconciliations'
  ]
  LOOP
    IF pg_catalog.has_table_privilege('r72_web', 'app_private.' || table_name, 'SELECT')
       OR pg_catalog.has_table_privilege('r72_web', 'app_private.' || table_name, 'INSERT')
       OR pg_catalog.has_table_privilege(
         'r72_content_adapter', 'app_private.' || table_name, 'UPDATE'
       )
       OR pg_catalog.has_table_privilege(
         'r72_content_adapter', 'app_private.' || table_name, 'DELETE'
       )
       OR pg_catalog.has_table_privilege(
         'r72_content_command', 'app_private.' || table_name, 'UPDATE'
       )
       OR pg_catalog.has_table_privilege(
         'r72_content_command', 'app_private.' || table_name, 'DELETE'
       ) THEN
      RAISE EXCEPTION 'Unsafe company asset capability on %', table_name;
    END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app_private.company_asset_founder_approvals', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app_private.company_asset_quarantine_decisions', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_command', 'app_private.company_asset_releases', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_command', 'app_private.company_asset_reconciliations', 'INSERT'
     ) THEN
    RAISE EXCEPTION 'Company asset staging and founder decision authority separation is not intact';
  END IF;

  IF pg_catalog.has_table_privilege('r72_content_adapter', 'app.provider_operations', 'INSERT')
     OR pg_catalog.has_table_privilege('r72_content_command', 'app.provider_operations', 'INSERT')
     OR pg_catalog.pg_has_role('r72_content_adapter', 'r72_worker', 'MEMBER')
     OR pg_catalog.pg_has_role('r72_content_command', 'r72_worker', 'MEMBER')
     OR pg_catalog.pg_has_role(
       'r72_content_adapter', 'r72_provider_operation_definer', 'MEMBER'
     )
     OR pg_catalog.pg_has_role(
       'r72_content_command', 'r72_provider_operation_definer', 'MEMBER'
     )
     OR pg_catalog.pg_has_role('r72_content_adapter', 'r72_content_command', 'MEMBER')
     OR pg_catalog.pg_has_role('r72_content_command', 'r72_content_adapter', 'MEMBER')
     OR pg_catalog.pg_has_role('r72_content_adapter', 'r72_owner', 'MEMBER')
     OR pg_catalog.pg_has_role('r72_content_command', 'r72_owner', 'MEMBER')
     OR pg_catalog.pg_has_role('r72_content_adapter', 'r72_security_definer', 'MEMBER')
     OR pg_catalog.pg_has_role('r72_content_command', 'r72_security_definer', 'MEMBER')
     THEN
    RAISE EXCEPTION 'Company asset roles unexpectedly have provider execution capability';
  END IF;
END;
$company_asset_capability_check$;

RESET ROLE;
