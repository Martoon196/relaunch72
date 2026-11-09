-- Generated campaign drafts are appended by r72_content_adapter through the
-- existing companyContent.createVersion write transaction. A portal-session
-- write must lock and revalidate that exact session before any immutable
-- content row is inserted. This grants only that existing session fence; it
-- adds no approval, scheduling, provider-operation or mutable-content power.

SET LOCAL ROLE r72_owner;

GRANT EXECUTE ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  TO r72_content_adapter;
