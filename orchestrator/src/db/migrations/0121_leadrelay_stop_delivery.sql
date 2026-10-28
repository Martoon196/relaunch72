-- Inert per-target delivery ledger for canonical sales stops. No startup,
-- queue scan, credentials, installation grant, enrolment or provider operation.
-- Configuration rows are owner-managed. No existing application LOGIN gains
-- this capability; the new runtime role is deliberately NOLOGIN and ungranted.
DO $roles$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['r72_leadrelay_stop_definer','r72_leadrelay_stop_runtime'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT',name); END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=name
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) OR
      EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member
        WHERE r.rolname=name) THEN
      RAISE EXCEPTION 'Unsafe LeadRelay stop capability role: %',name; END IF;
  END LOOP;
  GRANT r72_leadrelay_stop_definer TO r72_owner;
END $roles$;
SET LOCAL ROLE r72_owner;
GRANT USAGE ON SCHEMA app_private TO r72_leadrelay_stop_definer, r72_leadrelay_stop_runtime;
GRANT SELECT ON app_private.external_event_shadow_receipts TO r72_leadrelay_stop_definer;

CREATE TABLE app_private.leadrelay_stop_targets (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  installation_id text NOT NULL CHECK (installation_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  leadrelay_workspace_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, installation_id)
);
CREATE TABLE app_private.leadrelay_stop_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  installation_id text NOT NULL,
  source_subject_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('commerce.purchase.completed','sales.appointment.booked')),
  product_key text NOT NULL CHECK (
    (event_type = 'sales.appointment.booked' AND product_key = '') OR
    (event_type = 'commerce.purchase.completed' AND length(product_key) BETWEEN 1 AND 100)
  ),
  lead_id uuid NOT NULL,
  stop_scope text NOT NULL CHECK (stop_scope = 'all_sales_followup_for_lead'),
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, installation_id)
    REFERENCES app_private.leadrelay_stop_targets(workspace_id, installation_id),
  UNIQUE (workspace_id, installation_id, id),
  UNIQUE (workspace_id, installation_id, source_subject_id, event_type, product_key)
);
CREATE TABLE app_private.leadrelay_stop_deliveries (
  workspace_id uuid NOT NULL,
  installation_id text NOT NULL,
  source text NOT NULL DEFAULT 'property_predator' CHECK (source = 'property_predator'),
  source_event_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  canonical_payload jsonb NOT NULL CHECK (jsonb_typeof(canonical_payload) = 'object'),
  frozen_binding jsonb NOT NULL CHECK (jsonb_typeof(frozen_binding) = 'object'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','held','conflict','delivered')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  claim_token uuid,
  claimed_at timestamptz,
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  duplicate boolean,
  PRIMARY KEY (workspace_id, installation_id, source_event_id),
  FOREIGN KEY (workspace_id, installation_id)
    REFERENCES app_private.leadrelay_stop_targets(workspace_id, installation_id),
  FOREIGN KEY (workspace_id, installation_id, binding_id)
    REFERENCES app_private.leadrelay_stop_bindings(workspace_id, installation_id, id),
  FOREIGN KEY (workspace_id, source, source_event_id)
    REFERENCES app_private.external_event_shadow_receipts(workspace_id, source, event_id),
  CHECK ((state = 'processing') = (claim_token IS NOT NULL)),
  CHECK ((state = 'delivered') = (duplicate IS NOT NULL))
);

CREATE INDEX leadrelay_stop_due_idx ON app_private.leadrelay_stop_deliveries
  (workspace_id, installation_id, retry_at, source_event_id) WHERE state = 'queued';

CREATE FUNCTION app_private.leadrelay_stop_immutable_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LeadRelay stop intent is immutable' USING ERRCODE = '22000'; END IF;
  IF TG_TABLE_NAME='leadrelay_stop_targets' AND
      (to_jsonb(NEW)-'enabled') IS DISTINCT FROM (to_jsonb(OLD)-'enabled') THEN
    RAISE EXCEPTION 'LeadRelay stop intent is immutable' USING ERRCODE='22000'; END IF;
  IF TG_TABLE_NAME='leadrelay_stop_bindings' AND
      ((to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR
       ((to_jsonb(OLD)->>'revoked_at') IS NOT NULL AND
        (to_jsonb(NEW)->'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)->'revoked_at'))) THEN
    RAISE EXCEPTION 'LeadRelay stop intent is immutable' USING ERRCODE='22000'; END IF;
  IF TG_TABLE_NAME='leadrelay_stop_deliveries' AND
      ((to_jsonb(NEW)-ARRAY['state','attempts','retry_at','claim_token','claimed_at','reason_code','duplicate'])
        IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['state','attempts','retry_at','claim_token','claimed_at','reason_code','duplicate']) OR
       to_jsonb(OLD)->>'state'='delivered') THEN
    RAISE EXCEPTION 'LeadRelay stop intent is immutable' USING ERRCODE='22000'; END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION app_private.leadrelay_stop_immutable_guard() FROM PUBLIC;

DO $tables$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['leadrelay_stop_targets','leadrelay_stop_bindings','leadrelay_stop_deliveries'] LOOP
    EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC', name);
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY stop_owner ON app_private.%I TO r72_owner USING (true) WITH CHECK (true)', name);
    EXECUTE format('CREATE POLICY stop_runtime ON app_private.%I TO r72_leadrelay_stop_definer USING (workspace_id = app_private.current_workspace_id()) WITH CHECK (workspace_id = app_private.current_workspace_id())', name);
    EXECUTE format('CREATE TRIGGER stop_immutable BEFORE UPDATE OR DELETE ON app_private.%I FOR EACH ROW EXECUTE FUNCTION app_private.leadrelay_stop_immutable_guard()', name);
  END LOOP;
END $tables$;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
  VALUES('app_private','leadrelay_stop_targets','workspace_id'),
    ('app_private','leadrelay_stop_bindings','workspace_id'),
    ('app_private','leadrelay_stop_deliveries','workspace_id');
GRANT SELECT ON app_private.leadrelay_stop_targets, app_private.leadrelay_stop_bindings TO r72_leadrelay_stop_definer;
-- SELECT FOR SHARE needs an UPDATE capability. It remains inside a NOLOGIN
-- definer with no mutation function: only the owner can configure/revoke.
GRANT UPDATE(enabled) ON app_private.leadrelay_stop_targets TO r72_leadrelay_stop_definer;
GRANT UPDATE(revoked_at) ON app_private.leadrelay_stop_bindings TO r72_leadrelay_stop_definer;
GRANT SELECT, INSERT, UPDATE ON app_private.leadrelay_stop_deliveries TO r72_leadrelay_stop_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(), app_private.current_actor_kind() TO r72_leadrelay_stop_definer;
GRANT CREATE ON SCHEMA app_private TO r72_leadrelay_stop_definer;
SET LOCAL ROLE r72_leadrelay_stop_definer;

CREATE FUNCTION app_private.prepare_leadrelay_stop(p_workspace uuid, p_installation text, p_event uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE target app_private.leadrelay_stop_targets%ROWTYPE;
  receipt app_private.external_event_shadow_receipts%ROWTYPE;
  binding app_private.leadrelay_stop_bindings%ROWTYPE;
  frozen jsonb; product text;
BEGIN
  IF p_workspace IS DISTINCT FROM app_private.current_workspace_id() OR
     coalesce(app_private.current_actor_kind(),'') NOT IN ('worker','system') THEN
    RAISE EXCEPTION 'Invalid stop delivery context' USING ERRCODE = '42501'; END IF;
  SELECT * INTO target FROM app_private.leadrelay_stop_targets
    WHERE workspace_id = p_workspace AND installation_id = p_installation AND enabled;
  IF NOT FOUND THEN RETURN 'target_disabled'; END IF;
  SELECT * INTO receipt FROM app_private.external_event_shadow_receipts
    WHERE workspace_id = p_workspace AND source = 'property_predator' AND event_id = p_event;
  IF NOT FOUND OR receipt.disposition <> 'shadow' OR receipt.event_version <> 1 OR
     receipt.event_type NOT IN ('commerce.purchase.completed','sales.appointment.booked') THEN
    RETURN 'canonical_event_required'; END IF;
  product := CASE WHEN receipt.event_type = 'commerce.purchase.completed'
    THEN receipt.event_payload->'data'->>'productKey' ELSE '' END;
  SELECT * INTO binding FROM app_private.leadrelay_stop_bindings
    WHERE workspace_id = p_workspace AND installation_id = p_installation
      AND source_subject_id = receipt.subject_id AND event_type = receipt.event_type
      AND product_key = product AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN 'mapping_required'; END IF;
  frozen := jsonb_build_object('hqWorkspaceId',p_workspace,'installationId',p_installation,
    'leadRelayWorkspaceId',target.leadrelay_workspace_id,'source','property_predator',
    'sourceSubjectId',binding.source_subject_id,'eventType',binding.event_type,
    'productKey',nullif(binding.product_key,''),'leadId',binding.lead_id,'stopScope',binding.stop_scope);
  INSERT INTO app_private.leadrelay_stop_deliveries(workspace_id,installation_id,source_event_id,
    binding_id,canonical_payload,frozen_binding)
    VALUES(p_workspace,p_installation,p_event,binding.id,receipt.event_payload,frozen)
    ON CONFLICT DO NOTHING;
  IF EXISTS (SELECT 1 FROM app_private.leadrelay_stop_deliveries WHERE workspace_id=p_workspace
      AND installation_id=p_installation AND source_event_id=p_event
      AND (binding_id IS DISTINCT FROM binding.id OR canonical_payload IS DISTINCT FROM receipt.event_payload
        OR frozen_binding IS DISTINCT FROM frozen)) THEN
    RAISE EXCEPTION 'Stop event conflicts with frozen intent' USING ERRCODE='22000'; END IF;
  RETURN 'prepared';
END $function$;

CREATE FUNCTION app_private.claim_leadrelay_stops(p_workspace uuid,p_installation text,p_limit integer)
RETURNS TABLE(source_event_id uuid, canonical_payload jsonb, frozen_binding jsonb, claim_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF p_workspace IS DISTINCT FROM app_private.current_workspace_id() OR
     coalesce(app_private.current_actor_kind(),'') NOT IN ('worker','system') OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid stop delivery context' USING ERRCODE='42501'; END IF;
  -- Stale processing is ambiguous: hold, never silently reclaim/resubmit.
  UPDATE app_private.leadrelay_stop_deliveries d SET state='held',claim_token=NULL,
    reason_code='stale_claim_reconcile' WHERE d.workspace_id=p_workspace
      AND d.installation_id=p_installation AND d.state='processing'
      AND d.claimed_at < statement_timestamp()-interval '2 minutes';
  RETURN QUERY WITH selected AS (
    SELECT d.workspace_id,d.installation_id,d.source_event_id
    FROM app_private.leadrelay_stop_deliveries d
    JOIN app_private.leadrelay_stop_targets t USING(workspace_id,installation_id)
    JOIN app_private.leadrelay_stop_bindings b ON b.id=d.binding_id
    WHERE d.workspace_id=p_workspace AND d.installation_id=p_installation
      AND t.enabled AND b.revoked_at IS NULL AND d.state='queued'
      AND d.retry_at<=statement_timestamp()
    ORDER BY d.retry_at,d.source_event_id LIMIT p_limit FOR UPDATE OF d SKIP LOCKED
  ) UPDATE app_private.leadrelay_stop_deliveries d SET state='processing',
      claim_token=gen_random_uuid(),claimed_at=statement_timestamp(),attempts=d.attempts+1
    FROM selected s WHERE d.workspace_id=s.workspace_id AND d.installation_id=s.installation_id
      AND d.source_event_id=s.source_event_id
    RETURNING d.source_event_id,d.canonical_payload,d.frozen_binding,d.claim_token;
END $function$;

CREATE FUNCTION app_private.authorize_leadrelay_stop(p_workspace uuid,p_installation text,p_event uuid,p_claim uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE active_binding uuid;
BEGIN
  IF p_workspace IS DISTINCT FROM app_private.current_workspace_id() OR
    coalesce(app_private.current_actor_kind(),'') NOT IN ('worker','system') THEN
    RAISE EXCEPTION 'Invalid stop authorization context' USING ERRCODE='42501'; END IF;
  -- Hold these locks through the caller's bounded HTTP request and receipt
  -- settlement transaction. Revocation committed first prevents submission;
  -- a revocation ordered later cannot recall a receiver-accepted stop.
  PERFORM 1 FROM app_private.leadrelay_stop_targets WHERE workspace_id=p_workspace
    AND installation_id=p_installation AND enabled FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT binding_id INTO active_binding FROM app_private.leadrelay_stop_deliveries
    WHERE workspace_id=p_workspace AND installation_id=p_installation
      AND source_event_id=p_event AND state='processing' AND claim_token=p_claim
      AND claimed_at>=statement_timestamp()-interval '2 minutes' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM app_private.leadrelay_stop_bindings WHERE id=active_binding
    AND workspace_id=p_workspace AND installation_id=p_installation AND revoked_at IS NULL FOR SHARE;
  RETURN FOUND;
END $function$;

CREATE FUNCTION app_private.settle_leadrelay_stop(p_workspace uuid,p_installation text,p_event uuid,
  p_claim uuid,p_result text,p_duplicate boolean,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE changed integer;
BEGIN
  IF p_workspace IS DISTINCT FROM app_private.current_workspace_id() OR
     coalesce(app_private.current_actor_kind(),'') NOT IN ('worker','system') OR
     coalesce(p_result,'') NOT IN ('delivered','deferred','held','conflict') OR
     (p_result='delivered') IS DISTINCT FROM (p_duplicate IS NOT NULL) OR
     (p_reason IS NOT NULL AND p_reason !~ '^[a-z][a-z0-9_]{0,63}$') THEN
    RAISE EXCEPTION 'Invalid stop settlement' USING ERRCODE='42501'; END IF;
  UPDATE app_private.leadrelay_stop_deliveries d SET
    state=CASE WHEN p_result='deferred' THEN 'queued' ELSE p_result END,
    claim_token=NULL,duplicate=p_duplicate,reason_code=p_reason,
    retry_at=statement_timestamp()+make_interval(secs=>least(3600,30*power(2,least(d.attempts,6)))::integer)
    WHERE d.workspace_id=p_workspace AND d.installation_id=p_installation
      AND d.source_event_id=p_event AND d.state='processing' AND d.claim_token=p_claim;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END $function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_leadrelay_stop_definer;
REVOKE ALL ON FUNCTION app_private.prepare_leadrelay_stop(uuid,text,uuid),
  app_private.claim_leadrelay_stops(uuid,text,integer),
  app_private.authorize_leadrelay_stop(uuid,text,uuid,uuid),
  app_private.settle_leadrelay_stop(uuid,text,uuid,uuid,text,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.prepare_leadrelay_stop(uuid,text,uuid),
  app_private.claim_leadrelay_stops(uuid,text,integer),
  app_private.authorize_leadrelay_stop(uuid,text,uuid,uuid),
  app_private.settle_leadrelay_stop(uuid,text,uuid,uuid,text,boolean,text)
  TO r72_leadrelay_stop_runtime;
