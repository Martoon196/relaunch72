-- Complete the RLS half of the read-only grants made in 0064.
--
-- The readiness definer already holds SELECT on these exact app tables, but
-- FORCE RLS made every row invisible because 0064 added policies only for its
-- private compliance evidence. These policies expose only the transaction's
-- exact workspace. No table grant or mutation capability is added here.

SET LOCAL ROLE r72_owner;

DO $create_readiness_policies$
DECLARE
  table_name text;
  policy_index integer := 0;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'contact_points',
    'contacts',
    'channel_endpoints',
    'provider_connections',
    'communication_consent_events',
    'communication_suppression_events',
    'messages',
    'message_versions',
    'message_approval_requests',
    'message_approval_decisions',
    'conversations',
    'campaign_template_versions',
    'campaign_template_steps',
    'campaign_template_approval_requests',
    'campaign_template_approval_decisions',
    'property_predator_email_pilot_approved_content',
    'property_predator_customer_email_jobs'
  ] LOOP
    policy_index := policy_index + 1;
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON app.%I FOR SELECT'
      || ' TO r72_email_pilot_readiness_definer'
      || ' USING (workspace_id = nullif('
      || 'current_setting(''app.workspace_id'', true), '''')::uuid)',
      'email_readiness_0064_' || lpad(policy_index::text, 2, '0') || '_select',
      table_name
    );
  END LOOP;
END
$create_readiness_policies$;

DO $readiness_policy_audit$
DECLARE
  table_name text;
  policy_index integer := 0;
  policy_qual text;
  unsafe_privilege text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'contact_points',
    'contacts',
    'channel_endpoints',
    'provider_connections',
    'communication_consent_events',
    'communication_suppression_events',
    'messages',
    'message_versions',
    'message_approval_requests',
    'message_approval_decisions',
    'conversations',
    'campaign_template_versions',
    'campaign_template_steps',
    'campaign_template_approval_requests',
    'campaign_template_approval_decisions',
    'property_predator_email_pilot_approved_content',
    'property_predator_customer_email_jobs'
  ] LOOP
    policy_index := policy_index + 1;
    SELECT pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
      INTO policy_qual
    FROM pg_catalog.pg_policy AS policy
    JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'app'
      AND relation.relname = table_name
      AND policy.polname = 'email_readiness_0064_'
        || lpad(policy_index::text, 2, '0') || '_select'
      AND policy.polcmd = 'r'
      AND policy.polpermissive
      AND 'r72_email_pilot_readiness_definer'::regrole::oid
        = ANY(policy.polroles);
    IF policy_qual IS NULL
       OR policy_qual NOT LIKE '%workspace_id%'
       OR policy_qual NOT LIKE '%app.workspace_id%'
       OR policy_qual LIKE '% OR %' THEN
      RAISE EXCEPTION 'Email readiness policy is not workspace-exact on %',
        table_name USING ERRCODE = '42501';
    END IF;
    IF NOT pg_catalog.has_table_privilege(
         'r72_email_pilot_readiness_definer',
         'app.' || table_name, 'SELECT'
       ) THEN
      RAISE EXCEPTION 'Email readiness definer lost SELECT on %', table_name
        USING ERRCODE = '42501';
    END IF;
    FOREACH unsafe_privilege IN ARRAY ARRAY[
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'
    ] LOOP
      IF pg_catalog.has_table_privilege(
           'r72_email_pilot_readiness_definer',
           'app.' || table_name, unsafe_privilege
         ) THEN
        RAISE EXCEPTION 'Email readiness definer must not hold % on %',
          unsafe_privilege, table_name USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;

  IF pg_catalog.has_table_privilege(
       'r72_crm_command',
       'app.property_predator_email_pilot_approved_content', 'SELECT'
     ) OR pg_catalog.has_table_privilege(
       'r72_crm_command',
       'app.property_predator_customer_email_jobs', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'CRM command identity must remain email evidence table-blind'
      USING ERRCODE = '42501';
  END IF;
END
$readiness_policy_audit$;
