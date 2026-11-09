-- PostgreSQL parses LEAST as special SQL syntax, not as a normal pg_catalog
-- function. Recreate the lease-renewal boundary without schema-qualifying it.

SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_setup_delivery_definer;
SET LOCAL ROLE r72_setup_delivery_definer;

CREATE OR REPLACE FUNCTION app_private.renew_account_setup_delivery_lease(
  p_delivery_id uuid,
  p_lease_token_hash bytea,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (lease_expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_delivery_id IS NULL
     OR p_lease_token_hash IS NULL
     OR octet_length(p_lease_token_hash) <> 32
     OR p_lease_seconds IS NULL
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE app_private.account_setup_deliveries AS delivery
     SET lease_expires_at = least(
           statement_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
           action_token.expires_at
         ),
         updated_at = statement_timestamp()
    FROM app.identity_action_tokens AS action_token
   WHERE delivery.id = p_delivery_id
     AND delivery.action_token_id = action_token.id
     AND delivery.state = 'leased'
     AND delivery.superseded_at IS NULL
     AND delivery.lease_token_hash = p_lease_token_hash
     AND delivery.lease_expires_at > statement_timestamp()
     AND action_token.consumed_at IS NULL
     AND action_token.revoked_at IS NULL
     AND action_token.expires_at > statement_timestamp()
  RETURNING delivery.lease_expires_at;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_setup_delivery_definer;
REVOKE ALL ON FUNCTION app_private.renew_account_setup_delivery_lease(
  uuid, bytea, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.renew_account_setup_delivery_lease(
  uuid, bytea, integer
) TO r72_setup_delivery_command;
