-- Operator API OAuth state for claude.ai connectors. Additive only: three private
-- tables and definer functions; no existing table changes.
--
-- Fixes the two review findings on the stateless design:
--   * an authorization code is single use across every instance and restart:
--     redemption locks the code row, and a second presentation revokes every
--     token issued from it;
--   * refresh tokens are stored as hashes, bound to the registered client, and
--     rotated on every use; presenting an already-rotated refresh token, or one
--     from another client, revokes the whole grant.
-- Access tokens are opaque and resolved against the database on every call, so
-- one connection can be revoked without rotating a server secret. Only SHA-256
-- hashes of codes, tokens, client ids and redirect URIs are stored.

SET LOCAL ROLE r72_owner;

CREATE TABLE app_private.operator_oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id uuid NOT NULL REFERENCES app.users(id),
  client_id_hash bytea NOT NULL CHECK (octet_length(client_id_hash) = 32),
  client_name text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('owner', 'client', 'code_replay', 'refresh_reuse', 'client_mismatch')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE TABLE app_private.operator_oauth_codes (
  code_hash bytea PRIMARY KEY CHECK (octet_length(code_hash) = 32),
  client_id_hash bytea NOT NULL CHECK (octet_length(client_id_hash) = 32),
  client_name text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 100),
  redirect_uri_hash bytea NOT NULL CHECK (octet_length(redirect_uri_hash) = 32),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  subject_user_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  consumed_at timestamptz,
  grant_id uuid REFERENCES app_private.operator_oauth_grants(id),
  CHECK ((consumed_at IS NULL) = (grant_id IS NULL))
);
CREATE INDEX operator_oauth_codes_expires_idx ON app_private.operator_oauth_codes (expires_at);

CREATE TABLE app_private.operator_oauth_tokens (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  grant_id uuid NOT NULL REFERENCES app_private.operator_oauth_grants(id),
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  rotated_at timestamptz,
  CHECK (kind = 'refresh' OR rotated_at IS NULL)
);
CREATE INDEX operator_oauth_tokens_grant_idx ON app_private.operator_oauth_tokens (grant_id);
CREATE INDEX operator_oauth_tokens_expires_idx ON app_private.operator_oauth_tokens (expires_at);

REVOKE ALL ON app_private.operator_oauth_grants, app_private.operator_oauth_codes, app_private.operator_oauth_tokens FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_private.operator_oauth_grants, app_private.operator_oauth_codes, app_private.operator_oauth_tokens
  TO r72_security_definer;

GRANT CREATE ON SCHEMA app_private TO r72_security_definer;
SET LOCAL ROLE r72_security_definer;

-- Store a consented, not yet redeemed authorization code (two minutes).
CREATE FUNCTION app_private.operator_oauth_issue_code(
  p_code_hash bytea, p_client_id_hash bytea, p_client_name text, p_redirect_uri_hash bytea,
  p_code_challenge text, p_subject_user_id uuid, p_now timestamptz, p_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
BEGIN
  IF p_code_hash IS NULL OR p_client_id_hash IS NULL OR p_redirect_uri_hash IS NULL OR p_subject_user_id IS NULL
     OR p_now IS NULL OR p_expires_at IS NULL THEN
    RAISE EXCEPTION 'invalid operator code input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.users WHERE id = p_subject_user_id AND status = 'active') THEN
    RETURN false;
  END IF;
  -- Bounded housekeeping: expired codes and long-dead tokens go first.
  DELETE FROM app_private.operator_oauth_codes
   WHERE ctid IN (SELECT ctid FROM app_private.operator_oauth_codes WHERE expires_at < p_now - interval '1 day' LIMIT 200);
  DELETE FROM app_private.operator_oauth_tokens
   WHERE ctid IN (SELECT ctid FROM app_private.operator_oauth_tokens WHERE expires_at < p_now - interval '1 day' LIMIT 200);
  INSERT INTO app_private.operator_oauth_codes (
    code_hash, client_id_hash, client_name, redirect_uri_hash, code_challenge, subject_user_id, created_at, expires_at
  ) VALUES (
    p_code_hash, p_client_id_hash, p_client_name, p_redirect_uri_hash, p_code_challenge, p_subject_user_id, p_now, p_expires_at
  );
  RETURN true;
END
$function$;

-- Exchange a code once, across every instance. A replayed code revokes its grant.
CREATE FUNCTION app_private.operator_oauth_redeem_code(
  p_code_hash bytea, p_client_id_hash bytea, p_redirect_uri_hash bytea, p_verifier_challenge text,
  p_access_hash bytea, p_access_expires_at timestamptz, p_refresh_hash bytea, p_refresh_expires_at timestamptz, p_now timestamptz
) RETURNS TABLE (outcome text, subject_user_id uuid, grant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  code app_private.operator_oauth_codes%ROWTYPE;
  new_grant uuid;
BEGIN
  IF p_access_hash IS NULL OR p_refresh_hash IS NULL OR p_access_hash = p_refresh_hash OR p_now IS NULL THEN
    RAISE EXCEPTION 'invalid operator redemption input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO code FROM app_private.operator_oauth_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF code.consumed_at IS NOT NULL THEN
    UPDATE app_private.operator_oauth_grants SET revoked_at = p_now, revoked_reason = 'code_replay'
     WHERE id = code.grant_id AND revoked_at IS NULL;
    RETURN QUERY SELECT 'replayed'::text, NULL::uuid, code.grant_id; RETURN;
  END IF;
  IF code.expires_at <= p_now OR code.client_id_hash <> p_client_id_hash OR code.redirect_uri_hash <> p_redirect_uri_hash
     OR code.code_challenge <> p_verifier_challenge
     OR NOT EXISTS (SELECT 1 FROM app.users WHERE id = code.subject_user_id AND status = 'active') THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  INSERT INTO app_private.operator_oauth_grants (subject_user_id, client_id_hash, client_name, created_at, last_used_at)
  VALUES (code.subject_user_id, code.client_id_hash, code.client_name, p_now, p_now)
  RETURNING id INTO new_grant;
  UPDATE app_private.operator_oauth_codes SET consumed_at = p_now, grant_id = new_grant WHERE code_hash = p_code_hash;
  INSERT INTO app_private.operator_oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES
    (p_access_hash, new_grant, 'access', p_now, p_access_expires_at),
    (p_refresh_hash, new_grant, 'refresh', p_now, p_refresh_expires_at);
  RETURN QUERY SELECT 'issued'::text, code.subject_user_id, new_grant;
END
$function$;

-- Rotate a refresh token. Reuse of a rotated token, or a different client, revokes the grant.
CREATE FUNCTION app_private.operator_oauth_refresh(
  p_refresh_hash bytea, p_client_id_hash bytea, p_access_hash bytea, p_access_expires_at timestamptz,
  p_new_refresh_hash bytea, p_refresh_expires_at timestamptz, p_now timestamptz
) RETURNS TABLE (outcome text, subject_user_id uuid, grant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  token app_private.operator_oauth_tokens%ROWTYPE;
  owner app_private.operator_oauth_grants%ROWTYPE;
BEGIN
  IF p_access_hash IS NULL OR p_new_refresh_hash IS NULL OR p_access_hash = p_new_refresh_hash OR p_now IS NULL THEN
    RAISE EXCEPTION 'invalid operator refresh input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO token FROM app_private.operator_oauth_tokens WHERE token_hash = p_refresh_hash AND kind = 'refresh' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  SELECT * INTO owner FROM app_private.operator_oauth_grants WHERE id = token.grant_id FOR UPDATE;
  IF owner.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, owner.id; RETURN;
  END IF;
  IF owner.client_id_hash <> p_client_id_hash THEN
    UPDATE app_private.operator_oauth_grants SET revoked_at = p_now, revoked_reason = 'client_mismatch' WHERE id = owner.id;
    RETURN QUERY SELECT 'client_mismatch'::text, NULL::uuid, owner.id; RETURN;
  END IF;
  IF token.rotated_at IS NOT NULL THEN
    UPDATE app_private.operator_oauth_grants SET revoked_at = p_now, revoked_reason = 'refresh_reuse' WHERE id = owner.id;
    RETURN QUERY SELECT 'reused'::text, NULL::uuid, owner.id; RETURN;
  END IF;
  IF token.expires_at <= p_now OR NOT EXISTS (SELECT 1 FROM app.users WHERE id = owner.subject_user_id AND status = 'active') THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, owner.id; RETURN;
  END IF;
  UPDATE app_private.operator_oauth_tokens SET rotated_at = p_now WHERE token_hash = p_refresh_hash;
  INSERT INTO app_private.operator_oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES
    (p_access_hash, owner.id, 'access', p_now, p_access_expires_at),
    (p_new_refresh_hash, owner.id, 'refresh', p_now, p_refresh_expires_at);
  UPDATE app_private.operator_oauth_grants SET last_used_at = p_now WHERE id = owner.id;
  RETURN QUERY SELECT 'issued'::text, owner.subject_user_id, owner.id;
END
$function$;

-- Resolve a presented access token: live token, live grant, active user.
CREATE FUNCTION app_private.operator_oauth_resolve(p_access_hash bytea, p_now timestamptz)
RETURNS TABLE (subject_user_id uuid, grant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT g.subject_user_id, g.id
    FROM app_private.operator_oauth_tokens AS t
    JOIN app_private.operator_oauth_grants AS g ON g.id = t.grant_id
    JOIN app.users AS u ON u.id = g.subject_user_id
   WHERE t.token_hash = p_access_hash AND t.kind = 'access' AND t.expires_at > p_now
     AND g.revoked_at IS NULL AND u.status = 'active'
$function$;

-- RFC 7009: a client revokes its own token; the whole grant ends.
CREATE FUNCTION app_private.operator_oauth_revoke_token(p_token_hash bytea, p_client_id_hash bytea, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE target uuid;
BEGIN
  SELECT g.id INTO target
    FROM app_private.operator_oauth_tokens AS t JOIN app_private.operator_oauth_grants AS g ON g.id = t.grant_id
   WHERE t.token_hash = p_token_hash AND g.client_id_hash = p_client_id_hash AND g.revoked_at IS NULL
   FOR UPDATE OF g;
  IF target IS NULL THEN RETURN false; END IF;
  UPDATE app_private.operator_oauth_grants SET revoked_at = p_now, revoked_reason = 'client' WHERE id = target;
  RETURN true;
END
$function$;

-- The owner's own list of connected clients, newest first.
CREATE FUNCTION app_private.operator_oauth_list_grants(p_subject_user_id uuid)
RETURNS TABLE (grant_id uuid, client_name text, created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz, revoked_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT id, client_name, created_at, last_used_at, revoked_at, revoked_reason
    FROM app_private.operator_oauth_grants
   WHERE subject_user_id = p_subject_user_id
   ORDER BY created_at DESC
   LIMIT 50
$function$;

-- The owner revokes one connection.
CREATE FUNCTION app_private.operator_oauth_revoke_grant(p_subject_user_id uuid, p_grant_id uuid, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
BEGIN
  UPDATE app_private.operator_oauth_grants SET revoked_at = p_now, revoked_reason = 'owner'
   WHERE id = p_grant_id AND subject_user_id = p_subject_user_id AND revoked_at IS NULL;
  RETURN FOUND;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;

REVOKE ALL ON FUNCTION
  app_private.operator_oauth_issue_code(bytea, bytea, text, bytea, text, uuid, timestamptz, timestamptz),
  app_private.operator_oauth_redeem_code(bytea, bytea, bytea, text, bytea, timestamptz, bytea, timestamptz, timestamptz),
  app_private.operator_oauth_refresh(bytea, bytea, bytea, timestamptz, bytea, timestamptz, timestamptz),
  app_private.operator_oauth_resolve(bytea, timestamptz),
  app_private.operator_oauth_revoke_token(bytea, bytea, timestamptz),
  app_private.operator_oauth_list_grants(uuid),
  app_private.operator_oauth_revoke_grant(uuid, uuid, timestamptz)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app_private.operator_oauth_issue_code(bytea, bytea, text, bytea, text, uuid, timestamptz, timestamptz),
  app_private.operator_oauth_redeem_code(bytea, bytea, bytea, text, bytea, timestamptz, bytea, timestamptz, timestamptz),
  app_private.operator_oauth_refresh(bytea, bytea, bytea, timestamptz, bytea, timestamptz, timestamptz),
  app_private.operator_oauth_resolve(bytea, timestamptz),
  app_private.operator_oauth_revoke_token(bytea, bytea, timestamptz),
  app_private.operator_oauth_list_grants(uuid),
  app_private.operator_oauth_revoke_grant(uuid, uuid, timestamptz)
TO r72_identity_command;
