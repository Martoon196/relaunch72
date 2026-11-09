-- Repair the proven founder reply ingress mismatch.
--
-- Production Mailgun accepted the exact signed Reply-To address and matched the
-- reviewed route, but Growth HQ returned 406 because the original owned-seed
-- recorder required office@propertypredator.com as the inbound sender. The live
-- founder pilot deliberately resolves its verified contact point dynamically,
-- so the reply sender must be bound to the exact settled delivery contact point
-- instead of a historical mailbox constant.

SET LOCAL ROLE r72_owner;

GRANT CREATE ON SCHEMA app_private TO r72_mailgun_webhook_definer;
SET LOCAL ROLE r72_mailgun_webhook_definer;

CREATE OR REPLACE FUNCTION app_private.record_property_predator_owned_seed_mailgun_inbound(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_correlation_sha256 text,
  p_provider_message_id text,
  p_normalized_sender text,
  p_normalized_recipient text,
  p_subject text,
  p_body_text text,
  p_occurred_at timestamptz,
  p_payload_sha256 bytea,
  p_event_identity_sha256 bytea,
  p_signature_token_sha256 bytea,
  p_signature_timestamp timestamptz,
  p_sender_identity_sha256 bytea,
  p_recipient_identity_sha256 bytea,
  p_subject_sha256 bytea,
  p_body_sha256 bytea
)
RETURNS TABLE (
  replayed boolean,
  conversation_id uuid,
  message_id uuid,
  message_version_id uuid,
  admin_call_task_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid := app_private.current_workspace_id();
  trusted_request_id text := app_private.current_request_id();
  correlation_digest bytea;
  expected_recipient text;
  selected_job app.property_predator_mailgun_jobs%ROWTYPE;
  selected_delivery app.message_deliveries%ROWTYPE;
  selected_conversation app.conversations%ROWTYPE;
  selected_point app.contact_points%ROWTYPE;
  existing_receipt app.property_predator_mailgun_inbound_receipts%ROWTYPE;
  conflicting_receipt_id uuid;
  created_receipt_id uuid := gen_random_uuid();
  created_message_id uuid := gen_random_uuid();
  created_version_id uuid := gen_random_uuid();
  created_task_id uuid := gen_random_uuid();
BEGIN
  IF trusted_workspace_id IS NULL
     OR trusted_workspace_id IS DISTINCT FROM p_workspace_id
     OR app_private.current_actor_kind() <> 'webhook'
     OR trusted_request_id IS NULL
     OR trusted_request_id <> btrim(trusted_request_id)
     OR length(trusted_request_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'owned-seed inbound webhook context denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_provider_connection_id IS NULL
     OR p_correlation_sha256 IS NULL
     OR p_correlation_sha256 !~ '^[0-9a-f]{64}$'
     OR p_provider_message_id IS NULL
     OR p_provider_message_id <> btrim(p_provider_message_id)
     OR length(p_provider_message_id) NOT BETWEEN 3 AND 498
     OR p_provider_message_id !~ '@'
     OR p_provider_message_id ~ '[^[:graph:]]'
     OR p_provider_message_id ~ '[<>]'
     OR p_normalized_sender IS NULL
     OR p_normalized_sender <> lower(btrim(p_normalized_sender))
     OR length(p_normalized_sender) NOT BETWEEN 3 AND 320
     OR p_normalized_sender !~ '^[^[:space:]@]+@[^[:space:]@]+$'
     OR p_normalized_sender ~ '[[:cntrl:]]'
     OR p_normalized_recipient IS NULL
     OR p_subject IS NULL OR p_subject <> btrim(p_subject)
     OR octet_length(p_subject) NOT BETWEEN 1 AND 500
     OR p_subject ~ '[\r\n]'
     OR p_body_text IS NULL OR p_body_text <> btrim(p_body_text)
     OR octet_length(p_body_text) NOT BETWEEN 1 AND 65536
     OR p_occurred_at IS NULL
     OR p_occurred_at < statement_timestamp() - interval '10 minutes'
     OR p_occurred_at > statement_timestamp() + interval '5 minutes'
     OR p_signature_timestamp IS DISTINCT FROM p_occurred_at
     OR octet_length(p_payload_sha256) <> 32
     OR octet_length(p_event_identity_sha256) <> 32
     OR octet_length(p_signature_token_sha256) <> 32
     OR octet_length(p_sender_identity_sha256) <> 32
     OR octet_length(p_recipient_identity_sha256) <> 32
     OR octet_length(p_subject_sha256) <> 32
     OR octet_length(p_body_sha256) <> 32 THEN
    RAISE EXCEPTION 'owned-seed inbound reply evidence is invalid'
      USING ERRCODE = '22023';
  END IF;

  correlation_digest := decode(p_correlation_sha256, 'hex');
  expected_recipient := 'reply+'
    || app_private.property_predator_mailgun_reply_token(correlation_digest)
    || '@mg.propertypredator.com';
  IF p_normalized_recipient <> expected_recipient
     OR p_sender_identity_sha256 <> public.digest(p_normalized_sender, 'sha256')
     OR p_recipient_identity_sha256 <> public.digest(p_normalized_recipient, 'sha256')
     OR p_subject_sha256 <> public.digest(p_subject, 'sha256')
     OR p_event_identity_sha256 <> public.digest(
       p_correlation_sha256 || pg_catalog.chr(31)
       || p_provider_message_id || pg_catalog.chr(31)
       || encode(p_sender_identity_sha256, 'hex') || pg_catalog.chr(31)
       || encode(p_recipient_identity_sha256, 'hex') || pg_catalog.chr(31)
       || encode(p_subject_sha256, 'hex') || pg_catalog.chr(31)
       || encode(p_body_sha256, 'hex'), 'sha256'
     )
     OR p_body_sha256 <> public.digest(p_body_text, 'sha256') THEN
    RAISE EXCEPTION 'owned-seed inbound reply evidence is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'property-predator-mailgun-inbound:' || p_workspace_id::text || ':'
      || p_provider_connection_id::text || ':' || p_provider_message_id,
      7200050
    )
  );

  SELECT receipt.* INTO existing_receipt
  FROM app.property_predator_mailgun_inbound_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.provider_connection_id = p_provider_connection_id
    AND receipt.provider_message_id = p_provider_message_id;
  IF FOUND THEN
    IF existing_receipt.correlation_sha256 IS DISTINCT FROM correlation_digest
       OR existing_receipt.event_identity_sha256 IS DISTINCT FROM p_event_identity_sha256
       OR existing_receipt.sender_identity_sha256 IS DISTINCT FROM p_sender_identity_sha256
       OR existing_receipt.recipient_identity_sha256 IS DISTINCT FROM p_recipient_identity_sha256
       OR existing_receipt.subject_sha256 IS DISTINCT FROM p_subject_sha256
       OR existing_receipt.body_sha256 IS DISTINCT FROM p_body_sha256 THEN
      RAISE EXCEPTION 'owned-seed inbound reply evidence conflicts'
        USING ERRCODE = '22000';
    END IF;
    RETURN QUERY SELECT true, existing_receipt.conversation_id,
      existing_receipt.inbound_message_id,
      existing_receipt.inbound_message_version_id,
      existing_receipt.admin_call_task_id;
    RETURN;
  END IF;

  SELECT receipt.id INTO conflicting_receipt_id
  FROM app.property_predator_mailgun_inbound_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.provider_connection_id = p_provider_connection_id
    AND receipt.signature_token_sha256 = p_signature_token_sha256;
  IF FOUND THEN
    RAISE EXCEPTION 'owned-seed inbound reply evidence conflicts'
      USING ERRCODE = '22000';
  END IF;

  BEGIN
    SELECT job.* INTO STRICT selected_job
    FROM app.property_predator_mailgun_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.provider_connection_id = p_provider_connection_id
      AND job.request_sha256 = correlation_digest
      AND job.state = 'settled'
      AND job.message_delivery_id IS NOT NULL
      AND job.expected_message_id = '<pp-' || p_correlation_sha256
        || '@mg.propertypredator.com>';
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RAISE EXCEPTION 'owned-seed inbound reply is unmatched'
        USING ERRCODE = '23503';
    WHEN TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'owned-seed inbound reply evidence conflicts'
        USING ERRCODE = '22000';
  END;

  IF NOT EXISTS (
    SELECT 1 FROM app.provider_connections AS connection
    WHERE connection.workspace_id = p_workspace_id
      AND connection.id = p_provider_connection_id
      AND connection.provider_id = 'mailgun_eu'
      AND connection.provider_kind = 'email'
      AND connection.environment = 'live'
      AND connection.status = 'active'
  ) THEN
    RAISE EXCEPTION 'owned-seed inbound reply is unmatched'
      USING ERRCODE = '23503';
  END IF;

  SELECT delivery.* INTO selected_delivery
  FROM app.message_deliveries AS delivery
  WHERE delivery.workspace_id = p_workspace_id
    AND delivery.id = selected_job.message_delivery_id
    AND delivery.provider_connection_id = p_provider_connection_id
    AND delivery.environment = 'live'
    AND delivery.conversation_channel = 'email'
    AND delivery.status IN ('accepted', 'delivered', 'read');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owned-seed inbound reply is unmatched'
      USING ERRCODE = '23503';
  END IF;

  SELECT conversation.* INTO selected_conversation
  FROM app.conversations AS conversation
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = selected_delivery.conversation_id
    AND conversation.contact_id = selected_delivery.contact_id
    AND conversation.channel = 'email'
    AND conversation.environment = 'live'
    AND conversation.state IN ('open', 'snoozed')
  FOR UPDATE;
  SELECT point.* INTO selected_point
  FROM app.contact_points AS point
  WHERE point.workspace_id = p_workspace_id
    AND point.id = selected_delivery.contact_point_id
    AND point.contact_id = selected_delivery.contact_id
    AND point.kind = 'email'
    AND lower(point.normalized_value) = p_normalized_sender
    AND point.deleted_at IS NULL;
  IF selected_conversation.id IS NULL OR selected_point.id IS NULL THEN
    RAISE EXCEPTION 'owned-seed inbound reply is unmatched'
      USING ERRCODE = '23503';
  END IF;

  -- The SECURITY DEFINER search_path is intentionally pg_catalog-only, so a
  -- bare application constraint name is not resolvable here. Every deferrable
  -- constraint in this narrow transaction is already designed for this
  -- message/version insert ordering.
  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO app.messages (
    id, workspace_id, conversation_id, contact_id, contact_point_id,
    channel, environment, direction, lifecycle, source_kind,
    current_version_id, current_version_number, current_body_sha256,
    created_by_actor_kind, created_by_user_id, occurred_at
  ) VALUES (
    created_message_id, p_workspace_id, selected_conversation.id,
    selected_delivery.contact_id, selected_delivery.contact_point_id,
    'email', 'live', 'inbound', 'received', 'verified_webhook',
    created_version_id, 1, p_body_sha256,
    'webhook', NULL, p_occurred_at
  );
  INSERT INTO app.message_versions (
    id, workspace_id, conversation_id, message_id,
    channel, environment, version_number, body_format, body_text,
    created_by_actor_kind, created_by_user_id, created_request_id
  ) VALUES (
    created_version_id, p_workspace_id, selected_conversation.id,
    created_message_id, 'email', 'live', 1, 'plain_text', p_body_text,
    'webhook', NULL, trusted_request_id
  );

  UPDATE app.conversations AS conversation
  SET assigned_user_id = coalesce(
        conversation.assigned_user_id, selected_delivery.created_by_user_id
      ),
      unread_count = least(conversation.unread_count + 1, 1000000),
      last_message_at = greatest(
        coalesce(conversation.last_message_at, p_occurred_at), p_occurred_at
      ),
      row_version = conversation.row_version + 1,
      updated_at = statement_timestamp()
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = selected_conversation.id;

  INSERT INTO app.tasks (
    id, workspace_id, contact_id, title, description,
    assignee_user_id, priority, status, due_at
  ) VALUES (
    created_task_id, p_workspace_id, selected_delivery.contact_id,
    'Call founder after verified Growth HQ reply',
    'A signed Mailgun reply from the verified founder endpoint reached Conversion Inbox. Open Lead 360, reconcile the reply and record the call outcome.',
    selected_delivery.created_by_user_id, 'urgent', 'open',
    statement_timestamp() + interval '15 minutes'
  );

  INSERT INTO app.property_predator_mailgun_inbound_receipts (
    id, workspace_id, provider_connection_id, mailgun_job_id,
    outbound_message_delivery_id, conversation_id, contact_id,
    contact_point_id, inbound_message_id, inbound_message_version_id,
    inbound_version_number, admin_call_task_id, provider_message_id, correlation_sha256,
    payload_sha256, event_identity_sha256, signature_token_sha256,
    sender_identity_sha256, recipient_identity_sha256,
    subject_sha256, body_sha256,
    signature_timestamp, occurred_at, request_id
  ) VALUES (
    created_receipt_id, p_workspace_id, p_provider_connection_id,
    selected_job.id, selected_delivery.id, selected_conversation.id,
    selected_delivery.contact_id, selected_delivery.contact_point_id,
    created_message_id, created_version_id, 1, created_task_id,
    p_provider_message_id, correlation_digest, p_payload_sha256,
    p_event_identity_sha256, p_signature_token_sha256,
    p_sender_identity_sha256, p_recipient_identity_sha256,
    p_subject_sha256, p_body_sha256,
    p_signature_timestamp, p_occurred_at, trusted_request_id
  );

  INSERT INTO app.activities (
    workspace_id, contact_id, task_id, activity_type, channel,
    actor_kind, actor_user_id, subject, body, metadata,
    request_id, correlation_id, occurred_at
  ) VALUES (
    p_workspace_id, selected_delivery.contact_id, created_task_id,
    'inbox.email.reply_received', 'email', 'webhook', NULL,
    'Verified founder email reply received',
    'Conversion Inbox received a signed Mailgun reply from the verified founder endpoint and created an urgent admin call task.',
    pg_catalog.jsonb_build_object(
      'receiptId', created_receipt_id,
      'conversationId', selected_conversation.id,
      'messageId', created_message_id,
      'ownedSeed', true,
      'founderEndpoint', true
    ), trusted_request_id, created_receipt_id::text,
    least(p_occurred_at, statement_timestamp())
  );

  RETURN QUERY SELECT false, selected_conversation.id, created_message_id,
    created_version_id, created_task_id;
END;
$function$;
REVOKE ALL ON FUNCTION app_private.record_property_predator_owned_seed_mailgun_inbound(
  uuid, uuid, text, text, text, text, text, text, timestamptz,
  bytea, bytea, bytea, timestamptz, bytea, bytea, bytea, bytea
) FROM PUBLIC;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE CREATE ON SCHEMA app_private FROM r72_mailgun_webhook_definer;

DO $repair_audit$
DECLARE
  recorder_oid oid := pg_catalog.to_regprocedure(
    'app_private.record_property_predator_owned_seed_mailgun_inbound(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,bytea,bytea,bytea,timestamp with time zone,bytea,bytea,bytea,bytea)'
  );
  recorder_source text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(recorder_oid) INTO recorder_source;
  IF recorder_oid IS NULL
     OR recorder_source IS NULL
     OR pg_catalog.strpos(
       recorder_source,
       'lower(point.normalized_value) = p_normalized_sender'
     ) = 0
     OR pg_catalog.strpos(
       recorder_source,
       'p_normalized_sender <> ''office@propertypredator.com'''
     ) <> 0
     OR NOT pg_catalog.has_function_privilege(
       'r72_mailgun_webhook_command', recorder_oid, 'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure
       JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
       WHERE procedure.oid = recorder_oid
         AND owner_role.rolname = 'r72_mailgun_webhook_definer'
         AND procedure.prosecdef
         AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
     ) THEN
    RAISE EXCEPTION 'Founder reply sender binding repair is incomplete'
      USING ERRCODE = '42501';
  END IF;
END
$repair_audit$;

RESET ROLE;
