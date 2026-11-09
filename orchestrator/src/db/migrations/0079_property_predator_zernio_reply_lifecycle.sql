-- Durable, founder-controlled Instagram reply lifecycle for the live Zernio
-- Messaging surface. Draft and approval commands are database-only. A send is
-- possible only after an exact approval and a one-shot calling lease; an
-- ambiguous provider outcome can never be retried automatically.

SET LOCAL ROLE r72_owner;

CREATE TABLE app.property_predator_zernio_reply_drafts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  provider_profile_id_sha256 bytea NOT NULL CHECK (octet_length(provider_profile_id_sha256) = 32),
  provider_account_id_sha256 bytea NOT NULL CHECK (octet_length(provider_account_id_sha256) = 32),
  provider_conversation_id_sha256 bytea NOT NULL CHECK (octet_length(provider_conversation_id_sha256) = 32),
  network text NOT NULL DEFAULT 'instagram' CHECK (network = 'instagram'),
  body_text text NOT NULL CHECK (
    body_text = btrim(body_text)
    AND octet_length(convert_to(body_text, 'UTF8')) BETWEEN 1 AND 10000
  ),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  environment text NOT NULL DEFAULT 'live' CHECK (environment = 'live'),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, provider_connection_id, provider_account_id_sha256)
    REFERENCES app.property_predator_zernio_accounts
      (workspace_id, provider_connection_id, provider_account_id_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX property_predator_zernio_reply_drafts_target_idx
  ON app.property_predator_zernio_reply_drafts (
    workspace_id, provider_connection_id, provider_account_id_sha256,
    provider_conversation_id_sha256, created_at DESC, id DESC
  );

CREATE TABLE app.property_predator_zernio_reply_approval_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  draft_id uuid NOT NULL,
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  requested_by_user_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, draft_id),
  FOREIGN KEY (workspace_id, draft_id)
    REFERENCES app.property_predator_zernio_reply_drafts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_zernio_reply_approval_decisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  approval_request_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_by_user_id uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, approval_request_id),
  FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES app.property_predator_zernio_reply_approval_requests (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, draft_id)
    REFERENCES app.property_predator_zernio_reply_drafts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, decided_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_zernio_reply_deliveries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  draft_id uuid NOT NULL,
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  provider_account_id_sha256 bytea NOT NULL CHECK (octet_length(provider_account_id_sha256) = 32),
  provider_conversation_id_sha256 bytea NOT NULL CHECK (octet_length(provider_conversation_id_sha256) = 32),
  idempotency_key_sha256 bytea NOT NULL CHECK (octet_length(idempotency_key_sha256) = 32),
  lease_token_sha256 bytea NOT NULL CHECK (octet_length(lease_token_sha256) = 32),
  state text NOT NULL CHECK (state IN ('calling', 'accepted', 'failed', 'outcome_unknown')),
  requested_by_user_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  settled_at timestamptz,
  provider_message_id_sha256 bytea CHECK (
    provider_message_id_sha256 IS NULL OR octet_length(provider_message_id_sha256) = 32
  ),
  provider_response_sha256 bytea CHECK (
    provider_response_sha256 IS NULL OR octet_length(provider_response_sha256) = 32
  ),
  failure_code text CHECK (
    failure_code IS NULL OR failure_code IN (
      'unauthorised', 'forbidden', 'rate_limited', 'provider_rejected',
      'provider_unavailable', 'invalid_provider_response', 'outcome_unknown',
      'settlement_unavailable'
    )
  ),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, draft_id),
  FOREIGN KEY (workspace_id, draft_id)
    REFERENCES app.property_predator_zernio_reply_drafts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES app.property_predator_zernio_reply_approval_requests (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_decision_id)
    REFERENCES app.property_predator_zernio_reply_approval_decisions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'calling' AND settled_at IS NULL AND provider_message_id_sha256 IS NULL
      AND provider_response_sha256 IS NULL AND failure_code IS NULL)
    OR (state = 'accepted' AND settled_at IS NOT NULL AND provider_message_id_sha256 IS NOT NULL
      AND provider_response_sha256 IS NOT NULL AND failure_code IS NULL)
    OR (state = 'failed' AND settled_at IS NOT NULL AND provider_message_id_sha256 IS NULL
      AND failure_code IS NOT NULL AND failure_code <> 'outcome_unknown')
    OR (state = 'outcome_unknown' AND settled_at IS NOT NULL
      AND provider_message_id_sha256 IS NULL AND failure_code = 'outcome_unknown')
  )
);

CREATE FUNCTION app_private.zernio_reply_delivery_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  IF OLD.state <> 'calling' OR NEW.state NOT IN ('accepted', 'failed', 'outcome_unknown')
     OR NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id
     OR NEW.draft_id <> OLD.draft_id
     OR NEW.approval_request_id <> OLD.approval_request_id
     OR NEW.approval_decision_id <> OLD.approval_decision_id
     OR NEW.body_sha256 <> OLD.body_sha256
     OR NEW.provider_account_id_sha256 <> OLD.provider_account_id_sha256
     OR NEW.provider_conversation_id_sha256 <> OLD.provider_conversation_id_sha256
     OR NEW.idempotency_key_sha256 <> OLD.idempotency_key_sha256
     OR NEW.lease_token_sha256 <> OLD.lease_token_sha256
     OR NEW.requested_by_user_id <> OLD.requested_by_user_id
     OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'Zernio reply delivery transition denied' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.zernio_reply_delivery_guard() FROM PUBLIC;

CREATE TRIGGER property_predator_zernio_reply_drafts_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_zernio_reply_drafts
  FOR EACH ROW EXECUTE FUNCTION app_private.zernio_evidence_immutable_guard();
CREATE TRIGGER property_predator_zernio_reply_requests_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_zernio_reply_approval_requests
  FOR EACH ROW EXECUTE FUNCTION app_private.zernio_evidence_immutable_guard();
CREATE TRIGGER property_predator_zernio_reply_decisions_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_zernio_reply_approval_decisions
  FOR EACH ROW EXECUTE FUNCTION app_private.zernio_evidence_immutable_guard();
CREATE TRIGGER property_predator_zernio_reply_deliveries_guard
  BEFORE UPDATE ON app.property_predator_zernio_reply_deliveries
  FOR EACH ROW EXECUTE FUNCTION app_private.zernio_reply_delivery_guard();
CREATE TRIGGER property_predator_zernio_reply_deliveries_no_delete
  BEFORE DELETE ON app.property_predator_zernio_reply_deliveries
  FOR EACH ROW EXECUTE FUNCTION app_private.zernio_evidence_immutable_guard();

ALTER TABLE app.property_predator_zernio_reply_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_reply_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_reply_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_reply_approval_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_reply_approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_reply_approval_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_reply_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_reply_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY zernio_reply_drafts_owner_all ON app.property_predator_zernio_reply_drafts
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY zernio_reply_requests_owner_all ON app.property_predator_zernio_reply_approval_requests
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY zernio_reply_decisions_owner_all ON app.property_predator_zernio_reply_approval_decisions
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY zernio_reply_deliveries_owner_all ON app.property_predator_zernio_reply_deliveries
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY zernio_reply_drafts_definer_all ON app.property_predator_zernio_reply_drafts
  FOR ALL TO r72_zernio_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY zernio_reply_requests_definer_all ON app.property_predator_zernio_reply_approval_requests
  FOR ALL TO r72_zernio_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY zernio_reply_decisions_definer_all ON app.property_predator_zernio_reply_approval_decisions
  FOR ALL TO r72_zernio_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY zernio_reply_deliveries_definer_all ON app.property_predator_zernio_reply_deliveries
  FOR ALL TO r72_zernio_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT ON app.property_predator_zernio_reply_drafts,
  app.property_predator_zernio_reply_approval_requests,
  app.property_predator_zernio_reply_approval_decisions TO r72_zernio_social_definer;
GRANT SELECT, INSERT, UPDATE ON app.property_predator_zernio_reply_deliveries
  TO r72_zernio_social_definer;

GRANT CREATE ON SCHEMA app_private TO r72_zernio_social_definer;
SET LOCAL ROLE r72_zernio_social_definer;

CREATE FUNCTION app_private.create_zernio_reply_draft(
  p_workspace_id uuid, p_provider_connection_id uuid, p_draft_id uuid,
  p_provider_profile_id_sha256 bytea, p_provider_account_id_sha256 bytea,
  p_provider_conversation_id_sha256 bytea, p_body text, p_body_sha256 bytea
) RETURNS TABLE(disposition text, draft_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; existing app.property_predator_zernio_reply_drafts%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR octet_length(p_provider_profile_id_sha256) <> 32
     OR octet_length(p_provider_account_id_sha256) <> 32
     OR octet_length(p_provider_conversation_id_sha256) <> 32
     OR octet_length(p_body_sha256) <> 32
     OR p_body IS NULL OR p_body <> btrim(p_body)
     OR octet_length(convert_to(p_body, 'UTF8')) NOT BETWEEN 1 AND 10000
     OR public.digest(p_body, 'sha256') <> p_body_sha256 THEN
    RAISE EXCEPTION 'Zernio reply draft denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) OR NOT EXISTS (
    SELECT 1 FROM app.property_predator_zernio_accounts account
    JOIN app.provider_connections connection
      ON connection.workspace_id = account.workspace_id
     AND connection.id = account.provider_connection_id
    WHERE account.workspace_id = p_workspace_id
      AND account.provider_connection_id = p_provider_connection_id
      AND account.provider_profile_id_sha256 = p_provider_profile_id_sha256
      AND account.provider_account_id_sha256 = p_provider_account_id_sha256
      AND account.network = 'instagram' AND account.status = 'active'
      AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
      AND connection.environment = 'live' AND connection.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Zernio reply draft denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing FROM app.property_predator_zernio_reply_drafts draft
  WHERE draft.workspace_id = p_workspace_id AND draft.id = p_draft_id;
  IF FOUND THEN
    IF existing.provider_connection_id <> p_provider_connection_id
       OR existing.provider_profile_id_sha256 <> p_provider_profile_id_sha256
       OR existing.provider_account_id_sha256 <> p_provider_account_id_sha256
       OR existing.provider_conversation_id_sha256 <> p_provider_conversation_id_sha256
       OR existing.body_sha256 <> p_body_sha256 OR existing.body_text <> p_body
       OR existing.created_by_user_id <> selected_user THEN
      RAISE EXCEPTION 'Zernio reply draft conflict' USING ERRCODE = '40001';
    END IF;
    RETURN QUERY SELECT 'replayed'::text, existing.id;
    RETURN;
  END IF;
  INSERT INTO app.property_predator_zernio_reply_drafts (
    id, workspace_id, provider_connection_id, provider_profile_id_sha256,
    provider_account_id_sha256, provider_conversation_id_sha256,
    body_text, body_sha256, created_by_user_id
  ) VALUES (
    p_draft_id, p_workspace_id, p_provider_connection_id, p_provider_profile_id_sha256,
    p_provider_account_id_sha256, p_provider_conversation_id_sha256,
    p_body, p_body_sha256, selected_user
  );
  RETURN QUERY SELECT 'created'::text, p_draft_id;
END
$function$;

CREATE FUNCTION app_private.request_zernio_reply_approval(
  p_workspace_id uuid, p_draft_id uuid, p_approval_request_id uuid
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_draft app.property_predator_zernio_reply_drafts%ROWTYPE;
  existing app.property_predator_zernio_reply_approval_requests%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'Zernio reply approval request denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM app.workspace_memberships membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'Zernio reply approval request denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected_draft FROM app.property_predator_zernio_reply_drafts draft
  WHERE draft.workspace_id = p_workspace_id AND draft.id = p_draft_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Zernio reply draft missing' USING ERRCODE = '23503'; END IF;
  SELECT * INTO existing FROM app.property_predator_zernio_reply_approval_requests request
  WHERE request.workspace_id = p_workspace_id
    AND (request.id = p_approval_request_id OR request.draft_id = p_draft_id);
  IF FOUND THEN
    IF existing.id <> p_approval_request_id OR existing.draft_id <> p_draft_id
       OR existing.body_sha256 <> selected_draft.body_sha256
       OR existing.requested_by_user_id <> selected_user THEN
      RAISE EXCEPTION 'Zernio reply approval request conflict' USING ERRCODE = '40001';
    END IF;
    RETURN 'replayed';
  END IF;
  INSERT INTO app.property_predator_zernio_reply_approval_requests (
    id, workspace_id, draft_id, body_sha256, requested_by_user_id
  ) VALUES (
    p_approval_request_id, p_workspace_id, p_draft_id,
    selected_draft.body_sha256, selected_user
  );
  RETURN 'requested';
END
$function$;

CREATE FUNCTION app_private.decide_zernio_reply_approval(
  p_workspace_id uuid, p_approval_request_id uuid, p_decision_id uuid, p_decision text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_request app.property_predator_zernio_reply_approval_requests%ROWTYPE;
  existing app.property_predator_zernio_reply_approval_decisions%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Zernio reply approval decision denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM app.workspace_memberships membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'Zernio reply approval decision denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected_request FROM app.property_predator_zernio_reply_approval_requests request
  WHERE request.workspace_id = p_workspace_id AND request.id = p_approval_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Zernio reply approval request missing' USING ERRCODE = '23503'; END IF;
  SELECT * INTO existing FROM app.property_predator_zernio_reply_approval_decisions decision
  WHERE decision.workspace_id = p_workspace_id
    AND (decision.id = p_decision_id OR decision.approval_request_id = p_approval_request_id);
  IF FOUND THEN
    IF existing.id <> p_decision_id OR existing.approval_request_id <> p_approval_request_id
       OR existing.draft_id <> selected_request.draft_id
       OR existing.body_sha256 <> selected_request.body_sha256
       OR existing.decision <> p_decision OR existing.decided_by_user_id <> selected_user THEN
      RAISE EXCEPTION 'Zernio reply approval decision conflict' USING ERRCODE = '40001';
    END IF;
    RETURN 'replayed';
  END IF;
  INSERT INTO app.property_predator_zernio_reply_approval_decisions (
    id, workspace_id, approval_request_id, draft_id, body_sha256,
    decision, decided_by_user_id
  ) VALUES (
    p_decision_id, p_workspace_id, p_approval_request_id, selected_request.draft_id,
    selected_request.body_sha256, p_decision, selected_user
  );
  RETURN p_decision;
END
$function$;

CREATE FUNCTION app_private.read_zernio_reply_state(
  p_workspace_id uuid, p_provider_connection_id uuid,
  p_provider_profile_id_sha256 bytea, p_provider_account_id_sha256 bytea,
  p_provider_conversation_id_sha256 bytea
) RETURNS TABLE(
  draft_id uuid, body_text text, body_sha256 bytea, created_at timestamptz,
  approval_request_id uuid, requested_at timestamptz,
  approval_decision_id uuid, approval_decision text, decided_at timestamptz,
  delivery_id uuid, delivery_state text, delivery_started_at timestamptz,
  delivery_settled_at timestamptz, delivery_failure_code text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT draft.id, draft.body_text, draft.body_sha256, draft.created_at,
    request.id, request.requested_at,
    decision.id, decision.decision, decision.decided_at,
    delivery.id, delivery.state, delivery.started_at,
    delivery.settled_at, delivery.failure_code
  FROM app.property_predator_zernio_reply_drafts draft
  LEFT JOIN app.property_predator_zernio_reply_approval_requests request
    ON request.workspace_id = draft.workspace_id AND request.draft_id = draft.id
  LEFT JOIN app.property_predator_zernio_reply_approval_decisions decision
    ON decision.workspace_id = request.workspace_id
   AND decision.approval_request_id = request.id
  LEFT JOIN app.property_predator_zernio_reply_deliveries delivery
    ON delivery.workspace_id = draft.workspace_id AND delivery.draft_id = draft.id
  WHERE session_user = 'r72_zernio_social_command'
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'user'
    AND EXISTS (SELECT 1 FROM app.workspace_memberships membership
      WHERE membership.workspace_id = p_workspace_id
        AND membership.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND membership.status = 'active' AND membership.role IN ('owner', 'admin'))
    AND draft.workspace_id = p_workspace_id
    AND draft.provider_connection_id = p_provider_connection_id
    AND draft.provider_profile_id_sha256 = p_provider_profile_id_sha256
    AND draft.provider_account_id_sha256 = p_provider_account_id_sha256
    AND draft.provider_conversation_id_sha256 = p_provider_conversation_id_sha256
  ORDER BY draft.created_at DESC, draft.id DESC
  LIMIT 1
$function$;

CREATE FUNCTION app_private.claim_zernio_reply_send(
  p_workspace_id uuid, p_provider_connection_id uuid, p_draft_id uuid,
  p_delivery_id uuid, p_provider_profile_id_sha256 bytea,
  p_provider_account_id_sha256 bytea, p_provider_conversation_id_sha256 bytea,
  p_idempotency_key_sha256 bytea, p_lease_token_sha256 bytea
) RETURNS TABLE(disposition text, body_text text, body_sha256 bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_draft app.property_predator_zernio_reply_drafts%ROWTYPE;
  selected_request app.property_predator_zernio_reply_approval_requests%ROWTYPE;
  selected_decision app.property_predator_zernio_reply_approval_decisions%ROWTYPE;
  existing app.property_predator_zernio_reply_deliveries%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR octet_length(p_provider_profile_id_sha256) <> 32
     OR octet_length(p_provider_account_id_sha256) <> 32
     OR octet_length(p_provider_conversation_id_sha256) <> 32
     OR octet_length(p_idempotency_key_sha256) <> 32
     OR octet_length(p_lease_token_sha256) <> 32 THEN
    RAISE EXCEPTION 'Zernio reply send denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM app.workspace_memberships membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'Zernio reply send denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected_draft FROM app.property_predator_zernio_reply_drafts draft
  WHERE draft.workspace_id = p_workspace_id AND draft.id = p_draft_id FOR SHARE;
  IF NOT FOUND OR selected_draft.provider_connection_id <> p_provider_connection_id
     OR selected_draft.provider_profile_id_sha256 <> p_provider_profile_id_sha256
     OR selected_draft.provider_account_id_sha256 <> p_provider_account_id_sha256
     OR selected_draft.provider_conversation_id_sha256 <> p_provider_conversation_id_sha256 THEN
    RAISE EXCEPTION 'Zernio reply send target denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected_request FROM app.property_predator_zernio_reply_approval_requests request
  WHERE request.workspace_id = p_workspace_id AND request.draft_id = p_draft_id;
  SELECT * INTO selected_decision FROM app.property_predator_zernio_reply_approval_decisions decision
  WHERE decision.workspace_id = p_workspace_id
    AND decision.approval_request_id = selected_request.id;
  IF selected_request.id IS NULL OR selected_decision.id IS NULL
     OR selected_decision.decision <> 'approved'
     OR selected_request.body_sha256 <> selected_draft.body_sha256
     OR selected_decision.body_sha256 <> selected_draft.body_sha256 THEN
    RAISE EXCEPTION 'Zernio reply send is not approved' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.property_predator_zernio_accounts account
    WHERE account.workspace_id = p_workspace_id
      AND account.provider_connection_id = p_provider_connection_id
      AND account.provider_profile_id_sha256 = p_provider_profile_id_sha256
      AND account.provider_account_id_sha256 = p_provider_account_id_sha256
      AND account.network = 'instagram' AND account.status = 'active') THEN
    RAISE EXCEPTION 'Zernio reply account is not active' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing FROM app.property_predator_zernio_reply_deliveries delivery
  WHERE delivery.workspace_id = p_workspace_id
    AND (delivery.id = p_delivery_id OR delivery.draft_id = p_draft_id);
  IF FOUND THEN
    IF existing.id <> p_delivery_id OR existing.draft_id <> p_draft_id
       OR existing.idempotency_key_sha256 <> p_idempotency_key_sha256
       OR existing.lease_token_sha256 <> p_lease_token_sha256
       OR existing.requested_by_user_id <> selected_user THEN
      RAISE EXCEPTION 'Zernio reply delivery conflict' USING ERRCODE = '40001';
    END IF;
    RETURN QUERY SELECT ('already_' || existing.state)::text, NULL::text, existing.body_sha256;
    RETURN;
  END IF;
  INSERT INTO app.property_predator_zernio_reply_deliveries (
    id, workspace_id, draft_id, approval_request_id, approval_decision_id,
    body_sha256, provider_account_id_sha256, provider_conversation_id_sha256,
    idempotency_key_sha256, lease_token_sha256, state, requested_by_user_id
  ) VALUES (
    p_delivery_id, p_workspace_id, p_draft_id, selected_request.id, selected_decision.id,
    selected_draft.body_sha256, p_provider_account_id_sha256,
    p_provider_conversation_id_sha256, p_idempotency_key_sha256,
    p_lease_token_sha256, 'calling', selected_user
  );
  RETURN QUERY SELECT 'claimed'::text, selected_draft.body_text, selected_draft.body_sha256;
END
$function$;

CREATE FUNCTION app_private.settle_zernio_reply_send(
  p_workspace_id uuid, p_delivery_id uuid, p_lease_token_sha256 bytea,
  p_state text, p_provider_message_id_sha256 bytea,
  p_provider_response_sha256 bytea, p_failure_code text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_delivery app.property_predator_zernio_reply_deliveries%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR octet_length(p_lease_token_sha256) <> 32
     OR p_state NOT IN ('accepted', 'failed', 'outcome_unknown')
     OR (p_provider_message_id_sha256 IS NOT NULL
       AND octet_length(p_provider_message_id_sha256) <> 32)
     OR (p_provider_response_sha256 IS NOT NULL
       AND octet_length(p_provider_response_sha256) <> 32)
     OR (p_state = 'accepted' AND (p_provider_message_id_sha256 IS NULL
       OR p_provider_response_sha256 IS NULL OR p_failure_code IS NOT NULL))
     OR (p_state = 'failed' AND (p_provider_message_id_sha256 IS NOT NULL
       OR p_failure_code NOT IN ('unauthorised', 'forbidden', 'rate_limited',
         'provider_rejected', 'invalid_provider_response')))
     OR (p_state = 'outcome_unknown' AND (p_provider_message_id_sha256 IS NOT NULL
       OR p_failure_code <> 'outcome_unknown')) THEN
    RAISE EXCEPTION 'Zernio reply settlement denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  SELECT * INTO selected_delivery FROM app.property_predator_zernio_reply_deliveries delivery
  WHERE delivery.workspace_id = p_workspace_id AND delivery.id = p_delivery_id FOR UPDATE;
  IF NOT FOUND OR selected_delivery.lease_token_sha256 <> p_lease_token_sha256
     OR selected_delivery.requested_by_user_id <> selected_user THEN
    RAISE EXCEPTION 'Zernio reply settlement denied' USING ERRCODE = '42501';
  END IF;
  IF selected_delivery.state <> 'calling' THEN
    IF selected_delivery.state = p_state
       AND selected_delivery.provider_message_id_sha256 IS NOT DISTINCT FROM p_provider_message_id_sha256
       AND selected_delivery.provider_response_sha256 IS NOT DISTINCT FROM p_provider_response_sha256
       AND selected_delivery.failure_code IS NOT DISTINCT FROM p_failure_code THEN
      RETURN 'replayed';
    END IF;
    RAISE EXCEPTION 'Zernio reply settlement conflict' USING ERRCODE = '40001';
  END IF;
  UPDATE app.property_predator_zernio_reply_deliveries SET
    state = p_state, settled_at = statement_timestamp(),
    provider_message_id_sha256 = p_provider_message_id_sha256,
    provider_response_sha256 = p_provider_response_sha256,
    failure_code = p_failure_code
  WHERE workspace_id = p_workspace_id AND id = p_delivery_id;
  RETURN p_state;
END
$function$;

REVOKE ALL ON FUNCTION app_private.create_zernio_reply_draft(uuid,uuid,uuid,bytea,bytea,bytea,text,bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.request_zernio_reply_approval(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.decide_zernio_reply_approval(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.read_zernio_reply_state(uuid,uuid,bytea,bytea,bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.claim_zernio_reply_send(uuid,uuid,uuid,uuid,bytea,bytea,bytea,bytea,bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.settle_zernio_reply_send(uuid,uuid,bytea,text,bytea,bytea,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app_private.create_zernio_reply_draft(uuid,uuid,uuid,bytea,bytea,bytea,text,bytea),
  app_private.request_zernio_reply_approval(uuid,uuid,uuid),
  app_private.decide_zernio_reply_approval(uuid,uuid,uuid,text),
  app_private.read_zernio_reply_state(uuid,uuid,bytea,bytea,bytea),
  app_private.claim_zernio_reply_send(uuid,uuid,uuid,uuid,bytea,bytea,bytea,bytea,bytea),
  app_private.settle_zernio_reply_send(uuid,uuid,bytea,text,bytea,bytea,text)
  TO r72_zernio_social_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_zernio_social_definer;

INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
VALUES
  ('app', 'property_predator_zernio_reply_drafts', 'workspace_id'),
  ('app', 'property_predator_zernio_reply_approval_requests', 'workspace_id'),
  ('app', 'property_predator_zernio_reply_approval_decisions', 'workspace_id'),
  ('app', 'property_predator_zernio_reply_deliveries', 'workspace_id');

DO $capability_audit$
DECLARE
  relation regclass;
  unexpected_public text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'app.property_predator_zernio_reply_drafts'::regclass,
    'app.property_predator_zernio_reply_approval_requests'::regclass,
    'app.property_predator_zernio_reply_approval_decisions'::regclass,
    'app.property_predator_zernio_reply_deliveries'::regclass
  ] LOOP
    IF has_table_privilege('r72_zernio_social_command', relation, 'SELECT')
       OR has_table_privilege('r72_zernio_social_command', relation, 'INSERT')
       OR has_table_privilege('r72_zernio_social_command', relation, 'UPDATE')
       OR has_table_privilege('r72_zernio_social_command', relation, 'DELETE')
       OR has_table_privilege('r72_zernio_social_command', relation, 'TRUNCATE') THEN
      RAISE EXCEPTION 'Zernio command role gained direct reply-table capability';
    END IF;
  END LOOP;
  SELECT procedure.oid::regprocedure::text INTO unexpected_public
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) AS privilege
  WHERE namespace.nspname = 'app_private'
    AND procedure.proname IN (
      'create_zernio_reply_draft',
      'request_zernio_reply_approval',
      'decide_zernio_reply_approval',
      'read_zernio_reply_state',
      'claim_zernio_reply_send',
      'settle_zernio_reply_send'
    )
    AND privilege.grantee = 0
    AND privilege.privilege_type = 'EXECUTE'
  LIMIT 1;
  IF unexpected_public IS NOT NULL THEN
    RAISE EXCEPTION 'A Zernio reply effect function remains public: %', unexpected_public;
  END IF;
END
$capability_audit$;

RESET ROLE;
