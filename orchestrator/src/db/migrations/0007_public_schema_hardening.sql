-- Runtime roles are application capabilities, not general database tenants.
-- Older PostgreSQL defaults and upgraded databases may still let every role
-- create objects in public. Remove that ambient authority forward-only after
-- all current extensions have been installed by the migrator.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM
  r72_owner,
  r72_security_definer,
  r72_web,
  r72_public,
  r72_worker,
  r72_webhook,
  r72_readonly,
  r72_crm_command,
  r72_identity_command,
  r72_provisioning_command;

-- Extension functions such as public.digest remain callable where PostgreSQL's
-- extension grants permit it; no runtime identity may create/name-hijack an
-- object in this shared schema.
