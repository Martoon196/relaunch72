-- Original methods 0.1.1 and owner-only email/advocacy authoring. No delivery capabilities.
-- Does not change any applied migration, subscription, provider or brand assignment.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;

CREATE TABLE app.seo_blog_creator_campaigns(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('email','advocacy')), input_hash text NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),
  brief jsonb NOT NULL CHECK(jsonb_typeof(brief)='object' AND octet_length(brief::text)<=16384),
  profile_version integer NOT NULL, facts_sha text NOT NULL, assignment_revision integer NOT NULL,
  method_receipt_id uuid NOT NULL, reserved_tokens bigint NOT NULL CHECK(reserved_tokens BETWEEN 0 AND 500000),
  state text NOT NULL CHECK(state IN ('generating','draft','held','unknown','approved')),
  current_version integer NOT NULL DEFAULT 0, row_version integer NOT NULL DEFAULT 1,
  approval jsonb, detail text NOT NULL DEFAULT '', created_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,assignment_revision) REFERENCES app.seo_blog_method_assignments(workspace_id,revision)
);
CREATE TABLE app.seo_blog_creator_versions(
  workspace_id uuid NOT NULL, campaign_id uuid NOT NULL, number integer NOT NULL CHECK(number>0),
  content_text text NOT NULL CHECK(octet_length(content_text)<=65536 AND jsonb_typeof(content_text::jsonb)='object'),
  content_sha text NOT NULL CHECK(content_sha=encode(sha256(convert_to(content_text,'UTF8')),'hex')),
  method_receipt_id uuid, created_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,campaign_id,number), FOREIGN KEY(workspace_id,campaign_id) REFERENCES app.seo_blog_creator_campaigns(workspace_id,id),
  FOREIGN KEY(workspace_id,method_receipt_id) REFERENCES app.seo_blog_method_receipts(workspace_id,id)
);
DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seo_blog_creator_campaigns','seo_blog_creator_versions'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_content_command,r72_web,r72_worker',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_seo_method_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_scope',t);
    EXECUTE format('GRANT SELECT,INSERT ON app.%I TO r72_seo_method_definer',t);
    INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
  END LOOP;
END $tables$;
GRANT UPDATE ON app.seo_blog_creator_campaigns TO r72_seo_method_definer;
CREATE TRIGGER seo_creator_versions_immutable BEFORE UPDATE OR DELETE ON app.seo_blog_creator_versions FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();
GRANT CREATE ON SCHEMA app_private TO r72_seo_method_definer;
SET LOCAL ROLE r72_seo_method_definer;

CREATE FUNCTION app_private.seo_creator_profile(p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE p jsonb; docs jsonb;
BEGIN
  SELECT data INTO p FROM app.seo_blog_records WHERE workspace_id=p_workspace AND kind='profile' ORDER BY (data->>'version')::integer DESC LIMIT 1;
  IF p IS NULL OR p->>'confirmedAt' IS NULL OR jsonb_array_length(p->'conflicts')>0 THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(data),'[]'::jsonb) INTO docs FROM (
    SELECT DISTINCT ON (data->>'id') data FROM app.seo_blog_records WHERE workspace_id=p_workspace AND kind='knowledge'
    ORDER BY data->>'id',(data->>'version')::integer DESC
  ) d WHERE data->>'active'='true';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(docs) d WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'knowledge') k
    WHERE k->>'documentId'=d->>'id' AND k->>'version'=d->>'version' AND k->>'sha256'=d->>'sha256'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'knowledge') k WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(docs) d
    WHERE k->>'documentId'=d->>'id' AND k->>'version'=d->>'version' AND k->>'sha256'=d->>'sha256')) THEN RETURN NULL; END IF;
  RETURN p;
END $f$;

CREATE FUNCTION app_private.seo_creator_record(p_workspace uuid,p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('id',c.id,'brandId',c.workspace_id,'brief',c.brief,'profileVersion',c.profile_version,'factsSha',c.facts_sha,
  'assignmentRevision',c.assignment_revision,'state',c.state,'rowVersion',c.row_version,'approval',c.approval,'detail',c.detail,'createdAt',c.created_at,
  'version',CASE WHEN v.number IS NULL THEN NULL ELSE jsonb_build_object('number',v.number,'content',v.content_text::jsonb,'contentSha',v.content_sha,'methodReceiptId',v.method_receipt_id,'createdAt',v.created_at,'createdBy',v.created_by) END)
 FROM app.seo_blog_creator_campaigns c LEFT JOIN app.seo_blog_creator_versions v ON v.workspace_id=c.workspace_id AND v.campaign_id=c.id AND v.number=c.current_version
 WHERE c.workspace_id=p_workspace AND c.id=p_id
$f$;

CREATE FUNCTION app_private.seo_creator_command(p_workspace uuid,p_session bytea,p_id uuid,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app.seo_blog_creator_campaigns; v app.seo_blog_creator_versions; p jsonb; a app.seo_blog_method_assignments;
 used bigint; reserved bigint; ceiling bigint; receipt jsonb; body text; sha text; next_state text; required_pack text;
BEGIN
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
 IF p_action='list' THEN RETURN coalesce((SELECT jsonb_agg(app_private.seo_creator_record(p_workspace,id) ORDER BY created_at DESC) FROM app.seo_blog_creator_campaigns WHERE workspace_id=p_workspace),'[]'::jsonb); END IF;
 IF p_action='get' THEN RETURN app_private.seo_creator_record(p_workspace,p_id); END IF;
 IF p_action NOT IN ('begin','complete','edit','approve','recover') THEN RAISE EXCEPTION 'Unknown creator command' USING ERRCODE='22023'; END IF;
 -- Serialise allowance reservations with assignment changes and other creator starts for this brand.
 PERFORM workspace_id FROM app.seo_blog_brands WHERE workspace_id=p_workspace FOR UPDATE;
 SELECT * INTO c FROM app.seo_blog_creator_campaigns WHERE workspace_id=p_workspace AND id=p_id FOR UPDATE;
 SELECT * INTO a FROM app.seo_blog_method_assignments WHERE workspace_id=p_workspace ORDER BY revision DESC LIMIT 1;
 p:=app_private.seo_creator_profile(p_workspace);
 IF p_action='begin' THEN
   IF c.id IS NOT NULL THEN
     IF c.input_hash IS DISTINCT FROM p_input->>'inputHash' THEN RAISE EXCEPTION 'Command input changed' USING ERRCODE='40001'; END IF;
     RETURN jsonb_build_object('created',false,'record',app_private.seo_creator_record(p_workspace,p_id));
   END IF;
   required_pack:=CASE p_input#>>'{brief,kind}' WHEN 'email' THEN 'email-writing' WHEN 'advocacy' THEN 'advocacy-and-referral' ELSE NULL END;
   IF p_id IS NULL OR p_input->>'brandId' IS DISTINCT FROM p_workspace::text OR p_input->>'actorId' IS DISTINCT FROM actor::text
     OR required_pack IS NULL OR p_input->>'id' IS DISTINCT FROM p_id::text OR (p_input->>'reservation')::bigint<>350000
     OR p IS NULL OR p->>'version' IS DISTINCT FROM p_input->>'profileVersion' OR p->>'factsSha' IS DISTINCT FROM p_input->>'factsSha'
     OR a.revision IS NULL OR a.revision IS DISTINCT FROM (p_input->>'assignmentRevision')::integer THEN
     RAISE EXCEPTION 'Current confirmed profile and method assignment required' USING ERRCODE='55000'; END IF;
   IF NOT EXISTS(SELECT 1 FROM app.seo_blog_brands b JOIN app.seo_blog_method_private_organizations o ON o.organization_id=b.organization_id WHERE b.workspace_id=p_workspace)
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.pins) pin JOIN app.seo_blog_method_releases r ON r.pack_id=pin->>'packId' AND r.version=pin->>'version' AND r.canonical_sha256=pin->>'hash'
       WHERE r.pack_id=required_pack AND r.version='0.1.1' AND r.private_approval='approved') THEN RAISE EXCEPTION 'Reviewed private creator assignment required' USING ERRCODE='42501'; END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'conversionPages') page WHERE page->>'url'=p_input#>>'{brief,cta,url}' AND page->>'label'=p_input#>>'{brief,cta,label}') THEN RAISE EXCEPTION 'Approved brand action required' USING ERRCODE='22023'; END IF;
   SELECT coalesce(sum(amount),0) INTO used FROM app.seo_blog_usage WHERE workspace_id=p_workspace AND kind='model_tokens' AND at>=date_trunc('month',clock_timestamp());
   SELECT coalesce(sum(reserved_tokens),0) INTO reserved FROM app.seo_blog_creator_campaigns WHERE workspace_id=p_workspace;
   SELECT (settings#>>'{budgets,modelTokensPerMonth}')::bigint INTO ceiling FROM app.seo_blog_brands WHERE workspace_id=p_workspace;
   IF ceiling IS NULL OR ceiling-used-reserved<350000 THEN RAISE EXCEPTION 'More writing allowance is needed for this campaign; pending or uncertain runs retain their reservation' USING ERRCODE='55000'; END IF;
   INSERT INTO app.seo_blog_creator_campaigns(workspace_id,id,kind,input_hash,brief,profile_version,facts_sha,assignment_revision,method_receipt_id,reserved_tokens,state,created_by)
     VALUES(p_workspace,p_id,p_input#>>'{brief,kind}',p_input->>'inputHash',p_input->'brief',(p_input->>'profileVersion')::integer,p_input->>'factsSha',a.revision,(p_input->>'methodReceiptId')::uuid,350000,'generating',actor);
   RETURN jsonb_build_object('created',true,'record',app_private.seo_creator_record(p_workspace,p_id));
 END IF;
 IF c.id IS NULL THEN RAISE EXCEPTION 'Campaign not found' USING ERRCODE='22023'; END IF;
 IF p_action='recover' THEN
   p_action:='complete';p_input:=jsonb_build_object('receiptId',c.method_receipt_id,'detail','Recovered the saved generation receipt without another model call.');
 END IF;
 IF p_action='complete' THEN
   IF c.method_receipt_id IS DISTINCT FROM (p_input->>'receiptId')::uuid THEN RAISE EXCEPTION 'Wrong campaign receipt' USING ERRCODE='42501'; END IF;
   SELECT data INTO receipt FROM app.seo_blog_method_receipts WHERE workspace_id=p_workspace AND id=c.method_receipt_id;
   IF c.state<>'generating' AND NOT(c.state='unknown' AND receipt->>'outcome' IN ('accepted','rejected')) THEN RETURN app_private.seo_creator_record(p_workspace,p_id); END IF;
   body:=coalesce(p_input->>'contentText',CASE WHEN receipt->>'outcome'='accepted' THEN receipt->>'resultText' ELSE NULL END);
   IF receipt IS NULL OR receipt->>'outcome'='unknown' THEN next_state:='unknown';
   ELSIF receipt->>'outcome'='rejected' THEN next_state:='held';
   ELSIF body IS NOT NULL AND receipt->>'outcome'='accepted' THEN
     sha:=encode(sha256(convert_to(body,'UTF8')),'hex');
     IF receipt->>'assetRef' IS DISTINCT FROM 'creator:'||p_id::text OR receipt->>'stage' IS DISTINCT FROM c.kind
       OR receipt->>'resultHash' IS DISTINCT FROM sha OR receipt->>'profileVersion' IS DISTINCT FROM c.profile_version::text
       OR receipt#>>'{assignment,revision}' IS DISTINCT FROM c.assignment_revision::text THEN RAISE EXCEPTION 'Campaign body does not match generation receipt' USING ERRCODE='42501'; END IF;
     INSERT INTO app.seo_blog_creator_versions(workspace_id,campaign_id,number,content_text,content_sha,method_receipt_id,created_by) VALUES(p_workspace,p_id,1,body,sha,c.method_receipt_id,actor);
     next_state:='draft';
   ELSE next_state:='held'; END IF;
   IF next_state='draft' AND (p IS NULL OR p->>'version' IS DISTINCT FROM c.profile_version::text OR p->>'factsSha' IS DISTINCT FROM c.facts_sha OR a.revision IS DISTINCT FROM c.assignment_revision) THEN next_state:='held'; END IF;
   UPDATE app.seo_blog_creator_campaigns SET state=next_state,current_version=CASE WHEN sha IS NOT NULL THEN 1 ELSE 0 END,
     reserved_tokens=CASE WHEN next_state='unknown' THEN reserved_tokens ELSE 0 END,row_version=row_version+1,
     detail=CASE WHEN next_state='held' AND sha IS NOT NULL THEN 'Brand context or production rules changed during generation. Create a new campaign from the current confirmed inputs.' ELSE left(coalesce(p_input->>'detail','Review this campaign'),800) END WHERE workspace_id=p_workspace AND id=p_id;
   RETURN app_private.seo_creator_record(p_workspace,p_id);
 END IF;
 SELECT * INTO v FROM app.seo_blog_creator_versions WHERE workspace_id=p_workspace AND campaign_id=p_id AND number=c.current_version;
 IF c.row_version IS DISTINCT FROM (p_input->>'expectedRowVersion')::integer OR v.content_sha IS NULL OR v.content_sha IS DISTINCT FROM p_input->>'expectedSha' THEN RAISE EXCEPTION 'Campaign version changed' USING ERRCODE='40001'; END IF;
 IF p IS NULL OR p->>'version' IS DISTINCT FROM c.profile_version::text OR p->>'factsSha' IS DISTINCT FROM c.facts_sha OR a.revision IS DISTINCT FROM c.assignment_revision THEN RAISE EXCEPTION 'Current profile or production rules changed; create a new campaign from the confirmed inputs' USING ERRCODE='55000'; END IF;
 IF c.state IN ('generating','held','unknown') THEN RAISE EXCEPTION 'Held or uncertain generation cannot be approved or edited as a clean draft' USING ERRCODE='55000'; END IF;
 IF p_action='edit' THEN
   body:=p_input->>'contentText';sha:=encode(sha256(convert_to(body,'UTF8')),'hex');
   IF sha=v.content_sha THEN RETURN app_private.seo_creator_record(p_workspace,p_id); END IF;
   INSERT INTO app.seo_blog_creator_versions(workspace_id,campaign_id,number,content_text,content_sha,created_by) VALUES(p_workspace,p_id,c.current_version+1,body,sha,actor);
   UPDATE app.seo_blog_creator_campaigns SET current_version=current_version+1,state='draft',approval=NULL,row_version=row_version+1,detail='Owner edit saved. Review this new version before export.' WHERE workspace_id=p_workspace AND id=p_id;
 ELSE
   UPDATE app.seo_blog_creator_campaigns SET state='approved',approval=jsonb_build_object('version',current_version,'contentSha',v.content_sha,'by',actor,'at',clock_timestamp()),row_version=row_version+1,detail='Approved authoring draft. No messages have been sent or scheduled.' WHERE workspace_id=p_workspace AND id=p_id;
 END IF;
 RETURN app_private.seo_creator_record(p_workspace,p_id);
END $f$;

REVOKE ALL ON FUNCTION app_private.seo_creator_profile(uuid),app_private.seo_creator_record(uuid,uuid),app_private.seo_creator_command(uuid,bytea,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_creator_command(uuid,bytea,uuid,text,jsonb) TO r72_content_command;

-- METHOD_RECEIPT_EXTENSION_AND_RELEASE_SEEDS
CREATE OR REPLACE FUNCTION app_private.seo_method_save_receipt(p_workspace uuid,p_session bytea,p_data jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app.seo_blog_method_assignments; pin jsonb; saved app.seo_blog_method_receipts;
BEGIN
  PERFORM app_private.seo_media_private_actor(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  IF p_data->>'brandId' IS DISTINCT FROM p_workspace::text OR p_data->>'approvalState' IS DISTINCT FROM 'draft'
    OR p_data->>'outcome' IS NULL OR p_data->>'outcome' NOT IN ('accepted','rejected','unknown')
    OR p_data->>'stage' IS NULL OR p_data->>'stage' NOT IN ('planning','blog','revision','social','email','advocacy')
    OR p_data->>'promptHash' IS NULL OR p_data#>>'{usage,tokensIn}' IS NULL OR p_data#>>'{usage,tokensOut}' IS NULL
    OR p_data->>'revisionPasses' IS NULL OR p_data->>'profileVersion' IS NULL OR (p_data->>'profileVersion')::integer<1
    OR (p_data->>'outcome'='accepted' AND (p_data->>'resultHash' IS NULL OR p_data->>'resultHash' !~ '^[0-9a-f]{64}$'))
    OR jsonb_typeof(p_data->'pins') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_data->'pins') NOT BETWEEN 1 AND 12 OR p_data->>'promptHash' !~ '^[0-9a-f]{64}$'
    OR (p_data#>>'{usage,tokensIn}')::bigint NOT BETWEEN 0 AND 10000000
    OR (p_data#>>'{usage,tokensOut}')::bigint NOT BETWEEN 0 AND 10000000
    OR (p_data->>'revisionPasses')::integer NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'Invalid method receipt' USING ERRCODE='22023';
  END IF;
  SELECT * INTO a FROM app.seo_blog_method_assignments WHERE workspace_id=p_workspace
    AND revision=(p_data#>>'{assignment,revision}')::integer;
  IF a.revision IS NULL OR a.scope IS DISTINCT FROM p_data#>>'{assignment,scope}'
    OR a.pins IS DISTINCT FROM p_data#>'{assignment,pins}' THEN RAISE EXCEPTION 'Invalid assignment receipt' USING ERRCODE='42501'; END IF;
  FOR pin IN SELECT value FROM jsonb_array_elements(p_data->'pins') LOOP
    IF NOT a.pins @> jsonb_build_array(pin) OR NOT EXISTS(SELECT 1 FROM app.seo_blog_method_releases r
      WHERE r.pack_id=pin->>'packId' AND r.version=pin->>'version' AND r.canonical_sha256=pin->>'hash' AND r.private_approval='approved')
      THEN RAISE EXCEPTION 'Unapproved receipt method' USING ERRCODE='42501'; END IF;
  END LOOP;
  SELECT * INTO saved FROM app.seo_blog_method_receipts WHERE workspace_id=p_workspace AND id=(p_data->>'id')::uuid;
  IF saved.id IS NOT NULL THEN
    IF saved.data IS DISTINCT FROM p_data THEN RAISE EXCEPTION 'Receipt is immutable' USING ERRCODE='42501'; END IF;
    RETURN;
  END IF;
  INSERT INTO app.seo_blog_method_receipts(workspace_id,id,assignment_revision,data)
    VALUES(p_workspace,(p_data->>'id')::uuid,a.revision,p_data);
  -- Blog success usage stays in its engine. Creator usage and rejected calls are charged once here, even if a later asset save fails.
  IF p_data->>'outcome'<>'accepted' OR p_data->>'stage' IN ('email','advocacy') THEN
    INSERT INTO app.seo_blog_usage(workspace_id,kind,amount,at,reference) VALUES(p_workspace,'model_tokens',
      (p_data#>>'{usage,tokensIn}')::bigint+(p_data#>>'{usage,tokensOut}')::bigint,clock_timestamp(),'method-cost:'||(p_data->>'id'));
  END IF;
END $f$;


RESET ROLE;
SET LOCAL ROLE r72_owner;
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('advocacy-and-referral','0.1.1','5f5445da6dbbc471d4b16df7fced6fa37a64526fb44faecc5652efdf1e9730ea','private-owned-brands','approved','Martin, chat 2026-11-04: implement the three fixes, prepare the six packs for own brands, and add Inbox Engine and Word of Mouth Engine. Private authoring only; release validation gate required.','blocked','Public commercial-use approval remains separate and unrecorded.','docs/rl72-boosters-0.1.1.md; original-document comparison and release validation required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('blog-writing','0.1.1','3c43d95d51651ff8af8389bb40eb35f7afb8dac267fe476e7c579aa73e8fd063','private-owned-brands','approved','Martin, chat 2026-11-04: implement the three fixes, prepare the six packs for own brands, and add Inbox Engine and Word of Mouth Engine. Private authoring only; release validation gate required.','blocked','Public commercial-use approval remains separate and unrecorded.','docs/rl72-boosters-0.1.1.md; original-document comparison and release validation required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('conversion-copy','0.1.1','10777fa8331f1e1dc7cc6431cc91ef4baea08d88f548af675d52c5a0e50ecc34','private-owned-brands','approved','Martin, chat 2026-11-04: implement the three fixes, prepare the six packs for own brands, and add Inbox Engine and Word of Mouth Engine. Private authoring only; release validation gate required.','blocked','Public commercial-use approval remains separate and unrecorded.','docs/rl72-boosters-0.1.1.md; original-document comparison and release validation required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('editorial-planning','0.1.1','6663021c521271bfd9aa9b83f9585facccec2763fcac9dccfbb259d2504eae2d','private-owned-brands','approved','Martin, chat 2026-11-04: implement the three fixes, prepare the six packs for own brands, and add Inbox Engine and Word of Mouth Engine. Private authoring only; release validation gate required.','blocked','Public commercial-use approval remains separate and unrecorded.','docs/rl72-boosters-0.1.1.md; original-document comparison and release validation required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('email-writing','0.1.1','a2a314dad44b48fdac700e2ef29f814ad4647c6328ca3faca7a125a763fe6fc5','private-owned-brands','approved','Martin, chat 2026-11-04: implement the three fixes, prepare the six packs for own brands, and add Inbox Engine and Word of Mouth Engine. Private authoring only; release validation gate required.','blocked','Public commercial-use approval remains separate and unrecorded.','docs/rl72-boosters-0.1.1.md; original-document comparison and release validation required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('production-core','0.1.1','7bcc918952b1d6f56363e61ae0723f9cd48e3e4926eeb5c421aedfbc8cb9826e','private-owned-brands','approved','Martin, chat 2026-11-04: implement the three fixes, prepare the six packs for own brands, and add Inbox Engine and Word of Mouth Engine. Private authoring only; release validation gate required.','blocked','Public commercial-use approval remains separate and unrecorded.','docs/rl72-boosters-0.1.1.md; original-document comparison and release validation required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('social-repurposing','0.1.1','b0bd8597873769cedfdac9cf28d574363d64ededcdcb00342064902ceea7cc28','private-owned-brands','approved','Martin, chat 2026-11-04: implement the three fixes, prepare the six packs for own brands, and add Inbox Engine and Word of Mouth Engine. Private authoring only; release validation gate required.','blocked','Public commercial-use approval remains separate and unrecorded.','docs/rl72-boosters-0.1.1.md; original-document comparison and release validation required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('visual-briefing','0.1.1','b310bd14ba857190bfe035eb5a497533f119b4330cf8bdf5f6cff21e2e11514f','private-owned-brands','approved','Martin, chat 2026-11-04: implement the three fixes, prepare the six packs for own brands, and add Inbox Engine and Word of Mouth Engine. Private authoring only; release validation gate required.','blocked','Public commercial-use approval remains separate and unrecorded.','docs/rl72-boosters-0.1.1.md; original-document comparison and release validation required.');
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_seo_method_definer;
