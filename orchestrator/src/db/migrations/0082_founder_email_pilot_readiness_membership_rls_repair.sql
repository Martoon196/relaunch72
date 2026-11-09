-- Let the read-only founder-email readiness boundary verify its operator.
--
-- 0064 granted this SECURITY DEFINER SELECT on workspace memberships but did
-- not add an RLS policy for the role. Consequently its owner/admin check could
-- never observe even the active workspace's membership and the current email
-- rail failed closed before deriving a request digest. This repair exposes
-- only rows belonging to the workspace already pinned in transaction context.

SET LOCAL ROLE r72_owner;

CREATE POLICY founder_email_pilot_readiness_membership_select
  ON app.workspace_memberships
  FOR SELECT TO r72_email_pilot_readiness_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  );

DO $repair_audit$
DECLARE
  readiness_function regprocedure := pg_catalog.to_regprocedure(
    'app_private.derive_customer_email_pilot_request_digest(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,uuid,uuid,uuid,bytea)'
  );
  function_owner text;
  is_security_definer boolean;
  function_volatility "char";
  function_settings text[];
  policy_qual text;
  unsafe_privilege text;
BEGIN
  IF NOT pg_catalog.has_table_privilege(
       'r72_email_pilot_readiness_definer',
       'app.workspace_memberships', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'Email pilot readiness definer lost membership read access'
      USING ERRCODE = '42501';
  END IF;

  FOREACH unsafe_privilege IN ARRAY ARRAY[
    'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'
  ] LOOP
    IF pg_catalog.has_table_privilege(
         'r72_email_pilot_readiness_definer',
         'app.workspace_memberships', unsafe_privilege
       ) THEN
      RAISE EXCEPTION 'Email pilot readiness definer must not hold % on memberships',
        unsafe_privilege USING ERRCODE = '42501';
    END IF;
  END LOOP;

  SELECT pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
    INTO policy_qual
  FROM pg_catalog.pg_policy AS policy
  JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'app'
    AND relation.relname = 'workspace_memberships'
    AND policy.polname = 'founder_email_pilot_readiness_membership_select'
    AND policy.polcmd = 'r'
    AND policy.polpermissive
    AND 'r72_email_pilot_readiness_definer'::regrole::oid
      = ANY(policy.polroles);
  IF policy_qual IS NULL
     OR policy_qual NOT LIKE '%workspace_id%'
     OR policy_qual NOT LIKE '%app.workspace_id%'
     OR policy_qual LIKE '% OR %' THEN
    RAISE EXCEPTION 'Email pilot readiness membership policy is not exact'
      USING ERRCODE = '42501';
  END IF;

  IF readiness_function IS NULL THEN
    RAISE EXCEPTION 'Customer email request digest boundary is missing'
      USING ERRCODE = '42501';
  END IF;
  SELECT owner_role.rolname, procedure.prosecdef, procedure.provolatile,
         procedure.proconfig
    INTO function_owner, is_security_definer, function_volatility,
         function_settings
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_roles AS owner_role
    ON owner_role.oid = procedure.proowner
  WHERE procedure.oid = readiness_function;
  IF function_owner <> 'r72_email_pilot_readiness_definer'
     OR NOT is_security_definer
     OR function_volatility <> 's'
     OR NOT coalesce(
       function_settings @> ARRAY['search_path=pg_catalog']::text[], false
     ) THEN
    RAISE EXCEPTION 'Customer email request digest boundary lost read-only ownership'
      USING ERRCODE = '42501';
  END IF;
END
$repair_audit$;
