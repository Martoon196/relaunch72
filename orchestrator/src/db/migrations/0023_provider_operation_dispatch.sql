-- Fenced, test-only provider operation dispatch. Runtime identities receive
-- function execution, never direct queue mutation. An expired remote-call
-- lease is ambiguous and is therefore reconciled, never blindly re-sent.

DO $provider_operation_role$
DECLARE
  unexpected_member text;
  unexpected_parent text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_provider_operation_definer'
  ) THEN
    CREATE ROLE r72_provider_operation_definer NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_provider_operation_definer'
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe role attributes: r72_provider_operation_definer';
  END IF;

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer, r72_commerce_definer,
    r72_external_event_definer, r72_growth_projector_definer,
    r72_journey_projector_definer, r72_legacy_materializer_definer
    FROM r72_provider_operation_definer;
  REVOKE r72_provider_operation_definer
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
      r72_crm_command, r72_identity_command, r72_provisioning_command,
      r72_setup_delivery_command, r72_setup_reissue_command,
      r72_external_event_command, r72_import_command, r72_content_command;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_provider_operation_definer'
  LIMIT 1;
  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe provider-operation definer parent: %', unexpected_parent;
  END IF;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_provider_operation_definer'
    AND member.rolname NOT IN ('r72_owner', current_user)
  LIMIT 1;
  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe provider-operation definer grant: %', unexpected_member;
  END IF;

  GRANT r72_provider_operation_definer TO r72_owner;
END;
$provider_operation_role$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private FROM r72_provider_operation_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_provider_operation_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_provider_operation_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_provider_operation_definer;
REVOKE CREATE ON SCHEMA public FROM r72_provider_operation_definer;

GRANT USAGE ON SCHEMA app, app_private TO r72_provider_operation_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_actor_kind(),
  app_private.current_request_id(),
  app_private.can_manage_workspace(uuid, uuid)
TO r72_provider_operation_definer;

CREATE POLICY provider_connections_dispatch_definer_select
  ON app.provider_connections FOR SELECT TO r72_provider_operation_definer
  USING (true);
CREATE POLICY message_versions_dispatch_definer_select
  ON app.message_versions FOR SELECT TO r72_provider_operation_definer
  USING (true);
CREATE POLICY provider_operations_dispatch_definer_all
  ON app.provider_operations FOR ALL TO r72_provider_operation_definer
  USING (true) WITH CHECK (true);
CREATE POLICY message_deliveries_dispatch_definer_all
  ON app.message_deliveries FOR ALL TO r72_provider_operation_definer
  USING (true) WITH CHECK (true);
CREATE POLICY provider_operation_attempts_dispatch_definer_all
  ON app.provider_operation_attempts FOR ALL TO r72_provider_operation_definer
  USING (true) WITH CHECK (true);
CREATE POLICY provider_operation_receipts_dispatch_definer_all
  ON app.provider_operation_receipts FOR ALL TO r72_provider_operation_definer
  USING (true) WITH CHECK (true);
CREATE POLICY contact_points_dispatch_definer_select
  ON app.contact_points FOR SELECT TO r72_provider_operation_definer
  USING (true);
CREATE POLICY communication_consent_events_dispatch_definer_select
  ON app.communication_consent_events FOR SELECT TO r72_provider_operation_definer
  USING (true);
CREATE POLICY communication_suppression_events_dispatch_definer_select
  ON app.communication_suppression_events FOR SELECT TO r72_provider_operation_definer
  USING (true);
CREATE POLICY activities_dispatch_definer_insert
  ON app.activities FOR INSERT TO r72_provider_operation_definer
  WITH CHECK (true);
CREATE POLICY outbox_events_dispatch_definer_insert
  ON app.outbox_events FOR INSERT TO r72_provider_operation_definer
  WITH CHECK (true);

GRANT SELECT ON app.provider_connections, app.message_versions
TO r72_provider_operation_definer;
GRANT SELECT ON app.contact_points, app.communication_consent_events,
  app.communication_suppression_events TO r72_provider_operation_definer;
GRANT SELECT, UPDATE ON app.provider_operations, app.message_deliveries,
  app.provider_operation_attempts TO r72_provider_operation_definer;
GRANT INSERT ON app.provider_operation_attempts,
  app.provider_operation_receipts, app.activities, app.outbox_events
TO r72_provider_operation_definer;
GRANT SELECT ON app.provider_operation_receipts TO r72_provider_operation_definer;

GRANT CREATE ON SCHEMA app_private TO r72_provider_operation_definer;
SET LOCAL ROLE r72_provider_operation_definer;

CREATE FUNCTION app_private.claim_provider_operations(
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_batch_size integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  operation_id uuid,
  workspace_id uuid,
  provider_connection_id uuid,
  message_delivery_id uuid,
  environment text,
  idempotency_key text,
  correlation_id uuid,
  attempt_number smallint,
  lease_version bigint,
  lease_expires_at timestamptz,
  attempt_kind text,
  provider_reference text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_worker_id IS NULL
     OR p_lease_token_hash IS NULL
     OR octet_length(p_lease_token_hash) <> 32
     OR p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 25
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'invalid provider operation claim input' USING ERRCODE = '22023';
  END IF;

  -- Once a provider call began, lease expiry is ambiguous. Preserve that fact
  -- and require reconciliation instead of putting the send back on the queue.
  UPDATE app.provider_operation_attempts AS attempt
     SET state = 'needs_attention', retryable = false,
         error_code = 'ambiguous_lease_expiry',
         safe_summary = 'Provider call lease expired; reconciliation required',
         completed_at = statement_timestamp()
   WHERE attempt.state = 'calling'
     AND EXISTS (
       SELECT 1
       FROM app.provider_operations AS operation
       JOIN app.provider_connections AS connection
         ON connection.workspace_id = operation.workspace_id
        AND connection.id = operation.provider_connection_id
        AND connection.environment = operation.environment
       WHERE operation.workspace_id = attempt.workspace_id
         AND operation.id = attempt.provider_operation_id
         AND operation.state = 'calling'
         AND operation.lease_version = attempt.lease_version
         AND operation.lease_expires_at <= statement_timestamp()
         AND operation.environment = 'test'
         AND connection.provider_id = 'test_conversation'
         AND connection.environment = 'test'
         AND connection.status = 'active'
     );

  UPDATE app.message_deliveries AS delivery
     SET status = 'reconciliation_required', updated_at = statement_timestamp()
   WHERE delivery.status = 'sending'
     AND EXISTS (
       SELECT 1
       FROM app.provider_operations AS operation
       JOIN app.provider_connections AS connection
         ON connection.workspace_id = operation.workspace_id
        AND connection.id = operation.provider_connection_id
        AND connection.environment = operation.environment
       WHERE operation.workspace_id = delivery.workspace_id
         AND operation.id = delivery.provider_operation_id
         AND operation.state = 'calling'
         AND operation.lease_expires_at <= statement_timestamp()
         AND operation.environment = 'test'
         AND connection.provider_id = 'test_conversation'
         AND connection.environment = 'test'
         AND connection.status = 'active'
     );

  UPDATE app.provider_operations AS operation
     SET state = 'reconciliation_required',
         lease_token_hash = NULL, lease_expires_at = NULL,
         next_attempt_at = statement_timestamp() + interval '30 seconds',
         last_error_code = 'ambiguous_lease_expiry',
         last_summary = 'Provider call lease expired; reconciliation required',
         row_version = operation.row_version + 1,
         updated_at = statement_timestamp()
   WHERE operation.state = 'calling'
     AND operation.lease_expires_at <= statement_timestamp()
     AND operation.environment = 'test'
     AND EXISTS (
       SELECT 1
       FROM app.provider_connections AS connection
       WHERE connection.workspace_id = operation.workspace_id
         AND connection.id = operation.provider_connection_id
         AND connection.environment = operation.environment
         AND connection.provider_id = 'test_conversation'
         AND connection.environment = 'test'
         AND connection.status = 'active'
     );

  -- A lease that expired before mark-calling is safe to reclaim: the provider
  -- boundary was never crossed.
  UPDATE app.provider_operation_attempts AS attempt
     SET state = 'failed', retryable = true,
         error_code = 'lease_expired_before_call',
         safe_summary = 'Lease expired before provider call',
         completed_at = statement_timestamp()
   WHERE attempt.state = 'leased'
     AND EXISTS (
       SELECT 1
       FROM app.provider_operations AS operation
       JOIN app.provider_connections AS connection
         ON connection.workspace_id = operation.workspace_id
        AND connection.id = operation.provider_connection_id
        AND connection.environment = operation.environment
       WHERE operation.workspace_id = attempt.workspace_id
         AND operation.id = attempt.provider_operation_id
         AND operation.state = 'leased'
         AND operation.lease_version = attempt.lease_version
         AND operation.lease_expires_at <= statement_timestamp()
         AND operation.environment = 'test'
         AND connection.provider_id = 'test_conversation'
         AND connection.environment = 'test'
         AND connection.status = 'active'
     );

  UPDATE app.message_deliveries AS delivery
     SET status = 'failed', failed_at = statement_timestamp(),
         updated_at = statement_timestamp()
   WHERE delivery.status = 'queued'
     AND EXISTS (
       SELECT 1
       FROM app.provider_operations AS operation
       JOIN app.provider_connections AS connection
         ON connection.workspace_id = operation.workspace_id
        AND connection.id = operation.provider_connection_id
        AND connection.environment = operation.environment
       WHERE operation.workspace_id = delivery.workspace_id
         AND operation.id = delivery.provider_operation_id
         AND operation.state = 'leased'
         AND operation.lease_expires_at <= statement_timestamp()
         AND operation.attempt_count >= operation.max_attempts
         AND operation.environment = 'test'
         AND connection.provider_id = 'test_conversation'
         AND connection.environment = 'test'
         AND connection.status = 'active'
     );

  UPDATE app.provider_operations AS operation
     SET state = 'dead_letter', lease_token_hash = NULL,
         lease_expires_at = NULL, completed_at = statement_timestamp(),
         last_error_code = 'attempt_limit_exhausted',
         last_summary = 'Provider operation attempt limit exhausted',
         row_version = operation.row_version + 1,
         updated_at = statement_timestamp()
   WHERE operation.state = 'leased'
     AND operation.lease_expires_at <= statement_timestamp()
     AND operation.attempt_count >= operation.max_attempts
     AND operation.environment = 'test'
     AND EXISTS (
       SELECT 1
       FROM app.provider_connections AS connection
       WHERE connection.workspace_id = operation.workspace_id
         AND connection.id = operation.provider_connection_id
         AND connection.environment = operation.environment
         AND connection.provider_id = 'test_conversation'
         AND connection.environment = 'test'
         AND connection.status = 'active'
     );

  RETURN QUERY
  WITH candidates AS (
    SELECT operation.id,
           CASE WHEN operation.state = 'reconciliation_required'
             THEN 'reconcile' ELSE 'dispatch' END AS selected_attempt_kind
    FROM app.provider_operations AS operation
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = operation.workspace_id
     AND connection.id = operation.provider_connection_id
     AND connection.environment = operation.environment
    WHERE connection.provider_id = 'test_conversation'
      AND connection.environment = 'test'
      AND connection.status = 'active'
      AND operation.environment = 'test'
      AND operation.attempt_count < operation.max_attempts
      AND operation.next_attempt_at <= statement_timestamp()
      AND (
        operation.state IN ('queued', 'retry_wait')
        OR (operation.state = 'leased'
          AND operation.lease_expires_at <= statement_timestamp())
        OR (operation.state = 'reconciliation_required'
          AND operation.provider_reference IS NOT NULL)
      )
    ORDER BY operation.next_attempt_at, operation.created_at, operation.id
    FOR UPDATE OF operation SKIP LOCKED
    LIMIT p_batch_size
  ), claimed AS (
    UPDATE app.provider_operations AS operation
       SET state = 'leased', lease_token_hash = p_lease_token_hash,
           lease_expires_at = statement_timestamp()
             + pg_catalog.make_interval(secs => p_lease_seconds),
           attempt_count = operation.attempt_count + 1,
           lease_version = operation.lease_version + 1,
           last_error_code = NULL, last_summary = NULL,
           row_version = operation.row_version + 1,
           updated_at = statement_timestamp()
      FROM candidates
     WHERE operation.id = candidates.id
    RETURNING operation.*, candidates.selected_attempt_kind
  ), attempts AS (
    INSERT INTO app.provider_operation_attempts AS inserted_attempt (
      id, workspace_id, provider_operation_id, attempt_number,
      worker_id, lease_version, attempt_kind, state, started_at
    )
    SELECT public.gen_random_uuid(), claimed.workspace_id, claimed.id,
           claimed.attempt_count, p_worker_id, claimed.lease_version,
           claimed.selected_attempt_kind, 'leased', statement_timestamp()
    FROM claimed
    RETURNING inserted_attempt.workspace_id,
              inserted_attempt.provider_operation_id,
              inserted_attempt.attempt_number,
              inserted_attempt.lease_version,
              inserted_attempt.attempt_kind
  )
  SELECT operation.id, operation.workspace_id,
         operation.provider_connection_id, delivery.id,
         operation.environment, operation.idempotency_key,
         operation.correlation_id, attempts.attempt_number,
         attempts.lease_version, operation.lease_expires_at,
         attempts.attempt_kind, operation.provider_reference
  FROM attempts
  JOIN claimed AS operation
    ON operation.workspace_id = attempts.workspace_id
   AND operation.id = attempts.provider_operation_id
  JOIN app.message_deliveries AS delivery
    ON delivery.workspace_id = operation.workspace_id
   AND delivery.provider_operation_id = operation.id
   AND delivery.id = operation.message_delivery_id
  ORDER BY operation.created_at, operation.id;
END;
$function$;

-- Return one exact, currently leased TEST dispatch payload. The login worker
-- cannot SELECT inbox tables directly; possession of the active worker/lease
-- tuple is required to cross this narrow payload boundary.
CREATE FUNCTION app_private.load_test_provider_dispatch_payload(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_delivery_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint
)
RETURNS TABLE (
  workspace_id uuid,
  provider_connection_id uuid,
  provider_id text,
  environment text,
  conversation_id uuid,
  message_id uuid,
  message_version_id uuid,
  body text,
  body_sha256 text,
  contact_point_id uuid,
  recipient text,
  channel text,
  consent_channel text,
  purpose text,
  consent_event_id uuid,
  eligibility_status text,
  eligibility_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_operation_id IS NULL OR p_delivery_id IS NULL
     OR p_worker_id IS NULL
     OR p_lease_token_hash IS NULL OR octet_length(p_lease_token_hash) <> 32
     OR p_lease_version IS NULL OR p_lease_version < 1 THEN
    RAISE EXCEPTION 'invalid provider dispatch payload input' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH leased AS (
    SELECT operation.workspace_id,
           operation.provider_connection_id,
           connection.provider_id,
           operation.environment,
           delivery.conversation_id,
           delivery.message_id,
           delivery.message_version_id,
           version.body_text AS body,
           pg_catalog.encode(version.body_sha256, 'hex') AS body_sha256,
           delivery.contact_point_id,
           point.normalized_value AS recipient,
           delivery.conversation_channel AS channel,
           delivery.consent_channel,
           delivery.purpose,
           delivery.consent_event_id,
           point.deleted_at IS NULL
             AND point.is_verified
             AND point.dedupe_state = 'normal'
             AND point.kind = (CASE delivery.consent_channel
               WHEN 'email' THEN 'email'
               WHEN 'sms' THEN 'phone'
               WHEN 'whatsapp' THEN 'whatsapp'
               ELSE 'social' END)
             AND delivery.endpoint_identity_sha256 = public.digest(
               point.kind || pg_catalog.chr(31)
                 || point.value || pg_catalog.chr(31) || point.normalized_value,
               'sha256'
             ) AS endpoint_valid
    FROM app.provider_operations AS operation
    JOIN app.provider_operation_attempts AS attempt
      ON attempt.workspace_id = operation.workspace_id
     AND attempt.provider_operation_id = operation.id
     AND attempt.worker_id = p_worker_id
     AND attempt.lease_version = p_lease_version
     AND attempt.attempt_kind = 'dispatch'
     AND attempt.state = 'leased'
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = operation.workspace_id
     AND connection.id = operation.provider_connection_id
     AND connection.environment = operation.environment
     AND connection.provider_id = 'test_conversation'
     AND connection.environment = 'test'
     AND connection.status = 'active'
    JOIN app.message_deliveries AS delivery
      ON delivery.workspace_id = operation.workspace_id
     AND delivery.provider_operation_id = operation.id
     AND delivery.id = p_delivery_id
     AND delivery.id = operation.message_delivery_id
     AND delivery.environment = 'test'
     AND delivery.status = 'queued'
    JOIN app.message_versions AS version
      ON version.workspace_id = delivery.workspace_id
     AND version.conversation_id = delivery.conversation_id
     AND version.message_id = delivery.message_id
     AND version.id = delivery.message_version_id
     AND version.version_number = delivery.version_number
     AND version.body_sha256 = delivery.body_sha256
    JOIN app.contact_points AS point
      ON point.workspace_id = delivery.workspace_id
     AND point.id = delivery.contact_point_id
     AND point.contact_id = delivery.contact_id
    WHERE operation.workspace_id = p_workspace_id
      AND operation.id = p_operation_id
      AND operation.state = 'leased'
      AND operation.environment = 'test'
      AND operation.lease_token_hash = p_lease_token_hash
      AND operation.lease_version = p_lease_version
      AND operation.lease_expires_at > statement_timestamp()
  ), evaluated AS (
    SELECT leased.*,
           latest_consent.id AS latest_consent_id,
           latest_consent.state AS latest_consent_state,
           EXISTS (
             SELECT 1
             FROM (
               SELECT DISTINCT ON (coalesce(suppression.purpose, ''))
                 suppression.state
               FROM app.communication_suppression_events AS suppression
               WHERE suppression.workspace_id = leased.workspace_id
                 AND suppression.contact_point_id = leased.contact_point_id
                 AND suppression.channel = leased.consent_channel
                 AND (suppression.purpose IS NULL
                   OR suppression.purpose = leased.purpose)
                 AND suppression.endpoint_identity_sha256 = public.digest(
                   (CASE leased.consent_channel
                     WHEN 'email' THEN 'email'
                     WHEN 'sms' THEN 'phone'
                     WHEN 'whatsapp' THEN 'whatsapp'
                     ELSE 'social' END)
                     || pg_catalog.chr(31) || point.value
                     || pg_catalog.chr(31) || point.normalized_value,
                   'sha256'
                 )
                 AND suppression.occurred_at
                   <= statement_timestamp() + interval '5 minutes'
               ORDER BY coalesce(suppression.purpose, ''),
                 suppression.occurred_at DESC, suppression.recorded_at DESC,
                 suppression.id DESC
             ) AS current_suppression
             WHERE current_suppression.state = 'suppressed'
           ) AS suppressed
    FROM leased
    JOIN app.contact_points AS point
      ON point.workspace_id = leased.workspace_id
     AND point.id = leased.contact_point_id
    LEFT JOIN LATERAL (
      SELECT consent.id, consent.state
      FROM app.communication_consent_events AS consent
      WHERE consent.workspace_id = leased.workspace_id
        AND consent.contact_point_id = leased.contact_point_id
        AND consent.channel = leased.consent_channel
        AND consent.purpose = leased.purpose
        AND consent.endpoint_identity_sha256 = public.digest(
          (CASE leased.consent_channel
            WHEN 'email' THEN 'email'
            WHEN 'sms' THEN 'phone'
            WHEN 'whatsapp' THEN 'whatsapp'
            ELSE 'social' END)
            || pg_catalog.chr(31) || point.value
            || pg_catalog.chr(31) || point.normalized_value,
          'sha256'
        )
        AND consent.occurred_at <= statement_timestamp() + interval '5 minutes'
      ORDER BY consent.occurred_at DESC, consent.recorded_at DESC, consent.id DESC
      LIMIT 1
    ) AS latest_consent ON true
  )
  SELECT evaluated.workspace_id,
         evaluated.provider_connection_id,
         evaluated.provider_id,
         evaluated.environment,
         evaluated.conversation_id,
         evaluated.message_id,
         evaluated.message_version_id,
         evaluated.body,
         evaluated.body_sha256,
         evaluated.contact_point_id,
         evaluated.recipient,
         evaluated.channel,
         evaluated.consent_channel,
         evaluated.purpose,
         CASE
           WHEN evaluated.endpoint_valid
             AND evaluated.latest_consent_id = evaluated.consent_event_id
             AND evaluated.latest_consent_state = 'granted'
             AND NOT evaluated.suppressed
             THEN evaluated.latest_consent_id
           ELSE NULL
         END AS consent_event_id,
         CASE
           WHEN NOT evaluated.endpoint_valid THEN 'blocked'
           WHEN evaluated.latest_consent_id IS NULL THEN 'unknown'
           WHEN evaluated.latest_consent_id IS DISTINCT FROM evaluated.consent_event_id
             OR evaluated.latest_consent_state <> 'granted' THEN 'blocked'
           WHEN evaluated.suppressed THEN 'blocked'
           ELSE 'allowed'
         END AS eligibility_status,
         CASE
           WHEN NOT evaluated.endpoint_valid THEN 'endpoint_unavailable'
           WHEN evaluated.latest_consent_id IS NULL THEN 'consent_unknown'
           WHEN evaluated.latest_consent_id IS DISTINCT FROM evaluated.consent_event_id
             OR evaluated.latest_consent_state <> 'granted' THEN 'consent_changed'
           WHEN evaluated.suppressed THEN 'suppressed'
           ELSE 'consent_granted'
         END AS eligibility_reason
  FROM evaluated;
END;
$function$;

CREATE FUNCTION app_private.mark_provider_operation_calling(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  selected_attempt_kind text;
  dispatch_consent_allowed boolean;
BEGIN
  IF p_workspace_id IS NULL OR p_operation_id IS NULL OR p_worker_id IS NULL
     OR p_lease_token_hash IS NULL OR octet_length(p_lease_token_hash) <> 32
     OR p_lease_version IS NULL OR p_lease_version < 1 THEN
    RAISE EXCEPTION 'invalid provider operation calling input' USING ERRCODE = '22023';
  END IF;

  SELECT attempt.attempt_kind INTO selected_attempt_kind
  FROM app.provider_operation_attempts AS attempt
  WHERE attempt.workspace_id = p_workspace_id
    AND attempt.provider_operation_id = p_operation_id
    AND attempt.worker_id = p_worker_id
    AND attempt.lease_version = p_lease_version
    AND attempt.state = 'leased'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider operation lease was lost' USING ERRCODE = '40001';
  END IF;

  IF selected_attempt_kind = 'dispatch' THEN
    SELECT EXISTS (
      SELECT 1
      FROM app.message_deliveries AS delivery
      JOIN app.contact_points AS point
        ON point.workspace_id = delivery.workspace_id
       AND point.id = delivery.contact_point_id
       AND point.contact_id = delivery.contact_id
       AND point.deleted_at IS NULL
       AND point.is_verified
       AND point.dedupe_state = 'normal'
       AND point.kind = (CASE delivery.consent_channel
         WHEN 'email' THEN 'email' WHEN 'sms' THEN 'phone'
         WHEN 'whatsapp' THEN 'whatsapp' ELSE 'social' END)
      JOIN app.communication_consent_events AS consent
        ON consent.workspace_id = delivery.workspace_id
       AND consent.id = delivery.consent_event_id
       AND consent.contact_id = delivery.contact_id
       AND consent.contact_point_id = delivery.contact_point_id
       AND consent.channel = delivery.consent_channel
       AND consent.purpose = delivery.purpose
       AND consent.endpoint_identity_sha256 = delivery.endpoint_identity_sha256
       AND consent.state = 'granted'
      WHERE delivery.workspace_id = p_workspace_id
        AND delivery.provider_operation_id = p_operation_id
        AND delivery.status = 'queued'
        AND delivery.endpoint_identity_sha256 = public.digest(
          point.kind || pg_catalog.chr(31)
            || point.value || pg_catalog.chr(31) || point.normalized_value,
          'sha256'
        )
        AND consent.id = (
          SELECT latest.id
          FROM app.communication_consent_events AS latest
          WHERE latest.workspace_id = delivery.workspace_id
            AND latest.contact_point_id = delivery.contact_point_id
            AND latest.channel = delivery.consent_channel
            AND latest.purpose = delivery.purpose
            AND latest.endpoint_identity_sha256 = delivery.endpoint_identity_sha256
            AND latest.occurred_at <= statement_timestamp() + interval '5 minutes'
          ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC
          LIMIT 1
        )
        AND NOT EXISTS (
          SELECT 1
          FROM (
            SELECT DISTINCT ON (coalesce(suppression.purpose, ''))
              suppression.state
            FROM app.communication_suppression_events AS suppression
            WHERE suppression.workspace_id = delivery.workspace_id
              AND suppression.contact_point_id = delivery.contact_point_id
              AND suppression.channel = delivery.consent_channel
              AND (suppression.purpose IS NULL
                OR suppression.purpose = delivery.purpose)
              AND suppression.endpoint_identity_sha256 = delivery.endpoint_identity_sha256
              AND suppression.occurred_at <= statement_timestamp() + interval '5 minutes'
            ORDER BY coalesce(suppression.purpose, ''),
              suppression.occurred_at DESC, suppression.recorded_at DESC,
              suppression.id DESC
          ) AS current_suppression
          WHERE current_suppression.state = 'suppressed'
        )
    ) INTO dispatch_consent_allowed;
    IF NOT coalesce(dispatch_consent_allowed, false) THEN
      RAISE EXCEPTION 'provider operation consent changed before call'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE app.provider_operations AS operation
     SET state = 'calling', row_version = operation.row_version + 1,
         updated_at = statement_timestamp()
   WHERE operation.workspace_id = p_workspace_id
     AND operation.id = p_operation_id
     AND operation.state = 'leased'
     AND operation.lease_token_hash = p_lease_token_hash
     AND operation.lease_version = p_lease_version
     AND operation.lease_expires_at > statement_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider operation lease was lost' USING ERRCODE = '40001';
  END IF;

  UPDATE app.provider_operation_attempts AS attempt
     SET state = 'calling'
   WHERE attempt.workspace_id = p_workspace_id
     AND attempt.provider_operation_id = p_operation_id
     AND attempt.worker_id = p_worker_id
     AND attempt.lease_version = p_lease_version
     AND attempt.state = 'leased';

  IF selected_attempt_kind = 'dispatch' THEN
    UPDATE app.message_deliveries AS delivery
       SET status = 'sending', updated_at = statement_timestamp()
     WHERE delivery.workspace_id = p_workspace_id
       AND delivery.provider_operation_id = p_operation_id
       AND delivery.status = 'queued';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'provider delivery was not queueable' USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN true;
END;
$function$;

CREATE FUNCTION app_private.renew_provider_operation_lease(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint,
  p_lease_seconds integer DEFAULT 60
)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  renewed_until timestamptz;
BEGIN
  IF p_workspace_id IS NULL OR p_operation_id IS NULL OR p_worker_id IS NULL
     OR p_lease_token_hash IS NULL OR octet_length(p_lease_token_hash) <> 32
     OR p_lease_version IS NULL OR p_lease_version < 1
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'invalid provider operation lease renewal input'
      USING ERRCODE = '22023';
  END IF;

  UPDATE app.provider_operations AS operation
     SET lease_expires_at = statement_timestamp()
           + pg_catalog.make_interval(secs => p_lease_seconds),
         row_version = operation.row_version + 1,
         updated_at = statement_timestamp()
   WHERE operation.workspace_id = p_workspace_id
     AND operation.id = p_operation_id
     AND operation.state IN ('leased', 'calling')
     AND operation.lease_token_hash = p_lease_token_hash
     AND operation.lease_version = p_lease_version
     AND operation.lease_expires_at > statement_timestamp()
     AND EXISTS (
       SELECT 1 FROM app.provider_operation_attempts AS attempt
       WHERE attempt.workspace_id = operation.workspace_id
         AND attempt.provider_operation_id = operation.id
         AND attempt.worker_id = p_worker_id
         AND attempt.lease_version = p_lease_version
         AND attempt.state IN ('leased', 'calling')
     )
  RETURNING operation.lease_expires_at INTO renewed_until;
  IF renewed_until IS NULL THEN
    RAISE EXCEPTION 'provider operation lease was lost' USING ERRCODE = '40001';
  END IF;
  RETURN renewed_until;
END;
$function$;

CREATE FUNCTION app_private.cancel_provider_operation_before_call(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint,
  p_error_code text,
  p_safe_summary text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  normalized_error text := pg_catalog.lower(pg_catalog.btrim(p_error_code));
  normalized_summary text := pg_catalog.btrim(p_safe_summary);
BEGIN
  IF p_workspace_id IS NULL OR p_operation_id IS NULL OR p_worker_id IS NULL
     OR p_lease_token_hash IS NULL OR octet_length(p_lease_token_hash) <> 32
     OR p_lease_version IS NULL OR p_lease_version < 1
     OR p_error_code IS NULL OR normalized_error <> p_error_code
     OR normalized_error !~ '^[a-z][a-z0-9_.:-]{0,99}$'
     OR p_safe_summary IS NULL OR normalized_summary <> p_safe_summary
     OR length(normalized_summary) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid provider operation cancellation input'
      USING ERRCODE = '22023';
  END IF;

  UPDATE app.provider_operation_attempts AS attempt
     SET state = 'failed', retryable = false, error_code = normalized_error,
         safe_summary = normalized_summary, completed_at = statement_timestamp()
   WHERE attempt.workspace_id = p_workspace_id
     AND attempt.provider_operation_id = p_operation_id
     AND attempt.worker_id = p_worker_id
     AND attempt.lease_version = p_lease_version
     AND attempt.state = 'leased'
     AND EXISTS (
       SELECT 1 FROM app.provider_operations AS operation
       WHERE operation.workspace_id = attempt.workspace_id
         AND operation.id = attempt.provider_operation_id
         AND operation.state = 'leased'
         AND operation.lease_token_hash = p_lease_token_hash
         AND operation.lease_version = p_lease_version
         AND operation.lease_expires_at > statement_timestamp()
     );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider operation lease was lost' USING ERRCODE = '40001';
  END IF;

  UPDATE app.message_deliveries AS delivery
     SET status = 'cancelled', updated_at = statement_timestamp()
   WHERE delivery.workspace_id = p_workspace_id
     AND delivery.provider_operation_id = p_operation_id
     AND delivery.status IN ('queued', 'reconciliation_required');

  UPDATE app.provider_operations AS operation
     SET state = 'cancelled', lease_token_hash = NULL,
         lease_expires_at = NULL, completed_at = statement_timestamp(),
         last_error_code = normalized_error, last_summary = normalized_summary,
         row_version = operation.row_version + 1,
         updated_at = statement_timestamp()
   WHERE operation.workspace_id = p_workspace_id
     AND operation.id = p_operation_id
     AND operation.state = 'leased'
     AND operation.lease_token_hash = p_lease_token_hash
     AND operation.lease_version = p_lease_version;
  RETURN FOUND;
END;
$function$;

CREATE FUNCTION app_private.settle_provider_operation(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint,
  p_outcome text,
  p_provider_reference text,
  p_retryable boolean,
  p_error_code text,
  p_safe_summary text,
  p_provider_occurred_at timestamptz
)
RETURNS TABLE (operation_state text, delivery_status text, completed_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  selected_call record;
  selected_delivery app.message_deliveries%ROWTYPE;
  target_operation_state text;
  target_delivery_status text;
  target_completed_at timestamptz;
  normalized_reference text := pg_catalog.btrim(p_provider_reference);
  normalized_error text := pg_catalog.lower(pg_catalog.btrim(p_error_code));
  normalized_summary text := pg_catalog.btrim(p_safe_summary);
BEGIN
  IF p_workspace_id IS NULL OR p_operation_id IS NULL OR p_worker_id IS NULL
     OR p_lease_token_hash IS NULL OR octet_length(p_lease_token_hash) <> 32
     OR p_lease_version IS NULL OR p_lease_version < 1
     OR p_outcome IS NULL
     OR p_outcome NOT IN ('accepted', 'pending', 'succeeded', 'failed', 'needs_attention')
     OR p_retryable IS NULL
     OR p_safe_summary IS NULL OR normalized_summary <> p_safe_summary
     OR length(normalized_summary) NOT BETWEEN 1 AND 500
     OR p_provider_occurred_at IS NULL
     OR p_provider_occurred_at > statement_timestamp() + interval '5 minutes'
     OR (p_provider_reference IS NOT NULL AND (
       normalized_reference <> p_provider_reference
       OR length(normalized_reference) NOT BETWEEN 1 AND 500
     ))
     OR (p_outcome IN ('accepted', 'succeeded') AND p_provider_reference IS NULL)
     OR (p_outcome = 'failed' AND (
       p_error_code IS NULL OR normalized_error <> p_error_code
       OR normalized_error !~ '^[a-z][a-z0-9_.:-]{0,99}$'
     ))
     OR (p_error_code IS NOT NULL AND (
       normalized_error <> p_error_code
       OR normalized_error !~ '^[a-z][a-z0-9_.:-]{0,99}$'
     )) THEN
    RAISE EXCEPTION 'invalid provider operation settlement input'
      USING ERRCODE = '22023';
  END IF;

  SELECT operation.*, attempt.attempt_kind
    INTO selected_call
  FROM app.provider_operations AS operation
  JOIN app.provider_operation_attempts AS attempt
    ON attempt.workspace_id = operation.workspace_id
   AND attempt.provider_operation_id = operation.id
   AND attempt.lease_version = operation.lease_version
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = operation.workspace_id
   AND connection.id = operation.provider_connection_id
   AND connection.environment = operation.environment
  WHERE operation.workspace_id = p_workspace_id
    AND operation.id = p_operation_id
    AND operation.state = 'calling'
    AND operation.lease_token_hash = p_lease_token_hash
    AND operation.lease_version = p_lease_version
    AND operation.lease_expires_at > statement_timestamp()
    AND attempt.worker_id = p_worker_id
    AND attempt.state = 'calling'
    AND connection.provider_id = 'test_conversation'
    AND connection.environment = 'test'
  FOR UPDATE OF operation, attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider operation calling lease was lost' USING ERRCODE = '40001';
  END IF;

  SELECT delivery.* INTO selected_delivery
  FROM app.message_deliveries AS delivery
  WHERE delivery.workspace_id = p_workspace_id
    AND delivery.provider_operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider delivery was not found' USING ERRCODE = '55000';
  END IF;

  IF p_provider_occurred_at < selected_call.created_at - interval '5 minutes' THEN
    RAISE EXCEPTION 'provider occurrence predates the operation' USING ERRCODE = '22023';
  END IF;

  IF p_outcome = 'accepted' THEN
    target_operation_state := 'accepted';
    target_delivery_status := 'accepted';
    target_completed_at := statement_timestamp();
  ELSIF p_outcome = 'succeeded' THEN
    target_operation_state := 'succeeded';
    target_delivery_status := 'accepted';
    target_completed_at := statement_timestamp();
  ELSIF p_outcome IN ('pending', 'needs_attention') THEN
    IF selected_call.attempt_count >= selected_call.max_attempts THEN
      target_operation_state := 'dead_letter';
      target_delivery_status := 'failed';
      target_completed_at := statement_timestamp();
      normalized_error := coalesce(normalized_error, 'reconciliation_limit_exhausted');
    ELSE
      target_operation_state := 'reconciliation_required';
      target_delivery_status := 'reconciliation_required';
      target_completed_at := NULL;
    END IF;
  ELSIF p_retryable AND selected_call.attempt_count < selected_call.max_attempts THEN
    IF selected_call.attempt_kind = 'reconcile' THEN
      target_operation_state := 'reconciliation_required';
      target_delivery_status := 'reconciliation_required';
    ELSE
      target_operation_state := 'retry_wait';
      target_delivery_status := 'queued';
    END IF;
    target_completed_at := NULL;
  ELSE
    target_operation_state := CASE
      WHEN p_retryable THEN 'dead_letter' ELSE 'failed' END;
    target_delivery_status := 'failed';
    target_completed_at := statement_timestamp();
  END IF;

  UPDATE app.provider_operation_attempts AS attempt
     SET state = CASE p_outcome
           WHEN 'accepted' THEN 'accepted'
           WHEN 'pending' THEN 'pending'
           WHEN 'succeeded' THEN 'succeeded'
           WHEN 'failed' THEN 'failed'
           ELSE 'needs_attention'
         END,
         retryable = p_retryable, error_code = normalized_error,
         safe_summary = normalized_summary,
         provider_occurred_at = p_provider_occurred_at,
         completed_at = statement_timestamp()
   WHERE attempt.workspace_id = p_workspace_id
     AND attempt.provider_operation_id = p_operation_id
     AND attempt.worker_id = p_worker_id
     AND attempt.lease_version = p_lease_version
     AND attempt.state = 'calling';

  UPDATE app.message_deliveries AS delivery
     SET status = target_delivery_status,
         accepted_at = CASE WHEN target_delivery_status = 'accepted'
           THEN coalesce(delivery.accepted_at, p_provider_occurred_at)
           ELSE delivery.accepted_at END,
         failed_at = CASE WHEN target_delivery_status = 'failed'
           THEN coalesce(delivery.failed_at, statement_timestamp())
           ELSE NULL END,
         updated_at = statement_timestamp()
   WHERE delivery.workspace_id = p_workspace_id
     AND delivery.provider_operation_id = p_operation_id;

  UPDATE app.provider_operations AS operation
     SET state = target_operation_state,
         provider_reference = coalesce(normalized_reference, operation.provider_reference),
         last_error_code = normalized_error,
         last_summary = normalized_summary,
         next_attempt_at = CASE
           WHEN target_operation_state IN ('retry_wait', 'reconciliation_required')
             THEN statement_timestamp()
               + pg_catalog.make_interval(secs => least(300, 10 * operation.attempt_count))
           ELSE operation.next_attempt_at
         END,
         lease_token_hash = NULL, lease_expires_at = NULL,
         completed_at = target_completed_at,
         row_version = operation.row_version + 1,
         updated_at = statement_timestamp()
   WHERE operation.workspace_id = p_workspace_id
     AND operation.id = p_operation_id;

  IF target_operation_state IN ('accepted', 'succeeded') THEN
    INSERT INTO app.activities (
      id, workspace_id, contact_id, activity_type, channel, actor_kind,
      subject, metadata, request_id, correlation_id, causation_id, occurred_at
    ) VALUES (
      public.gen_random_uuid(), p_workspace_id, selected_delivery.contact_id,
      'conversation.message.sent',
      CASE selected_delivery.conversation_channel
        WHEN 'instagram' THEN 'social' WHEN 'facebook' THEN 'social'
        ELSE selected_delivery.conversation_channel END,
      'worker', 'Approved test message accepted by provider',
      pg_catalog.jsonb_build_object(
        'operationId', p_operation_id,
        'deliveryId', selected_delivery.id,
        'messageId', selected_delivery.message_id,
        'providerId', 'test_conversation',
        'environment', 'test',
        'status', target_operation_state
      ),
      'provider-operation:' || p_operation_id::text,
      selected_call.correlation_id::text, p_operation_id::text,
      statement_timestamp()
    );

    INSERT INTO app.outbox_events (
      id, workspace_id, aggregate_type, aggregate_id, event_type,
      event_version, idempotency_key, payload, request_id,
      correlation_id, causation_id
    ) VALUES (
      public.gen_random_uuid(), p_workspace_id, 'message',
      selected_delivery.message_id, 'conversation.message.sent', 1,
      'provider-operation:' || p_operation_id::text || ':' || target_operation_state,
      pg_catalog.jsonb_build_object(
        'operationId', p_operation_id,
        'deliveryId', selected_delivery.id,
        'messageId', selected_delivery.message_id,
        'conversationId', selected_delivery.conversation_id,
        'providerId', 'test_conversation',
        'environment', 'test',
        'status', target_operation_state
      ),
      'provider-operation:' || p_operation_id::text,
      selected_call.correlation_id::text, p_operation_id::text
    );
  END IF;

  RETURN QUERY SELECT target_operation_state, target_delivery_status,
                      target_completed_at;
END;
$function$;

CREATE FUNCTION app_private.record_test_provider_delivery_receipt(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_delivery_id uuid,
  p_external_event_id text,
  p_payload_sha256 bytea,
  p_delivery_status text,
  p_error_code text,
  p_occurred_at timestamptz
)
RETURNS TABLE (receipt_id uuid, effective_status text, replayed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  existing app.provider_operation_receipts%ROWTYPE;
  inserted_id uuid;
  selected_status text;
  normalized_event_id text := pg_catalog.btrim(p_external_event_id);
  normalized_error text := pg_catalog.lower(pg_catalog.btrim(p_error_code));
BEGIN
  IF p_workspace_id IS NULL OR p_operation_id IS NULL OR p_delivery_id IS NULL
     OR p_workspace_id IS DISTINCT FROM app_private.current_workspace_id()
     OR app_private.current_actor_kind() <> 'user'
     OR app_private.current_user_id() IS NULL
     OR NOT app_private.can_manage_workspace(
       app_private.current_user_id(), p_workspace_id
     )
     OR p_external_event_id IS NULL OR normalized_event_id <> p_external_event_id
     OR length(normalized_event_id) NOT BETWEEN 1 AND 500
     OR p_payload_sha256 IS NULL OR octet_length(p_payload_sha256) <> 32
     OR p_delivery_status IS NULL
     OR p_delivery_status NOT IN ('accepted', 'delivered', 'read', 'failed')
     OR p_occurred_at IS NULL
     OR p_occurred_at > statement_timestamp() + interval '5 minutes'
     OR (p_error_code IS NOT NULL AND (
       normalized_error <> p_error_code
       OR normalized_error !~ '^[a-z][a-z0-9_.:-]{0,99}$'
     )) THEN
    RAISE EXCEPTION 'invalid test provider receipt input' USING ERRCODE = '22023';
  END IF;

  PERFORM operation.id
    FROM app.provider_operations AS operation
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = operation.workspace_id
     AND connection.id = operation.provider_connection_id
     AND connection.environment = operation.environment
    JOIN app.message_deliveries AS delivery
      ON delivery.workspace_id = operation.workspace_id
     AND delivery.provider_operation_id = operation.id
    WHERE operation.workspace_id = p_workspace_id
      AND operation.id = p_operation_id
      AND delivery.id = p_delivery_id
      AND connection.provider_id = 'test_conversation'
      AND connection.environment = 'test'
      AND operation.provider_reference IS NOT NULL
      AND p_occurred_at >= operation.created_at - interval '5 minutes'
    FOR UPDATE OF operation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'test provider receipt target is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT receipt.* INTO existing
  FROM app.provider_operation_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.provider_operation_id = p_operation_id
    AND receipt.external_event_id = normalized_event_id;
  IF FOUND THEN
    IF existing.message_delivery_id IS DISTINCT FROM p_delivery_id
       OR existing.payload_sha256 IS DISTINCT FROM p_payload_sha256
       OR existing.delivery_status IS DISTINCT FROM p_delivery_status
       OR existing.error_code IS DISTINCT FROM normalized_error
       OR existing.occurred_at IS DISTINCT FROM p_occurred_at THEN
      RAISE EXCEPTION 'test provider receipt replay conflict' USING ERRCODE = '23505';
    END IF;
    SELECT delivery.status INTO selected_status
    FROM app.message_deliveries AS delivery
    WHERE delivery.workspace_id = p_workspace_id AND delivery.id = p_delivery_id;
    RETURN QUERY SELECT existing.id, selected_status, true;
    RETURN;
  END IF;

  INSERT INTO app.provider_operation_receipts AS inserted_receipt (
    id, workspace_id, provider_operation_id, message_delivery_id,
    source_kind, external_event_id, payload_sha256, delivery_status,
    error_code, actor_kind, actor_user_id, occurred_at
  ) VALUES (
    public.gen_random_uuid(), p_workspace_id, p_operation_id, p_delivery_id,
    'test_provider', normalized_event_id, p_payload_sha256, p_delivery_status,
    normalized_error, 'user', app_private.current_user_id(), p_occurred_at
  ) RETURNING inserted_receipt.id INTO inserted_id;

  UPDATE app.message_deliveries AS delivery
     SET status = CASE
           WHEN delivery.status = 'read' THEN 'read'
           WHEN p_delivery_status = 'read' THEN 'read'
           WHEN delivery.status = 'delivered' THEN 'delivered'
           WHEN p_delivery_status = 'delivered' THEN 'delivered'
           WHEN delivery.status = 'failed' THEN 'failed'
           WHEN p_delivery_status = 'failed' THEN 'failed'
           WHEN delivery.status = 'accepted' THEN 'accepted'
           ELSE 'accepted'
         END,
         accepted_at = CASE
           WHEN p_delivery_status IN ('accepted', 'delivered', 'read')
             THEN coalesce(delivery.accepted_at, p_occurred_at)
           ELSE delivery.accepted_at END,
         delivered_at = CASE
           WHEN p_delivery_status IN ('delivered', 'read')
             THEN coalesce(delivery.delivered_at, p_occurred_at)
           ELSE delivery.delivered_at END,
         read_at = CASE WHEN p_delivery_status = 'read'
           THEN coalesce(delivery.read_at, p_occurred_at)
           ELSE delivery.read_at END,
         failed_at = CASE
           WHEN delivery.status NOT IN ('delivered', 'read')
             AND p_delivery_status NOT IN ('delivered', 'read')
             AND (delivery.status = 'failed' OR p_delivery_status = 'failed')
             THEN coalesce(delivery.failed_at, p_occurred_at)
           ELSE NULL END,
         updated_at = statement_timestamp()
   WHERE delivery.workspace_id = p_workspace_id AND delivery.id = p_delivery_id
  RETURNING delivery.status INTO selected_status;

  RETURN QUERY SELECT inserted_id, selected_status, false;
END;
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_provider_operation_definer;

REVOKE ALL ON FUNCTION app_private.claim_provider_operations(
  uuid, bytea, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.load_test_provider_dispatch_payload(
  uuid, uuid, uuid, uuid, bytea, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.mark_provider_operation_calling(
  uuid, uuid, uuid, bytea, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.renew_provider_operation_lease(
  uuid, uuid, uuid, bytea, bigint, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.cancel_provider_operation_before_call(
  uuid, uuid, uuid, bytea, bigint, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.settle_provider_operation(
  uuid, uuid, uuid, bytea, bigint, text, text, boolean, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_test_provider_delivery_receipt(
  uuid, uuid, uuid, text, bytea, text, text, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.claim_provider_operations(
  uuid, bytea, integer, integer
) TO r72_worker;
GRANT EXECUTE ON FUNCTION app_private.load_test_provider_dispatch_payload(
  uuid, uuid, uuid, uuid, bytea, bigint
) TO r72_worker;
GRANT EXECUTE ON FUNCTION app_private.mark_provider_operation_calling(
  uuid, uuid, uuid, bytea, bigint
) TO r72_worker;
GRANT EXECUTE ON FUNCTION app_private.renew_provider_operation_lease(
  uuid, uuid, uuid, bytea, bigint, integer
) TO r72_worker;
GRANT EXECUTE ON FUNCTION app_private.cancel_provider_operation_before_call(
  uuid, uuid, uuid, bytea, bigint, text, text
) TO r72_worker;
GRANT EXECUTE ON FUNCTION app_private.settle_provider_operation(
  uuid, uuid, uuid, bytea, bigint, text, text, boolean, text, text, timestamptz
) TO r72_worker;
GRANT EXECUTE ON FUNCTION app_private.record_test_provider_delivery_receipt(
  uuid, uuid, uuid, text, bytea, text, text, timestamptz
) TO r72_crm_command;

DO $provider_operation_capability_check$
BEGIN
  IF pg_catalog.has_table_privilege('r72_worker', 'app.provider_operations', 'UPDATE')
     OR pg_catalog.has_table_privilege('r72_worker', 'app.provider_operation_attempts', 'INSERT')
     OR pg_catalog.has_table_privilege('r72_worker', 'app.message_deliveries', 'UPDATE')
     OR pg_catalog.has_table_privilege('r72_crm_command', 'app.provider_operation_receipts', 'INSERT')
     OR pg_catalog.has_table_privilege('r72_provider_operation_definer', 'app.messages', 'SELECT') THEN
    RAISE EXCEPTION 'unsafe provider-operation dispatch capability';
  END IF;
END;
$provider_operation_capability_check$;
