-- Restore the Conversion Inbox for r72_web after a live founder walkthrough
-- showed /portal/inbox failing closed as "Conversion Inbox temporarily
-- unavailable", including its empty state.
--
-- Cause. The Inbox list, thread, transcript, consent and rail-activity queries
-- reference live evidence tables directly:
--
--   app.property_predator_customer_email_jobs
--   app.property_predator_whatsapp_live_inbox_projections
--   app.property_predator_sms_inbox_projections
--   app.property_predator_sms_jobs
--
-- r72_web holds no SELECT on any of them, and that is deliberate: 0055 and 0056
-- kept live rail evidence behind r72_operational_inbox_definer. PostgreSQL
-- resolves privileges on every relation named by a statement when it plans that
-- statement, not when a row is produced. The whole Inbox query is therefore
-- rejected with 42501 even in a workspace that has no live conversation at all,
-- which is why the empty state failed exactly like a populated one.
--
-- Fix. Three bounded SECURITY DEFINER read functions owned by
-- r72_operational_inbox_definer and granted to r72_web alone. They answer only
-- the questions the Inbox asks: may this live conversation be listed, what
-- signed inbound receipt does this message descend from, and is this delivery
-- genuinely linked to a live provider operation. They return identifiers, a
-- provider family, a network and timestamps. No body, subject, recipient
-- digest, sender digest, provider payload, signature or credential crosses the
-- boundary, and r72_web gains no new table privilege.
--
-- This migration reads no customer data, sends nothing and changes no row.

SET LOCAL ROLE r72_owner;

-- Column-scoped so the definer can answer the Inbox questions and nothing else.
-- Bodies, digests, payloads and provider references are all withheld; the audit
-- below fails the migration if any of them become readable.
GRANT SELECT (workspace_id, id, conversation_id, environment)
  ON app.message_deliveries TO r72_operational_inbox_definer;
GRANT SELECT (workspace_id, id, conversation_id, inbound_message_id, received_at)
  ON app.property_predator_mailgun_inbound_receipts TO r72_operational_inbox_definer;
GRANT SELECT (workspace_id, message_delivery_id)
  ON app.property_predator_customer_email_jobs TO r72_operational_inbox_definer;
GRANT SELECT (workspace_id, id, receipt_id, conversation_id, inbound_message_id, recorded_at)
  ON app.property_predator_whatsapp_live_inbox_projections TO r72_operational_inbox_definer;
GRANT SELECT (workspace_id, id, receipt_id, conversation_id, inbound_message_id, recorded_at)
  ON app.property_predator_sms_inbox_projections TO r72_operational_inbox_definer;
GRANT SELECT (workspace_id, message_delivery_id, operation_id)
  ON app.property_predator_sms_jobs TO r72_operational_inbox_definer;

DO $definer_column_audit$
DECLARE
  forbidden record;
BEGIN
  FOR forbidden IN
    SELECT candidate.table_name, candidate.column_name
    FROM (
      VALUES
        ('property_predator_mailgun_inbound_receipts', 'body_sha256'),
        ('property_predator_mailgun_inbound_receipts', 'payload_sha256'),
        ('property_predator_mailgun_inbound_receipts', 'signature_sha256'),
        ('property_predator_mailgun_inbound_receipts', 'sender_identity_sha256'),
        ('property_predator_whatsapp_live_inbox_projections', 'body_sha256'),
        ('property_predator_whatsapp_live_inbox_projections', 'sender_identity_sha256'),
        ('property_predator_sms_inbox_projections', 'body_sha256'),
        ('property_predator_sms_inbox_projections', 'sender_identity_sha256'),
        ('property_predator_sms_inbox_projections', 'opt_evidence'),
        ('property_predator_sms_jobs', 'recipient_sha256'),
        ('property_predator_sms_jobs', 'request_sha256'),
        ('property_predator_sms_jobs', 'idempotency_key_sha256')
    ) AS candidate(table_name, column_name)
    WHERE EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'app'
        AND relation.relname = candidate.table_name
        AND attribute.attname = candidate.column_name
        AND NOT attribute.attisdropped
    )
    AND pg_catalog.has_column_privilege(
      'r72_operational_inbox_definer',
      format('app.%I', candidate.table_name),
      candidate.column_name,
      'SELECT'
    )
  LOOP
    RAISE EXCEPTION
      'Operational inbox definer must not read app.%.% ',
      forbidden.table_name, forbidden.column_name
      USING ERRCODE = '42501';
  END LOOP;
END
$definer_column_audit$;

GRANT CREATE ON SCHEMA app_private TO r72_operational_inbox_definer;
SET LOCAL ROLE r72_operational_inbox_definer;

-- One shared gate so all three functions demand exactly the same context and a
-- reviewer can prove they cannot drift apart.
CREATE FUNCTION app_private.operational_inbox_live_read_allowed(
  p_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT p_workspace_id IS NOT NULL
    AND p_workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
    AND app_private.current_user_id() IS NOT NULL
    AND app_private.has_active_workspace_membership(
      app_private.current_user_id(), p_workspace_id
    )
$function$;

-- Live conversation visibility. A live conversation is listable only when its
-- own rail holds exact evidence for it; a forged or cross-workspace id simply
-- returns false rather than raising, so the Inbox degrades to "not visible"
-- instead of failing the whole page.
CREATE FUNCTION app_private.operational_inbox_live_conversation_visible(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_channel text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT p_conversation_id IS NOT NULL
    AND app_private.operational_inbox_live_read_allowed(p_workspace_id)
    AND CASE p_channel
      WHEN 'email' THEN (
        EXISTS (
          SELECT 1
          FROM app.property_predator_mailgun_inbound_receipts AS owned_reply
          WHERE owned_reply.workspace_id = p_workspace_id
            AND owned_reply.conversation_id = p_conversation_id
        )
        OR EXISTS (
          SELECT 1
          FROM app.message_deliveries AS live_delivery
          JOIN app.property_predator_customer_email_jobs AS live_email
            ON live_email.workspace_id = live_delivery.workspace_id
           AND live_email.message_delivery_id = live_delivery.id
          WHERE live_delivery.workspace_id = p_workspace_id
            AND live_delivery.conversation_id = p_conversation_id
            AND live_delivery.environment = 'live'
        )
      )
      WHEN 'whatsapp' THEN EXISTS (
        SELECT 1
        FROM app.property_predator_whatsapp_live_inbox_projections AS live_whatsapp
        WHERE live_whatsapp.workspace_id = p_workspace_id
          AND live_whatsapp.conversation_id = p_conversation_id
      )
      WHEN 'sms' THEN (
        EXISTS (
          SELECT 1
          FROM app.property_predator_sms_inbox_projections AS live_sms
          WHERE live_sms.workspace_id = p_workspace_id
            AND live_sms.conversation_id = p_conversation_id
        )
        OR EXISTS (
          SELECT 1
          FROM app.message_deliveries AS live_delivery
          JOIN app.property_predator_sms_jobs AS live_sms_job
            ON live_sms_job.workspace_id = live_delivery.workspace_id
           AND live_sms_job.message_delivery_id = live_delivery.id
          WHERE live_delivery.workspace_id = p_workspace_id
            AND live_delivery.conversation_id = p_conversation_id
            AND live_delivery.environment = 'live'
        )
      )
      ELSE false
    END
$function$;

-- Live inbound provenance and receipt linkage, mirroring the shape the test
-- rail already exposes through app_private.test_inbox_webhook_message_provenance.
-- At most one row: each projection binds one inbound message id.
CREATE FUNCTION app_private.operational_inbox_live_message_provenance(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_message_id uuid
)
RETURNS TABLE (
  receipt_id uuid,
  provider_family text,
  network text,
  verified_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT provenance.receipt_id, provenance.provider_family,
         provenance.network, provenance.verified_at
  FROM (
    SELECT 1 AS rail_rank, owned_reply.id AS receipt_id,
           'mailgun_email'::text AS provider_family, 'email'::text AS network,
           owned_reply.received_at AS verified_at
    FROM app.property_predator_mailgun_inbound_receipts AS owned_reply
    WHERE app_private.operational_inbox_live_read_allowed(p_workspace_id)
      AND p_conversation_id IS NOT NULL
      AND p_message_id IS NOT NULL
      AND owned_reply.workspace_id = p_workspace_id
      AND owned_reply.conversation_id = p_conversation_id
      AND owned_reply.inbound_message_id = p_message_id
    UNION ALL
    SELECT 2, live_whatsapp.receipt_id, 'meta_whatsapp_live'::text,
           'whatsapp'::text, live_whatsapp.recorded_at
    FROM app.property_predator_whatsapp_live_inbox_projections AS live_whatsapp
    WHERE app_private.operational_inbox_live_read_allowed(p_workspace_id)
      AND p_conversation_id IS NOT NULL
      AND p_message_id IS NOT NULL
      AND live_whatsapp.workspace_id = p_workspace_id
      AND live_whatsapp.conversation_id = p_conversation_id
      AND live_whatsapp.inbound_message_id = p_message_id
    UNION ALL
    SELECT 3, live_sms.receipt_id, 'twilio_sms_live'::text, 'sms'::text,
           live_sms.recorded_at
    FROM app.property_predator_sms_inbox_projections AS live_sms
    WHERE app_private.operational_inbox_live_read_allowed(p_workspace_id)
      AND p_conversation_id IS NOT NULL
      AND p_message_id IS NOT NULL
      AND live_sms.workspace_id = p_workspace_id
      AND live_sms.conversation_id = p_conversation_id
      AND live_sms.inbound_message_id = p_message_id
  ) AS provenance
  -- One inbound message belongs to exactly one rail, so the ranked LIMIT is
  -- defensive rather than load-bearing: it guarantees the transcript row this
  -- feeds can never fan out into duplicates even if that invariant were broken.
  ORDER BY provenance.rail_rank
  LIMIT 1
$function$;

-- Live delivery and provider-operation linkage for the rail-activity strip.
-- SMS additionally pins the exact provider operation, so a delivery cannot
-- borrow another operation's activity.
CREATE FUNCTION app_private.operational_inbox_live_delivery_linked(
  p_workspace_id uuid,
  p_message_delivery_id uuid,
  p_provider_operation_id uuid,
  p_channel text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT p_message_delivery_id IS NOT NULL
    AND app_private.operational_inbox_live_read_allowed(p_workspace_id)
    AND CASE p_channel
      WHEN 'email' THEN EXISTS (
        SELECT 1
        FROM app.property_predator_customer_email_jobs AS live_email
        WHERE live_email.workspace_id = p_workspace_id
          AND live_email.message_delivery_id = p_message_delivery_id
      )
      WHEN 'sms' THEN EXISTS (
        SELECT 1
        FROM app.property_predator_sms_jobs AS live_sms
        WHERE live_sms.workspace_id = p_workspace_id
          AND live_sms.message_delivery_id = p_message_delivery_id
          AND live_sms.operation_id = p_provider_operation_id
      )
      ELSE false
    END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE CREATE ON SCHEMA app_private FROM r72_operational_inbox_definer;

REVOKE ALL ON FUNCTION app_private.operational_inbox_live_read_allowed(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.operational_inbox_live_conversation_visible(
  uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.operational_inbox_live_message_provenance(
  uuid, uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.operational_inbox_live_delivery_linked(
  uuid, uuid, uuid, text
) FROM PUBLIC;

-- r72_web receives the three Inbox questions and nothing else. The shared gate
-- stays unreachable from the web role: it is an internal detail of the three.
GRANT EXECUTE ON FUNCTION app_private.operational_inbox_live_conversation_visible(
  uuid, uuid, text
) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.operational_inbox_live_message_provenance(
  uuid, uuid, uuid
) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.operational_inbox_live_delivery_linked(
  uuid, uuid, uuid, text
) TO r72_web;

-- r72_web must remain table-blind on the four live evidence tables that caused
-- the outage. app.property_predator_mailgun_inbound_receipts is deliberately
-- excluded: 0050 granted it to r72_web and Lead 360 still reads it directly, so
-- revoking that grant belongs to a separate, wider change than this repair.
DO $web_table_blindness_audit$
DECLARE
  leaked text;
BEGIN
  FOR leaked IN
    SELECT candidate.table_name
    FROM (
      VALUES
        ('property_predator_customer_email_jobs'),
        ('property_predator_whatsapp_live_inbox_projections'),
        ('property_predator_sms_inbox_projections'),
        ('property_predator_sms_jobs')
    ) AS candidate(table_name)
    WHERE pg_catalog.has_table_privilege(
      'r72_web', format('app.%I', candidate.table_name),
      'SELECT, INSERT, UPDATE, DELETE'
    )
  LOOP
    RAISE EXCEPTION
      'r72_web must stay table-blind on app.% after the inbox read boundary',
      leaked
      USING ERRCODE = '42501';
  END LOOP;
END
$web_table_blindness_audit$;

-- The repair is pointless if r72_web cannot call what replaced the direct reads.
DO $web_execute_audit$
DECLARE
  required text;
BEGIN
  FOR required IN
    SELECT candidate.signature
    FROM (
      VALUES
        ('app_private.operational_inbox_live_conversation_visible(uuid, uuid, text)'),
        ('app_private.operational_inbox_live_message_provenance(uuid, uuid, uuid)'),
        ('app_private.operational_inbox_live_delivery_linked(uuid, uuid, uuid, text)')
    ) AS candidate(signature)
    WHERE NOT pg_catalog.has_function_privilege('r72_web', candidate.signature, 'EXECUTE')
  LOOP
    RAISE EXCEPTION 'r72_web must execute %', required USING ERRCODE = '42501';
  END LOOP;
  IF pg_catalog.has_function_privilege(
       'r72_web', 'app_private.operational_inbox_live_read_allowed(uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'The shared inbox gate must not be callable by r72_web'
      USING ERRCODE = '42501';
  END IF;
END
$web_execute_audit$;
