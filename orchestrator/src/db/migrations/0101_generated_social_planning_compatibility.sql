-- HQ-SCHEDULE-006: additive generated-draft compatibility for the existing TEST planner.
-- Old application/new schema remains safe: v1 excludes generated jobs and retains legacy behavior.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

SET LOCAL ROLE r72_owner;

ALTER TABLE app.public_social_revalidation_proofs
  ADD COLUMN evidence_type text NOT NULL DEFAULT 'legacy',
  ADD COLUMN generated_source_item_id uuid,
  ADD COLUMN generated_source_version_id uuid,
  ADD COLUMN generated_source_item_version integer,
  ADD COLUMN generated_content_sha256 bytea,
  ADD COLUMN generated_brand_sha256 bytea;
ALTER TABLE app.public_social_revalidation_proofs
  ALTER COLUMN source_resource_version_id DROP NOT NULL,
  ALTER COLUMN source_approval_id DROP NOT NULL,
  ALTER COLUMN source_approved_at DROP NOT NULL,
  ADD CONSTRAINT public_social_revalidation_proofs_evidence_shape CHECK (
    (evidence_type = 'legacy' AND source_resource_version_id IS NOT NULL
      AND source_approval_id IS NOT NULL AND source_approved_at IS NOT NULL
      AND generated_source_item_id IS NULL AND generated_source_version_id IS NULL
      AND generated_source_item_version IS NULL AND generated_content_sha256 IS NULL
      AND generated_brand_sha256 IS NULL)
    OR
    (evidence_type = 'generated' AND source_resource_version_id IS NULL
      AND source_approval_id IS NULL AND source_approved_at IS NULL
      AND generated_source_item_id IS NOT NULL AND generated_source_version_id IS NOT NULL
      AND generated_source_item_version > 0
      AND octet_length(generated_content_sha256) = 32
      AND octet_length(generated_brand_sha256) = 32)
  );

GRANT CREATE ON SCHEMA app_private TO r72_public_social_definer;
SET LOCAL ROLE r72_public_social_definer;

-- PostgreSQL rejects counted regular-expression repetitions above 255.  The
-- 0080 helper used {0,499}, so any media-bearing plan could fail while merely
-- evaluating the predicate.  The explicit length bound already supplies the
-- upper limit; use an unbounded character-class repetition here.
CREATE OR REPLACE FUNCTION app_private.public_social_media_payload_supported(
  p_blob_storage_key text,
  p_content_mime_type text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT p_blob_storage_key IS NOT NULL
    AND pg_catalog.length(p_blob_storage_key) BETWEEN 1 AND 500
    AND p_blob_storage_key ~ '^/?[A-Za-z0-9][A-Za-z0-9._/-]*$'
    AND pg_catalog.strpos(p_blob_storage_key, '..') = 0
    AND pg_catalog.strpos(p_blob_storage_key, '//') = 0
    AND p_content_mime_type IS NOT NULL
    AND p_content_mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$';
$function$;

CREATE OR REPLACE FUNCTION app_private.create_test_social_planning_intent(
  p_workspace_id uuid,
  p_intent_id uuid,
  p_campaign_id uuid,
  p_revision_id uuid,
  p_content_version_id uuid,
  p_desired_for timestamptz,
  p_max_attempts smallint,
  p_target_ids uuid[],
  p_media_version_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS TABLE (intent_id uuid, intent_sha256 text, disposition text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor_id uuid;
  request_id text;
  existing app.public_social_planning_intents%ROWTYPE;
  existing_targets uuid[];
  existing_media uuid[];
  target_count integer;
  distinct_target_count integer;
  media_count integer;
  distinct_media_count integer;
  main_content_item_id uuid;
  main_content_sha256 bytea;
  main_blob_sha256 bytea;
  main_brand_sha256 bytea;
  main_approval_request_id uuid;
  main_approval_decision_id uuid;
  main_attestation_id uuid;
  resolved_targets jsonb;
  resolved_media jsonb;
  calculated_intent_sha256 bytea;
BEGIN
  PERFORM app_private.assert_public_social_manager(p_workspace_id);
  actor_id := app_private.current_user_id();
  request_id := app_private.current_request_id();
  IF p_intent_id IS NULL OR p_campaign_id IS NULL OR p_revision_id IS NULL
     OR p_content_version_id IS NULL OR p_desired_for IS NULL
     OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 4
     OR p_target_ids IS NULL OR cardinality(p_target_ids) NOT BETWEEN 1 AND 9
     OR array_position(p_target_ids, NULL) IS NOT NULL
     OR p_media_version_ids IS NULL
     OR cardinality(p_media_version_ids) > 10
     OR array_position(p_media_version_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid TEST public-social planning intent'
      USING ERRCODE = '22023';
  END IF;
  SELECT count(*), count(DISTINCT value)
    INTO target_count, distinct_target_count
  FROM unnest(p_target_ids) AS value;
  SELECT count(*), count(DISTINCT value)
    INTO media_count, distinct_media_count
  FROM unnest(p_media_version_ids) AS value;
  IF target_count <> distinct_target_count OR media_count <> distinct_media_count THEN
    RAISE EXCEPTION 'planning targets and media must be unique'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-planning-intent:' || p_workspace_id::text || ':'
        || p_intent_id::text,
      7200040
    )
  );
  SELECT intent.* INTO existing
  FROM app.public_social_planning_intents AS intent
  WHERE intent.workspace_id = p_workspace_id AND intent.id = p_intent_id;
  IF FOUND THEN
    SELECT array_agg(target.target_id ORDER BY target.ordinal)
      INTO existing_targets
    FROM app.public_social_planning_intent_targets AS target
    WHERE target.workspace_id = p_workspace_id AND target.intent_id = p_intent_id;
    SELECT COALESCE(array_agg(media.content_version_id ORDER BY media.ordinal), ARRAY[]::uuid[])
      INTO existing_media
    FROM app.public_social_planning_intent_media AS media
    WHERE media.workspace_id = p_workspace_id AND media.intent_id = p_intent_id;
    IF existing.campaign_id IS DISTINCT FROM p_campaign_id
       OR existing.campaign_revision_id IS DISTINCT FROM p_revision_id
       OR existing.content_version_id IS DISTINCT FROM p_content_version_id
       OR existing.desired_for IS DISTINCT FROM p_desired_for
       OR existing.max_attempts IS DISTINCT FROM p_max_attempts
       OR existing_targets IS DISTINCT FROM p_target_ids
       OR existing_media IS DISTINCT FROM p_media_version_ids THEN
      RAISE EXCEPTION 'planning intent id was reused with different inputs'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT p_intent_id, encode(existing.intent_sha256, 'hex'),
      'replayed'::text;
    RETURN;
  END IF;

  IF p_desired_for < statement_timestamp() - interval '5 seconds'
     OR p_desired_for > statement_timestamp() + interval '366 days' THEN
    RAISE EXCEPTION 'planning time is outside the TEST horizon'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.public_social_campaign_revisions AS revision
    WHERE revision.workspace_id = p_workspace_id
      AND revision.campaign_id = p_campaign_id
      AND revision.id = p_revision_id
  ) THEN
    RAISE EXCEPTION 'campaign revision was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT version.content_item_id, version.content_sha256, version.blob_sha256,
    version.brand_sha256, approved.request_id, approved.decision_id,
    fresh.attestation_id
  INTO main_content_item_id, main_content_sha256, main_blob_sha256,
    main_brand_sha256, main_approval_request_id, main_approval_decision_id,
    main_attestation_id
  FROM app.company_content_versions AS version
  JOIN LATERAL (
    SELECT request.id AS request_id, decision.id AS decision_id
    FROM app.company_content_approval_requests AS request
    JOIN app.company_content_approval_decisions AS decision
      ON decision.workspace_id = request.workspace_id
     AND decision.content_item_id = request.content_item_id
     AND decision.content_version_id = request.content_version_id
     AND decision.approval_request_id = request.id
     AND decision.content_sha256 = request.content_sha256
     AND decision.decision = 'approved'
    WHERE request.workspace_id = version.workspace_id
      AND request.content_item_id = version.content_item_id
      AND request.content_version_id = version.id
      AND request.content_sha256 = version.content_sha256
      AND NOT EXISTS (
        SELECT 1 FROM app.company_content_approval_requests AS later_request
        WHERE later_request.workspace_id = request.workspace_id
          AND later_request.content_item_id = request.content_item_id
          AND later_request.content_version_id = request.content_version_id
          AND later_request.request_number > request.request_number
      )
    ORDER BY request.request_number DESC, request.id
    LIMIT 1
  ) AS approved ON true
  JOIN LATERAL (
    SELECT attestation.id AS attestation_id
    FROM app.company_content_source_attestations AS attestation
    WHERE attestation.workspace_id = version.workspace_id
      AND attestation.content_item_id = version.content_item_id
      AND attestation.content_version_id = version.id
      AND attestation.content_sha256 = version.content_sha256
      AND attestation.blob_sha256 = version.blob_sha256
      AND attestation.brand_sha256 = version.brand_sha256
      AND attestation.checked_at <= statement_timestamp()
      AND attestation.expires_at > statement_timestamp()
    ORDER BY attestation.checked_at DESC, attestation.id
    LIMIT 1
  ) AS fresh ON true
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_content_version_id
    AND version.content_kind = 'social_post'
    AND (
      (version.source_system = 'propertypredator.company-content'
       AND version.source_item_id ~
         '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
       AND version.source_version ~ '^[1-9][0-9]{0,9}$'
       AND (
         length(version.source_version) < 10
         OR version.source_version <= '2147483647'
       )
       AND version.metadata->>'sourceVersionId' ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.pg_input_is_valid(
         version.metadata->>'sourceVersionId', 'uuid'
       )
       AND version.metadata->>'sourceApprovalId' ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.pg_input_is_valid(
         version.metadata->>'sourceApprovalId', 'uuid'
       )
       AND CASE
         WHEN version.metadata->>'sourceApprovedAt' ~
             '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
          AND pg_catalog.pg_input_is_valid(
            version.metadata->>'sourceApprovedAt', 'timestamp with time zone'
          )
         THEN (version.metadata->>'sourceApprovedAt')::timestamptz
           <= statement_timestamp()
         ELSE false
       END)
      OR
      (version.source_system = 'property_predator_generation'
       AND version.origin IN ('generated', 'edited')
       AND version.source_item_id ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.pg_input_is_valid(version.source_item_id, 'uuid')
       AND version.source_version ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:v[1-9][0-9]*(:edit:[0-9a-f]{16})*$'
       -- Admit generated content only when its actual predecessor chain reaches
       -- a canonical nearest generated revision.  All metadata comparisons are
       -- textual here, so malformed UUID/integer JSON can never reach a cast.
       AND EXISTS (
         WITH RECURSIVE chain AS (
           SELECT candidate.*, 0 AS depth, ARRAY[candidate.id]::uuid[] AS path
           FROM app.company_content_versions AS candidate
           WHERE candidate.workspace_id = version.workspace_id
             AND candidate.id = version.id
           UNION ALL
           SELECT predecessor.*, chain.depth + 1, chain.path || predecessor.id
           FROM chain
           JOIN app.company_content_versions AS predecessor
             ON predecessor.workspace_id = chain.workspace_id
            AND predecessor.content_item_id = chain.content_item_id
            AND predecessor.id = chain.previous_version_id
           WHERE chain.depth < 100
             AND NOT predecessor.id = ANY(chain.path)
         ), nearest_generated AS MATERIALIZED (
           SELECT candidate.* FROM chain AS candidate
           WHERE candidate.origin = 'generated'
           ORDER BY candidate.depth
           LIMIT 1
         )
         SELECT 1
         FROM nearest_generated AS generated
         WHERE generated.source_system = 'property_predator_generation'
           AND generated.source_item_id ~
             '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           AND pg_catalog.pg_input_is_valid(generated.source_item_id, 'uuid')
           AND generated.source_version ~
             '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:v[1-9][0-9]{0,9}$'
           AND generated.metadata->'source'->>'schema' =
             'propertypredator.generated-draft-source/v1'
           AND generated.metadata->'source'->>'sourceItemId' =
             generated.source_item_id
           AND generated.metadata->'source'->>'sourceDraftId' ~
             '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           AND pg_catalog.pg_input_is_valid(
             generated.metadata->'source'->>'sourceDraftId', 'uuid'
           )
           AND generated.metadata->'source'->>'sourceVersionId' =
             split_part(generated.source_version, ':', 1)
           AND generated.metadata->'source'->>'sourceVersionId' ~
             '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           AND pg_catalog.pg_input_is_valid(
             generated.metadata->'source'->>'sourceVersionId', 'uuid'
           )
           AND generated.metadata->'source'->>'sourceItemVersion' =
             substring(split_part(generated.source_version, ':', 2) FROM 2)
           AND generated.metadata->'source'->>'sourceItemVersion' ~
             '^[1-9][0-9]{0,9}$'
           AND (
             length(generated.metadata->'source'->>'sourceItemVersion') < 10
             OR generated.metadata->'source'->>'sourceItemVersion' <= '2147483647'
           )
           AND generated.metadata->'source'->>'contentSha256' =
             encode(generated.content_sha256, 'hex')
           AND generated.metadata->'source'->>'brandSha256' =
             encode(generated.brand_sha256, 'hex')
           AND public.digest(generated.content_body, 'sha256') =
             generated.content_sha256
           AND NOT EXISTS (
             SELECT 1
             FROM chain AS edited
             LEFT JOIN chain AS predecessor
               ON predecessor.depth = edited.depth + 1
              AND predecessor.id = edited.previous_version_id
             WHERE edited.depth < generated.depth
               AND (
                 predecessor.id IS NOT NULL
                 AND edited.origin = 'edited'
                 AND edited.metadata->>'editor' = 'growth_hq_exact_review'
                 AND edited.metadata->>'previousContentVersionId' = predecessor.id::text
                 AND edited.metadata->>'previousContentSha256' =
                   encode(predecessor.content_sha256, 'hex')
                 AND edited.version_number = predecessor.version_number + 1
                 AND edited.source_system = predecessor.source_system
                 AND edited.source_item_id = predecessor.source_item_id
                 AND edited.brand_sha256 = predecessor.brand_sha256
                 AND edited.source_version = left(predecessor.source_version, 430)
                   || ':edit:' || left(encode(edited.content_sha256, 'hex'), 16)
               ) IS NOT TRUE
           )
       ))
    )
    AND public.digest(version.content_body, 'sha256') = version.content_sha256
    AND app_private.public_social_body_supported(version.content_body)
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'social content is not currently approved and attested'
      USING ERRCODE = '42501';
  END IF;

  WITH requested AS (
    SELECT requested_target_id, ordinal::integer
    FROM unnest(p_target_ids) WITH ORDINALITY
      AS input(requested_target_id, ordinal)
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'ordinal', requested.ordinal,
      'targetId', target.id,
      'providerConnectionId', target.provider_connection_id,
      'network', target.network,
      'accountRefSha256', encode(target.account_ref_sha256, 'hex')
    ) ORDER BY requested.ordinal
  ) INTO resolved_targets
  FROM requested
  JOIN app.public_social_targets AS target
    ON target.workspace_id = p_workspace_id
   AND target.id = requested.requested_target_id
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = target.workspace_id
   AND connection.id = target.provider_connection_id
  WHERE target.environment = 'test'
    AND connection.provider_id = 'public_social_dark_simulator'
    AND connection.provider_kind = 'social'
    AND connection.environment = 'test'
    AND connection.status = 'active';
  IF jsonb_array_length(COALESCE(resolved_targets, '[]'::jsonb)) <> target_count THEN
    RAISE EXCEPTION 'one or more TEST public-social targets are unavailable'
      USING ERRCODE = '42501';
  END IF;

  WITH requested AS (
    SELECT requested_version_id, ordinal::integer
    FROM unnest(p_media_version_ids) WITH ORDINALITY
      AS input(requested_version_id, ordinal)
  ), resolved AS (
    SELECT requested.ordinal, version.content_item_id, version.id AS version_id,
      version.content_sha256, version.blob_sha256, version.brand_sha256,
      approved.request_id, approved.decision_id, fresh.attestation_id
    FROM requested
    JOIN app.company_content_versions AS version
      ON version.workspace_id = p_workspace_id
     AND version.id = requested.requested_version_id
    JOIN LATERAL (
      SELECT request.id AS request_id, decision.id AS decision_id
      FROM app.company_content_approval_requests AS request
      JOIN app.company_content_approval_decisions AS decision
        ON decision.workspace_id = request.workspace_id
       AND decision.content_item_id = request.content_item_id
       AND decision.content_version_id = request.content_version_id
       AND decision.approval_request_id = request.id
       AND decision.content_sha256 = request.content_sha256
       AND decision.decision = 'approved'
      WHERE request.workspace_id = version.workspace_id
        AND request.content_item_id = version.content_item_id
        AND request.content_version_id = version.id
        AND request.content_sha256 = version.content_sha256
        AND NOT EXISTS (
          SELECT 1 FROM app.company_content_approval_requests AS later_request
          WHERE later_request.workspace_id = request.workspace_id
            AND later_request.content_item_id = request.content_item_id
            AND later_request.content_version_id = request.content_version_id
            AND later_request.request_number > request.request_number
        )
      ORDER BY request.request_number DESC, request.id
      LIMIT 1
    ) AS approved ON true
    JOIN LATERAL (
      SELECT attestation.id AS attestation_id
      FROM app.company_content_source_attestations AS attestation
      WHERE attestation.workspace_id = version.workspace_id
        AND attestation.content_item_id = version.content_item_id
        AND attestation.content_version_id = version.id
        AND attestation.content_sha256 = version.content_sha256
        AND attestation.blob_sha256 = version.blob_sha256
        AND attestation.brand_sha256 = version.brand_sha256
        AND attestation.checked_at <= statement_timestamp()
        AND attestation.expires_at > statement_timestamp()
      ORDER BY attestation.checked_at DESC, attestation.id
      LIMIT 1
    ) AS fresh ON true
    WHERE version.content_kind IN ('image', 'video')
      AND version.source_system = 'propertypredator.company-content'
      AND version.source_item_id ~
        '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      AND version.source_version ~ '^[1-9][0-9]{0,9}$'
      AND (
        length(version.source_version) < 10
        OR version.source_version <= '2147483647'
      )
      AND version.metadata->>'sourceVersionId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceVersionId', 'uuid'
      )
      AND version.metadata->>'sourceApprovalId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceApprovalId', 'uuid'
      )
      AND CASE
        WHEN version.metadata->>'sourceApprovedAt' ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceApprovedAt', 'timestamp with time zone'
         )
        THEN (version.metadata->>'sourceApprovedAt')::timestamptz
          <= statement_timestamp()
        ELSE false
      END
      AND app_private.public_social_media_payload_supported(
        version.blob_storage_key, version.content_mime_type
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.company_content_versions AS newer
        WHERE newer.workspace_id = version.workspace_id
          AND newer.content_item_id = version.content_item_id
          AND newer.version_number > version.version_number
      )
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'ordinal', resolved.ordinal,
      'contentItemId', resolved.content_item_id,
      'contentVersionId', resolved.version_id,
      'contentSha256', encode(resolved.content_sha256, 'hex'),
      'blobSha256', encode(resolved.blob_sha256, 'hex'),
      'brandSha256', encode(resolved.brand_sha256, 'hex'),
      'approvalRequestId', resolved.request_id,
      'approvalDecisionId', resolved.decision_id,
      'sourceAttestationId', resolved.attestation_id
    ) ORDER BY resolved.ordinal
  ), '[]'::jsonb) INTO resolved_media
  FROM resolved;
  IF jsonb_array_length(resolved_media) <> media_count THEN
    RAISE EXCEPTION 'one or more media assets are not currently approved and attested'
      USING ERRCODE = '42501';
  END IF;

  calculated_intent_sha256 := public.digest(
    jsonb_build_object(
      'contract', 'public-social-planning-intent/v1',
      'workspaceId', p_workspace_id,
      'intentId', p_intent_id,
      'campaignId', p_campaign_id,
      'revisionId', p_revision_id,
      'contentVersionId', p_content_version_id,
      'contentSha256', encode(main_content_sha256, 'hex'),
      'approvalRequestId', main_approval_request_id,
      'approvalDecisionId', main_approval_decision_id,
      'planningAttestationId', main_attestation_id,
      'desiredFor', to_char(p_desired_for AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'maxAttempts', p_max_attempts,
      'targets', resolved_targets,
      'media', resolved_media
    )::text,
    'sha256'
  );

  INSERT INTO app.public_social_planning_intents (
    id, workspace_id, campaign_id, campaign_revision_id,
    content_item_id, content_version_id, content_sha256, blob_sha256,
    brand_sha256, approval_request_id, approval_decision_id,
    planning_source_attestation_id, desired_for, max_attempts, intent_sha256,
    created_by_user_id, created_request_id
  ) VALUES (
    p_intent_id, p_workspace_id, p_campaign_id, p_revision_id,
    main_content_item_id, p_content_version_id, main_content_sha256,
    main_blob_sha256, main_brand_sha256, main_approval_request_id,
    main_approval_decision_id, main_attestation_id, p_desired_for,
    p_max_attempts, calculated_intent_sha256, actor_id, request_id
  );

  INSERT INTO app.public_social_planning_intent_targets (
    workspace_id, intent_id, ordinal, target_id, provider_connection_id,
    network, environment, account_ref_sha256
  )
  SELECT p_workspace_id, p_intent_id, (entry->>'ordinal')::smallint,
    (entry->>'targetId')::uuid, (entry->>'providerConnectionId')::uuid,
    entry->>'network', 'test', decode(entry->>'accountRefSha256', 'hex')
  FROM jsonb_array_elements(resolved_targets) AS entry;

  INSERT INTO app.public_social_planning_intent_media (
    workspace_id, intent_id, ordinal, content_item_id, content_version_id,
    content_sha256, blob_sha256, brand_sha256, approval_request_id,
    approval_decision_id, planning_source_attestation_id
  )
  SELECT p_workspace_id, p_intent_id, (entry->>'ordinal')::smallint,
    (entry->>'contentItemId')::uuid, (entry->>'contentVersionId')::uuid,
    decode(entry->>'contentSha256', 'hex'), decode(entry->>'blobSha256', 'hex'),
    decode(entry->>'brandSha256', 'hex'),
    (entry->>'approvalRequestId')::uuid,
    (entry->>'approvalDecisionId')::uuid,
    (entry->>'sourceAttestationId')::uuid
  FROM jsonb_array_elements(resolved_media) AS entry;

  INSERT INTO app.public_social_revalidation_jobs (
    workspace_id, intent_id, state, attempt_count, max_attempts,
    next_attempt_at
  ) VALUES (
    p_workspace_id, p_intent_id, 'waiting_for_window', 0, p_max_attempts,
    GREATEST(p_desired_for - interval '10 minutes', statement_timestamp())
  );

  RETURN QUERY SELECT p_intent_id, encode(calculated_intent_sha256, 'hex'),
    'applied'::text;
END;
$function$;

CREATE OR REPLACE FUNCTION app_private.claim_due_test_social_revalidations(
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_batch_size integer,
  p_lease_seconds integer
)
RETURNS TABLE (
  job_id uuid,
  workspace_id uuid,
  intent_id uuid,
  lease_version bigint,
  desired_for timestamptz,
  content_item_id uuid,
  content_version_id uuid,
  source_system text,
  source_item_id text,
  source_version text,
  source_resource_version_id uuid,
  source_approval_id uuid,
  source_approved_at text,
  content_sha256 text,
  blob_sha256 text,
  brand_sha256 text,
  media jsonb
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_worker_id IS NULL OR p_lease_token_hash IS NULL
     OR octet_length(p_lease_token_hash) <> 32
     OR p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 50
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'invalid revalidation claim' USING ERRCODE = '22023';
  END IF;

  -- Legacy rows created before the source-proof contract was enforced must
  -- fail closed without poisoning this global claim.  This statement runs
  -- before candidate selection, so a malformed job in one workspace is
  -- terminalised and a valid job in another workspace can still be leased by
  -- the same call.  CASE is deliberate: no UUID/timestamp cast is reachable
  -- until PostgreSQL has proved the input is both canonical and parseable.
  UPDATE app.public_social_revalidation_jobs AS job
     SET state = 'dead_letter', lease_token_hash = NULL,
         lease_worker_id = NULL, lease_expires_at = NULL,
         last_error_code = 'revalidation.source_metadata_invalid',
         updated_at = statement_timestamp(), row_version = job.row_version + 1,
         completed_at = statement_timestamp()
    FROM app.public_social_planning_intents AS intent
    JOIN app.company_content_versions AS version
      ON version.workspace_id = intent.workspace_id
     AND version.content_item_id = intent.content_item_id
     AND version.id = intent.content_version_id
     AND version.content_sha256 = intent.content_sha256
     AND version.blob_sha256 = intent.blob_sha256
     AND version.brand_sha256 = intent.brand_sha256
   WHERE intent.workspace_id = job.workspace_id AND intent.id = job.intent_id
     AND NOT EXISTS (
       SELECT 1 FROM app.company_content_versions AS generated_version
       WHERE generated_version.workspace_id = intent.workspace_id
         AND generated_version.id = intent.content_version_id
         AND generated_version.source_system = 'property_predator_generation'
     )
     AND (
       job.state IN ('waiting_for_window', 'retry_wait')
       OR (job.state = 'leased' AND job.lease_expires_at <= statement_timestamp())
     )
     AND job.next_attempt_at <= statement_timestamp()
     AND intent.desired_for <= statement_timestamp() + interval '10 minutes'
     AND (
       (
         version.source_system = 'propertypredator.company-content'
         AND version.source_item_id ~
           '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
         AND version.source_version ~ '^[1-9][0-9]{0,9}$'
         AND (
           length(version.source_version) < 10
           OR version.source_version <= '2147483647'
         )
         AND version.metadata->>'sourceVersionId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceVersionId', 'uuid'
         )
         AND version.metadata->>'sourceApprovalId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceApprovalId', 'uuid'
         )
         AND CASE
           WHEN version.metadata->>'sourceApprovedAt' ~
               '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
            AND pg_catalog.pg_input_is_valid(
              version.metadata->>'sourceApprovedAt', 'timestamp with time zone'
            )
           THEN (version.metadata->>'sourceApprovedAt')::timestamptz
             <= statement_timestamp()
           ELSE false
         END
       ) IS NOT TRUE
       OR EXISTS (
         SELECT 1
         FROM app.public_social_planning_intent_media AS planned_media
         JOIN app.company_content_versions AS media_version
           ON media_version.workspace_id = planned_media.workspace_id
          AND media_version.content_item_id = planned_media.content_item_id
          AND media_version.id = planned_media.content_version_id
          AND media_version.content_sha256 = planned_media.content_sha256
          AND media_version.blob_sha256 = planned_media.blob_sha256
          AND media_version.brand_sha256 = planned_media.brand_sha256
         WHERE planned_media.workspace_id = intent.workspace_id
           AND planned_media.intent_id = intent.id
           AND (
             media_version.source_system = 'propertypredator.company-content'
             AND media_version.source_item_id ~
               '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
             AND media_version.source_version ~ '^[1-9][0-9]{0,9}$'
             AND (
               length(media_version.source_version) < 10
               OR media_version.source_version <= '2147483647'
             )
             AND media_version.metadata->>'sourceVersionId' ~
               '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             AND pg_catalog.pg_input_is_valid(
               media_version.metadata->>'sourceVersionId', 'uuid'
             )
             AND media_version.metadata->>'sourceApprovalId' ~
               '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             AND pg_catalog.pg_input_is_valid(
               media_version.metadata->>'sourceApprovalId', 'uuid'
             )
             AND CASE
               WHEN media_version.metadata->>'sourceApprovedAt' ~
                   '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                AND pg_catalog.pg_input_is_valid(
                  media_version.metadata->>'sourceApprovedAt',
                  'timestamp with time zone'
                )
               THEN (media_version.metadata->>'sourceApprovedAt')::timestamptz
                 <= statement_timestamp()
               ELSE false
             END
           ) IS NOT TRUE
       )
     );

  -- Resolve terminal planner states before leasing new work. An expired lease
  -- is terminal here when the final target was cancelled or its JIT window is
  -- already gone; it must never churn through generic retries.
  UPDATE app.public_social_revalidation_jobs AS job
     SET state = 'cancelled', lease_token_hash = NULL,
         lease_worker_id = NULL, lease_expires_at = NULL,
         last_error_code = 'revalidation.cancelled',
         updated_at = statement_timestamp(), row_version = job.row_version + 1,
         completed_at = statement_timestamp()
    FROM app.public_social_planning_intents AS intent
   WHERE intent.workspace_id = job.workspace_id AND intent.id = job.intent_id
     AND NOT EXISTS (
       SELECT 1 FROM app.company_content_versions AS generated_version
       WHERE generated_version.workspace_id = intent.workspace_id
         AND generated_version.id = intent.content_version_id
         AND generated_version.source_system = 'property_predator_generation'
     )
     AND (
       job.state IN ('waiting_for_window', 'retry_wait')
       OR (job.state = 'leased' AND job.lease_expires_at <= statement_timestamp())
     )
     AND NOT EXISTS (
       SELECT 1 FROM app.public_social_planning_intent_targets AS target
       WHERE target.workspace_id = intent.workspace_id
         AND target.intent_id = intent.id
         AND NOT EXISTS (
           SELECT 1 FROM app.public_social_planning_target_cancellations AS cancellation
           WHERE cancellation.workspace_id = target.workspace_id
             AND cancellation.intent_id = target.intent_id
             AND cancellation.target_id = target.target_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM app.public_social_planning_target_supersessions AS supersession
           WHERE supersession.workspace_id = target.workspace_id
             AND supersession.predecessor_intent_id = target.intent_id
             AND supersession.predecessor_target_id = target.target_id
         )
     );
  UPDATE app.public_social_revalidation_jobs AS job
     SET state = 'window_expired', lease_token_hash = NULL,
         lease_worker_id = NULL, lease_expires_at = NULL,
         last_error_code = 'revalidation.window_expired',
         updated_at = statement_timestamp(), row_version = job.row_version + 1,
         completed_at = statement_timestamp()
    FROM app.public_social_planning_intents AS intent
   WHERE intent.workspace_id = job.workspace_id AND intent.id = job.intent_id
     AND NOT EXISTS (
       SELECT 1 FROM app.company_content_versions AS generated_version
       WHERE generated_version.workspace_id = intent.workspace_id
         AND generated_version.id = intent.content_version_id
         AND generated_version.source_system = 'property_predator_generation'
     )
     AND (
       job.state IN ('waiting_for_window', 'retry_wait')
       OR (job.state = 'leased' AND job.lease_expires_at <= statement_timestamp())
     )
     AND intent.desired_for < statement_timestamp() - interval '5 minutes';

  UPDATE app.public_social_revalidation_jobs AS job
     SET state = CASE WHEN job.attempt_count >= job.max_attempts
                      THEN 'dead_letter' ELSE 'retry_wait' END,
         next_attempt_at = statement_timestamp() + interval '30 seconds',
         lease_token_hash = NULL, lease_worker_id = NULL,
         lease_expires_at = NULL,
         last_error_code = 'revalidation.lease_expired',
         updated_at = statement_timestamp(), row_version = job.row_version + 1,
         completed_at = CASE WHEN job.attempt_count >= job.max_attempts
                             THEN statement_timestamp() ELSE NULL END
   WHERE job.state = 'leased' AND job.lease_expires_at <= statement_timestamp()
     AND NOT EXISTS (
       SELECT 1 FROM app.public_social_planning_intents AS intent
       JOIN app.company_content_versions AS generated_version
         ON generated_version.workspace_id = intent.workspace_id
        AND generated_version.id = intent.content_version_id
        AND generated_version.source_system = 'property_predator_generation'
       WHERE intent.workspace_id = job.workspace_id AND intent.id = job.intent_id
     );

  RETURN QUERY
  WITH selected AS MATERIALIZED (
    SELECT job.workspace_id, job.id
    FROM app.public_social_revalidation_jobs AS job
    JOIN app.public_social_planning_intents AS intent
      ON intent.workspace_id = job.workspace_id AND intent.id = job.intent_id
    JOIN app.company_content_versions AS version
      ON version.workspace_id = intent.workspace_id
     AND version.content_item_id = intent.content_item_id
     AND version.id = intent.content_version_id
     AND version.content_sha256 = intent.content_sha256
     AND version.blob_sha256 = intent.blob_sha256
     AND version.brand_sha256 = intent.brand_sha256
    WHERE job.state IN ('waiting_for_window', 'retry_wait')
      AND job.next_attempt_at <= statement_timestamp()
      AND intent.desired_for <= statement_timestamp() + interval '10 minutes'
      AND intent.desired_for >= statement_timestamp() - interval '5 minutes'
      AND version.source_system = 'propertypredator.company-content'
      AND version.source_item_id ~
        '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      AND version.source_version ~ '^[1-9][0-9]{0,9}$'
      AND (
        length(version.source_version) < 10
        OR version.source_version <= '2147483647'
      )
      AND version.metadata->>'sourceVersionId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceVersionId', 'uuid'
      )
      AND version.metadata->>'sourceApprovalId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceApprovalId', 'uuid'
      )
      AND CASE
        WHEN version.metadata->>'sourceApprovedAt' ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceApprovedAt', 'timestamp with time zone'
         )
        THEN (version.metadata->>'sourceApprovedAt')::timestamptz
          <= statement_timestamp()
        ELSE false
      END
      AND NOT EXISTS (
        SELECT 1
        FROM app.public_social_planning_intent_media AS planned_media
        JOIN app.company_content_versions AS media_version
          ON media_version.workspace_id = planned_media.workspace_id
         AND media_version.content_item_id = planned_media.content_item_id
         AND media_version.id = planned_media.content_version_id
         AND media_version.content_sha256 = planned_media.content_sha256
         AND media_version.blob_sha256 = planned_media.blob_sha256
         AND media_version.brand_sha256 = planned_media.brand_sha256
        WHERE planned_media.workspace_id = intent.workspace_id
          AND planned_media.intent_id = intent.id
          AND (
            media_version.source_system = 'propertypredator.company-content'
            AND media_version.source_item_id ~
              '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
            AND media_version.source_version ~ '^[1-9][0-9]{0,9}$'
            AND (
              length(media_version.source_version) < 10
              OR media_version.source_version <= '2147483647'
            )
            AND media_version.metadata->>'sourceVersionId' ~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            AND pg_catalog.pg_input_is_valid(
              media_version.metadata->>'sourceVersionId', 'uuid'
            )
            AND media_version.metadata->>'sourceApprovalId' ~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            AND pg_catalog.pg_input_is_valid(
              media_version.metadata->>'sourceApprovalId', 'uuid'
            )
            AND CASE
              WHEN media_version.metadata->>'sourceApprovedAt' ~
                  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
               AND pg_catalog.pg_input_is_valid(
                 media_version.metadata->>'sourceApprovedAt',
                 'timestamp with time zone'
               )
              THEN (media_version.metadata->>'sourceApprovedAt')::timestamptz
                <= statement_timestamp()
              ELSE false
            END
          ) IS NOT TRUE
      )
      AND EXISTS (
        SELECT 1 FROM app.public_social_planning_intent_targets AS target
        WHERE target.workspace_id = intent.workspace_id
          AND target.intent_id = intent.id
          AND NOT EXISTS (
            SELECT 1
            FROM app.public_social_planning_target_cancellations AS cancellation
            WHERE cancellation.workspace_id = target.workspace_id
              AND cancellation.intent_id = target.intent_id
              AND cancellation.target_id = target.target_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM app.public_social_planning_target_supersessions AS supersession
            WHERE supersession.workspace_id = target.workspace_id
              AND supersession.predecessor_intent_id = target.intent_id
              AND supersession.predecessor_target_id = target.target_id
          )
      )
    ORDER BY job.next_attempt_at, job.created_at, job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT p_batch_size
  ), claimed AS (
    UPDATE app.public_social_revalidation_jobs AS job
       SET state = 'leased', attempt_count = job.attempt_count + 1,
           lease_token_hash = p_lease_token_hash,
           lease_worker_id = p_worker_id,
           lease_expires_at = statement_timestamp()
             + make_interval(secs => p_lease_seconds),
           lease_version = job.lease_version + 1,
           last_error_code = NULL, updated_at = statement_timestamp(),
           row_version = job.row_version + 1
      FROM selected
     WHERE job.workspace_id = selected.workspace_id AND job.id = selected.id
    RETURNING job.*
  )
  SELECT claimed.id, claimed.workspace_id, intent.id, claimed.lease_version,
    intent.desired_for, version.content_item_id, version.id,
    version.source_system, version.source_item_id, version.source_version,
    CASE
      WHEN version.metadata->>'sourceVersionId' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.pg_input_is_valid(
         version.metadata->>'sourceVersionId', 'uuid'
       )
      THEN (version.metadata->>'sourceVersionId')::uuid
      ELSE NULL
    END,
    CASE
      WHEN version.metadata->>'sourceApprovalId' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.pg_input_is_valid(
         version.metadata->>'sourceApprovalId', 'uuid'
       )
      THEN (version.metadata->>'sourceApprovalId')::uuid
      ELSE NULL
    END,
    version.metadata->>'sourceApprovedAt',
    encode(version.content_sha256, 'hex'), encode(version.blob_sha256, 'hex'),
    encode(version.brand_sha256, 'hex'),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'ordinal', planned_media.ordinal,
        'contentItemId', media_version.content_item_id,
        'contentVersionId', media_version.id,
        'sourceSystem', media_version.source_system,
        'sourceItemId', media_version.source_item_id,
        'sourceVersion', media_version.source_version,
        'sourceResourceVersionId', media_version.metadata->>'sourceVersionId',
        'sourceApprovalId', media_version.metadata->>'sourceApprovalId',
        'sourceApprovedAt', media_version.metadata->>'sourceApprovedAt',
        'contentSha256', encode(media_version.content_sha256, 'hex'),
        'blobSha256', encode(media_version.blob_sha256, 'hex'),
        'brandSha256', encode(media_version.brand_sha256, 'hex')
      ) ORDER BY planned_media.ordinal)
      FROM app.public_social_planning_intent_media AS planned_media
      JOIN app.company_content_versions AS media_version
        ON media_version.workspace_id = planned_media.workspace_id
       AND media_version.id = planned_media.content_version_id
      WHERE planned_media.workspace_id = intent.workspace_id
        AND planned_media.intent_id = intent.id
    ), '[]'::jsonb)
  FROM claimed
  JOIN app.public_social_planning_intents AS intent
    ON intent.workspace_id = claimed.workspace_id AND intent.id = claimed.intent_id
  JOIN app.company_content_versions AS version
    ON version.workspace_id = intent.workspace_id
   AND version.id = intent.content_version_id
  ORDER BY intent.desired_for, claimed.id;
END;
$function$;

CREATE FUNCTION app_private.claim_due_test_social_revalidations_v2(
  p_worker_id uuid, p_lease_token_hash bytea, p_batch_size integer, p_lease_seconds integer
) RETURNS TABLE (
  job_id uuid, workspace_id uuid, intent_id uuid, lease_version bigint,
  desired_for timestamptz, content_item_id uuid, content_version_id uuid,
  source_system text, source_item_id text, source_version text,
  evidence_type text, source_resource_version_id uuid, source_approval_id uuid,
  source_approved_at text, generated_source_item_id uuid,
  generated_source_version_id uuid, generated_source_item_version integer,
  generated_content_sha256 text, generated_brand_sha256 text,
  generated_lineage jsonb, content_sha256 text, blob_sha256 text,
  brand_sha256 text, media jsonb
) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'invalid revalidation claim' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT legacy.job_id, legacy.workspace_id, legacy.intent_id,
    legacy.lease_version, legacy.desired_for, legacy.content_item_id,
    legacy.content_version_id, legacy.source_system, legacy.source_item_id,
    legacy.source_version, 'legacy'::text, legacy.source_resource_version_id,
    legacy.source_approval_id, legacy.source_approved_at, NULL::uuid, NULL::uuid,
    NULL::integer, NULL::text, NULL::text, NULL::jsonb, legacy.content_sha256,
    legacy.blob_sha256, legacy.brand_sha256, legacy.media
  FROM app_private.claim_due_test_social_revalidations(
    p_worker_id, p_lease_token_hash, p_batch_size, p_lease_seconds
  ) AS legacy;
  IF FOUND THEN RETURN; END IF;

  -- Generated rows are append-only in the supported lifecycle, so validate and
  -- terminalise malformed metadata/lineage before candidate leasing.  This
  -- keeps an earliest bad row from throwing the global claim or being stranded
  -- in a lease while valid work waits behind it.
  UPDATE app.public_social_revalidation_jobs AS job
     SET state='dead_letter',lease_token_hash=NULL,lease_worker_id=NULL,
         lease_expires_at=NULL,
         last_error_code='revalidation.generated_lineage_invalid',
         updated_at=statement_timestamp(),row_version=job.row_version+1,
         completed_at=statement_timestamp()
    FROM app.public_social_planning_intents AS intent
    JOIN app.company_content_versions AS version
      ON version.workspace_id=intent.workspace_id
     AND version.content_item_id=intent.content_item_id
     AND version.id=intent.content_version_id
     AND version.content_sha256=intent.content_sha256
     AND version.blob_sha256=intent.blob_sha256
     AND version.brand_sha256=intent.brand_sha256
   WHERE intent.workspace_id=job.workspace_id AND intent.id=job.intent_id
     AND version.source_system='property_predator_generation'
     AND (
       job.state IN ('waiting_for_window','retry_wait')
       OR (job.state='leased' AND job.lease_expires_at<=statement_timestamp())
     )
     AND job.next_attempt_at<=statement_timestamp()
     AND intent.desired_for<=statement_timestamp()+interval '10 minutes'
     AND NOT EXISTS (
       WITH RECURSIVE chain AS (
         SELECT candidate.*,0 AS depth,ARRAY[candidate.id]::uuid[] AS path
         FROM app.company_content_versions AS candidate
         WHERE candidate.workspace_id=version.workspace_id
           AND candidate.id=version.id
         UNION ALL
         SELECT predecessor.*,chain.depth+1,chain.path||predecessor.id
         FROM chain
         JOIN app.company_content_versions AS predecessor
           ON predecessor.workspace_id=chain.workspace_id
          AND predecessor.content_item_id=chain.content_item_id
          AND predecessor.id=chain.previous_version_id
         WHERE chain.depth<100 AND NOT predecessor.id=ANY(chain.path)
       ), nearest_generated AS MATERIALIZED (
         SELECT candidate.* FROM chain AS candidate
         WHERE candidate.origin='generated'
         ORDER BY candidate.depth LIMIT 1
       )
       SELECT 1 FROM nearest_generated AS generated
       WHERE generated.source_system='property_predator_generation'
         AND generated.source_item_id ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND pg_catalog.pg_input_is_valid(generated.source_item_id,'uuid')
         AND generated.source_version ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:v[1-9][0-9]{0,9}$'
         AND generated.metadata->'source'->>'schema'=
           'propertypredator.generated-draft-source/v1'
         AND generated.metadata->'source'->>'sourceItemId'=generated.source_item_id
         AND generated.metadata->'source'->>'sourceDraftId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND pg_catalog.pg_input_is_valid(
           generated.metadata->'source'->>'sourceDraftId','uuid'
         )
         AND generated.metadata->'source'->>'sourceVersionId'=
           split_part(generated.source_version,':',1)
         AND generated.metadata->'source'->>'sourceVersionId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND pg_catalog.pg_input_is_valid(
           generated.metadata->'source'->>'sourceVersionId','uuid'
         )
         AND generated.metadata->'source'->>'sourceItemVersion'=
           substring(split_part(generated.source_version,':',2) FROM 2)
         AND generated.metadata->'source'->>'sourceItemVersion' ~ '^[1-9][0-9]{0,9}$'
         AND (length(generated.metadata->'source'->>'sourceItemVersion')<10
           OR generated.metadata->'source'->>'sourceItemVersion'<='2147483647')
         AND generated.metadata->'source'->>'contentSha256'=
           encode(generated.content_sha256,'hex')
         AND generated.metadata->'source'->>'brandSha256'=
           encode(generated.brand_sha256,'hex')
         AND public.digest(generated.content_body,'sha256')=generated.content_sha256
         AND NOT EXISTS (
           SELECT 1 FROM chain AS edited
           LEFT JOIN chain AS predecessor
             ON predecessor.depth=edited.depth+1
            AND predecessor.id=edited.previous_version_id
           WHERE edited.depth<generated.depth
             AND (predecessor.id IS NOT NULL
               AND edited.origin='edited'
               AND edited.metadata->>'editor'='growth_hq_exact_review'
               AND edited.metadata->>'previousContentVersionId'=predecessor.id::text
               AND edited.metadata->>'previousContentSha256'=
                 encode(predecessor.content_sha256,'hex')
               AND edited.version_number=predecessor.version_number+1
               AND edited.source_system=predecessor.source_system
               AND edited.source_item_id=predecessor.source_item_id
               AND edited.brand_sha256=predecessor.brand_sha256
               AND edited.source_version=left(predecessor.source_version,430)
                 ||':edit:'||left(encode(edited.content_sha256,'hex'),16)
             ) IS NOT TRUE
         )
     );

  -- V1 deliberately leaves every generated job untouched. V2 therefore owns
  -- the generated terminal-state and expired-lease maintenance before it
  -- selects new work; otherwise an expired generated lease can never recover.
  UPDATE app.public_social_revalidation_jobs AS job
     SET state='cancelled',lease_token_hash=NULL,lease_worker_id=NULL,
         lease_expires_at=NULL,last_error_code='revalidation.cancelled',
         updated_at=statement_timestamp(),row_version=job.row_version+1,
         completed_at=statement_timestamp()
    FROM app.public_social_planning_intents AS intent
    JOIN app.company_content_versions AS version
      ON version.workspace_id=intent.workspace_id
     AND version.id=intent.content_version_id
   WHERE intent.workspace_id=job.workspace_id AND intent.id=job.intent_id
     AND version.source_system='property_predator_generation'
     AND (
       job.state IN ('waiting_for_window','retry_wait')
       OR (job.state='leased' AND job.lease_expires_at<=statement_timestamp())
     )
     AND NOT EXISTS (
       SELECT 1 FROM app.public_social_planning_intent_targets AS target
       WHERE target.workspace_id=intent.workspace_id AND target.intent_id=intent.id
         AND NOT EXISTS (
           SELECT 1 FROM app.public_social_planning_target_cancellations AS cancellation
           WHERE cancellation.workspace_id=target.workspace_id
             AND cancellation.intent_id=target.intent_id
             AND cancellation.target_id=target.target_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM app.public_social_planning_target_supersessions AS supersession
           WHERE supersession.workspace_id=target.workspace_id
             AND supersession.predecessor_intent_id=target.intent_id
             AND supersession.predecessor_target_id=target.target_id
         )
     );

  UPDATE app.public_social_revalidation_jobs AS job
     SET state='window_expired',lease_token_hash=NULL,lease_worker_id=NULL,
         lease_expires_at=NULL,last_error_code='revalidation.window_expired',
         updated_at=statement_timestamp(),row_version=job.row_version+1,
         completed_at=statement_timestamp()
    FROM app.public_social_planning_intents AS intent
    JOIN app.company_content_versions AS version
      ON version.workspace_id=intent.workspace_id
     AND version.id=intent.content_version_id
   WHERE intent.workspace_id=job.workspace_id AND intent.id=job.intent_id
     AND version.source_system='property_predator_generation'
     AND (
       job.state IN ('waiting_for_window','retry_wait')
       OR (job.state='leased' AND job.lease_expires_at<=statement_timestamp())
     )
     AND intent.desired_for<statement_timestamp()-interval '5 minutes';

  UPDATE app.public_social_revalidation_jobs AS job
     SET state=CASE WHEN job.attempt_count>=job.max_attempts
                    THEN 'dead_letter' ELSE 'retry_wait' END,
         next_attempt_at=statement_timestamp()+interval '30 seconds',
         lease_token_hash=NULL,lease_worker_id=NULL,lease_expires_at=NULL,
         last_error_code='revalidation.lease_expired',
         updated_at=statement_timestamp(),row_version=job.row_version+1,
         completed_at=CASE WHEN job.attempt_count>=job.max_attempts
                           THEN statement_timestamp() ELSE NULL END
   WHERE job.state='leased' AND job.lease_expires_at<=statement_timestamp()
     AND EXISTS (
       SELECT 1 FROM app.public_social_planning_intents AS intent
       JOIN app.company_content_versions AS version
         ON version.workspace_id=intent.workspace_id
        AND version.id=intent.content_version_id
       WHERE intent.workspace_id=job.workspace_id AND intent.id=job.intent_id
         AND version.source_system='property_predator_generation'
     );

  RETURN QUERY
  WITH selected AS MATERIALIZED (
    SELECT job.workspace_id, job.id
    FROM app.public_social_revalidation_jobs job
    JOIN app.public_social_planning_intents intent
      ON intent.workspace_id=job.workspace_id AND intent.id=job.intent_id
    JOIN app.company_content_versions version
      ON version.workspace_id=intent.workspace_id AND version.id=intent.content_version_id
     AND version.content_item_id=intent.content_item_id
     AND version.content_sha256=intent.content_sha256
     AND version.blob_sha256=intent.blob_sha256 AND version.brand_sha256=intent.brand_sha256
    WHERE job.state IN ('waiting_for_window','retry_wait')
      AND job.next_attempt_at <= statement_timestamp()
      AND intent.desired_for BETWEEN statement_timestamp()-interval '5 minutes'
                                 AND statement_timestamp()+interval '10 minutes'
      AND version.source_system='property_predator_generation'
      AND version.origin IN ('generated','edited')
      AND public.digest(version.content_body,'sha256')=version.content_sha256
      AND app_private.public_social_body_supported(version.content_body)
      AND NOT EXISTS (SELECT 1 FROM app.company_content_versions newer
        WHERE newer.workspace_id=version.workspace_id AND newer.content_item_id=version.content_item_id
          AND newer.version_number>version.version_number)
      AND EXISTS (SELECT 1 FROM app.public_social_planning_intent_targets target
        WHERE target.workspace_id=intent.workspace_id AND target.intent_id=intent.id
          AND NOT EXISTS (SELECT 1 FROM app.public_social_planning_target_cancellations c
            WHERE c.workspace_id=target.workspace_id AND c.intent_id=target.intent_id AND c.target_id=target.target_id)
          AND NOT EXISTS (SELECT 1 FROM app.public_social_planning_target_supersessions s
            WHERE s.workspace_id=target.workspace_id AND s.predecessor_intent_id=target.intent_id
              AND s.predecessor_target_id=target.target_id))
    ORDER BY job.next_attempt_at,job.created_at,job.id FOR UPDATE OF job SKIP LOCKED
    LIMIT p_batch_size
  ), claimed AS (
    UPDATE app.public_social_revalidation_jobs job SET state='leased',
      attempt_count=job.attempt_count+1, lease_token_hash=p_lease_token_hash,
      lease_worker_id=p_worker_id,
      lease_expires_at=statement_timestamp()+make_interval(secs=>p_lease_seconds),
      lease_version=job.lease_version+1,last_error_code=NULL,
      updated_at=statement_timestamp(),row_version=job.row_version+1
    FROM selected WHERE job.workspace_id=selected.workspace_id AND job.id=selected.id RETURNING job.*
  )
  SELECT claimed.id,claimed.workspace_id,intent.id,claimed.lease_version,intent.desired_for,
    version.content_item_id,version.id,version.source_system,version.source_item_id,
    version.source_version,'generated'::text,NULL::uuid,NULL::uuid,NULL::text,
    ancestor.source_draft_id,ancestor.id,ancestor.source_item_version,
    encode(ancestor.content_sha256,'hex'),encode(ancestor.brand_sha256,'hex'),
    lineage.items,encode(version.content_sha256,'hex'),encode(version.blob_sha256,'hex'),
    encode(version.brand_sha256,'hex'),COALESCE(media.items,'[]'::jsonb)
  FROM claimed JOIN app.public_social_planning_intents intent
    ON intent.workspace_id=claimed.workspace_id AND intent.id=claimed.intent_id
  JOIN app.company_content_versions version ON version.workspace_id=intent.workspace_id AND version.id=intent.content_version_id
  CROSS JOIN LATERAL (
    WITH RECURSIVE chain AS (
      SELECT v.*,0 depth FROM app.company_content_versions v WHERE v.workspace_id=version.workspace_id AND v.id=version.id
      UNION ALL SELECT parent.*,chain.depth+1 FROM chain JOIN app.company_content_versions parent
        ON parent.workspace_id=chain.workspace_id AND parent.id=chain.previous_version_id WHERE chain.depth<100
    ) SELECT CASE WHEN pg_catalog.pg_input_is_valid(
        generated.metadata->'source'->>'sourceVersionId','uuid')
        THEN (generated.metadata->'source'->>'sourceVersionId')::uuid END AS id,
      CASE WHEN pg_catalog.pg_input_is_valid(
        generated.metadata->'source'->>'sourceDraftId','uuid')
        THEN (generated.metadata->'source'->>'sourceDraftId')::uuid END source_draft_id,
      CASE WHEN generated.metadata->'source'->>'sourceItemVersion' ~ '^[1-9][0-9]{0,9}$'
          AND (length(generated.metadata->'source'->>'sourceItemVersion')<10
            OR generated.metadata->'source'->>'sourceItemVersion'<='2147483647')
        THEN (generated.metadata->'source'->>'sourceItemVersion')::integer END source_item_version,
      generated.content_sha256,generated.brand_sha256
    FROM chain generated WHERE generated.origin='generated'
      AND generated.metadata->'source'->>'schema'='propertypredator.generated-draft-source/v1'
      AND split_part(generated.source_version, ':', 1)
        = generated.metadata->'source'->>'sourceVersionId'
    ORDER BY generated.depth LIMIT 1
  ) ancestor
  CROSS JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object(
      'contentItemId',v.content_item_id,'contentVersionId',v.id,'versionNumber',v.version_number,
      'previousVersionId',v.previous_version_id,'title',v.title,'origin',v.origin,
      'source',jsonb_build_object('system',v.source_system,'itemId',v.source_item_id,'version',v.source_version),
      'sourceMetadata',v.metadata->'source','editor',v.metadata->>'editor',
      'previousContentVersionId',v.metadata->>'previousContentVersionId',
      'previousContentSha256',v.metadata->>'previousContentSha256',
      'contentSha256',encode(v.content_sha256,'hex'),'blobSha256',encode(v.blob_sha256,'hex'),
      'brandSha256',encode(v.brand_sha256,'hex'),'approvalRequestId',NULL,
      'approvalDecisionId',NULL,'approvalStatus','unrequested','approvalStale',false
    ) ORDER BY v.version_number DESC) items FROM app.company_content_versions v
    WHERE v.workspace_id=version.workspace_id AND v.content_item_id=version.content_item_id) lineage
  LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object(
      'ordinal',m.ordinal,'contentItemId',mv.content_item_id,'contentVersionId',mv.id,
      'sourceSystem',mv.source_system,'sourceItemId',mv.source_item_id,'sourceVersion',mv.source_version,
      'sourceResourceVersionId',mv.metadata->>'sourceVersionId','sourceApprovalId',mv.metadata->>'sourceApprovalId',
      'sourceApprovedAt',mv.metadata->>'sourceApprovedAt','contentSha256',encode(mv.content_sha256,'hex'),
      'blobSha256',encode(mv.blob_sha256,'hex'),'brandSha256',encode(mv.brand_sha256,'hex')) ORDER BY m.ordinal) items
    FROM app.public_social_planning_intent_media m JOIN app.company_content_versions mv
      ON mv.workspace_id=m.workspace_id AND mv.id=m.content_version_id
    WHERE m.workspace_id=intent.workspace_id AND m.intent_id=intent.id) media ON true;
END;$function$;

CREATE FUNCTION app_private.load_leased_test_social_source_versions_v2(
  p_job_id uuid,p_worker_id uuid,p_lease_token_hash bytea,p_lease_version bigint
) RETURNS TABLE(resource_ordinal smallint,workspace_id uuid,content_item_id uuid,
  content_version_id uuid,source_system text,source_item_id text,source_version text,
  content_sha256 text,body_sha256 text,blob_sha256 text,brand_sha256 text,
  evidence_type text,source_resource_version_id uuid,source_approval_id uuid,source_approved_at text,
  generated_source_item_id uuid,generated_source_version_id uuid,generated_source_item_version integer,
  generated_content_sha256 text,generated_brand_sha256 text,generated_lineage jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE selected app.public_social_revalidation_jobs%ROWTYPE;
BEGIN
  SELECT * INTO selected FROM app.public_social_revalidation_jobs WHERE id=p_job_id;
  IF NOT FOUND OR selected.state<>'leased' OR selected.lease_worker_id IS DISTINCT FROM p_worker_id
    OR selected.lease_token_hash IS DISTINCT FROM p_lease_token_hash
    OR selected.lease_version IS DISTINCT FROM p_lease_version
    OR selected.lease_expires_at<=statement_timestamp() THEN
    RAISE EXCEPTION 'revalidation lease was lost' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT legacy.resource_ordinal,legacy.workspace_id,legacy.content_item_id,
    legacy.content_version_id,legacy.source_system,legacy.source_item_id,legacy.source_version,
    legacy.content_sha256,legacy.body_sha256,legacy.blob_sha256,legacy.brand_sha256,
    'legacy'::text,legacy.source_resource_version_id,legacy.source_approval_id,legacy.source_approved_at,
    NULL::uuid,NULL::uuid,NULL::integer,NULL::text,NULL::text,NULL::jsonb
  FROM app_private.load_leased_test_social_source_versions(p_job_id,p_worker_id,p_lease_token_hash,p_lease_version) legacy;
  IF FOUND THEN RETURN; END IF;
  RETURN QUERY
  WITH main AS (SELECT version.* FROM app.public_social_planning_intents intent
    JOIN app.company_content_versions version ON version.workspace_id=intent.workspace_id AND version.id=intent.content_version_id
    WHERE intent.workspace_id=selected.workspace_id AND intent.id=selected.intent_id
      AND version.source_system='property_predator_generation'),
  ancestor AS (
    WITH RECURSIVE chain AS (
      SELECT current.*,0 AS depth FROM main current
      UNION ALL SELECT parent.*,chain.depth+1 FROM chain
      JOIN app.company_content_versions parent
        ON parent.workspace_id=chain.workspace_id AND parent.id=chain.previous_version_id
      WHERE chain.depth<100
    )
    SELECT CASE WHEN pg_catalog.pg_input_is_valid(
        generated.metadata->'source'->>'sourceDraftId','uuid')
        THEN (generated.metadata->'source'->>'sourceDraftId')::uuid END AS source_item_id,
      CASE WHEN pg_catalog.pg_input_is_valid(
        generated.metadata->'source'->>'sourceVersionId','uuid')
        THEN (generated.metadata->'source'->>'sourceVersionId')::uuid END AS source_version_id,
      CASE WHEN generated.metadata->'source'->>'sourceItemVersion' ~ '^[1-9][0-9]{0,9}$'
          AND (length(generated.metadata->'source'->>'sourceItemVersion')<10
            OR generated.metadata->'source'->>'sourceItemVersion'<='2147483647')
        THEN (generated.metadata->'source'->>'sourceItemVersion')::integer END AS source_item_version,
      encode(generated.content_sha256,'hex') AS content_sha256,
      encode(generated.brand_sha256,'hex') AS brand_sha256
    FROM chain generated WHERE generated.origin='generated'
      AND generated.metadata->'source'->>'schema'='propertypredator.generated-draft-source/v1'
    ORDER BY generated.depth LIMIT 1
  ),
  lineage AS (SELECT jsonb_agg(jsonb_build_object(
      'contentItemId',v.content_item_id,'contentVersionId',v.id,'versionNumber',v.version_number,
      'previousVersionId',v.previous_version_id,'title',v.title,'origin',v.origin,
      'source',jsonb_build_object('system',v.source_system,'itemId',v.source_item_id,'version',v.source_version),
      'sourceMetadata',v.metadata->'source','editor',v.metadata->>'editor',
      'previousContentVersionId',v.metadata->>'previousContentVersionId','previousContentSha256',v.metadata->>'previousContentSha256',
      'contentSha256',encode(v.content_sha256,'hex'),'blobSha256',encode(v.blob_sha256,'hex'),
      'brandSha256',encode(v.brand_sha256,'hex'),'approvalRequestId',NULL,'approvalDecisionId',NULL,
      'approvalStatus','unrequested','approvalStale',false) ORDER BY v.version_number DESC) items
    FROM app.company_content_versions v,main WHERE v.workspace_id=main.workspace_id AND v.content_item_id=main.content_item_id),
  resources AS (
    SELECT 0::smallint ordinal,main.workspace_id,main.content_item_id,main.id,
      main.source_system,main.source_item_id,main.source_version,main.content_sha256,
      public.digest(main.content_body,'sha256') body_sha256,main.blob_sha256,main.brand_sha256,main.metadata,lineage.items
    FROM main,lineage
    UNION ALL SELECT m.ordinal,m.workspace_id,v.content_item_id,v.id,v.source_system,v.source_item_id,v.source_version,
      v.content_sha256,public.digest(v.content_body,'sha256'),v.blob_sha256,v.brand_sha256,v.metadata,lineage.items
    FROM app.public_social_planning_intent_media m JOIN app.company_content_versions v
      ON v.workspace_id=m.workspace_id AND v.id=m.content_version_id CROSS JOIN lineage
    WHERE m.workspace_id=selected.workspace_id AND m.intent_id=selected.intent_id)
  SELECT r.ordinal,r.workspace_id,r.content_item_id,r.id,r.source_system,r.source_item_id,r.source_version,
    encode(r.content_sha256,'hex'),encode(r.body_sha256,'hex'),encode(r.blob_sha256,'hex'),encode(r.brand_sha256,'hex'),
    CASE WHEN r.ordinal=0 THEN 'generated' ELSE 'legacy' END,
    CASE WHEN r.ordinal>0 THEN (r.metadata->>'sourceVersionId')::uuid END,
    CASE WHEN r.ordinal>0 THEN (r.metadata->>'sourceApprovalId')::uuid END,
    CASE WHEN r.ordinal>0 THEN r.metadata->>'sourceApprovedAt' END,
    CASE WHEN r.ordinal=0 THEN ancestor.source_item_id END,
    CASE WHEN r.ordinal=0 THEN ancestor.source_version_id END,
    CASE WHEN r.ordinal=0 THEN ancestor.source_item_version END,
    CASE WHEN r.ordinal=0 THEN ancestor.content_sha256 END,
    CASE WHEN r.ordinal=0 THEN ancestor.brand_sha256 END,
    CASE WHEN r.ordinal=0 THEN r.items END FROM resources r CROSS JOIN ancestor ORDER BY r.ordinal;
END;$function$;

CREATE FUNCTION app_private.complete_test_social_revalidation_v2(
  p_workspace_id uuid,p_job_id uuid,p_worker_id uuid,p_lease_token_hash bytea,p_lease_version bigint,
  p_proof_id uuid,p_content_source_resource_version_id uuid,p_content_source_approval_id uuid,
  p_content_source_approved_at timestamptz,p_media_source_resource_version_ids uuid[],
  p_media_source_approval_ids uuid[],p_media_source_approved_ats timestamptz[],
  p_source_catalog_sha256 bytea,p_checked_at timestamptz,p_expires_at timestamptz,
  p_evidence_type text,p_generated_source_item_id uuid,p_generated_source_version_id uuid,
  p_generated_source_item_version integer,p_generated_content_sha256 bytea,p_generated_brand_sha256 bytea
) RETURNS TABLE(proof_id uuid,state text,disposition text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE selected app.public_social_revalidation_jobs%ROWTYPE; intent app.public_social_planning_intents%ROWTYPE;
  valid_count integer; media_count integer;
BEGIN
  IF p_evidence_type='legacy' THEN
    IF p_generated_source_item_id IS NOT NULL OR p_generated_source_version_id IS NOT NULL
      OR p_generated_source_item_version IS NOT NULL OR p_generated_content_sha256 IS NOT NULL
      OR p_generated_brand_sha256 IS NOT NULL THEN RAISE EXCEPTION 'mixed revalidation proof' USING ERRCODE='22023'; END IF;
    RETURN QUERY SELECT * FROM app_private.complete_test_social_revalidation(p_workspace_id,p_job_id,p_worker_id,
      p_lease_token_hash,p_lease_version,p_proof_id,p_content_source_resource_version_id,p_content_source_approval_id,
      p_content_source_approved_at,p_media_source_resource_version_ids,p_media_source_approval_ids,
      p_media_source_approved_ats,p_source_catalog_sha256,p_checked_at,p_expires_at); RETURN;
  END IF;
  IF p_workspace_id IS NULL OR p_job_id IS NULL OR p_worker_id IS NULL
    OR p_lease_token_hash IS NULL OR octet_length(p_lease_token_hash)<>32
    OR p_lease_version IS NULL OR p_lease_version<=0 OR p_proof_id IS NULL
    OR p_evidence_type IS DISTINCT FROM 'generated'
    OR p_content_source_resource_version_id IS NOT NULL
    OR p_content_source_approval_id IS NOT NULL OR p_content_source_approved_at IS NOT NULL
    OR p_media_source_resource_version_ids IS NULL OR p_media_source_approval_ids IS NULL
    OR p_media_source_approved_ats IS NULL
    OR cardinality(p_media_source_resource_version_ids)>10
    OR cardinality(p_media_source_resource_version_ids)<>cardinality(p_media_source_approval_ids)
    OR cardinality(p_media_source_resource_version_ids)<>cardinality(p_media_source_approved_ats)
    OR array_position(p_media_source_resource_version_ids,NULL) IS NOT NULL
    OR array_position(p_media_source_approval_ids,NULL) IS NOT NULL
    OR array_position(p_media_source_approved_ats,NULL) IS NOT NULL
    OR p_generated_source_item_id IS NULL OR p_generated_source_version_id IS NULL
    OR p_generated_source_item_version IS NULL OR p_generated_source_item_version<1
    OR p_generated_content_sha256 IS NULL OR octet_length(p_generated_content_sha256)<>32
    OR p_generated_brand_sha256 IS NULL OR octet_length(p_generated_brand_sha256)<>32
    OR p_source_catalog_sha256 IS NULL OR octet_length(p_source_catalog_sha256)<>32
    OR p_checked_at IS NULL OR p_expires_at IS NULL
    OR p_checked_at NOT BETWEEN statement_timestamp()-interval '30 seconds' AND statement_timestamp()+interval '30 seconds'
    OR p_expires_at<=p_checked_at OR p_expires_at>p_checked_at+interval '15 minutes' THEN
    RAISE EXCEPTION 'invalid generated revalidation proof' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public-social-revalidation:'||p_workspace_id||':'||p_job_id,7200040));
  SELECT * INTO selected FROM app.public_social_revalidation_jobs WHERE workspace_id=p_workspace_id AND id=p_job_id FOR UPDATE;
  IF NOT FOUND OR selected.state<>'leased' OR selected.lease_worker_id IS DISTINCT FROM p_worker_id
    OR selected.lease_token_hash IS DISTINCT FROM p_lease_token_hash OR selected.lease_version IS DISTINCT FROM p_lease_version
    OR selected.lease_expires_at<=statement_timestamp() THEN RAISE EXCEPTION 'revalidation lease was lost' USING ERRCODE='55000'; END IF;
  SELECT * INTO intent FROM app.public_social_planning_intents WHERE workspace_id=p_workspace_id AND id=selected.intent_id;
  IF NOT FOUND OR intent.desired_for<statement_timestamp()-interval '5 minutes'
    OR intent.desired_for>statement_timestamp()+interval '10 minutes'
    OR p_expires_at<=intent.desired_for+interval '2 minutes'
    OR NOT EXISTS(SELECT 1 FROM app.public_social_planning_intent_targets target
      WHERE target.workspace_id=intent.workspace_id AND target.intent_id=intent.id
        AND NOT EXISTS(SELECT 1 FROM app.public_social_planning_target_cancellations cancellation
          WHERE cancellation.workspace_id=target.workspace_id AND cancellation.intent_id=target.intent_id
            AND cancellation.target_id=target.target_id)
        AND NOT EXISTS(SELECT 1 FROM app.public_social_planning_target_supersessions supersession
          WHERE supersession.workspace_id=target.workspace_id
            AND supersession.predecessor_intent_id=target.intent_id
            AND supersession.predecessor_target_id=target.target_id)) THEN
    RAISE EXCEPTION 'revalidation intent is outside its active TEST window' USING ERRCODE='55000';
  END IF;

  SELECT count(*) INTO valid_count
  FROM app.company_content_versions AS current
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id=intent.workspace_id AND request.id=intent.approval_request_id
   AND request.content_item_id=intent.content_item_id
   AND request.content_version_id=intent.content_version_id
   AND request.content_sha256=intent.content_sha256
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id=request.workspace_id AND decision.id=intent.approval_decision_id
   AND decision.content_item_id=request.content_item_id
   AND decision.content_version_id=request.content_version_id
   AND decision.approval_request_id=request.id
   AND decision.content_sha256=request.content_sha256 AND decision.decision='approved'
  WHERE current.workspace_id=intent.workspace_id AND current.id=intent.content_version_id
    AND current.content_item_id=intent.content_item_id AND current.content_sha256=intent.content_sha256
    AND current.blob_sha256=intent.blob_sha256 AND current.brand_sha256=intent.brand_sha256
    AND current.source_system='property_predator_generation'
    AND current.origin IN ('generated','edited')
    AND public.digest(current.content_body,'sha256')=current.content_sha256
    AND current.content_kind='social_post'
    AND app_private.public_social_body_supported(current.content_body)
    AND NOT EXISTS(SELECT 1 FROM app.company_content_versions newer
      WHERE newer.workspace_id=current.workspace_id AND newer.content_item_id=current.content_item_id
        AND newer.version_number>current.version_number)
    AND NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests later_request
      WHERE later_request.workspace_id=request.workspace_id
        AND later_request.content_item_id=request.content_item_id
        AND later_request.content_version_id=request.content_version_id
        AND later_request.request_number>request.request_number)
    AND EXISTS(
      WITH RECURSIVE chain AS (
        SELECT candidate.*,0 AS depth,ARRAY[candidate.id]::uuid[] AS path
        FROM app.company_content_versions AS candidate
        WHERE candidate.workspace_id=current.workspace_id AND candidate.id=current.id
        UNION ALL
        SELECT predecessor.*,chain.depth+1,chain.path||predecessor.id
        FROM chain JOIN app.company_content_versions AS predecessor
          ON predecessor.workspace_id=chain.workspace_id
         AND predecessor.content_item_id=chain.content_item_id
         AND predecessor.id=chain.previous_version_id
        WHERE chain.depth<100 AND NOT predecessor.id=ANY(chain.path)
      ), nearest_generated AS MATERIALIZED (
        SELECT candidate.* FROM chain AS candidate
        WHERE candidate.origin='generated' ORDER BY candidate.depth LIMIT 1
      )
      SELECT 1 FROM nearest_generated AS generated
      WHERE generated.source_system='property_predator_generation'
        AND generated.source_item_id ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND pg_catalog.pg_input_is_valid(generated.source_item_id,'uuid')
        AND generated.source_version ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:v[1-9][0-9]{0,9}$'
        AND generated.metadata->'source'->>'schema'='propertypredator.generated-draft-source/v1'
        AND generated.metadata->'source'->>'sourceItemId'=generated.source_item_id
        AND generated.metadata->'source'->>'sourceDraftId'=p_generated_source_item_id::text
        AND generated.metadata->'source'->>'sourceDraftId' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND pg_catalog.pg_input_is_valid(generated.metadata->'source'->>'sourceDraftId','uuid')
        AND generated.metadata->'source'->>'sourceVersionId'=p_generated_source_version_id::text
        AND generated.metadata->'source'->>'sourceVersionId'=split_part(generated.source_version,':',1)
        AND generated.metadata->'source'->>'sourceItemVersion'=p_generated_source_item_version::text
        AND generated.metadata->'source'->>'sourceItemVersion'=
          substring(split_part(generated.source_version,':',2) FROM 2)
        AND generated.metadata->'source'->>'sourceItemVersion' ~ '^[1-9][0-9]{0,9}$'
        AND (length(generated.metadata->'source'->>'sourceItemVersion')<10
          OR generated.metadata->'source'->>'sourceItemVersion'<='2147483647')
        AND generated.metadata->'source'->>'contentSha256'=encode(generated.content_sha256,'hex')
        AND generated.metadata->'source'->>'brandSha256'=encode(generated.brand_sha256,'hex')
        AND generated.content_sha256=p_generated_content_sha256
        AND generated.brand_sha256=p_generated_brand_sha256
        AND public.digest(generated.content_body,'sha256')=generated.content_sha256
        AND NOT EXISTS(SELECT 1 FROM chain AS edited
          LEFT JOIN chain AS predecessor ON predecessor.depth=edited.depth+1
            AND predecessor.id=edited.previous_version_id
          WHERE edited.depth<generated.depth
            AND (predecessor.id IS NOT NULL AND edited.origin='edited'
              AND edited.metadata->>'editor'='growth_hq_exact_review'
              AND edited.metadata->>'previousContentVersionId'=predecessor.id::text
              AND edited.metadata->>'previousContentSha256'=encode(predecessor.content_sha256,'hex')
              AND edited.version_number=predecessor.version_number+1
              AND edited.source_system=predecessor.source_system
              AND edited.source_item_id=predecessor.source_item_id
              AND edited.brand_sha256=predecessor.brand_sha256
              AND edited.source_version=left(predecessor.source_version,430)
                ||':edit:'||left(encode(edited.content_sha256,'hex'),16)) IS NOT TRUE)
    );
  IF valid_count<>1 THEN RAISE EXCEPTION 'fresh exact generated content proof is unavailable' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO media_count FROM app.public_social_planning_intent_media WHERE workspace_id=p_workspace_id AND intent_id=intent.id;
  IF cardinality(p_media_source_resource_version_ids)<>media_count THEN
    RAISE EXCEPTION 'revalidation media proof count is invalid' USING ERRCODE='22023'; END IF;
  IF media_count<> (SELECT count(*) FROM unnest(p_media_source_resource_version_ids,p_media_source_approval_ids,p_media_source_approved_ats)
    WITH ORDINALITY supplied(resource_id,approval_id,approved_at,ordinal)
    JOIN app.public_social_planning_intent_media m ON m.workspace_id=p_workspace_id AND m.intent_id=intent.id AND m.ordinal=supplied.ordinal
    JOIN app.company_content_versions v ON v.workspace_id=m.workspace_id
      AND v.content_item_id=m.content_item_id AND v.id=m.content_version_id
      AND v.content_sha256=m.content_sha256 AND v.blob_sha256=m.blob_sha256
      AND v.brand_sha256=m.brand_sha256 AND v.source_system='propertypredator.company-content'
      AND v.source_item_id ~ '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      AND v.source_version ~ '^[1-9][0-9]{0,9}$'
      AND (length(v.source_version)<10 OR v.source_version<='2147483647')
      AND CASE WHEN v.metadata->>'sourceVersionId' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND pg_catalog.pg_input_is_valid(v.metadata->>'sourceVersionId','uuid')
        THEN (v.metadata->>'sourceVersionId')::uuid=supplied.resource_id ELSE false END
      AND CASE WHEN v.metadata->>'sourceApprovalId' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND pg_catalog.pg_input_is_valid(v.metadata->>'sourceApprovalId','uuid')
        THEN (v.metadata->>'sourceApprovalId')::uuid=supplied.approval_id ELSE false END
      AND CASE WHEN v.metadata->>'sourceApprovedAt' ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
        AND pg_catalog.pg_input_is_valid(v.metadata->>'sourceApprovedAt','timestamp with time zone')
        THEN (v.metadata->>'sourceApprovedAt')::timestamptz=supplied.approved_at ELSE false END
      AND supplied.approved_at<=p_checked_at AND v.content_kind IN ('image','video')
    JOIN app.company_content_approval_requests req ON req.workspace_id=m.workspace_id
      AND req.id=m.approval_request_id AND req.content_item_id=m.content_item_id
      AND req.content_version_id=m.content_version_id AND req.content_sha256=m.content_sha256
    JOIN app.company_content_approval_decisions dec ON dec.workspace_id=req.workspace_id
      AND dec.id=m.approval_decision_id AND dec.content_item_id=req.content_item_id
      AND dec.content_version_id=req.content_version_id AND dec.approval_request_id=req.id
      AND dec.content_sha256=req.content_sha256 AND dec.decision='approved'
    WHERE app_private.public_social_media_payload_supported(v.blob_storage_key,v.content_mime_type)
      AND NOT EXISTS(SELECT 1 FROM app.company_content_versions newer
        WHERE newer.workspace_id=v.workspace_id AND newer.content_item_id=v.content_item_id
          AND newer.version_number>v.version_number)
      AND NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests later_request
        WHERE later_request.workspace_id=req.workspace_id
          AND later_request.content_item_id=req.content_item_id
          AND later_request.content_version_id=req.content_version_id
          AND later_request.request_number>req.request_number))
  THEN RAISE EXCEPTION 'fresh exact media proof is unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO app.public_social_revalidation_proofs(id,workspace_id,job_id,intent_id,intent_sha256,
    content_item_id,content_version_id,content_sha256,blob_sha256,brand_sha256,evidence_type,
    generated_source_item_id,generated_source_version_id,generated_source_item_version,
    generated_content_sha256,generated_brand_sha256,source_catalog_sha256,checked_at,expires_at,worker_id,lease_version)
  VALUES(p_proof_id,p_workspace_id,p_job_id,intent.id,intent.intent_sha256,intent.content_item_id,
    intent.content_version_id,intent.content_sha256,intent.blob_sha256,intent.brand_sha256,'generated',
    p_generated_source_item_id,p_generated_source_version_id,p_generated_source_item_version,
    p_generated_content_sha256,p_generated_brand_sha256,p_source_catalog_sha256,p_checked_at,p_expires_at,p_worker_id,p_lease_version);
  INSERT INTO app.public_social_revalidation_proof_media(workspace_id,proof_id,intent_id,ordinal,content_item_id,
    content_version_id,content_sha256,blob_sha256,brand_sha256,source_resource_version_id,source_approval_id,
    source_approved_at,source_catalog_sha256,checked_at,expires_at)
  SELECT p_workspace_id,p_proof_id,intent.id,m.ordinal,m.content_item_id,m.content_version_id,m.content_sha256,
    m.blob_sha256,m.brand_sha256,s.resource_id,s.approval_id,s.approved_at,p_source_catalog_sha256,p_checked_at,p_expires_at
  FROM unnest(p_media_source_resource_version_ids,p_media_source_approval_ids,p_media_source_approved_ats)
    WITH ORDINALITY s(resource_id,approval_id,approved_at,ordinal)
  JOIN app.public_social_planning_intent_media m ON m.workspace_id=p_workspace_id AND m.intent_id=intent.id AND m.ordinal=s.ordinal;
  UPDATE app.public_social_revalidation_jobs SET state='verified',current_proof_id=p_proof_id,
    lease_token_hash=NULL,lease_worker_id=NULL,lease_expires_at=NULL,last_error_code=NULL,
    updated_at=statement_timestamp(),row_version=row_version+1 WHERE workspace_id=p_workspace_id AND id=p_job_id;
  RETURN QUERY SELECT p_proof_id,'verified'::text,'applied'::text;
END;$function$;

CREATE FUNCTION app_private.complete_and_materialize_test_social_revalidation_v2(
  p_workspace_id uuid,p_job_id uuid,p_worker_id uuid,p_lease_token_hash bytea,p_lease_version bigint,
  p_proof_id uuid,p_post_id uuid,p_content_source_resource_version_id uuid,p_content_source_approval_id uuid,
  p_content_source_approved_at timestamptz,p_media_source_resource_version_ids uuid[],p_media_source_approval_ids uuid[],
  p_media_source_approved_ats timestamptz[],p_source_catalog_sha256 bytea,p_checked_at timestamptz,p_expires_at timestamptz,
  p_evidence_type text,p_generated_source_item_id uuid,p_generated_source_version_id uuid,
  p_generated_source_item_version integer,p_generated_content_sha256 bytea,p_generated_brand_sha256 bytea
) RETURNS TABLE(proof_id uuid,post_id uuid,operation_ids uuid[],disposition text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE completed record; materialized record;
BEGIN
  SELECT * INTO STRICT completed FROM app_private.complete_test_social_revalidation_v2(p_workspace_id,p_job_id,
    p_worker_id,p_lease_token_hash,p_lease_version,p_proof_id,p_content_source_resource_version_id,p_content_source_approval_id,
    p_content_source_approved_at,p_media_source_resource_version_ids,p_media_source_approval_ids,p_media_source_approved_ats,
    p_source_catalog_sha256,p_checked_at,p_expires_at,p_evidence_type,p_generated_source_item_id,
    p_generated_source_version_id,p_generated_source_item_version,p_generated_content_sha256,p_generated_brand_sha256);
  SELECT * INTO STRICT materialized FROM app_private.materialize_test_social_planning_intent(p_workspace_id,p_job_id,p_proof_id,p_post_id);
  RETURN QUERY SELECT p_proof_id,p_post_id,materialized.operation_ids::uuid[],materialized.disposition::text;
END;$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_public_social_definer;
REVOKE ALL ON FUNCTION app_private.claim_due_test_social_revalidations_v2(uuid,bytea,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.load_leased_test_social_source_versions_v2(uuid,uuid,bytea,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.complete_test_social_revalidation_v2(uuid,uuid,uuid,bytea,bigint,uuid,uuid,uuid,timestamptz,uuid[],uuid[],timestamptz[],bytea,timestamptz,timestamptz,text,uuid,uuid,integer,bytea,bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.complete_and_materialize_test_social_revalidation_v2(uuid,uuid,uuid,bytea,bigint,uuid,uuid,uuid,uuid,timestamptz,uuid[],uuid[],timestamptz[],bytea,timestamptz,timestamptz,text,uuid,uuid,integer,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.claim_due_test_social_revalidations_v2(uuid,bytea,integer,integer),
 app_private.load_leased_test_social_source_versions_v2(uuid,uuid,bytea,bigint),
 app_private.complete_and_materialize_test_social_revalidation_v2(uuid,uuid,uuid,bytea,bigint,uuid,uuid,uuid,uuid,timestamptz,uuid[],uuid[],timestamptz[],bytea,timestamptz,timestamptz,text,uuid,uuid,integer,bytea,bytea)
TO r72_public_social_revalidator_command;

DO $capability_audit$
DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'app_private.claim_due_test_social_revalidations_v2(uuid,bytea,integer,integer)',
    'app_private.load_leased_test_social_source_versions_v2(uuid,uuid,bytea,bigint)',
    'app_private.complete_test_social_revalidation_v2(uuid,uuid,uuid,bytea,bigint,uuid,uuid,uuid,timestamptz,uuid[],uuid[],timestamptz[],bytea,timestamptz,timestamptz,text,uuid,uuid,integer,bytea,bytea)',
    'app_private.complete_and_materialize_test_social_revalidation_v2(uuid,uuid,uuid,bytea,bigint,uuid,uuid,uuid,uuid,timestamptz,uuid[],uuid[],timestamptz[],bytea,timestamptz,timestamptz,text,uuid,uuid,integer,bytea,bytea)'
  ] LOOP
    IF pg_catalog.to_regprocedure(signature) IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.oid = pg_catalog.to_regprocedure(signature)
        AND procedure.proowner = 'r72_public_social_definer'::regrole
        AND procedure.prosecdef
        AND procedure.proconfig @> ARRAY['search_path=pg_catalog']::text[]
        AND NOT pg_catalog.has_function_privilege('public', procedure.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'generated social capability audit failed: %', signature;
    END IF;
  END LOOP;
  IF pg_catalog.has_function_privilege('r72_public_social_revalidator_command',
       'app_private.complete_test_social_revalidation_v2(uuid,uuid,uuid,bytea,bigint,uuid,uuid,uuid,timestamptz,uuid[],uuid[],timestamptz[],bytea,timestamptz,timestamptz,text,uuid,uuid,integer,bytea,bytea)', 'EXECUTE') THEN
    RAISE EXCEPTION 'internal generated completion leaked to runtime role';
  END IF;
END
$capability_audit$;

RESET ROLE;
COMMIT;
