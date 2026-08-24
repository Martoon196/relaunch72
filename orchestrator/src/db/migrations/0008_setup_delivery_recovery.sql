-- Durable, encrypted account-setup delivery and fenced setup claims.
-- Raw setup, delivery-lease and setup-claim credentials never cross into SQL:
-- PostgreSQL stores only authentication hashes and application-encrypted bytes.

DO $roles$
DECLARE
  role_name text;
  unexpected_member text;
  unexpected_parent text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'r72_onboarding_definer',
    'r72_setup_delivery_definer',
    'r72_setup_delivery_command',
    'r72_setup_reissue_command'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name
    ) THEN
      EXECUTE format('CREATE ROLE %I', role_name);
    END IF;
  END LOOP;

  ALTER ROLE r72_onboarding_definer
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ALTER ROLE r72_setup_delivery_definer
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ALTER ROLE r72_setup_delivery_command
    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ALTER ROLE r72_setup_reissue_command
    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer
    FROM r72_setup_delivery_command, r72_setup_reissue_command;
  REVOKE r72_onboarding_definer, r72_setup_delivery_definer,
    r72_setup_delivery_command, r72_setup_reissue_command
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
      r72_crm_command, r72_identity_command, r72_provisioning_command;

  -- New definer roles must have no parent. New runtime roles must have no
  -- parent and may not be granted to any runtime identity.
  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = ANY (ARRAY[
    'r72_onboarding_definer', 'r72_setup_delivery_definer',
    'r72_setup_delivery_command', 'r72_setup_reissue_command'
  ])
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe setup-delivery role membership: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = ANY (ARRAY[
    'r72_onboarding_definer', 'r72_setup_delivery_definer',
    'r72_setup_delivery_command', 'r72_setup_reissue_command'
  ])
    AND NOT (
      member.rolname = 'r72_owner'
      AND parent.rolname = ANY (ARRAY[
        'r72_onboarding_definer', 'r72_setup_delivery_definer'
      ])
    )
    AND member.rolname <> current_user
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe setup-delivery role grant: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  GRANT r72_onboarding_definer, r72_setup_delivery_definer TO r72_owner;
  EXECUTE format(
    'GRANT r72_setup_delivery_command, r72_setup_reissue_command TO %I',
    current_user
  );
END
$roles$;

SET LOCAL ROLE r72_owner;

-- Fail closed if any pre-created delivery role carried unrelated application
-- authority. Runtime identities remain function-only; the two NOLOGIN owners
-- receive only the exact privileges needed below.
REVOKE ALL ON SCHEMA app, app_private
  FROM r72_onboarding_definer, r72_setup_delivery_definer,
    r72_setup_delivery_command, r72_setup_reissue_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_onboarding_definer, r72_setup_delivery_definer,
    r72_setup_delivery_command, r72_setup_reissue_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_onboarding_definer, r72_setup_delivery_definer,
    r72_setup_delivery_command, r72_setup_reissue_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_onboarding_definer, r72_setup_delivery_definer,
    r72_setup_delivery_command, r72_setup_reissue_command;
REVOKE CREATE ON SCHEMA public
  FROM r72_onboarding_definer, r72_setup_delivery_definer,
    r72_setup_delivery_command, r72_setup_reissue_command;
GRANT USAGE ON SCHEMA app_private
  TO r72_setup_delivery_command, r72_setup_reissue_command;

CREATE TABLE app_private.account_setup_deliveries (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  action_token_id uuid NOT NULL UNIQUE
    REFERENCES app.identity_action_tokens(id) ON DELETE RESTRICT,
  generation integer NOT NULL CHECK (generation > 0),
  recipient_email_hash bytea NOT NULL CHECK (octet_length(recipient_email_hash) = 32),
  payload_version smallint NOT NULL CHECK (payload_version = 1),
  encryption_key_id text NOT NULL CHECK (
    encryption_key_id = btrim(encryption_key_id)
    AND length(encryption_key_id) BETWEEN 1 AND 100
    AND encryption_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
  ),
  encryption_iv bytea CHECK (
    encryption_iv IS NULL OR octet_length(encryption_iv) = 12
  ),
  encrypted_payload bytea CHECK (
    encrypted_payload IS NULL
    OR octet_length(encrypted_payload) BETWEEN 1 AND 16384
  ),
  authentication_tag bytea CHECK (
    authentication_tag IS NULL OR octet_length(authentication_tag) = 16
  ),
  state text NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'leased', 'retry', 'delivered', 'superseded', 'dead_letter')
  ),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token_hash bytea CHECK (
    lease_token_hash IS NULL OR octet_length(lease_token_hash) = 32
  ),
  lease_expires_at timestamptz,
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  last_error_code text CHECK (
    last_error_code IS NULL
    OR (
      length(last_error_code) BETWEEN 1 AND 100
      AND last_error_code ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'
    )
  ),
  delivered_at timestamptz,
  superseded_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, generation),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (
      state IN ('pending', 'leased', 'retry')
      AND encryption_iv IS NOT NULL
      AND encrypted_payload IS NOT NULL
      AND authentication_tag IS NOT NULL
    )
    OR
    (
      state IN ('delivered', 'superseded', 'dead_letter')
      AND encryption_iv IS NULL
      AND encrypted_payload IS NULL
      AND authentication_tag IS NULL
    )
  ),
  CHECK (
    (state = 'leased') = (lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((state = 'superseded') = (superseded_at IS NOT NULL)),
  CHECK ((state = 'dead_letter') = (dead_lettered_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE INDEX account_setup_deliveries_claim_idx
  ON app_private.account_setup_deliveries (available_at, created_at, id)
  WHERE state IN ('pending', 'leased', 'retry')
    AND superseded_at IS NULL;

CREATE TABLE app_private.account_setup_reissue_receipts (
  idempotency_key text PRIMARY KEY CHECK (
    idempotency_key = btrim(idempotency_key)
    AND length(idempotency_key) BETWEEN 1 AND 128
  ),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  action_token_id uuid NOT NULL UNIQUE
    REFERENCES app.identity_action_tokens(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL UNIQUE
    REFERENCES app_private.account_setup_deliveries(id) ON DELETE RESTRICT,
  generation integer NOT NULL CHECK (generation > 0),
  setup_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app_private.account_setup_claims (
  action_token_id uuid PRIMARY KEY
    REFERENCES app.identity_action_tokens(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  claim_hash bytea NOT NULL UNIQUE CHECK (octet_length(claim_hash) = 32),
  source_hash bytea NOT NULL CHECK (octet_length(source_hash) = 32),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at)
);

REVOKE ALL ON app_private.account_setup_deliveries,
  app_private.account_setup_reissue_receipts,
  app_private.account_setup_claims
  FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command;

-- Move provisioning ownership out of the shared login/session definer. Keep
-- only the SELECT/UPDATE rights still required by complete account setup on
-- r72_security_definer; remove its provisioning inserts and private receipt.
-- PostgreSQL requires the target function owner to have CREATE on the schema
-- before ALTER OWNER, so this grant precedes the transfer and is revoked after
-- the new onboarding functions are created.
GRANT USAGE ON SCHEMA app, app_private TO r72_onboarding_definer;
GRANT CREATE ON SCHEMA app_private TO r72_onboarding_definer;
ALTER FUNCTION app_private.provision_customer_workspace(
  text, text, text, text, text, text, text, bytea, text, text, text
) OWNER TO r72_onboarding_definer;

REVOKE INSERT ON app.organizations, app.users, app.workspaces,
  app.organization_memberships, app.workspace_memberships,
  app.identity_action_tokens, app.pipelines, app.pipeline_stages
  FROM r72_security_definer;
REVOKE ALL ON app_private.customer_provisioning_receipts FROM r72_security_definer;

ALTER POLICY organizations_security_lookup ON app.organizations
  TO r72_security_definer, r72_onboarding_definer;
ALTER POLICY users_security_lookup ON app.users
  TO r72_security_definer, r72_onboarding_definer, r72_setup_delivery_definer;
ALTER POLICY workspaces_security_lookup ON app.workspaces
  TO r72_security_definer, r72_onboarding_definer;
ALTER POLICY organization_memberships_security_lookup ON app.organization_memberships
  TO r72_security_definer, r72_onboarding_definer;
ALTER POLICY workspace_memberships_security_lookup ON app.workspace_memberships
  TO r72_security_definer, r72_onboarding_definer;

ALTER POLICY organizations_security_insert ON app.organizations
  TO r72_onboarding_definer;
ALTER POLICY users_security_insert ON app.users
  TO r72_onboarding_definer;
ALTER POLICY workspaces_security_insert ON app.workspaces
  TO r72_onboarding_definer;
ALTER POLICY organization_memberships_security_insert ON app.organization_memberships
  TO r72_onboarding_definer;
ALTER POLICY workspace_memberships_security_insert ON app.workspace_memberships
  TO r72_onboarding_definer;
ALTER POLICY identity_action_tokens_security_select ON app.identity_action_tokens
  TO r72_security_definer, r72_onboarding_definer, r72_setup_delivery_definer;
ALTER POLICY identity_action_tokens_security_insert ON app.identity_action_tokens
  TO r72_onboarding_definer;
ALTER POLICY identity_action_tokens_security_update ON app.identity_action_tokens
  TO r72_security_definer, r72_onboarding_definer;
ALTER POLICY pipelines_security_insert ON app.pipelines
  TO r72_onboarding_definer;
ALTER POLICY pipeline_stages_security_insert ON app.pipeline_stages
  TO r72_onboarding_definer;
ALTER POLICY pipelines_security_lock_select ON app.pipelines
  TO r72_security_definer, r72_onboarding_definer;
ALTER POLICY pipeline_stages_security_lock_select ON app.pipeline_stages
  TO r72_security_definer, r72_onboarding_definer;

ALTER POLICY users_security_password_update ON app.users
  TO r72_security_definer, r72_onboarding_definer;
ALTER POLICY organizations_security_lock ON app.organizations
  TO r72_security_definer, r72_onboarding_definer;
ALTER POLICY workspaces_security_lock ON app.workspaces
  TO r72_security_definer, r72_onboarding_definer;
ALTER POLICY organization_memberships_security_lock ON app.organization_memberships
  TO r72_security_definer, r72_onboarding_definer;
ALTER POLICY workspace_memberships_security_lock ON app.workspace_memberships
  TO r72_security_definer, r72_onboarding_definer;

GRANT USAGE ON SCHEMA app, app_private
  TO r72_onboarding_definer, r72_setup_delivery_definer;
GRANT SELECT, INSERT ON app.organizations, app.users, app.workspaces,
  app.organization_memberships, app.workspace_memberships,
  app.identity_action_tokens, app.pipelines, app.pipeline_stages
  TO r72_onboarding_definer;
GRANT UPDATE (updated_at) ON app.users, app.organizations, app.workspaces,
  app.organization_memberships, app.workspace_memberships
  TO r72_onboarding_definer;
GRANT UPDATE (revoked_at) ON app.identity_action_tokens
  TO r72_onboarding_definer;
GRANT SELECT, INSERT ON app_private.customer_provisioning_receipts,
  app_private.account_setup_reissue_receipts
  TO r72_onboarding_definer;
GRANT SELECT, INSERT ON app_private.account_setup_deliveries
  TO r72_onboarding_definer;
GRANT SELECT, DELETE ON app_private.account_setup_claims
  TO r72_onboarding_definer;

GRANT SELECT ON app.identity_action_tokens, app.users
  TO r72_setup_delivery_definer;
GRANT SELECT, UPDATE ON app_private.account_setup_deliveries
  TO r72_setup_delivery_definer;

GRANT SELECT, INSERT, DELETE ON app_private.account_setup_claims
  TO r72_security_definer;

GRANT CREATE ON SCHEMA app_private TO r72_onboarding_definer;
SET LOCAL ROLE r72_onboarding_definer;

CREATE FUNCTION app_private.provision_customer_workspace_with_setup_delivery(
  p_idempotency_key text,
  p_organization_name text,
  p_organization_slug text,
  p_workspace_name text,
  p_workspace_slug text,
  p_owner_email text,
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
  selected_organization_id uuid;
  selected_workspace_id uuid;
  selected_owner_user_id uuid;
  selected_action_token_id uuid;
  selected_setup_expires_at timestamptz;
  selected_created_now boolean;
  selected_delivery_id uuid;
  selected_generation integer;
BEGIN
  IF p_delivery_id IS NULL
     OR p_payload_version IS DISTINCT FROM 1
     OR p_recipient_email_hash IS NULL
     OR octet_length(p_recipient_email_hash) <> 32
     OR p_recipient_email_hash <> public.digest(
       pg_catalog.convert_to(
         pg_catalog.lower(pg_catalog.btrim(p_owner_email)),
         'UTF8'
       ),
       'sha256'
     )
     OR p_encryption_key_id IS NULL
     OR p_encryption_key_id <> pg_catalog.btrim(p_encryption_key_id)
     OR length(p_encryption_key_id) NOT BETWEEN 1 AND 100
     OR p_encryption_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
     OR p_encryption_iv IS NULL
     OR octet_length(p_encryption_iv) <> 12
     OR p_encrypted_payload IS NULL
     OR octet_length(p_encrypted_payload) NOT BETWEEN 1 AND 16384
     OR p_authentication_tag IS NULL
     OR octet_length(p_authentication_tag) <> 16 THEN
    RAISE EXCEPTION 'invalid encrypted setup delivery input' USING ERRCODE = '22023';
  END IF;

  SELECT provisioned.organization_id,
         provisioned.workspace_id,
         provisioned.owner_user_id,
         provisioned.setup_action_token_id,
         provisioned.setup_expires_at,
         provisioned.created_now
    INTO selected_organization_id,
         selected_workspace_id,
         selected_owner_user_id,
         selected_action_token_id,
         selected_setup_expires_at,
         selected_created_now
  FROM app_private.provision_customer_workspace(
    p_idempotency_key,
    p_organization_name,
    p_organization_slug,
    p_workspace_name,
    p_workspace_slug,
    p_owner_email,
    p_owner_display_name,
    p_setup_token_hash,
    p_timezone,
    p_locale,
    p_currency
  ) AS provisioned;

  IF selected_created_now THEN
    INSERT INTO app_private.account_setup_deliveries (
      id,
      user_id,
      workspace_id,
      action_token_id,
      generation,
      recipient_email_hash,
      payload_version,
      encryption_key_id,
      encryption_iv,
      encrypted_payload,
      authentication_tag
    ) VALUES (
      p_delivery_id,
      selected_owner_user_id,
      selected_workspace_id,
      selected_action_token_id,
      1,
      p_recipient_email_hash,
      p_payload_version,
      p_encryption_key_id,
      p_encryption_iv,
      p_encrypted_payload,
      p_authentication_tag
    )
    RETURNING id, generation INTO selected_delivery_id, selected_generation;
  ELSE
    -- Never return or replace caller ciphertext on a replay. The first atomic
    -- transaction's immutable delivery row is the only authoritative payload.
    SELECT delivery.id, delivery.generation
      INTO selected_delivery_id, selected_generation
    FROM app_private.account_setup_deliveries AS delivery
    WHERE delivery.action_token_id = selected_action_token_id;

    IF selected_delivery_id IS NULL THEN
      RAISE EXCEPTION 'provisioned customer has no durable setup delivery; use trusted reissue'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN QUERY SELECT
    selected_organization_id,
    selected_workspace_id,
    selected_owner_user_id,
    selected_action_token_id,
    selected_setup_expires_at,
    selected_delivery_id,
    selected_generation,
    selected_created_now;
END
$function$;

CREATE FUNCTION app_private.reissue_native_account_setup(
  p_idempotency_key text,
  p_workspace_id uuid,
  p_user_id uuid,
  p_operator_request text,
  p_setup_token_hash bytea,
  p_recipient_email_hash bytea,
  p_delivery_id uuid,
  p_payload_version smallint,
  p_encryption_key_id text,
  p_encryption_iv bytea,
  p_encrypted_payload bytea,
  p_authentication_tag bytea
)
RETURNS TABLE (
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
  normalized_idempotency_key text := pg_catalog.btrim(p_idempotency_key);
  normalized_operator_request text := pg_catalog.btrim(p_operator_request);
  stable_request_hash bytea;
  existing_request_hash bytea;
  existing_action_token_id uuid;
  existing_setup_expires_at timestamptz;
  existing_delivery_id uuid;
  existing_generation integer;
  locked_user_id uuid;
  selected_organization_id uuid;
  created_action_token_id uuid;
  created_setup_expires_at timestamptz := statement_timestamp() + interval '24 hours';
  created_generation integer;
BEGIN
  IF p_idempotency_key IS NULL
     OR normalized_idempotency_key <> p_idempotency_key
     OR length(normalized_idempotency_key) NOT BETWEEN 1 AND 128
     OR p_workspace_id IS NULL
     OR p_user_id IS NULL
     OR p_operator_request IS NULL
     OR normalized_operator_request <> p_operator_request
     OR length(normalized_operator_request) NOT BETWEEN 1 AND 200
     OR p_setup_token_hash IS NULL
     OR octet_length(p_setup_token_hash) <> 32
     OR p_recipient_email_hash IS NULL
     OR octet_length(p_recipient_email_hash) <> 32
     OR p_delivery_id IS NULL
     OR p_payload_version IS DISTINCT FROM 1
     OR p_encryption_key_id IS NULL
     OR p_encryption_key_id <> pg_catalog.btrim(p_encryption_key_id)
     OR length(p_encryption_key_id) NOT BETWEEN 1 AND 100
     OR p_encryption_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
     OR p_encryption_iv IS NULL
     OR octet_length(p_encryption_iv) <> 12
     OR p_encrypted_payload IS NULL
     OR octet_length(p_encrypted_payload) NOT BETWEEN 1 AND 16384
     OR p_authentication_tag IS NULL
     OR octet_length(p_authentication_tag) <> 16 THEN
    RAISE EXCEPTION 'invalid native account setup reissue input' USING ERRCODE = '22023';
  END IF;

  stable_request_hash := public.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        p_workspace_id,
        p_user_id,
        normalized_operator_request,
        pg_catalog.encode(p_recipient_email_hash, 'hex')
      )::text,
      'UTF8'
    ),
    'sha256'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(normalized_idempotency_key, 7200008)
  );

  SELECT receipt.request_hash,
         receipt.action_token_id,
         receipt.setup_expires_at,
         receipt.delivery_id,
         receipt.generation
    INTO existing_request_hash,
         existing_action_token_id,
         existing_setup_expires_at,
         existing_delivery_id,
         existing_generation
  FROM app_private.account_setup_reissue_receipts AS receipt
  WHERE receipt.idempotency_key = normalized_idempotency_key;

  IF FOUND THEN
    IF existing_request_hash <> stable_request_hash THEN
      RAISE EXCEPTION 'setup reissue idempotency key was reused with different input'
        USING ERRCODE = '22023';
    END IF;

    RETURN QUERY SELECT
      existing_action_token_id,
      existing_setup_expires_at,
      existing_delivery_id,
      existing_generation,
      false;
    RETURN;
  END IF;

  -- Every setup path locks in the same order: user, action token(s), then
  -- setup claim. This serializes reissue against setup completion.
  SELECT person.id
    INTO locked_user_id
  FROM app.users AS person
  WHERE person.id = p_user_id
    AND person.status = 'pending'
    AND person.password_hash IS NULL
    AND public.digest(
      pg_catalog.convert_to(pg_catalog.lower(person.email::text), 'UTF8'),
      'sha256'
    ) = p_recipient_email_hash
  FOR UPDATE;

  IF locked_user_id IS NULL THEN
    RAISE EXCEPTION 'native account setup reissue target is not pending and active'
      USING ERRCODE = '22023';
  END IF;

  -- Lock lifecycle rows one at a time in a deterministic order. Setup
  -- completion uses this exact user -> lifecycle -> token -> claim order.
  SELECT workspace_membership.organization_id
    INTO selected_organization_id
  FROM app.workspace_memberships AS workspace_membership
  WHERE workspace_membership.user_id = locked_user_id
    AND workspace_membership.workspace_id = p_workspace_id
    AND workspace_membership.status = 'active'
    AND workspace_membership.role = 'owner'
  FOR UPDATE;

  IF selected_organization_id IS NULL THEN
    RAISE EXCEPTION 'native account setup reissue target is not pending and active'
      USING ERRCODE = '22023';
  END IF;

  PERFORM workspace.id
  FROM app.workspaces AS workspace
  WHERE workspace.id = p_workspace_id
    AND workspace.organization_id = selected_organization_id
    AND workspace.status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'native account setup reissue target is not pending and active'
      USING ERRCODE = '22023';
  END IF;

  PERFORM organization.id
  FROM app.organizations AS organization
  WHERE organization.id = selected_organization_id
    AND organization.status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'native account setup reissue target is not pending and active'
      USING ERRCODE = '22023';
  END IF;

  PERFORM organization_membership.organization_id
  FROM app.organization_memberships AS organization_membership
  WHERE organization_membership.organization_id = selected_organization_id
    AND organization_membership.user_id = locked_user_id
    AND organization_membership.status = 'active'
    AND organization_membership.role = 'owner'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'native account setup reissue target is not pending and active'
      USING ERRCODE = '22023';
  END IF;

  PERFORM action_token.id
  FROM app.identity_action_tokens AS action_token
  WHERE action_token.user_id = locked_user_id
    AND action_token.purpose = 'account_setup'
  ORDER BY action_token.created_at, action_token.id
  FOR UPDATE;

  DELETE FROM app_private.account_setup_claims AS claim
  WHERE claim.user_id = locked_user_id;

  UPDATE app.identity_action_tokens AS action_token
     SET revoked_at = statement_timestamp()
   WHERE action_token.user_id = locked_user_id
     AND action_token.purpose = 'account_setup'
     AND action_token.consumed_at IS NULL
     AND action_token.revoked_at IS NULL;

  SELECT coalesce(pg_catalog.max(delivery.generation), 0) + 1
    INTO created_generation
  FROM app_private.account_setup_deliveries AS delivery
  WHERE delivery.user_id = locked_user_id;

  INSERT INTO app.identity_action_tokens (
    user_id,
    workspace_id,
    purpose,
    token_hash,
    expires_at,
    request_id
  ) VALUES (
    locked_user_id,
    p_workspace_id,
    'account_setup',
    p_setup_token_hash,
    created_setup_expires_at,
    normalized_idempotency_key
  )
  RETURNING id INTO created_action_token_id;

  INSERT INTO app_private.account_setup_deliveries (
    id,
    user_id,
    workspace_id,
    action_token_id,
    generation,
    recipient_email_hash,
    payload_version,
    encryption_key_id,
    encryption_iv,
    encrypted_payload,
    authentication_tag
  ) VALUES (
    p_delivery_id,
    locked_user_id,
    p_workspace_id,
    created_action_token_id,
    created_generation,
    p_recipient_email_hash,
    p_payload_version,
    p_encryption_key_id,
    p_encryption_iv,
    p_encrypted_payload,
    p_authentication_tag
  );

  INSERT INTO app_private.account_setup_reissue_receipts (
    idempotency_key,
    request_hash,
    workspace_id,
    user_id,
    action_token_id,
    delivery_id,
    generation,
    setup_expires_at
  ) VALUES (
    normalized_idempotency_key,
    stable_request_hash,
    p_workspace_id,
    locked_user_id,
    created_action_token_id,
    p_delivery_id,
    created_generation,
    created_setup_expires_at
  );

  RETURN QUERY SELECT
    created_action_token_id,
    created_setup_expires_at,
    p_delivery_id,
    created_generation,
    true;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_onboarding_definer;

GRANT CREATE ON SCHEMA app_private TO r72_setup_delivery_definer;
SET LOCAL ROLE r72_setup_delivery_definer;

CREATE FUNCTION app_private.redact_terminal_account_setup_delivery()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP <> 'UPDATE'
     OR TG_TABLE_SCHEMA <> 'app'
     OR TG_TABLE_NAME <> 'identity_action_tokens' THEN
    RAISE EXCEPTION 'setup delivery redaction trigger has an invalid binding'
      USING ERRCODE = '55000';
  END IF;

  IF (NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL)
     AND OLD.consumed_at IS NULL
     AND OLD.revoked_at IS NULL THEN
    -- Delivered and dead-letter rows are already secret-free terminal facts.
    -- Only live work is superseded; this preserves the exact
    -- state='superseded' iff superseded_at IS NOT NULL invariant.
    UPDATE app_private.account_setup_deliveries AS delivery
       SET state = 'superseded',
           encryption_iv = NULL,
           encrypted_payload = NULL,
           authentication_tag = NULL,
           lease_token_hash = NULL,
           lease_expires_at = NULL,
           superseded_at = statement_timestamp(),
           updated_at = statement_timestamp()
     WHERE delivery.action_token_id = NEW.id
       AND delivery.state IN ('pending', 'leased', 'retry')
       AND delivery.superseded_at IS NULL;
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION app_private.required_account_setup_delivery_key_ids()
RETURNS TABLE (encryption_key_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT DISTINCT delivery.encryption_key_id
  FROM app_private.account_setup_deliveries AS delivery
  JOIN app.identity_action_tokens AS action_token
    ON action_token.id = delivery.action_token_id
   AND action_token.user_id = delivery.user_id
   AND action_token.workspace_id = delivery.workspace_id
  JOIN app.users AS person ON person.id = delivery.user_id
  WHERE delivery.state IN ('pending', 'leased', 'retry')
    AND delivery.superseded_at IS NULL
    AND delivery.encrypted_payload IS NOT NULL
    AND action_token.purpose = 'account_setup'
    AND action_token.consumed_at IS NULL
    AND action_token.revoked_at IS NULL
    AND action_token.expires_at > statement_timestamp()
    AND person.status = 'pending'
    AND person.password_hash IS NULL
  ORDER BY delivery.encryption_key_id
$function$;

CREATE FUNCTION app_private.claim_account_setup_deliveries(
  p_lease_token_hash bytea,
  p_batch_size integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  delivery_id uuid,
  user_id uuid,
  workspace_id uuid,
  action_token_id uuid,
  payload_version smallint,
  encryption_key_id text,
  encryption_iv bytea,
  encrypted_payload bytea,
  authentication_tag bytea,
  recipient_email_hash bytea,
  aad_context bytea,
  attempt_count smallint,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_lease_token_hash IS NULL
     OR octet_length(p_lease_token_hash) <> 32
     OR p_batch_size IS NULL
     OR p_batch_size NOT BETWEEN 1 AND 25
     OR p_lease_seconds IS NULL
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'invalid setup delivery claim input' USING ERRCODE = '22023';
  END IF;

  -- Terminalize exhausted or expired work before selecting a claim. The
  -- encrypted secret is erased when it can no longer be delivered.
  WITH terminal_candidates AS (
    SELECT delivery.id
    FROM app_private.account_setup_deliveries AS delivery
    WHERE delivery.state IN ('pending', 'leased', 'retry')
      AND delivery.superseded_at IS NULL
      AND (
        (delivery.state = 'leased'
          AND delivery.lease_expires_at <= statement_timestamp()
          AND delivery.attempt_count >= 8)
        OR NOT EXISTS (
          SELECT 1
          FROM app.identity_action_tokens AS action_token
          JOIN app.users AS person ON person.id = action_token.user_id
          WHERE action_token.id = delivery.action_token_id
            AND action_token.user_id = delivery.user_id
            AND action_token.workspace_id = delivery.workspace_id
            AND action_token.purpose = 'account_setup'
            AND action_token.consumed_at IS NULL
            AND action_token.revoked_at IS NULL
            AND action_token.expires_at > statement_timestamp()
            AND person.status = 'pending'
            AND person.password_hash IS NULL
        )
      )
    ORDER BY delivery.updated_at, delivery.id
    FOR UPDATE OF delivery SKIP LOCKED
    LIMIT 25
  )
  UPDATE app_private.account_setup_deliveries AS delivery
     SET state = 'dead_letter',
         encryption_iv = NULL,
         encrypted_payload = NULL,
         authentication_tag = NULL,
         lease_token_hash = NULL,
         lease_expires_at = NULL,
         last_error_code = CASE
           WHEN delivery.attempt_count >= 8 THEN 'retry_limit_exhausted'
           ELSE 'setup_token_expired'
         END,
         dead_lettered_at = statement_timestamp(),
         updated_at = statement_timestamp()
    FROM terminal_candidates
   WHERE delivery.id = terminal_candidates.id;

  RETURN QUERY
  WITH candidates AS (
    SELECT delivery.id
    FROM app_private.account_setup_deliveries AS delivery
    JOIN app.identity_action_tokens AS action_token
      ON action_token.id = delivery.action_token_id
     AND action_token.user_id = delivery.user_id
     AND action_token.workspace_id = delivery.workspace_id
    JOIN app.users AS person ON person.id = delivery.user_id
    WHERE delivery.superseded_at IS NULL
      AND delivery.encrypted_payload IS NOT NULL
      AND delivery.attempt_count < 8
      AND (
        (delivery.state IN ('pending', 'retry')
          AND delivery.available_at <= statement_timestamp())
        OR
        (delivery.state = 'leased'
          AND delivery.lease_expires_at <= statement_timestamp())
      )
      AND action_token.purpose = 'account_setup'
      AND action_token.consumed_at IS NULL
      AND action_token.revoked_at IS NULL
      AND action_token.expires_at > statement_timestamp()
      AND person.status = 'pending'
      AND person.password_hash IS NULL
    ORDER BY delivery.available_at, delivery.created_at, delivery.id
    FOR UPDATE OF delivery SKIP LOCKED
    LIMIT p_batch_size
  ), claimed AS (
    UPDATE app_private.account_setup_deliveries AS delivery
       SET state = 'leased',
           lease_token_hash = p_lease_token_hash,
           lease_expires_at = statement_timestamp()
             + pg_catalog.make_interval(secs => p_lease_seconds),
           attempt_count = delivery.attempt_count + 1,
           last_error_code = NULL,
           updated_at = statement_timestamp()
      FROM candidates
     WHERE delivery.id = candidates.id
    RETURNING delivery.*
  )
  SELECT claimed.id,
         claimed.user_id,
         claimed.workspace_id,
         claimed.action_token_id,
         claimed.payload_version,
         claimed.encryption_key_id,
         claimed.encryption_iv,
         claimed.encrypted_payload,
         claimed.authentication_tag,
         claimed.recipient_email_hash,
         pg_catalog.convert_to('r72/setup-link/v1', 'UTF8')
           || pg_catalog.decode('00', 'hex')
           || pg_catalog.convert_to(pg_catalog.lower(claimed.id::text), 'UTF8'),
         claimed.attempt_count,
         claimed.lease_expires_at
  FROM claimed
  ORDER BY claimed.created_at, claimed.id;
END
$function$;

CREATE FUNCTION app_private.renew_account_setup_delivery_lease(
  p_delivery_id uuid,
  p_lease_token_hash bytea,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (lease_expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_delivery_id IS NULL
     OR p_lease_token_hash IS NULL
     OR octet_length(p_lease_token_hash) <> 32
     OR p_lease_seconds IS NULL
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE app_private.account_setup_deliveries AS delivery
     SET lease_expires_at = pg_catalog.least(
           statement_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
           action_token.expires_at
         ),
         updated_at = statement_timestamp()
    FROM app.identity_action_tokens AS action_token
   WHERE delivery.id = p_delivery_id
     AND delivery.action_token_id = action_token.id
     AND delivery.state = 'leased'
     AND delivery.superseded_at IS NULL
     AND delivery.lease_token_hash = p_lease_token_hash
     AND delivery.lease_expires_at > statement_timestamp()
     AND action_token.consumed_at IS NULL
     AND action_token.revoked_at IS NULL
     AND action_token.expires_at > statement_timestamp()
  RETURNING delivery.lease_expires_at;
END
$function$;

CREATE FUNCTION app_private.acknowledge_account_setup_delivery(
  p_delivery_id uuid,
  p_lease_token_hash bytea
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  affected_rows integer;
BEGIN
  IF p_delivery_id IS NULL
     OR p_lease_token_hash IS NULL
     OR octet_length(p_lease_token_hash) <> 32 THEN
    RETURN false;
  END IF;

  UPDATE app_private.account_setup_deliveries AS delivery
     SET state = 'delivered',
         encryption_iv = NULL,
         encrypted_payload = NULL,
         authentication_tag = NULL,
         lease_token_hash = NULL,
         lease_expires_at = NULL,
         delivered_at = statement_timestamp(),
         updated_at = statement_timestamp()
   WHERE delivery.id = p_delivery_id
     AND delivery.state = 'leased'
     AND delivery.superseded_at IS NULL
     AND delivery.lease_token_hash = p_lease_token_hash
     AND delivery.lease_expires_at > statement_timestamp();

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows = 1;
END
$function$;

CREATE FUNCTION app_private.fail_account_setup_delivery(
  p_delivery_id uuid,
  p_lease_token_hash bytea,
  p_error_code text,
  p_retry_at timestamptz
)
RETURNS TABLE (delivery_state text, available_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  normalized_error_code text := pg_catalog.btrim(p_error_code);
BEGIN
  IF p_delivery_id IS NULL
     OR p_lease_token_hash IS NULL
     OR octet_length(p_lease_token_hash) <> 32
     OR p_error_code IS NULL
     OR normalized_error_code <> p_error_code
     OR length(normalized_error_code) NOT BETWEEN 1 AND 100
     OR normalized_error_code !~ '^[a-z0-9][a-z0-9._:-]{0,99}$'
     OR p_retry_at IS NULL
     OR p_retry_at < statement_timestamp()
     OR p_retry_at > statement_timestamp() + interval '24 hours' THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE app_private.account_setup_deliveries AS delivery
     SET state = CASE
           WHEN delivery.attempt_count >= 8
             OR p_retry_at >= action_token.expires_at
           THEN 'dead_letter'
           ELSE 'retry'
         END,
         encryption_iv = CASE
           WHEN delivery.attempt_count >= 8
             OR p_retry_at >= action_token.expires_at
           THEN NULL
           ELSE delivery.encryption_iv
         END,
         encrypted_payload = CASE
           WHEN delivery.attempt_count >= 8
             OR p_retry_at >= action_token.expires_at
           THEN NULL
           ELSE delivery.encrypted_payload
         END,
         authentication_tag = CASE
           WHEN delivery.attempt_count >= 8
             OR p_retry_at >= action_token.expires_at
           THEN NULL
           ELSE delivery.authentication_tag
         END,
         available_at = p_retry_at,
         lease_token_hash = NULL,
         lease_expires_at = NULL,
         last_error_code = normalized_error_code,
         dead_lettered_at = CASE
           WHEN delivery.attempt_count >= 8
             OR p_retry_at >= action_token.expires_at
           THEN statement_timestamp()
           ELSE NULL
         END,
         updated_at = statement_timestamp()
    FROM app.identity_action_tokens AS action_token
   WHERE delivery.id = p_delivery_id
     AND delivery.action_token_id = action_token.id
     AND delivery.state = 'leased'
     AND delivery.superseded_at IS NULL
     AND delivery.lease_token_hash = p_lease_token_hash
     AND delivery.lease_expires_at > statement_timestamp()
  RETURNING delivery.state, delivery.available_at;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_setup_delivery_definer;

DROP TRIGGER IF EXISTS identity_action_tokens_redact_setup_delivery
  ON app.identity_action_tokens;
CREATE TRIGGER identity_action_tokens_redact_setup_delivery
AFTER UPDATE OF consumed_at, revoked_at ON app.identity_action_tokens
FOR EACH ROW
EXECUTE FUNCTION app_private.redact_terminal_account_setup_delivery();

-- Replace the unfenced setup command. A cheap indexed token reservation must
-- succeed before the application performs expensive scrypt work.
REVOKE ALL ON FUNCTION app_private.complete_native_account_setup(
  bytea, text, bytea, bytea, bytea, bytea
) FROM PUBLIC, r72_identity_command;
DROP FUNCTION app_private.complete_native_account_setup(
  bytea, text, bytea, bytea, bytea, bytea
);

GRANT CREATE ON SCHEMA app_private TO r72_security_definer;
SET LOCAL ROLE r72_security_definer;

CREATE FUNCTION app_private.reserve_native_account_setup(
  p_setup_token_hash bytea,
  p_claim_hash bytea,
  p_source_hash bytea
)
RETURNS TABLE (claim_expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  candidate_user_id uuid;
  locked_user_id uuid;
  locked_action_token_id uuid;
  created_claim_expires_at timestamptz := statement_timestamp() + interval '2 minutes';
BEGIN
  IF p_setup_token_hash IS NULL
     OR octet_length(p_setup_token_hash) <> 32
     OR p_claim_hash IS NULL
     OR octet_length(p_claim_hash) <> 32
     OR p_source_hash IS NULL
     OR octet_length(p_source_hash) <> 32
     OR p_setup_token_hash = p_claim_hash
     OR p_setup_token_hash = p_source_hash
     OR p_claim_hash = p_source_hash THEN
    RETURN;
  END IF;

  -- Cheap, indexed hash lookup. Invalid random tokens stop here before scrypt.
  SELECT action_token.user_id
    INTO candidate_user_id
  FROM app.identity_action_tokens AS action_token
  WHERE action_token.token_hash = p_setup_token_hash
    AND action_token.purpose = 'account_setup';

  IF candidate_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT person.id
    INTO locked_user_id
  FROM app.users AS person
  WHERE person.id = candidate_user_id
    AND person.status = 'pending'
    AND person.password_hash IS NULL
  FOR UPDATE;

  IF locked_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT action_token.id
    INTO locked_action_token_id
  FROM app.identity_action_tokens AS action_token
  WHERE action_token.token_hash = p_setup_token_hash
    AND action_token.user_id = locked_user_id
    AND action_token.purpose = 'account_setup'
    AND action_token.consumed_at IS NULL
    AND action_token.revoked_at IS NULL
    AND action_token.expires_at > statement_timestamp()
  FOR UPDATE;

  IF locked_action_token_id IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM app_private.account_setup_claims AS claim
  WHERE claim.action_token_id = locked_action_token_id
    AND claim.expires_at <= statement_timestamp();

  IF EXISTS (
    SELECT 1
    FROM app_private.account_setup_claims AS claim
    WHERE claim.action_token_id = locked_action_token_id
      AND claim.expires_at > statement_timestamp()
  ) THEN
    RETURN;
  END IF;

  INSERT INTO app_private.account_setup_claims (
    action_token_id,
    user_id,
    claim_hash,
    source_hash,
    expires_at
  ) VALUES (
    locked_action_token_id,
    locked_user_id,
    p_claim_hash,
    p_source_hash,
    created_claim_expires_at
  );

  RETURN QUERY SELECT created_claim_expires_at;
END
$function$;

CREATE FUNCTION app_private.release_native_account_setup_claim(
  p_setup_token_hash bytea,
  p_claim_hash bytea,
  p_source_hash bytea
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  candidate_user_id uuid;
  locked_user_id uuid;
  affected_rows integer;
BEGIN
  IF p_setup_token_hash IS NULL
     OR octet_length(p_setup_token_hash) <> 32
     OR p_claim_hash IS NULL
     OR octet_length(p_claim_hash) <> 32
     OR p_source_hash IS NULL
     OR octet_length(p_source_hash) <> 32 THEN
    RETURN false;
  END IF;

  SELECT action_token.user_id
    INTO candidate_user_id
  FROM app.identity_action_tokens AS action_token
  WHERE action_token.token_hash = p_setup_token_hash
    AND action_token.purpose = 'account_setup';

  IF candidate_user_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT person.id
    INTO locked_user_id
  FROM app.users AS person
  WHERE person.id = candidate_user_id
  FOR UPDATE;

  DELETE FROM app_private.account_setup_claims AS claim
  USING app.identity_action_tokens AS action_token
  WHERE action_token.id = claim.action_token_id
    AND action_token.token_hash = p_setup_token_hash
    AND action_token.user_id = locked_user_id
    AND claim.claim_hash = p_claim_hash
    AND claim.source_hash = p_source_hash;

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows = 1;
END
$function$;

CREATE FUNCTION app_private.complete_native_account_setup(
  p_setup_token_hash bytea,
  p_setup_claim_hash bytea,
  p_source_hash bytea,
  p_password_hash text,
  p_session_token_hash bytea,
  p_csrf_secret_hash bytea,
  p_ip_hash bytea DEFAULT NULL,
  p_user_agent_hash bytea DEFAULT NULL
)
RETURNS TABLE (
  session_id uuid,
  user_id uuid,
  user_email text,
  selected_workspace_id uuid,
  expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  candidate_user_id uuid;
  candidate_workspace_id uuid;
  locked_user_id uuid;
  selected_organization_id uuid;
  selected_action_token_id uuid;
  selected_user_email text;
  selected_setup_workspace_id uuid;
  selected_claim_action_token_id uuid;
  created_session_id uuid;
  selected_expires_at timestamptz := statement_timestamp() + interval '14 days';
BEGIN
  IF p_setup_token_hash IS NULL
     OR octet_length(p_setup_token_hash) <> 32
     OR p_setup_claim_hash IS NULL
     OR octet_length(p_setup_claim_hash) <> 32
     OR p_source_hash IS NULL
     OR octet_length(p_source_hash) <> 32
     OR p_setup_token_hash = p_setup_claim_hash
     OR p_setup_token_hash = p_source_hash
     OR p_setup_claim_hash = p_source_hash
     OR p_password_hash IS NULL
     OR p_password_hash !~ '^scrypt\$v1\$16384,8,1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$'
     OR p_session_token_hash IS NULL
     OR octet_length(p_session_token_hash) <> 32
     OR p_csrf_secret_hash IS NULL
     OR octet_length(p_csrf_secret_hash) <> 32
     OR p_session_token_hash = p_setup_token_hash
     OR p_csrf_secret_hash = p_setup_token_hash
     OR p_csrf_secret_hash = p_session_token_hash
     OR (p_ip_hash IS NOT NULL AND octet_length(p_ip_hash) <> 32)
     OR (p_user_agent_hash IS NOT NULL AND octet_length(p_user_agent_hash) <> 32) THEN
    RETURN;
  END IF;

  SELECT action_token.user_id, action_token.workspace_id
    INTO candidate_user_id, candidate_workspace_id
  FROM app.identity_action_tokens AS action_token
  WHERE action_token.token_hash = p_setup_token_hash
    AND action_token.purpose = 'account_setup';

  IF candidate_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT person.id, person.email::text
    INTO locked_user_id, selected_user_email
  FROM app.users AS person
  WHERE person.id = candidate_user_id
    AND person.status = 'pending'
    AND person.password_hash IS NULL
  FOR UPDATE;

  IF locked_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT membership.organization_id
    INTO selected_organization_id
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = candidate_workspace_id
    AND membership.user_id = locked_user_id
    AND membership.status = 'active'
    AND membership.role = 'owner'
  FOR UPDATE;
  IF selected_organization_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM workspace.id
  FROM app.workspaces AS workspace
  WHERE workspace.id = candidate_workspace_id
    AND workspace.organization_id = selected_organization_id
    AND workspace.status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM organization.id
  FROM app.organizations AS organization
  WHERE organization.id = selected_organization_id
    AND organization.status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM organization_membership.organization_id
  FROM app.organization_memberships AS organization_membership
  WHERE organization_membership.organization_id = selected_organization_id
    AND organization_membership.user_id = locked_user_id
    AND organization_membership.status = 'active'
    AND organization_membership.role = 'owner'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT action_token.id, action_token.workspace_id
    INTO selected_action_token_id, selected_setup_workspace_id
  FROM app.identity_action_tokens AS action_token
  WHERE action_token.token_hash = p_setup_token_hash
    AND action_token.user_id = locked_user_id
    AND action_token.workspace_id = candidate_workspace_id
    AND action_token.purpose = 'account_setup'
    AND action_token.consumed_at IS NULL
    AND action_token.revoked_at IS NULL
    AND action_token.expires_at > statement_timestamp()
  FOR UPDATE;

  IF selected_action_token_id IS NULL THEN
    RETURN;
  END IF;

  SELECT claim.action_token_id
    INTO selected_claim_action_token_id
  FROM app_private.account_setup_claims AS claim
  WHERE claim.action_token_id = selected_action_token_id
    AND claim.claim_hash = p_setup_claim_hash
    AND claim.source_hash = p_source_hash
    AND claim.expires_at > statement_timestamp()
  FOR UPDATE;

  IF selected_claim_action_token_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE app.users AS person
     SET password_hash = p_password_hash,
         email_verified_at = statement_timestamp(),
         status = 'active',
         row_version = person.row_version + 1,
         updated_at = statement_timestamp()
   WHERE person.id = locked_user_id;

  UPDATE app.identity_action_tokens AS action_token
     SET consumed_at = statement_timestamp()
   WHERE action_token.id = selected_action_token_id;

  UPDATE app.identity_action_tokens AS peer_token
     SET revoked_at = statement_timestamp()
   WHERE peer_token.user_id = locked_user_id
     AND peer_token.purpose = 'account_setup'
     AND peer_token.id <> selected_action_token_id
     AND peer_token.consumed_at IS NULL
     AND peer_token.revoked_at IS NULL;

  DELETE FROM app_private.account_setup_claims AS claim
  WHERE claim.user_id = locked_user_id;

  INSERT INTO app.user_sessions (
    token_hash,
    csrf_secret_hash,
    user_id,
    selected_workspace_id,
    expires_at,
    ip_hash,
    user_agent_hash
  ) VALUES (
    p_session_token_hash,
    p_csrf_secret_hash,
    locked_user_id,
    selected_setup_workspace_id,
    selected_expires_at,
    p_ip_hash,
    p_user_agent_hash
  )
  RETURNING id INTO created_session_id;

  RETURN QUERY SELECT
    created_session_id,
    locked_user_id,
    selected_user_email,
    selected_setup_workspace_id,
    selected_expires_at;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;

REVOKE ALL ON FUNCTION app_private.provision_customer_workspace(
  text, text, text, text, text, text, text, bytea, text, text, text
) FROM r72_provisioning_command;

REVOKE ALL ON FUNCTION app_private.provision_customer_workspace_with_setup_delivery(
  text, text, text, text, text, text, text, bytea, bytea, text, text, text,
  uuid, smallint, text, bytea, bytea, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reissue_native_account_setup(
  text, uuid, uuid, text, bytea, bytea, uuid, smallint, text, bytea, bytea, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.claim_account_setup_deliveries(
  bytea, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.required_account_setup_delivery_key_ids()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.redact_terminal_account_setup_delivery()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.renew_account_setup_delivery_lease(
  uuid, bytea, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.acknowledge_account_setup_delivery(
  uuid, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.fail_account_setup_delivery(
  uuid, bytea, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reserve_native_account_setup(
  bytea, bytea, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.release_native_account_setup_claim(
  bytea, bytea, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.complete_native_account_setup(
  bytea, bytea, bytea, text, bytea, bytea, bytea, bytea
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.provision_customer_workspace_with_setup_delivery(
  text, text, text, text, text, text, text, bytea, bytea, text, text, text,
  uuid, smallint, text, bytea, bytea, bytea
) TO r72_provisioning_command;
GRANT EXECUTE ON FUNCTION app_private.reissue_native_account_setup(
  text, uuid, uuid, text, bytea, bytea, uuid, smallint, text, bytea, bytea, bytea
) TO r72_setup_reissue_command;
GRANT EXECUTE ON FUNCTION app_private.claim_account_setup_deliveries(
  bytea, integer, integer
) TO r72_setup_delivery_command;
GRANT EXECUTE ON FUNCTION app_private.required_account_setup_delivery_key_ids()
  TO r72_setup_delivery_command;
GRANT EXECUTE ON FUNCTION app_private.renew_account_setup_delivery_lease(
  uuid, bytea, integer
) TO r72_setup_delivery_command;
GRANT EXECUTE ON FUNCTION app_private.acknowledge_account_setup_delivery(
  uuid, bytea
) TO r72_setup_delivery_command;
GRANT EXECUTE ON FUNCTION app_private.fail_account_setup_delivery(
  uuid, bytea, text, timestamptz
) TO r72_setup_delivery_command;
GRANT EXECUTE ON FUNCTION app_private.reserve_native_account_setup(
  bytea, bytea, bytea
) TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.release_native_account_setup_claim(
  bytea, bytea, bytea
) TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.complete_native_account_setup(
  bytea, bytea, bytea, text, bytea, bytea, bytea, bytea
) TO r72_identity_command;
