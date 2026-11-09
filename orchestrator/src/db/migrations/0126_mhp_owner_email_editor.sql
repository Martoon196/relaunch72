-- GHQ-WEBINAR-005A. Owner-authored immutable email versions reuse company content.
-- Local source candidate only; Root separately rehearses and applies after review.
-- Existing automatic mail keeps its v1 interface; owner work requires v2 proof.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;

ALTER TABLE app_private.mhp_marketing_sends
 ADD COLUMN owner_workspace_id uuid,
 ADD COLUMN owner_content_item_id uuid,
 ADD COLUMN owner_content_version_id uuid,
 ADD COLUMN owner_content_sha256 bytea,
 ADD COLUMN owner_approval_decision_id uuid,
 ADD COLUMN owner_user_id uuid,
 ADD COLUMN owner_audience_campaign text,
 ADD COLUMN owner_lease_id uuid,
 ADD COLUMN owner_held_at timestamptz,
 ADD COLUMN owner_hold_reason text,
 ADD COLUMN owner_last_failure text,
 ADD CONSTRAINT mhp_owner_email_shape CHECK (
  (owner_workspace_id IS NULL AND owner_content_item_id IS NULL AND owner_content_version_id IS NULL
   AND owner_content_sha256 IS NULL AND owner_approval_decision_id IS NULL AND owner_user_id IS NULL
   AND owner_audience_campaign IS NULL AND owner_lease_id IS NULL AND owner_held_at IS NULL
   AND owner_hold_reason IS NULL AND owner_last_failure IS NULL)
  OR (owner_workspace_id IS NOT NULL AND owner_workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
   AND owner_content_item_id IS NOT NULL AND owner_content_version_id IS NOT NULL
   AND owner_content_sha256 IS NOT NULL AND octet_length(owner_content_sha256)=32
   AND owner_approval_decision_id IS NOT NULL AND owner_user_id IS NOT NULL
   AND owner_audience_campaign IS NOT NULL AND owner_audience_campaign~'^[a-z0-9_-]{1,60}$'
   AND template_key='owner_followup' AND campaign_key='owner-'||owner_content_item_id::text
   AND (owner_lease_id IS NULL OR lease_until IS NOT NULL)
   AND (owner_held_at IS NULL)=(owner_hold_reason IS NULL)
   AND (owner_hold_reason IS NULL OR owner_hold_reason IN('newer_draft','approval_or_brand_changed','recovery'))
   AND (owner_last_failure IS NULL OR owner_last_failure='delivery_not_accepted'))),
 ADD CONSTRAINT mhp_owner_email_version_fk FOREIGN KEY(owner_workspace_id,owner_content_item_id,owner_content_version_id,owner_content_sha256)
  REFERENCES app.company_content_versions(workspace_id,content_item_id,id,content_sha256) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_owner_email_approval_fk FOREIGN KEY(owner_workspace_id,owner_approval_decision_id)
  REFERENCES app.company_content_approval_decisions(workspace_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_owner_email_author_fk FOREIGN KEY(owner_workspace_id,owner_user_id)
  REFERENCES app.workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT;
CREATE INDEX mhp_owner_email_item ON app_private.mhp_marketing_sends(owner_content_item_id,id)
 WHERE owner_content_version_id IS NOT NULL;

CREATE TABLE app_private.mhp_owner_email_dispatch_proofs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 send_id uuid NOT NULL REFERENCES app_private.mhp_marketing_sends(id) ON DELETE RESTRICT,
 lease_id uuid NOT NULL,
 content_item_id uuid NOT NULL,content_version_id uuid NOT NULL,
 content_sha256 bytea NOT NULL CHECK(octet_length(content_sha256)=32),
 blob_sha256 bytea NOT NULL CHECK(octet_length(blob_sha256)=32),
 brand_sha256 bytea NOT NULL CHECK(octet_length(brand_sha256)=32),
 manifest_sha256 bytea NOT NULL CHECK(octet_length(manifest_sha256)=32),
 approval_decision_id uuid NOT NULL,
 observed_role text NOT NULL CHECK(observed_role='r72_identity_command'),
 observed_session_user text NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 accepted boolean,provider_reference text,completed_at timestamptz,
 UNIQUE(send_id,lease_id),
 FOREIGN KEY(workspace_id,content_item_id,content_version_id,content_sha256)
  REFERENCES app.company_content_versions(workspace_id,content_item_id,id,content_sha256) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,approval_decision_id) REFERENCES app.company_content_approval_decisions(workspace_id,id) ON DELETE RESTRICT,
 CHECK(expires_at>checked_at AND expires_at<=checked_at+interval '15 minutes'),
 CHECK((accepted IS NULL)=(completed_at IS NULL)),
 CHECK(provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 200),
 CHECK(accepted IS DISTINCT FROM true OR provider_reference IS NOT NULL)
);
ALTER TABLE app_private.mhp_owner_email_dispatch_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_owner_email_dispatch_proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY mhp_owner_email_proof_owner ON app_private.mhp_owner_email_dispatch_proofs TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY mhp_owner_email_proof_definer ON app_private.mhp_owner_email_dispatch_proofs TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b') WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b');
REVOKE ALL ON app_private.mhp_owner_email_dispatch_proofs FROM PUBLIC;
GRANT SELECT,INSERT ON app_private.mhp_owner_email_dispatch_proofs TO r72_mhp_prospect_definer;
GRANT UPDATE(accepted,provider_reference,completed_at) ON app_private.mhp_owner_email_dispatch_proofs TO r72_mhp_prospect_definer;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
 VALUES('app_private','mhp_owner_email_dispatch_proofs','workspace_id');

CREATE FUNCTION app_private.mhp_owner_email_proof_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Owner dispatch proof is immutable' USING ERRCODE='42501'; END IF;
 IF OLD.accepted IS NOT NULL OR NEW.accepted IS NULL OR NEW.completed_at IS NULL
  OR (to_jsonb(OLD)-ARRAY['accepted','provider_reference','completed_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['accepted','provider_reference','completed_at'])
 THEN RAISE EXCEPTION 'Owner dispatch proof identity is immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_owner_email_proof_immutable() FROM PUBLIC;
CREATE TRIGGER mhp_owner_email_proof_immutable BEFORE UPDATE OR DELETE ON app_private.mhp_owner_email_dispatch_proofs
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_owner_email_proof_immutable();

GRANT SELECT ON app.organization_branding,app.company_content_items,app.company_content_versions,
 app.company_content_source_attestations,app.company_content_approval_requests,app.company_content_approval_decisions TO r72_mhp_prospect_definer;
CREATE POLICY mhp_owner_email_brand_read ON app.organization_branding FOR SELECT TO r72_mhp_prospect_definer
 USING(organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8');
CREATE POLICY mhp_owner_email_items_read ON app.company_content_items FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system='mhp.owner-email');
CREATE POLICY mhp_owner_email_versions_read ON app.company_content_versions FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system='mhp.owner-email');
DO $policies$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['company_content_source_attestations','company_content_approval_requests','company_content_approval_decisions'] LOOP
  EXECUTE format('CREATE POLICY mhp_owner_email_local_read ON app.%I FOR SELECT TO r72_mhp_prospect_definer USING (
   workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND EXISTS(SELECT 1 FROM app.company_content_versions v
    WHERE v.workspace_id=%I.workspace_id AND v.id=%I.content_version_id AND v.source_system=''mhp.owner-email''))',t,t,t);
 END LOOP;
END $policies$;
GRANT SELECT,INSERT ON app.command_receipts TO r72_mhp_prospect_definer;
GRANT UPDATE(result,status,response_status,completed_at) ON app.command_receipts TO r72_mhp_prospect_definer;
CREATE POLICY mhp_owner_email_receipts ON app.command_receipts TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name IN('mhp.ownerEmail.schedule','mhp.ownerEmail.replace','mhp.ownerEmail.cancel','mhp.ownerEmail.test'))
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name IN('mhp.ownerEmail.schedule','mhp.ownerEmail.replace','mhp.ownerEmail.cancel','mhp.ownerEmail.test'));

SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE FUNCTION app_private.mhp_owner_email_authorize(p_session bytea) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid;
BEGIN
 IF p_session IS NULL OR octet_length(p_session)<>32 THEN RAISE EXCEPTION 'Invalid owner session' USING ERRCODE='42501'; END IF;
 SELECT r.user_id,r.selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session) r
 JOIN app.user_sessions s ON s.id=r.session_id AND s.product_audience='martin_howard_property';
 IF actor IS NULL OR selected IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'::uuid
  OR NOT app_private.mhp_marketing_workspace_allowed(actor,selected)
 THEN RAISE EXCEPTION 'Selected MHP owner session required' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $f$;

CREATE FUNCTION app_private.mhp_owner_email_brand() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE canonical text; hashed text;
BEGIN
 SELECT jsonb_build_object('schema','mhp.organization-branding/v1','organizationId',b.organization_id,
  'productName',b.product_name,'logoStorageKey',b.logo_storage_key,'logoSha256',encode(b.logo_sha256,'hex'),
  'primaryColor',b.primary_color,'accentColor',b.accent_color,'supportEmail',b.support_email::text,
  'revision',to_char(b.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text INTO canonical
 FROM app.organization_branding b WHERE b.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
 IF canonical IS NULL THEN RAISE EXCEPTION 'MHP branding unavailable' USING ERRCODE='23514'; END IF;
 hashed:=encode(public.digest(canonical,'sha256'),'hex');
 RETURN jsonb_build_object('canonical',canonical,'sha256',hashed,'ref','mhp:organization-branding:ba41b1a4-9752-4dbf-8312-d04a0f03d0b8:'||hashed);
END $f$;

-- Recompute the exact canonical email bytes accepted by the existing TS parser.
-- A stored hash alone is insufficient: inline blob, manifest and real brand are checked.
CREATE FUNCTION app_private.mhp_owner_email_exact(p_version uuid,p_approved boolean,p_latest boolean,p_attested boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v app.company_content_versions%ROWTYPE; body jsonb; local jsonb; manifest jsonb; brand jsonb;
 canonical text; decision uuid; manifest_hash bytea; expected_keys text[];
BEGIN
 SELECT * INTO v FROM app.company_content_versions x WHERE x.id=p_version
  AND x.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND x.source_system='mhp.owner-email';
 IF NOT FOUND OR v.content_kind<>'email' OR v.content_mime_type<>'application/vnd.propertypredator.email-draft+json'
  OR v.source_item_id!~'^owner-email:[0-9a-f-]{36}$' OR v.source_version!~'^edit:[0-9a-f-]{36}$'
 THEN RAISE EXCEPTION 'Invalid local email version' USING ERRCODE='23514'; END IF;
 body:=v.content_body::jsonb; local:=v.metadata->'mhpOwnerEmail';
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(body) k) IS DISTINCT FROM ARRAY['bodyText','schema','subject']
  OR body->>'schema'<>'propertypredator.email-draft/v1' OR jsonb_typeof(body->'subject') IS DISTINCT FROM 'string'
  OR jsonb_typeof(body->'bodyText') IS DISTINCT FROM 'string' OR length(body->>'subject') NOT BETWEEN 1 AND 500
  OR body->>'subject'<>btrim(body->>'subject') OR body->>'subject'~'[[:cntrl:]]'
  OR length(btrim(body->>'bodyText'))=0 OR octet_length(body->>'bodyText')>50000
 THEN RAISE EXCEPTION 'Invalid canonical email copy' USING ERRCODE='23514'; END IF;
 canonical:='{"bodyText":'||to_json(body->>'bodyText')::text||',"schema":"propertypredator.email-draft/v1","subject":'||to_json(body->>'subject')::text||'}';
 IF canonical<>v.content_body OR public.digest(canonical,'sha256')<>v.content_sha256
  OR v.blob_sha256<>v.content_sha256 OR v.blob_storage_key<>'inline:mhp.owner-email:'||encode(v.content_sha256,'hex')
  OR jsonb_typeof(local) IS DISTINCT FROM 'object' OR local->>'schema' IS DISTINCT FROM 'mhp.owner-email-local/v1'
  OR local->>'authoredBy' IS DISTINCT FROM 'native-owner' OR jsonb_typeof(local->'brandCanonical') IS DISTINCT FROM 'string'
  OR jsonb_typeof(local->'manifestCanonical') IS DISTINCT FROM 'string'
 THEN RAISE EXCEPTION 'Local email bytes or provenance mismatch' USING ERRCODE='23514'; END IF;
 brand:=app_private.mhp_owner_email_brand();
 IF local->>'brandCanonical' IS DISTINCT FROM brand->>'canonical' OR v.brand_snapshot_ref IS DISTINCT FROM brand->>'ref'
  OR encode(v.brand_sha256,'hex') IS DISTINCT FROM brand->>'sha256'
 THEN RAISE EXCEPTION 'MHP branding changed' USING ERRCODE='23514'; END IF;
 manifest:=(local->>'manifestCanonical')::jsonb; manifest_hash:=public.digest(local->>'manifestCanonical','sha256');
 expected_keys:=ARRAY['audienceCampaign','blobSha256','blobStorageKey','brandSha256','brandSnapshotRef','contentSha256','schema','sourceItemId','sourceSystem','sourceVersion','workspaceId'];
 IF jsonb_typeof(manifest) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(manifest) k) IS DISTINCT FROM expected_keys
  OR manifest->>'schema'<>'mhp.owner-email-source/v1' OR manifest->>'workspaceId' IS DISTINCT FROM v.workspace_id::text
  OR manifest->>'sourceSystem' IS DISTINCT FROM v.source_system OR manifest->>'sourceItemId' IS DISTINCT FROM v.source_item_id
  OR manifest->>'sourceVersion' IS DISTINCT FROM v.source_version OR manifest->>'contentSha256' IS DISTINCT FROM encode(v.content_sha256,'hex')
  OR manifest->>'blobSha256' IS DISTINCT FROM encode(v.blob_sha256,'hex') OR manifest->>'blobStorageKey' IS DISTINCT FROM v.blob_storage_key
  OR manifest->>'brandSnapshotRef' IS DISTINCT FROM v.brand_snapshot_ref OR manifest->>'brandSha256' IS DISTINCT FROM encode(v.brand_sha256,'hex')
  OR manifest->>'audienceCampaign' IS NULL OR manifest->>'audienceCampaign'!~'^[a-z0-9_-]{1,60}$'
  OR local->>'manifestSha256' IS DISTINCT FROM encode(manifest_hash,'hex')
 THEN RAISE EXCEPTION 'Local email manifest mismatch' USING ERRCODE='23514'; END IF;
 IF p_attested AND NOT EXISTS(SELECT 1 FROM app.company_content_source_attestations a WHERE a.workspace_id=v.workspace_id
  AND a.content_version_id=v.id AND a.source_catalog_sha256=manifest_hash AND a.content_sha256=v.content_sha256
  AND a.blob_sha256=v.blob_sha256 AND a.brand_sha256=v.brand_sha256)
 THEN RAISE EXCEPTION 'Local owner source observation missing' USING ERRCODE='23514'; END IF;
 IF p_latest AND EXISTS(SELECT 1 FROM app.company_content_versions n WHERE n.workspace_id=v.workspace_id
  AND n.content_item_id=v.content_item_id AND n.version_number>v.version_number)
 THEN RAISE EXCEPTION 'A newer email draft exists' USING ERRCODE='23514'; END IF;
 SELECT d.id INTO decision FROM app.company_content_approval_decisions d
 JOIN app.company_content_approval_requests r ON r.workspace_id=d.workspace_id AND r.id=d.approval_request_id
 WHERE d.workspace_id=v.workspace_id AND d.content_version_id=v.id AND d.content_sha256=v.content_sha256
  AND d.decision='approved' AND app_private.mhp_marketing_workspace_allowed(d.decided_by_user_id,d.workspace_id)
  AND r.request_number=(SELECT max(latest.request_number) FROM app.company_content_approval_requests latest
   WHERE latest.workspace_id=v.workspace_id AND latest.content_version_id=v.id)
 ORDER BY d.decided_at DESC,d.id DESC LIMIT 1;
 IF p_approved AND decision IS NULL THEN RAISE EXCEPTION 'Latest owner approval required' USING ERRCODE='23514'; END IF;
 IF NOT app_private.mhp_marketing_workspace_allowed(v.created_by_user_id,v.workspace_id)
 THEN RAISE EXCEPTION 'Current author permission required' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('contentItemId',v.content_item_id,'contentVersionId',v.id,'versionNumber',v.version_number,
  'previousVersionId',v.previous_version_id,'title',v.title,'sourceItemId',v.source_item_id,'sourceVersion',v.source_version,
  'canonicalContent',v.content_body,'contentSha256',encode(v.content_sha256,'hex'),'blobSha256',encode(v.blob_sha256,'hex'),
  'brand',brand,'manifestCanonical',local->>'manifestCanonical','manifestSha256',encode(manifest_hash,'hex'),
  'approvalDecisionId',decision,'authorId',v.created_by_user_id,'audienceCampaign',manifest->>'audienceCampaign');
END $f$;

CREATE FUNCTION app_private.mhp_owner_email_local_version(p_session bytea,p_version uuid,p_revision text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v app.company_content_versions%ROWTYPE; exact jsonb; valid boolean:=true;
BEGIN
 PERFORM app_private.mhp_owner_email_authorize(p_session);
 IF (p_version IS NULL)=(p_revision IS NULL) OR (p_revision IS NOT NULL AND p_revision!~'^edit:[0-9a-f-]{36}$')
 THEN RAISE EXCEPTION 'Invalid local email lookup' USING ERRCODE='22023'; END IF;
 SELECT * INTO v FROM app.company_content_versions x WHERE x.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND x.source_system='mhp.owner-email' AND ((p_version IS NOT NULL AND x.id=p_version) OR (p_revision IS NOT NULL AND x.source_version=p_revision));
 IF NOT FOUND THEN RETURN NULL; END IF;
 BEGIN exact:=app_private.mhp_owner_email_exact(v.id,false,true,true);
 EXCEPTION WHEN check_violation OR insufficient_privilege THEN valid:=false; END;
 RETURN jsonb_build_object('contentItemId',v.content_item_id,'contentVersionId',v.id,'versionNumber',v.version_number,
  'previousVersionId',v.previous_version_id,'title',v.title,'sourceItemId',v.source_item_id,'sourceVersion',v.source_version,
  'canonicalContent',v.content_body,'contentSha256',encode(v.content_sha256,'hex'),'blobSha256',encode(v.blob_sha256,'hex'),
  'brandSha256',encode(v.brand_sha256,'hex'),'metadata',v.metadata,'valid',valid,'exact',exact);
END $f$;

CREATE FUNCTION app_private.mhp_owner_email_new_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF NEW.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND NEW.source_system='mhp.owner-email' THEN
  PERFORM app_private.mhp_owner_email_exact(NEW.id,false,true,false);
  -- Existing version-insert guard already owns this item's advisory lock.
  UPDATE app_private.mhp_marketing_sends s SET owner_held_at=COALESCE(s.owner_held_at,clock_timestamp()),owner_hold_reason='newer_draft'
  WHERE s.owner_content_item_id=NEW.content_item_id AND s.owner_content_version_id<>NEW.id
   AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL
   AND (s.owner_lease_id IS NULL OR s.lease_until<=clock_timestamp());
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_owner_email_authorize(bytea),app_private.mhp_owner_email_brand(),
 app_private.mhp_owner_email_exact(uuid,boolean,boolean,boolean),app_private.mhp_owner_email_local_version(bytea,uuid,text),
 app_private.mhp_owner_email_new_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_owner_email_new_version() TO r72_owner;
SET LOCAL ROLE r72_owner;
CREATE TRIGGER mhp_owner_email_version_hold AFTER INSERT ON app.company_content_versions
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_owner_email_new_version();
SET LOCAL ROLE r72_mhp_prospect_definer;

RESET ROLE;
SET LOCAL ROLE r72_security_definer;
GRANT EXECUTE ON FUNCTION app_private.lock_active_portal_session(bytea,uuid,uuid) TO r72_mhp_prospect_definer;
RESET ROLE;
SET LOCAL ROLE r72_mhp_prospect_definer;

CREATE FUNCTION app_private.mhp_owner_email_audience(p_campaign text)
RETURNS TABLE(prospect_id uuid,label text,link text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH anchors AS(
  SELECT s.prospect_id,min(s.created_at) AS captured_at FROM app_private.mhp_marketing_sends s
  WHERE s.owner_content_version_id IS NULL AND s.campaign_key=p_campaign
   AND s.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup') GROUP BY s.prospect_id
 )
 SELECT p.id,signup.label,signup.link FROM anchors a JOIN app_private.mhp_prospects p ON p.id=a.prospect_id
 CROSS JOIN LATERAL(SELECT x.label,x.link,x.consent_given FROM app_private.mhp_prospect_signups x
  WHERE x.prospect_id=p.id AND x.kind='webinar' AND x.created_at<=a.captured_at ORDER BY x.created_at DESC,x.id DESC LIMIT 1) signup
 WHERE p.marketing_consent AND p.unsubscribed_at IS NULL AND signup.consent_given
$f$;

CREATE FUNCTION app_private.mhp_owner_email_snapshot(p_session bytea,p_campaign text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; automatic jsonb; owner_items jsonb; tests jsonb; eligible integer;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$' THEN RAISE EXCEPTION 'Invalid webinar campaign' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO eligible FROM app_private.mhp_owner_email_audience(p_campaign);
 SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.template),'[]') INTO automatic FROM(
  SELECT s.template_key AS template,count(*) AS total,count(*) FILTER(WHERE s.sent_at IS NOT NULL) AS sent,
   count(*) FILTER(WHERE s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL) AS pending,
   count(*) FILTER(WHERE s.failed_at IS NOT NULL) AS failed,count(*) FILTER(WHERE s.cancelled_at IS NOT NULL) AS cancelled
  FROM app_private.mhp_marketing_sends s WHERE s.owner_content_version_id IS NULL AND s.campaign_key=p_campaign
  GROUP BY s.template_key) t;
 SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."contentItemId"),'[]') INTO owner_items FROM(
  SELECT s.owner_content_item_id AS "contentItemId",count(*) AS total,
   count(*) FILTER(WHERE s.sent_at IS NOT NULL) AS sent,
   count(*) FILTER(WHERE s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.owner_lease_id IS NOT NULL AND s.lease_until>statement_timestamp()) AS "inFlight",
   count(*) FILTER(WHERE s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.owner_held_at IS NOT NULL AND (s.owner_lease_id IS NULL OR s.lease_until<=statement_timestamp())) AS held,
   count(*) FILTER(WHERE s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.owner_held_at IS NULL AND (s.owner_lease_id IS NULL OR s.lease_until<=statement_timestamp())) AS pending,
   count(*) FILTER(WHERE s.failed_at IS NOT NULL) AS failed,count(*) FILTER(WHERE s.cancelled_at IS NOT NULL) AS cancelled,
   min(s.due_at) AS "dueAt",max(s.expires_at) AS "expiresAt",max(s.owner_hold_reason) AS "holdReason",max(s.owner_last_failure) AS "lastFailure"
  FROM app_private.mhp_marketing_sends s WHERE s.owner_workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
   AND s.owner_audience_campaign=p_campaign GROUP BY s.owner_content_item_id ORDER BY s.owner_content_item_id LIMIT 50) t;
 SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."createdAt" DESC),'[]') INTO tests FROM(
  SELECT r.created_at AS "createdAt",r.result->>'contentVersionId' AS "contentVersionId",
   CASE WHEN r.status='succeeded' THEN 'accepted' ELSE 'unknown' END AS status
  FROM app.command_receipts r WHERE r.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND r.actor_user_id=actor
   AND r.command_name='mhp.ownerEmail.test' ORDER BY r.created_at DESC,r.id DESC LIMIT 20) t;
 RETURN jsonb_build_object('brand',app_private.mhp_owner_email_brand(),'campaign',p_campaign,'eligible',eligible,
  'automatic',automatic,'ownerItems',owner_items,'tests',tests);
END $f$;

CREATE FUNCTION app_private.mhp_owner_email_action_receipt(p_actor uuid,p_action text,p_command uuid,p_payload jsonb,p_request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE r app.command_receipts%ROWTYPE; hashed bytea;
BEGIN
 IF p_actor IS NULL OR p_command IS NULL OR p_action NOT IN('schedule','replace','cancel','test')
  OR p_request IS NULL OR p_request!~'^[!-~]{1,128}$' THEN RAISE EXCEPTION 'Invalid email command' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp-owner-email-command:'||p_actor::text||':'||p_action||':'||p_command::text,7200126));
 hashed:=public.digest(p_payload::text,'sha256');
 SELECT * INTO r FROM app.command_receipts x WHERE x.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND x.actor_user_id=p_actor AND x.command_name='mhp.ownerEmail.'||p_action AND x.idempotency_key=p_command::text;
 IF FOUND THEN
  IF r.payload_hash<>hashed THEN RAISE EXCEPTION 'Email command input changed' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('receiptId',r.id,'replayed',true,'result',r.result,'status',r.status);
 END IF;
 INSERT INTO app.command_receipts(workspace_id,actor_user_id,command_name,idempotency_key,request_id,payload_hash,status,result)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b',p_actor,'mhp.ownerEmail.'||p_action,p_command::text,p_request,hashed,'started',p_payload)
 RETURNING * INTO r;
 RETURN jsonb_build_object('receiptId',r.id,'replayed',false,'result',r.result,'status',r.status);
END $f$;

CREATE FUNCTION app_private.mhp_owner_email_queue_command(p_session bytea,p_action text,p_command uuid,p_version uuid,p_campaign text,
 p_due timestamptz,p_expires timestamptz,p_request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; item uuid; exact jsonb; receipt jsonb; outcome jsonb; changed integer:=0; remaining integer:=0; inflight integer:=0;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF NOT app_private.lock_active_portal_session(p_session,actor,'2789228d-55a6-4688-b1e8-2f70abca990b')
 THEN RAISE EXCEPTION 'Owner session changed' USING ERRCODE='42501'; END IF;
 IF p_action IS NULL OR p_action NOT IN('schedule','replace','cancel') OR p_version IS NULL
  OR p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$' THEN RAISE EXCEPTION 'Invalid email action' USING ERRCODE='22023'; END IF;
 receipt:=app_private.mhp_owner_email_action_receipt(actor,p_action,p_command,jsonb_build_object('version',p_version,'campaign',p_campaign,'due',p_due,'expires',p_expires),p_request);
 IF (receipt->>'replayed')::boolean THEN RETURN (receipt->'result')||jsonb_build_object('replayed',true); END IF;
 SELECT v.content_item_id INTO item FROM app.company_content_versions v WHERE v.id=p_version
  AND v.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND v.source_system='mhp.owner-email';
 IF item IS NULL THEN RAISE EXCEPTION 'Local email unavailable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('company-content:2789228d-55a6-4688-b1e8-2f70abca990b:'||item::text,7200021));
 SELECT count(*) INTO inflight FROM app_private.mhp_marketing_sends s WHERE s.owner_content_item_id=item
  AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.owner_lease_id IS NOT NULL AND s.lease_until>clock_timestamp();
 IF p_action='cancel' THEN
  IF p_due IS NOT NULL OR p_expires IS NOT NULL THEN RAISE EXCEPTION 'Cancel has no schedule' USING ERRCODE='22023'; END IF;
  WITH targets AS(SELECT s.id FROM app_private.mhp_marketing_sends s WHERE s.owner_content_item_id=item
   AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL
   AND (s.owner_lease_id IS NULL OR s.lease_until<=clock_timestamp()) ORDER BY s.id LIMIT 500 FOR UPDATE SKIP LOCKED)
  UPDATE app_private.mhp_marketing_sends s SET cancelled_at=clock_timestamp() FROM targets t WHERE s.id=t.id;
  GET DIAGNOSTICS changed=ROW_COUNT;
  SELECT count(*) INTO remaining FROM app_private.mhp_marketing_sends s WHERE s.owner_content_item_id=item
   AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND (s.owner_lease_id IS NULL OR s.lease_until<=clock_timestamp());
 ELSE
  IF p_due IS NULL OR p_expires IS NULL OR NOT isfinite(p_due) OR NOT isfinite(p_expires)
   OR p_due<clock_timestamp() OR p_expires<=p_due THEN RAISE EXCEPTION 'Choose future send and expiry times' USING ERRCODE='22023'; END IF;
  exact:=app_private.mhp_owner_email_exact(p_version,true,true,true);
  IF exact->>'audienceCampaign'<>p_campaign THEN RAISE EXCEPTION 'Email audience changed' USING ERRCODE='23514'; END IF;
  IF p_action='schedule' THEN
   INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,
    owner_workspace_id,owner_content_item_id,owner_content_version_id,owner_content_sha256,owner_approval_decision_id,owner_user_id,owner_audience_campaign)
   SELECT a.prospect_id,'owner_followup','owner-'||item::text,jsonb_build_object('label',a.label,'link',a.link),p_due,p_expires,
    '2789228d-55a6-4688-b1e8-2f70abca990b',item,p_version,decode(exact->>'contentSha256','hex'),(exact->>'approvalDecisionId')::uuid,actor,p_campaign
   FROM app_private.mhp_owner_email_audience(p_campaign) a
   WHERE NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends s WHERE s.prospect_id=a.prospect_id AND s.owner_content_item_id=item)
   ORDER BY a.prospect_id LIMIT 500 ON CONFLICT(prospect_id,template_key,campaign_key) DO NOTHING;
   GET DIAGNOSTICS changed=ROW_COUNT;
   SELECT count(*) INTO remaining FROM app_private.mhp_owner_email_audience(p_campaign) a
    WHERE NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends s WHERE s.prospect_id=a.prospect_id AND s.owner_content_item_id=item);
  ELSE
   WITH targets AS(SELECT s.id FROM app_private.mhp_marketing_sends s JOIN app_private.mhp_owner_email_audience(p_campaign) a ON a.prospect_id=s.prospect_id
    WHERE s.owner_content_item_id=item AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL
     AND (s.owner_lease_id IS NULL OR s.lease_until<=clock_timestamp())
     AND (s.owner_held_at IS NOT NULL OR s.owner_content_version_id<>p_version OR s.due_at<>p_due OR s.expires_at<>p_expires)
    ORDER BY s.id LIMIT 500 FOR UPDATE OF s SKIP LOCKED)
   UPDATE app_private.mhp_marketing_sends s SET owner_content_version_id=p_version,owner_content_sha256=decode(exact->>'contentSha256','hex'),
    owner_approval_decision_id=(exact->>'approvalDecisionId')::uuid,owner_user_id=actor,due_at=p_due,expires_at=p_expires,
    owner_held_at=NULL,owner_hold_reason=NULL,owner_lease_id=NULL,lease_until=NULL,owner_last_failure=NULL
   FROM targets t WHERE s.id=t.id;
   GET DIAGNOSTICS changed=ROW_COUNT;
   SELECT count(*) INTO remaining FROM app_private.mhp_marketing_sends s JOIN app_private.mhp_owner_email_audience(p_campaign) a ON a.prospect_id=s.prospect_id
    WHERE s.owner_content_item_id=item AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL
     AND (s.owner_lease_id IS NULL OR s.lease_until<=clock_timestamp())
     AND (s.owner_held_at IS NOT NULL OR s.owner_content_version_id<>p_version OR s.due_at<>p_due OR s.expires_at<>p_expires);
  END IF;
 END IF;
 outcome:=jsonb_build_object('action',p_action,'contentItemId',item,'contentVersionId',p_version,'changed',changed,'remaining',remaining,'inFlight',inflight,'replayed',false);
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp()
 WHERE id=(receipt->>'receiptId')::uuid;
 RETURN outcome;
END $f$;

CREATE FUNCTION app_private.mhp_owner_email_test_begin(p_session bytea,p_command uuid,p_version uuid,p_destination_hash bytea,p_request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; receipt jsonb; exact jsonb; item uuid;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF NOT app_private.lock_active_portal_session(p_session,actor,'2789228d-55a6-4688-b1e8-2f70abca990b')
 THEN RAISE EXCEPTION 'Owner session changed' USING ERRCODE='42501'; END IF;
 IF p_version IS NULL OR p_destination_hash IS NULL OR octet_length(p_destination_hash)<>32
 THEN RAISE EXCEPTION 'Invalid owner test' USING ERRCODE='22023'; END IF;
 receipt:=app_private.mhp_owner_email_action_receipt(actor,'test',p_command,jsonb_build_object('contentVersionId',p_version,'destinationSha256',encode(p_destination_hash,'hex'),'deliveryStatus','unknown'),p_request);
 IF (receipt->>'replayed')::boolean THEN RETURN jsonb_build_object('send',false,'status',CASE WHEN receipt->>'status'='succeeded' THEN 'accepted' ELSE 'unknown' END); END IF;
 SELECT v.content_item_id INTO item FROM app.company_content_versions v WHERE v.id=p_version AND v.source_system='mhp.owner-email';
 IF item IS NULL THEN RAISE EXCEPTION 'Local email unavailable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('company-content:2789228d-55a6-4688-b1e8-2f70abca990b:'||item::text,7200021));
 exact:=app_private.mhp_owner_email_exact(p_version,false,true,true);
 RETURN jsonb_build_object('send',true,'status','unknown','exact',exact,'testId',receipt->>'receiptId');
END $f$;

CREATE FUNCTION app_private.mhp_owner_email_test_finish(p_session bytea,p_command uuid,p_accepted boolean,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF NOT app_private.lock_active_portal_session(p_session,actor,'2789228d-55a6-4688-b1e8-2f70abca990b')
 THEN RAISE EXCEPTION 'Owner session changed' USING ERRCODE='42501'; END IF;
 IF p_command IS NULL OR p_accepted IS NULL OR (p_accepted AND (p_reference IS NULL OR length(p_reference) NOT BETWEEN 1 AND 200))
 THEN RAISE EXCEPTION 'Invalid owner test outcome' USING ERRCODE='22023'; END IF;
 UPDATE app.command_receipts r SET result=r.result||jsonb_build_object('deliveryStatus',CASE WHEN p_accepted THEN 'accepted' ELSE 'unknown' END,
  'providerReference',CASE WHEN p_accepted THEN p_reference ELSE NULL END),status=CASE WHEN p_accepted THEN 'succeeded' ELSE 'failed' END,
  response_status=CASE WHEN p_accepted THEN 200 ELSE 503 END,completed_at=clock_timestamp()
 WHERE r.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND r.actor_user_id=actor
  AND r.command_name='mhp.ownerEmail.test' AND r.idempotency_key=p_command::text AND r.status='started';
END $f$;

-- Compatibility: all v1 maintenance, selection and settlement remain legacy-only.
CREATE OR REPLACE FUNCTION app_private.mhp_claim_marketing_sends(p_limit integer,p_lease_seconds integer,p_only_emails text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE claimed jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
  RAISE EXCEPTION 'Invalid claim' USING ERRCODE='22023'; END IF;
 IF p_only_emails IS NOT NULL AND (cardinality(p_only_emails) NOT BETWEEN 1 AND 20) THEN RAISE EXCEPTION 'Invalid claim' USING ERRCODE='22023'; END IF;
 UPDATE app_private.mhp_marketing_sends s SET cancelled_at=clock_timestamp()
 WHERE s.owner_content_version_id IS NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.expires_at<=clock_timestamp()
  AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp());
 UPDATE app_private.mhp_marketing_sends s SET failed_at=clock_timestamp()
 WHERE s.owner_content_version_id IS NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.attempts>=5 AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp());
 UPDATE app_private.mhp_marketing_sends s SET cancelled_at=clock_timestamp()
 FROM app_private.mhp_prospects p
 WHERE s.owner_content_version_id IS NULL AND p.id=s.prospect_id AND p.unsubscribed_at IS NOT NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL;
 WITH due AS(
  SELECT s.id FROM app_private.mhp_marketing_sends s JOIN app_private.mhp_prospects p ON p.id=s.prospect_id
  WHERE s.owner_content_version_id IS NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.due_at<=clock_timestamp()
   AND s.expires_at>clock_timestamp() AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp())
   AND (p_only_emails IS NULL OR p.email::text=ANY(p_only_emails))
  ORDER BY s.due_at,s.id LIMIT p_limit FOR UPDATE OF s SKIP LOCKED
 ), leased AS(
  UPDATE app_private.mhp_marketing_sends s SET lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempts=s.attempts+1
  FROM due WHERE s.id=due.id RETURNING s.*
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',l.id,'prospectId',p.id,'template',l.template_key,'campaign',l.campaign_key,
  'context',l.context,'email',p.email::text,'firstName',p.first_name,'level',p.level,'attempts',l.attempts,'expiresAt',l.expires_at) ORDER BY l.due_at),'[]'::jsonb)
 INTO claimed FROM leased l JOIN app_private.mhp_prospects p ON p.id=l.prospect_id;
 RETURN claimed;
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_settle_marketing_send(p_send uuid,p_accepted boolean,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_send IS NULL OR p_accepted IS NULL OR (p_accepted AND (p_reference IS NULL OR length(p_reference) NOT BETWEEN 1 AND 200)) THEN
  RAISE EXCEPTION 'Invalid settlement' USING ERRCODE='22023'; END IF;
 IF p_accepted THEN
  UPDATE app_private.mhp_marketing_sends SET sent_at=clock_timestamp(),provider_reference=p_reference,lease_until=NULL
  WHERE id=p_send AND sent_at IS NULL AND owner_content_version_id IS NULL;
 ELSE
  UPDATE app_private.mhp_marketing_sends SET lease_until=clock_timestamp()+make_interval(mins=>5*attempts)
  WHERE id=p_send AND sent_at IS NULL AND owner_content_version_id IS NULL;
 END IF;
END $f$;

CREATE FUNCTION app_private.mhp_claim_owner_marketing_sends(p_limit integer,p_lease_seconds integer,p_only_emails text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE candidate record; s app_private.mhp_marketing_sends%ROWTYPE; p app_private.mhp_prospects%ROWTYPE;
 exact jsonb; claimed jsonb:='[]'; next_lease uuid; until_at timestamptz;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900
  OR (p_only_emails IS NOT NULL AND cardinality(p_only_emails) NOT BETWEEN 1 AND 20)
 THEN RAISE EXCEPTION 'Invalid owner claim' USING ERRCODE='22023'; END IF;
 -- Terminal-only maintenance is independent of due time, holds and test recipients.
 -- Healthy held/future/other-recipient rows must not consume this bounded scan.
 FOR candidate IN SELECT q.id,q.owner_content_item_id FROM app_private.mhp_marketing_sends q
  JOIN app_private.mhp_prospects x ON x.id=q.prospect_id
  WHERE q.owner_content_version_id IS NOT NULL AND q.sent_at IS NULL AND q.cancelled_at IS NULL AND q.failed_at IS NULL
   AND (q.lease_until IS NULL OR q.lease_until<=clock_timestamp())
   AND (q.expires_at<=clock_timestamp() OR q.attempts>=5 OR x.unsubscribed_at IS NOT NULL OR NOT x.marketing_consent
    OR NOT EXISTS(
     SELECT 1 FROM (SELECT min(anchor.created_at) AS captured_at FROM app_private.mhp_marketing_sends anchor
      WHERE anchor.prospect_id=q.prospect_id AND anchor.campaign_key=q.owner_audience_campaign AND anchor.owner_content_version_id IS NULL
       AND anchor.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup')) captured
     CROSS JOIN LATERAL(SELECT signup.consent_given FROM app_private.mhp_prospect_signups signup
      WHERE signup.prospect_id=q.prospect_id AND signup.kind='webinar' AND signup.created_at<=captured.captured_at
      ORDER BY signup.created_at DESC,signup.id DESC LIMIT 1) latest WHERE latest.consent_given))
  ORDER BY q.due_at,q.id LIMIT 500
 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('company-content:2789228d-55a6-4688-b1e8-2f70abca990b:'||candidate.owner_content_item_id::text,7200021)) THEN CONTINUE; END IF;
  SELECT * INTO s FROM app_private.mhp_marketing_sends q WHERE q.id=candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR s.sent_at IS NOT NULL OR s.cancelled_at IS NOT NULL OR s.failed_at IS NOT NULL
   OR s.lease_until>clock_timestamp() THEN CONTINUE; END IF;
  SELECT * INTO p FROM app_private.mhp_prospects x WHERE x.id=s.prospect_id;
  IF s.expires_at<=clock_timestamp() OR p.unsubscribed_at IS NOT NULL OR NOT p.marketing_consent
   OR NOT EXISTS(
    SELECT 1 FROM (SELECT min(anchor.created_at) AS captured_at FROM app_private.mhp_marketing_sends anchor
     WHERE anchor.prospect_id=s.prospect_id AND anchor.campaign_key=s.owner_audience_campaign AND anchor.owner_content_version_id IS NULL
      AND anchor.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup')) captured
    CROSS JOIN LATERAL(SELECT signup.consent_given FROM app_private.mhp_prospect_signups signup
     WHERE signup.prospect_id=s.prospect_id AND signup.kind='webinar' AND signup.created_at<=captured.captured_at
     ORDER BY signup.created_at DESC,signup.id DESC LIMIT 1) latest WHERE latest.consent_given)
  THEN UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp() WHERE id=s.id;
  ELSIF s.attempts>=5 THEN UPDATE app_private.mhp_marketing_sends SET failed_at=clock_timestamp() WHERE id=s.id; END IF;
 END LOOP;
 FOR candidate IN SELECT q.id,q.owner_content_item_id FROM app_private.mhp_marketing_sends q
  JOIN app_private.mhp_prospects x ON x.id=q.prospect_id
  WHERE q.owner_content_version_id IS NOT NULL AND q.sent_at IS NULL AND q.cancelled_at IS NULL AND q.failed_at IS NULL
   AND q.owner_held_at IS NULL AND q.due_at<=clock_timestamp() AND q.expires_at>clock_timestamp() AND q.attempts<5
   AND (q.lease_until IS NULL OR q.lease_until<=clock_timestamp())
   AND x.unsubscribed_at IS NULL AND x.marketing_consent
   AND (p_only_emails IS NULL OR x.email::text=ANY(p_only_emails))
   AND EXISTS(
    SELECT 1 FROM (SELECT min(anchor.created_at) AS captured_at FROM app_private.mhp_marketing_sends anchor
     WHERE anchor.prospect_id=q.prospect_id AND anchor.campaign_key=q.owner_audience_campaign AND anchor.owner_content_version_id IS NULL
      AND anchor.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup')) captured
    CROSS JOIN LATERAL(SELECT signup.consent_given FROM app_private.mhp_prospect_signups signup
     WHERE signup.prospect_id=q.prospect_id AND signup.kind='webinar' AND signup.created_at<=captured.captured_at
     ORDER BY signup.created_at DESC,signup.id DESC LIMIT 1) latest WHERE latest.consent_given)
  ORDER BY q.due_at,q.id LIMIT 500
 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('company-content:2789228d-55a6-4688-b1e8-2f70abca990b:'||candidate.owner_content_item_id::text,7200021)) THEN CONTINUE; END IF;
  SELECT * INTO s FROM app_private.mhp_marketing_sends q WHERE q.id=candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR s.sent_at IS NOT NULL OR s.cancelled_at IS NOT NULL OR s.failed_at IS NOT NULL
   OR s.lease_until>clock_timestamp() THEN CONTINUE; END IF;
  SELECT * INTO p FROM app_private.mhp_prospects x WHERE x.id=s.prospect_id;
  IF s.expires_at<=clock_timestamp() OR p.unsubscribed_at IS NOT NULL OR NOT p.marketing_consent
   OR NOT EXISTS(
    SELECT 1 FROM (SELECT min(anchor.created_at) AS captured_at FROM app_private.mhp_marketing_sends anchor
     WHERE anchor.prospect_id=s.prospect_id AND anchor.campaign_key=s.owner_audience_campaign AND anchor.owner_content_version_id IS NULL
      AND anchor.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup')) captured
    CROSS JOIN LATERAL(SELECT signup.consent_given FROM app_private.mhp_prospect_signups signup
     WHERE signup.prospect_id=s.prospect_id AND signup.kind='webinar' AND signup.created_at<=captured.captured_at
     ORDER BY signup.created_at DESC,signup.id DESC LIMIT 1) latest WHERE latest.consent_given)
  THEN UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp() WHERE id=s.id; CONTINUE; END IF;
  IF s.attempts>=5 THEN UPDATE app_private.mhp_marketing_sends SET failed_at=clock_timestamp() WHERE id=s.id; CONTINUE; END IF;
  IF s.owner_held_at IS NOT NULL OR s.due_at>clock_timestamp()
   OR (p_only_emails IS NOT NULL AND NOT p.email::text=ANY(p_only_emails)) THEN CONTINUE; END IF;
  BEGIN
   exact:=app_private.mhp_owner_email_exact(s.owner_content_version_id,true,true,true);
   IF (exact->>'approvalDecisionId')::uuid<>s.owner_approval_decision_id
    OR decode(exact->>'contentSha256','hex')<>s.owner_content_sha256
    OR exact->>'audienceCampaign'<>s.owner_audience_campaign
    OR NOT app_private.mhp_marketing_workspace_allowed(s.owner_user_id,s.owner_workspace_id)
   THEN RAISE EXCEPTION 'Pinned owner permission changed' USING ERRCODE='23514'; END IF;
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN
   UPDATE app_private.mhp_marketing_sends SET owner_held_at=clock_timestamp(),owner_hold_reason='approval_or_brand_changed' WHERE id=s.id;
   CONTINUE;
  END;
  next_lease:=gen_random_uuid();until_at:=clock_timestamp()+make_interval(secs=>p_lease_seconds);
  UPDATE app_private.mhp_marketing_sends SET owner_lease_id=next_lease,lease_until=until_at,attempts=attempts+1 WHERE id=s.id;
  claimed:=claimed||jsonb_build_array(jsonb_build_object('id',s.id,'leaseId',next_lease,'leaseUntil',until_at));
  IF jsonb_array_length(claimed)>=p_limit THEN EXIT; END IF;
 END LOOP;
 RETURN claimed;
END $f$;

CREATE FUNCTION app_private.mhp_prepare_owner_marketing_send(p_send uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s app_private.mhp_marketing_sends%ROWTYPE; p app_private.mhp_prospects%ROWTYPE; item uuid; exact jsonb; proof uuid; checked timestamptz;
BEGIN
 IF p_send IS NULL OR p_lease IS NULL THEN RAISE EXCEPTION 'Invalid owner lease' USING ERRCODE='22023'; END IF;
 SELECT q.owner_content_item_id INTO item FROM app_private.mhp_marketing_sends q WHERE q.id=p_send AND q.owner_lease_id=p_lease;
 IF item IS NULL THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('company-content:2789228d-55a6-4688-b1e8-2f70abca990b:'||item::text,7200021));
 SELECT * INTO s FROM app_private.mhp_marketing_sends q WHERE q.id=p_send FOR UPDATE;
 IF s.owner_lease_id IS DISTINCT FROM p_lease OR s.lease_until<=clock_timestamp() OR s.lease_until IS NULL
  OR s.sent_at IS NOT NULL OR s.cancelled_at IS NOT NULL OR s.failed_at IS NOT NULL OR s.owner_held_at IS NOT NULL OR s.expires_at<=clock_timestamp()
  OR EXISTS(SELECT 1 FROM app_private.mhp_owner_email_dispatch_proofs old WHERE old.send_id=p_send AND old.lease_id=p_lease)
 THEN RETURN NULL; END IF;
 SELECT * INTO p FROM app_private.mhp_prospects x WHERE x.id=s.prospect_id;
 IF p.unsubscribed_at IS NOT NULL OR NOT p.marketing_consent
  OR NOT EXISTS(SELECT 1 FROM app_private.mhp_owner_email_audience(s.owner_audience_campaign) a WHERE a.prospect_id=s.prospect_id)
 THEN RETURN NULL; END IF;
 BEGIN
  exact:=app_private.mhp_owner_email_exact(s.owner_content_version_id,true,true,true);
  IF (exact->>'approvalDecisionId')::uuid<>s.owner_approval_decision_id OR decode(exact->>'contentSha256','hex')<>s.owner_content_sha256
   OR exact->>'audienceCampaign'<>s.owner_audience_campaign
   OR NOT app_private.mhp_marketing_workspace_allowed(s.owner_user_id,s.owner_workspace_id)
  THEN RETURN NULL; END IF;
 EXCEPTION WHEN check_violation OR insufficient_privilege THEN RETURN NULL; END;
 checked:=clock_timestamp();
 INSERT INTO app_private.mhp_owner_email_dispatch_proofs(workspace_id,send_id,lease_id,content_item_id,content_version_id,
  content_sha256,blob_sha256,brand_sha256,manifest_sha256,approval_decision_id,observed_role,observed_session_user,checked_at,expires_at)
 VALUES(s.owner_workspace_id,s.id,p_lease,s.owner_content_item_id,s.owner_content_version_id,s.owner_content_sha256,
  decode(exact->>'blobSha256','hex'),decode(exact->'brand'->>'sha256','hex'),decode(exact->>'manifestSha256','hex'),
  s.owner_approval_decision_id,'r72_identity_command',session_user,checked,least(s.lease_until,checked+interval '15 minutes')) RETURNING id INTO proof;
 RETURN jsonb_build_object('id',s.id,'leaseId',p_lease,'leaseUntil',s.lease_until,'proofId',proof,'prospectId',p.id,
  'email',p.email::text,'firstName',p.first_name,'context',s.context,'campaign',s.owner_audience_campaign,'exact',exact);
END $f$;

CREATE FUNCTION app_private.mhp_settle_owner_marketing_send(p_send uuid,p_lease uuid,p_accepted boolean,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s app_private.mhp_marketing_sends%ROWTYPE;
BEGIN
 IF p_send IS NULL OR p_lease IS NULL OR p_accepted IS NULL OR (p_accepted AND (p_reference IS NULL OR length(p_reference) NOT BETWEEN 1 AND 200))
 THEN RAISE EXCEPTION 'Invalid owner settlement' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM app_private.mhp_marketing_sends q WHERE q.id=p_send AND q.owner_content_version_id IS NOT NULL FOR UPDATE;
 IF NOT FOUND OR s.owner_lease_id IS DISTINCT FROM p_lease OR s.lease_until<=clock_timestamp() OR s.lease_until IS NULL OR s.sent_at IS NOT NULL
 THEN RAISE EXCEPTION 'Owner lease is no longer current' USING ERRCODE='23514'; END IF;
 IF p_accepted AND NOT EXISTS(SELECT 1 FROM app_private.mhp_owner_email_dispatch_proofs p WHERE p.send_id=p_send AND p.lease_id=p_lease
  AND p.content_version_id=s.owner_content_version_id AND p.content_sha256=s.owner_content_sha256 AND p.accepted IS NULL AND p.expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'Owner dispatch proof required' USING ERRCODE='23514'; END IF;
 UPDATE app_private.mhp_owner_email_dispatch_proofs SET accepted=p_accepted,provider_reference=CASE WHEN p_accepted THEN p_reference ELSE NULL END,
  completed_at=clock_timestamp() WHERE send_id=p_send AND lease_id=p_lease AND accepted IS NULL;
 IF p_accepted THEN
  -- A global unsubscribe after verified handoff cannot undo provider acceptance.
  UPDATE app_private.mhp_marketing_sends SET sent_at=clock_timestamp(),provider_reference=p_reference,owner_lease_id=NULL,lease_until=NULL,owner_last_failure=NULL WHERE id=p_send;
 ELSE
  UPDATE app_private.mhp_marketing_sends SET owner_lease_id=NULL,lease_until=clock_timestamp()+make_interval(mins=>5*attempts),
   owner_last_failure='delivery_not_accepted' WHERE id=p_send;
 END IF;
END $f$;

CREATE FUNCTION app_private.mhp_hold_owner_marketing_sends() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE changed integer; flying integer;
BEGIN
 UPDATE app_private.mhp_marketing_sends s SET owner_held_at=COALESCE(s.owner_held_at,clock_timestamp()),owner_hold_reason='recovery'
 WHERE s.owner_content_version_id IS NOT NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL
  AND (s.owner_lease_id IS NULL OR s.lease_until<=clock_timestamp()) AND s.owner_hold_reason IS DISTINCT FROM 'recovery';
 GET DIAGNOSTICS changed=ROW_COUNT;
 SELECT count(*) INTO flying FROM app_private.mhp_marketing_sends s WHERE s.owner_content_version_id IS NOT NULL
  AND s.sent_at IS NULL AND s.owner_lease_id IS NOT NULL AND s.lease_until>clock_timestamp();
 RETURN jsonb_build_object('held',changed,'inFlight',flying,'resumed',0);
END $f$;

REVOKE ALL ON FUNCTION app_private.mhp_owner_email_audience(text),app_private.mhp_owner_email_snapshot(bytea,text),
 app_private.mhp_owner_email_action_receipt(uuid,text,uuid,jsonb,text),
 app_private.mhp_owner_email_queue_command(bytea,text,uuid,uuid,text,timestamptz,timestamptz,text),
 app_private.mhp_owner_email_test_begin(bytea,uuid,uuid,bytea,text),app_private.mhp_owner_email_test_finish(bytea,uuid,boolean,text),
 app_private.mhp_claim_owner_marketing_sends(integer,integer,text[]),app_private.mhp_prepare_owner_marketing_send(uuid,uuid),
 app_private.mhp_settle_owner_marketing_send(uuid,uuid,boolean,text),app_private.mhp_hold_owner_marketing_sends() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_owner_email_authorize(bytea) TO r72_web,r72_identity_command,r72_content_adapter,r72_content_command;
GRANT EXECUTE ON FUNCTION app_private.mhp_owner_email_snapshot(bytea,text),app_private.mhp_owner_email_local_version(bytea,uuid,text) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.mhp_owner_email_queue_command(bytea,text,uuid,uuid,text,timestamptz,timestamptz,text),
 app_private.mhp_owner_email_test_begin(bytea,uuid,uuid,bytea,text),app_private.mhp_owner_email_test_finish(bytea,uuid,boolean,text),
 app_private.mhp_claim_owner_marketing_sends(integer,integer,text[]),app_private.mhp_prepare_owner_marketing_send(uuid,uuid),
 app_private.mhp_settle_owner_marketing_send(uuid,uuid,boolean,text),app_private.mhp_hold_owner_marketing_sends() TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
RESET ROLE;
