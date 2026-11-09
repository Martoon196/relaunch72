-- Tighten the 0082 membership visibility repair to the one operator row the
-- readiness function evaluates. The definer may not enumerate colleagues even
-- inside the active workspace: it sees only the current active owner/admin.

SET LOCAL ROLE r72_owner;

ALTER POLICY founder_email_pilot_readiness_membership_select
  ON app.workspace_memberships
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND status = 'active'
    AND role IN ('owner', 'admin')
  );

DO $tightening_audit$
DECLARE
  policy_qual text;
  unsafe_privilege text;
BEGIN
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
     OR policy_qual NOT LIKE '%user_id%'
     OR policy_qual NOT LIKE '%app.user_id%'
     OR policy_qual NOT LIKE '%status%active%'
     OR policy_qual NOT LIKE '%role%owner%admin%'
     OR policy_qual LIKE '% OR %' THEN
    RAISE EXCEPTION 'Email pilot readiness membership policy is not operator-exact'
      USING ERRCODE = '42501';
  END IF;

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
END
$tightening_audit$;
