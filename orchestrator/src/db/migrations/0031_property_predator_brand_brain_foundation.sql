-- Property Predator Brand Brain: private hash-addressed source inventory,
-- independent HQ safety decisions, evaluation evidence and effects-off activation.
-- No prompt/knowledge/image bytes, provider credentials or execution capability
-- are stored or granted by this migration.

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app_private FROM r72_content_adapter, r72_content_command;
GRANT USAGE ON SCHEMA app_private TO r72_content_adapter, r72_content_command;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_request_id(),
  app_private.has_active_workspace_membership(uuid, uuid),
  app_private.can_write_workspace(uuid, uuid),
  app_private.can_manage_workspace(uuid, uuid)
TO r72_content_adapter, r72_content_command;

CREATE TABLE app_private.brand_brain_source_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  inventory_id text NOT NULL CHECK (inventory_id = 'property-predator.ai-inventory/v1'),
  source_system text NOT NULL CHECK (source_system = 'property-predator'),
  canonical_manifest text NOT NULL CHECK (
    octet_length(canonical_manifest) BETWEEN 2 AND 1048576
    AND jsonb_typeof(canonical_manifest::jsonb) = 'object'
  ),
  manifest_sha256 bytea GENERATED ALWAYS AS (
    public.digest(canonical_manifest, 'sha256')
  ) STORED,
  source_package_sha256 bytea NOT NULL CHECK (
    octet_length(source_package_sha256) = 32
    AND encode(source_package_sha256, 'hex') =
      'd55afac02ac995f6157749181cf230ea8acc23b7b129dd6f92f63bcd04b57300'
  ),
  runtime_brand_sha256 bytea NOT NULL CHECK (
    octet_length(runtime_brand_sha256) = 32
    AND encode(runtime_brand_sha256, 'hex') =
      'd77b0306d110075571dedd716d012c8752a302eb39ea9198e71ecd43cc089abc'
  ),
  source_count integer NOT NULL CHECK (source_count = 11),
  specialist_count integer NOT NULL CHECK (specialist_count = 6),
  artwork_count integer NOT NULL CHECK (artwork_count = 10),
  quarantine_count integer NOT NULL CHECK (quarantine_count = 1),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, manifest_sha256),
  UNIQUE (workspace_id, source_system, inventory_id, source_package_sha256),
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (manifest_sha256 = source_package_sha256)
);

CREATE TABLE app_private.brand_brain_source_version_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  source_id text NOT NULL CHECK (
    source_id = btrim(source_id) AND length(source_id) BETWEEN 1 AND 200
    AND source_id IN (
      'ai-brief-grounding', 'brand-bible', 'legacy-admin-image-style',
      'production-kit', 'propertypredator-owned-content-policy/v1',
      'propertypredator-owned-content-role/ad/v1',
      'propertypredator-owned-content-role/content/v1',
      'propertypredator-owned-content-role/email/v1',
      'propertypredator-owned-content-role/image/v1',
      'propertypredator-owned-content-role/social/v1',
      'propertypredator-owned-content-role/video/v1'
    )
  ),
  asset_role text NOT NULL CHECK (
    asset_role IN ('knowledge', 'instruction', 'visual-reference')
  ),
  authority_status text NOT NULL CHECK (
    authority_status IN ('authoritative-runtime', 'reference-only', 'legacy-conflicting')
  ),
  repository_path text NOT NULL CHECK (
    repository_path = btrim(repository_path)
    AND length(repository_path) BETWEEN 1 AND 500
    AND repository_path !~ '(^/|\\\\|(^|/)\.\.?(?:/|$)|^[A-Za-z]:)'
  ),
  locator_kind text NOT NULL CHECK (locator_kind IN ('file', 'python-symbol')),
  source_symbol text CHECK (
    source_symbol IS NULL OR (
      source_symbol = btrim(source_symbol) AND length(source_symbol) BETWEEN 1 AND 200
    )
  ),
  media_type text NOT NULL CHECK (
    media_type = lower(btrim(media_type))
    AND media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
  ),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 104857600),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  supplied_by text NOT NULL CHECK (supplied_by = 'property-predator-repository'),
  ownership_status text NOT NULL CHECK (ownership_status = 'source-asserted-company-owned'),
  licence_status text NOT NULL CHECK (licence_status = 'hq-review-required'),
  privacy_class text NOT NULL CHECK (privacy_class = 'company-internal'),
  consumer_use text NOT NULL CHECK (consumer_use IN (
    'runtime-authority-reference',
    'reference-only-not-runtime-profile-input',
    'quarantine-only'
  )),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_release_id, source_id),
  UNIQUE (workspace_id, source_release_id, id, source_id, content_sha256, consumer_use),
  FOREIGN KEY (workspace_id, source_release_id)
    REFERENCES app_private.brand_brain_source_releases (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (locator_kind = 'file' AND source_symbol IS NULL)
    OR (locator_kind = 'python-symbol' AND source_symbol IS NOT NULL)
  ),
  CHECK (
    (authority_status = 'authoritative-runtime' AND consumer_use = 'runtime-authority-reference')
    OR (authority_status = 'reference-only' AND consumer_use = 'reference-only-not-runtime-profile-input')
    OR (authority_status = 'legacy-conflicting' AND consumer_use = 'quarantine-only')
  )
);

CREATE TABLE app_private.brand_brain_specialist_profile_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  profile_id text NOT NULL CHECK (
    profile_id = btrim(profile_id)
    AND length(profile_id) BETWEEN 1 AND 200
    AND profile_id IN (
      'propertypredator.owned.social/v1', 'propertypredator.owned.content/v1',
      'propertypredator.owned.image/v1', 'propertypredator.owned.email/v1',
      'propertypredator.owned.video/v1', 'propertypredator.owned.ad/v1'
    )
  ),
  profile_name text NOT NULL CHECK (
    profile_name = btrim(profile_name) AND length(profile_name) BETWEEN 1 AND 200
  ),
  capabilities jsonb NOT NULL CHECK (
    jsonb_typeof(capabilities) = 'array'
    AND jsonb_array_length(capabilities) BETWEEN 1 AND 20
    AND octet_length(capabilities::text) <= 4096
  ),
  runtime_brand_sha256 bytea NOT NULL CHECK (
    octet_length(runtime_brand_sha256) = 32
    AND encode(runtime_brand_sha256, 'hex') =
      'd77b0306d110075571dedd716d012c8752a302eb39ea9198e71ecd43cc089abc'
  ),
  source_status text NOT NULL CHECK (source_status = 'source-current'),
  hq_activation_status text NOT NULL CHECK (hq_activation_status = 'review-required'),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_release_id, profile_id),
  UNIQUE (workspace_id, source_release_id, id, profile_id, runtime_brand_sha256),
  FOREIGN KEY (workspace_id, source_release_id)
    REFERENCES app_private.brand_brain_source_releases (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app_private.brand_brain_specialist_source_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  specialist_profile_ref_id uuid NOT NULL,
  source_version_ref_id uuid NOT NULL,
  reference_kind text NOT NULL CHECK (
    reference_kind IN ('role', 'policy', 'instruction', 'knowledge')
  ),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (
    workspace_id, source_release_id, specialist_profile_ref_id,
    source_version_ref_id, reference_kind
  ),
  FOREIGN KEY (workspace_id, source_release_id, specialist_profile_ref_id)
    REFERENCES app_private.brand_brain_specialist_profile_refs (
      workspace_id, source_release_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, source_release_id, source_version_ref_id)
    REFERENCES app_private.brand_brain_source_version_refs (
      workspace_id, source_release_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app_private.brand_brain_artwork_version_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  asset_id text NOT NULL CHECK (
    asset_id = btrim(asset_id) AND length(asset_id) BETWEEN 1 AND 200
    AND asset_id IN (
      'brand-app-icon', 'brand-avatar', 'brand-mark', 'brand-og-banner',
      'feature-apex-gdv', 'feature-covenant-shield', 'feature-max-offer-solver',
      'feature-owner-x-ray', 'feature-predator-verdict', 'feature-qs-grade-costing'
    )
  ),
  repository_path text NOT NULL CHECK (
    repository_path = btrim(repository_path)
    AND length(repository_path) BETWEEN 1 AND 500
    AND repository_path !~ '(^/|\\\\|(^|/)\.\.?(?:/|$)|^[A-Za-z]:)'
  ),
  media_type text NOT NULL CHECK (
    media_type = lower(btrim(media_type))
    AND media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
  ),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 104857600),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  purpose text NOT NULL CHECK (
    purpose = btrim(purpose) AND length(purpose) BETWEEN 1 AND 500
  ),
  source_approval_status text NOT NULL CHECK (
    source_approval_status = 'git-tracked-marketing-reference'
  ),
  hq_use_status text NOT NULL CHECK (hq_use_status = 'review-required'),
  supplied_by text NOT NULL CHECK (supplied_by = 'property-predator-repository'),
  ownership_status text NOT NULL CHECK (ownership_status = 'source-asserted-company-owned'),
  licence_status text NOT NULL CHECK (licence_status = 'hq-review-required'),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_release_id, asset_id),
  FOREIGN KEY (workspace_id, source_release_id)
    REFERENCES app_private.brand_brain_source_releases (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app_private.brand_brain_quarantines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  quarantine_id text NOT NULL CHECK (
    quarantine_id = btrim(quarantine_id) AND length(quarantine_id) BETWEEN 1 AND 200
    AND quarantine_id = 'legacy-black-panther-vs-current-no-animal/v1'
  ),
  status text NOT NULL CHECK (status = 'quarantined'),
  reason_code text NOT NULL CHECK (reason_code = 'visual-policy-conflict'),
  usable boolean NOT NULL CHECK (usable IS FALSE),
  resolution text NOT NULL CHECK (resolution = 'unresolved-founder-decision-required'),
  rule_ids jsonb NOT NULL CHECK (
    jsonb_typeof(rule_ids) = 'array'
    AND jsonb_array_length(rule_ids) BETWEEN 1 AND 50
    AND octet_length(rule_ids::text) <= 8192
  ),
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_release_id, quarantine_id),
  FOREIGN KEY (workspace_id, source_release_id)
    REFERENCES app_private.brand_brain_source_releases (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app_private.brand_brain_quarantine_source_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  quarantine_id uuid NOT NULL,
  source_version_ref_id uuid NOT NULL,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, source_release_id, quarantine_id, source_version_ref_id),
  FOREIGN KEY (workspace_id, source_release_id, quarantine_id)
    REFERENCES app_private.brand_brain_quarantines (
      workspace_id, source_release_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, source_release_id, source_version_ref_id)
    REFERENCES app_private.brand_brain_source_version_refs (
      workspace_id, source_release_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app_private.brand_brain_source_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  manifest_sha256 bytea NOT NULL CHECK (octet_length(manifest_sha256) = 32),
  checked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_release_id, manifest_sha256, checked_at),
  FOREIGN KEY (workspace_id, source_release_id, manifest_sha256)
    REFERENCES app_private.brand_brain_source_releases (
      workspace_id, id, manifest_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (checked_at >= recorded_at - interval '5 minutes'),
  CHECK (checked_at <= recorded_at + interval '30 seconds'),
  CHECK (expires_at > checked_at),
  CHECK (expires_at <= checked_at + interval '15 minutes')
);

CREATE TABLE app_private.brand_brain_eval_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  manifest_sha256 bytea NOT NULL CHECK (octet_length(manifest_sha256) = 32),
  eval_suite_sha256 bytea NOT NULL CHECK (
    octet_length(eval_suite_sha256) = 32
    AND encode(eval_suite_sha256, 'hex') =
      '88ca474133d36bbc4345f180e9045feb31d9ddec6b2bb0a5eb810c894f22de51'
  ),
  runner_version text NOT NULL CHECK (
    runner_version = 'property-predator-brand-brain-offline-eval/v1'
  ),
  positive_case_count integer NOT NULL CHECK (positive_case_count = 4),
  negative_case_count integer NOT NULL CHECK (negative_case_count = 5),
  passed_case_count integer NOT NULL CHECK (
    passed_case_count BETWEEN 0 AND positive_case_count + negative_case_count
  ),
  passed boolean NOT NULL,
  result_sha256 bytea NOT NULL CHECK (octet_length(result_sha256) = 32),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_release_id, manifest_sha256, eval_suite_sha256, runner_version),
  UNIQUE (workspace_id, source_release_id, id, manifest_sha256),
  UNIQUE (workspace_id, source_release_id, id, manifest_sha256, passed),
  FOREIGN KEY (workspace_id, source_release_id, manifest_sha256)
    REFERENCES app_private.brand_brain_source_releases (
      workspace_id, id, manifest_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    passed = (passed_case_count = positive_case_count + negative_case_count)
  )
);

CREATE TABLE app_private.brand_brain_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  manifest_sha256 bytea NOT NULL CHECK (octet_length(manifest_sha256) = 32),
  review_dimension text NOT NULL CHECK (review_dimension IN (
    'ownership_licence', 'privacy_security', 'brand_readiness'
  )),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decision_reason_code text CHECK (
    decision_reason_code IS NULL
    OR decision_reason_code ~ '^[a-z][a-z0-9_-]{0,99}$'
  ),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_release_id, review_dimension),
  UNIQUE (workspace_id, source_release_id, id, manifest_sha256),
  UNIQUE (
    workspace_id, source_release_id, id, manifest_sha256,
    review_dimension, decision
  ),
  FOREIGN KEY (workspace_id, source_release_id, manifest_sha256)
    REFERENCES app_private.brand_brain_source_releases (
      workspace_id, id, manifest_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (decision = 'approved' OR decision_reason_code IS NOT NULL)
);

CREATE TABLE app_private.brand_brain_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_release_id uuid NOT NULL,
  manifest_sha256 bytea NOT NULL CHECK (octet_length(manifest_sha256) = 32),
  eval_result_id uuid NOT NULL,
  ownership_decision_id uuid NOT NULL,
  privacy_decision_id uuid NOT NULL,
  brand_decision_id uuid NOT NULL,
  provider_effects boolean NOT NULL DEFAULT false CHECK (provider_effects IS FALSE),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_release_id),
  FOREIGN KEY (workspace_id, source_release_id, manifest_sha256)
    REFERENCES app_private.brand_brain_source_releases (
      workspace_id, id, manifest_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, source_release_id, eval_result_id, manifest_sha256)
    REFERENCES app_private.brand_brain_eval_results (
      workspace_id, source_release_id, id, manifest_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, source_release_id, ownership_decision_id, manifest_sha256
  ) REFERENCES app_private.brand_brain_review_decisions (
    workspace_id, source_release_id, id, manifest_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, source_release_id, privacy_decision_id, manifest_sha256
  ) REFERENCES app_private.brand_brain_review_decisions (
    workspace_id, source_release_id, id, manifest_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, source_release_id, brand_decision_id, manifest_sha256
  ) REFERENCES app_private.brand_brain_review_decisions (
    workspace_id, source_release_id, id, manifest_sha256
  ) ON DELETE RESTRICT
);

-- The three dimension-specific decision references cannot be expressed with
-- literals in ordinary foreign keys, so the exact tuple is checked in one
-- manager-only insert guard below. The eval FK pins the evidence row while the
-- guard requires passed=true; provider_effects is independently forced false.

CREATE FUNCTION app_private.stamp_brand_brain_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  NEW.recorded_by_user_id := app_private.current_user_id();
  NEW.recorded_request_id := app_private.current_request_id();
  NEW.recorded_at := statement_timestamp();
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_brand_brain_specialist_source_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  selected_use text;
  selected_source_id text;
  manifest_profile jsonb;
BEGIN
  SELECT source.consumer_use, source.source_id, profile_manifest.value
    INTO selected_use, selected_source_id, manifest_profile
  FROM app_private.brand_brain_source_version_refs AS source
  JOIN app_private.brand_brain_specialist_profile_refs AS profile
    ON profile.workspace_id = source.workspace_id
    AND profile.source_release_id = source.source_release_id
    AND profile.id = NEW.specialist_profile_ref_id
  JOIN app_private.brand_brain_source_releases AS release
    ON release.workspace_id = profile.workspace_id
    AND release.id = profile.source_release_id
  CROSS JOIN LATERAL jsonb_array_elements(
    release.canonical_manifest::jsonb -> 'specialistProfiles'
  ) AS profile_manifest(value)
  WHERE source.workspace_id = NEW.workspace_id
    AND source.source_release_id = NEW.source_release_id
    AND source.id = NEW.source_version_ref_id
    AND profile_manifest.value ->> 'profileId' = profile.profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'specialist source relation is not present in the trusted manifest'
      USING ERRCODE = '23514';
  END IF;
  IF selected_use <> 'runtime-authority-reference' THEN
    RAISE EXCEPTION 'eval-only or quarantined source cannot enter a specialist runtime profile'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.reference_kind = 'role'
        AND manifest_profile ->> 'roleSourceId' <> selected_source_id)
     OR (NEW.reference_kind = 'policy'
        AND manifest_profile ->> 'policySourceId' <> selected_source_id)
     OR (NEW.reference_kind = 'instruction'
        AND NOT (manifest_profile -> 'instructionSourceIds' ? selected_source_id))
     OR (NEW.reference_kind = 'knowledge'
        AND NOT (manifest_profile -> 'knowledgeSourceIds' ? selected_source_id)) THEN
    RAISE EXCEPTION 'specialist source relation differs from the trusted manifest'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_brand_brain_source_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.brand_brain_source_releases AS release
    WHERE release.workspace_id = NEW.workspace_id
      AND release.id = NEW.source_release_id
      AND release.canonical_manifest::jsonb -> 'sources' @> jsonb_build_array(
        jsonb_build_object(
          'sourceId', NEW.source_id, 'assetRole', NEW.asset_role,
          'authorityStatus', NEW.authority_status, 'path', NEW.repository_path,
          'locatorKind', NEW.locator_kind, 'symbol', NEW.source_symbol,
          'mediaType', NEW.media_type, 'byteLength', NEW.byte_length,
          'contentSha256', encode(NEW.content_sha256, 'hex'),
          'suppliedBy', NEW.supplied_by, 'ownershipStatus', NEW.ownership_status,
          'licenceStatus', NEW.licence_status, 'privacyClass', NEW.privacy_class,
          'consumerUse', NEW.consumer_use
        )
      )
  ) THEN
    RAISE EXCEPTION 'source reference differs from the trusted manifest'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_brand_brain_specialist_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  manifest_profile jsonb;
BEGIN
  SELECT profile_manifest.value INTO manifest_profile
  FROM app_private.brand_brain_source_releases AS release
  CROSS JOIN LATERAL jsonb_array_elements(
    release.canonical_manifest::jsonb -> 'specialistProfiles'
  ) AS profile_manifest(value)
  WHERE release.workspace_id = NEW.workspace_id
    AND release.id = NEW.source_release_id
    AND profile_manifest.value ->> 'profileId' = NEW.profile_id;
  IF NOT FOUND
     OR manifest_profile ->> 'name' IS DISTINCT FROM NEW.profile_name
     OR manifest_profile -> 'capabilities' IS DISTINCT FROM NEW.capabilities
     OR manifest_profile ->> 'runtimeBrandSha256'
        IS DISTINCT FROM encode(NEW.runtime_brand_sha256, 'hex')
     OR manifest_profile ->> 'sourceStatus' IS DISTINCT FROM NEW.source_status
     OR manifest_profile ->> 'hqActivationStatus' IS DISTINCT FROM NEW.hq_activation_status THEN
    RAISE EXCEPTION 'specialist profile differs from the trusted manifest'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_brand_brain_artwork_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.brand_brain_source_releases AS release
    WHERE release.workspace_id = NEW.workspace_id
      AND release.id = NEW.source_release_id
      AND release.canonical_manifest::jsonb -> 'artworkReferences' @> jsonb_build_array(
        jsonb_build_object(
          'assetId', NEW.asset_id, 'path', NEW.repository_path,
          'mediaType', NEW.media_type, 'byteLength', NEW.byte_length,
          'contentSha256', encode(NEW.content_sha256, 'hex'), 'purpose', NEW.purpose,
          'sourceApprovalStatus', NEW.source_approval_status,
          'hqUseStatus', NEW.hq_use_status, 'suppliedBy', NEW.supplied_by,
          'ownershipStatus', NEW.ownership_status, 'licenceStatus', NEW.licence_status
        )
      )
  ) THEN
    RAISE EXCEPTION 'artwork reference differs from the trusted manifest'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_brand_brain_quarantine_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  manifest_quarantine jsonb;
BEGIN
  SELECT quarantine_manifest.value INTO manifest_quarantine
  FROM app_private.brand_brain_source_releases AS release
  CROSS JOIN LATERAL jsonb_array_elements(
    release.canonical_manifest::jsonb -> 'quarantines'
  ) AS quarantine_manifest(value)
  WHERE release.workspace_id = NEW.workspace_id
    AND release.id = NEW.source_release_id
    AND quarantine_manifest.value ->> 'quarantineId' = NEW.quarantine_id;
  IF NOT FOUND
     OR manifest_quarantine ->> 'status' IS DISTINCT FROM NEW.status
     OR manifest_quarantine ->> 'reasonCode' IS DISTINCT FROM NEW.reason_code
     OR (manifest_quarantine ->> 'usable')::boolean IS DISTINCT FROM NEW.usable
     OR manifest_quarantine ->> 'resolution' IS DISTINCT FROM NEW.resolution
     OR manifest_quarantine -> 'ruleIds' IS DISTINCT FROM NEW.rule_ids
     OR manifest_quarantine ->> 'evidenceSha256'
        IS DISTINCT FROM encode(NEW.evidence_sha256, 'hex') THEN
    RAISE EXCEPTION 'quarantine differs from the trusted manifest'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_brand_brain_quarantine_source_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  selected_source_id text;
  manifest_quarantine jsonb;
BEGIN
  SELECT source.source_id, quarantine_manifest.value
    INTO selected_source_id, manifest_quarantine
  FROM app_private.brand_brain_source_version_refs AS source
  JOIN app_private.brand_brain_quarantines AS quarantine
    ON quarantine.workspace_id = source.workspace_id
    AND quarantine.source_release_id = source.source_release_id
    AND quarantine.id = NEW.quarantine_id
  JOIN app_private.brand_brain_source_releases AS release
    ON release.workspace_id = quarantine.workspace_id
    AND release.id = quarantine.source_release_id
  CROSS JOIN LATERAL jsonb_array_elements(
    release.canonical_manifest::jsonb -> 'quarantines'
  ) AS quarantine_manifest(value)
  WHERE source.workspace_id = NEW.workspace_id
    AND source.source_release_id = NEW.source_release_id
    AND source.id = NEW.source_version_ref_id
    AND quarantine_manifest.value ->> 'quarantineId' = quarantine.quarantine_id;
  IF NOT FOUND OR NOT (manifest_quarantine -> 'sourceIds' ? selected_source_id) THEN
    RAISE EXCEPTION 'quarantine source relation differs from the trusted manifest'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_brand_brain_activation_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  selected_release app_private.brand_brain_source_releases%ROWTYPE;
  selected_eval app_private.brand_brain_eval_results%ROWTYPE;
  ownership app_private.brand_brain_review_decisions%ROWTYPE;
  privacy app_private.brand_brain_review_decisions%ROWTYPE;
  brand app_private.brand_brain_review_decisions%ROWTYPE;
  actual_sources integer;
  actual_specialists integer;
  actual_artwork integer;
  actual_quarantines integer;
BEGIN
  IF NOT app_private.can_manage_workspace(
    app_private.current_user_id(), NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'Brand Brain activation requires workspace manager authority'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO selected_release
  FROM app_private.brand_brain_source_releases AS release
  WHERE release.workspace_id = NEW.workspace_id
    AND release.id = NEW.source_release_id
    AND release.manifest_sha256 = NEW.manifest_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Brand Brain source release is not available'
      USING ERRCODE = '23503';
  END IF;

  SELECT count(*)::integer INTO actual_sources
  FROM app_private.brand_brain_source_version_refs
  WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id;
  SELECT count(*)::integer INTO actual_specialists
  FROM app_private.brand_brain_specialist_profile_refs
  WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id;
  SELECT count(*)::integer INTO actual_artwork
  FROM app_private.brand_brain_artwork_version_refs
  WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id;
  SELECT count(*)::integer INTO actual_quarantines
  FROM app_private.brand_brain_quarantines
  WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id;
  IF actual_sources <> selected_release.source_count
     OR actual_specialists <> selected_release.specialist_count
     OR actual_artwork <> selected_release.artwork_count
     OR actual_quarantines <> selected_release.quarantine_count THEN
    RAISE EXCEPTION 'Brand Brain release inventory is incomplete'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM app_private.brand_brain_specialist_profile_refs AS profile
    LEFT JOIN app_private.brand_brain_specialist_source_refs AS reference
      ON reference.workspace_id = profile.workspace_id
      AND reference.source_release_id = profile.source_release_id
      AND reference.specialist_profile_ref_id = profile.id
    WHERE profile.workspace_id = NEW.workspace_id
      AND profile.source_release_id = NEW.source_release_id
    GROUP BY profile.id
    HAVING count(*) FILTER (WHERE reference.reference_kind = 'role') <> 1
      OR count(*) FILTER (WHERE reference.reference_kind = 'policy') <> 1
      OR count(*) FILTER (WHERE reference.reference_kind = 'instruction') <> 1
      OR count(*) FILTER (WHERE reference.reference_kind = 'knowledge') <> 1
  ) THEN
    RAISE EXCEPTION 'Brand Brain specialist source manifest is incomplete'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM app_private.brand_brain_quarantines AS quarantine
    LEFT JOIN app_private.brand_brain_quarantine_source_refs AS reference
      ON reference.workspace_id = quarantine.workspace_id
      AND reference.source_release_id = quarantine.source_release_id
      AND reference.quarantine_id = quarantine.id
    WHERE quarantine.workspace_id = NEW.workspace_id
      AND quarantine.source_release_id = NEW.source_release_id
    GROUP BY quarantine.id
    HAVING count(reference.id) <> 2
  ) THEN
    RAISE EXCEPTION 'Brand Brain quarantine evidence links are incomplete'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO selected_eval
  FROM app_private.brand_brain_eval_results AS evaluation
  WHERE evaluation.workspace_id = NEW.workspace_id
    AND evaluation.source_release_id = NEW.source_release_id
    AND evaluation.id = NEW.eval_result_id
    AND evaluation.manifest_sha256 = NEW.manifest_sha256
    AND evaluation.passed IS TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Brand Brain activation requires a passing exact-manifest evaluation'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO ownership FROM app_private.brand_brain_review_decisions
  WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id
    AND id = NEW.ownership_decision_id AND manifest_sha256 = NEW.manifest_sha256
    AND review_dimension = 'ownership_licence' AND decision = 'approved';
  SELECT * INTO privacy FROM app_private.brand_brain_review_decisions
  WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id
    AND id = NEW.privacy_decision_id AND manifest_sha256 = NEW.manifest_sha256
    AND review_dimension = 'privacy_security' AND decision = 'approved';
  SELECT * INTO brand FROM app_private.brand_brain_review_decisions
  WHERE workspace_id = NEW.workspace_id AND source_release_id = NEW.source_release_id
    AND id = NEW.brand_decision_id AND manifest_sha256 = NEW.manifest_sha256
    AND review_dimension = 'brand_readiness' AND decision = 'approved';
  IF ownership.id IS NULL OR privacy.id IS NULL OR brand.id IS NULL THEN
    RAISE EXCEPTION 'Brand Brain activation requires all three independent approvals'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.brand_brain_source_attestations AS attestation
    WHERE attestation.workspace_id = NEW.workspace_id
      AND attestation.source_release_id = NEW.source_release_id
      AND attestation.manifest_sha256 = NEW.manifest_sha256
      AND attestation.checked_at <= statement_timestamp()
      AND attestation.expires_at > statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'Brand Brain activation requires a fresh source attestation'
      USING ERRCODE = '23514';
  END IF;

  NEW.provider_effects := false;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.reject_brand_brain_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Brand Brain inventory, evidence and decisions are append-only'
    USING ERRCODE = '55000';
END;
$function$;

REVOKE ALL ON FUNCTION app_private.stamp_brand_brain_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_brand_brain_source_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_brand_brain_specialist_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_brand_brain_specialist_source_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_brand_brain_artwork_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_brand_brain_quarantine_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_brand_brain_quarantine_source_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_brand_brain_activation_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reject_brand_brain_mutation() FROM PUBLIC;

DO $brand_brain_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'brand_brain_source_releases', 'brand_brain_source_version_refs',
    'brand_brain_specialist_profile_refs', 'brand_brain_specialist_source_refs',
    'brand_brain_artwork_version_refs', 'brand_brain_quarantines',
    'brand_brain_quarantine_source_refs', 'brand_brain_source_attestations',
    'brand_brain_eval_results', 'brand_brain_review_decisions',
    'brand_brain_activations'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON app_private.%I
       FOR EACH ROW EXECUTE FUNCTION app_private.stamp_brand_brain_insert()',
      table_name || '_stamp_insert', table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app_private.%I
       FOR EACH ROW EXECUTE FUNCTION app_private.reject_brand_brain_mutation()',
      table_name || '_immutable', table_name
    );
  END LOOP;
END;
$brand_brain_triggers$;

CREATE TRIGGER brand_brain_specialist_source_eligibility
BEFORE INSERT ON app_private.brand_brain_specialist_source_refs
FOR EACH ROW EXECUTE FUNCTION app_private.guard_brand_brain_specialist_source_insert();

CREATE TRIGGER brand_brain_source_manifest_guard
BEFORE INSERT ON app_private.brand_brain_source_version_refs
FOR EACH ROW EXECUTE FUNCTION app_private.guard_brand_brain_source_insert();

CREATE TRIGGER brand_brain_specialist_manifest_guard
BEFORE INSERT ON app_private.brand_brain_specialist_profile_refs
FOR EACH ROW EXECUTE FUNCTION app_private.guard_brand_brain_specialist_insert();

CREATE TRIGGER brand_brain_artwork_manifest_guard
BEFORE INSERT ON app_private.brand_brain_artwork_version_refs
FOR EACH ROW EXECUTE FUNCTION app_private.guard_brand_brain_artwork_insert();

CREATE TRIGGER brand_brain_quarantine_manifest_guard
BEFORE INSERT ON app_private.brand_brain_quarantines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_brand_brain_quarantine_insert();

CREATE TRIGGER brand_brain_quarantine_source_manifest_guard
BEFORE INSERT ON app_private.brand_brain_quarantine_source_refs
FOR EACH ROW EXECUTE FUNCTION app_private.guard_brand_brain_quarantine_source_insert();

CREATE TRIGGER brand_brain_activation_gate
BEFORE INSERT ON app_private.brand_brain_activations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_brand_brain_activation_insert();

DO $brand_brain_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'brand_brain_source_releases', 'brand_brain_source_version_refs',
    'brand_brain_specialist_profile_refs', 'brand_brain_specialist_source_refs',
    'brand_brain_artwork_version_refs', 'brand_brain_quarantines',
    'brand_brain_quarantine_source_refs', 'brand_brain_source_attestations',
    'brand_brain_eval_results', 'brand_brain_review_decisions',
    'brand_brain_activations'
  ]
  LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)',
      table_name || '_owner_all', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I FOR SELECT TO r72_content_adapter, r72_content_command
       USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.has_active_workspace_membership(
           app_private.current_user_id(), workspace_id
         )
       )',
      table_name || '_content_select', table_name
    );
  END LOOP;
END;
$brand_brain_rls$;

DO $brand_brain_adapter_insert$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'brand_brain_source_releases', 'brand_brain_source_version_refs',
    'brand_brain_specialist_profile_refs', 'brand_brain_specialist_source_refs',
    'brand_brain_artwork_version_refs', 'brand_brain_quarantines',
    'brand_brain_quarantine_source_refs', 'brand_brain_source_attestations',
    'brand_brain_eval_results'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I FOR INSERT TO r72_content_adapter
       WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND recorded_by_user_id = app_private.current_user_id()
         AND recorded_request_id = app_private.current_request_id()
         AND app_private.can_write_workspace(recorded_by_user_id, workspace_id)
       )',
      table_name || '_adapter_insert', table_name
    );
  END LOOP;
END;
$brand_brain_adapter_insert$;

CREATE POLICY brand_brain_review_decisions_manager_insert
  ON app_private.brand_brain_review_decisions
  FOR INSERT TO r72_content_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );

CREATE POLICY brand_brain_activations_manager_insert
  ON app_private.brand_brain_activations
  FOR INSERT TO r72_content_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
    AND provider_effects IS FALSE
  );

GRANT SELECT ON
  app_private.brand_brain_source_releases,
  app_private.brand_brain_source_version_refs,
  app_private.brand_brain_specialist_profile_refs,
  app_private.brand_brain_specialist_source_refs,
  app_private.brand_brain_artwork_version_refs,
  app_private.brand_brain_quarantines,
  app_private.brand_brain_quarantine_source_refs,
  app_private.brand_brain_source_attestations,
  app_private.brand_brain_eval_results,
  app_private.brand_brain_review_decisions,
  app_private.brand_brain_activations
TO r72_content_adapter, r72_content_command;

GRANT INSERT ON
  app_private.brand_brain_source_releases,
  app_private.brand_brain_source_version_refs,
  app_private.brand_brain_specialist_profile_refs,
  app_private.brand_brain_specialist_source_refs,
  app_private.brand_brain_artwork_version_refs,
  app_private.brand_brain_quarantines,
  app_private.brand_brain_quarantine_source_refs,
  app_private.brand_brain_source_attestations,
  app_private.brand_brain_eval_results
TO r72_content_adapter;

GRANT INSERT ON
  app_private.brand_brain_review_decisions,
  app_private.brand_brain_activations
TO r72_content_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app_private', 'brand_brain_source_releases', 'workspace_id'),
  ('app_private', 'brand_brain_source_version_refs', 'workspace_id'),
  ('app_private', 'brand_brain_specialist_profile_refs', 'workspace_id'),
  ('app_private', 'brand_brain_specialist_source_refs', 'workspace_id'),
  ('app_private', 'brand_brain_artwork_version_refs', 'workspace_id'),
  ('app_private', 'brand_brain_quarantines', 'workspace_id'),
  ('app_private', 'brand_brain_quarantine_source_refs', 'workspace_id'),
  ('app_private', 'brand_brain_source_attestations', 'workspace_id'),
  ('app_private', 'brand_brain_eval_results', 'workspace_id'),
  ('app_private', 'brand_brain_review_decisions', 'workspace_id'),
  ('app_private', 'brand_brain_activations', 'workspace_id');

DO $brand_brain_capability_check$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'brand_brain_source_releases', 'brand_brain_source_version_refs',
    'brand_brain_specialist_profile_refs', 'brand_brain_specialist_source_refs',
    'brand_brain_artwork_version_refs', 'brand_brain_quarantines',
    'brand_brain_quarantine_source_refs', 'brand_brain_source_attestations',
    'brand_brain_eval_results', 'brand_brain_review_decisions',
    'brand_brain_activations'
  ]
  LOOP
    IF pg_catalog.has_table_privilege('r72_web', 'app_private.' || table_name, 'SELECT')
       OR pg_catalog.has_table_privilege('r72_web', 'app_private.' || table_name, 'INSERT')
       OR pg_catalog.has_table_privilege('r72_content_adapter', 'app_private.' || table_name, 'UPDATE')
       OR pg_catalog.has_table_privilege('r72_content_adapter', 'app_private.' || table_name, 'DELETE')
       OR pg_catalog.has_table_privilege('r72_content_command', 'app_private.' || table_name, 'UPDATE')
       OR pg_catalog.has_table_privilege('r72_content_command', 'app_private.' || table_name, 'DELETE') THEN
      RAISE EXCEPTION 'Unsafe Brand Brain capability on %', table_name;
    END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege('r72_content_adapter', 'app.provider_operations', 'INSERT')
     OR pg_catalog.has_table_privilege('r72_content_command', 'app.provider_operations', 'INSERT')
     OR pg_catalog.pg_has_role('r72_content_adapter', 'r72_worker', 'MEMBER')
     OR pg_catalog.pg_has_role('r72_content_command', 'r72_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'Brand Brain roles unexpectedly have provider execution capability';
  END IF;
END;
$brand_brain_capability_check$;

RESET ROLE;
