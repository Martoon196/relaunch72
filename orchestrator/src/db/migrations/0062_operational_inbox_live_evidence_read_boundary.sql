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
-- r72_web holds no SELECT on three of them. 0055 did expose the WhatsApp
-- projection directly; this migration retires that legacy exception as the
-- same bounded boundary takes over all three live rails. PostgreSQL
-- resolves privileges on every relation named by a statement when it plans that
-- statement, not when a row is produced. The whole Inbox query is therefore
-- rejected with 42501 even in a workspace that has no live conversation at all,
-- which is why the empty state failed exactly like a populated one.
--
-- Fix. Three bounded SECURITY DEFINER read functions owned by a dedicated
-- r72_operational_inbox_reader_definer and granted to r72_web alone. They answer only
-- the questions the Inbox asks: may this live conversation be listed, what
-- signed inbound receipt does this message descend from, and is this delivery
-- genuinely linked to a live provider operation. They return identifiers, a
-- provider family, a network and timestamps. No body, subject, recipient
-- digest, sender digest, provider payload, signature or credential crosses the
-- boundary, and r72_web gains no new table privilege.
--
-- This migration reads no customer data, sends nothing and changes no row.

DO $roles$
DECLARE unsafe_parent text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_operational_inbox_reader_definer'
  ) THEN
    CREATE ROLE r72_operational_inbox_reader_definer NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_operational_inbox_reader_definer'
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe operational inbox reader definer role attributes';
  END IF;
  REVOKE r72_owner, r72_security_definer, r72_operational_inbox_definer
    FROM r72_operational_inbox_reader_definer;
  REVOKE r72_operational_inbox_reader_definer
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
      r72_crm_command, r72_operational_inbox_definer;
  SELECT parent.rolname INTO unsafe_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_operational_inbox_reader_definer'
  LIMIT 1;
  IF unsafe_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe operational inbox reader definer parent: %', unsafe_parent;
  END IF;
  GRANT r72_operational_inbox_reader_definer TO r72_owner;
END
$roles$;

SET LOCAL ROLE r72_owner;

-- 0056 composed the signed SMS inbound projector and exact INSERT policy but
-- did not extend the two older 0055 origin-domain checks. That made every real
-- Twilio inbound projection fail before it could reach the unified Inbox.
ALTER TABLE app.property_predator_admin_call_task_origins
  DROP CONSTRAINT property_predator_admin_call_task_origins_source_channel_check;
ALTER TABLE app.property_predator_admin_call_task_origins
  ADD CONSTRAINT property_predator_admin_call_task_origins_source_channel_check
  CHECK (source_channel IN (
    'email', 'sms', 'whatsapp', 'instagram', 'facebook'
  ));
ALTER TABLE app.property_predator_admin_call_task_origins
  DROP CONSTRAINT property_predator_admin_call_task_origins_source_provider_check;
ALTER TABLE app.property_predator_admin_call_task_origins
  ADD CONSTRAINT property_predator_admin_call_task_origins_source_provider_check
  CHECK (source_provider IN (
    'operator', 'mailgun_eu', 'twilio_messaging', 'meta_whatsapp_cloud'
  ));

-- Retire the one legacy direct live-evidence grant. The Inbox read paths in
-- this release no longer reference this table, and the bounded function below
-- replaces it before the migration commits.
REVOKE SELECT ON app.property_predator_whatsapp_live_inbox_projections
  FROM r72_web;
DROP POLICY property_predator_whatsapp_live_inbox_projections_web_select
  ON app.property_predator_whatsapp_live_inbox_projections;

-- This reader is deliberately separate from r72_operational_inbox_definer.
-- The older command role legitimately holds broader Mailgun receipt access for
-- its append-only admin-call workflow; conflating it with this bounded reader
-- made the original 0062 privilege audit impossible to satisfy.
REVOKE ALL ON SCHEMA app, app_private
  FROM r72_operational_inbox_reader_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_operational_inbox_reader_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_operational_inbox_reader_definer;
REVOKE CREATE ON SCHEMA public FROM r72_operational_inbox_reader_definer;
-- Functions in app_private have several deliberately isolated owners, so
-- r72_owner cannot bulk-REVOKE their ACLs. The role is new in this migration;
-- fail if an unexpected pre-existing installation gave it any direct function
-- privilege instead of attempting an owner-invalid bulk revoke.
DO $reader_function_hygiene$
DECLARE unexpected_function text;
BEGIN
  SELECT procedure.oid::regprocedure::text INTO unexpected_function
  FROM pg_catalog.pg_proc AS procedure
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) AS privilege
  WHERE privilege.grantee = (
    SELECT oid FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_operational_inbox_reader_definer'
  )
  LIMIT 1;
  IF unexpected_function IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected operational inbox reader function privilege: %',
      unexpected_function USING ERRCODE = '42501';
  END IF;
END
$reader_function_hygiene$;
GRANT USAGE ON SCHEMA app, app_private
  TO r72_operational_inbox_reader_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_actor_kind(),
  app_private.has_active_workspace_membership(uuid, uuid)
  TO r72_operational_inbox_reader_definer;

-- Column-scoped so the definer can answer the Inbox questions and nothing else.
-- Bodies, digests, payloads and provider references are all withheld; the audit
-- below fails the migration if any of them become readable.
GRANT SELECT (workspace_id, id, conversation_id, environment)
  ON app.message_deliveries TO r72_operational_inbox_reader_definer;
GRANT SELECT (workspace_id, id, conversation_id, inbound_message_id, received_at)
  ON app.property_predator_mailgun_inbound_receipts TO r72_operational_inbox_reader_definer;
GRANT SELECT (workspace_id, message_delivery_id)
  ON app.property_predator_customer_email_jobs TO r72_operational_inbox_reader_definer;
GRANT SELECT (workspace_id, id, receipt_id, conversation_id, inbound_message_id, recorded_at)
  ON app.property_predator_whatsapp_live_inbox_projections TO r72_operational_inbox_reader_definer;
GRANT SELECT (workspace_id, id, receipt_id, conversation_id, inbound_message_id, recorded_at)
  ON app.property_predator_sms_inbox_projections TO r72_operational_inbox_reader_definer;
GRANT SELECT (workspace_id, message_delivery_id, operation_id)
  ON app.property_predator_sms_jobs TO r72_operational_inbox_reader_definer;

-- FORCE RLS remains active. The reader can see only the authenticated user's
-- current workspace and only while the shared gate separately proves active
-- membership.
DO $reader_policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'message_deliveries',
    'property_predator_mailgun_inbound_receipts',
    'property_predator_customer_email_jobs',
    'property_predator_whatsapp_live_inbox_projections',
    'property_predator_sms_inbox_projections',
    'property_predator_sms_jobs'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_operational_inbox_reader_definer
       USING (
         workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
         AND current_setting(''app.actor_kind'', true) = ''user''
       )',
      'operational_inbox_reader_' || table_name || '_select', table_name
    );
  END LOOP;
END
$reader_policies$;

-- The candidate list is resolved against pg_attribute first, and the privilege
-- test uses the (attrelid, attnum) overload. The name-based overload evaluates
-- its column argument even when a guard clause would have excluded the row,
-- because PostgreSQL does not promise WHERE-clause evaluation order, so a stale
-- candidate raised 42703 and failed the whole apply. The attnum form cannot.
-- A stale candidate now fails loudly below instead of silently auditing nothing.
DO $definer_column_audit$
DECLARE
  candidates constant text[][] := ARRAY[
    ['property_predator_mailgun_inbound_receipts', 'body_sha256'],
    ['property_predator_mailgun_inbound_receipts', 'payload_sha256'],
    ['property_predator_mailgun_inbound_receipts', 'signature_token_sha256'],
    ['property_predator_mailgun_inbound_receipts', 'sender_identity_sha256'],
    ['property_predator_whatsapp_live_inbox_projections', 'body_sha256'],
    ['property_predator_whatsapp_live_inbox_projections', 'sender_identity_sha256'],
    ['property_predator_sms_inbox_projections', 'body_sha256'],
    ['property_predator_sms_inbox_projections', 'sender_identity_sha256'],
    ['property_predator_sms_inbox_projections', 'opt_evidence'],
    ['property_predator_sms_jobs', 'recipient_sha256'],
    ['property_predator_sms_jobs', 'request_sha256'],
    ['property_predator_sms_jobs', 'idempotency_key_sha256']
  ];
  candidate_table text;
  candidate_column text;
  resolved_relation oid;
  resolved_attnum smallint;
  index integer;
BEGIN
  FOR index IN 1 .. array_length(candidates, 1) LOOP
    candidate_table := candidates[index][1];
    candidate_column := candidates[index][2];
    SELECT attribute.attrelid, attribute.attnum
      INTO resolved_relation, resolved_attnum
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'app'
      AND relation.relname = candidate_table
      AND attribute.attname = candidate_column
      AND NOT attribute.attisdropped;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Operational inbox column audit must name a real column: app.%.%',
        candidate_table, candidate_column
        USING ERRCODE = '42703';
    END IF;
    IF pg_catalog.has_column_privilege(
         'r72_operational_inbox_reader_definer', resolved_relation, resolved_attnum, 'SELECT'
       ) THEN
      RAISE EXCEPTION
        'Operational inbox definer must not read app.%.%',
        candidate_table, candidate_column
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
END
$definer_column_audit$;

GRANT CREATE ON SCHEMA app_private TO r72_operational_inbox_reader_definer;
SET LOCAL ROLE r72_operational_inbox_reader_definer;

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

REVOKE CREATE ON SCHEMA app_private FROM r72_operational_inbox_reader_definer;

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

-- r72_web must remain table-blind on the four live evidence tables involved in
-- the outage. app.property_predator_mailgun_inbound_receipts is deliberately
-- excluded: 0050 granted it to r72_web and Lead 360 still reads it directly, so
-- revoking that grant belongs to a separate, wider change than this repair.
-- Resolved through to_regclass for the same reason as the column audit: a stale
-- table name must fail with a message that names it, not an opaque 42P01 from
-- inside a privilege test.
DO $web_table_blindness_audit$
DECLARE
  candidates constant text[] := ARRAY[
    'property_predator_customer_email_jobs',
    'property_predator_whatsapp_live_inbox_projections',
    'property_predator_sms_inbox_projections',
    'property_predator_sms_jobs'
  ];
  candidate_table text;
  resolved_relation oid;
BEGIN
  FOREACH candidate_table IN ARRAY candidates LOOP
    resolved_relation := pg_catalog.to_regclass(format('app.%I', candidate_table));
    IF resolved_relation IS NULL THEN
      RAISE EXCEPTION
        'Operational inbox blindness audit must name a real table: app.%',
        candidate_table
        USING ERRCODE = '42P01';
    END IF;
    IF pg_catalog.has_table_privilege(
         'r72_web', resolved_relation, 'SELECT, INSERT, UPDATE, DELETE'
       ) THEN
      RAISE EXCEPTION
        'r72_web must stay table-blind on app.% after the inbox read boundary',
        candidate_table
        USING ERRCODE = '42501';
    END IF;
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
