-- PP-SMS-VERIFY-20261029: close the receipt trigger's default PUBLIC execute grant.
-- This is idempotent so the emergency production ACL repair remains valid.
SET LOCAL ROLE r72_owner;
REVOKE ALL ON FUNCTION app_private.reject_sms_phone_receipt_mutation() FROM PUBLIC;
