-- Repair the exact owned-social function ACLs after production evidence showed
-- their owner-default PUBLIC EXECUTE grants survived the original migrations.
-- This migration changes no data, creates no provider job and performs no call.

SET LOCAL ROLE r72_owned_social_definer;

REVOKE ALL ON FUNCTION app_private.record_owned_social_profile(
  uuid, uuid, uuid, text, bytea, bytea, text, bytea, bytea, bytea,
  bytea, bytea, bytea, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.revoke_owned_social_profile(
  uuid, uuid, uuid, bytea, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.enqueue_owned_social_job(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, bytea, bytea, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.claim_owned_social_job(
  uuid, uuid, bytea, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.load_owned_social_job(
  uuid, uuid, bigint, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.begin_owned_social_call(
  uuid, uuid, bigint, bytea, boolean, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.settle_owned_social_call(
  uuid, uuid, bigint, bytea, text, text, bytea, timestamptz, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.property_predator_owned_social_activation_readiness(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, bytea, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.record_owned_social_profile(
  uuid, uuid, uuid, text, bytea, bytea, text, bytea, bytea, bytea,
  bytea, bytea, bytea, timestamptz, timestamptz
) TO r72_owned_social_command;
GRANT EXECUTE ON FUNCTION app_private.revoke_owned_social_profile(
  uuid, uuid, uuid, bytea, text
) TO r72_owned_social_command;
GRANT EXECUTE ON FUNCTION app_private.enqueue_owned_social_job(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, bytea, bytea, timestamptz
) TO r72_owned_social_command;
GRANT EXECUTE ON FUNCTION app_private.property_predator_owned_social_activation_readiness(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, bytea, timestamptz
) TO r72_owned_social_command;

GRANT EXECUTE ON FUNCTION app_private.claim_owned_social_job(
  uuid, uuid, bytea, integer
) TO r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.load_owned_social_job(
  uuid, uuid, bigint, bytea
) TO r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.begin_owned_social_call(
  uuid, uuid, bigint, bytea, boolean, boolean
) TO r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.settle_owned_social_call(
  uuid, uuid, bigint, bytea, text, text, bytea, timestamptz, text
) TO r72_owned_social_worker_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;

DO $owned_social_acl_repair_audit$
DECLARE
  unexpected_public_function text;
  missing_command_function text;
  missing_worker_function text;
BEGIN
  SELECT procedure.oid::regprocedure::text
    INTO unexpected_public_function
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) AS privilege
  WHERE namespace.nspname = 'app_private'
    AND procedure.proname IN (
      'record_owned_social_profile', 'revoke_owned_social_profile',
      'enqueue_owned_social_job', 'claim_owned_social_job',
      'load_owned_social_job', 'begin_owned_social_call',
      'settle_owned_social_call',
      'property_predator_owned_social_activation_readiness'
    )
    AND privilege.grantee = 0
    AND privilege.privilege_type = 'EXECUTE'
  LIMIT 1;
  IF unexpected_public_function IS NOT NULL THEN
    RAISE EXCEPTION 'Owned-social function remains executable by PUBLIC: %',
      unexpected_public_function;
  END IF;

  SELECT required.signature INTO missing_command_function
  FROM (VALUES
    ('app_private.record_owned_social_profile(uuid,uuid,uuid,text,bytea,bytea,text,bytea,bytea,bytea,bytea,bytea,bytea,timestamp with time zone,timestamp with time zone)'),
    ('app_private.revoke_owned_social_profile(uuid,uuid,uuid,bytea,text)'),
    ('app_private.enqueue_owned_social_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,bytea,bytea,timestamp with time zone)'),
    ('app_private.property_predator_owned_social_activation_readiness(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,timestamp with time zone)')
  ) AS required(signature)
  WHERE NOT pg_catalog.has_function_privilege(
    'r72_owned_social_command', required.signature, 'EXECUTE'
  )
  LIMIT 1;
  IF missing_command_function IS NOT NULL THEN
    RAISE EXCEPTION 'Owned-social command function grant is missing: %',
      missing_command_function;
  END IF;

  SELECT required.signature INTO missing_worker_function
  FROM (VALUES
    ('app_private.claim_owned_social_job(uuid,uuid,bytea,integer)'),
    ('app_private.load_owned_social_job(uuid,uuid,bigint,bytea)'),
    ('app_private.begin_owned_social_call(uuid,uuid,bigint,bytea,boolean,boolean)'),
    ('app_private.settle_owned_social_call(uuid,uuid,bigint,bytea,text,text,bytea,timestamp with time zone,text)')
  ) AS required(signature)
  WHERE NOT pg_catalog.has_function_privilege(
    'r72_owned_social_worker_command', required.signature, 'EXECUTE'
  )
  LIMIT 1;
  IF missing_worker_function IS NOT NULL THEN
    RAISE EXCEPTION 'Owned-social worker function grant is missing: %',
      missing_worker_function;
  END IF;
END
$owned_social_acl_repair_audit$;

REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;
