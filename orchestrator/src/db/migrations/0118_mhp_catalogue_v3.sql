-- Founder-authorised catalogue v3. No Stripe effects, eligibility dates or paid DealDesk feature claims.
SET LOCAL ROLE r72_owner;
DO $guard$
BEGIN
 IF EXISTS(SELECT 1 FROM app.purchases WHERE organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8') THEN
  RAISE EXCEPTION 'MHP catalogue v3 requires the pre-launch empty purchase ledger; version historical prices explicitly before proceeding';
 END IF;
END $guard$;

-- Keep the retired product and its existing manual audit/history.
UPDATE app.products SET active=false WHERE organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND sku='mhp_kit';
INSERT INTO app.products(organization_id,brand,sku,name,type,price_pence,refund_days,recurring_interval,instalments,grants,active)
SELECT 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'::uuid,'martin_howard_property',sku,name,kind,amount,refund_days,recurrence,payments,
 jsonb_build_object('crm',crm,'enquirySite',crm,'emailWorkflow',advanced,'leadrelay',advanced),available
FROM(VALUES
 ('mhp_deal_desk','The Deal Desk','kit',4700,14,NULL::text,NULL::integer,false,false,false),
 ('mhp_course','Property Investor Course','course',149700,30,NULL,NULL,true,false,true),
 ('mhp_course_3x','Property Investor Course - 3 monthly payments','course',52500,30,'month',3,true,false,true),
 ('mhp_course_web','Property Investor Course - eligible webinar or referral offer','course',99700,30,NULL,NULL,true,false,false),
 ('mhp_course_web_3x','Property Investor Course - eligible webinar offer, 3 monthly payments','course',34900,30,'month',3,true,false,false),
 ('mhp_room_monthly','Members Room - monthly','membership',6700,30,'month',NULL,true,false,true),
 ('mhp_room_annual','Members Room - annual','membership',67000,30,'year',NULL,true,false,true),
 ('mhp_room_founders','Members Room - eligible founder rate','membership',4700,30,'month',NULL,true,false,false),
 ('mhp_mentoring','Property Mentoring','cohort',399700,30,NULL,NULL,true,true,true),
 ('mhp_mentoring_6x','Property Mentoring - 6 monthly payments','cohort',69900,30,'month',6,true,true,true),
 ('mhp_mentoring_early','Property Mentoring - eligible early application offer','cohort',299700,30,NULL,NULL,true,true,false),
 ('mhp_mentoring_early_6x','Property Mentoring - eligible early offer, 6 monthly payments','cohort',52500,30,'month',6,true,true,false),
 ('mhp_partnership','Property Partnership','partnership',750000,30,NULL,NULL,true,true,true)
) AS p(sku,name,kind,amount,refund_days,recurrence,payments,crm,advanced,available)
ON CONFLICT(sku) DO UPDATE SET name=excluded.name,type=excluded.type,price_pence=excluded.price_pence,refund_days=excluded.refund_days,
 recurring_interval=excluded.recurring_interval,instalments=excluded.instalments,grants=excluded.grants,active=excluded.active
WHERE app.products.organization_id=excluded.organization_id AND app.products.brand=excluded.brand;

-- Preserve PP and historical MHP keys. Partnership has no checkout key.
ALTER TABLE app_private.checkout_intents DROP CONSTRAINT checkout_intents_product_key_check;
ALTER TABLE app_private.checkout_intents ADD CONSTRAINT checkout_intents_product_key_check CHECK(product_key IN(
 'autopsy','core','core_bump','pro','mhp_kit','mhp_deal_desk','mhp_course','mhp_course_3x','mhp_course_web','mhp_course_web_3x',
 'mhp_room_monthly','mhp_room_annual','mhp_room_founders','mhp_mentoring','mhp_mentoring_6x','mhp_mentoring_early','mhp_mentoring_early_6x'));
ALTER TABLE app_private.checkout_intents DROP CONSTRAINT checkout_intents_product_stage_check;
ALTER TABLE app_private.checkout_intents ADD CONSTRAINT checkout_intents_product_stage_check CHECK(
 (product_key='autopsy' AND through_stage='S1' AND NOT portal_access AND expected_mode='payment') OR
 (product_key IN('core','core_bump','pro') AND through_stage='S9' AND portal_access AND expected_mode='payment') OR
 (product_key IN('mhp_kit','mhp_deal_desk','mhp_course','mhp_course_3x','mhp_course_web','mhp_course_web_3x','mhp_room_monthly','mhp_room_annual',
  'mhp_room_founders','mhp_mentoring','mhp_mentoring_6x','mhp_mentoring_early','mhp_mentoring_early_6x') AND through_stage='S9')
);

-- Permanent no-checkout owner entitlements for every new catalogue product.
-- Previously audited owner grants remain immutable; missing products are added once.
DO $seed$
DECLARE u record;p record;e uuid;stamp timestamptz:=clock_timestamp();
BEGIN
 FOR u IN SELECT id,email::text AS email,COALESCE(display_name,email::text) AS name FROM app.users
 WHERE lower(email::text) IN('martin.howard1984@gmail.com','office@propertypredator.com') LOOP
  FOR p IN SELECT * FROM app.products WHERE organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND brand='martin_howard_property' AND sku<>'mhp_kit' LOOP
   IF EXISTS(SELECT 1 FROM app_private.mhp_manual_grants WHERE account_id=u.id AND product_id=p.id AND grant_kind='owner_seed') THEN CONTINUE; END IF;
   e:=gen_random_uuid();
   INSERT INTO app.entitlements(id,account_id,product_id,grants,starts_at,source,source_reference)
   VALUES(e,u.id,p.id,p.grants,stamp,'manual','mhp-owner-seed-0118-v3');
   INSERT INTO app_private.mhp_manual_grants(entitlement_id,command_id,account_id,product_id,target_email,target_name,starts_at,note,grant_kind,request_payload)
   VALUES(e,gen_random_uuid(),u.id,p.id,lower(u.email),u.name,stamp,'Founder-authorised permanent owner access: MHP catalogue v3','owner_seed',jsonb_build_object('migration','0118','owner',lower(u.email),'product',p.id));
  END LOOP;
 END LOOP;
END $seed$;
