-- Bind founder reply ingress to the live customer-email job that actually
-- created the delivery. The retired owned-seed Mailgun queue is empty in the
-- founder lifecycle, so using it as the correlation source makes every valid
-- reply terminally unmatched.

SET LOCAL ROLE r72_owner;

DO $empty_legacy_receipts$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.property_predator_mailgun_inbound_receipts
  ) THEN
    RAISE EXCEPTION 'Founder reply receipt job binding cannot be changed with legacy receipts present'
      USING ERRCODE = '55000';
  END IF;
END
$empty_legacy_receipts$;

ALTER TABLE app.property_predator_mailgun_inbound_receipts
  DROP CONSTRAINT property_predator_mailgun_inbo_workspace_id_mailgun_job_id_fkey;
ALTER TABLE app.property_predator_mailgun_inbound_receipts
  RENAME COLUMN mailgun_job_id TO customer_email_job_id;
ALTER TABLE app.property_predator_mailgun_inbound_receipts
  ADD CONSTRAINT property_predator_mailgun_inbound_customer_email_job_fkey
  FOREIGN KEY (workspace_id, customer_email_job_id)
  REFERENCES app.property_predator_customer_email_jobs (workspace_id, id)
  ON DELETE RESTRICT;

DROP POLICY IF EXISTS property_predator_mailgun_jobs_inbound_definer_select
  ON app.property_predator_mailgun_jobs;
REVOKE SELECT ON app.property_predator_mailgun_jobs
  FROM r72_mailgun_webhook_definer;

GRANT SELECT ON app.property_predator_customer_email_jobs
  TO r72_mailgun_webhook_definer;
CREATE POLICY customer_email_jobs_mailgun_inbound_definer_select
  ON app.property_predator_customer_email_jobs
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
BEGIN
  SELECT pg_catalog.pg_get_functiondef(recorder_oid) INTO recorder_definition;
  IF recorder_oid IS NULL
     OR recorder_definition IS NULL
     OR pg_catalog.strpos(
       recorder_definition,
       'selected_job app.property_predator_mailgun_jobs%ROWTYPE;'
     ) = 0
     OR pg_catalog.strpos(
       recorder_definition,
       'FROM app.property_predator_mailgun_jobs AS job'
     ) = 0
     OR pg_catalog.strpos(
       recorder_definition,
       'AND job.state = ''settled'''
     ) = 0
     OR pg_catalog.strpos(
       recorder_definition,
       'mailgun_job_id,'
     ) = 0 THEN
    RAISE EXCEPTION 'Founder reply recorder source is not the reviewed 0072 definition'
      USING ERRCODE = '55000';
  END IF;

  recorder_definition := pg_catalog.replace(
    recorder_definition,
    'selected_job app.property_predator_mailgun_jobs%ROWTYPE;',
    'selected_job app.property_predator_customer_email_jobs%ROWTYPE;'
  );
  recorder_definition := pg_catalog.replace(
    recorder_definition,
    'FROM app.property_predator_mailgun_jobs AS job',
    'FROM app.property_predator_customer_email_jobs AS job'
  );
  recorder_definition := pg_catalog.replace(
    recorder_definition,
    'AND job.state = ''settled''',
    'AND job.state = ''succeeded'''
  );
  recorder_definition := pg_catalog.replace(
    recorder_definition,
    'mailgun_job_id,',
    'customer_email_job_id,'
  );

  IF pg_catalog.strpos(
       recorder_definition,
       'app.property_predator_mailgun_jobs'
     ) <> 0
     OR pg_catalog.strpos(
       recorder_definition,
       'app.property_predator_customer_email_jobs'
     ) = 0
     OR pg_catalog.strpos(
       recorder_definition,
       'AND job.state = ''succeeded'''
     ) = 0
     OR pg_catalog.strpos(
       recorder_definition,
       'customer_email_job_id,'
     ) = 0
     OR pg_catalog.strpos(
       recorder_definition,
       'mailgun_job_id,'
     ) <> 0 THEN
    RAISE EXCEPTION 'Founder reply recorder correlation rewrite is incomplete'
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
       'AND job.state = ''succeeded'''
     ) = 0
     OR pg_catalog.strpos(
       recorder_source,
       'app.property_predator_mailgun_jobs'
     ) <> 0
     OR pg_catalog.strpos(
       recorder_source,
       'customer_email_job_id,'
     ) = 0
     OR pg_catalog.strpos(
       recorder_source,
       'mailgun_job_id,'
     ) <> 0
     OR pg_catalog.strpos(
       recorder_source,
       'lower(point.normalized_value) = p_normalized_sender'
     ) = 0
     OR pg_catalog.has_table_privilege(
       'r72_mailgun_webhook_definer',
       'app.property_predator_mailgun_jobs',
       'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'r72_mailgun_webhook_definer',
       'app.property_predator_customer_email_jobs',
       'SELECT'
     )
     OR NOT pg_catalog.has_function_privilege(
       'r72_mailgun_webhook_command', recorder_oid, 'EXECUTE'
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
       FROM pg_catalog.pg_proc AS procedure
       JOIN pg_catalog.pg_roles AS owner_role
         ON owner_role.oid = procedure.proowner
       WHERE procedure.oid = recorder_oid
         AND owner_role.rolname = 'r72_mailgun_webhook_definer'
         AND procedure.prosecdef
         AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
     ) THEN
    RAISE EXCEPTION 'Founder reply live-job correlation repair is incomplete'
      USING ERRCODE = '42501';
  END IF;
END
$repair_audit$;

RESET ROLE;
