-- Preserve provider-reported occurrence time in the immutable pilot reservation,
-- while fencing operational lifecycle timestamps against the database-authored
-- creation time. This prevents harmless distributed-clock skew from violating
-- monotonic chronology constraints after an otherwise valid provider call.

SET LOCAL ROLE r72_owner;

-- The function remains owned by the table-capable, non-login definer role.
-- Schema CREATE is restored only for the duration of this exact replacement.
GRANT CREATE ON SCHEMA app_private TO r72_mailgun_worker_definer;
SET LOCAL ROLE r72_mailgun_worker_definer;

CREATE OR REPLACE FUNCTION app_private.settle_property_predator_email_pilot_call(
  p_workspace_id uuid, p_reservation_id uuid, p_request_sha256 bytea,
  p_status text, p_external_id text, p_occurred_at timestamptz,
  p_retryable boolean, p_error_code text, p_summary text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.property_predator_email_pilot_reservations%ROWTYPE;
  changed_rows integer;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR p_status NOT IN ('accepted', 'pending', 'succeeded', 'failed', 'needs_attention')
     OR p_occurred_at IS NULL OR p_retryable IS NULL
     OR p_summary IS NULL OR p_summary <> btrim(p_summary)
     OR length(p_summary) NOT BETWEEN 1 AND 500
     OR (p_external_id IS NOT NULL AND (
       p_external_id <> btrim(p_external_id) OR length(p_external_id) NOT BETWEEN 1 AND 500
     ))
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_.:-]{0,99}$')
     OR (p_status IN ('accepted', 'succeeded') AND p_external_id IS NULL) THEN
    RAISE EXCEPTION 'Mailgun settlement input denied' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_workspace_id::text || ':property-predator-email-pilot', 0)
  );
  SELECT reservation.* INTO selected
  FROM app.property_predator_email_pilot_reservations AS reservation
  WHERE reservation.workspace_id = p_workspace_id
    AND reservation.id = p_reservation_id
    AND reservation.request_sha256 = p_request_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'Mailgun reservation lost' USING ERRCODE = '40001'; END IF;
  IF selected.state <> 'calling' THEN
    IF selected.state = p_status
       AND selected.provider_external_id IS NOT DISTINCT FROM p_external_id
       AND selected.provider_occurred_at IS NOT DISTINCT FROM p_occurred_at
       AND selected.provider_retryable IS NOT DISTINCT FROM p_retryable
       AND selected.provider_error_code IS NOT DISTINCT FROM p_error_code
       AND selected.provider_summary IS NOT DISTINCT FROM p_summary THEN
      RETURN true;
    END IF;
    RAISE EXCEPTION 'Mailgun reservation settlement conflict' USING ERRCODE = '40001';
  END IF;
  UPDATE app.property_predator_email_pilot_reservations
  SET state = p_status, provider_external_id = p_external_id,
      provider_occurred_at = p_occurred_at, provider_retryable = p_retryable,
      provider_error_code = p_error_code, provider_summary = p_summary,
      settled_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_reservation_id;
  UPDATE app.provider_operations AS operation
  SET state = CASE p_status
        WHEN 'accepted' THEN 'accepted'
        WHEN 'succeeded' THEN 'succeeded'
        WHEN 'failed' THEN 'failed'
        ELSE 'reconciliation_required'
      END,
      provider_reference = p_external_id,
      lease_token_hash = NULL, lease_expires_at = NULL,
      last_error_code = p_error_code, last_summary = p_summary,
      completed_at = CASE
        WHEN p_status IN ('accepted', 'succeeded', 'failed')
          THEN GREATEST(p_occurred_at, operation.created_at)
        ELSE NULL
      END,
      row_version = operation.row_version + 1,
      updated_at = statement_timestamp()
  WHERE operation.workspace_id = p_workspace_id
    AND operation.id = selected.operation_id
    AND operation.message_delivery_id = selected.message_delivery_id
    AND operation.state = 'calling';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Mailgun operation settlement fence was lost' USING ERRCODE = '40001';
  END IF;
  UPDATE app.message_deliveries AS delivery
  SET status = CASE
        WHEN p_status IN ('accepted', 'succeeded') THEN 'accepted'
        WHEN p_status = 'failed' THEN 'failed'
        ELSE 'reconciliation_required'
      END,
      accepted_at = CASE
        WHEN p_status IN ('accepted', 'succeeded')
          THEN GREATEST(p_occurred_at, delivery.queued_at)
        ELSE NULL
      END,
      failed_at = CASE
        WHEN p_status = 'failed'
          THEN GREATEST(p_occurred_at, delivery.queued_at)
        ELSE NULL
      END,
      updated_at = statement_timestamp()
  WHERE delivery.workspace_id = p_workspace_id
    AND delivery.id = selected.message_delivery_id
    AND delivery.provider_operation_id = selected.operation_id
    AND delivery.status = 'sending';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Mailgun delivery settlement fence was lost' USING ERRCODE = '40001';
  END IF;
  -- Every attempted call remains reserved. In particular needs_attention is an
  -- ambiguous outcome and can never be silently retried or refunded.
  RETURN true;
END
$function$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON FUNCTION app_private.settle_property_predator_email_pilot_call(
  uuid, uuid, bytea, text, text, timestamptz, boolean, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.settle_property_predator_email_pilot_call(
  uuid, uuid, bytea, text, text, timestamptz, boolean, text, text
) TO r72_mailgun_worker_command;
REVOKE CREATE ON SCHEMA app_private FROM r72_mailgun_worker_definer;
