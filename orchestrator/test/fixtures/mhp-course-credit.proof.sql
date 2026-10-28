-- Isolated branch only, after0119/0120, within the runner's rolled-back transaction.
SET LOCAL ROLE r72_owner;
DO $proof$
DECLARE buyer uuid:='12000000-0000-4000-8000-000000000011'; other_id uuid:='12000000-0000-4000-8000-000000000012';
 token bytea:=decode(repeat('c1',32),'hex'); other_token bytea:=decode(repeat('c2',32),'hex'); h bytea:=decode(repeat('c3',32),'hex');
 command uuid:='12000000-0000-4000-8000-000000000013'; ws uuid; other_ws uuid; purchase uuid; course uuid; credit uuid; p jsonb; plan jsonb; old_expiry timestamptz; count_pass integer:=0;
BEGIN
 INSERT INTO app.users(id,email,status,email_verified_at,display_name) VALUES
 (buyer,'mhp-credit-proof@example.invalid','active',clock_timestamp(),'Credit proof'),(other_id,'mhp-credit-other@example.invalid','active',clock_timestamp(),'Manual proof');
 p:=jsonb_build_object('sessionId','cs_test_creditdesk','sku','mhp_deal_desk','customerId','cus_creditproof','subscriptionId',NULL,'scheduleId',NULL,
  'email','mhp-credit-proof@example.invalid','live',false,'cancelled',false,'firstPaidAt',clock_timestamp()-interval '1 day','periodEnd',NULL,'observedAt',clock_timestamp(),
  'payments',jsonb_build_array(jsonb_build_object('id','pi_creditdesk','paymentIntentId','pi_creditdesk','chargeId','ch_creditdesk','amount',4700,'refunded',0,'paidAt',clock_timestamp()-interval '1 day')));
 purchase:=app_private.record_mhp_commerce_event('acct_creditproof','evt_creditdesk','checkout.session.completed',h,p);
 SELECT id,expires_at INTO credit,old_expiry FROM app_private.mhp_course_credits WHERE purchase_id=purchase;
 IF credit IS NULL OR old_expiry<>(SELECT first_paid_at+interval '30 days' FROM app.purchases WHERE id=purchase) THEN RAISE EXCEPTION 'Credit creation/expiry incorrect'; END IF; count_pass:=count_pass+1;
 IF (SELECT count(*) FROM app_private.mhp_email_handoffs WHERE purchase_id=purchase AND status='held')<>3
  OR (SELECT array_agg(template_id ORDER BY due_at) FROM app_private.mhp_email_handoffs WHERE purchase_id=purchase)<>ARRAY[27,28,29] THEN RAISE EXCEPTION 'D4 handoff templates missing'; END IF; count_pass:=count_pass+1;
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_purchase_contact_attributes WHERE purchase_id=purchase AND attributes->>'DESK_BUYER'='true'
   AND attributes->>'DESK_CREDIT_END'=to_char(old_expiry AT TIME ZONE 'Europe/London','FMDD FMMonth YYYY') AND attributes->>'VERDICT_FORM_SENT'='false') THEN RAISE EXCEPTION 'Purchase contact attributes incorrect'; END IF; count_pass:=count_pass+1;
 PERFORM app_private.record_mhp_commerce_event('acct_creditproof','evt_creditdesk','checkout.session.completed',h,p);
 IF (SELECT count(*) FROM app_private.mhp_email_handoffs WHERE purchase_id=purchase)<>3 OR (SELECT count(*) FROM app_private.mhp_course_credits WHERE purchase_id=purchase)<>1 THEN RAISE EXCEPTION 'Replay duplicated credit/email handoff'; END IF; count_pass:=count_pass+1;
 IF EXISTS(SELECT 1 FROM app.entitlements WHERE purchase_id=purchase) THEN RAISE EXCEPTION 'Receipt granted unbound identity'; END IF; count_pass:=count_pass+1;
 PERFORM app_private.mhp_bind_verified_purchases(buyer); ws:=app_private.ensure_mhp_member_workspace(buyer);
 PERFORM app_private.mhp_set_manual_access(other_id,true,'course','credit proof manual'); other_ws:=app_private.ensure_mhp_member_workspace(other_id);
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
 VALUES(token,h,buyer,ws,clock_timestamp()+interval '1 hour','martin_howard_property'),(other_token,h,other_id,other_ws,clock_timestamp()+interval '1 hour','martin_howard_property');
 IF app_private.mhp_course_credit_snapshot(other_token)->>'status'<>'unavailable'
  OR EXISTS(SELECT 1 FROM app_private.mhp_purchase_contact_attributes WHERE buyer_email='mhp-credit-other@example.invalid') THEN RAISE EXCEPTION 'Manual grant fabricated buyer credit/attributes'; END IF; count_pass:=count_pass+1;
 PERFORM app_private.mhp_submit_verdict(token,'12000000-0000-4000-8000-000000000014','{"experience":"Starting","budget":"GBP 25000","weeklyTime":"10 hours","areas":"Leeds","goals":"One rental","questions":"Which lane?"}'::jsonb);
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_purchase_contact_attributes WHERE purchase_id=purchase AND attributes->>'VERDICT_FORM_SENT'='true') THEN RAISE EXCEPTION 'Verdict submitted flag missing'; END IF; count_pass:=count_pass+1;
 plan:=app_private.mhp_begin_course_checkout(token,command,'price_course','mhp_course_v3',date_trunc('second',clock_timestamp())+interval '30 minutes');
 IF plan->>'id'<>command::text OR (plan->>'amountPence')::integer<>145000 OR plan->>'actorId'<>buyer::text THEN RAISE EXCEPTION 'Credit reservation terms differ'; END IF; count_pass:=count_pass+1;
 IF app_private.mhp_begin_course_checkout(token,'12000000-0000-4000-8000-000000000015','price_course','mhp_course_v3',clock_timestamp()+interval '30 minutes')->>'id'<>command::text
  OR (SELECT count(*) FROM app_private.mhp_credit_checkouts WHERE credit_id=credit)<>1 THEN RAISE EXCEPTION 'Parallel/repeated browser command reserves credit twice'; END IF; count_pass:=count_pass+1;
 BEGIN
  PERFORM app_private.mhp_begin_course_checkout(other_token,command,'price_course','mhp_course_v3',clock_timestamp()+interval '30 minutes');
  RAISE EXCEPTION 'Another account reused command';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END; count_pass:=count_pass+1;
 PERFORM app_private.mhp_record_credit_checkout(command,'acct_creditproof','cs_test_creditcourse','https://checkout.stripe.com/c/pay/synthetic','open',(plan->>'expiresAt')::timestamptz);
 -- Reservation made before the deadline may finish within its fixed checkout allowance.
 UPDATE app_private.mhp_course_credits SET expires_at=clock_timestamp()-interval '1 second' WHERE id=credit;
 p:=jsonb_build_object('sessionId','cs_test_creditcourse','sku','mhp_course','customerId','cus_creditproof','subscriptionId',NULL,'scheduleId',NULL,
  'email','mhp-credit-proof@example.invalid','live',false,'cancelled',false,'firstPaidAt',clock_timestamp(),'periodEnd',NULL,'observedAt',clock_timestamp(),
  'payments',jsonb_build_array(jsonb_build_object('id','pi_creditcourse','paymentIntentId','pi_creditcourse','chargeId','ch_creditcourse','amount',145000,'refunded',0,'paidAt',clock_timestamp())));
 BEGIN
  PERFORM app_private.record_mhp_commerce_event('acct_creditproof','evt_forgedcredit','checkout.session.completed',h,p);
  RAISE EXCEPTION 'Discount without reservation accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END; count_pass:=count_pass+1;
 p:=p||jsonb_build_object('creditAttemptId',command);
 BEGIN
  PERFORM app_private.record_mhp_commerce_event('acct_creditproof','evt_wrongcreditbuyer','checkout.session.completed',h,jsonb_set(p,'{customerId}','"cus_other"'::jsonb));
  RAISE EXCEPTION 'Credit transferred to another customer';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END; count_pass:=count_pass+1;
 course:=app_private.record_mhp_commerce_event('acct_creditproof','evt_creditcourse','checkout.session.completed',h,p);
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_course_credits WHERE id=credit AND redeemed_purchase_id=course)
  OR NOT EXISTS(SELECT 1 FROM app.entitlements WHERE purchase_id=course AND account_id=buyer AND source='purchase' AND ends_at IS NULL) THEN RAISE EXCEPTION 'Credit did not create owned course entitlement'; END IF; count_pass:=count_pass+1;
 IF EXISTS(SELECT 1 FROM app_private.mhp_email_handoffs WHERE purchase_id=purchase AND status<>'cancelled') THEN RAISE EXCEPTION 'Course purchase did not exit D4'; END IF; count_pass:=count_pass+1;
 PERFORM app_private.record_mhp_commerce_event('acct_creditproof','evt_creditcourse','checkout.session.completed',h,p);
 IF (SELECT count(*) FROM app.entitlements WHERE purchase_id=course)<>1 OR app_private.mhp_course_credit_snapshot(token)->>'status'<>'used' THEN RAISE EXCEPTION 'Credit completion replay duplicated grant'; END IF; count_pass:=count_pass+1;
 -- Freeze is the signed-full-refund barrier BEFORE provider checkout enumeration.
 p:=jsonb_build_object('sessionId','cs_test_otherdesk','sku','mhp_deal_desk','customerId','cus_otherproof','subscriptionId',NULL,'scheduleId',NULL,
  'email','mhp-credit-other@example.invalid','live',false,'cancelled',false,'firstPaidAt',clock_timestamp(),'periodEnd',NULL,'observedAt',clock_timestamp(),
  'payments',jsonb_build_array(jsonb_build_object('id','pi_otherdesk','paymentIntentId','pi_otherdesk','chargeId','ch_otherdesk','amount',4700,'refunded',0,'paidAt',clock_timestamp())));
 purchase:=app_private.record_mhp_commerce_event('acct_creditproof','evt_otherdesk','checkout.session.completed',h,p);
 PERFORM app_private.mhp_bind_verified_purchases(other_id);
 PERFORM app_private.mhp_freeze_course_credit('acct_creditproof','cs_test_otherdesk');
 BEGIN
  PERFORM app_private.mhp_begin_course_checkout(other_token,'12000000-0000-4000-8000-000000000016','price_course','mhp_course_v3',clock_timestamp()+interval '30 minutes');
  RAISE EXCEPTION 'Reservation slipped between refund freeze and receipt';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END; count_pass:=count_pass+1;
 PERFORM app_private.record_mhp_commerce_event('acct_creditproof','evt_otherrefund','charge.refunded',h,jsonb_set(p,'{payments,0,refunded}','4700'::jsonb));
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_course_credits WHERE purchase_id=purchase AND revoked_at IS NOT NULL AND redeemed_purchase_id IS NULL)
  OR EXISTS(SELECT 1 FROM app_private.mhp_email_handoffs WHERE purchase_id=purchase AND status<>'cancelled') THEN RAISE EXCEPTION 'Refund did not revoke unused credit/D4'; END IF; count_pass:=count_pass+1;
 IF has_table_privilege('r72_web','app_private.mhp_course_credits','SELECT') OR has_function_privilege('r72_web','app_private.mhp_freeze_course_credit(text,text)','EXECUTE')
  OR has_function_privilege('r72_identity_command','app_private.record_mhp_commerce_event(text,text,text,bytea,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Credit runtime ACL too broad'; END IF; count_pass:=count_pass+1;
 IF count_pass<>18 THEN RAISE EXCEPTION 'Unexpected proof assertion count: %',count_pass; END IF;
END $proof$;
SELECT 'MHP purchase credit and held D4' AS proof,18 AS passed,0 AS failed,0 AS skipped;
RESET ROLE;
