-- Let the isolated company-asset roles revalidate the already-resolved portal
-- session inside their own transaction. The adapter receives only snapshot-safe
-- validation; the command role receives only lock-and-validate. Neither role can
-- resolve, create, revoke or inspect sessions directly.

SET LOCAL ROLE r72_owner;

REVOKE ALL ON FUNCTION app_private.active_portal_session(bytea, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  FROM r72_content_adapter;
REVOKE EXECUTE ON FUNCTION app_private.active_portal_session(bytea, uuid, uuid)
  FROM r72_content_command;

GRANT EXECUTE ON FUNCTION app_private.active_portal_session(bytea, uuid, uuid)
  TO r72_content_adapter;
GRANT EXECUTE ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  TO r72_content_command;
