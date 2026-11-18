-- Applied transactionally to production EU 2026-11-17. Do not re-run policy creation.
SET LOCAL ROLE r72_owner;
GRANT SELECT ON app.pipelines,app.pipeline_stages,app.opportunities TO r72_mhp_prospect_definer;
GRANT INSERT ON app.opportunities,app.opportunity_stage_history,app.tasks TO r72_mhp_prospect_definer;
CREATE POLICY mhp_book_pipeline_read ON app.pipelines FOR SELECT TO r72_mhp_prospect_definer USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_book_stage_read ON app.pipeline_stages FOR SELECT TO r72_mhp_prospect_definer USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_book_opportunity_read ON app.opportunities FOR SELECT TO r72_mhp_prospect_definer USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_book_opportunity_insert ON app.opportunities FOR INSERT TO r72_mhp_prospect_definer WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND name LIKE 'Before You Buy book enquiry%' AND status='open' AND value_minor=0);
CREATE POLICY mhp_book_history_insert ON app.opportunity_stage_history FOR INSERT TO r72_mhp_prospect_definer WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND actor_kind='system' AND note='Book signup received');
CREATE POLICY mhp_book_task_insert ON app.tasks FOR INSERT TO r72_mhp_prospect_definer WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND title='Follow up Before You Buy book enquiry' AND status='open');
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE OR REPLACE FUNCTION app_private.mhp_book_contact_after_signup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE p app_private.mhp_prospects%ROWTYPE; contact uuid; matches integer; pipe uuid; stage uuid; opportunity uuid;
 ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b';
 owner_id constant uuid:='5a3e599f-c3bd-4fdc-acc0-a3f5fa95fab4';
BEGIN
 IF NEW.module IS DISTINCT FROM 'book-before-you-buy' OR NEW.label IS DISTINCT FROM 'Before You Buy — book interest' OR NEW.kind<>'waitlist' THEN RETURN NEW; END IF;
 SELECT * INTO STRICT p FROM app_private.mhp_prospects WHERE id=NEW.prospect_id;
 IF p.email::text LIKE '%.invalid' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp:book-contact:'||p.email::text,121));
 SELECT count(*),min(cp.contact_id::text)::uuid INTO matches,contact FROM app.contact_points cp
 WHERE cp.workspace_id=ws AND cp.kind='email' AND lower(cp.normalized_value)=p.email::text AND cp.deleted_at IS NULL;
 IF matches>1 THEN RETURN NEW; END IF;
 IF matches=1 THEN
  IF NOT EXISTS(SELECT 1 FROM app.contacts c JOIN app.contact_points cp ON cp.workspace_id=c.workspace_id AND cp.contact_id=c.id
   WHERE c.workspace_id=ws AND c.id=contact AND c.deleted_at IS NULL AND c.lifecycle_status<>'archived'
    AND cp.kind='email' AND cp.normalized_value=p.email::text AND cp.deleted_at IS NULL AND cp.dedupe_state='normal') THEN RETURN NEW; END IF;
 ELSE
  contact:=gen_random_uuid();
  INSERT INTO app.contacts(id,workspace_id,display_name,source,custom_fields)
  VALUES(contact,ws,coalesce(p.first_name,p.email::text),'mhp:book-before-you-buy',jsonb_build_object('bookInterest','Before You Buy','mhpProspectId',p.id::text));
  INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_verified,consent_status)
  VALUES(ws,contact,'email',p.email::text,p.email::text,false,'unknown');
 END IF;
 -- One book enquiry per contact. Never reset an enquiry that has already progressed.
 IF EXISTS(SELECT 1 FROM app.opportunities o WHERE o.workspace_id=ws AND o.contact_id=contact AND o.name LIKE 'Before You Buy book enquiry%') THEN RETURN NEW; END IF;
 SELECT pp.id,s.id INTO STRICT pipe,stage FROM app.pipelines pp JOIN app.pipeline_stages s ON s.workspace_id=pp.workspace_id AND s.pipeline_id=pp.id
 WHERE pp.workspace_id=ws AND pp.slug::text='enquiries' AND pp.status='active' AND pp.is_default AND s.slug::text='new' AND s.stage_type='open' AND NOT s.is_terminal;
 opportunity:=gen_random_uuid();
 INSERT INTO app.opportunities(id,workspace_id,contact_id,pipeline_id,stage_id,name,owner_user_id)
 VALUES(opportunity,ws,contact,pipe,stage,left('Before You Buy book enquiry · '||coalesce(p.first_name,p.email::text),200),owner_id);
 INSERT INTO app.opportunity_stage_history(workspace_id,pipeline_id,opportunity_id,to_stage_id,actor_kind,note)
 VALUES(ws,pipe,opportunity,stage,'system','Book signup received');
 INSERT INTO app.tasks(workspace_id,contact_id,opportunity_id,title,description,assignee_user_id,due_at)
 VALUES(ws,contact,opportunity,'Follow up Before You Buy book enquiry','Book reader requested Chapter One and launch updates. Review their request and recorded permissions before following up.',owner_id,clock_timestamp()+interval '1 day');
 RETURN NEW;
END $f$;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
RESET ROLE;

-- Regression: repeated signup creates exactly one New enquiry and one assigned task.
DO $test$
DECLARE prospect uuid; n integer;
BEGIN
 BEGIN
 INSERT INTO app_private.mhp_prospects(email,first_name) VALUES('book-pipeline-regression-20261117@example.com','Book pipeline regression') RETURNING id INTO prospect;
 INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,consent_given,consent_version)
 VALUES(prospect,'waitlist','Before You Buy — book interest','book-before-you-buy',true,'test');
 INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,consent_given,consent_version)
 VALUES(prospect,'waitlist','Before You Buy — book interest','book-before-you-buy',true,'test');
 SELECT count(*) INTO n FROM app.opportunities o JOIN app.contact_points cp ON cp.contact_id=o.contact_id AND cp.workspace_id=o.workspace_id JOIN app.pipeline_stages s ON s.id=o.stage_id AND s.workspace_id=o.workspace_id WHERE cp.normalized_value='book-pipeline-regression-20261117@example.com' AND s.name='New enquiry';
 IF n<>1 THEN RAISE EXCEPTION 'Expected one New enquiry, got %',n; END IF;
 SELECT count(*) INTO n FROM app.tasks t JOIN app.contact_points cp ON cp.contact_id=t.contact_id AND cp.workspace_id=t.workspace_id WHERE cp.normalized_value='book-pipeline-regression-20261117@example.com' AND t.title='Follow up Before You Buy book enquiry' AND t.assignee_user_id='5a3e599f-c3bd-4fdc-acc0-a3f5fa95fab4';
 IF n<>1 THEN RAISE EXCEPTION 'Expected one assigned followup task, got %',n; END IF;
 RAISE EXCEPTION USING ERRCODE='ZB001',MESSAGE='rollback regression fixtures';
 EXCEPTION WHEN SQLSTATE 'ZB001' THEN NULL;
 END;
END $test$