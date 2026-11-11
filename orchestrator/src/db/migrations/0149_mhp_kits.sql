-- MHP-KITS-001: module kits sold on their own. Additive: three private tables and
-- definer functions, plus three existing functions widened by one OR clause each:
--   * mhp_has_purchase_email also admits a kit buyer, so they can sign in;
--   * mhp_course_outline and mhp_course_content also open a module whose kit the
--     signed-in member holds (not refunded).
-- The kit catalogue and its prices live in code (src/mhp/kits.ts); the database
-- records what Stripe confirmed was paid. Paid kit files live here, never in a
-- public repository, and are released only by mhp_kit_file.

SET LOCAL ROLE r72_owner;

CREATE TABLE app_private.mhp_kit_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_account text NOT NULL CHECK (stripe_account ~ '^acct_[A-Za-z0-9]{1,64}$'),
  live boolean NOT NULL,
  session_id text NOT NULL UNIQUE CHECK (session_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,200}$'),
  payment_intent_id text NOT NULL UNIQUE CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9]{1,200}$'),
  email citext NOT NULL CHECK (email::text = lower(btrim(email::text)) AND length(email::text) BETWEEN 3 AND 320
    AND email::text ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'),
  buyer_name text NOT NULL DEFAULT '' CHECK (length(buyer_name) <= 200),
  kind text NOT NULL CHECK (kind IN ('single', 'pair')),
  kits text[] NOT NULL,
  modules text[] NOT NULL,
  amount_pence integer NOT NULL CHECK (amount_pence BETWEEN 1 AND 1000000),
  paid_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  refunded_at timestamptz,
  receipt_state text NOT NULL DEFAULT 'pending' CHECK (receipt_state IN ('pending', 'sending', 'sent', 'rejected', 'unknown')),
  job_lease uuid,
  job_lease_until timestamptz,
  job_attempts integer NOT NULL DEFAULT 0 CHECK (job_attempts BETWEEN 0 AND 100),
  job_done_at timestamptz,
  CHECK (cardinality(kits) = CASE kind WHEN 'single' THEN 1 ELSE 2 END),
  CHECK (cardinality(modules) = cardinality(kits)),
  CHECK (kits[1] ~ '^[a-z0-9-]{1,80}$' AND (cardinality(kits) = 1 OR (kits[2] ~ '^[a-z0-9-]{1,80}$' AND kits[2] <> kits[1]))),
  CHECK (modules[1] ~ '^[0-9]{2}$' AND (cardinality(modules) = 1 OR modules[2] ~ '^[0-9]{2}$'))
);
CREATE INDEX mhp_kit_orders_email_idx ON app_private.mhp_kit_orders (email);
CREATE INDEX mhp_kit_orders_jobs_idx ON app_private.mhp_kit_orders (stripe_account, live) WHERE job_done_at IS NULL;

CREATE TABLE app_private.mhp_kit_files (
  kit text NOT NULL CHECK (kit ~ '^[a-z0-9-]{1,80}$'),
  filename text NOT NULL CHECK (filename ~ '^[a-z0-9][a-z0-9.-]{0,150}\.(pdf|xlsx|docx)$'),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 20000000),
  uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (kit, filename)
);

REVOKE ALL ON app_private.mhp_kit_orders, app_private.mhp_kit_files FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_private.mhp_kit_orders, app_private.mhp_kit_files TO r72_security_definer;
GRANT EXECUTE ON FUNCTION app_private.resolve_session(bytea), app_private.mhp_is_programme_admin(uuid) TO r72_security_definer;

GRANT CREATE ON SCHEMA app_private TO r72_security_definer;
SET LOCAL ROLE r72_security_definer;

-- The signed-in MHP member and their verified email, or NULL.
CREATE FUNCTION app_private.mhp_kit_session_user(p_session bytea) RETURNS TABLE (user_id uuid, email text, is_admin boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT u.id, lower(u.email::text), app_private.mhp_is_programme_admin(u.id)
  FROM app_private.resolve_session(p_session) s
  JOIN app.user_sessions us ON us.id = s.session_id AND us.product_audience = 'martin_howard_property'
  JOIN app.users u ON u.id = s.user_id AND u.status = 'active'
$f$;

-- Signed Stripe evidence only (the webhook checked the session, amount and kits first). Idempotent per session.
CREATE FUNCTION app_private.mhp_record_kit_order(p_account text, p_live boolean, p_session text, p_intent text, p_email text,
  p_name text, p_kind text, p_kits text[], p_modules text[], p_amount integer, p_paid_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE existing app_private.mhp_kit_orders%ROWTYPE; created uuid;
BEGIN
  SELECT * INTO existing FROM app_private.mhp_kit_orders WHERE session_id = p_session;
  IF FOUND THEN
    IF existing.stripe_account <> p_account OR existing.live <> p_live OR existing.payment_intent_id <> p_intent
       OR existing.kits <> p_kits OR existing.amount_pence <> p_amount THEN
      RAISE EXCEPTION 'Kit order evidence changed' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', existing.id, 'created', false);
  END IF;
  INSERT INTO app_private.mhp_kit_orders (stripe_account, live, session_id, payment_intent_id, email, buyer_name, kind, kits, modules, amount_pence, paid_at)
  VALUES (p_account, p_live, p_session, p_intent, lower(btrim(p_email)), left(COALESCE(btrim(p_name), ''), 200), p_kind, p_kits, p_modules, p_amount, p_paid_at)
  RETURNING id INTO created;
  RETURN jsonb_build_object('id', created, 'created', true);
END $f$;

-- A refunded order no longer opens anything; the buyer may still sign in, as former buyers can.
CREATE FUNCTION app_private.mhp_refund_kit_order(p_account text, p_live boolean, p_intent text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $f$
  WITH changed AS (
    UPDATE app_private.mhp_kit_orders SET refunded_at = COALESCE(refunded_at, clock_timestamp())
    WHERE stripe_account = p_account AND live = p_live AND payment_intent_id = p_intent RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM changed)
$f$;

CREATE FUNCTION app_private.mhp_kit_email_known(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT EXISTS (SELECT 1 FROM app_private.mhp_kit_orders WHERE email::text = lower(btrim(p_email)))
$f$;

CREATE FUNCTION app_private.mhp_kit_module_open(p_user uuid, p_module text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT EXISTS (SELECT 1 FROM app.users u JOIN app_private.mhp_kit_orders o ON o.email::text = lower(u.email::text)
    WHERE u.id = p_user AND u.status = 'active' AND o.refunded_at IS NULL AND p_module = ANY (o.modules))
$f$;

-- The signed-in member's kits (not refunded) with their file names; an admin also sees every kit's files.
CREATE FUNCTION app_private.mhp_my_kits(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE me record;
BEGIN
  SELECT * INTO me FROM app_private.mhp_kit_session_user(p_session);
  IF me.user_id IS NULL THEN RAISE EXCEPTION 'MHP session required' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object('isAdmin', me.is_admin,
    'kits', COALESCE((SELECT jsonb_agg(jsonb_build_object('kit', k.kit, 'orderedAt', k.ordered_at) ORDER BY k.ordered_at, k.kit)
      FROM (SELECT x.kit, min(o.paid_at) AS ordered_at FROM app_private.mhp_kit_orders o CROSS JOIN LATERAL unnest(o.kits) AS x(kit)
            WHERE o.email::text = me.email AND o.refunded_at IS NULL GROUP BY x.kit) k), '[]'::jsonb),
    'files', COALESCE((SELECT jsonb_agg(jsonb_build_object('kit', f.kit, 'name', f.filename, 'size', octet_length(f.bytes)) ORDER BY f.kit, f.filename)
      FROM app_private.mhp_kit_files f
      WHERE me.is_admin OR EXISTS (SELECT 1 FROM app_private.mhp_kit_orders o WHERE o.email::text = me.email AND o.refunded_at IS NULL AND f.kit = ANY (o.kits))), '[]'::jsonb));
END $f$;

CREATE FUNCTION app_private.mhp_kit_file(p_session bytea, p_kit text, p_name text) RETURNS TABLE (content_type text, bytes bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE me record;
BEGIN
  SELECT * INTO me FROM app_private.mhp_kit_session_user(p_session);
  IF me.user_id IS NULL THEN RAISE EXCEPTION 'MHP session required' USING ERRCODE = '42501'; END IF;
  IF NOT me.is_admin AND NOT EXISTS (SELECT 1 FROM app_private.mhp_kit_orders o
     WHERE o.email::text = me.email AND o.refunded_at IS NULL AND p_kit = ANY (o.kits)) THEN
    RAISE EXCEPTION 'Kit access required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT f.content_type, f.bytes FROM app_private.mhp_kit_files f WHERE f.kit = p_kit AND f.filename = p_name;
END $f$;

-- Owner upload: replaces a kit's files as one set.
CREATE FUNCTION app_private.mhp_store_kit_files(p_session bytea, p_kit text, p_files jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE me record; f jsonb; stored integer := 0;
BEGIN
  SELECT * INTO me FROM app_private.mhp_kit_session_user(p_session);
  IF me.user_id IS NULL OR NOT me.is_admin THEN RAISE EXCEPTION 'Owner access required' USING ERRCODE = '42501'; END IF;
  IF p_kit IS NULL OR p_kit !~ '^[a-z0-9-]{1,80}$' OR jsonb_typeof(p_files) <> 'array' OR jsonb_array_length(p_files) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'Invalid kit files' USING ERRCODE = '22023';
  END IF;
  DELETE FROM app_private.mhp_kit_files WHERE kit = p_kit;
  FOR f IN SELECT value FROM jsonb_array_elements(p_files) LOOP
    INSERT INTO app_private.mhp_kit_files (kit, filename, content_type, bytes)
    VALUES (p_kit, f->>'name', f->>'type', decode(f->>'base64', 'base64'));
    stored := stored + 1;
  END LOOP;
  RETURN stored;
END $f$;

-- After-payment work (receipt email, webinar replay, CRM), leased so one worker does it at a time.
CREATE FUNCTION app_private.mhp_claim_kit_job(p_account text, p_live boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE o app_private.mhp_kit_orders%ROWTYPE; lease uuid := gen_random_uuid();
BEGIN
  SELECT * INTO o FROM app_private.mhp_kit_orders
  WHERE stripe_account = p_account AND live = p_live AND job_done_at IS NULL AND refunded_at IS NULL AND job_attempts < 8
    AND (job_lease_until IS NULL OR job_lease_until < clock_timestamp())
  ORDER BY paid_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE app_private.mhp_kit_orders SET job_lease = lease, job_lease_until = clock_timestamp() + interval '5 minutes',
    job_attempts = job_attempts + 1 WHERE id = o.id;
  RETURN jsonb_build_object('id', o.id, 'lease', lease, 'email', o.email::text, 'name', o.buyer_name, 'kind', o.kind, 'kits', to_jsonb(o.kits),
    'amountPence', o.amount_pence, 'paidAt', o.paid_at, 'receiptState', o.receipt_state, 'attempt', o.job_attempts + 1);
END $f$;

-- A receipt is attempted once: an unknown outcome is never sent again.
CREATE FUNCTION app_private.mhp_begin_kit_receipt(p_id uuid, p_lease uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $f$
  WITH changed AS (UPDATE app_private.mhp_kit_orders SET receipt_state = 'sending'
    WHERE id = p_id AND job_lease = p_lease AND receipt_state = 'pending' RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM changed)
$f$;
CREATE FUNCTION app_private.mhp_settle_kit_receipt(p_id uuid, p_lease uuid, p_result text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $f$
  UPDATE app_private.mhp_kit_orders SET receipt_state = p_result
  WHERE id = p_id AND job_lease = p_lease AND receipt_state = 'sending' AND p_result IN ('sent', 'rejected', 'unknown')
$f$;
CREATE FUNCTION app_private.mhp_finish_kit_job(p_id uuid, p_lease uuid, p_done boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $f$
  UPDATE app_private.mhp_kit_orders SET job_done_at = CASE WHEN p_done THEN clock_timestamp() END,
    job_lease = NULL, job_lease_until = CASE WHEN p_done THEN NULL ELSE clock_timestamp() + interval '2 minutes' * job_attempts END
  WHERE id = p_id AND job_lease = p_lease
$f$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;

REVOKE ALL ON FUNCTION
  app_private.mhp_kit_session_user(bytea),
  app_private.mhp_record_kit_order(text, boolean, text, text, text, text, text, text[], text[], integer, timestamptz),
  app_private.mhp_refund_kit_order(text, boolean, text),
  app_private.mhp_kit_email_known(text),
  app_private.mhp_kit_module_open(uuid, text),
  app_private.mhp_my_kits(bytea),
  app_private.mhp_kit_file(bytea, text, text),
  app_private.mhp_store_kit_files(bytea, text, jsonb),
  app_private.mhp_claim_kit_job(text, boolean),
  app_private.mhp_begin_kit_receipt(uuid, uuid),
  app_private.mhp_settle_kit_receipt(uuid, uuid, text),
  app_private.mhp_finish_kit_job(uuid, uuid, boolean)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app_private.mhp_record_kit_order(text, boolean, text, text, text, text, text, text[], text[], integer, timestamptz),
  app_private.mhp_refund_kit_order(text, boolean, text),
  app_private.mhp_claim_kit_job(text, boolean),
  app_private.mhp_begin_kit_receipt(uuid, uuid),
  app_private.mhp_settle_kit_receipt(uuid, uuid, text),
  app_private.mhp_finish_kit_job(uuid, uuid, boolean)
TO r72_webhook;
GRANT EXECUTE ON FUNCTION app_private.mhp_my_kits(bytea), app_private.mhp_kit_file(bytea, text, text) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.mhp_store_kit_files(bytea, text, jsonb) TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.mhp_kit_email_known(text) TO r72_mhp_commerce_definer;
GRANT EXECUTE ON FUNCTION app_private.mhp_kit_module_open(uuid, text) TO r72_mhp_prospect_definer;

-- Sign-in: a kit buyer is a buyer. One OR clause on the released predicate.
GRANT CREATE ON SCHEMA app_private TO r72_mhp_commerce_definer;
SET LOCAL ROLE r72_mhp_commerce_definer;
CREATE OR REPLACE FUNCTION app_private.mhp_has_purchase_email(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app.purchases WHERE buyer_email=lower(btrim(p_email)))
  OR app_private.mhp_kit_email_known(p_email);
$f$;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_commerce_definer;

-- Training centre: a held kit opens its own module. One OR clause in each released function.
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE OR REPLACE FUNCTION app_private.mhp_course_outline(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; tier text;
BEGIN
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL THEN RAISE EXCEPTION 'MHP session required' USING ERRCODE='42501'; END IF;
 tier:=app_private.mhp_learning_tier(actor);
 RETURN jsonb_build_object('tier',tier,'isAdmin',app_private.mhp_is_programme_admin(actor),
  'modules',COALESCE((SELECT jsonb_agg(jsonb_build_object('number',m.number,'slug',m.slug,'title',m.title,'promise',m.promise,'door',m.door,'level',m.level,
    'open',(tier='full' OR (tier='desk' AND m.number IN('00','01')) OR app_private.mhp_kit_module_open(actor,m.number)),
    'lessons',COALESCE((SELECT jsonb_agg(jsonb_build_object('key',l.lesson_key,'position',l.position,'slug',l.slug,'title',l.title,'minutes',l.minutes,'task',l.task) ORDER BY l.position)
      FROM app_private.mhp_course_lessons l WHERE l.module_number=m.number),'[]'::jsonb)) ORDER BY m.number) FROM app_private.mhp_course_modules m),'[]'::jsonb),
  'progress',COALESCE((SELECT jsonb_object_agg(lesson_key,jsonb_build_object('taskDone',task_done_at IS NOT NULL,'completed',completed_at IS NOT NULL,'notes',COALESCE(notes,'')))
   FROM app_private.mhp_lesson_progress WHERE user_id=actor),'{}'::jsonb));
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_course_content(p_session bytea,p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; tier text; result jsonb;
BEGIN
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL THEN RAISE EXCEPTION 'MHP session required' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_key!~'^[0-9]{2}(/[0-9]{2})?$' THEN RAISE EXCEPTION 'Invalid content key' USING ERRCODE='22023'; END IF;
 tier:=app_private.mhp_learning_tier(actor);
 IF NOT (tier='full' OR (tier='desk' AND left(p_key,2) IN('00','01')) OR app_private.mhp_kit_module_open(actor,left(p_key,2))) THEN
  RAISE EXCEPTION 'Course access required' USING ERRCODE='42501'; END IF;
 IF length(p_key)=2 THEN
  SELECT jsonb_build_object('overview',overview_md,'sources',sources_md) INTO result FROM app_private.mhp_course_modules WHERE number=p_key;
 ELSE
  SELECT jsonb_build_object('body',body_md) INTO result FROM app_private.mhp_course_lessons WHERE lesson_key=p_key;
 END IF;
 RETURN result;
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_save_lesson_progress(p_session bytea,p_lesson text,p_task_done boolean,p_complete boolean,p_notes text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; tier text; row_out app_private.mhp_lesson_progress%ROWTYPE;
BEGIN
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL THEN RAISE EXCEPTION 'MHP session required' USING ERRCODE='42501'; END IF;
 tier:=app_private.mhp_learning_tier(actor);
 IF tier='none' AND NOT app_private.mhp_kit_module_open(actor,left(p_lesson,2)) THEN RAISE EXCEPTION 'Course access required' USING ERRCODE='42501'; END IF;
 IF p_lesson IS NULL OR p_lesson!~'^[0-9]{2}/[0-9]{2}$' OR p_task_done IS NULL OR p_complete IS NULL
  OR (p_complete AND NOT p_task_done) OR (p_notes IS NOT NULL AND length(p_notes)>10000) THEN
  RAISE EXCEPTION 'Invalid progress' USING ERRCODE='22023'; END IF;
 -- 'desk' members may only progress Module 0 and Module 1, and any module whose kit they hold.
 IF tier IN('desk','none') AND left(p_lesson,2) NOT IN('00','01') AND NOT app_private.mhp_kit_module_open(actor,left(p_lesson,2)) THEN
  RAISE EXCEPTION 'Course access required' USING ERRCODE='42501'; END IF;
 IF tier='none' AND left(p_lesson,2) IN('00','01') AND NOT app_private.mhp_kit_module_open(actor,left(p_lesson,2)) THEN
  RAISE EXCEPTION 'Course access required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_course_lessons WHERE lesson_key=p_lesson) THEN RAISE EXCEPTION 'Unknown lesson' USING ERRCODE='22023'; END IF;
 INSERT INTO app_private.mhp_lesson_progress(user_id,lesson_key,task_done_at,completed_at,notes)
 VALUES(actor,p_lesson,CASE WHEN p_task_done THEN clock_timestamp() END,CASE WHEN p_complete THEN clock_timestamp() END,NULLIF(p_notes,''))
 ON CONFLICT(user_id,lesson_key) DO UPDATE SET
  task_done_at=CASE WHEN p_task_done THEN COALESCE(app_private.mhp_lesson_progress.task_done_at,clock_timestamp()) END,
  completed_at=CASE WHEN p_complete THEN COALESCE(app_private.mhp_lesson_progress.completed_at,clock_timestamp()) END,
  notes=NULLIF(p_notes,''),updated_at=clock_timestamp()
 RETURNING * INTO row_out;
 RETURN jsonb_build_object('taskDone',row_out.task_done_at IS NOT NULL,'completed',row_out.completed_at IS NOT NULL);
END $f$;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
RESET ROLE;
