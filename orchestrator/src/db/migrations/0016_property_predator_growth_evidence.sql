-- Immutable Property Predator evidence for Growth HQ. Every public evidence
-- row is pinned to one accepted shadow event through a private projection
-- receipt, one workspace, and one CRM contact/source identity.

SET LOCAL ROLE r72_owner;

-- Extend the reviewed positive registry for the four Growth evidence events.
-- The ingress identity still records only shadow receipts and retains no app
-- schema or table access.
ALTER TABLE app_private.external_event_shadow_receipts
  DROP CONSTRAINT external_event_shadow_receipts_event_type_check;
ALTER TABLE app_private.external_event_shadow_receipts
  ADD CONSTRAINT external_event_shadow_receipts_event_type_check
  CHECK (event_type IN (
    'identity.account.created',
    'privacy.consent.updated',
    'affiliate.referral.attributed',
    'product.analysis.completed',
    'commerce.purchase.completed',
    'commerce.purchase.refunded',
    'commerce.subscription.cancelled',
    'content.consumption.progressed',
    'content.consumption.completed',
    'offer.presented',
    'offer.responded'
  ));

GRANT CREATE ON SCHEMA app_private TO r72_external_event_definer;
SET LOCAL ROLE r72_external_event_definer;

CREATE OR REPLACE FUNCTION app_private.record_external_event_shadow_receipt(
  p_workspace_id uuid,
  p_source text,
  p_event_id uuid,
  p_event_type text,
  p_event_version smallint,
  p_occurred_at timestamptz,
  p_correlation_id uuid,
  p_subject_kind text,
  p_subject_id uuid,
  p_payload_sha256 bytea,
  p_event_payload jsonb,
  p_signature_key_id text,
  p_signature_timestamp timestamptz
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
  inserted_receipt_count integer;
  existing_payload_sha256 bytea;
BEGIN
  IF trusted_actor_kind IS DISTINCT FROM 'webhook'
     OR trusted_workspace_id IS NULL
     OR p_workspace_id IS DISTINCT FROM trusted_workspace_id THEN
    RAISE EXCEPTION 'external event receipt context denied'
      USING ERRCODE = '42501';
  END IF;

  IF trusted_request_id IS NULL
     OR length(trusted_request_id) NOT BETWEEN 1 AND 128
     OR trusted_request_id ~ '[^[:graph:]]'
     OR p_source IS DISTINCT FROM 'property_predator'
     OR p_event_id IS NULL
     OR p_event_type IS NULL
     OR p_event_type NOT IN (
       'identity.account.created',
       'privacy.consent.updated',
       'affiliate.referral.attributed',
       'product.analysis.completed',
       'commerce.purchase.completed',
       'commerce.purchase.refunded',
       'commerce.subscription.cancelled',
       'content.consumption.progressed',
       'content.consumption.completed',
       'offer.presented',
       'offer.responded'
     )
     OR p_event_version IS DISTINCT FROM 1
     OR p_occurred_at IS NULL
     OR p_correlation_id IS NULL
     OR p_subject_kind IS DISTINCT FROM 'account'
     OR p_subject_id IS NULL
     OR p_payload_sha256 IS NULL
     OR octet_length(p_payload_sha256) <> 32
     OR p_signature_key_id IS NULL
     OR length(p_signature_key_id) NOT BETWEEN 1 AND 64
     OR p_signature_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     OR p_signature_timestamp IS NULL
     OR p_event_payload IS NULL
     OR jsonb_typeof(p_event_payload) IS DISTINCT FROM 'object'
     OR NOT (p_event_payload ?& ARRAY[
       'id', 'type', 'version', 'occurredAt', 'correlationId', 'subject', 'data'
     ])
     OR p_event_payload - ARRAY[
       'id', 'type', 'version', 'occurredAt', 'correlationId', 'subject', 'data'
     ] <> '{}'::jsonb
     OR p_event_payload->>'id' IS DISTINCT FROM p_event_id::text
     OR p_event_payload->>'type' IS DISTINCT FROM p_event_type
     OR p_event_payload->>'version' IS DISTINCT FROM p_event_version::text
     OR (p_event_payload->>'occurredAt')::timestamptz IS DISTINCT FROM p_occurred_at
     OR p_event_payload->>'correlationId' IS DISTINCT FROM p_correlation_id::text
     OR jsonb_typeof(p_event_payload->'subject') IS DISTINCT FROM 'object'
     OR NOT ((p_event_payload->'subject') ?& ARRAY['kind', 'id'])
     OR (p_event_payload->'subject') - ARRAY['kind', 'id'] <> '{}'::jsonb
     OR p_event_payload->'subject'->>'kind' IS DISTINCT FROM p_subject_kind
     OR p_event_payload->'subject'->>'id' IS DISTINCT FROM p_subject_id::text
     OR jsonb_typeof(p_event_payload->'data') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid external event shadow receipt input'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_private.external_event_shadow_receipts (
    workspace_id,
    source,
    event_id,
    event_type,
    event_version,
    occurred_at,
    correlation_id,
    subject_kind,
    subject_id,
    payload_sha256,
    event_payload,
    signature_key_id,
    signature_timestamp,
    disposition,
    actor_kind,
    request_id
  ) VALUES (
    trusted_workspace_id,
    p_source,
    p_event_id,
    p_event_type,
    p_event_version,
    p_occurred_at,
    p_correlation_id,
    p_subject_kind,
    p_subject_id,
    p_payload_sha256,
    p_event_payload,
    p_signature_key_id,
    p_signature_timestamp,
    'shadow',
    'webhook',
    trusted_request_id
  )
  ON CONFLICT (workspace_id, source, event_id) DO NOTHING;

  GET DIAGNOSTICS inserted_receipt_count = ROW_COUNT;
  IF inserted_receipt_count = 0 THEN
    SELECT receipt.payload_sha256
      INTO existing_payload_sha256
    FROM app_private.external_event_shadow_receipts AS receipt
    WHERE receipt.workspace_id = trusted_workspace_id
      AND receipt.source = p_source
      AND receipt.event_id = p_event_id;

    IF NOT FOUND OR existing_payload_sha256 IS DISTINCT FROM p_payload_sha256 THEN
      RAISE EXCEPTION 'external event id was replayed with different payload bytes'
        USING ERRCODE = '22000';
    END IF;

    RETURN QUERY SELECT 'shadow'::text, true;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'shadow'::text, false;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_external_event_definer;

-- The shadow bridge already makes (workspace, source, event_id) immutable.
-- This redundant candidate key lets the projection receipt additionally prove
-- that it is acknowledging the exact authenticated payload and event shape.
ALTER TABLE app_private.external_event_shadow_receipts
  ADD CONSTRAINT external_event_shadow_receipts_projection_identity_uq
  UNIQUE (
    workspace_id, source, event_id, event_type,
    subject_kind, subject_id, payload_sha256
  );

CREATE TABLE app_private.external_event_projection_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source = 'property_predator'),
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'identity.account.created',
    'privacy.consent.updated',
    'affiliate.referral.attributed',
    'product.analysis.completed',
    'commerce.purchase.completed',
    'commerce.purchase.refunded',
    'commerce.subscription.cancelled',
    'content.consumption.progressed',
    'content.consumption.completed',
    'offer.presented',
    'offer.responded'
  )),
  subject_kind text NOT NULL CHECK (subject_kind = 'account'),
  subject_id uuid NOT NULL,
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  request_id text NOT NULL CHECK (
    length(request_id) BETWEEN 1 AND 128
    AND request_id !~ '[^[:graph:]]'
  ),
  projected_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source, event_id),
  UNIQUE (
    workspace_id, id, source, event_id, event_type,
    subject_kind, subject_id, payload_sha256
  ),
  UNIQUE (
    workspace_id, id, source, event_id, event_type,
    subject_id, payload_sha256
  ),
  FOREIGN KEY (
    workspace_id, source, event_id, event_type,
    subject_kind, subject_id, payload_sha256
  ) REFERENCES app_private.external_event_shadow_receipts (
    workspace_id, source, event_id, event_type,
    subject_kind, subject_id, payload_sha256
  ) ON DELETE RESTRICT
);

CREATE INDEX external_event_projection_receipts_workspace_time_idx
  ON app_private.external_event_projection_receipts
    (workspace_id, projected_at DESC, id DESC);

CREATE TABLE app.contact_source_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  source_system text NOT NULL CHECK (
    source_system = lower(btrim(source_system))
    AND source_system ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  source_subject_kind text NOT NULL CHECK (source_subject_kind = 'account'),
  source_subject_id uuid NOT NULL,
  projection_receipt_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  source_event_type text NOT NULL
    CHECK (source_event_type = 'identity.account.created'),
  source_payload_sha256 bytea NOT NULL
    CHECK (octet_length(source_payload_sha256) = 32),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (
    workspace_id, id, contact_id, source_system,
    source_subject_kind, source_subject_id
  ),
  UNIQUE (
    workspace_id, id, contact_id, source_system, source_subject_id
  ),
  UNIQUE (
    workspace_id, source_system, source_subject_kind, source_subject_id
  ),
  UNIQUE (workspace_id, source_system, source_event_id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, projection_receipt_id, source_system, source_event_id,
    source_event_type, source_subject_kind, source_subject_id,
    source_payload_sha256
  ) REFERENCES app_private.external_event_projection_receipts (
    workspace_id, id, source, event_id, event_type,
    subject_kind, subject_id, payload_sha256
  ) ON DELETE RESTRICT
);

CREATE INDEX contact_source_identities_contact_idx
  ON app.contact_source_identities
    (workspace_id, contact_id, source_system, recorded_at DESC, id DESC);

CREATE TABLE app.content_consumption_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  contact_source_identity_id uuid NOT NULL,
  source_subject_id uuid NOT NULL,
  projection_receipt_id uuid NOT NULL,
  medium text NOT NULL CHECK (
    medium IN ('video', 'audio', 'article', 'document', 'other')
  ),
  action text NOT NULL CHECK (
    action IN ('started', 'progressed', 'completed', 'downloaded')
  ),
  progress_basis_points smallint CHECK (
    progress_basis_points BETWEEN 0 AND 10000
  ),
  progress_seconds integer CHECK (progress_seconds >= 0),
  content_key text NOT NULL CHECK (
    content_key = lower(btrim(content_key))
    AND content_key ~ '^[a-z0-9][a-z0-9_.:-]{0,149}$'
  ),
  content_version text NOT NULL CHECK (
    content_version = btrim(content_version)
    AND length(content_version) BETWEEN 1 AND 100
  ),
  content_label text NOT NULL CHECK (
    length(btrim(content_label)) BETWEEN 1 AND 200
  ),
  source_system text NOT NULL CHECK (
    source_system = lower(btrim(source_system))
    AND source_system ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  source_event_id uuid NOT NULL,
  source_event_type text NOT NULL CHECK (
    source_event_type IN (
      'content.consumption.progressed', 'content.consumption.completed'
    )
  ),
  source_payload_sha256 bytea NOT NULL
    CHECK (octet_length(source_payload_sha256) = 32),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_system, source_event_id),
  FOREIGN KEY (
    workspace_id, contact_source_identity_id, contact_id,
    source_system, source_subject_id
  ) REFERENCES app.contact_source_identities (
    workspace_id, id, contact_id, source_system, source_subject_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, projection_receipt_id, source_system, source_event_id,
    source_event_type, source_subject_id, source_payload_sha256
  ) REFERENCES app_private.external_event_projection_receipts (
    workspace_id, id, source, event_id, event_type,
    subject_id, payload_sha256
  ) ON DELETE RESTRICT,
  CHECK (
    action <> 'progressed'
    OR progress_basis_points IS NOT NULL
    OR progress_seconds IS NOT NULL
  ),
  CHECK (
    action <> 'completed'
    OR progress_basis_points IS NOT NULL AND progress_basis_points = 10000
  ),
  -- `started` and `downloaded` remain reserved product vocabulary, but no row
  -- can use them until a future wire event and forward migration register an
  -- exact source type. Current writes are a strict event/action bijection.
  CHECK (
    (source_event_type = 'content.consumption.progressed'
      AND action = 'progressed')
    OR
    (source_event_type = 'content.consumption.completed'
      AND action = 'completed')
  )
);

CREATE INDEX content_consumption_facts_contact_timeline_idx
  ON app.content_consumption_facts
    (workspace_id, contact_id, occurred_at DESC, id DESC);

CREATE INDEX content_consumption_facts_content_timeline_idx
  ON app.content_consumption_facts
    (workspace_id, content_key, content_version, occurred_at DESC, id DESC);

CREATE TABLE app.offer_presentation_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  contact_source_identity_id uuid NOT NULL,
  source_subject_id uuid NOT NULL,
  projection_receipt_id uuid NOT NULL,
  offer_key text NOT NULL CHECK (
    offer_key = lower(btrim(offer_key))
    AND offer_key ~ '^[a-z0-9][a-z0-9_.:-]{0,149}$'
  ),
  offer_version text NOT NULL CHECK (
    offer_version = btrim(offer_version)
    AND length(offer_version) BETWEEN 1 AND 100
  ),
  product_key text NOT NULL CHECK (
    product_key = lower(btrim(product_key))
    AND product_key ~ '^[a-z0-9][a-z0-9_.:-]{0,149}$'
  ),
  offer_label text NOT NULL CHECK (
    length(btrim(offer_label)) BETWEEN 1 AND 200
    AND offer_label !~ '[[:cntrl:]]'
  ),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  -- The wire contract is canonical lowercase; the projector must normalize to
  -- the existing database convention so prices compose with CRM/commerce data.
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  placement text NOT NULL CHECK (
    placement = lower(btrim(placement))
    AND placement ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'
  ),
  source_system text NOT NULL CHECK (
    source_system = lower(btrim(source_system))
    AND source_system ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  source_event_id uuid NOT NULL,
  source_event_type text NOT NULL CHECK (source_event_type = 'offer.presented'),
  source_payload_sha256 bytea NOT NULL
    CHECK (octet_length(source_payload_sha256) = 32),
  presented_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (
    workspace_id, id, contact_id, contact_source_identity_id,
    source_system, source_subject_id
  ),
  UNIQUE (workspace_id, source_system, source_event_id),
  FOREIGN KEY (
    workspace_id, contact_source_identity_id, contact_id,
    source_system, source_subject_id
  ) REFERENCES app.contact_source_identities (
    workspace_id, id, contact_id, source_system, source_subject_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, projection_receipt_id, source_system, source_event_id,
    source_event_type, source_subject_id, source_payload_sha256
  ) REFERENCES app_private.external_event_projection_receipts (
    workspace_id, id, source, event_id, event_type,
    subject_id, payload_sha256
  ) ON DELETE RESTRICT
);

CREATE INDEX offer_presentation_facts_contact_timeline_idx
  ON app.offer_presentation_facts
    (workspace_id, contact_id, presented_at DESC, id DESC);

CREATE INDEX offer_presentation_facts_offer_timeline_idx
  ON app.offer_presentation_facts
    (workspace_id, offer_key, offer_version, presented_at DESC, id DESC);

CREATE TABLE app.offer_response_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  contact_source_identity_id uuid NOT NULL,
  source_subject_id uuid NOT NULL,
  offer_presentation_id uuid NOT NULL,
  projection_receipt_id uuid NOT NULL,
  response text NOT NULL CHECK (
    response IN ('accepted', 'declined', 'deferred', 'requested_contact')
  ),
  source_system text NOT NULL CHECK (
    source_system = lower(btrim(source_system))
    AND source_system ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  source_event_id uuid NOT NULL,
  source_event_type text NOT NULL CHECK (source_event_type = 'offer.responded'),
  source_payload_sha256 bytea NOT NULL
    CHECK (octet_length(source_payload_sha256) = 32),
  responded_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_system, source_event_id),
  FOREIGN KEY (
    workspace_id, offer_presentation_id, contact_id,
    contact_source_identity_id, source_system, source_subject_id
  ) REFERENCES app.offer_presentation_facts (
    workspace_id, id, contact_id,
    contact_source_identity_id, source_system, source_subject_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, projection_receipt_id, source_system, source_event_id,
    source_event_type, source_subject_id, source_payload_sha256
  ) REFERENCES app_private.external_event_projection_receipts (
    workspace_id, id, source, event_id, event_type,
    subject_id, payload_sha256
  ) ON DELETE RESTRICT
);

CREATE INDEX offer_response_facts_contact_timeline_idx
  ON app.offer_response_facts
    (workspace_id, contact_id, responded_at DESC, id DESC);

CREATE INDEX offer_response_facts_presentation_timeline_idx
  ON app.offer_response_facts
    (workspace_id, offer_presentation_id, responded_at DESC, id DESC);

CREATE TABLE app.contact_attribution_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  contact_source_identity_id uuid NOT NULL,
  source_subject_id uuid NOT NULL,
  projection_receipt_id uuid NOT NULL,
  attribution_type text NOT NULL CHECK (
    attribution_type IN (
      'first_touch', 'last_touch', 'lead_creation',
      'conversion_touch', 'self_reported', 'affiliate_referral', 'other'
    )
  ),
  channel text NOT NULL CHECK (
    channel = lower(btrim(channel))
    AND channel ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  attribution_model text CHECK (
    attribution_model IS NULL OR (
      attribution_model = lower(btrim(attribution_model))
      AND attribution_model ~ '^[a-z][a-z0-9_.:-]{0,99}$'
    )
  ),
  affiliate_id uuid,
  referral_code text CHECK (
    referral_code IS NULL OR (
      referral_code = btrim(referral_code)
      AND length(referral_code) BETWEEN 1 AND 64
      AND referral_code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
    )
  ),
  utm_source text CHECK (
    utm_source IS NULL OR length(btrim(utm_source)) BETWEEN 1 AND 200
  ),
  utm_medium text CHECK (
    utm_medium IS NULL OR length(btrim(utm_medium)) BETWEEN 1 AND 200
  ),
  utm_campaign text CHECK (
    utm_campaign IS NULL OR length(btrim(utm_campaign)) BETWEEN 1 AND 300
  ),
  utm_term text CHECK (
    utm_term IS NULL OR length(btrim(utm_term)) BETWEEN 1 AND 300
  ),
  utm_content text CHECK (
    utm_content IS NULL OR length(btrim(utm_content)) BETWEEN 1 AND 300
  ),
  referrer_url text CHECK (
    referrer_url IS NULL OR length(btrim(referrer_url)) BETWEEN 1 AND 2048
  ),
  landing_url text CHECK (
    landing_url IS NULL OR length(btrim(landing_url)) BETWEEN 1 AND 2048
  ),
  source_system text NOT NULL CHECK (
    source_system = lower(btrim(source_system))
    AND source_system ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  source_event_id uuid NOT NULL,
  source_event_type text NOT NULL
    CHECK (source_event_type = 'affiliate.referral.attributed'),
  source_payload_sha256 bytea NOT NULL
    CHECK (octet_length(source_payload_sha256) = 32),
  attributed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_system, source_event_id),
  FOREIGN KEY (
    workspace_id, contact_source_identity_id, contact_id,
    source_system, source_subject_id
  ) REFERENCES app.contact_source_identities (
    workspace_id, id, contact_id, source_system, source_subject_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, projection_receipt_id, source_system, source_event_id,
    source_event_type, source_subject_id, source_payload_sha256
  ) REFERENCES app_private.external_event_projection_receipts (
    workspace_id, id, source, event_id, event_type,
    subject_id, payload_sha256
  ) ON DELETE RESTRICT,
  CHECK ((affiliate_id IS NULL) = (referral_code IS NULL)),
  CHECK (
    attribution_type = 'affiliate_referral'
    AND affiliate_id IS NOT NULL
  ),
  CHECK (
    attribution_type <> 'affiliate_referral'
    OR (
      channel = 'affiliate'
      AND attribution_model = 'last_click'
      AND affiliate_id IS NOT NULL
      AND referral_code IS NOT NULL
    )
  )
);

CREATE INDEX contact_attribution_facts_contact_timeline_idx
  ON app.contact_attribution_facts
    (workspace_id, contact_id, attributed_at DESC, id DESC);

CREATE INDEX contact_attribution_facts_campaign_timeline_idx
  ON app.contact_attribution_facts
    (workspace_id, utm_campaign, attributed_at DESC, id DESC)
  WHERE utm_campaign IS NOT NULL;

CREATE INDEX contact_attribution_facts_affiliate_timeline_idx
  ON app.contact_attribution_facts
    (workspace_id, affiliate_id, attributed_at DESC, id DESC)
  WHERE affiliate_id IS NOT NULL;

-- Start from an explicit empty capability surface even if a role was
-- pre-created with surprising table grants on a managed Postgres branch.
REVOKE ALL ON
  app.contact_source_identities,
  app.content_consumption_facts,
  app.offer_presentation_facts,
  app.offer_response_facts,
  app.contact_attribution_facts
FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_crm_command, r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_definer, r72_external_event_command;

REVOKE ALL ON app_private.external_event_projection_receipts
FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_crm_command, r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_definer, r72_external_event_command;

-- No workspace-owned evidence table exists for even one transaction without
-- forced RLS. The private receipt is scoped for the same reason: its runtime
-- role can never acknowledge or enumerate another workspace's shadow event.
DO $evidence_rls$
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
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)',
      table_name || '_owner_all',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_web USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.has_active_workspace_membership(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
      table_name || '_member_select',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_webhook USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.current_actor_kind() = ''webhook''
       )',
      table_name || '_webhook_select',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR INSERT TO r72_webhook WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.current_actor_kind() = ''webhook''
       )',
      table_name || '_webhook_insert',
      table_name
    );
  END LOOP;
END
$evidence_rls$;

ALTER TABLE app_private.external_event_projection_receipts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.external_event_projection_receipts
  FORCE ROW LEVEL SECURITY;

CREATE POLICY external_event_projection_receipts_owner_all
  ON app_private.external_event_projection_receipts
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);

CREATE POLICY external_event_projection_receipts_webhook_select
  ON app_private.external_event_projection_receipts
  FOR SELECT TO r72_webhook USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
  );

CREATE POLICY external_event_projection_receipts_webhook_insert
  ON app_private.external_event_projection_receipts
  FOR INSERT TO r72_webhook WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND request_id = app_private.current_request_id()
  );

GRANT SELECT ON
  app.contact_source_identities,
  app.content_consumption_facts,
  app.offer_presentation_facts,
  app.offer_response_facts,
  app.contact_attribution_facts
TO r72_web, r72_webhook;

GRANT INSERT ON
  app.contact_source_identities,
  app.content_consumption_facts,
  app.offer_presentation_facts,
  app.offer_response_facts,
  app.contact_attribution_facts
TO r72_webhook;

GRANT SELECT, INSERT ON app_private.external_event_projection_receipts
  TO r72_webhook;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'contact_source_identities', 'workspace_id'),
  ('app', 'content_consumption_facts', 'workspace_id'),
  ('app', 'offer_presentation_facts', 'workspace_id'),
  ('app', 'offer_response_facts', 'workspace_id'),
  ('app', 'contact_attribution_facts', 'workspace_id'),
  ('app_private', 'external_event_projection_receipts', 'workspace_id');

-- Migration 0015's dedicated ingress login remains a receipt-only function
-- caller. In particular, creating projector tables must not give it app schema
-- access or any effective table privilege through PUBLIC or another grant.
DO $external_event_command_table_audit$
DECLARE
  unexpected_object text;
BEGIN
  IF pg_catalog.has_schema_privilege(
       'r72_external_event_command', 'app', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_external_event_command', 'app', 'CREATE'
     ) THEN
    RAISE EXCEPTION 'External-event command unexpectedly has app schema access';
  END IF;

  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unexpected_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
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
    )
  LIMIT 1;

  IF unexpected_object IS NOT NULL THEN
    RAISE EXCEPTION 'External-event command unexpectedly has table privilege on %',
      unexpected_object;
  END IF;
END
$external_event_command_table_audit$;
