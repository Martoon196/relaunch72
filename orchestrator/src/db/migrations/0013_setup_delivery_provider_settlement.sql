-- Provider-aware settlement for the durable account-setup delivery queue.
-- A delivery is never called sent without a fenced, persisted provider
-- acceptance reference. Permanent provider failures terminalize immediately.

SET LOCAL ROLE r72_owner;

ALTER TABLE app_private.account_setup_deliveries
  ADD COLUMN provider_id text,
  ADD COLUMN provider_reference_id text,
  ADD COLUMN provider_accepted_at timestamptz,
  ADD COLUMN acceptance_recorded_at timestamptz;

ALTER TABLE app_private.account_setup_deliveries
  ADD CONSTRAINT account_setup_deliveries_provider_id_ck CHECK (
    provider_id IS NULL
    OR (
      provider_id = btrim(provider_id)
      AND length(provider_id) BETWEEN 1 AND 50
      AND provider_id ~ '^[a-z0-9][a-z0-9._:-]{0,49}$'
    )
  ),
  ADD CONSTRAINT account_setup_deliveries_provider_reference_ck CHECK (
    provider_reference_id IS NULL
    OR (
      provider_reference_id = btrim(provider_reference_id)
      AND length(provider_reference_id) BETWEEN 1 AND 255
      AND provider_reference_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    )
  ),
  ADD CONSTRAINT account_setup_deliveries_acceptance_shape_ck CHECK (
    (
      provider_id IS NULL
      AND provider_reference_id IS NULL
      AND provider_accepted_at IS NULL
      AND acceptance_recorded_at IS NULL
    )
    OR
    (
      state = 'delivered'
      AND provider_id IS NOT NULL
      AND provider_reference_id IS NOT NULL
      AND provider_accepted_at IS NOT NULL
      AND acceptance_recorded_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT account_setup_deliveries_acceptance_chronology_ck CHECK (
    acceptance_recorded_at IS NULL
    OR (
      acceptance_recorded_at >= created_at
      AND delivered_at = acceptance_recorded_at
      AND provider_accepted_at >= created_at - interval '5 minutes'
      AND provider_accepted_at <= acceptance_recorded_at + interval '5 minutes'
    )
  );

CREATE UNIQUE INDEX account_setup_deliveries_provider_reference_uq
  ON app_private.account_setup_deliveries (provider_id, provider_reference_id)
  WHERE provider_id IS NOT NULL AND provider_reference_id IS NOT NULL;

REVOKE ALL ON FUNCTION app_private.acknowledge_account_setup_delivery(uuid, bytea)
  FROM r72_setup_delivery_command;

-- Recreate the claim primitive under its existing isolated owner so the first
-- lease, like renewal, can never outlive the single-use setup credential.
GRANT CREATE ON SCHEMA app_private TO r72_setup_delivery_definer;
SET LOCAL ROLE r72_setup_delivery_definer;

CREATE OR REPLACE FUNCTION app_private.claim_account_setup_deliveries(
  p_lease_token_hash bytea,
  p_batch_size integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  delivery_id uuid,
  user_id uuid,
  workspace_id uuid,
  action_token_id uuid,
  payload_version smallint,
  encryption_key_id text,
  encryption_iv bytea,
  encrypted_payload bytea,
  authentication_tag bytea,
  recipient_email_hash bytea,
  aad_context bytea,
  attempt_count smallint,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_lease_token_hash IS NULL
     OR octet_length(p_lease_token_hash) <> 32
     OR p_batch_size IS NULL
     OR p_batch_size NOT BETWEEN 1 AND 25
     OR p_lease_seconds IS NULL
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'invalid setup delivery claim input' USING ERRCODE = '22023';
  END IF;

  WITH terminal_candidates AS (
    SELECT delivery.id
    FROM app_private.account_setup_deliveries AS delivery
    WHERE delivery.state IN ('pending', 'leased', 'retry')
      AND delivery.superseded_at IS NULL
      AND (
        (delivery.state = 'leased'
          AND delivery.lease_expires_at <= statement_timestamp()
          AND delivery.attempt_count >= 8)
        OR NOT EXISTS (
          SELECT 1
          FROM app.identity_action_tokens AS action_token
          JOIN app.users AS person ON person.id = action_token.user_id
          WHERE action_token.id = delivery.action_token_id
            AND action_token.user_id = delivery.user_id
            AND action_token.workspace_id = delivery.workspace_id
            AND action_token.purpose = 'account_setup'
            AND action_token.consumed_at IS NULL
            AND action_token.revoked_at IS NULL
            AND action_token.expires_at > statement_timestamp()
            AND person.status = 'pending'
            AND person.password_hash IS NULL
        )
      )
    ORDER BY delivery.updated_at, delivery.id
    FOR UPDATE OF delivery SKIP LOCKED
    LIMIT 25
  )
  UPDATE app_private.account_setup_deliveries AS delivery
     SET state = 'dead_letter',
         encryption_iv = NULL,
         encrypted_payload = NULL,
         authentication_tag = NULL,
         lease_token_hash = NULL,
         lease_expires_at = NULL,
         last_error_code = CASE
           WHEN delivery.attempt_count >= 8 THEN 'retry_limit_exhausted'
           ELSE 'setup_token_expired'
         END,
         dead_lettered_at = statement_timestamp(),
         updated_at = statement_timestamp()
    FROM terminal_candidates
   WHERE delivery.id = terminal_candidates.id;

  RETURN QUERY
  WITH candidates AS (
    SELECT delivery.id, action_token.expires_at AS setup_expires_at
    FROM app_private.account_setup_deliveries AS delivery
    JOIN app.identity_action_tokens AS action_token
      ON action_token.id = delivery.action_token_id
     AND action_token.user_id = delivery.user_id
     AND action_token.workspace_id = delivery.workspace_id
    JOIN app.users AS person ON person.id = delivery.user_id
    WHERE delivery.superseded_at IS NULL
      AND delivery.encrypted_payload IS NOT NULL
      AND delivery.attempt_count < 8
      AND (
        (delivery.state IN ('pending', 'retry')
          AND delivery.available_at <= statement_timestamp())
        OR
        (delivery.state = 'leased'
          AND delivery.lease_expires_at <= statement_timestamp())
      )
      AND action_token.purpose = 'account_setup'
      AND action_token.consumed_at IS NULL
      AND action_token.revoked_at IS NULL
      AND action_token.expires_at > statement_timestamp()
      AND person.status = 'pending'
      AND person.password_hash IS NULL
    ORDER BY delivery.available_at, delivery.created_at, delivery.id
    FOR UPDATE OF delivery SKIP LOCKED
    LIMIT p_batch_size
  ), claimed AS (
    UPDATE app_private.account_setup_deliveries AS delivery
       SET state = 'leased',
           lease_token_hash = p_lease_token_hash,
           lease_expires_at = least(
             statement_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
             candidates.setup_expires_at
           ),
           attempt_count = delivery.attempt_count + 1,
           last_error_code = NULL,
           updated_at = statement_timestamp()
      FROM candidates
     WHERE delivery.id = candidates.id
    RETURNING delivery.*
  )
  SELECT claimed.id,
         claimed.user_id,
         claimed.workspace_id,
         claimed.action_token_id,
         claimed.payload_version,
         claimed.encryption_key_id,
         claimed.encryption_iv,
         claimed.encrypted_payload,
         claimed.authentication_tag,
         claimed.recipient_email_hash,
         pg_catalog.convert_to('r72/setup-link/v1', 'UTF8')
           || pg_catalog.decode('00', 'hex')
           || pg_catalog.convert_to(pg_catalog.lower(claimed.id::text), 'UTF8'),
         claimed.attempt_count,
         claimed.lease_expires_at
  FROM claimed
  ORDER BY claimed.created_at, claimed.id;
END
$function$;

CREATE FUNCTION app_private.acknowledge_account_setup_delivery_acceptance(
  p_delivery_id uuid,
  p_lease_token_hash bytea,
  p_provider_id text,
  p_provider_reference_id text,
  p_provider_accepted_at timestamptz
)
RETURNS TABLE (
  delivered_at timestamptz,
  provider_id text,
  provider_reference_id text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  normalized_provider_id text := pg_catalog.btrim(p_provider_id);
  normalized_provider_reference text := pg_catalog.btrim(p_provider_reference_id);
BEGIN
  IF p_delivery_id IS NULL
     OR p_lease_token_hash IS NULL
     OR octet_length(p_lease_token_hash) <> 32
     OR p_provider_id IS NULL
     OR normalized_provider_id <> p_provider_id
     OR length(normalized_provider_id) NOT BETWEEN 1 AND 50
     OR normalized_provider_id !~ '^[a-z0-9][a-z0-9._:-]{0,49}$'
     OR p_provider_reference_id IS NULL
     OR normalized_provider_reference <> p_provider_reference_id
     OR length(normalized_provider_reference) NOT BETWEEN 1 AND 255
     OR normalized_provider_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
     OR p_provider_accepted_at IS NULL
     OR p_provider_accepted_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid setup delivery provider acceptance input'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE app_private.account_setup_deliveries AS delivery
     SET state = 'delivered',
         encryption_iv = NULL,
         encrypted_payload = NULL,
         authentication_tag = NULL,
         lease_token_hash = NULL,
         lease_expires_at = NULL,
         provider_id = normalized_provider_id,
         provider_reference_id = normalized_provider_reference,
         provider_accepted_at = p_provider_accepted_at,
         acceptance_recorded_at = statement_timestamp(),
         delivered_at = statement_timestamp(),
         updated_at = statement_timestamp()
   WHERE delivery.id = p_delivery_id
     AND delivery.state = 'leased'
     AND delivery.superseded_at IS NULL
     AND delivery.lease_token_hash = p_lease_token_hash
     AND delivery.lease_expires_at > statement_timestamp()
     AND p_provider_accepted_at >= delivery.created_at - interval '5 minutes'
  RETURNING delivery.delivered_at, delivery.provider_id,
            delivery.provider_reference_id;
END
$function$;

CREATE FUNCTION app_private.reject_account_setup_delivery_permanently(
  p_delivery_id uuid,
  p_lease_token_hash bytea,
  p_error_code text
)
RETURNS TABLE (dead_lettered_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  normalized_error_code text := pg_catalog.btrim(p_error_code);
BEGIN
  IF p_delivery_id IS NULL
     OR p_lease_token_hash IS NULL
     OR octet_length(p_lease_token_hash) <> 32
     OR p_error_code IS NULL
     OR normalized_error_code <> p_error_code
     OR length(normalized_error_code) NOT BETWEEN 1 AND 100
     OR normalized_error_code !~ '^[a-z0-9][a-z0-9._:-]{0,99}$' THEN
    RAISE EXCEPTION 'invalid permanent setup delivery rejection input'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE app_private.account_setup_deliveries AS delivery
     SET state = 'dead_letter',
         encryption_iv = NULL,
         encrypted_payload = NULL,
         authentication_tag = NULL,
         lease_token_hash = NULL,
         lease_expires_at = NULL,
         last_error_code = normalized_error_code,
         dead_lettered_at = statement_timestamp(),
         updated_at = statement_timestamp()
   WHERE delivery.id = p_delivery_id
     AND delivery.state = 'leased'
     AND delivery.superseded_at IS NULL
     AND delivery.lease_token_hash = p_lease_token_hash
     AND delivery.lease_expires_at > statement_timestamp()
  RETURNING delivery.dead_lettered_at;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_setup_delivery_definer;

REVOKE ALL ON FUNCTION app_private.claim_account_setup_deliveries(
  bytea, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.acknowledge_account_setup_delivery_acceptance(
  uuid, bytea, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reject_account_setup_delivery_permanently(
  uuid, bytea, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.claim_account_setup_deliveries(
  bytea, integer, integer
) TO r72_setup_delivery_command;
GRANT EXECUTE ON FUNCTION app_private.acknowledge_account_setup_delivery_acceptance(
  uuid, bytea, text, text, timestamptz
) TO r72_setup_delivery_command;
GRANT EXECUTE ON FUNCTION app_private.reject_account_setup_delivery_permanently(
  uuid, bytea, text
) TO r72_setup_delivery_command;
