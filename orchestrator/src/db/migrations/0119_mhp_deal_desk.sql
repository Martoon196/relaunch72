-- MHP-DEALDESK-001. Permanent calculators/read access, bounded writes, saved files and verdicts.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_commerce_definer,r72_mhp_member_definer;

ALTER TABLE app.entitlements ADD COLUMN crm_write_ends_at timestamptz;
ALTER TABLE app.entitlements ADD CONSTRAINT mhp_crm_write_window CHECK(crm_write_ends_at IS NULL OR crm_write_ends_at>=starts_at);
UPDATE app.products SET grants=grants||jsonb_build_object('calculators',true,'dealFileLimit',NULL)
WHERE brand='martin_howard_property' AND sku<>'mhp_kit';
UPDATE app.products SET active=true,grants=jsonb_build_object('crm',true,'enquirySite',true,'emailWorkflow',false,'leadrelay',false,'calculators',true,'dealFileLimit',3)
WHERE brand='martin_howard_property' AND sku='mhp_deal_desk';
-- Manual grant audit is immutable; feature snapshots acquire only the authorised calculator/Desk additions.
UPDATE app.entitlements e SET grants=p.grants,
 crm_write_ends_at=CASE WHEN p.sku='mhp_deal_desk' THEN e.starts_at+interval '30 days' ELSE NULL END
FROM app.products p WHERE p.id=e.product_id AND p.brand='martin_howard_property' AND p.sku<>'mhp_kit';

CREATE TABLE app.deal_files (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
 created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
 property jsonb NOT NULL CHECK(jsonb_typeof(property)='object' AND octet_length(property::text)<=20000),
 calculator text NOT NULL CHECK(calculator IN('brrr','hmo','sa','auction','residual')),
 inputs jsonb NOT NULL CHECK(jsonb_typeof(inputs)='object' AND octet_length(inputs::text)<=20000),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=50000),
 formula_version text NOT NULL CHECK(length(formula_version) BETWEEN 1 AND 100),
 archived boolean NOT NULL DEFAULT false,
 row_version bigint NOT NULL DEFAULT 1 CHECK(row_version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id)
);
CREATE INDEX mhp_deal_files_workspace ON app.deal_files(workspace_id,created_at DESC,id);

CREATE TABLE app.mhp_verdict_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 purchase_id uuid UNIQUE REFERENCES app.purchases(id) ON DELETE RESTRICT,
 account_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
 buyer_email text NOT NULL,
 source text NOT NULL CHECK(source IN('purchase','manual')),
 purchased_at timestamptz NOT NULL,
 due_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'awaiting_form' CHECK(status IN('awaiting_form','submitted','reviewed')),
 answers jsonb CHECK(answers IS NULL OR (jsonb_typeof(answers)='object' AND octet_length(answers::text)<=20000)),
 submitted_at timestamptz,
 response text CHECK(response IS NULL OR length(btrim(response)) BETWEEN 1 AND 12000),
 reviewed_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
 reviewed_at timestamptz,
 row_version bigint NOT NULL DEFAULT 1 CHECK(row_version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((source='purchase')=(purchase_id IS NOT NULL)),
 CHECK(source='purchase' OR account_id IS NOT NULL),
 CHECK((status='awaiting_form')=(answers IS NULL AND submitted_at IS NULL)),
 CHECK((status='reviewed')=(response IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE UNIQUE INDEX mhp_manual_verdict_account ON app.mhp_verdict_requests(account_id) WHERE purchase_id IS NULL;
CREATE INDEX mhp_verdict_queue ON app.mhp_verdict_requests(status,due_at,id);

CREATE TABLE app_private.mhp_deal_commands (
 command_id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
 action text NOT NULL CHECK(action IN('save','archive','submit_verdict','review_verdict')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 result_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $security$
DECLARE t text; s text;
BEGIN
 FOREACH t IN ARRAY ARRAY['deal_files','mhp_verdict_requests','mhp_deal_commands'] LOOP
  s:=CASE WHEN t='mhp_deal_commands' THEN 'app_private' ELSE 'app' END;
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',s,t);
  EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',s,t);
  EXECUTE format('CREATE POLICY mhp_desk_owner ON %I.%I TO r72_owner USING(true) WITH CHECK(true)',s,t);
  EXECUTE format('CREATE POLICY mhp_desk_member ON %I.%I TO r72_mhp_member_definer USING(true) WITH CHECK(true)',s,t);
  EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC,r72_web,r72_identity_command',s,t);
 END LOOP;
END $security$;
GRANT SELECT,INSERT,UPDATE ON app.deal_files,app.mhp_verdict_requests TO r72_mhp_member_definer;
GRANT SELECT,INSERT ON app_private.mhp_deal_commands TO r72_mhp_member_definer;
GRANT SELECT ON app.purchases TO r72_mhp_member_definer;
CREATE POLICY mhp_desk_member_purchase ON app.purchases FOR SELECT TO r72_mhp_member_definer
USING(organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8');
GRANT SELECT,INSERT,UPDATE(account_id) ON app.mhp_verdict_requests TO r72_mhp_commerce_definer;
CREATE POLICY mhp_desk_commerce_verdict ON app.mhp_verdict_requests TO r72_mhp_commerce_definer USING(source='purchase') WITH CHECK(source='purchase');

-- No runtime delete can reopen a lifetime slot, and original creation/ownership cannot move.
CREATE FUNCTION app_private.mhp_deal_file_immutable_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deal files are retained; archive instead' USING ERRCODE='42501'; END IF;
 IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'Deal file identity is immutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_deal_file_immutable_identity() FROM PUBLIC;
CREATE TRIGGER mhp_deal_file_immutable_identity BEFORE UPDATE OR DELETE ON app.deal_files
FOR EACH ROW EXECUTE FUNCTION app_private.mhp_deal_file_immutable_identity();
CREATE TRIGGER mhp_deal_commands_immutable BEFORE UPDATE OR DELETE ON app_private.mhp_deal_commands
FOR EACH ROW EXECUTE FUNCTION app_private.mhp_manual_grants_immutable();

CREATE FUNCTION app_private.mhp_verdict_immutable_intake() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Verdict history is retained' USING ERRCODE='42501'; END IF;
 IF NEW.id<>OLD.id OR NEW.purchase_id IS DISTINCT FROM OLD.purchase_id OR NEW.source<>OLD.source
 OR NEW.buyer_email<>OLD.buyer_email OR NEW.purchased_at<>OLD.purchased_at OR NEW.due_at<>OLD.due_at
 OR NEW.created_at<>OLD.created_at OR (OLD.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM OLD.account_id)
 OR (OLD.answers IS NOT NULL AND (NEW.answers IS DISTINCT FROM OLD.answers OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at))
 OR (OLD.status='reviewed' AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'Verdict intake and completed response are immutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_verdict_immutable_intake() FROM PUBLIC;
CREATE TRIGGER mhp_verdict_immutable_intake BEFORE UPDATE OR DELETE ON app.mhp_verdict_requests
FOR EACH ROW EXECUTE FUNCTION app_private.mhp_verdict_immutable_intake();

-- Working days are Monday-Friday in Europe/London; bank holidays are not inferred.
CREATE FUNCTION app_private.mhp_five_working_days(p_start timestamptz) RETURNS timestamptz
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $f$
 SELECT ((p_start AT TIME ZONE 'Europe/London')::date+n + (p_start AT TIME ZONE 'Europe/London')::time) AT TIME ZONE 'Europe/London'
 FROM generate_series(1,9) n
 WHERE extract(isodow FROM (p_start AT TIME ZONE 'Europe/London')::date+n)<6
 ORDER BY n OFFSET 4 LIMIT 1
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_five_working_days(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_five_working_days(timestamptz) TO r72_mhp_commerce_definer,r72_mhp_member_definer;

SET LOCAL ROLE r72_mhp_commerce_definer;
CREATE OR REPLACE FUNCTION app_private.mhp_account_access(p_user uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH live AS(
  SELECT e.*,p.sku,(e.ends_at IS NULL OR e.ends_at>clock_timestamp()) AS live_write,
   CASE WHEN p.sku='mhp_deal_desk' THEN COALESCE(e.crm_write_ends_at,e.starts_at+interval '30 days') ELSE e.ends_at END AS write_end
  FROM app.entitlements e JOIN app.products p ON p.id=e.product_id
  WHERE e.account_id=p_user AND p.brand='martin_howard_property' AND e.starts_at<=clock_timestamp()
  AND (e.ends_at IS NULL OR e.ends_at>clock_timestamp() OR e.read_only_until>clock_timestamp())
 ), evaluated AS(SELECT *,live_write AND (write_end IS NULL OR write_end>clock_timestamp()) AS writable FROM live)
 SELECT jsonb_build_object(
  'crm',COALESCE(bool_or((grants->>'crm')::boolean),false),
  'enquirySite',COALESCE(bool_or((grants->>'enquirySite')::boolean AND writable),false),
  'emailWorkflow',COALESCE(bool_or((grants->>'emailWorkflow')::boolean),false),
  'emailWritable',COALESCE(bool_or((grants->>'emailWorkflow')::boolean AND writable),false),
  'leadrelay',COALESCE(bool_or((grants->>'leadrelay')::boolean AND writable),false),
  'calculators',COALESCE(bool_or((grants->>'calculators')::boolean),false),
  'readOnly',COALESCE(bool_or((grants->>'crm')::boolean),false) AND NOT COALESCE(bool_or((grants->>'crm')::boolean AND writable),false),
  'dealFileLimit',CASE WHEN COALESCE(bool_or((grants->>'crm')::boolean AND sku<>'mhp_deal_desk' AND writable),false) THEN NULL ELSE 3 END,
  'deskWriteEndsAt',CASE WHEN bool_or((grants->>'crm')::boolean AND writable AND write_end IS NULL) THEN NULL ELSE max(write_end) FILTER(WHERE (grants->>'crm')::boolean) END,
  'endsAt',CASE WHEN bool_or(ends_at IS NULL) THEN NULL ELSE max(COALESCE(read_only_until,ends_at)) END)
 FROM evaluated;
$f$;

CREATE OR REPLACE FUNCTION app_private.mhp_refresh_entitlement(p_purchase uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE b app.purchases%ROWTYPE; p app.products%ROWTYPE; paid_count integer; ending timestamptz; grace timestamptz; write_ending timestamptz;
BEGIN
 SELECT * INTO b FROM app.purchases WHERE id=p_purchase;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO p FROM app.products WHERE id=b.product_id AND brand='martin_howard_property';
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown MHP product' USING ERRCODE='22023'; END IF;
 IF p.sku='mhp_deal_desk' THEN
  INSERT INTO app.mhp_verdict_requests(purchase_id,account_id,buyer_email,source,purchased_at,due_at)
  VALUES(b.id,b.account_id,b.buyer_email,'purchase',b.first_paid_at,app_private.mhp_five_working_days(b.first_paid_at))
  ON CONFLICT(purchase_id) DO UPDATE SET account_id=excluded.account_id
  WHERE app.mhp_verdict_requests.account_id IS NULL AND excluded.account_id IS NOT NULL;
  write_ending:=b.first_paid_at+interval '30 days';
 END IF;
 IF b.account_id IS NULL THEN RETURN; END IF;
 SELECT count(*) INTO paid_count FROM app_private.mhp_purchase_payments WHERE purchase_id=b.id;
 IF b.status='refunded' THEN ending:=b.refunded_at; grace:=ending+interval '7 days';
 ELSIF p.instalments IS NOT NULL AND paid_count>=p.instalments THEN ending:=NULL;
 ELSIF b.status='cancelled' THEN ending:=GREATEST(b.first_paid_at,LEAST(COALESCE(b.period_end,clock_timestamp()),clock_timestamp()));
 ELSIF p.recurring_interval IS NOT NULL THEN ending:=b.period_end;
 ELSE ending:=NULL; END IF;
 INSERT INTO app.entitlements(account_id,product_id,purchase_id,grants,starts_at,ends_at,read_only_until,crm_write_ends_at,source)
 VALUES(b.account_id,b.product_id,b.id,p.grants,b.first_paid_at,ending,grace,write_ending,'purchase')
 ON CONFLICT(purchase_id) DO UPDATE SET ends_at=excluded.ends_at,read_only_until=excluded.read_only_until,crm_write_ends_at=excluded.crm_write_ends_at;
END $f$;

RESET ROLE;
SET LOCAL ROLE r72_mhp_member_definer;
CREATE OR REPLACE FUNCTION app_private.mhp_workspace_access(p_user uuid,p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE m app_private.mhp_members%ROWTYPE; a jsonb; b app.investor_businesses%ROWTYPE;
BEGIN
 SELECT * INTO m FROM app_private.mhp_members WHERE workspace_id=p_workspace;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO b FROM app.investor_businesses WHERE workspace_id=p_workspace;
 a:=jsonb_build_object('crm',false,'enquirySite',false,'emailWorkflow',false,'emailWritable',false,'leadrelay',false,'calculators',false,'dealFileLimit',3,'deskWriteEndsAt',NULL,'readOnly',false,'endsAt',NULL);
 IF b.access_state='suspended' THEN RETURN a; END IF;
 IF app_private.mhp_is_programme_admin(m.user_id) THEN
  RETURN jsonb_build_object('crm',true,'enquirySite',true,'emailWorkflow',true,'emailWritable',true,'leadrelay',true,'calculators',true,'dealFileLimit',NULL,'deskWriteEndsAt',NULL,'readOnly',false,'endsAt',NULL);
 END IF;
 IF m.user_id IS NOT NULL THEN a:=app_private.mhp_account_access(m.user_id); END IF;
 IF app_private.mhp_is_programme_admin(p_user) AND b.workspace_id IS NOT NULL AND (b.access_state='pending_payment' OR (m.user_id IS NULL AND m.manual_active AND b.access_state='active')) THEN
  a:=a||jsonb_build_object('crm',true,'enquirySite',false,'readOnly',false);
 END IF;
 RETURN a;
END $f$;

CREATE FUNCTION app_private.mhp_deal_context(p_session bytea,p_write boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a jsonb; actor uuid; ws uuid;
BEGIN
 a:=app_private.mhp_member_snapshot(p_session); actor:=(a->>'userId')::uuid;ws:=(a->>'workspaceId')::uuid;
 IF NOT COALESCE((a->>'calculators')::boolean,false) OR NOT COALESCE((a->>'crm')::boolean,false)
 OR NOT app_private.has_active_workspace_membership(actor,ws) THEN RAISE EXCEPTION 'Deal Desk access required' USING ERRCODE='42501'; END IF;
 IF p_write AND (COALESCE((a->>'readOnly')::boolean,true) OR NOT app_private.lock_active_portal_session(p_session,actor,ws)) THEN
  RAISE EXCEPTION 'Your Desk is read-only' USING ERRCODE='42501';
 END IF;
 RETURN a;
END $f$;

CREATE FUNCTION app_private.mhp_desk_snapshot(p_session bytea,p_file uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a jsonb; actor uuid; ws uuid; member_id uuid; chosen jsonb; v jsonb; can_verdict boolean;
BEGIN
 a:=app_private.mhp_deal_context(p_session,false);actor:=(a->>'userId')::uuid;ws:=(a->>'workspaceId')::uuid;
 SELECT user_id INTO member_id FROM app_private.mhp_members WHERE workspace_id=ws;
 SELECT jsonb_build_object('id',f.id,'title',f.title,'property',f.property,'calculator',f.calculator,'inputs',f.inputs,'result',f.result,'formulaVersion',f.formula_version,
  'archived',f.archived,'version',f.row_version,'createdAt',f.created_at,'updatedAt',f.updated_at) INTO chosen FROM app.deal_files f WHERE f.workspace_id=ws AND f.id=p_file;
 SELECT jsonb_build_object('id',r.id,'status',r.status,'source',r.source,'purchaseStatus',b.status,'answers',r.answers,'dueAt',r.due_at,'submittedAt',r.submitted_at,'response',r.response,'reviewedAt',r.reviewed_at,'version',r.row_version)
 INTO v FROM app.mhp_verdict_requests r LEFT JOIN app.purchases b ON b.id=r.purchase_id
 WHERE r.account_id=member_id
 ORDER BY (r.status='awaiting_form' AND (r.source='manual' OR b.status<>'refunded')) DESC,r.purchased_at DESC,r.id LIMIT 1;
 can_verdict:=actor=member_id AND ((v->>'status'='awaiting_form' AND (v->>'source'='manual' OR v->>'purchaseStatus'<>'refunded')) OR (v IS NULL AND (
  app_private.mhp_is_owner(p_session) OR EXISTS(SELECT 1 FROM app.entitlements e JOIN app.products p ON p.id=e.product_id
   WHERE e.account_id=actor AND p.sku='mhp_deal_desk' AND e.source<>'purchase' AND e.starts_at<=clock_timestamp() AND (e.ends_at IS NULL OR e.ends_at>clock_timestamp())))));
 RETURN jsonb_build_object('access',a,'selected',chosen,'lifetimeFileCount',(SELECT count(*) FROM app.deal_files WHERE workspace_id=ws),
  'fileLimit',a->'dealFileLimit','verdict',v,'canSubmitVerdict',COALESCE(can_verdict,false),
  'files',COALESCE((SELECT jsonb_agg(item ORDER BY updated_at DESC,id) FROM(
   SELECT f.id,f.updated_at,jsonb_build_object('id',f.id,'title',f.title,'property',f.property,'calculator',f.calculator,'inputs',f.inputs,'result',f.result,'formulaVersion',f.formula_version,
    'archived',f.archived,'version',f.row_version,'createdAt',f.created_at,'updatedAt',f.updated_at) item
   FROM app.deal_files f WHERE f.workspace_id=ws ORDER BY f.updated_at DESC,f.id LIMIT 200) files),'[]'::jsonb));
END $f$;

CREATE FUNCTION app_private.mhp_save_deal_file(p_session bytea,p_command uuid,p_file uuid,p_version bigint,p_title text,p_property jsonb,p_calculator text,p_inputs jsonb,p_result jsonb,p_formula_version text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a jsonb; actor uuid; ws uuid; payload jsonb; prior app_private.mhp_deal_commands%ROWTYPE; f app.deal_files%ROWTYPE; fid uuid; cap integer;
BEGIN
 a:=app_private.mhp_deal_context(p_session,false);actor:=(a->>'userId')::uuid;ws:=(a->>'workspaceId')::uuid;
 IF p_command IS NULL OR p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 200 OR p_calculator IS NULL OR p_calculator NOT IN('brrr','hmo','sa','auction','residual')
 OR p_property IS NULL OR jsonb_typeof(p_property)<>'object' OR octet_length(p_property::text)>20000
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_property) k WHERE k NOT IN('address','notes'))
 OR (p_property ? 'address' AND (jsonb_typeof(p_property->'address')<>'string' OR length(p_property->>'address')>500))
 OR (p_property ? 'notes' AND (jsonb_typeof(p_property->'notes')<>'string' OR length(p_property->>'notes')>4000))
 OR p_inputs IS NULL OR jsonb_typeof(p_inputs)<>'object' OR octet_length(p_inputs::text)>20000
 OR p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR octet_length(p_result::text)>50000
 OR p_formula_version IS NULL OR length(p_formula_version) NOT BETWEEN 1 AND 100
 OR p_result->>'calculator' IS DISTINCT FROM p_calculator OR p_result->>'version' IS DISTINCT FROM p_formula_version OR p_result->'inputs' IS DISTINCT FROM p_inputs
 OR (p_file IS NULL AND p_version IS NOT NULL) OR (p_file IS NOT NULL AND (p_version IS NULL OR p_version<1)) THEN RAISE EXCEPTION 'Check the deal file details' USING ERRCODE='22023'; END IF;
 payload:=jsonb_build_object('workspace',ws,'file',p_file,'version',p_version,'title',btrim(p_title),'property',p_property,'calculator',p_calculator,'inputs',p_inputs,'result',p_result,'formulaVersion',p_formula_version);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_command::text,119));
 SELECT * INTO prior FROM app_private.mhp_deal_commands WHERE command_id=p_command;
 IF FOUND THEN
  IF prior.actor_id<>actor OR prior.action<>'save' OR prior.payload<>payload THEN RAISE EXCEPTION 'Deal command changed' USING ERRCODE='40001'; END IF;
  RETURN prior.result_id;
 END IF;
 a:=app_private.mhp_deal_context(p_session,true);
 PERFORM pg_advisory_xact_lock(hashtextextended(ws::text,119));
 -- Re-evaluate after the serialization point so a concurrent expiry cannot create a fourth file.
 a:=app_private.mhp_deal_context(p_session,true);cap:=(a->>'dealFileLimit')::integer;
 IF p_file IS NULL THEN
  IF cap IS NOT NULL AND (SELECT count(*) FROM app.deal_files WHERE workspace_id=ws)>=cap THEN RAISE EXCEPTION 'Your three deal files have been used; a course upgrade opens more files' USING ERRCODE='54000'; END IF;
  INSERT INTO app.deal_files(workspace_id,created_by,title,property,calculator,inputs,result,formula_version)
  VALUES(ws,actor,btrim(p_title),p_property,p_calculator,p_inputs,p_result,p_formula_version) RETURNING id INTO fid;
 ELSE
  SELECT * INTO f FROM app.deal_files WHERE workspace_id=ws AND id=p_file FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deal file unavailable' USING ERRCODE='42501'; END IF;
  IF f.row_version<>p_version THEN RAISE EXCEPTION 'Deal file changed; reload before saving' USING ERRCODE='40001'; END IF;
  UPDATE app.deal_files SET title=btrim(p_title),property=p_property,calculator=p_calculator,inputs=p_inputs,result=p_result,formula_version=p_formula_version,
   row_version=row_version+1,updated_at=clock_timestamp() WHERE id=f.id;
  fid:=f.id;
 END IF;
 INSERT INTO app_private.mhp_deal_commands(command_id,actor_id,action,payload,result_id) VALUES(p_command,actor,'save',payload,fid);
 RETURN fid;
END $f$;

CREATE FUNCTION app_private.mhp_archive_deal_file(p_session bytea,p_command uuid,p_file uuid,p_version bigint,p_archived boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a jsonb; actor uuid; ws uuid; payload jsonb; prior app_private.mhp_deal_commands%ROWTYPE; f app.deal_files%ROWTYPE;
BEGIN
 a:=app_private.mhp_deal_context(p_session,false);actor:=(a->>'userId')::uuid;ws:=(a->>'workspaceId')::uuid;
 IF p_command IS NULL OR p_file IS NULL OR p_version IS NULL OR p_version<1 OR p_archived IS NULL THEN RAISE EXCEPTION 'Invalid archive action' USING ERRCODE='22023'; END IF;
 payload:=jsonb_build_object('workspace',ws,'file',p_file,'version',p_version,'archived',p_archived);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_command::text,119));
 SELECT * INTO prior FROM app_private.mhp_deal_commands WHERE command_id=p_command;
 IF FOUND THEN
  IF prior.actor_id<>actor OR prior.action<>'archive' OR prior.payload<>payload THEN RAISE EXCEPTION 'Deal command changed' USING ERRCODE='40001'; END IF;
  RETURN prior.result_id;
 END IF;
 PERFORM app_private.mhp_deal_context(p_session,true);
 SELECT * INTO f FROM app.deal_files WHERE workspace_id=ws AND id=p_file FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Deal file unavailable' USING ERRCODE='42501'; END IF;
 IF f.row_version<>p_version THEN RAISE EXCEPTION 'Deal file changed; reload before saving' USING ERRCODE='40001'; END IF;
 UPDATE app.deal_files SET archived=p_archived,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=f.id;
 INSERT INTO app_private.mhp_deal_commands(command_id,actor_id,action,payload,result_id) VALUES(p_command,actor,'archive',payload,f.id);
 RETURN f.id;
END $f$;

CREATE FUNCTION app_private.mhp_submit_verdict(p_session bytea,p_command uuid,p_answers jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a jsonb; actor uuid; ws uuid; member_id uuid; payload jsonb; prior app_private.mhp_deal_commands%ROWTYPE; r app.mhp_verdict_requests%ROWTYPE; k text; stamp timestamptz;
BEGIN
 a:=app_private.mhp_deal_context(p_session,false);actor:=(a->>'userId')::uuid;ws:=(a->>'workspaceId')::uuid;
 SELECT user_id INTO member_id FROM app_private.mhp_members WHERE workspace_id=ws;
 IF actor IS DISTINCT FROM member_id OR NOT app_private.lock_active_portal_session(p_session,actor,ws) THEN RAISE EXCEPTION 'Submit your own One Lane Verdict intake' USING ERRCODE='42501'; END IF;
 IF p_command IS NULL OR p_answers IS NULL OR jsonb_typeof(p_answers)<>'object' OR octet_length(p_answers::text)>20000
 OR (SELECT count(*) FROM jsonb_object_keys(p_answers))<>6 THEN RAISE EXCEPTION 'Complete the six intake fields' USING ERRCODE='22023'; END IF;
 FOREACH k IN ARRAY ARRAY['experience','budget','weeklyTime','areas','goals','questions'] LOOP
  IF NOT p_answers ? k OR jsonb_typeof(p_answers->k)<>'string' OR length(btrim(p_answers->>k)) NOT BETWEEN 1 AND 3000 THEN
   RAISE EXCEPTION 'Complete the six intake fields' USING ERRCODE='22023';
  END IF;
 END LOOP;
 payload:=jsonb_build_object('workspace',ws,'answers',p_answers);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_command::text,119));
 SELECT * INTO prior FROM app_private.mhp_deal_commands WHERE command_id=p_command;
 IF FOUND THEN
  IF prior.actor_id<>actor OR prior.action<>'submit_verdict' OR prior.payload<>payload THEN RAISE EXCEPTION 'Verdict command changed' USING ERRCODE='40001'; END IF;
  RETURN prior.result_id;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text,119));
 SELECT v.* INTO r FROM app.mhp_verdict_requests v LEFT JOIN app.purchases b ON b.id=v.purchase_id
 WHERE v.account_id=actor AND (v.source='manual' OR b.status<>'refunded')
 ORDER BY (v.status='awaiting_form') DESC,v.purchased_at DESC,v.id LIMIT 1 FOR UPDATE OF v;
 IF NOT FOUND THEN
  IF NOT app_private.mhp_is_owner(p_session) AND NOT EXISTS(SELECT 1 FROM app.entitlements e JOIN app.products p ON p.id=e.product_id
   WHERE e.account_id=actor AND p.sku='mhp_deal_desk' AND e.source<>'purchase' AND e.starts_at<=clock_timestamp() AND (e.ends_at IS NULL OR e.ends_at>clock_timestamp())) THEN
   RAISE EXCEPTION 'A Deal Desk verdict grant is required' USING ERRCODE='42501';
  END IF;
  SELECT min(e.starts_at) INTO stamp FROM app.entitlements e JOIN app.products p ON p.id=e.product_id WHERE e.account_id=actor AND p.sku='mhp_deal_desk' AND e.source<>'purchase';
  stamp:=COALESCE(stamp,clock_timestamp());
  INSERT INTO app.mhp_verdict_requests(account_id,buyer_email,source,purchased_at,due_at)
  SELECT actor,lower(email::text),'manual',stamp,app_private.mhp_five_working_days(stamp) FROM app.users WHERE id=actor RETURNING * INTO r;
 END IF;
 IF r.status<>'awaiting_form' THEN RAISE EXCEPTION 'Your verdict intake has already been submitted' USING ERRCODE='40001'; END IF;
 UPDATE app.mhp_verdict_requests SET answers=p_answers,submitted_at=clock_timestamp(),status='submitted',row_version=row_version+1 WHERE id=r.id;
 INSERT INTO app_private.mhp_deal_commands(command_id,actor_id,action,payload,result_id) VALUES(p_command,actor,'submit_verdict',payload,r.id);
 RETURN r.id;
END $f$;

CREATE FUNCTION app_private.mhp_verdict_queue(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF NOT app_private.mhp_is_owner(p_session) THEN RAISE EXCEPTION 'MHP owner access required' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('requests',COALESCE((SELECT jsonb_agg(item ORDER BY due_at,id) FROM(
  SELECT r.id,r.due_at,jsonb_build_object('id',r.id,'memberName',COALESCE(u.display_name,r.buyer_email),'memberEmail',r.buyer_email,'status',r.status,
   'source',r.source,'purchaseId',r.purchase_id,'purchaseStatus',b.status,'answers',r.answers,'dueAt',r.due_at,'submittedAt',r.submitted_at,'response',r.response,
   'reviewedAt',r.reviewed_at,'reviewedBy',reviewer.display_name,'version',r.row_version) item
  FROM app.mhp_verdict_requests r LEFT JOIN app.users u ON u.id=r.account_id LEFT JOIN app.users reviewer ON reviewer.id=r.reviewed_by LEFT JOIN app.purchases b ON b.id=r.purchase_id
  ORDER BY (r.status='reviewed'),r.due_at,r.id LIMIT 200) pending),'[]'::jsonb));
END $f$;

CREATE FUNCTION app_private.mhp_review_verdict(p_session bytea,p_command uuid,p_verdict uuid,p_version bigint,p_response text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; ws uuid; payload jsonb; prior app_private.mhp_deal_commands%ROWTYPE; r app.mhp_verdict_requests%ROWTYPE;
BEGIN
 IF NOT app_private.mhp_is_owner(p_session) THEN RAISE EXCEPTION 'MHP owner access required' USING ERRCODE='42501'; END IF;
 SELECT user_id,selected_workspace_id INTO actor,ws FROM app_private.resolve_session(p_session);
 IF NOT app_private.lock_active_portal_session(p_session,actor,ws) THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='42501'; END IF;
 IF p_command IS NULL OR p_verdict IS NULL OR p_version IS NULL OR p_version<1 OR p_response IS NULL OR length(btrim(p_response)) NOT BETWEEN 1 AND 12000 THEN
  RAISE EXCEPTION 'Write the verdict before completing it' USING ERRCODE='22023';
 END IF;
 payload:=jsonb_build_object('verdict',p_verdict,'version',p_version,'response',btrim(p_response));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_command::text,119));
 SELECT * INTO prior FROM app_private.mhp_deal_commands WHERE command_id=p_command;
 IF FOUND THEN
  IF prior.actor_id<>actor OR prior.action<>'review_verdict' OR prior.payload<>payload THEN RAISE EXCEPTION 'Verdict command changed' USING ERRCODE='40001'; END IF;
  RETURN prior.result_id;
 END IF;
 SELECT * INTO r FROM app.mhp_verdict_requests WHERE id=p_verdict FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Verdict unavailable' USING ERRCODE='42501'; END IF;
 IF r.status<>'submitted' OR r.row_version<>p_version THEN RAISE EXCEPTION 'Verdict changed or is not ready to review' USING ERRCODE='40001'; END IF;
 UPDATE app.mhp_verdict_requests SET response=btrim(p_response),reviewed_by=actor,reviewed_at=clock_timestamp(),status='reviewed',row_version=row_version+1 WHERE id=r.id;
 INSERT INTO app_private.mhp_deal_commands(command_id,actor_id,action,payload,result_id) VALUES(p_command,actor,'review_verdict',payload,r.id);
 RETURN r.id;
END $f$;

REVOKE ALL ON FUNCTION app_private.mhp_deal_context(bytea,boolean),app_private.mhp_desk_snapshot(bytea,uuid),
 app_private.mhp_save_deal_file(bytea,uuid,uuid,bigint,text,jsonb,text,jsonb,jsonb,text),app_private.mhp_archive_deal_file(bytea,uuid,uuid,bigint,boolean),
 app_private.mhp_submit_verdict(bytea,uuid,jsonb),app_private.mhp_verdict_queue(bytea),app_private.mhp_review_verdict(bytea,uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_desk_snapshot(bytea,uuid),app_private.mhp_verdict_queue(bytea) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.mhp_save_deal_file(bytea,uuid,uuid,bigint,text,jsonb,text,jsonb,jsonb,text),app_private.mhp_archive_deal_file(bytea,uuid,uuid,bigint,boolean),
 app_private.mhp_submit_verdict(bytea,uuid,jsonb),app_private.mhp_review_verdict(bytea,uuid,uuid,bigint,text) TO r72_identity_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_commerce_definer,r72_mhp_member_definer;
RESET ROLE;
