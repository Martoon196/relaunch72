-- PRIVATE DRAFT. Native source adapter into canonical planning tables; no alternate queue.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_public_social_definer;
SET LOCAL ROLE r72_public_social_definer;
CREATE FUNCTION app_private.creative_media_create_planning_intent(
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
  IF cardinality(p_media_version_ids)<>1 OR cardinality(p_target_ids)<>1 THEN RAISE EXCEPTION 'One exact native video and account required' USING ERRCODE='22023'; END IF;
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
    AND app_private.creative_media_native_post_current(p_workspace_id,version.id,true)
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
  WHERE target.environment = 'test' AND target.network=(SELECT metadata->>'network' FROM app.company_content_versions WHERE workspace_id=p_workspace_id AND id=p_content_version_id)
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
      AND app_private.creative_media_native_version_current(p_workspace_id,version.id,true)
      AND version.id=(SELECT (metadata->>'nativeVideoVersionId')::uuid FROM app.company_content_versions WHERE workspace_id=p_workspace_id AND id=p_content_version_id)
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
REVOKE ALL ON FUNCTION app_private.creative_media_create_planning_intent(uuid,uuid,uuid,uuid,uuid,timestamptz,smallint,uuid[],uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_create_planning_intent(uuid,uuid,uuid,uuid,uuid,timestamptz,smallint,uuid[],uuid[]) TO r72_public_social_command;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_public_social_definer;
