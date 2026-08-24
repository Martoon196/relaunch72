-- PostgreSQL-native one-off Checkout provenance and paid portal provisioning.
-- A Stripe signature proves provider origin; only an exact match to a
-- server-created, session-bound intent can mint a paid order. Browser-held
-- order claims and setup credentials enter PostgreSQL only as SHA-256 hashes.

DO $roles$
DECLARE
  unexpected_member text;
  unexpected_parent text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_commerce_definer'
  ) THEN
    CREATE ROLE r72_commerce_definer NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_commerce_definer'
      AND NOT rolcanlogin
      AND NOT rolinherit
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe role attributes: r72_commerce_definer does not match the required capability shape';
  END IF;

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer
    FROM r72_commerce_definer;
  REVOKE r72_commerce_definer
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
      r72_crm_command, r72_identity_command, r72_provisioning_command,
      r72_setup_delivery_command, r72_setup_reissue_command;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_commerce_definer'
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe commerce role membership: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_commerce_definer'
    AND member.rolname NOT IN ('r72_owner', current_user)
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe commerce role grant: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  GRANT r72_commerce_definer TO r72_owner;
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private FROM r72_commerce_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_commerce_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_commerce_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_commerce_definer;
REVOKE CREATE ON SCHEMA public FROM r72_commerce_definer;

-- An intent is committed before Stripe is called. Its immutable expected facts
-- are the authority later matched by the signed Checkout event.
CREATE TABLE app_private.checkout_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_idempotency_key text NOT NULL UNIQUE CHECK (
    request_idempotency_key = btrim(request_idempotency_key)
    AND length(request_idempotency_key) BETWEEN 1 AND 128
  ),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  product_key text NOT NULL CHECK (
    product_key IN ('autopsy', 'core', 'core_bump', 'pro')
  ),
  entitlement_version smallint NOT NULL CHECK (entitlement_version = 1),
  through_stage text NOT NULL CHECK (through_stage IN ('S1', 'S9')),
  portal_access boolean NOT NULL,
  expected_price_id text NOT NULL CHECK (
    expected_price_id = btrim(expected_price_id)
    AND length(expected_price_id) BETWEEN 1 AND 255
  ),
  expected_amount_minor bigint NOT NULL CHECK (expected_amount_minor > 0),
  expected_currency text NOT NULL CHECK (
    expected_currency = lower(expected_currency)
    AND expected_currency ~ '^[a-z]{3}$'
  ),
  expected_mode text NOT NULL DEFAULT 'payment' CHECK (expected_mode = 'payment'),
  expected_livemode boolean NOT NULL,
  provider_idempotency_key text NOT NULL UNIQUE DEFAULT (
    'r72-checkout-v1:' || gen_random_uuid()::text
  ) CHECK (
    provider_idempotency_key = btrim(provider_idempotency_key)
    AND length(provider_idempotency_key) BETWEEN 1 AND 255
  ),
  stripe_session_id text UNIQUE CHECK (
    stripe_session_id IS NULL OR (
      stripe_session_id = btrim(stripe_session_id)
      AND length(stripe_session_id) BETWEEN 1 AND 128
    )
  ),
  status text NOT NULL DEFAULT 'created' CHECK (
    status IN ('created', 'session_created', 'completed', 'expired', 'cancelled')
  ),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK (status <> 'created' OR stripe_session_id IS NULL),
  CHECK (status NOT IN ('session_created', 'completed') OR stripe_session_id IS NOT NULL),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK (
    (product_key = 'autopsy' AND through_stage = 'S1' AND NOT portal_access)
    OR
    (product_key IN ('core', 'core_bump', 'pro') AND through_stage = 'S9' AND portal_access)
  )
);

-- The raw 256-bit browser credential stays in same-origin session storage.
-- Only this one-way lookup hash survives the checkout redirect.
CREATE TABLE app_private.order_claim_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_intent_id uuid NOT NULL UNIQUE
    REFERENCES app_private.checkout_intents(id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  purpose text NOT NULL DEFAULT 'intake' CHECK (purpose = 'intake'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

-- Event ID is the replay boundary. The digest binds a replay to the exact raw
-- signed bytes without retaining Stripe's full PII-bearing payload.
CREATE TABLE app_private.stripe_checkout_events (
  event_id text PRIMARY KEY CHECK (
    event_id = btrim(event_id) AND length(event_id) BETWEEN 1 AND 255
  ),
  event_type text NOT NULL CHECK (
    event_type = btrim(event_type) AND length(event_type) BETWEEN 1 AND 255
  ),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  provider_created_at timestamptz NOT NULL,
  livemode boolean NOT NULL,
  reported_checkout_intent_id uuid,
  checkout_intent_id uuid
    REFERENCES app_private.checkout_intents(id) ON DELETE RESTRICT,
  stripe_session_id text NOT NULL CHECK (
    stripe_session_id = btrim(stripe_session_id)
    AND length(stripe_session_id) BETWEEN 1 AND 128
  ),
  disposition text NOT NULL DEFAULT 'received' CHECK (
    disposition IN ('received', 'processed', 'rejected')
  ),
  reason_code text CHECK (
    reason_code IS NULL OR (
      reason_code = btrim(reason_code)
      AND length(reason_code) BETWEEN 1 AND 100
      AND reason_code ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'
    )
  ),
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  processed_at timestamptz,
  CHECK ((disposition = 'received') = (processed_at IS NULL)),
  CHECK (disposition = 'received' OR reason_code IS NOT NULL),
  CHECK (processed_at IS NULL OR processed_at >= received_at)
);

-- This is Relaunch72's own commercial order, not a future workspace merchant
-- order. Financial truth and onboarding truth deliberately remain independent.
CREATE TABLE app_private.platform_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_intent_id uuid NOT NULL UNIQUE
    REFERENCES app_private.checkout_intents(id) ON DELETE RESTRICT,
  accepted_event_id text NOT NULL UNIQUE
    REFERENCES app_private.stripe_checkout_events(event_id) ON DELETE RESTRICT,
  stripe_session_id text NOT NULL UNIQUE CHECK (
    stripe_session_id = btrim(stripe_session_id)
    AND length(stripe_session_id) BETWEEN 1 AND 128
  ),
  payment_intent_id text UNIQUE CHECK (
    payment_intent_id IS NULL OR (
      payment_intent_id = btrim(payment_intent_id)
      AND length(payment_intent_id) BETWEEN 1 AND 255
    )
  ),
  stripe_customer_id text CHECK (
    stripe_customer_id IS NULL OR (
      stripe_customer_id = btrim(stripe_customer_id)
      AND length(stripe_customer_id) BETWEEN 1 AND 255
    )
  ),
  product_key text NOT NULL CHECK (
    product_key IN ('autopsy', 'core', 'core_bump', 'pro')
  ),
  entitlement_version smallint NOT NULL CHECK (entitlement_version = 1),
  through_stage text NOT NULL CHECK (through_stage IN ('S1', 'S9')),
  portal_access boolean NOT NULL,
  price_id text NOT NULL CHECK (
    price_id = btrim(price_id) AND length(price_id) BETWEEN 1 AND 255
  ),
  receipt_email citext CHECK (
    receipt_email IS NULL OR (
      receipt_email::text = lower(btrim(receipt_email::text))
      AND length(receipt_email::text) BETWEEN 3 AND 320
      AND receipt_email::text ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (
    currency = lower(currency) AND currency ~ '^[a-z]{3}$'
  ),
  financial_status text NOT NULL DEFAULT 'paid' CHECK (financial_status = 'paid'),
  fulfilment_status text NOT NULL CHECK (
    fulfilment_status IN ('awaiting_intake', 'blocked', 'provisioned')
  ),
  block_reason text CHECK (
    block_reason IS NULL OR (
      block_reason = btrim(block_reason)
      AND length(block_reason) BETWEEN 1 AND 100
      AND block_reason ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'
    )
  ),
  organization_id uuid REFERENCES app.organizations(id) ON DELETE RESTRICT,
  workspace_id uuid,
  owner_user_id uuid,
  setup_action_token_id uuid UNIQUE
    REFERENCES app.identity_action_tokens(id) ON DELETE RESTRICT,
  setup_delivery_id uuid UNIQUE
    REFERENCES app_private.account_setup_deliveries(id) ON DELETE RESTRICT,
  paid_at timestamptz NOT NULL,
  provisioned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES app.workspaces (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (
    (product_key = 'autopsy' AND through_stage = 'S1' AND NOT portal_access)
    OR
    (product_key IN ('core', 'core_bump', 'pro') AND through_stage = 'S9' AND portal_access)
  ),
  CHECK (
    (fulfilment_status = 'blocked' AND block_reason IS NOT NULL)
    OR
    (fulfilment_status <> 'blocked' AND block_reason IS NULL)
  ),
  CHECK (
    (
      fulfilment_status = 'provisioned'
      AND receipt_email IS NOT NULL
      AND organization_id IS NOT NULL
      AND workspace_id IS NOT NULL
      AND owner_user_id IS NOT NULL
      AND setup_action_token_id IS NOT NULL
      AND setup_delivery_id IS NOT NULL
      AND provisioned_at IS NOT NULL
    )
    OR
    (
      fulfilment_status <> 'provisioned'
      AND organization_id IS NULL
      AND workspace_id IS NULL
      AND owner_user_id IS NULL
      AND setup_action_token_id IS NULL
      AND setup_delivery_id IS NULL
      AND provisioned_at IS NULL
    )
  ),
  CHECK (fulfilment_status <> 'awaiting_intake' OR receipt_email IS NOT NULL),
  CHECK (provisioned_at IS NULL OR provisioned_at >= created_at)
);

CREATE INDEX checkout_intents_session_status_idx
  ON app_private.checkout_intents (stripe_session_id, status)
  WHERE stripe_session_id IS NOT NULL;
CREATE INDEX platform_orders_fulfilment_idx
  ON app_private.platform_orders (fulfilment_status, created_at, id);

REVOKE ALL ON app_private.checkout_intents,
  app_private.order_claim_grants,
  app_private.stripe_checkout_events,
  app_private.platform_orders
  FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command;

GRANT USAGE ON SCHEMA app_private
  TO r72_commerce_definer, r72_public, r72_provisioning_command;
GRANT SELECT, INSERT, UPDATE ON app_private.checkout_intents
  TO r72_commerce_definer;
GRANT SELECT, INSERT ON app_private.order_claim_grants
  TO r72_commerce_definer;
GRANT SELECT, INSERT, UPDATE ON app_private.stripe_checkout_events
  TO r72_commerce_definer;
GRANT SELECT, INSERT ON app_private.platform_orders
  TO r72_commerce_definer;

GRANT SELECT ON app_private.checkout_intents,
  app_private.order_claim_grants,
  app_private.platform_orders
  TO r72_onboarding_definer;
-- PostgreSQL requires a minimum UPDATE privilege for SELECT ... FOR UPDATE.
GRANT UPDATE (updated_at) ON app_private.checkout_intents
  TO r72_onboarding_definer;
GRANT UPDATE (consumed_at) ON app_private.order_claim_grants
  TO r72_onboarding_definer;
GRANT UPDATE (
  fulfilment_status,
  organization_id,
  workspace_id,
  owner_user_id,
  setup_action_token_id,
  setup_delivery_id,
  provisioned_at,
  updated_at
) ON app_private.platform_orders TO r72_onboarding_definer;

GRANT CREATE ON SCHEMA app_private TO r72_commerce_definer;
SET LOCAL ROLE r72_commerce_definer;

CREATE FUNCTION app_private.begin_one_off_checkout(
  p_request_idempotency_key text,
  p_product_key text,
  p_entitlement_version smallint,
  p_through_stage text,
  p_portal_access boolean,
  p_expected_price_id text,
  p_expected_amount_minor bigint,
  p_expected_currency text,
  p_expected_livemode boolean,
  p_order_claim_hash bytea
)
RETURNS TABLE (
  checkout_intent_id uuid,
  provider_idempotency_key text,
  intent_expires_at timestamptz,
  stripe_session_id text,
  created_now boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  normalized_request_key text := pg_catalog.btrim(p_request_idempotency_key);
  normalized_product_key text := pg_catalog.lower(pg_catalog.btrim(p_product_key));
  normalized_price_id text := pg_catalog.btrim(p_expected_price_id);
  normalized_currency text := pg_catalog.lower(pg_catalog.btrim(p_expected_currency));
  stable_request_hash bytea;
  existing_request_hash bytea;
  existing_intent_id uuid;
  existing_provider_key text;
  existing_expires_at timestamptz;
  existing_session_id text;
  created_intent_id uuid;
  created_provider_key text;
  -- Stripe Checkout accepts whole-second Unix expiry values. Persist and
  -- return that exact second so event.created can be compared to the same
  -- authority later without rounding drift.
  created_expires_at timestamptz :=
    pg_catalog.date_trunc('second', statement_timestamp()) + interval '1 hour';
  created_claim_expires_at timestamptz := statement_timestamp() + interval '7 days';
BEGIN
  IF p_request_idempotency_key IS NULL
     OR normalized_request_key <> p_request_idempotency_key
     OR length(normalized_request_key) NOT BETWEEN 1 AND 128
     OR p_product_key IS NULL
     OR normalized_product_key NOT IN ('autopsy', 'core', 'core_bump', 'pro')
     OR p_entitlement_version IS DISTINCT FROM 1
     OR p_through_stage IS NULL
     OR p_portal_access IS NULL
     OR NOT (
       (normalized_product_key = 'autopsy' AND p_through_stage = 'S1' AND NOT p_portal_access)
       OR
       (normalized_product_key IN ('core', 'core_bump', 'pro')
         AND p_through_stage = 'S9' AND p_portal_access)
     )
     OR p_expected_price_id IS NULL
     OR normalized_price_id <> p_expected_price_id
     OR length(normalized_price_id) NOT BETWEEN 1 AND 255
     OR p_expected_amount_minor IS NULL
     OR p_expected_amount_minor <= 0
     OR p_expected_currency IS NULL
     OR normalized_currency <> p_expected_currency
     OR normalized_currency !~ '^[a-z]{3}$'
     OR p_expected_livemode IS NULL
     OR p_order_claim_hash IS NULL
     OR octet_length(p_order_claim_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid one-off checkout input' USING ERRCODE = '22023';
  END IF;

  stable_request_hash := public.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        normalized_product_key,
        p_entitlement_version,
        p_through_stage,
        p_portal_access,
        normalized_price_id,
        p_expected_amount_minor,
        normalized_currency,
        'payment',
        p_expected_livemode,
        pg_catalog.encode(p_order_claim_hash, 'hex')
      )::text,
      'UTF8'
    ),
    'sha256'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(normalized_request_key, 7200012)
  );

  SELECT intent.request_hash,
         intent.id,
         intent.provider_idempotency_key,
         intent.expires_at,
         intent.stripe_session_id
    INTO existing_request_hash,
         existing_intent_id,
         existing_provider_key,
         existing_expires_at,
         existing_session_id
  FROM app_private.checkout_intents AS intent
  WHERE intent.request_idempotency_key = normalized_request_key;

  IF FOUND THEN
    IF existing_request_hash <> stable_request_hash THEN
      RAISE EXCEPTION 'checkout idempotency key was reused with different input'
        USING ERRCODE = '22023';
    END IF;

    RETURN QUERY SELECT
      existing_intent_id,
      existing_provider_key,
      existing_expires_at,
      existing_session_id,
      false;
    RETURN;
  END IF;

  INSERT INTO app_private.checkout_intents AS intent (
    request_idempotency_key,
    request_hash,
    product_key,
    entitlement_version,
    through_stage,
    portal_access,
    expected_price_id,
    expected_amount_minor,
    expected_currency,
    expected_livemode,
    expires_at
  ) VALUES (
    normalized_request_key,
    stable_request_hash,
    normalized_product_key,
    p_entitlement_version,
    p_through_stage,
    p_portal_access,
    normalized_price_id,
    p_expected_amount_minor,
    normalized_currency,
    p_expected_livemode,
    created_expires_at
  )
  RETURNING intent.id, intent.provider_idempotency_key
    INTO created_intent_id, created_provider_key;

  INSERT INTO app_private.order_claim_grants (
    checkout_intent_id,
    token_hash,
    expires_at
  ) VALUES (
    created_intent_id,
    p_order_claim_hash,
    created_claim_expires_at
  );

  RETURN QUERY SELECT
    created_intent_id,
    created_provider_key,
    created_expires_at,
    NULL::text,
    true;
END
$function$;

CREATE FUNCTION app_private.bind_one_off_checkout_session(
  p_checkout_intent_id uuid,
  p_provider_idempotency_key text,
  p_stripe_session_id text
)
RETURNS TABLE (
  checkout_intent_id uuid,
  stripe_session_id text,
  bound_now boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  normalized_provider_key text := pg_catalog.btrim(p_provider_idempotency_key);
  normalized_session_id text := pg_catalog.btrim(p_stripe_session_id);
  selected_provider_key text;
  selected_session_id text;
  selected_status text;
  selected_expires_at timestamptz;
BEGIN
  IF p_checkout_intent_id IS NULL
     OR p_provider_idempotency_key IS NULL
     OR normalized_provider_key <> p_provider_idempotency_key
     OR length(normalized_provider_key) NOT BETWEEN 1 AND 255
     OR p_stripe_session_id IS NULL
     OR normalized_session_id <> p_stripe_session_id
     OR length(normalized_session_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid Checkout Session binding input' USING ERRCODE = '22023';
  END IF;

  SELECT intent.provider_idempotency_key,
         intent.stripe_session_id,
         intent.status,
         intent.expires_at
    INTO selected_provider_key,
         selected_session_id,
         selected_status,
         selected_expires_at
  FROM app_private.checkout_intents AS intent
  WHERE intent.id = p_checkout_intent_id
  FOR UPDATE;

  IF NOT FOUND OR selected_provider_key <> normalized_provider_key THEN
    RETURN;
  END IF;

  IF selected_session_id IS NOT NULL THEN
    IF selected_session_id <> normalized_session_id THEN
      RAISE EXCEPTION 'checkout intent is already bound to a different Stripe Session'
        USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT p_checkout_intent_id, selected_session_id, false;
    RETURN;
  END IF;

  IF selected_status <> 'created' OR selected_expires_at <= statement_timestamp() THEN
    RETURN;
  END IF;

  UPDATE app_private.checkout_intents AS intent
     SET stripe_session_id = normalized_session_id,
         status = 'session_created',
         updated_at = statement_timestamp()
   WHERE intent.id = p_checkout_intent_id;

  RETURN QUERY SELECT p_checkout_intent_id, normalized_session_id, true;
END
$function$;

CREATE FUNCTION app_private.record_paid_checkout_completed(
  p_event_id text,
  p_event_type text,
  p_payload_sha256 bytea,
  p_provider_created_at timestamptz,
  p_event_livemode boolean,
  p_session_livemode boolean,
  p_reported_checkout_intent_id uuid,
  p_client_reference_intent_id uuid,
  p_metadata_schema_version smallint,
  p_stripe_session_id text,
  p_session_mode text,
  p_payment_status text,
  p_price_id text,
  p_line_item_count integer,
  p_quantity integer,
  p_amount_total bigint,
  p_currency text,
  p_payment_intent_id text,
  p_stripe_customer_id text,
  p_receipt_email text
)
RETURNS TABLE (
  event_disposition text,
  order_id uuid,
  replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  normalized_event_id text := pg_catalog.btrim(p_event_id);
  normalized_event_type text := pg_catalog.btrim(p_event_type);
  normalized_session_id text := pg_catalog.btrim(p_stripe_session_id);
  normalized_mode text := pg_catalog.btrim(p_session_mode);
  normalized_payment_status text := pg_catalog.btrim(p_payment_status);
  normalized_price_id text := pg_catalog.btrim(p_price_id);
  normalized_currency text := pg_catalog.lower(pg_catalog.btrim(p_currency));
  normalized_payment_intent_id text := nullif(pg_catalog.btrim(p_payment_intent_id), '');
  normalized_customer_id text := nullif(pg_catalog.btrim(p_stripe_customer_id), '');
  normalized_receipt_email text := pg_catalog.lower(pg_catalog.btrim(p_receipt_email));
  receipt_email_is_valid boolean;
  inserted_event_count integer;
  existing_payload_sha256 bytea;
  existing_event_type text;
  existing_disposition text;
  existing_reason_code text;
  existing_event_checkout_intent_id uuid;
  existing_order_id uuid;
  existing_payment_intent_id text;
  selected_intent_id uuid;
  selected_session_id text;
  selected_status text;
  selected_expires_at timestamptz;
  selected_product_key text;
  selected_entitlement_version smallint;
  selected_through_stage text;
  selected_portal_access boolean;
  selected_price_id text;
  selected_amount_minor bigint;
  selected_currency text;
  selected_mode text;
  selected_livemode boolean;
  rejection_code text;
  created_order_id uuid;
BEGIN
  IF p_event_id IS NULL
     OR normalized_event_id <> p_event_id
     OR length(normalized_event_id) NOT BETWEEN 1 AND 255
     OR p_event_type IS NULL
     OR normalized_event_type <> p_event_type
     OR length(normalized_event_type) NOT BETWEEN 1 AND 255
     OR p_payload_sha256 IS NULL
     OR octet_length(p_payload_sha256) <> 32
     OR p_provider_created_at IS NULL
     OR p_event_livemode IS NULL
     OR p_session_livemode IS NULL
     OR p_stripe_session_id IS NULL
     OR normalized_session_id <> p_stripe_session_id
     OR length(normalized_session_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid paid Checkout event input' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_private.stripe_checkout_events (
    event_id,
    event_type,
    payload_sha256,
    provider_created_at,
    livemode,
    reported_checkout_intent_id,
    stripe_session_id
  ) VALUES (
    normalized_event_id,
    normalized_event_type,
    p_payload_sha256,
    p_provider_created_at,
    p_event_livemode,
    p_reported_checkout_intent_id,
    normalized_session_id
  )
  ON CONFLICT (event_id) DO NOTHING;

  GET DIAGNOSTICS inserted_event_count = ROW_COUNT;
  IF inserted_event_count = 0 THEN
    SELECT event.payload_sha256,
           event.event_type,
           event.disposition,
           event.reason_code,
           event.checkout_intent_id
      INTO existing_payload_sha256,
           existing_event_type,
           existing_disposition,
           existing_reason_code,
           existing_event_checkout_intent_id
    FROM app_private.stripe_checkout_events AS event
    WHERE event.event_id = normalized_event_id;

    IF NOT FOUND
       OR existing_payload_sha256 <> p_payload_sha256
       OR existing_event_type <> normalized_event_type THEN
      RAISE EXCEPTION 'Stripe event id was replayed with different signed payload bytes'
        USING ERRCODE = '22000';
    END IF;

    IF existing_disposition = 'processed' THEN
      SELECT platform_order.id
        INTO existing_order_id
      FROM app_private.platform_orders AS platform_order
      WHERE platform_order.accepted_event_id = normalized_event_id
         OR platform_order.checkout_intent_id = existing_event_checkout_intent_id;
    END IF;

    RETURN QUERY SELECT
      existing_disposition,
      existing_order_id,
      true;
    RETURN;
  END IF;

  SELECT intent.id,
         intent.stripe_session_id,
         intent.status,
         intent.expires_at,
         intent.product_key,
         intent.entitlement_version,
         intent.through_stage,
         intent.portal_access,
         intent.expected_price_id,
         intent.expected_amount_minor,
         intent.expected_currency,
         intent.expected_mode,
         intent.expected_livemode
    INTO selected_intent_id,
         selected_session_id,
         selected_status,
         selected_expires_at,
         selected_product_key,
         selected_entitlement_version,
         selected_through_stage,
         selected_portal_access,
         selected_price_id,
         selected_amount_minor,
         selected_currency,
         selected_mode,
         selected_livemode
  FROM app_private.checkout_intents AS intent
  WHERE intent.id = p_reported_checkout_intent_id
  FOR UPDATE;

  rejection_code := CASE
    WHEN normalized_event_type <> 'checkout.session.completed' THEN 'unsupported_event_type'
    WHEN p_reported_checkout_intent_id IS NULL OR selected_intent_id IS NULL THEN 'unknown_checkout_intent'
    WHEN p_provider_created_at > selected_expires_at THEN 'checkout_completed_after_expiry'
    WHEN p_metadata_schema_version IS DISTINCT FROM 1 THEN 'metadata_schema_mismatch'
    WHEN p_client_reference_intent_id IS DISTINCT FROM selected_intent_id THEN 'client_reference_mismatch'
    WHEN selected_session_id IS NULL THEN 'checkout_session_unbound'
    WHEN normalized_session_id <> selected_session_id THEN 'checkout_session_mismatch'
    WHEN selected_status NOT IN ('session_created', 'completed') THEN 'checkout_intent_state_mismatch'
    WHEN normalized_mode IS DISTINCT FROM selected_mode THEN 'checkout_mode_mismatch'
    WHEN normalized_payment_status IS DISTINCT FROM 'paid' THEN 'checkout_not_paid'
    WHEN p_event_livemode IS DISTINCT FROM selected_livemode
      OR p_session_livemode IS DISTINCT FROM selected_livemode
      OR p_event_livemode IS DISTINCT FROM p_session_livemode THEN 'checkout_livemode_mismatch'
    WHEN normalized_price_id IS DISTINCT FROM selected_price_id THEN 'checkout_price_mismatch'
    WHEN p_line_item_count IS DISTINCT FROM 1 THEN 'checkout_line_item_count_mismatch'
    WHEN p_quantity IS DISTINCT FROM 1 THEN 'checkout_quantity_mismatch'
    WHEN p_amount_total IS DISTINCT FROM selected_amount_minor THEN 'checkout_amount_mismatch'
    WHEN normalized_currency IS DISTINCT FROM selected_currency THEN 'checkout_currency_mismatch'
    WHEN normalized_payment_intent_id IS NULL THEN 'payment_intent_missing'
    WHEN length(normalized_payment_intent_id) > 255 THEN 'payment_intent_invalid'
    WHEN normalized_customer_id IS NOT NULL
      AND length(normalized_customer_id) > 255 THEN 'stripe_customer_invalid'
    WHEN EXISTS (
      SELECT 1
      FROM app_private.platform_orders AS other_order
      WHERE other_order.payment_intent_id = normalized_payment_intent_id
        AND other_order.checkout_intent_id <> selected_intent_id
    ) THEN 'payment_intent_conflict'
    ELSE NULL
  END;

  IF rejection_code IS NOT NULL THEN
    UPDATE app_private.stripe_checkout_events AS event
       SET checkout_intent_id = selected_intent_id,
           disposition = 'rejected',
           reason_code = rejection_code,
           processed_at = statement_timestamp()
     WHERE event.event_id = normalized_event_id;

    RETURN QUERY SELECT 'rejected'::text, NULL::uuid, false;
    RETURN;
  END IF;

  SELECT platform_order.id,
         platform_order.payment_intent_id
    INTO existing_order_id,
         existing_payment_intent_id
  FROM app_private.platform_orders AS platform_order
  WHERE platform_order.checkout_intent_id = selected_intent_id;

  IF existing_order_id IS NOT NULL THEN
    IF existing_payment_intent_id IS DISTINCT FROM normalized_payment_intent_id THEN
      UPDATE app_private.stripe_checkout_events AS event
         SET checkout_intent_id = selected_intent_id,
             disposition = 'rejected',
             reason_code = 'checkout_completion_conflict',
             processed_at = statement_timestamp()
       WHERE event.event_id = normalized_event_id;

      RETURN QUERY SELECT 'rejected'::text, NULL::uuid, false;
      RETURN;
    END IF;

    UPDATE app_private.stripe_checkout_events AS event
       SET checkout_intent_id = selected_intent_id,
           disposition = 'processed',
           reason_code = 'duplicate_checkout_completion',
           processed_at = statement_timestamp()
     WHERE event.event_id = normalized_event_id;

    RETURN QUERY SELECT 'processed'::text, existing_order_id, true;
    RETURN;
  END IF;

  receipt_email_is_valid := p_receipt_email IS NOT NULL
    AND length(normalized_receipt_email) BETWEEN 3 AND 320
    AND normalized_receipt_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';

  INSERT INTO app_private.platform_orders (
    checkout_intent_id,
    accepted_event_id,
    stripe_session_id,
    payment_intent_id,
    stripe_customer_id,
    product_key,
    entitlement_version,
    through_stage,
    portal_access,
    price_id,
    receipt_email,
    amount_minor,
    currency,
    fulfilment_status,
    block_reason,
    paid_at
  ) VALUES (
    selected_intent_id,
    normalized_event_id,
    normalized_session_id,
    normalized_payment_intent_id,
    normalized_customer_id,
    selected_product_key,
    selected_entitlement_version,
    selected_through_stage,
    selected_portal_access,
    selected_price_id,
    CASE WHEN receipt_email_is_valid THEN normalized_receipt_email ELSE NULL END,
    selected_amount_minor,
    selected_currency,
    CASE WHEN receipt_email_is_valid THEN 'awaiting_intake' ELSE 'blocked' END,
    CASE WHEN receipt_email_is_valid THEN NULL ELSE 'missing_or_invalid_receipt_email' END,
    p_provider_created_at
  )
  RETURNING id INTO created_order_id;

  UPDATE app_private.checkout_intents AS intent
     SET status = 'completed',
         completed_at = statement_timestamp(),
         updated_at = statement_timestamp()
   WHERE intent.id = selected_intent_id;

  UPDATE app_private.stripe_checkout_events AS event
     SET checkout_intent_id = selected_intent_id,
         disposition = 'processed',
         reason_code = CASE
           WHEN receipt_email_is_valid THEN 'paid_order_created'
           ELSE 'paid_order_blocked'
         END,
         processed_at = statement_timestamp()
   WHERE event.event_id = normalized_event_id;

  RETURN QUERY SELECT 'processed'::text, created_order_id, false;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_commerce_definer;

GRANT CREATE ON SCHEMA app_private TO r72_onboarding_definer;
SET LOCAL ROLE r72_onboarding_definer;

-- This preflight reveals the delivery destination only to a caller presenting
-- the correct high-entropy order claim. The final command rechecks every fact.
CREATE FUNCTION app_private.authorize_paid_portal_fulfilment(
  p_stripe_session_id text,
  p_order_claim_hash bytea
)
RETURNS TABLE (
  order_id uuid,
  product_key text,
  receipt_email text,
  fulfilment_status text,
  organization_id uuid,
  workspace_id uuid,
  owner_user_id uuid,
  setup_action_token_id uuid,
  setup_delivery_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT platform_order.id,
         platform_order.product_key,
         platform_order.receipt_email::text,
         platform_order.fulfilment_status,
         platform_order.organization_id,
         platform_order.workspace_id,
         platform_order.owner_user_id,
         platform_order.setup_action_token_id,
         platform_order.setup_delivery_id
  FROM app_private.checkout_intents AS intent
  JOIN app_private.platform_orders AS platform_order
    ON platform_order.checkout_intent_id = intent.id
  JOIN app_private.order_claim_grants AS claim
    ON claim.checkout_intent_id = intent.id
  WHERE intent.stripe_session_id = p_stripe_session_id
    AND p_stripe_session_id IS NOT NULL
    AND p_stripe_session_id = pg_catalog.btrim(p_stripe_session_id)
    AND length(p_stripe_session_id) BETWEEN 1 AND 128
    AND p_order_claim_hash IS NOT NULL
    AND octet_length(p_order_claim_hash) = 32
    AND claim.token_hash = p_order_claim_hash
    AND claim.purpose = 'intake'
    AND intent.status = 'completed'
    AND platform_order.financial_status = 'paid'
    AND platform_order.portal_access
    AND platform_order.receipt_email IS NOT NULL
    AND (
      (
        platform_order.fulfilment_status = 'awaiting_intake'
        AND claim.consumed_at IS NULL
        AND claim.expires_at > statement_timestamp()
      )
      OR
      (
       platform_order.fulfilment_status = 'provisioned'
       AND claim.consumed_at IS NOT NULL
       AND claim.expires_at > statement_timestamp()
      )
    )
$function$;

-- One transaction consumes the paid browser authority, invokes the already
-- proven native customer/setup-delivery primitive and links its canonical
-- result back to the commercial order. The browser never supplies owner email
-- or provisioning idempotency: both come from the locked paid order.
CREATE FUNCTION app_private.fulfil_paid_portal_checkout_with_setup_delivery(
  p_stripe_session_id text,
  p_order_claim_hash bytea,
  p_organization_name text,
  p_organization_slug text,
  p_workspace_name text,
  p_workspace_slug text,
  p_owner_display_name text,
  p_setup_token_hash bytea,
  p_recipient_email_hash bytea,
  p_timezone text,
  p_locale text,
  p_currency text,
  p_delivery_id uuid,
  p_payload_version smallint,
  p_encryption_key_id text,
  p_encryption_iv bytea,
  p_encrypted_payload bytea,
  p_authentication_tag bytea
)
RETURNS TABLE (
  organization_id uuid,
  workspace_id uuid,
  owner_user_id uuid,
  setup_action_token_id uuid,
  setup_expires_at timestamptz,
  setup_delivery_id uuid,
  setup_delivery_generation integer,
  created_now boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  normalized_session_id text := pg_catalog.btrim(p_stripe_session_id);
  selected_intent_id uuid;
  selected_intent_status text;
  selected_order_id uuid;
  selected_product_key text;
  selected_financial_status text;
  selected_fulfilment_status text;
  selected_portal_access boolean;
  selected_receipt_email text;
  existing_organization_id uuid;
  existing_workspace_id uuid;
  existing_owner_user_id uuid;
  existing_setup_action_token_id uuid;
  existing_setup_delivery_id uuid;
  existing_setup_expires_at timestamptz;
  existing_setup_delivery_generation integer;
  selected_claim_id uuid;
  selected_claim_token_hash bytea;
  selected_claim_expires_at timestamptz;
  selected_claim_consumed_at timestamptz;
  provisioned_organization_id uuid;
  provisioned_workspace_id uuid;
  provisioned_owner_user_id uuid;
  provisioned_setup_action_token_id uuid;
  provisioned_setup_expires_at timestamptz;
  provisioned_setup_delivery_id uuid;
  provisioned_setup_delivery_generation integer;
  provisioned_created_now boolean;
  affected_rows integer;
BEGIN
  IF p_stripe_session_id IS NULL
     OR normalized_session_id <> p_stripe_session_id
     OR length(normalized_session_id) NOT BETWEEN 1 AND 128
     OR p_order_claim_hash IS NULL
     OR octet_length(p_order_claim_hash) <> 32 THEN
    RETURN;
  END IF;

  -- Global lock order for commerce/onboarding commands: intent, order, claim.
  SELECT intent.id, intent.status
    INTO selected_intent_id, selected_intent_status
  FROM app_private.checkout_intents AS intent
  WHERE intent.stripe_session_id = normalized_session_id
  FOR UPDATE;

  IF selected_intent_id IS NULL OR selected_intent_status <> 'completed' THEN
    RETURN;
  END IF;

  SELECT platform_order.id,
         platform_order.product_key,
         platform_order.financial_status,
         platform_order.fulfilment_status,
         platform_order.portal_access,
         platform_order.receipt_email::text,
         platform_order.organization_id,
         platform_order.workspace_id,
         platform_order.owner_user_id,
         platform_order.setup_action_token_id,
         platform_order.setup_delivery_id
    INTO selected_order_id,
         selected_product_key,
         selected_financial_status,
         selected_fulfilment_status,
         selected_portal_access,
         selected_receipt_email,
         existing_organization_id,
         existing_workspace_id,
         existing_owner_user_id,
         existing_setup_action_token_id,
         existing_setup_delivery_id
  FROM app_private.platform_orders AS platform_order
  WHERE platform_order.checkout_intent_id = selected_intent_id
  FOR UPDATE;

  IF selected_order_id IS NULL
     OR selected_financial_status <> 'paid'
     OR NOT selected_portal_access
     OR selected_product_key NOT IN ('core', 'core_bump', 'pro')
     OR selected_receipt_email IS NULL
     OR selected_fulfilment_status NOT IN ('awaiting_intake', 'provisioned') THEN
    RETURN;
  END IF;

  SELECT claim.id,
         claim.token_hash,
         claim.expires_at,
         claim.consumed_at
    INTO selected_claim_id,
         selected_claim_token_hash,
         selected_claim_expires_at,
         selected_claim_consumed_at
  FROM app_private.order_claim_grants AS claim
  WHERE claim.checkout_intent_id = selected_intent_id
    AND claim.purpose = 'intake'
  FOR UPDATE;

  IF selected_claim_id IS NULL
     OR selected_claim_token_hash <> p_order_claim_hash
     OR (
       selected_fulfilment_status = 'awaiting_intake'
       AND (
         selected_claim_consumed_at IS NOT NULL
         OR selected_claim_expires_at <= statement_timestamp()
       )
     )
     OR (
       selected_fulfilment_status = 'provisioned'
       AND (
         selected_claim_consumed_at IS NULL
         OR selected_claim_expires_at <= statement_timestamp()
       )
     ) THEN
    RETURN;
  END IF;

  -- A committed fulfilment may lose its HTTP response. Once the claim is
  -- consumed, replay returns only the canonical linked result; it must not
  -- validate or invoke a newly prepared setup credential/delivery payload.
  IF selected_fulfilment_status = 'provisioned' THEN
    SELECT action_token.expires_at,
           delivery.generation
      INTO existing_setup_expires_at,
           existing_setup_delivery_generation
    FROM app.identity_action_tokens AS action_token
    JOIN app_private.account_setup_deliveries AS delivery
      ON delivery.id = existing_setup_delivery_id
     AND delivery.action_token_id = action_token.id
    WHERE action_token.id = existing_setup_action_token_id
      AND action_token.workspace_id = existing_workspace_id
      AND action_token.user_id = existing_owner_user_id
      AND delivery.workspace_id = existing_workspace_id
      AND delivery.user_id = existing_owner_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'paid Checkout order has no canonical setup delivery result';
    END IF;

    RETURN QUERY SELECT
      existing_organization_id,
      existing_workspace_id,
      existing_owner_user_id,
      existing_setup_action_token_id,
      existing_setup_expires_at,
      existing_setup_delivery_id,
      existing_setup_delivery_generation,
      false;
    RETURN;
  END IF;

  IF p_recipient_email_hash IS NULL
     OR octet_length(p_recipient_email_hash) <> 32
     OR p_recipient_email_hash <> public.digest(
       pg_catalog.convert_to(pg_catalog.lower(selected_receipt_email), 'UTF8'),
       'sha256'
     ) THEN
    RAISE EXCEPTION 'paid Checkout delivery recipient does not match the verified receipt email'
      USING ERRCODE = '22023';
  END IF;

  SELECT provisioned.organization_id,
         provisioned.workspace_id,
         provisioned.owner_user_id,
         provisioned.setup_action_token_id,
         provisioned.setup_expires_at,
         provisioned.setup_delivery_id,
         provisioned.setup_delivery_generation,
         provisioned.created_now
    INTO provisioned_organization_id,
         provisioned_workspace_id,
         provisioned_owner_user_id,
         provisioned_setup_action_token_id,
         provisioned_setup_expires_at,
         provisioned_setup_delivery_id,
         provisioned_setup_delivery_generation,
         provisioned_created_now
  FROM app_private.provision_customer_workspace_with_setup_delivery(
    normalized_session_id,
    p_organization_name,
    p_organization_slug,
    p_workspace_name,
    p_workspace_slug,
    selected_receipt_email,
    p_owner_display_name,
    p_setup_token_hash,
    p_recipient_email_hash,
    p_timezone,
    p_locale,
    p_currency,
    p_delivery_id,
    p_payload_version,
    p_encryption_key_id,
    p_encryption_iv,
    p_encrypted_payload,
    p_authentication_tag
  ) AS provisioned;

  IF provisioned_organization_id IS NULL
     OR provisioned_workspace_id IS NULL
     OR provisioned_owner_user_id IS NULL
     OR provisioned_setup_action_token_id IS NULL
     OR provisioned_setup_delivery_id IS NULL THEN
    RAISE EXCEPTION 'paid Checkout provisioning returned no canonical result';
  END IF;

  UPDATE app_private.order_claim_grants AS claim
     SET consumed_at = statement_timestamp()
   WHERE claim.id = selected_claim_id
     AND claim.consumed_at IS NULL
     AND claim.expires_at > statement_timestamp();

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'paid Checkout order claim could not be consumed';
  END IF;

  UPDATE app_private.platform_orders AS platform_order
     SET fulfilment_status = 'provisioned',
         organization_id = provisioned_organization_id,
         workspace_id = provisioned_workspace_id,
         owner_user_id = provisioned_owner_user_id,
         setup_action_token_id = provisioned_setup_action_token_id,
         setup_delivery_id = provisioned_setup_delivery_id,
         provisioned_at = statement_timestamp(),
         updated_at = statement_timestamp()
   WHERE platform_order.id = selected_order_id
     AND platform_order.fulfilment_status = 'awaiting_intake';

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'paid Checkout order could not be linked to provisioning';
  END IF;

  RETURN QUERY SELECT
    provisioned_organization_id,
    provisioned_workspace_id,
    provisioned_owner_user_id,
    provisioned_setup_action_token_id,
    provisioned_setup_expires_at,
    provisioned_setup_delivery_id,
    provisioned_setup_delivery_generation,
    provisioned_created_now;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_onboarding_definer;

REVOKE ALL ON FUNCTION app_private.begin_one_off_checkout(
  text, text, smallint, text, boolean, text, bigint, text, boolean, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.bind_one_off_checkout_session(
  uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_paid_checkout_completed(
  text, text, bytea, timestamptz, boolean, boolean, uuid, uuid, smallint,
  text, text, text, text, integer, integer, bigint, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.authorize_paid_portal_fulfilment(
  text, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.fulfil_paid_portal_checkout_with_setup_delivery(
  text, bytea, text, text, text, text, text, bytea, bytea, text, text, text,
  uuid, smallint, text, bytea, bytea, bytea
) FROM PUBLIC;

-- Automatic onboarding must pass through the paid-order wrapper. The inner
-- function remains available to its NOLOGIN owner for the nested call only.
REVOKE ALL ON FUNCTION app_private.provision_customer_workspace_with_setup_delivery(
  text, text, text, text, text, text, text, bytea, bytea, text, text, text,
  uuid, smallint, text, bytea, bytea, bytea
) FROM r72_provisioning_command;

GRANT EXECUTE ON FUNCTION app_private.begin_one_off_checkout(
  text, text, smallint, text, boolean, text, bigint, text, boolean, bytea
) TO r72_public;
GRANT EXECUTE ON FUNCTION app_private.bind_one_off_checkout_session(
  uuid, text, text
) TO r72_public;
GRANT EXECUTE ON FUNCTION app_private.record_paid_checkout_completed(
  text, text, bytea, timestamptz, boolean, boolean, uuid, uuid, smallint,
  text, text, text, text, integer, integer, bigint, text, text, text, text
) TO r72_webhook;
GRANT EXECUTE ON FUNCTION app_private.authorize_paid_portal_fulfilment(
  text, bytea
) TO r72_provisioning_command;
GRANT EXECUTE ON FUNCTION app_private.fulfil_paid_portal_checkout_with_setup_delivery(
  text, bytea, text, text, text, text, text, bytea, bytea, text, text, text,
  uuid, smallint, text, bytea, bytea, bytea
) TO r72_provisioning_command;
