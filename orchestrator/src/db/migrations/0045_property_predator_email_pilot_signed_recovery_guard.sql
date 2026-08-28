-- Forward-only repair for the reservation guard introduced in 0025. Migration
-- 0043 added signed-webhook recovery from pending/needs_attention to a terminal
-- receipt state, but the older trigger still permitted only calling settlement.
-- Preserve every authorization/evidence field and admit only the exact receipt
-- projection performed by recover_one_property_predator_mailgun_job.

SET LOCAL ROLE r72_owner;

CREATE OR REPLACE FUNCTION app_private.guard_property_predator_email_pilot_reservation_update()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.message_delivery_id IS DISTINCT FROM OLD.message_delivery_id
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256
     OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.utc_month IS DISTINCT FROM OLD.utc_month
     OR NEW.stage IS DISTINCT FROM OLD.stage
     OR NEW.recipient_scope IS DISTINCT FROM OLD.recipient_scope
     OR NEW.message_version_id IS DISTINCT FROM OLD.message_version_id
     OR NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
     OR NEW.approval_decision_id IS DISTINCT FROM OLD.approval_decision_id
     OR NEW.approved_content_sha256 IS DISTINCT FROM OLD.approved_content_sha256
     OR NEW.control_event_id IS DISTINCT FROM OLD.control_event_id
     OR NEW.recipient_evidence IS DISTINCT FROM OLD.recipient_evidence
     OR NEW.requested_messages IS DISTINCT FROM OLD.requested_messages
     OR NEW.estimated_spend_usd_micros IS DISTINCT FROM OLD.estimated_spend_usd_micros
     OR NEW.runtime_provider_effects_enabled IS DISTINCT FROM OLD.runtime_provider_effects_enabled
     OR NEW.runtime_email_delivery_enabled IS DISTINCT FROM OLD.runtime_email_delivery_enabled
     OR NEW.runtime_emergency_paused IS DISTINCT FROM OLD.runtime_emergency_paused
     OR NEW.authorized_at IS DISTINCT FROM OLD.authorized_at THEN
    RAISE EXCEPTION 'Property Predator email pilot reservation evidence is immutable'
      USING ERRCODE = '40001';
  END IF;

  -- Preserve the original one-shot provider settlement and pre-call cancellation
  -- boundary. Table constraints continue to enforce the matching field shape.
  IF OLD.state = 'calling' THEN
    IF NEW.state = 'calling' THEN
      RAISE EXCEPTION 'Property Predator email pilot reservation evidence is immutable'
        USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
  END IF;

  -- A reservation already marked ambiguous may move only to the terminal state
  -- proven by the verified Mailgun receipt selected in 0043. No cancellation or
  -- authorization evidence can be rewritten during this projection.
  IF OLD.state IN ('pending', 'needs_attention')
     AND NEW.state IN ('accepted', 'succeeded', 'failed') THEN
    IF current_user IS DISTINCT FROM 'r72_mailgun_worker_definer'
       OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason
       OR NEW.provider_external_id IS NULL
       OR NEW.provider_occurred_at IS NULL
       OR NEW.provider_retryable IS DISTINCT FROM false
       OR NEW.provider_summary IS NULL
       OR NEW.settled_at IS NULL
       OR NEW.settled_at < OLD.settled_at
       OR (
         NEW.state IN ('accepted', 'succeeded')
         AND (
           NEW.provider_error_code IS NOT NULL
           OR NEW.provider_summary
             <> 'Signed Mailgun webhook reconciled the ambiguous call'
         )
       )
       OR (
         NEW.state = 'failed'
         AND (
           NEW.provider_error_code IS DISTINCT FROM 'mailgun.permanent'
           OR NEW.provider_summary
             <> 'Signed Mailgun webhook confirmed a permanent delivery failure'
         )
       ) THEN
      RAISE EXCEPTION 'Property Predator email pilot reservation evidence is immutable'
        USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Property Predator email pilot reservation evidence is immutable'
    USING ERRCODE = '40001';
END
$function$;

REVOKE ALL ON FUNCTION app_private.guard_property_predator_email_pilot_reservation_update()
  FROM PUBLIC;

RESET ROLE;
