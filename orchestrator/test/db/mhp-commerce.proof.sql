-- Execute only in an isolated branch, after 0113--0116, inside a transaction
-- that the runner rolls back. All people/payment identifiers below are synthetic.
SET LOCAL ROLE r72_owner;
DO $proof$
DECLARE
 buyer uuid:='11400000-0000-4000-8000-000000000001';
 outsider uuid:='11400000-0000-4000-8000-000000000002';
 ws uuid:='11400000-0000-4000-8000-000000000003';
 token bytea:=decode(repeat('14',32),'hex');
 other_token bytea:=decode(repeat('15',32),'hex');
 pp_token bytea:=decode(repeat('16',32),'hex');
 h bytea:=decode(repeat('ab',32),'hex');
 payload jsonb; purchase uuid; actual jsonb; p app.purchases%ROWTYPE;
BEGIN
 INSERT INTO app.users(id,email,status,display_name) VALUES(buyer,'mhp-commerce-proof@example.invalid','active','Synthetic buyer'),(outsider,'mhp-other-proof@example.invalid','active','Synthetic other');
 payload:=jsonb_build_object('sessionId','cs_test_mhpproof','sku','mhp_course','customerId','cus_mhpproof','subscriptionId',NULL,'scheduleId',NULL,
  'email','mhp-commerce-proof@example.invalid','live',false,'cancelled',false,'firstPaidAt',clock_timestamp()-interval '10 days','periodEnd',NULL,'observedAt',clock_timestamp(),
  'payments',jsonb_build_array(jsonb_build_object('id','pi_mhpproof','paymentIntentId','pi_mhpproof','chargeId','ch_mhpproof','amount',99700,'refunded',0,'paidAt',clock_timestamp()-interval '10 days')));
 purchase:=app_private.record_mhp_commerce_event('acct_mhpproof','evt_mhpproof1','checkout.session.completed',h,payload);
 IF (SELECT account_id IS NOT NULL FROM app.purchases WHERE id=purchase) OR EXISTS(SELECT 1 FROM app.entitlements WHERE purchase_id=purchase) THEN RAISE EXCEPTION 'Unverified email granted access'; END IF;
 BEGIN
  PERFORM app_private.mhp_bind_verified_purchases(buyer);
  RAISE EXCEPTION 'Unverified identity accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 UPDATE app.users SET email_verified_at=clock_timestamp() WHERE id IN(buyer,outsider);
 PERFORM app_private.mhp_bind_verified_purchases(buyer);
 IF NOT (app_private.mhp_account_access(buyer)->>'crm')::boolean THEN RAISE EXCEPTION 'Verified purchase has no CRM access'; END IF;
 IF app_private.record_mhp_commerce_event('acct_mhpproof','evt_mhpproof1','checkout.session.completed',h,payload)<>purchase OR (SELECT count(*) FROM app.entitlements WHERE purchase_id=purchase)<>1 THEN RAISE EXCEPTION 'Receipt replay was not idempotent'; END IF;
 BEGIN
  PERFORM app_private.record_mhp_commerce_event('acct_mhpproof','evt_mhpproof1','checkout.session.completed',decode(repeat('cd',32),'hex'),payload);
  RAISE EXCEPTION 'Changed replay digest accepted';
 EXCEPTION WHEN serialization_failure THEN NULL; END;
 BEGIN
  PERFORM app_private.record_mhp_commerce_event('acct_mhpproof','evt_badamount','invoice.paid',h,jsonb_set(payload,'{payments,0,amount}','1'::jsonb));
  RAISE EXCEPTION 'Wrong amount accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 IF EXISTS(SELECT 1 FROM app_private.mhp_stripe_events WHERE event_id='evt_badamount') THEN RAISE EXCEPTION 'Failed event recorded'; END IF;

 -- Partial refunds are recorded without revoking the whole purchase. A full
 -- refund ends paid access and starts exactly seven days of read-only access.
 PERFORM app_private.record_mhp_commerce_event('acct_mhpproof','evt_partial','charge.refunded',h,jsonb_set(payload,'{payments,0,refunded}','500'::jsonb));
 IF (SELECT status FROM app.purchases WHERE id=purchase)<>'paid' THEN RAISE EXCEPTION 'Partial refund revoked whole purchase'; END IF;
 PERFORM app_private.record_mhp_commerce_event('acct_mhpproof','evt_full','charge.refunded',h,jsonb_set(payload,'{payments,0,refunded}','99700'::jsonb));
 actual:=app_private.mhp_account_access(buyer);
 IF NOT (actual->>'crm')::boolean OR NOT (actual->>'readOnly')::boolean OR (actual->>'enquirySite')::boolean THEN RAISE EXCEPTION 'Refund grace grants incorrect'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.entitlements WHERE purchase_id=purchase AND read_only_until=ends_at+interval '7 days') THEN RAISE EXCEPTION 'Refund grace not seven days'; END IF;
 PERFORM app_private.record_mhp_commerce_event('acct_mhpproof','evt_oldpaid','invoice.paid',h,payload);
 IF (SELECT status FROM app.purchases WHERE id=purchase)<>'refunded' THEN RAISE EXCEPTION 'Stale paid event revived refund'; END IF;
 PERFORM app_private.mhp_set_manual_access(buyer,true,'mentoring','synthetic proof');
 actual:=app_private.mhp_account_access(buyer);
 IF (actual->>'readOnly')::boolean OR NOT (actual->>'emailWorkflow')::boolean THEN RAISE EXCEPTION 'Independent entitlement lost on other purchase refund'; END IF;
 PERFORM app_private.mhp_set_manual_access(buyer,false,'mentoring','synthetic proof');

 -- A fully paid three-instalment course remains owned after its schedule ends.
 payload:=jsonb_build_object('sessionId','cs_test_mhpinstalments','sku','mhp_course_3x','customerId','cus_mhpproof','subscriptionId','sub_mhpproof','scheduleId','sub_sched_mhpproof',
  'email','mhp-commerce-proof@example.invalid','live',false,'cancelled',true,'firstPaidAt',clock_timestamp()-interval '65 days','periodEnd',clock_timestamp()+interval '20 days','observedAt',clock_timestamp(),
  'payments',(SELECT jsonb_agg(jsonb_build_object('id','in_proof'||n,'paymentIntentId','pi_proof'||n,'chargeId','ch_proof'||n,'amount',34900,'refunded',0,'paidAt',clock_timestamp()-make_interval(days=>65-(n-1)*30))) FROM generate_series(1,3) n));
 purchase:=app_private.record_mhp_commerce_event('acct_mhpproof','evt_instalments','customer.subscription.deleted',h,payload);
 PERFORM app_private.mhp_bind_verified_purchases(buyer);
 IF NOT EXISTS(SELECT 1 FROM app.entitlements WHERE purchase_id=purchase AND ends_at IS NULL) THEN RAISE EXCEPTION 'Paid-in-full course ended with schedule'; END IF;

 INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES(ws,'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8','Synthetic commerce proof','mhp-commerce-proof');
 INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('ba41b1a4-9752-4dbf-8312-d04a0f03d0b8',buyer,'owner','active'),('ba41b1a4-9752-4dbf-8312-d04a0f03d0b8',outsider,'billing','active');
 INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES(ws,'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8',buyer,'owner','active'),(ws,'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8',outsider,'viewer','active');
 INSERT INTO app_private.mhp_members(workspace_id,user_id,owner_email) VALUES(ws,buyer,'mhp-commerce-proof@example.invalid');
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience) VALUES(token,h,buyer,ws,clock_timestamp()+interval '1 hour','martin_howard_property'),(other_token,h,outsider,ws,clock_timestamp()+interval '1 hour','martin_howard_property'),(pp_token,h,buyer,ws,clock_timestamp()+interval '1 hour','property_predator_growth');
 BEGIN
  PERFORM app_private.mhp_begin_refund(other_token,purchase);
  RAISE EXCEPTION 'Other account can refund purchase';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM app_private.mhp_account_snapshot(pp_token);
  RAISE EXCEPTION 'Property Predator session accepted by MHP account';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM app_private.mhp_begin_refund(token,purchase);
  RAISE EXCEPTION 'Refund after thirty days accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 UPDATE app.purchases SET first_paid_at=clock_timestamp()-interval '29 days' WHERE id=purchase;
 actual:=app_private.mhp_begin_refund(token,purchase);
 IF actual->>'purchaseId'<>purchase::text THEN RAISE EXCEPTION 'In-window refund request missing'; END IF;
 UPDATE app.purchases SET first_paid_at=clock_timestamp()-interval '31 days' WHERE id=purchase;
 PERFORM app_private.mhp_begin_refund(token,purchase); -- authorised request survives retry after deadline
 IF has_table_privilege('r72_web','app.purchases','SELECT') OR has_table_privilege('r72_identity_command','app.entitlements','UPDATE') OR has_function_privilege('r72_web','app_private.mhp_bind_verified_purchases(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected commerce runtime authority'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname,c.relname) IN(('app','products'),('app','purchases'),('app','entitlements'),('app_private','mhp_stripe_events'),('app_private','mhp_purchase_payments'),('app_private','mhp_refund_requests')) AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)) THEN RAISE EXCEPTION 'Commerce RLS missing'; END IF;
 RAISE NOTICE 'MHP commerce proof passed: receipt replay/conflict, verified binding, amount rejection, refund/grace/order, entitlement overlap, completed instalments, ownership/audience/window/retry and runtime ACL/RLS';
END $proof$;
RESET ROLE;
