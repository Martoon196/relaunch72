-- PP-SMS-VERIFY-20261029. A founder-owned, single-recipient possession check.
-- This does not grant marketing consent, enqueue a marketing SMS or relax 0056/0061.
SET LOCAL ROLE r72_owner;

CREATE TABLE app_private.sms_phone_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  request_key_sha256 bytea NOT NULL CHECK (octet_length(request_key_sha256) = 32),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+44[0-9]{9,10}$'),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','claimed','armed','sent','failed','needs_attention','verified')),
  code_hash text,
  provider_message_sid text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT statement_timestamp() + interval '10 minutes',
  claimed_at timestamptz,
  sent_at timestamptz,
  verified_at timestamptz,
  UNIQUE (workspace_id, request_key_sha256),
  UNIQUE (workspace_id, id, contact_point_id),
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX sms_phone_challenges_pending
  ON app_private.sms_phone_challenges (workspace_id, created_at)
  WHERE state = 'pending';
CREATE INDEX sms_phone_challenges_rate
  ON app_private.sms_phone_challenges (workspace_id, contact_id, created_at DESC);

CREATE TABLE app_private.sms_phone_verification_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  challenge_id uuid NOT NULL UNIQUE,
  contact_point_id uuid NOT NULL,
  phone_identity_sha256 bytea NOT NULL CHECK (octet_length(phone_identity_sha256) = 32),
  provider_message_sid text NOT NULL CHECK (provider_message_sid ~ '^SM[0-9a-f]{32}$'),
  verified_by_user_id uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (workspace_id, challenge_id, contact_point_id)
    REFERENCES app_private.sms_phone_challenges (workspace_id, id, contact_point_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, verified_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE FUNCTION app_private.reject_sms_phone_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'SMS phone verification receipts are append-only' USING ERRCODE='42501';
END $$;
CREATE TRIGGER sms_phone_receipts_immutable
  BEFORE UPDATE OR DELETE ON app_private.sms_phone_verification_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_sms_phone_receipt_mutation();

ALTER TABLE app_private.sms_phone_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.sms_phone_challenges FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.sms_phone_verification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.sms_phone_verification_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY sms_phone_challenges_owner ON app_private.sms_phone_challenges
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY sms_phone_receipts_owner ON app_private.sms_phone_verification_receipts
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY sms_phone_challenges_definer ON app_private.sms_phone_challenges
  FOR ALL TO r72_sms_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid);
CREATE POLICY sms_phone_receipts_definer ON app_private.sms_phone_verification_receipts
  FOR SELECT TO r72_sms_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid);
CREATE POLICY sms_phone_receipts_definer_insert ON app_private.sms_phone_verification_receipts
  FOR INSERT TO r72_sms_definer
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE ON app_private.sms_phone_challenges TO r72_sms_definer;
GRANT SELECT, INSERT ON app_private.sms_phone_verification_receipts TO r72_sms_definer;
GRANT INSERT ON app.contact_points TO r72_sms_definer;
GRANT UPDATE (is_verified, row_version, updated_at) ON app.contact_points TO r72_sms_definer;
CREATE POLICY sms_phone_points_insert ON app.contact_points FOR INSERT TO r72_sms_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid
    AND kind='phone' AND NOT is_verified AND consent_status='unknown'
    AND dedupe_state='normal' AND deleted_at IS NULL
  );
CREATE POLICY sms_phone_points_verify ON app.contact_points FOR UPDATE TO r72_sms_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid
    AND kind='phone' AND NOT is_verified
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id',true),'')::uuid
    AND kind='phone' AND is_verified
  );

-- The no-login definer needs temporary DDL permission only while these
-- SECURITY DEFINER functions are created. Restore the closed schema after.
GRANT CREATE ON SCHEMA app_private TO r72_sms_definer;
SET LOCAL ROLE r72_sms_definer;

CREATE FUNCTION app_private.request_sms_phone_challenge(
  p_workspace uuid, p_contact uuid, p_phone text, p_request_key text
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  actor uuid;
  selected_point app.contact_points%ROWTYPE;
  existing uuid;
  created uuid;
BEGIN
  IF session_user <> 'r72_sms_command'
     OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace::text
     OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id',true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id',true),'') = ''
     OR p_phone !~ '^\+44[0-9]{9,10}$'
     OR p_request_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'SMS phone challenge denied' USING ERRCODE='42501';
  END IF;
  actor := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships m
    WHERE m.workspace_id=p_workspace AND m.user_id=actor
      AND m.status='active' AND m.role IN ('owner','admin')
  ) THEN
    RAISE EXCEPTION 'SMS phone challenge operator denied' USING ERRCODE='42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(format('sms-phone:%s:%s',p_workspace,p_phone),7200122)
  );
  SELECT c.id INTO existing FROM app_private.sms_phone_challenges c
  WHERE c.workspace_id=p_workspace
    AND c.request_key_sha256=public.digest(p_request_key,'sha256');
  IF existing IS NOT NULL THEN RETURN existing; END IF;
  IF (SELECT count(*) FROM app_private.sms_phone_challenges c
      WHERE c.workspace_id=p_workspace AND c.contact_id=p_contact
        AND c.created_at > statement_timestamp()-interval '1 hour') >= 3 THEN
    RAISE EXCEPTION 'SMS phone challenge rate limit' USING ERRCODE='54000';
  END IF;
  SELECT point.* INTO selected_point FROM app.contact_points point
  WHERE point.workspace_id=p_workspace AND point.kind='phone'
    AND point.normalized_value=p_phone
    AND point.deleted_at IS NULL AND point.dedupe_state='normal';
  IF FOUND AND (selected_point.contact_id<>p_contact OR selected_point.is_verified) THEN
    RAISE EXCEPTION 'SMS phone endpoint already assigned or verified' USING ERRCODE='23505';
  END IF;
  IF NOT FOUND THEN
    INSERT INTO app.contact_points (
      workspace_id, contact_id, kind, label, value, normalized_value,
      is_primary, is_verified, consent_status
    ) VALUES (
      p_workspace,p_contact,'phone','Founder SMS possession check',
      p_phone,p_phone,true,false,'unknown'
    ) RETURNING * INTO selected_point;
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_private.sms_phone_challenges c
    WHERE c.workspace_id=p_workspace AND c.contact_point_id=selected_point.id
      AND c.state IN ('pending','claimed','armed','sent')
      AND c.expires_at>statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'SMS phone challenge already active' USING ERRCODE='23505';
  END IF;
  INSERT INTO app_private.sms_phone_challenges (
    workspace_id,contact_id,contact_point_id,requested_by_user_id,
    request_key_sha256,phone_e164
  ) VALUES (
    p_workspace,p_contact,selected_point.id,actor,
    public.digest(p_request_key,'sha256'),p_phone
  ) RETURNING id INTO created;
  RETURN created;
END $$;

CREATE FUNCTION app_private.claim_sms_phone_challenge(
  p_workspace uuid,p_connection uuid,p_allowed_phone text
) RETURNS TABLE(challenge_id uuid, phone_e164 text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected app_private.sms_phone_challenges%ROWTYPE;
BEGIN
  IF session_user <> 'r72_sms_worker_command'
     OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace::text
     OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'worker'
     OR p_allowed_phone !~ '^\+44[0-9]{9,10}$'
     OR NOT EXISTS (
       SELECT 1 FROM app.provider_connections pc
       WHERE pc.workspace_id=p_workspace AND pc.id=p_connection
         AND pc.provider_id='twilio_messaging' AND pc.provider_kind='sms'
         AND pc.environment='live' AND pc.status='active'
     ) THEN
    RAISE EXCEPTION 'SMS phone challenge claim denied' USING ERRCODE='42501';
  END IF;
  SELECT c.* INTO selected FROM app_private.sms_phone_challenges c
  WHERE c.workspace_id=p_workspace AND c.phone_e164=p_allowed_phone
    AND c.state='pending' AND c.expires_at>statement_timestamp()
  ORDER BY c.created_at,c.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE app_private.sms_phone_challenges c
  SET state='claimed',claimed_at=statement_timestamp()
  WHERE c.id=selected.id;
  RETURN QUERY SELECT selected.id,selected.phone_e164;
END $$;

CREATE FUNCTION app_private.arm_sms_phone_challenge(
  p_workspace uuid,p_challenge uuid,p_code text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed integer;
BEGIN
  IF session_user <> 'r72_sms_worker_command'
     OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace::text
     OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'worker'
     OR p_code !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'SMS phone challenge arm denied' USING ERRCODE='42501';
  END IF;
  UPDATE app_private.sms_phone_challenges c
  SET code_hash=public.crypt(p_code,public.gen_salt('bf',12)),
      state='armed',expires_at=statement_timestamp()+interval '10 minutes'
  WHERE c.workspace_id=p_workspace AND c.id=p_challenge
    AND c.state='claimed' AND c.claimed_at>statement_timestamp()-interval '1 minute';
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END $$;

CREATE FUNCTION app_private.settle_sms_phone_challenge(
  p_workspace uuid,p_challenge uuid,p_state text,p_provider_sid text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed integer;
BEGIN
  IF session_user <> 'r72_sms_worker_command'
     OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace::text
     OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'worker'
     OR p_state NOT IN ('sent','failed','needs_attention')
     OR (p_state='sent' AND p_provider_sid !~ '^SM[0-9a-f]{32}$')
     OR (p_state<>'sent' AND p_provider_sid IS NOT NULL) THEN
    RAISE EXCEPTION 'SMS phone challenge settle denied' USING ERRCODE='42501';
  END IF;
  UPDATE app_private.sms_phone_challenges c
  SET state=p_state,provider_message_sid=p_provider_sid,
      sent_at=CASE WHEN p_state='sent' THEN statement_timestamp() ELSE NULL END
  WHERE c.workspace_id=p_workspace AND c.id=p_challenge AND c.state='armed';
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END $$;

CREATE FUNCTION app_private.confirm_sms_phone_challenge(
  p_workspace uuid,p_challenge uuid,p_code text
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; challenge app_private.sms_phone_challenges%ROWTYPE; changed integer;
BEGIN
  IF session_user <> 'r72_sms_command'
     OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace::text
     OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id',true) !~ '^[0-9a-f-]{36}$'
     OR p_code !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'SMS phone confirmation denied' USING ERRCODE='42501';
  END IF;
  actor:=current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships m
    WHERE m.workspace_id=p_workspace AND m.user_id=actor
      AND m.status='active' AND m.role IN ('owner','admin')
  ) THEN
    RAISE EXCEPTION 'SMS phone confirmation operator denied' USING ERRCODE='42501';
  END IF;
  SELECT c.* INTO challenge FROM app_private.sms_phone_challenges c
  WHERE c.workspace_id=p_workspace AND c.id=p_challenge FOR UPDATE;
  IF NOT FOUND OR challenge.state<>'sent'
     OR challenge.expires_at<=statement_timestamp() OR challenge.attempts>=5 THEN
    RAISE EXCEPTION 'SMS phone challenge unavailable' USING ERRCODE='22023';
  END IF;
  IF public.crypt(p_code,challenge.code_hash)<>challenge.code_hash THEN
    UPDATE app_private.sms_phone_challenges c SET attempts=attempts+1
    WHERE c.id=p_challenge;
    RETURN NULL;
  END IF;
  UPDATE app.contact_points point
  SET is_verified=true,row_version=row_version+1,updated_at=statement_timestamp()
  WHERE point.workspace_id=p_workspace AND point.id=challenge.contact_point_id
    AND point.contact_id=challenge.contact_id AND point.kind='phone'
    AND point.normalized_value=challenge.phone_e164
    AND NOT point.is_verified AND point.deleted_at IS NULL
    AND point.dedupe_state='normal';
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN
    RAISE EXCEPTION 'SMS phone point changed during verification' USING ERRCODE='40001';
  END IF;
  UPDATE app_private.sms_phone_challenges c
  SET state='verified',verified_at=statement_timestamp()
  WHERE c.id=p_challenge;
  INSERT INTO app_private.sms_phone_verification_receipts (
    workspace_id,challenge_id,contact_point_id,phone_identity_sha256,
    provider_message_sid,verified_by_user_id
  ) VALUES (
    p_workspace,p_challenge,challenge.contact_point_id,
    public.digest(challenge.phone_e164,'sha256'),
    challenge.provider_message_sid,actor
  );
  RETURN challenge.contact_point_id;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA app_private FROM r72_sms_definer;
REVOKE ALL ON FUNCTION
  app_private.request_sms_phone_challenge(uuid,uuid,text,text),
  app_private.claim_sms_phone_challenge(uuid,uuid,text),
  app_private.arm_sms_phone_challenge(uuid,uuid,text),
  app_private.settle_sms_phone_challenge(uuid,uuid,text,text),
  app_private.confirm_sms_phone_challenge(uuid,uuid,text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app_private.request_sms_phone_challenge(uuid,uuid,text,text),
  app_private.confirm_sms_phone_challenge(uuid,uuid,text)
TO r72_sms_command;
GRANT EXECUTE ON FUNCTION
  app_private.claim_sms_phone_challenge(uuid,uuid,text),
  app_private.arm_sms_phone_challenge(uuid,uuid,text),
  app_private.settle_sms_phone_challenge(uuid,uuid,text,text)
TO r72_sms_worker_command;
