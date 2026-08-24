-- Atomic native customer provisioning and one-use account setup. The
-- provisioning runtime is function-only; browser-facing identity code can
-- consume a setup credential but cannot create organizations or workspaces.

DO $roles$
DECLARE
  unexpected_parent text;
  unexpected_member text;
  privileged_parent text;
  privileged_member text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_provisioning_command'
  ) THEN
    CREATE ROLE r72_provisioning_command;
  END IF;

  ALTER ROLE r72_provisioning_command
    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

  REVOKE r72_owner, r72_security_definer FROM r72_provisioning_command;
  REVOKE r72_provisioning_command
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
      r72_crm_command, r72_identity_command;

  SELECT parent.rolname
    INTO unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_provisioning_command'
  LIMIT 1;

  IF unexpected_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe provisioning role membership: r72_provisioning_command can SET ROLE %',
      unexpected_parent;
  END IF;

  SELECT member.rolname
    INTO unexpected_member
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_provisioning_command'
    AND member.rolname <> current_user
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe provisioning role grant: % can SET ROLE r72_provisioning_command',
      unexpected_member;
  END IF;

  -- Provisioning expands the non-login definer's table authority. Re-audit
  -- both privileged membership directions before applying those grants.
  SELECT member.rolname, parent.rolname
    INTO privileged_member, privileged_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE (member.rolname = 'r72_owner' AND parent.rolname <> 'r72_security_definer')
     OR member.rolname = 'r72_security_definer'
  LIMIT 1;

  IF privileged_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe privileged role membership: % can SET ROLE %',
      privileged_member, privileged_parent;
  END IF;

  SELECT member.rolname, parent.rolname
    INTO privileged_member, privileged_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE (parent.rolname = 'r72_owner' AND member.rolname <> current_user)
     OR (parent.rolname = 'r72_security_definer' AND member.rolname <> 'r72_owner')
  LIMIT 1;

  IF privileged_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe privileged role grant: % can SET ROLE %',
      privileged_member, privileged_parent;
  END IF;

  -- The migration identity may SET LOCAL ROLE for exact integration tests.
  EXECUTE format('GRANT r72_provisioning_command TO %I', current_user);
END
$roles$;

SET LOCAL ROLE r72_owner;

-- Fail closed if a pre-created runtime role carried unrelated application
-- privileges. Its only authority is the provisioning function granted below.
REVOKE ALL ON SCHEMA app, app_private FROM r72_provisioning_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_provisioning_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_provisioning_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_provisioning_command;
GRANT USAGE ON SCHEMA app_private TO r72_provisioning_command;

-- An account-setup credential is valid for one exact workspace membership.
-- Other token purposes remain allowed to omit a workspace.
ALTER TABLE app.identity_action_tokens
  ADD COLUMN workspace_id uuid;
ALTER TABLE app.identity_action_tokens
  ADD CONSTRAINT identity_action_tokens_workspace_user_fk
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE CASCADE;
ALTER TABLE app.identity_action_tokens
  ADD CONSTRAINT identity_action_tokens_setup_workspace_ck
  CHECK (purpose <> 'account_setup' OR workspace_id IS NOT NULL);

CREATE INDEX identity_action_tokens_workspace_active_idx
  ON app.identity_action_tokens (workspace_id, user_id, purpose, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX identity_action_tokens_one_active_setup_uq
  ON app.identity_action_tokens (user_id)
  WHERE purpose = 'account_setup'
    AND consumed_at IS NULL
    AND revoked_at IS NULL;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES ('app', 'identity_action_tokens', 'workspace_id');

-- This private receipt is both the concurrency boundary and the durable answer
-- for a retried payment/order event. It deliberately stores no raw credential.
CREATE TABLE app_private.customer_provisioning_receipts (
  idempotency_key text PRIMARY KEY
    CHECK (idempotency_key = btrim(idempotency_key) AND length(idempotency_key) BETWEEN 1 AND 128),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  organization_id uuid NOT NULL UNIQUE REFERENCES app.organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL UNIQUE REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  -- Retain the issued UUID for audit without blocking routine expired-token
  -- deletion. The receipt is not a credential-verification source.
  setup_token_id uuid NOT NULL UNIQUE,
  setup_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON app_private.customer_provisioning_receipts FROM PUBLIC;
REVOKE ALL ON app_private.customer_provisioning_receipts
  FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command;

-- The non-login function owner gets only the table operations used below.
-- FORCE RLS remains in force on every app table, with explicit policies.
GRANT SELECT, INSERT ON app.organizations, app.users, app.workspaces,
  app.organization_memberships, app.workspace_memberships,
  app.identity_action_tokens, app.pipelines, app.pipeline_stages
  TO r72_security_definer;
GRANT UPDATE (password_hash, email_verified_at, status, row_version, updated_at)
  ON app.users TO r72_security_definer;
GRANT UPDATE (consumed_at, revoked_at)
  ON app.identity_action_tokens TO r72_security_definer;
GRANT SELECT, INSERT ON app_private.customer_provisioning_receipts
  TO r72_security_definer;

CREATE POLICY organizations_security_insert ON app.organizations
  FOR INSERT TO r72_security_definer WITH CHECK (true);
CREATE POLICY users_security_insert ON app.users
  FOR INSERT TO r72_security_definer WITH CHECK (true);
CREATE POLICY workspaces_security_insert ON app.workspaces
  FOR INSERT TO r72_security_definer WITH CHECK (true);
CREATE POLICY organization_memberships_security_insert ON app.organization_memberships
  FOR INSERT TO r72_security_definer WITH CHECK (true);
CREATE POLICY workspace_memberships_security_insert ON app.workspace_memberships
  FOR INSERT TO r72_security_definer WITH CHECK (true);
CREATE POLICY identity_action_tokens_security_select ON app.identity_action_tokens
  FOR SELECT TO r72_security_definer USING (true);
CREATE POLICY identity_action_tokens_security_insert ON app.identity_action_tokens
  FOR INSERT TO r72_security_definer WITH CHECK (true);
CREATE POLICY identity_action_tokens_security_update ON app.identity_action_tokens
  FOR UPDATE TO r72_security_definer USING (true) WITH CHECK (true);
CREATE POLICY pipelines_security_insert ON app.pipelines
  FOR INSERT TO r72_security_definer WITH CHECK (true);
CREATE POLICY pipeline_stages_security_insert ON app.pipeline_stages
  FOR INSERT TO r72_security_definer WITH CHECK (true);

GRANT CREATE ON SCHEMA app_private TO r72_security_definer;
SET LOCAL ROLE r72_security_definer;

CREATE FUNCTION app_private.provision_customer_workspace(
  p_idempotency_key text,
  p_organization_name text,
  p_organization_slug text,
  p_workspace_name text,
  p_workspace_slug text,
  p_owner_email text,
  p_owner_display_name text,
  p_setup_token_hash bytea,
  p_timezone text,
  p_locale text,
  p_currency text
)
RETURNS TABLE (
  organization_id uuid,
  workspace_id uuid,
  owner_user_id uuid,
  setup_action_token_id uuid,
  setup_expires_at timestamptz,
  created_now boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  normalized_idempotency_key text := pg_catalog.btrim(p_idempotency_key);
  normalized_organization_name text := pg_catalog.btrim(p_organization_name);
  normalized_organization_slug text := pg_catalog.lower(pg_catalog.btrim(p_organization_slug));
  normalized_workspace_name text := pg_catalog.btrim(p_workspace_name);
  normalized_workspace_slug text := pg_catalog.lower(pg_catalog.btrim(p_workspace_slug));
  normalized_owner_email text := pg_catalog.lower(pg_catalog.btrim(p_owner_email));
  normalized_owner_display_name text := nullif(pg_catalog.btrim(p_owner_display_name), '');
  normalized_timezone text := pg_catalog.btrim(p_timezone);
  normalized_locale text := pg_catalog.btrim(p_locale);
  normalized_currency text := pg_catalog.upper(pg_catalog.btrim(p_currency));
  stable_request_hash bytea;
  existing_request_hash bytea;
  existing_organization_id uuid;
  existing_workspace_id uuid;
  existing_owner_user_id uuid;
  existing_setup_token_id uuid;
  existing_setup_expires_at timestamptz;
  created_organization_id uuid;
  created_workspace_id uuid;
  created_owner_user_id uuid;
  created_setup_token_id uuid;
  created_pipeline_id uuid;
  created_setup_expires_at timestamptz := statement_timestamp() + interval '24 hours';
BEGIN
  IF p_idempotency_key IS NULL
     OR p_organization_name IS NULL
     OR p_organization_slug IS NULL
     OR p_workspace_name IS NULL
     OR p_workspace_slug IS NULL
     OR p_owner_email IS NULL
     OR p_timezone IS NULL
     OR p_locale IS NULL
     OR p_currency IS NULL
     OR normalized_idempotency_key <> p_idempotency_key
     OR length(normalized_idempotency_key) NOT BETWEEN 1 AND 128
     OR length(normalized_organization_name) NOT BETWEEN 1 AND 200
     OR normalized_organization_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$'
     OR length(normalized_workspace_name) NOT BETWEEN 1 AND 200
     OR normalized_workspace_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$'
     OR length(normalized_owner_email) NOT BETWEEN 3 AND 320
     OR normalized_owner_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR (normalized_owner_display_name IS NOT NULL
       AND length(normalized_owner_display_name) NOT BETWEEN 1 AND 200)
     OR length(normalized_timezone) NOT BETWEEN 1 AND 100
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_timezone_names AS timezone
       WHERE timezone.name = normalized_timezone
     )
     OR length(normalized_locale) NOT BETWEEN 2 AND 20
     OR normalized_currency !~ '^[A-Z]{3}$'
     OR p_setup_token_hash IS NULL
     OR octet_length(p_setup_token_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid customer provisioning input' USING ERRCODE = '22023';
  END IF;

  -- Credential material is intentionally excluded. A legitimate retry
  -- generates a fresh raw setup token, but the first committed token stays
  -- authoritative and is never replaced. PostgreSQL owns the fixed expiry.
  stable_request_hash := public.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        normalized_organization_name,
        normalized_organization_slug,
        normalized_workspace_name,
        normalized_workspace_slug,
        normalized_owner_email,
        normalized_owner_display_name,
        normalized_timezone,
        normalized_locale,
        normalized_currency
      )::text,
      'UTF8'
    ),
    'sha256'
  );

  -- A 64-bit advisory hash may serialize unrelated keys on the vanishingly
  -- unlikely collision, but can never merge their receipts or data.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(normalized_idempotency_key, 7200006)
  );

  SELECT receipt.request_hash,
         receipt.organization_id,
         receipt.workspace_id,
         receipt.owner_user_id,
         receipt.setup_token_id,
         receipt.setup_expires_at
    INTO existing_request_hash,
         existing_organization_id,
         existing_workspace_id,
         existing_owner_user_id,
         existing_setup_token_id,
         existing_setup_expires_at
  FROM app_private.customer_provisioning_receipts AS receipt
  WHERE receipt.idempotency_key = normalized_idempotency_key;

  IF FOUND THEN
    IF existing_request_hash <> stable_request_hash THEN
      RAISE EXCEPTION 'customer provisioning idempotency key was reused with different input'
        USING ERRCODE = '22023';
    END IF;

    RETURN QUERY SELECT
      existing_organization_id,
      existing_workspace_id,
      existing_owner_user_id,
      existing_setup_token_id,
      existing_setup_expires_at,
      false;
    RETURN;
  END IF;

  INSERT INTO app.organizations (name, slug, kind)
  VALUES (normalized_organization_name, normalized_organization_slug, 'direct_customer')
  RETURNING id INTO created_organization_id;

  INSERT INTO app.users (email, display_name)
  VALUES (normalized_owner_email, normalized_owner_display_name)
  RETURNING id INTO created_owner_user_id;

  INSERT INTO app.workspaces (
    organization_id,
    name,
    slug,
    timezone,
    locale,
    currency
  ) VALUES (
    created_organization_id,
    normalized_workspace_name,
    normalized_workspace_slug,
    normalized_timezone,
    normalized_locale,
    normalized_currency
  )
  RETURNING id INTO created_workspace_id;

  INSERT INTO app.organization_memberships (
    organization_id,
    user_id,
    role,
    status
  ) VALUES (
    created_organization_id,
    created_owner_user_id,
    'owner',
    'active'
  );

  INSERT INTO app.workspace_memberships (
    workspace_id,
    organization_id,
    user_id,
    role,
    status
  ) VALUES (
    created_workspace_id,
    created_organization_id,
    created_owner_user_id,
    'owner',
    'active'
  );

  INSERT INTO app.identity_action_tokens (
    user_id,
    workspace_id,
    purpose,
    token_hash,
    expires_at,
    request_id
  ) VALUES (
    created_owner_user_id,
    created_workspace_id,
    'account_setup',
    p_setup_token_hash,
    created_setup_expires_at,
    normalized_idempotency_key
  )
  RETURNING id INTO created_setup_token_id;

  INSERT INTO app.pipelines (workspace_id, name, slug, is_default)
  VALUES (created_workspace_id, 'Sales', 'sales', true)
  RETURNING id INTO created_pipeline_id;

  INSERT INTO app.pipeline_stages (
    workspace_id,
    pipeline_id,
    name,
    slug,
    position,
    stage_type,
    is_terminal
  ) VALUES
    (created_workspace_id, created_pipeline_id, 'New lead', 'new-lead', 1, 'open', false),
    (created_workspace_id, created_pipeline_id, 'Qualified', 'qualified', 2, 'open', false),
    (created_workspace_id, created_pipeline_id, 'Proposal', 'proposal', 3, 'open', false),
    (created_workspace_id, created_pipeline_id, 'Won', 'won', 4, 'won', true),
    (created_workspace_id, created_pipeline_id, 'Lost', 'lost', 5, 'lost', true);

  INSERT INTO app_private.customer_provisioning_receipts (
    idempotency_key,
    request_hash,
    organization_id,
    workspace_id,
    owner_user_id,
    setup_token_id,
    setup_expires_at
  ) VALUES (
    normalized_idempotency_key,
    stable_request_hash,
    created_organization_id,
    created_workspace_id,
    created_owner_user_id,
    created_setup_token_id,
    created_setup_expires_at
  );

  RETURN QUERY SELECT
    created_organization_id,
    created_workspace_id,
    created_owner_user_id,
    created_setup_token_id,
    created_setup_expires_at,
    true;
END
$function$;

CREATE FUNCTION app_private.complete_native_account_setup(
  p_setup_token_hash bytea,
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
  selected_action_token_id uuid;
  selected_user_id uuid;
  selected_user_email text;
  selected_setup_workspace_id uuid;
  created_session_id uuid;
  selected_expires_at timestamptz := statement_timestamp() + interval '14 days';
BEGIN
  IF p_setup_token_hash IS NULL
     OR octet_length(p_setup_token_hash) <> 32
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

  SELECT action_token.id,
         person.id,
         person.email::text,
         action_token.workspace_id
    INTO selected_action_token_id,
         selected_user_id,
         selected_user_email,
         selected_setup_workspace_id
  FROM app.identity_action_tokens AS action_token
  JOIN app.users AS person
    ON person.id = action_token.user_id
  JOIN app.workspace_memberships AS membership
    ON membership.workspace_id = action_token.workspace_id
   AND membership.user_id = action_token.user_id
  JOIN app.workspaces AS workspace
    ON workspace.id = membership.workspace_id
   AND workspace.organization_id = membership.organization_id
  JOIN app.organizations AS tenant_organization
    ON tenant_organization.id = workspace.organization_id
  JOIN app.organization_memberships AS organization_membership
    ON organization_membership.organization_id = tenant_organization.id
   AND organization_membership.user_id = person.id
  WHERE action_token.token_hash = p_setup_token_hash
    AND action_token.purpose = 'account_setup'
    AND action_token.consumed_at IS NULL
    AND action_token.revoked_at IS NULL
    AND action_token.expires_at > statement_timestamp()
    AND person.status = 'pending'
    AND person.password_hash IS NULL
    AND membership.status = 'active'
    AND membership.role = 'owner'
    AND workspace.status = 'active'
    AND tenant_organization.status = 'active'
    AND organization_membership.status = 'active'
    AND organization_membership.role = 'owner'
  FOR UPDATE OF action_token, person, membership, workspace,
    tenant_organization, organization_membership;

  IF selected_action_token_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE app.users AS person
     SET password_hash = p_password_hash,
         email_verified_at = statement_timestamp(),
         status = 'active',
         row_version = person.row_version + 1,
         updated_at = statement_timestamp()
   WHERE person.id = selected_user_id;

  UPDATE app.identity_action_tokens AS action_token
     SET consumed_at = statement_timestamp()
   WHERE action_token.id = selected_action_token_id;

  -- An activated identity cannot retain another live account-setup link.
  UPDATE app.identity_action_tokens AS peer_token
     SET revoked_at = statement_timestamp()
   WHERE peer_token.user_id = selected_user_id
     AND peer_token.purpose = 'account_setup'
     AND peer_token.id <> selected_action_token_id
     AND peer_token.consumed_at IS NULL
     AND peer_token.revoked_at IS NULL;

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
    selected_user_id,
    selected_setup_workspace_id,
    selected_expires_at,
    p_ip_hash,
    p_user_agent_hash
  )
  RETURNING id INTO created_session_id;

  RETURN QUERY SELECT
    created_session_id,
    selected_user_id,
    selected_user_email,
    selected_setup_workspace_id,
    selected_expires_at;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;

REVOKE ALL ON FUNCTION app_private.provision_customer_workspace(
  text, text, text, text, text, text, text, bytea, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.complete_native_account_setup(
  bytea, text, bytea, bytea, bytea, bytea
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.provision_customer_workspace(
  text, text, text, text, text, text, text, bytea, text, text, text
) TO r72_provisioning_command;
GRANT EXECUTE ON FUNCTION app_private.complete_native_account_setup(
  bytea, text, bytea, bytea, bytea, bytea
) TO r72_identity_command;
