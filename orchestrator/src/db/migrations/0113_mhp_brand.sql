-- MHP-DESK-001: brand identity and a private, one-workspace-per-member registry.
-- DNS is deliberately pending until Render verifies the actual custom domain.
DO $role$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_mhp_member_definer') THEN CREATE ROLE r72_mhp_member_definer NOLOGIN NOINHERIT; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_mhp_member_definer' AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe MHP member definer role'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles child ON child.oid=m.member WHERE child.rolname='r72_mhp_member_definer') THEN RAISE EXCEPTION 'MHP member definer must not inherit another role'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member WHERE parent.rolname='r72_mhp_member_definer' AND child.rolname NOT IN ('r72_owner',current_user)) THEN RAISE EXCEPTION 'Unexpected MHP member definer member'; END IF;
 GRANT r72_mhp_member_definer TO r72_owner;
 EXECUTE format('GRANT r72_mhp_member_definer TO %I',current_user);
END $role$;
SET LOCAL ROLE r72_owner;

INSERT INTO app.organizations(id,name,slug,kind)
VALUES('ba41b1a4-9752-4dbf-8312-d04a0f03d0b8','Martin Howard Property','martin-howard-property','direct_customer');
INSERT INTO app.organization_branding(organization_id,product_name,primary_color,accent_color,support_email)
VALUES('ba41b1a4-9752-4dbf-8312-d04a0f03d0b8','Martin Howard Property','#142019','#E8A33D','martin@propinvestuk.co.uk');
INSERT INTO app.organization_domains(organization_id,hostname,purpose,status,is_primary)
VALUES('ba41b1a4-9752-4dbf-8312-d04a0f03d0b8','app.martinhowardproperty.co.uk','portal','pending',true);

CREATE TABLE app_private.mhp_members (
 workspace_id uuid PRIMARY KEY REFERENCES app.workspaces(id) ON DELETE CASCADE,
 user_id uuid UNIQUE REFERENCES app.users(id) ON DELETE RESTRICT,
 owner_email citext UNIQUE NOT NULL CHECK(owner_email::text=lower(btrim(owner_email::text)) AND length(owner_email::text) BETWEEN 3 AND 320),
 manual_tier text CHECK(manual_tier IN('course','mentoring','partnership')),
 manual_reference text CHECK(length(btrim(manual_reference)) BETWEEN 1 AND 200),
 manual_active boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE app_private.mhp_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_members FORCE ROW LEVEL SECURITY;
CREATE POLICY mhp_members_owner ON app_private.mhp_members TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY mhp_members_definer ON app_private.mhp_members TO r72_mhp_member_definer USING(true) WITH CHECK(true);
CREATE POLICY mhp_members_security ON app_private.mhp_members FOR SELECT TO r72_security_definer USING(true);
REVOKE ALL ON app_private.mhp_members FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON app_private.mhp_members TO r72_mhp_member_definer;
GRANT SELECT ON app_private.mhp_members TO r72_security_definer;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
VALUES('app_private','mhp_members','workspace_id');

GRANT USAGE ON SCHEMA app,app_private TO r72_mhp_member_definer;
GRANT SELECT,INSERT ON app.organizations,app.workspaces,app.organization_memberships,app.workspace_memberships,
 app.pipelines,app.pipeline_stages,app.investor_businesses,app.user_sessions,app_private.investor_programme_admins TO r72_mhp_member_definer;
GRANT SELECT ON app.users,app.investor_sites,app.organization_domains TO r72_mhp_member_definer;
GRANT UPDATE(owner_user_id,access_state,payment_reference,row_version) ON app.investor_businesses TO r72_mhp_member_definer;
GRANT UPDATE(status,updated_at) ON app.workspace_memberships TO r72_mhp_member_definer;
GRANT UPDATE(revoked_at) ON app.user_sessions TO r72_mhp_member_definer;
DO $policies$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['organizations','workspaces','organization_memberships','workspace_memberships','pipelines','pipeline_stages','investor_businesses','user_sessions'] LOOP
  EXECUTE format('CREATE POLICY mhp_member_definer ON app.%I TO r72_mhp_member_definer USING(true) WITH CHECK(true)',t);
 END LOOP;
END $policies$;
CREATE POLICY mhp_member_users ON app.users FOR SELECT TO r72_mhp_member_definer USING(true);
CREATE POLICY mhp_member_sites ON app.investor_sites FOR SELECT TO r72_mhp_member_definer USING(true);
CREATE POLICY mhp_member_domains ON app.organization_domains FOR SELECT TO r72_mhp_member_definer USING(organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8');
CREATE POLICY mhp_member_admins ON app_private.investor_programme_admins TO r72_mhp_member_definer USING(true) WITH CHECK(true);

-- Existing, verified founder identities may administer; an email string alone
-- never creates a person, credential, session, or membership.
INSERT INTO app_private.investor_programme_admins(user_id)
SELECT id FROM app.users WHERE lower(email::text) IN('office@propertypredator.com','martin.howard1984@gmail.com')
 AND email_verified_at IS NOT NULL AND status='active'
ON CONFLICT DO NOTHING;
RESET ROLE;
