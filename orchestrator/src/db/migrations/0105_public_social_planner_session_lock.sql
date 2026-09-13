-- Portal planning writes use the existing transaction-level session fence.
-- Permit that check, not a bypass: invalid/revoked sessions still return false.
-- No table, provider, approval or membership privileges are added.
SET LOCAL ROLE r72_owner;

GRANT EXECUTE ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  TO r72_public_social_command;
