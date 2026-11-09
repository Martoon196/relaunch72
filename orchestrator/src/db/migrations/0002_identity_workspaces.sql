-- Relaunch72 identity, white-label organisation, workspace, membership,
-- invitation, action-token, and opaque-session foundation.

SET LOCAL ROLE r72_owner;

CREATE TABLE app.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  slug citext NOT NULL UNIQUE CHECK (slug::text = lower(slug::text) AND slug::text ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  kind text NOT NULL CHECK (kind IN ('direct_customer', 'agency')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (updated_at >= created_at)
);

CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE CHECK (
    email::text = btrim(email::text)
    AND length(email::text) BETWEEN 3 AND 320
    AND email::text ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  display_name text CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 200),
  password_hash text CHECK (password_hash IS NULL OR length(password_hash) BETWEEN 20 AND 1024),
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (updated_at >= created_at)
);

CREATE TABLE app.organization_branding (
  organization_id uuid PRIMARY KEY REFERENCES app.organizations(id) ON DELETE CASCADE,
  product_name text NOT NULL CHECK (length(btrim(product_name)) BETWEEN 1 AND 100),
  logo_storage_key text,
  logo_sha256 bytea CHECK (logo_sha256 IS NULL OR octet_length(logo_sha256) = 32),
  primary_color text CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color text CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  support_email citext CHECK (
    support_email IS NULL OR (
      support_email::text = btrim(support_email::text)
      AND length(support_email::text) BETWEEN 3 AND 320
      AND support_email::text ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((logo_storage_key IS NULL) = (logo_sha256 IS NULL)),
  CHECK (updated_at >= created_at)
);

CREATE TABLE app.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  legacy_tenant_key text,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  slug citext NOT NULL CHECK (slug::text = lower(slug::text) AND slug::text ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  timezone text NOT NULL DEFAULT 'Europe/London' CHECK (length(timezone) BETWEEN 1 AND 100),
  locale text NOT NULL DEFAULT 'en-GB' CHECK (length(locale) BETWEEN 2 AND 20),
  currency text NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, slug),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX workspaces_legacy_tenant_key_uq
  ON app.workspaces (legacy_tenant_key)
  WHERE legacy_tenant_key IS NOT NULL;

CREATE TABLE app.organization_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  workspace_id uuid,
  hostname citext NOT NULL UNIQUE CHECK (
    hostname::text = lower(hostname::text)
    AND length(hostname::text) BETWEEN 4 AND 253
    AND hostname::text ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  purpose text NOT NULL CHECK (purpose IN ('portal', 'funnel', 'forms', 'tracking')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'disabled')),
  verification_challenge_hash bytea CHECK (verification_challenge_hash IS NULL OR octet_length(verification_challenge_hash) = 32),
  verified_at timestamptz,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES app.workspaces (organization_id, id) ON DELETE CASCADE,
  CHECK ((status = 'verified') = (verified_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX organization_domains_primary_org_uq
  ON app.organization_domains (organization_id, purpose)
  WHERE workspace_id IS NULL AND is_primary;
CREATE UNIQUE INDEX organization_domains_primary_workspace_uq
  ON app.organization_domains (organization_id, workspace_id, purpose)
  WHERE workspace_id IS NOT NULL AND is_primary;

CREATE TABLE app.organization_memberships (
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'billing')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  granted_by_user_id uuid REFERENCES app.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, user_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (updated_at >= granted_at)
);

CREATE TABLE app.workspace_memberships (
  workspace_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'marketer', 'sales', 'viewer')),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended', 'revoked')),
  source_organization_id uuid,
  granted_by_user_id uuid REFERENCES app.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES app.workspaces (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (source_organization_id, user_id)
    REFERENCES app.organization_memberships (organization_id, user_id) ON DELETE RESTRICT,
  CHECK (source_organization_id IS NULL OR source_organization_id = organization_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (updated_at >= granted_at)
);

CREATE INDEX workspace_memberships_user_active_idx
  ON app.workspace_memberships (user_id, workspace_id)
  WHERE status = 'active';

CREATE TABLE app.membership_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  workspace_id uuid,
  invited_email citext NOT NULL CHECK (
    invited_email::text = btrim(invited_email::text)
    AND length(invited_email::text) BETWEEN 3 AND 320
    AND invited_email::text ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  resolved_user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  organization_role text CHECK (organization_role IN ('owner', 'admin', 'billing')),
  workspace_role text CHECK (workspace_role IN ('owner', 'admin', 'marketer', 'sales', 'viewer')),
  invited_by_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  source_order_key text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id)
    REFERENCES app.workspaces (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, resolved_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (organization_role IS NOT NULL OR workspace_role IS NOT NULL),
  CHECK ((workspace_id IS NULL) = (workspace_role IS NULL)),
  CHECK (expires_at > created_at),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX membership_invitations_pending_scope_email_uq
  ON app.membership_invitations (
    organization_id,
    coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    invited_email
  )
  WHERE status = 'pending';

CREATE TABLE app.identity_action_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('account_setup', 'membership_claim', 'password_reset')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  membership_invitation_id uuid REFERENCES app.membership_invitations(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  request_id text CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  requested_ip_hash bytea CHECK (requested_ip_hash IS NULL OR octet_length(requested_ip_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX identity_action_tokens_active_idx
  ON app.identity_action_tokens (user_id, purpose, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE app.user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  csrf_secret_hash bytea NOT NULL CHECK (octet_length(csrf_secret_hash) = 32),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  selected_workspace_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ip_hash bytea CHECK (ip_hash IS NULL OR octet_length(ip_hash) = 32),
  user_agent_hash bytea CHECK (user_agent_hash IS NULL OR octet_length(user_agent_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (selected_workspace_id, user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at),
  CHECK (last_seen_at >= created_at)
);

CREATE INDEX user_sessions_user_active_idx
  ON app.user_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE app.platform_memberships (
  user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('platform_admin', 'support', 'auditor')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

-- No workspace-bearing table exists for even one transaction without forced RLS.
ALTER TABLE app.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
ALTER TABLE app.organization_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organization_branding FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE app.organization_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organization_domains FORCE ROW LEVEL SECURITY;
ALTER TABLE app.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organization_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE app.membership_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.membership_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.identity_action_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.identity_action_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.platform_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.platform_memberships FORCE ROW LEVEL SECURITY;

-- Migration owner remains useful under FORCE RLS, but runtime roles can never
-- assume this NOLOGIN role.
DO $owner_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organizations', 'users', 'organization_branding', 'workspaces',
    'organization_domains', 'organization_memberships',
    'workspace_memberships', 'membership_invitations',
    'identity_action_tokens', 'user_sessions', 'platform_memberships'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)',
      table_name || '_owner_all',
      table_name
    );
  END LOOP;
END
$owner_policies$;

GRANT USAGE ON SCHEMA app, app_private TO r72_security_definer;
-- PostgreSQL requires a new function owner to have CREATE on the containing
-- schema. This grant exists only inside this migration transaction and is
-- revoked immediately after the audited helper ownership transfers.
GRANT CREATE ON SCHEMA app_private TO r72_security_definer;
GRANT SELECT ON app.organizations, app.users, app.workspaces,
  app.organization_memberships, app.workspace_memberships, app.user_sessions
  TO r72_security_definer;

CREATE POLICY organizations_security_lookup ON app.organizations
  FOR SELECT TO r72_security_definer USING (true);
CREATE POLICY users_security_lookup ON app.users
  FOR SELECT TO r72_security_definer USING (true);
CREATE POLICY workspaces_security_lookup ON app.workspaces
  FOR SELECT TO r72_security_definer USING (true);
CREATE POLICY organization_memberships_security_lookup ON app.organization_memberships
  FOR SELECT TO r72_security_definer USING (true);
CREATE POLICY workspace_memberships_security_lookup ON app.workspace_memberships
  FOR SELECT TO r72_security_definer USING (true);
CREATE POLICY user_sessions_security_lookup ON app.user_sessions
  FOR SELECT TO r72_security_definer USING (true);

CREATE FUNCTION app_private.has_active_organization_membership(p_user_id uuid, p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.organization_memberships AS membership
    JOIN app.users AS person ON person.id = membership.user_id
    JOIN app.organizations AS organization ON organization.id = membership.organization_id
    WHERE membership.user_id = p_user_id
      AND membership.organization_id = p_organization_id
      AND membership.status = 'active'
      AND person.status = 'active'
      AND organization.status = 'active'
  )
$function$;

CREATE FUNCTION app_private.can_manage_organization(p_user_id uuid, p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.organization_memberships AS membership
    JOIN app.users AS person ON person.id = membership.user_id
    JOIN app.organizations AS organization ON organization.id = membership.organization_id
    WHERE membership.user_id = p_user_id
      AND membership.organization_id = p_organization_id
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
      AND person.status = 'active'
      AND organization.status = 'active'
  )
$function$;

CREATE FUNCTION app_private.has_active_workspace_membership(p_user_id uuid, p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.workspace_memberships AS membership
    JOIN app.users AS person ON person.id = membership.user_id
    JOIN app.workspaces AS workspace ON workspace.id = membership.workspace_id
    JOIN app.organizations AS organization ON organization.id = workspace.organization_id
    WHERE membership.user_id = p_user_id
      AND membership.workspace_id = p_workspace_id
      AND membership.status = 'active'
      AND person.status = 'active'
      AND workspace.status = 'active'
      AND organization.status = 'active'
      AND (
        membership.source_organization_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM app.organization_memberships AS source_membership
          WHERE source_membership.organization_id = membership.source_organization_id
            AND source_membership.user_id = membership.user_id
            AND source_membership.status = 'active'
        )
      )
  )
$function$;

CREATE FUNCTION app_private.can_write_workspace(p_user_id uuid, p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app_private.has_active_workspace_membership(p_user_id, p_workspace_id)
    AND EXISTS (
      SELECT 1 FROM app.workspace_memberships AS membership
      WHERE membership.user_id = p_user_id
        AND membership.workspace_id = p_workspace_id
        AND membership.role IN ('owner', 'admin', 'marketer', 'sales')
    )
$function$;

CREATE FUNCTION app_private.can_manage_workspace(p_user_id uuid, p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app_private.has_active_workspace_membership(p_user_id, p_workspace_id)
    AND EXISTS (
      SELECT 1 FROM app.workspace_memberships AS membership
      WHERE membership.user_id = p_user_id
        AND membership.workspace_id = p_workspace_id
        AND membership.role IN ('owner', 'admin')
    )
$function$;

CREATE FUNCTION app_private.workspace_is_in_organization(p_workspace_id uuid, p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM app.workspaces AS workspace
    WHERE workspace.id = p_workspace_id
      AND workspace.organization_id = p_organization_id
      AND workspace.status = 'active'
  )
$function$;

CREATE FUNCTION app_private.resolve_session(p_token_hash bytea)
RETURNS TABLE (session_id uuid, user_id uuid, selected_workspace_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT session.id, session.user_id, session.selected_workspace_id
  FROM app.user_sessions AS session
  JOIN app.users AS person ON person.id = session.user_id
  WHERE session.token_hash = p_token_hash
    AND octet_length(p_token_hash) = 32
    AND session.revoked_at IS NULL
    AND session.expires_at > statement_timestamp()
    AND person.status = 'active'
    AND app_private.has_active_workspace_membership(session.user_id, session.selected_workspace_id)
$function$;

ALTER FUNCTION app_private.has_active_organization_membership(uuid, uuid) OWNER TO r72_security_definer;
ALTER FUNCTION app_private.can_manage_organization(uuid, uuid) OWNER TO r72_security_definer;
ALTER FUNCTION app_private.has_active_workspace_membership(uuid, uuid) OWNER TO r72_security_definer;
ALTER FUNCTION app_private.can_write_workspace(uuid, uuid) OWNER TO r72_security_definer;
ALTER FUNCTION app_private.can_manage_workspace(uuid, uuid) OWNER TO r72_security_definer;
ALTER FUNCTION app_private.workspace_is_in_organization(uuid, uuid) OWNER TO r72_security_definer;
ALTER FUNCTION app_private.resolve_session(bytea) OWNER TO r72_security_definer;
REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;

REVOKE ALL ON FUNCTION app_private.has_active_organization_membership(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.can_manage_organization(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.has_active_workspace_membership(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.can_write_workspace(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.can_manage_workspace(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.workspace_is_in_organization(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.resolve_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.has_active_organization_membership(uuid, uuid) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.can_manage_organization(uuid, uuid) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.has_active_workspace_membership(uuid, uuid) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.can_write_workspace(uuid, uuid) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.can_manage_workspace(uuid, uuid) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.workspace_is_in_organization(uuid, uuid) TO r72_web, r72_worker;
GRANT EXECUTE ON FUNCTION app_private.resolve_session(bytea) TO r72_web;

-- Safe user-facing policies. Raw sessions and action-token hashes have no web
-- table policy or grant; they are reachable only through audited functions.
CREATE POLICY users_self_select ON app.users FOR SELECT TO r72_web
  USING (id = app_private.current_user_id());
CREATE POLICY users_self_update ON app.users FOR UPDATE TO r72_web
  USING (id = app_private.current_user_id())
  WITH CHECK (id = app_private.current_user_id());

CREATE POLICY organizations_web_select ON app.organizations FOR SELECT TO r72_web
  USING (
    app_private.has_active_organization_membership(app_private.current_user_id(), id)
    OR (
      app_private.has_active_workspace_membership(
        app_private.current_user_id(), app_private.current_workspace_id()
      )
      AND app_private.workspace_is_in_organization(app_private.current_workspace_id(), id)
    )
  );
CREATE POLICY organizations_web_write ON app.organizations FOR UPDATE TO r72_web
  USING (app_private.can_manage_organization(app_private.current_user_id(), id))
  WITH CHECK (app_private.can_manage_organization(app_private.current_user_id(), id));
CREATE POLICY organizations_worker_select ON app.organizations FOR SELECT TO r72_worker
  USING (app_private.workspace_is_in_organization(app_private.current_workspace_id(), id));

CREATE POLICY organization_branding_web_select ON app.organization_branding FOR SELECT TO r72_web
  USING (
    app_private.has_active_organization_membership(app_private.current_user_id(), organization_id)
    OR (
      app_private.has_active_workspace_membership(
        app_private.current_user_id(), app_private.current_workspace_id()
      )
      AND app_private.workspace_is_in_organization(app_private.current_workspace_id(), organization_id)
    )
  );
CREATE POLICY organization_branding_web_write ON app.organization_branding FOR ALL TO r72_web
  USING (app_private.can_manage_organization(app_private.current_user_id(), organization_id))
  WITH CHECK (app_private.can_manage_organization(app_private.current_user_id(), organization_id));
CREATE POLICY organization_branding_worker_select ON app.organization_branding FOR SELECT TO r72_worker
  USING (app_private.workspace_is_in_organization(app_private.current_workspace_id(), organization_id));

CREATE POLICY workspaces_web_select ON app.workspaces FOR SELECT TO r72_web
  USING (
    id = app_private.current_workspace_id()
    AND app_private.has_active_workspace_membership(app_private.current_user_id(), id)
  );
CREATE POLICY workspaces_web_write ON app.workspaces FOR UPDATE TO r72_web
  USING (
    id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(app_private.current_user_id(), id)
  )
  WITH CHECK (
    id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(app_private.current_user_id(), id)
  );
CREATE POLICY workspaces_worker_select ON app.workspaces FOR SELECT TO r72_worker
  USING (id = app_private.current_workspace_id());

CREATE POLICY organization_domains_web_select ON app.organization_domains FOR SELECT TO r72_web
  USING (
    app_private.can_manage_organization(app_private.current_user_id(), organization_id)
    OR (
      workspace_id = app_private.current_workspace_id()
      AND app_private.has_active_workspace_membership(app_private.current_user_id(), workspace_id)
    )
  );
CREATE POLICY organization_domains_worker_select ON app.organization_domains FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());

CREATE POLICY organization_memberships_self_or_manager_select ON app.organization_memberships
  FOR SELECT TO r72_web
  USING (
    user_id = app_private.current_user_id()
    OR app_private.can_manage_organization(app_private.current_user_id(), organization_id)
  );
CREATE POLICY workspace_memberships_web_select ON app.workspace_memberships FOR SELECT TO r72_web
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.has_active_workspace_membership(
      app_private.current_user_id(), app_private.current_workspace_id()
    )
  );
CREATE POLICY workspace_memberships_worker_select ON app.workspace_memberships FOR SELECT TO r72_worker
  USING (workspace_id = app_private.current_workspace_id());

CREATE POLICY membership_invitations_manager_select ON app.membership_invitations FOR SELECT TO r72_web
  USING (
    (workspace_id IS NOT NULL AND workspace_id = app_private.current_workspace_id()
      AND app_private.can_manage_workspace(app_private.current_user_id(), workspace_id))
    OR (workspace_id IS NULL
      AND app_private.can_manage_organization(app_private.current_user_id(), organization_id))
  );

GRANT SELECT (id, email, display_name, email_verified_at, status, row_version, created_at, updated_at),
  UPDATE (display_name) ON app.users TO r72_web;
-- Tenant/ownership keys are immutable to the web role. RLS decides which rows
-- may be changed; column grants separately prevent an otherwise-authorised
-- editor from rewriting a row into another organisation or workspace.
GRANT SELECT ON app.organizations TO r72_web;
GRANT UPDATE (name, slug, status, row_version, updated_at)
  ON app.organizations TO r72_web;

GRANT SELECT, INSERT, DELETE ON app.organization_branding TO r72_web;
GRANT UPDATE (product_name, logo_storage_key, logo_sha256, primary_color,
  accent_color, support_email, updated_at)
  ON app.organization_branding TO r72_web;

GRANT SELECT ON app.workspaces TO r72_web;
GRANT UPDATE (name, slug, status, timezone, locale, currency, settings,
  row_version, updated_at)
  ON app.workspaces TO r72_web;

-- Domain verification and membership/invitation mutation are command
-- boundaries, not raw table CRUD. They remain read-only to r72_web until the
-- audited SECURITY DEFINER commands are introduced in the auth cutover.
GRANT SELECT ON app.organization_domains TO r72_web;
GRANT SELECT ON app.organization_memberships TO r72_web;
GRANT SELECT ON app.workspace_memberships TO r72_web;
GRANT SELECT ON app.membership_invitations TO r72_web;

GRANT SELECT ON app.organizations, app.organization_branding, app.workspaces,
  app.organization_domains, app.workspace_memberships TO r72_worker;

INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
VALUES
  ('app', 'workspaces', 'id'),
  ('app', 'organization_domains', 'workspace_id'),
  ('app', 'workspace_memberships', 'workspace_id'),
  ('app', 'membership_invitations', 'workspace_id'),
  ('app', 'user_sessions', 'selected_workspace_id');
