-- Let the founder evidence LOGIN prove it reached the configured installation.
--
-- Portal composition verifies every least-privilege pool before retaining it.
-- Production proved that the evidence role could execute its command boundary
-- but could not execute this read-only installation identity check, so startup
-- silently discarded the pool and the founder action reported unavailable.

SET LOCAL ROLE r72_owner;

GRANT EXECUTE ON FUNCTION app_private.runtime_database_installation_id()
  TO r72_founder_pilot_evidence_command;

DO $repair_audit$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
       'r72_founder_pilot_evidence_command',
       'app_private.runtime_database_installation_id()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Founder pilot evidence command cannot prove installation identity'
      USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'r72_founder_pilot_evidence_command',
       'app_private.record_founder_pilot_compliance_evidence(uuid,uuid,uuid,uuid,text,text,text,bytea,jsonb,text,integer,bytea)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Founder pilot evidence command lost its command boundary'
      USING ERRCODE = '42501';
  END IF;
END
$repair_audit$;
