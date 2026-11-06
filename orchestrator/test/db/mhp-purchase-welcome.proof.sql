-- Disposable branch only. The runner wraps this in one transaction and rolls back.
SET LOCAL ROLE r72_webhook;
DO $proof$
DECLARE payload jsonb; proof_id uuid; replay uuid; job jsonb; h bytea:=decode(repeat('42',32),'hex');
BEGIN
 payload:=jsonb_build_object('sessionId','cs_test_welcome142','sku','mhp_mentoring_6x','customerId','cus_welcome142',
  'subscriptionId','sub_welcome142','scheduleId','sub_sched_welcome142','email','welcome142@example.invalid','live',false,
  'cancelled',false,'firstPaidAt',clock_timestamp()-interval '29 days','periodEnd',clock_timestamp()+interval '31 days',
  'observedAt',clock_timestamp(),'payments',jsonb_build_array(jsonb_build_object('id','in_welcome142','paymentIntentId','pi_welcome142',
   'chargeId','ch_welcome142','amount',69900,'refunded',0,'paidAt',clock_timestamp()-interval '29 days')));
 proof_id:=app_private.record_mhp_commerce_event('acct_welcome142','evt_welcome142','checkout.session.completed',h,payload);
 replay:=app_private.record_mhp_commerce_event('acct_welcome142','evt_welcome142','checkout.session.completed',h,payload);
 IF replay<>proof_id THEN RAISE EXCEPTION 'Replay changed purchase'; END IF;
 PERFORM app_private.record_mhp_commerce_event('acct_welcome142','evt_welcome142invoice','invoice.paid',h,payload);
 IF app_private.mhp_claim_purchase_welcome('acct_other142',false) IS NOT NULL OR app_private.mhp_claim_purchase_welcome('acct_welcome142',true) IS NOT NULL THEN RAISE EXCEPTION 'Account or mode fence failed'; END IF;
 job:=app_private.mhp_claim_purchase_welcome('acct_welcome142',false);
 IF job IS NULL OR job->>'id'<>proof_id::text OR job->>'kind'<>'mentoring' THEN RAISE EXCEPTION 'Webhook role cannot claim welcome'; END IF;
 IF app_private.mhp_claim_purchase_welcome('acct_welcome142',false) IS NOT NULL THEN RAISE EXCEPTION 'Duplicate welcome claim'; END IF;
 IF app_private.mhp_begin_purchase_welcome(proof_id,gen_random_uuid(),'acct_welcome142',false) THEN RAISE EXCEPTION 'Wrong lease accepted'; END IF;
 IF app_private.mhp_begin_purchase_welcome(proof_id,(job->>'lease')::uuid,'acct_other142',false) THEN RAISE EXCEPTION 'Wrong sender accepted'; END IF;
 IF NOT app_private.mhp_begin_purchase_welcome(proof_id,(job->>'lease')::uuid,'acct_welcome142',false) THEN RAISE EXCEPTION 'Begin refused'; END IF;
 IF app_private.mhp_begin_purchase_welcome(proof_id,(job->>'lease')::uuid,'acct_welcome142',false) THEN RAISE EXCEPTION 'Begin replay accepted'; END IF;
 PERFORM app_private.mhp_settle_purchase_welcome(proof_id,(job->>'lease')::uuid,'acct_welcome142',false,'rejected');
 IF app_private.mhp_claim_purchase_welcome('acct_welcome142',false) IS NOT NULL THEN RAISE EXCEPTION 'Retry backoff ignored'; END IF;
 PERFORM set_config('proof.purchase',proof_id::text,true);
END $proof$;
SET LOCAL ROLE r72_owner;
DO $proof$
DECLARE proof_id uuid:=current_setting('proof.purchase')::uuid;
BEGIN
 IF (SELECT count(*) FROM app_private.mhp_purchase_welcomes WHERE purchase_id=proof_id)<>1 THEN RAISE EXCEPTION 'Receipt replay duplicated outbox'; END IF;
 IF (SELECT attempts FROM app_private.mhp_purchase_welcomes WHERE purchase_id=proof_id)<>1 THEN RAISE EXCEPTION 'Wrong attempt count'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.purchases b JOIN app.products p ON p.id=b.product_id WHERE b.id=proof_id AND p.refund_days=30 AND b.first_paid_at<clock_timestamp()-interval '28 days') THEN RAISE EXCEPTION 'Mentoring window no longer first-payment based'; END IF;
 UPDATE app_private.mhp_purchase_welcomes SET available_at=clock_timestamp()-interval '1 second' WHERE purchase_id=proof_id;
END $proof$;
SET LOCAL ROLE r72_webhook;
DO $proof$
DECLARE job jsonb;
BEGIN
 job:=app_private.mhp_claim_purchase_welcome('acct_welcome142',false);
 IF job IS NULL THEN RAISE EXCEPTION 'Explicit rejection not retryable'; END IF;
 PERFORM set_config('proof.lease',job->>'lease',true);
END $proof$;
SET LOCAL ROLE r72_owner;
UPDATE app_private.mhp_purchase_welcomes SET lease_until=clock_timestamp()-interval '1 second' WHERE purchase_id=current_setting('proof.purchase')::uuid;
SET LOCAL ROLE r72_webhook;
DO $proof$
DECLARE job jsonb; proof_id uuid:=current_setting('proof.purchase')::uuid;
BEGIN
 job:=app_private.mhp_claim_purchase_welcome('acct_welcome142',false);
 IF job IS NULL OR job->>'lease'=current_setting('proof.lease') THEN RAISE EXCEPTION 'Expired pre-call lease not recovered'; END IF;
 IF NOT app_private.mhp_begin_purchase_welcome(proof_id,(job->>'lease')::uuid,'acct_welcome142',false) THEN RAISE EXCEPTION 'Recovered lease cannot begin'; END IF;
END $proof$;
SET LOCAL ROLE r72_owner;
UPDATE app_private.mhp_purchase_welcomes SET lease_until=clock_timestamp()-interval '1 second' WHERE purchase_id=current_setting('proof.purchase')::uuid;
SET LOCAL ROLE r72_webhook;
DO $proof$
BEGIN
 IF app_private.mhp_claim_purchase_welcome('acct_welcome142',false) IS NOT NULL THEN RAISE EXCEPTION 'Unknown provider outcome retried'; END IF;
END $proof$;
SET LOCAL ROLE r72_owner;
DO $proof$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_purchase_welcomes WHERE purchase_id=current_setting('proof.purchase')::uuid AND state='unknown' AND attempts=2) THEN RAISE EXCEPTION 'Unknown outcome not held'; END IF;
 IF has_table_privilege('r72_webhook','app_private.mhp_purchase_welcomes','SELECT') OR has_table_privilege('r72_web','app_private.mhp_purchase_welcomes','SELECT') OR has_function_privilege('r72_web','app_private.mhp_claim_purchase_welcome(text,boolean)','EXECUTE') THEN RAISE EXCEPTION 'Unintended welcome authority'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='app_private.mhp_purchase_welcomes'::regclass AND relrowsecurity AND relforcerowsecurity) THEN RAISE EXCEPTION 'Welcome RLS missing'; END IF;
END $proof$;
RESET ROLE;
