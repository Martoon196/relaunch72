-- Expose only the provider-account digest to the portal connection service.
-- Messaging keeps the clear provider ID in runtime configuration, proves it
-- against this digest, and never confuses it with the internal account UUID.

SET LOCAL ROLE r72_owner;

DROP FUNCTION app_private.read_zernio_social_accounts(uuid,uuid,bytea);

CREATE FUNCTION app_private.read_zernio_social_accounts(
  p_workspace_id uuid, p_provider_connection_id uuid, p_provider_profile_id_sha256 bytea
) RETURNS TABLE(
  account_id uuid, provider_account_id_sha256 bytea, network text, username text,
  display_name text, status text, linked_at timestamptz, last_event_at timestamptz,
  webhook_receipt_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT account.id, account.provider_account_id_sha256, account.network,
    account.username, account.display_name, account.status, account.linked_at,
    account.last_event_at,
    (SELECT count(*) FROM app.property_predator_zernio_account_webhook_receipts receipt
     WHERE receipt.workspace_id = account.workspace_id
       AND receipt.provider_connection_id = account.provider_connection_id
       AND receipt.provider_account_id_sha256 = account.provider_account_id_sha256)
  FROM app.property_predator_zernio_accounts account
  WHERE session_user = 'r72_zernio_social_command'
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'user'
    AND account.workspace_id = p_workspace_id
    AND account.provider_connection_id = p_provider_connection_id
    AND account.provider_profile_id_sha256 = p_provider_profile_id_sha256
  ORDER BY account.network, account.created_at, account.id
$function$;

REVOKE ALL ON FUNCTION app_private.read_zernio_social_accounts(uuid,uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.read_zernio_social_accounts(uuid,uuid,bytea)
  TO r72_zernio_social_command;

RESET ROLE;
