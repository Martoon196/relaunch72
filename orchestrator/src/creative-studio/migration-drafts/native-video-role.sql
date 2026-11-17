-- Native video function owner; no paid-provider schema dependency.
DO $role$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_native_video_definer') THEN
    CREATE ROLE r72_native_video_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_native_video_definer' AND NOT rolcanlogin AND NOT rolinherit
     AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_native_video_definer') THEN
    RAISE EXCEPTION 'Unsafe media job function-owner role' USING ERRCODE='42501';
  END IF;
  GRANT r72_native_video_definer TO r72_owner;
END $role$;
SET LOCAL ROLE r72_owner;

GRANT USAGE ON SCHEMA app,app_private,public TO r72_native_video_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_media_owner(uuid,bytea),app_private.current_workspace_id(),app_private.current_actor_kind() TO r72_native_video_definer;
