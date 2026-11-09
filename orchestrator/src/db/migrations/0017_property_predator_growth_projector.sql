-- The Growth projector is a payload-derived capability, not a table-writing
-- identity. The shared webhook login may name one accepted event ID; this
-- function alone reads its private canonical payload and appends CRM evidence.

DO $roles$
DECLARE
  unexpected_member text;
  unexpected_parent text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_growth_projector_definer'
  ) THEN
    CREATE ROLE r72_growth_projector_definer NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_growth_projector_definer'
      AND NOT rolcanlogin
      AND NOT rolinherit
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe role attributes: r72_growth_projector_definer';
  END IF;

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer, r72_commerce_definer,
    r72_external_event_definer
    FROM r72_growth_projector_definer;
  REVOKE r72_growth_projector_definer
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
      r72_crm_command, r72_identity_command, r72_provisioning_command,
      r72_setup_delivery_command, r72_setup_reissue_command,
      r72_external_event_command, r72_external_event_definer;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_growth_projector_definer'
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Growth projector role membership: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_growth_projector_definer'
    AND member.rolname NOT IN ('r72_owner', current_user)
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Growth projector role grant: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  GRANT r72_growth_projector_definer TO r72_owner;
END
$roles$;

SET LOCAL ROLE r72_owner;

-- 0016 exposed direct evidence writes only as a temporary foundation. Remove
-- that surface before installing the single payload-derived entrypoint.
REVOKE ALL ON
  app.contact_source_identities,
  app.content_consumption_facts,
  app.offer_presentation_facts,
  app.offer_response_facts,
  app.contact_attribution_facts
FROM r72_webhook;
REVOKE ALL ON app_private.external_event_projection_receipts
FROM r72_webhook;

DROP POLICY IF EXISTS contact_source_identities_webhook_select
  ON app.contact_source_identities;
DROP POLICY IF EXISTS contact_source_identities_webhook_insert
  ON app.contact_source_identities;
DROP POLICY IF EXISTS content_consumption_facts_webhook_select
  ON app.content_consumption_facts;
DROP POLICY IF EXISTS content_consumption_facts_webhook_insert
  ON app.content_consumption_facts;
DROP POLICY IF EXISTS offer_presentation_facts_webhook_select
  ON app.offer_presentation_facts;
DROP POLICY IF EXISTS offer_presentation_facts_webhook_insert
  ON app.offer_presentation_facts;
DROP POLICY IF EXISTS offer_response_facts_webhook_select
  ON app.offer_response_facts;
DROP POLICY IF EXISTS offer_response_facts_webhook_insert
  ON app.offer_response_facts;
DROP POLICY IF EXISTS contact_attribution_facts_webhook_select
  ON app.contact_attribution_facts;
DROP POLICY IF EXISTS contact_attribution_facts_webhook_insert
  ON app.contact_attribution_facts;
DROP POLICY IF EXISTS external_event_projection_receipts_webhook_select
  ON app_private.external_event_projection_receipts;
DROP POLICY IF EXISTS external_event_projection_receipts_webhook_insert
  ON app_private.external_event_projection_receipts;

-- Start the non-login definer from an explicit empty capability set. Only the
-- tables required to resolve/create an identity and append exact evidence are
-- granted below; UPDATE and DELETE are never granted.
REVOKE ALL ON SCHEMA app, app_private FROM r72_growth_projector_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_growth_projector_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_growth_projector_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_growth_projector_definer;
REVOKE CREATE ON SCHEMA public FROM r72_growth_projector_definer;

GRANT USAGE ON SCHEMA app, app_private TO r72_growth_projector_definer;
GRANT SELECT ON app_private.external_event_shadow_receipts
  TO r72_growth_projector_definer;
GRANT SELECT, INSERT ON app_private.external_event_projection_receipts
  TO r72_growth_projector_definer;
GRANT SELECT, INSERT ON
  app.contacts,
  app.contact_points,
  app.contact_source_identities,
  app.content_consumption_facts,
  app.offer_presentation_facts,
  app.offer_response_facts,
  app.contact_attribution_facts
TO r72_growth_projector_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_actor_kind(), app_private.current_request_id()
TO r72_growth_projector_definer;

-- Forced RLS still applies to the definer. These policies constrain every
-- private table operation to the caller's webhook-scoped transaction context.
CREATE POLICY contacts_growth_projector_select ON app.contacts
  FOR SELECT TO r72_growth_projector_definer USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
  );
CREATE POLICY contacts_growth_projector_insert ON app.contacts
  FOR INSERT TO r72_growth_projector_definer WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND source = 'property_predator'
    AND owner_user_id IS NULL
    AND deleted_at IS NULL
  );
CREATE POLICY contact_points_growth_projector_select ON app.contact_points
  FOR SELECT TO r72_growth_projector_definer USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
  );
CREATE POLICY contact_points_growth_projector_insert ON app.contact_points
  FOR INSERT TO r72_growth_projector_definer WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND kind = 'email'
    AND is_primary
    AND NOT is_verified
    AND dedupe_state = 'normal'
    AND consent_status = 'unknown'
    AND deleted_at IS NULL
  );

DO $growth_projector_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'contact_source_identities',
    'content_consumption_facts',
    'offer_presentation_facts',
    'offer_response_facts',
    'contact_attribution_facts'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_growth_projector_definer
       USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.current_actor_kind() = ''webhook''
       )',
      table_name || '_growth_projector_select',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR INSERT TO r72_growth_projector_definer
       WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.current_actor_kind() = ''webhook''
         AND source_system = ''property_predator''
       )',
      table_name || '_growth_projector_insert',
      table_name
    );
  END LOOP;
END
$growth_projector_policies$;

CREATE POLICY external_event_projection_receipts_growth_projector_select
  ON app_private.external_event_projection_receipts
  FOR SELECT TO r72_growth_projector_definer USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
  );
CREATE POLICY external_event_projection_receipts_growth_projector_insert
  ON app_private.external_event_projection_receipts
  FOR INSERT TO r72_growth_projector_definer WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND source = 'property_predator'
    AND request_id = app_private.current_request_id()
  );

GRANT CREATE ON SCHEMA app_private TO r72_growth_projector_definer;
SET LOCAL ROLE r72_growth_projector_definer;

CREATE FUNCTION app_private.project_property_predator_growth_event(
  p_event_id uuid
)
RETURNS TABLE (
  disposition text,
  replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid := app_private.current_workspace_id();
  trusted_actor_kind text := app_private.current_actor_kind();
  trusted_request_id text := app_private.current_request_id();
  shadow_receipt app_private.external_event_shadow_receipts%ROWTYPE;
  event_data jsonb;
  projected_receipt_id uuid;
  inserted_receipt_count integer;
  projection_replayed boolean;
  source_identity_id uuid;
  resolved_contact_id uuid;
  existing_identity_contact_id uuid;
  email_contact_count integer;
  presentation_id uuid;
  canonical_email text;
  progress_basis_points_value integer;
  progress_seconds_value integer;
  price_minor_value bigint;
  expected_action text;
BEGIN
  IF trusted_actor_kind IS DISTINCT FROM 'webhook'
     OR trusted_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Growth projector context denied'
      USING ERRCODE = '42501';
  END IF;

  IF trusted_request_id IS NULL
     OR length(trusted_request_id) NOT BETWEEN 1 AND 128
     OR trusted_request_id ~ '[^[:graph:]]'
     OR p_event_id IS NULL THEN
    RAISE EXCEPTION 'invalid Growth projector request'
      USING ERRCODE = '22023';
  END IF;

  -- An advisory event fence serializes duplicate calls without granting the
  -- definer UPDATE on the immutable shadow receipt.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'property-predator-event:' || trusted_workspace_id::text || ':'
        || p_event_id::text,
      0
    )
  );

  SELECT receipt.*
    INTO shadow_receipt
  FROM app_private.external_event_shadow_receipts AS receipt
  WHERE receipt.workspace_id = trusted_workspace_id
    AND receipt.source = 'property_predator'
    AND receipt.event_id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'accepted Property Predator shadow receipt not found'
      USING ERRCODE = '23503';
  END IF;

  IF shadow_receipt.event_version IS DISTINCT FROM 1
     OR shadow_receipt.subject_kind IS DISTINCT FROM 'account'
     OR shadow_receipt.event_type NOT IN (
       'identity.account.created',
       'affiliate.referral.attributed',
       'content.consumption.progressed',
       'content.consumption.completed',
       'offer.presented',
       'offer.responded'
     )
     OR jsonb_typeof(shadow_receipt.event_payload->'data')
          IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'shadow receipt is not a supported Growth evidence event'
      USING ERRCODE = '22023';
  END IF;

  event_data := shadow_receipt.event_payload->'data';

  -- Validate the strict wire shape again at the database trust boundary. The
  -- shadow recorder proves provenance, while these branches prove semantics.
  IF shadow_receipt.event_type = 'identity.account.created' THEN
    IF NOT (event_data ?& ARRAY['email', 'signupMethod'])
       OR event_data - ARRAY['email', 'signupMethod', 'displayName']
            <> '{}'::jsonb
       OR jsonb_typeof(event_data->'email') IS DISTINCT FROM 'string'
       OR length(event_data->>'email') NOT BETWEEN 1 AND 320
       OR event_data->>'email' IS DISTINCT FROM lower(event_data->>'email')
       OR event_data->>'email' IS DISTINCT FROM btrim(event_data->>'email')
       OR event_data->>'email'
            !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       OR event_data->>'signupMethod' NOT IN ('password', 'google')
       OR (
         event_data ? 'displayName'
         AND (
           jsonb_typeof(event_data->'displayName') IS DISTINCT FROM 'string'
           OR length(event_data->>'displayName') NOT BETWEEN 1 AND 200
           OR event_data->>'displayName'
                IS DISTINCT FROM btrim(event_data->>'displayName')
           OR event_data->>'displayName' ~ '[[:cntrl:]]'
         )
       ) THEN
      RAISE EXCEPTION 'invalid identity.account.created projection payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'affiliate.referral.attributed' THEN
    IF NOT (event_data ?& ARRAY['affiliateId', 'referralCode', 'model'])
       OR event_data - ARRAY['affiliateId', 'referralCode', 'model']
            <> '{}'::jsonb
       OR jsonb_typeof(event_data->'affiliateId') IS DISTINCT FROM 'string'
       OR event_data->>'affiliateId'
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR jsonb_typeof(event_data->'referralCode') IS DISTINCT FROM 'string'
       OR event_data->>'referralCode'
            !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
       OR event_data->>'model' IS DISTINCT FROM 'last_click' THEN
      RAISE EXCEPTION 'invalid affiliate.referral.attributed projection payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type IN (
    'content.consumption.progressed', 'content.consumption.completed'
  ) THEN
    IF NOT (event_data ?& ARRAY[
         'contentKey', 'contentVersion', 'title', 'medium',
         'progressBasisPoints', 'consumedSeconds'
       ])
       OR event_data - ARRAY[
         'contentKey', 'contentVersion', 'title', 'medium',
         'progressBasisPoints', 'consumedSeconds'
       ] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'contentKey') IS DISTINCT FROM 'string'
       OR event_data->>'contentKey'
            !~ '^[a-z0-9][a-z0-9_.:-]{0,149}$'
       OR jsonb_typeof(event_data->'contentVersion') IS DISTINCT FROM 'string'
       OR length(event_data->>'contentVersion') NOT BETWEEN 1 AND 100
       OR event_data->>'contentVersion'
            IS DISTINCT FROM btrim(event_data->>'contentVersion')
       OR event_data->>'contentVersion' ~ '[[:cntrl:]]'
       OR jsonb_typeof(event_data->'title') IS DISTINCT FROM 'string'
       OR length(event_data->>'title') NOT BETWEEN 1 AND 200
       OR event_data->>'title' IS DISTINCT FROM btrim(event_data->>'title')
       OR event_data->>'title' ~ '[[:cntrl:]]'
       OR event_data->>'medium' NOT IN (
         'video', 'audio', 'article', 'document', 'other'
       )
       OR jsonb_typeof(event_data->'progressBasisPoints')
            IS DISTINCT FROM 'number'
       OR NOT (CASE
         WHEN event_data->>'progressBasisPoints' ~ '^(0|[1-9][0-9]{0,4})$'
         THEN (event_data->>'progressBasisPoints')::integer BETWEEN 0 AND 10000
         ELSE false
       END)
       OR jsonb_typeof(event_data->'consumedSeconds')
            IS DISTINCT FROM 'number'
       OR NOT (CASE
         WHEN event_data->>'consumedSeconds' ~ '^(0|[1-9][0-9]{0,9})$'
         THEN (event_data->>'consumedSeconds')::bigint BETWEEN 0 AND 2147483647
         ELSE false
       END)
       OR (
         shadow_receipt.event_type = 'content.consumption.completed'
         AND event_data->>'progressBasisPoints' IS DISTINCT FROM '10000'
       ) THEN
      RAISE EXCEPTION 'invalid content consumption projection payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'offer.presented' THEN
    IF NOT (event_data ?& ARRAY[
         'offerKey', 'offerVersion', 'productKey', 'label', 'price', 'placement'
       ])
       OR event_data - ARRAY[
         'offerKey', 'offerVersion', 'productKey', 'label', 'price', 'placement'
       ] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'offerKey') IS DISTINCT FROM 'string'
       OR event_data->>'offerKey' !~ '^[a-z0-9][a-z0-9_.:-]{0,149}$'
       OR jsonb_typeof(event_data->'offerVersion') IS DISTINCT FROM 'string'
       OR length(event_data->>'offerVersion') NOT BETWEEN 1 AND 100
       OR event_data->>'offerVersion'
            IS DISTINCT FROM btrim(event_data->>'offerVersion')
       OR event_data->>'offerVersion' ~ '[[:cntrl:]]'
       OR jsonb_typeof(event_data->'productKey') IS DISTINCT FROM 'string'
       OR event_data->>'productKey' !~ '^[a-z0-9][a-z0-9_.:-]{0,149}$'
       OR jsonb_typeof(event_data->'label') IS DISTINCT FROM 'string'
       OR length(event_data->>'label') NOT BETWEEN 1 AND 200
       OR event_data->>'label' IS DISTINCT FROM btrim(event_data->>'label')
       OR event_data->>'label' ~ '[[:cntrl:]]'
       OR jsonb_typeof(event_data->'placement') IS DISTINCT FROM 'string'
       OR event_data->>'placement' !~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'
       OR jsonb_typeof(event_data->'price') IS DISTINCT FROM 'object'
       OR NOT ((event_data->'price') ?& ARRAY['amountMinor', 'currency'])
       OR (event_data->'price') - ARRAY['amountMinor', 'currency']
            <> '{}'::jsonb
       OR jsonb_typeof(event_data->'price'->'amountMinor')
            IS DISTINCT FROM 'number'
       OR NOT (CASE
         WHEN event_data->'price'->>'amountMinor' ~ '^(0|[1-9][0-9]{0,15})$'
         THEN (event_data->'price'->>'amountMinor')::numeric
                BETWEEN 0 AND 9007199254740991
         ELSE false
       END)
       OR jsonb_typeof(event_data->'price'->'currency')
            IS DISTINCT FROM 'string'
       OR event_data->'price'->>'currency' !~ '^[a-z]{3}$' THEN
      RAISE EXCEPTION 'invalid offer.presented projection payload'
        USING ERRCODE = '22023';
    END IF;
  ELSIF shadow_receipt.event_type = 'offer.responded' THEN
    IF NOT (event_data ?& ARRAY['presentationEventId', 'response'])
       OR event_data - ARRAY['presentationEventId', 'response'] <> '{}'::jsonb
       OR jsonb_typeof(event_data->'presentationEventId')
            IS DISTINCT FROM 'string'
       OR event_data->>'presentationEventId'
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR event_data->>'response' NOT IN (
         'accepted', 'declined', 'deferred', 'requested_contact'
       ) THEN
      RAISE EXCEPTION 'invalid offer.responded projection payload'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO app_private.external_event_projection_receipts (
    workspace_id,
    source,
    event_id,
    event_type,
    subject_kind,
    subject_id,
    payload_sha256,
    request_id
  ) VALUES (
    trusted_workspace_id,
    shadow_receipt.source,
    shadow_receipt.event_id,
    shadow_receipt.event_type,
    shadow_receipt.subject_kind,
    shadow_receipt.subject_id,
    shadow_receipt.payload_sha256,
    trusted_request_id
  )
  ON CONFLICT (workspace_id, source, event_id) DO NOTHING
  RETURNING id INTO projected_receipt_id;

  GET DIAGNOSTICS inserted_receipt_count = ROW_COUNT;
  projection_replayed := inserted_receipt_count = 0;

  IF projection_replayed THEN
    SELECT receipt.id
      INTO projected_receipt_id
    FROM app_private.external_event_projection_receipts AS receipt
    WHERE receipt.workspace_id = trusted_workspace_id
      AND receipt.source = shadow_receipt.source
      AND receipt.event_id = shadow_receipt.event_id
      AND receipt.event_type = shadow_receipt.event_type
      AND receipt.subject_kind = shadow_receipt.subject_kind
      AND receipt.subject_id = shadow_receipt.subject_id
      AND receipt.payload_sha256 = shadow_receipt.payload_sha256;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'projection receipt conflicts with accepted shadow event'
        USING ERRCODE = '22000';
    END IF;
  END IF;

  IF shadow_receipt.event_type = 'identity.account.created' THEN
    canonical_email := event_data->>'email';

    -- Serialize both account ID and canonical email resolution. This prevents
    -- duplicate contacts when distinct deliveries race for the same identity.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'property-predator-account:' || trusted_workspace_id::text || ':'
          || shadow_receipt.subject_id::text,
        0
      )
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'property-predator-email:' || trusted_workspace_id::text || ':'
          || canonical_email,
        0
      )
    );

    SELECT identity.id, identity.contact_id
      INTO source_identity_id, resolved_contact_id
    FROM app.contact_source_identities AS identity
    WHERE identity.workspace_id = trusted_workspace_id
      AND identity.source_system = 'property_predator'
      AND identity.source_subject_kind = shadow_receipt.subject_kind
      AND identity.source_subject_id = shadow_receipt.subject_id;

    IF FOUND THEN
      IF NOT EXISTS (
        SELECT 1
        FROM app.contacts AS contact
        WHERE contact.workspace_id = trusted_workspace_id
          AND contact.id = resolved_contact_id
          AND contact.deleted_at IS NULL
          AND contact.lifecycle_status <> 'archived'
      ) THEN
        RAISE EXCEPTION 'Property Predator identity resolves to an inactive CRM contact'
          USING ERRCODE = '23503';
      END IF;

      RETURN QUERY SELECT 'projected'::text, projection_replayed;
      RETURN;
    END IF;

    SELECT pg_catalog.count(DISTINCT point.contact_id)::integer,
           pg_catalog.min(point.contact_id::text)::uuid
      INTO email_contact_count, resolved_contact_id
    FROM app.contact_points AS point
    WHERE point.workspace_id = trusted_workspace_id
      AND point.kind = 'email'
      AND point.normalized_value = canonical_email
      AND point.dedupe_state = 'normal'
      AND point.deleted_at IS NULL;

    IF email_contact_count > 1 THEN
      RAISE EXCEPTION 'Property Predator email matches multiple CRM contacts'
        USING ERRCODE = '23505';
    ELSIF email_contact_count = 1 THEN
      IF NOT EXISTS (
        SELECT 1
        FROM app.contacts AS contact
        WHERE contact.workspace_id = trusted_workspace_id
          AND contact.id = resolved_contact_id
          AND contact.deleted_at IS NULL
          AND contact.lifecycle_status <> 'archived'
      ) THEN
        RAISE EXCEPTION 'Property Predator email matches an inactive CRM contact'
          USING ERRCODE = '23503';
      END IF;
    ELSE
      INSERT INTO app.contacts (
        workspace_id,
        display_name,
        lifecycle_status,
        owner_user_id,
        source,
        custom_fields
      ) VALUES (
        trusted_workspace_id,
        CASE
          WHEN event_data ? 'displayName' THEN event_data->>'displayName'
          ELSE left(canonical_email, 200)
        END,
        'lead',
        NULL,
        'property_predator',
        '{}'::jsonb
      )
      RETURNING id INTO resolved_contact_id;

      INSERT INTO app.contact_points (
        workspace_id,
        contact_id,
        kind,
        label,
        value,
        normalized_value,
        is_primary,
        is_verified,
        dedupe_state,
        consent_status
      ) VALUES (
        trusted_workspace_id,
        resolved_contact_id,
        'email',
        'Property Predator account',
        canonical_email,
        canonical_email,
        true,
        false,
        'normal',
        'unknown'
      );
    END IF;

    INSERT INTO app.contact_source_identities (
      workspace_id,
      contact_id,
      source_system,
      source_subject_kind,
      source_subject_id,
      projection_receipt_id,
      source_event_id,
      source_event_type,
      source_payload_sha256,
      observed_at
    ) VALUES (
      trusted_workspace_id,
      resolved_contact_id,
      'property_predator',
      shadow_receipt.subject_kind,
      shadow_receipt.subject_id,
      projected_receipt_id,
      shadow_receipt.event_id,
      shadow_receipt.event_type,
      shadow_receipt.payload_sha256,
      shadow_receipt.occurred_at
    )
    ON CONFLICT (
      workspace_id, source_system, source_subject_kind, source_subject_id
    ) DO NOTHING
    RETURNING id, contact_id
      INTO source_identity_id, existing_identity_contact_id;

    IF NOT FOUND THEN
      SELECT identity.id, identity.contact_id
        INTO source_identity_id, existing_identity_contact_id
      FROM app.contact_source_identities AS identity
      WHERE identity.workspace_id = trusted_workspace_id
        AND identity.source_system = 'property_predator'
        AND identity.source_subject_kind = shadow_receipt.subject_kind
        AND identity.source_subject_id = shadow_receipt.subject_id;

      IF NOT FOUND
         OR existing_identity_contact_id IS DISTINCT FROM resolved_contact_id THEN
        RAISE EXCEPTION 'Property Predator source identity resolution conflict'
          USING ERRCODE = '23505';
      END IF;
    END IF;

    RETURN QUERY SELECT 'projected'::text, projection_replayed;
    RETURN;
  END IF;

  -- Every dependent fact requires the prior account identity in this exact
  -- workspace. An email match alone never authorizes dependent projection.
  SELECT identity.id, identity.contact_id
    INTO source_identity_id, resolved_contact_id
  FROM app.contact_source_identities AS identity
  JOIN app.contacts AS contact
    ON contact.workspace_id = identity.workspace_id
   AND contact.id = identity.contact_id
  WHERE identity.workspace_id = trusted_workspace_id
    AND identity.source_system = 'property_predator'
    AND identity.source_subject_kind = shadow_receipt.subject_kind
    AND identity.source_subject_id = shadow_receipt.subject_id
    AND contact.deleted_at IS NULL
    AND contact.lifecycle_status <> 'archived';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property Predator account identity is required before evidence'
      USING ERRCODE = '23503';
  END IF;

  IF shadow_receipt.event_type IN (
    'content.consumption.progressed', 'content.consumption.completed'
  ) THEN
    progress_basis_points_value :=
      (event_data->>'progressBasisPoints')::integer;
    progress_seconds_value := (event_data->>'consumedSeconds')::integer;
    expected_action := CASE shadow_receipt.event_type
      WHEN 'content.consumption.progressed' THEN 'progressed'
      ELSE 'completed'
    END;

    INSERT INTO app.content_consumption_facts (
      workspace_id,
      contact_id,
      contact_source_identity_id,
      source_subject_id,
      projection_receipt_id,
      medium,
      action,
      progress_basis_points,
      progress_seconds,
      content_key,
      content_version,
      content_label,
      source_system,
      source_event_id,
      source_event_type,
      source_payload_sha256,
      occurred_at
    ) VALUES (
      trusted_workspace_id,
      resolved_contact_id,
      source_identity_id,
      shadow_receipt.subject_id,
      projected_receipt_id,
      event_data->>'medium',
      expected_action,
      progress_basis_points_value,
      progress_seconds_value,
      event_data->>'contentKey',
      event_data->>'contentVersion',
      event_data->>'title',
      shadow_receipt.source,
      shadow_receipt.event_id,
      shadow_receipt.event_type,
      shadow_receipt.payload_sha256,
      shadow_receipt.occurred_at
    )
    ON CONFLICT (workspace_id, source_system, source_event_id) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1
      FROM app.content_consumption_facts AS fact
      WHERE fact.workspace_id = trusted_workspace_id
        AND fact.contact_id = resolved_contact_id
        AND fact.contact_source_identity_id = source_identity_id
        AND fact.source_subject_id = shadow_receipt.subject_id
        AND fact.projection_receipt_id = projected_receipt_id
        AND fact.medium = event_data->>'medium'
        AND fact.action = expected_action
        AND fact.progress_basis_points = progress_basis_points_value
        AND fact.progress_seconds = progress_seconds_value
        AND fact.content_key = event_data->>'contentKey'
        AND fact.content_version = event_data->>'contentVersion'
        AND fact.content_label = event_data->>'title'
        AND fact.source_system = shadow_receipt.source
        AND fact.source_event_id = shadow_receipt.event_id
        AND fact.source_event_type = shadow_receipt.event_type
        AND fact.source_payload_sha256 = shadow_receipt.payload_sha256
        AND fact.occurred_at = shadow_receipt.occurred_at
    ) THEN
      RAISE EXCEPTION 'existing content evidence conflicts with canonical payload'
        USING ERRCODE = '22000';
    END IF;
  ELSIF shadow_receipt.event_type = 'offer.presented' THEN
    price_minor_value := (event_data->'price'->>'amountMinor')::bigint;

    INSERT INTO app.offer_presentation_facts (
      workspace_id,
      contact_id,
      contact_source_identity_id,
      source_subject_id,
      projection_receipt_id,
      offer_key,
      offer_version,
      product_key,
      offer_label,
      price_minor,
      currency,
      placement,
      source_system,
      source_event_id,
      source_event_type,
      source_payload_sha256,
      presented_at
    ) VALUES (
      trusted_workspace_id,
      resolved_contact_id,
      source_identity_id,
      shadow_receipt.subject_id,
      projected_receipt_id,
      event_data->>'offerKey',
      event_data->>'offerVersion',
      event_data->>'productKey',
      event_data->>'label',
      price_minor_value,
      upper(event_data->'price'->>'currency'),
      event_data->>'placement',
      shadow_receipt.source,
      shadow_receipt.event_id,
      shadow_receipt.event_type,
      shadow_receipt.payload_sha256,
      shadow_receipt.occurred_at
    )
    ON CONFLICT (workspace_id, source_system, source_event_id) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1
      FROM app.offer_presentation_facts AS fact
      WHERE fact.workspace_id = trusted_workspace_id
        AND fact.contact_id = resolved_contact_id
        AND fact.contact_source_identity_id = source_identity_id
        AND fact.source_subject_id = shadow_receipt.subject_id
        AND fact.projection_receipt_id = projected_receipt_id
        AND fact.offer_key = event_data->>'offerKey'
        AND fact.offer_version = event_data->>'offerVersion'
        AND fact.product_key = event_data->>'productKey'
        AND fact.offer_label = event_data->>'label'
        AND fact.price_minor = price_minor_value
        AND fact.currency = upper(event_data->'price'->>'currency')
        AND fact.placement = event_data->>'placement'
        AND fact.source_system = shadow_receipt.source
        AND fact.source_event_id = shadow_receipt.event_id
        AND fact.source_event_type = shadow_receipt.event_type
        AND fact.source_payload_sha256 = shadow_receipt.payload_sha256
        AND fact.presented_at = shadow_receipt.occurred_at
    ) THEN
      RAISE EXCEPTION 'existing offer presentation conflicts with canonical payload'
        USING ERRCODE = '22000';
    END IF;
  ELSIF shadow_receipt.event_type = 'offer.responded' THEN
    SELECT fact.id
      INTO presentation_id
    FROM app.offer_presentation_facts AS fact
    WHERE fact.workspace_id = trusted_workspace_id
      AND fact.source_system = shadow_receipt.source
      AND fact.source_event_id = (event_data->>'presentationEventId')::uuid
      AND fact.contact_id = resolved_contact_id
      AND fact.contact_source_identity_id = source_identity_id
      AND fact.source_subject_id = shadow_receipt.subject_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'matching offer presentation evidence is required before response'
        USING ERRCODE = '23503';
    END IF;

    INSERT INTO app.offer_response_facts (
      workspace_id,
      contact_id,
      contact_source_identity_id,
      source_subject_id,
      offer_presentation_id,
      projection_receipt_id,
      response,
      source_system,
      source_event_id,
      source_event_type,
      source_payload_sha256,
      responded_at
    ) VALUES (
      trusted_workspace_id,
      resolved_contact_id,
      source_identity_id,
      shadow_receipt.subject_id,
      presentation_id,
      projected_receipt_id,
      event_data->>'response',
      shadow_receipt.source,
      shadow_receipt.event_id,
      shadow_receipt.event_type,
      shadow_receipt.payload_sha256,
      shadow_receipt.occurred_at
    )
    ON CONFLICT (workspace_id, source_system, source_event_id) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1
      FROM app.offer_response_facts AS fact
      WHERE fact.workspace_id = trusted_workspace_id
        AND fact.contact_id = resolved_contact_id
        AND fact.contact_source_identity_id = source_identity_id
        AND fact.source_subject_id = shadow_receipt.subject_id
        AND fact.offer_presentation_id = presentation_id
        AND fact.projection_receipt_id = projected_receipt_id
        AND fact.response = event_data->>'response'
        AND fact.source_system = shadow_receipt.source
        AND fact.source_event_id = shadow_receipt.event_id
        AND fact.source_event_type = shadow_receipt.event_type
        AND fact.source_payload_sha256 = shadow_receipt.payload_sha256
        AND fact.responded_at = shadow_receipt.occurred_at
    ) THEN
      RAISE EXCEPTION 'existing offer response conflicts with canonical payload'
        USING ERRCODE = '22000';
    END IF;
  ELSIF shadow_receipt.event_type = 'affiliate.referral.attributed' THEN
    INSERT INTO app.contact_attribution_facts (
      workspace_id,
      contact_id,
      contact_source_identity_id,
      source_subject_id,
      projection_receipt_id,
      attribution_type,
      channel,
      attribution_model,
      affiliate_id,
      referral_code,
      source_system,
      source_event_id,
      source_event_type,
      source_payload_sha256,
      attributed_at
    ) VALUES (
      trusted_workspace_id,
      resolved_contact_id,
      source_identity_id,
      shadow_receipt.subject_id,
      projected_receipt_id,
      'affiliate_referral',
      'affiliate',
      event_data->>'model',
      (event_data->>'affiliateId')::uuid,
      event_data->>'referralCode',
      shadow_receipt.source,
      shadow_receipt.event_id,
      shadow_receipt.event_type,
      shadow_receipt.payload_sha256,
      shadow_receipt.occurred_at
    )
    ON CONFLICT (workspace_id, source_system, source_event_id) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1
      FROM app.contact_attribution_facts AS fact
      WHERE fact.workspace_id = trusted_workspace_id
        AND fact.contact_id = resolved_contact_id
        AND fact.contact_source_identity_id = source_identity_id
        AND fact.source_subject_id = shadow_receipt.subject_id
        AND fact.projection_receipt_id = projected_receipt_id
        AND fact.attribution_type = 'affiliate_referral'
        AND fact.channel = 'affiliate'
        AND fact.attribution_model = event_data->>'model'
        AND fact.affiliate_id = (event_data->>'affiliateId')::uuid
        AND fact.referral_code = event_data->>'referralCode'
        AND fact.source_system = shadow_receipt.source
        AND fact.source_event_id = shadow_receipt.event_id
        AND fact.source_event_type = shadow_receipt.event_type
        AND fact.source_payload_sha256 = shadow_receipt.payload_sha256
        AND fact.attributed_at = shadow_receipt.occurred_at
    ) THEN
      RAISE EXCEPTION 'existing attribution evidence conflicts with canonical payload'
        USING ERRCODE = '22000';
    END IF;
  END IF;

  RETURN QUERY SELECT 'projected'::text, projection_replayed;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_growth_projector_definer;

REVOKE ALL ON FUNCTION app_private.project_property_predator_growth_event(uuid)
FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_crm_command, r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_command, r72_external_event_definer;
GRANT EXECUTE ON FUNCTION app_private.project_property_predator_growth_event(uuid)
TO r72_webhook;

-- Fail deployment if either runtime identity gained a wider effective
-- capability through PUBLIC, an inherited role, or a surprising pre-grant.
DO $growth_projector_capability_audit$
DECLARE
  projector_oid oid := pg_catalog.to_regprocedure(
    'app_private.project_property_predator_growth_event(uuid)'
  );
  recorder_oid oid := pg_catalog.to_regprocedure(
    'app_private.record_external_event_shadow_receipt(uuid,text,uuid,text,smallint,timestamptz,uuid,text,uuid,bytea,jsonb,text,timestamptz)'
  );
  unexpected_object text;
BEGIN
  IF projector_oid IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = projector_oid
      AND owner_role.rolname = 'r72_growth_projector_definer'
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
  ) THEN
    RAISE EXCEPTION 'Growth projector ownership or SECURITY DEFINER settings are unsafe';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'r72_webhook', projector_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'r72_external_event_command', projector_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'r72_webhook', recorder_oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Growth projector function capabilities are unsafe';
  END IF;

  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unexpected_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE (namespace.nspname, relation.relname) IN (
      ('app', 'contact_source_identities'),
      ('app', 'content_consumption_facts'),
      ('app', 'offer_presentation_facts'),
      ('app', 'offer_response_facts'),
      ('app', 'contact_attribution_facts'),
      ('app_private', 'external_event_projection_receipts')
    )
    AND (
      pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'INSERT')
      OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'UPDATE')
      OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'DELETE')
      OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'TRUNCATE')
      OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'REFERENCES')
      OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'TRIGGER')
      OR pg_catalog.has_any_column_privilege(
        'r72_webhook', relation.oid, 'SELECT'
      )
      OR pg_catalog.has_any_column_privilege(
        'r72_webhook', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_any_column_privilege(
        'r72_webhook', relation.oid, 'UPDATE'
      )
      OR pg_catalog.has_any_column_privilege(
        'r72_webhook', relation.oid, 'REFERENCES'
      )
    )
  LIMIT 1;

  IF unexpected_object IS NOT NULL THEN
    RAISE EXCEPTION 'Webhook unexpectedly has direct Growth table privilege on %',
      unexpected_object;
  END IF;

  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unexpected_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      pg_catalog.has_table_privilege(
        'r72_external_event_command', relation.oid, 'SELECT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_external_event_command', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_external_event_command', relation.oid, 'UPDATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_external_event_command', relation.oid, 'DELETE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_external_event_command', relation.oid, 'TRUNCATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_external_event_command', relation.oid, 'REFERENCES'
      )
      OR pg_catalog.has_table_privilege(
        'r72_external_event_command', relation.oid, 'TRIGGER'
      )
      OR pg_catalog.has_any_column_privilege(
        'r72_external_event_command', relation.oid, 'SELECT'
      )
      OR pg_catalog.has_any_column_privilege(
        'r72_external_event_command', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_any_column_privilege(
        'r72_external_event_command', relation.oid, 'UPDATE'
      )
      OR pg_catalog.has_any_column_privilege(
        'r72_external_event_command', relation.oid, 'REFERENCES'
      )
    )
  LIMIT 1;

  IF unexpected_object IS NOT NULL THEN
    RAISE EXCEPTION 'External-event command unexpectedly has table privilege on %',
      unexpected_object;
  END IF;

  IF pg_catalog.has_schema_privilege(
       'r72_external_event_command', 'app', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_external_event_command', 'app', 'CREATE'
     ) THEN
    RAISE EXCEPTION 'External-event command unexpectedly has app schema access';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(
       'r72_growth_projector_definer', 'app', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_growth_projector_definer', 'app', 'CREATE'
     )
     OR NOT pg_catalog.has_schema_privilege(
       'r72_growth_projector_definer', 'app_private', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_growth_projector_definer', 'app_private', 'CREATE'
     ) THEN
    RAISE EXCEPTION 'Growth projector definer schema capabilities are unsafe';
  END IF;

  SELECT format('%I.%I(%s)', namespace.nspname, procedure.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid))
    INTO unexpected_object
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'app_private'
    AND pg_catalog.has_function_privilege(
      'r72_growth_projector_definer', procedure.oid, 'EXECUTE'
    )
    AND procedure.oid NOT IN (
      projector_oid,
      pg_catalog.to_regprocedure('app_private.current_workspace_id()'),
      pg_catalog.to_regprocedure('app_private.current_actor_kind()'),
      pg_catalog.to_regprocedure('app_private.current_request_id()')
    )
  LIMIT 1;

  IF unexpected_object IS NOT NULL THEN
    RAISE EXCEPTION 'Growth projector definer unexpectedly can execute %',
      unexpected_object;
  END IF;

  -- The definer may append/select only the exact projector relations.
  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unexpected_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND relation.oid NOT IN (
      'app.contacts'::regclass,
      'app.contact_points'::regclass,
      'app.contact_source_identities'::regclass,
      'app.content_consumption_facts'::regclass,
      'app.offer_presentation_facts'::regclass,
      'app.offer_response_facts'::regclass,
      'app.contact_attribution_facts'::regclass,
      'app_private.external_event_shadow_receipts'::regclass,
      'app_private.external_event_projection_receipts'::regclass
    )
    AND (
      pg_catalog.has_table_privilege(
        'r72_growth_projector_definer', relation.oid, 'SELECT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_growth_projector_definer', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_growth_projector_definer', relation.oid, 'UPDATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_growth_projector_definer', relation.oid, 'DELETE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_growth_projector_definer', relation.oid, 'TRUNCATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_growth_projector_definer', relation.oid, 'REFERENCES'
      )
      OR pg_catalog.has_table_privilege(
        'r72_growth_projector_definer', relation.oid, 'TRIGGER'
      )
    )
  LIMIT 1;

  IF unexpected_object IS NOT NULL THEN
    RAISE EXCEPTION 'Growth projector definer unexpectedly has privilege on %',
      unexpected_object;
  END IF;

  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unexpected_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE (namespace.nspname, relation.relname) IN (
      ('app', 'contacts'),
      ('app', 'contact_points'),
      ('app', 'contact_source_identities'),
      ('app', 'content_consumption_facts'),
      ('app', 'offer_presentation_facts'),
      ('app', 'offer_response_facts'),
      ('app', 'contact_attribution_facts'),
      ('app_private', 'external_event_projection_receipts')
    )
    AND (
      NOT pg_catalog.has_table_privilege(
        'r72_growth_projector_definer', relation.oid, 'SELECT'
      )
      OR NOT pg_catalog.has_table_privilege(
        'r72_growth_projector_definer', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_growth_projector_definer', relation.oid, 'UPDATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_growth_projector_definer', relation.oid, 'DELETE'
      )
    )
  LIMIT 1;

  IF unexpected_object IS NOT NULL
     OR NOT pg_catalog.has_table_privilege(
       'r72_growth_projector_definer',
       'app_private.external_event_shadow_receipts',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_growth_projector_definer',
       'app_private.external_event_shadow_receipts',
       'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_growth_projector_definer',
       'app_private.external_event_shadow_receipts',
       'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_growth_projector_definer',
       'app_private.external_event_shadow_receipts',
       'DELETE'
     ) THEN
    RAISE EXCEPTION 'Growth projector definer table capability map is unsafe';
  END IF;
END
$growth_projector_capability_audit$;
