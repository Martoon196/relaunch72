-- Preserve verified replies across the founder-email rail cutover.
--
-- 0073 correctly made the current customer-email job the primary correlation
-- authority, but historical owned-seed deliveries were created by the earlier
-- Mailgun job rail. A reply to one of those already-sent messages must remain
-- receivable without weakening the exact workspace, provider, digest, sender,
-- delivery or receipt bindings. The immutable receipt therefore records exactly
-- one of the two job authorities and the recorder treats an overlap as a hard
-- evidence conflict.

SET LOCAL ROLE r72_owner;

ALTER TABLE app.property_predator_mailgun_inbound_receipts
  ALTER COLUMN customer_email_job_id DROP NOT NULL;
ALTER TABLE app.property_predator_mailgun_inbound_receipts
  ADD COLUMN legacy_mailgun_job_id uuid;
ALTER TABLE app.property_predator_mailgun_inbound_receipts
  ADD CONSTRAINT property_predator_mailgun_inbound_exact_job_authority_check
  CHECK (
    (customer_email_job_id IS NULL) <>
    (legacy_mailgun_job_id IS NULL)
  );
ALTER TABLE app.property_predator_mailgun_inbound_receipts
  ADD CONSTRAINT property_predator_mailgun_inbound_legacy_mailgun_job_fkey
  FOREIGN KEY (workspace_id, legacy_mailgun_job_id)
  REFERENCES app.property_predator_mailgun_jobs (workspace_id, id)
  ON DELETE RESTRICT;

GRANT SELECT ON app.property_predator_mailgun_jobs
  TO r72_mailgun_webhook_definer;
CREATE POLICY property_predator_mailgun_jobs_inbound_legacy_definer_select
  ON app.property_predator_mailgun_jobs
  FOR SELECT TO r72_mailgun_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
  );

GRANT CREATE ON SCHEMA app_private TO r72_mailgun_webhook_definer;
SET LOCAL ROLE r72_mailgun_webhook_definer;

DO $replace_recorder$
DECLARE
  recorder_oid oid := pg_catalog.to_regprocedure(
    'app_private.record_property_predator_owned_seed_mailgun_inbound(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,bytea,bytea,bytea,timestamp with time zone,bytea,bytea,bytea,bytea)'
  );
  recorder_definition text;
  old_match_block text := $old_match$
  BEGIN
    SELECT job.* INTO STRICT selected_job
    FROM app.property_predator_customer_email_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.provider_connection_id = p_provider_connection_id
      AND job.request_sha256 = correlation_digest
      AND job.state = 'succeeded'
      AND job.message_delivery_id IS NOT NULL
      AND job.expected_message_id = '<pp-' || p_correlation_sha256
        || '@mg.propertypredator.com>';
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RAISE EXCEPTION 'owned-seed inbound reply is unmatched'
        USING ERRCODE = '23503';
    WHEN TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'owned-seed inbound reply evidence conflicts'
        USING ERRCODE = '22000';
  END;
$old_match$;
  dual_match_block text := $dual_match$
  BEGIN
    SELECT candidate.customer_job_id, candidate.legacy_job_id,
           candidate.message_delivery_id
    INTO STRICT selected_customer_job_id, selected_legacy_job_id,
                selected_delivery_id
    FROM (
      SELECT job.id AS customer_job_id, NULL::uuid AS legacy_job_id,
             job.message_delivery_id
      FROM app.property_predator_customer_email_jobs AS job
      WHERE job.workspace_id = p_workspace_id
        AND job.provider_connection_id = p_provider_connection_id
        AND job.request_sha256 = correlation_digest
        AND job.state = 'succeeded'
        AND job.message_delivery_id IS NOT NULL
        AND job.expected_message_id = '<pp-' || p_correlation_sha256
          || '@mg.propertypredator.com>'
      UNION ALL
      SELECT NULL::uuid AS customer_job_id, job.id AS legacy_job_id,
             job.message_delivery_id
      FROM app.property_predator_mailgun_jobs AS job
      WHERE job.workspace_id = p_workspace_id
        AND job.provider_connection_id = p_provider_connection_id
        AND job.request_sha256 = correlation_digest
        AND job.state = 'settled'
        AND job.message_delivery_id IS NOT NULL
        AND job.expected_message_id = '<pp-' || p_correlation_sha256
          || '@mg.propertypredator.com>'
    ) AS candidate;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RAISE EXCEPTION 'owned-seed inbound reply is unmatched'
        USING ERRCODE = '23503';
    WHEN TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'owned-seed inbound reply evidence conflicts'
        USING ERRCODE = '22000';
  END;
$dual_match$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(recorder_oid) INTO recorder_definition;
  IF recorder_oid IS NULL
     OR recorder_definition IS NULL
     OR pg_catalog.strpos(
       recorder_definition,
       'selected_job app.property_predator_customer_email_jobs%ROWTYPE;'
     ) = 0
     OR pg_catalog.strpos(recorder_definition, old_match_block) = 0
     OR pg_catalog.strpos(
       recorder_definition,
       'AND delivery.id = selected_job.message_delivery_id'
     ) = 0
     OR pg_catalog.strpos(
       recorder_definition,
       'customer_email_job_id,'
     ) = 0
     OR pg_catalog.strpos(
       recorder_definition,
       'selected_job.id, selected_delivery.id,'
     ) = 0 THEN
    RAISE EXCEPTION 'Founder reply recorder source is not the reviewed 0073 definition'
      USING ERRCODE = '55000';
  END IF;

  recorder_definition := pg_catalog.replace(
    recorder_definition,
    'selected_job app.property_predator_customer_email_jobs%ROWTYPE;',
    E'selected_customer_job_id uuid;\n  selected_legacy_job_id uuid;\n  selected_delivery_id uuid;'
  );
  recorder_definition := pg_catalog.replace(
    recorder_definition, old_match_block, dual_match_block
  );
  recorder_definition := pg_catalog.replace(
    recorder_definition,
    'AND delivery.id = selected_job.message_delivery_id',
    'AND delivery.id = selected_delivery_id'
  );
  recorder_definition := pg_catalog.replace(
    recorder_definition,
    'customer_email_job_id,',
    'customer_email_job_id, legacy_mailgun_job_id,'
  );
  recorder_definition := pg_catalog.replace(
    recorder_definition,
    'selected_job.id, selected_delivery.id,',
    'selected_customer_job_id, selected_legacy_job_id, selected_delivery.id,'
  );

  IF pg_catalog.strpos(recorder_definition, 'selected_job') <> 0
     OR pg_catalog.strpos(
       recorder_definition,
       'app.property_predator_customer_email_jobs'
     ) = 0
     OR pg_catalog.strpos(
       recorder_definition,
       'app.property_predator_mailgun_jobs'
     ) = 0
     OR pg_catalog.strpos(
       recorder_definition,
       'selected_customer_job_id, selected_legacy_job_id, selected_delivery.id,'
     ) = 0
     OR pg_catalog.strpos(
       recorder_definition,
       'customer_email_job_id, legacy_mailgun_job_id,'
     ) = 0 THEN
    RAISE EXCEPTION 'Founder reply dual-correlation rewrite is incomplete'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE recorder_definition;
END
$replace_recorder$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mailgun_webhook_definer;

DO $repair_audit$
DECLARE
  recorder_oid oid := pg_catalog.to_regprocedure(
    'app_private.record_property_predator_owned_seed_mailgun_inbound(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,bytea,bytea,bytea,timestamp with time zone,bytea,bytea,bytea,bytea)'
  );
  recorder_source text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(recorder_oid) INTO recorder_source;
  IF recorder_oid IS NULL
     OR recorder_source IS NULL
     OR pg_catalog.strpos(
       recorder_source,
       'app.property_predator_customer_email_jobs'
     ) = 0
     OR pg_catalog.strpos(
       recorder_source,
       'app.property_predator_mailgun_jobs'
     ) = 0
     OR pg_catalog.strpos(
       recorder_source,
       'AND job.state = ''succeeded'''
     ) = 0
     OR pg_catalog.strpos(
       recorder_source,
       'AND job.state = ''settled'''
     ) = 0
     OR pg_catalog.strpos(
       recorder_source,
       'lower(point.normalized_value) = p_normalized_sender'
     ) = 0
     OR pg_catalog.strpos(
       recorder_source,
       'customer_email_job_id, legacy_mailgun_job_id,'
     ) = 0
     OR NOT pg_catalog.has_table_privilege(
       'r72_mailgun_webhook_definer',
       'app.property_predator_customer_email_jobs',
       'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'r72_mailgun_webhook_definer',
       'app.property_predator_mailgun_jobs',
       'SELECT'
     )
     OR NOT pg_catalog.has_function_privilege(
       'r72_mailgun_webhook_command', recorder_oid, 'EXECUTE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_mailgun_webhook_command',
       'app.property_predator_customer_email_jobs',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_mailgun_webhook_command',
       'app.property_predator_mailgun_jobs',
       'SELECT'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_record
       WHERE constraint_record.conrelid =
         'app.property_predator_mailgun_inbound_receipts'::regclass
         AND constraint_record.confrelid =
           'app.property_predator_customer_email_jobs'::regclass
         AND constraint_record.contype = 'f'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_record
       WHERE constraint_record.conrelid =
         'app.property_predator_mailgun_inbound_receipts'::regclass
         AND constraint_record.confrelid =
           'app.property_predator_mailgun_jobs'::regclass
         AND constraint_record.contype = 'f'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure
       JOIN pg_catalog.pg_roles AS owner_role
         ON owner_role.oid = procedure.proowner
       WHERE procedure.oid = recorder_oid
         AND owner_role.rolname = 'r72_mailgun_webhook_definer'
         AND procedure.prosecdef
         AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
     ) THEN
    RAISE EXCEPTION 'Founder reply dual-job correlation repair is incomplete'
      USING ERRCODE = '42501';
  END IF;
END
$repair_audit$;

RESET ROLE;
