-- Apply after the preserved112->117 proofs, then migration0118. Synthetic/read-only assertions only.
SET LOCAL ROLE r72_owner;
DO $proof$
DECLARE owner_id uuid;
BEGIN
 IF (SELECT count(*) FROM app.products WHERE brand='martin_howard_property' AND sku<>'mhp_kit')<>13 THEN RAISE EXCEPTION 'V3 product count differs'; END IF;
 IF EXISTS(SELECT 1 FROM(VALUES
  ('mhp_deal_desk',4700),('mhp_course',149700),('mhp_course_3x',52500),('mhp_course_web',99700),('mhp_course_web_3x',34900),
  ('mhp_room_monthly',6700),('mhp_room_annual',67000),('mhp_room_founders',4700),('mhp_mentoring',399700),('mhp_mentoring_6x',69900),
  ('mhp_mentoring_early',299700),('mhp_mentoring_early_6x',52500),('mhp_partnership',750000)) expected(sku,price)
  LEFT JOIN app.products p ON p.sku=expected.sku WHERE p.id IS NULL OR p.price_pence<>expected.price OR p.currency<>'gbp') THEN RAISE EXCEPTION 'V3 price differs'; END IF;
 IF (SELECT count(*) FROM app.products WHERE brand='martin_howard_property' AND active)<>7
 OR EXISTS(SELECT 1 FROM app.products WHERE sku IN('mhp_deal_desk','mhp_course_web','mhp_course_web_3x','mhp_room_founders','mhp_mentoring_early','mhp_mentoring_early_6x') AND active)
 THEN RAISE EXCEPTION 'V3 special offer enabled before eligibility journey'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.products WHERE sku='mhp_kit' AND NOT active AND price_pence=9700) THEN RAISE EXCEPTION 'Retired kit history changed'; END IF;
 IF EXISTS(SELECT 1 FROM app.products WHERE brand='martin_howard_property' AND refund_days<>CASE WHEN sku='mhp_deal_desk' THEN 14 ELSE 30 END) THEN RAISE EXCEPTION 'V3 refund window differs'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.products WHERE sku='mhp_deal_desk' AND name='The Deal Desk' AND grants='{"crm":false,"enquirySite":false,"emailWorkflow":false,"leadrelay":false}'::jsonb) THEN RAISE EXCEPTION 'Unbuilt Deal Desk capability claimed'; END IF;
 IF EXISTS(SELECT 1 FROM app.products WHERE sku IN('mhp_course_3x','mhp_course_web_3x','mhp_mentoring_6x','mhp_mentoring_early_6x')
  AND (recurring_interval<>'month' OR instalments<>CASE WHEN sku LIKE 'mhp_course%' THEN 3 ELSE 6 END)) THEN RAISE EXCEPTION 'V3 finite instalments differ'; END IF;
 FOR owner_id IN SELECT id FROM app.users WHERE lower(email::text) IN('martin.howard1984@gmail.com','office@propertypredator.com') LOOP
  IF (SELECT count(*) FROM app_private.mhp_manual_grants g JOIN app.entitlements e ON e.id=g.entitlement_id JOIN app.products p ON p.id=e.product_id
   WHERE g.account_id=owner_id AND g.grant_kind='owner_seed' AND p.sku<>'mhp_kit' AND e.ends_at IS NULL AND e.source='manual' AND e.purchase_id IS NULL)<>13
  THEN RAISE EXCEPTION 'V3 permanent owner grant or audit missing'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM app.purchases WHERE organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8')
 OR EXISTS(SELECT 1 FROM app_private.mhp_purchase_payments) THEN RAISE EXCEPTION 'V3 seed fabricated paid revenue'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_private.checkout_intents'::regclass AND conname='checkout_intents_product_key_check'
  AND pg_get_constraintdef(oid) LIKE '%autopsy%' AND pg_get_constraintdef(oid) LIKE '%core_bump%' AND pg_get_constraintdef(oid) LIKE '%pro%'
  AND pg_get_constraintdef(oid) NOT LIKE '%mhp_partnership%') THEN RAISE EXCEPTION 'V3 checkout changed PP or admitted manual partnership'; END IF;
END $proof$;
SELECT 'MHP catalogue v3 proof' AS proof,10 AS passed,0 AS failed,0 AS skipped;
