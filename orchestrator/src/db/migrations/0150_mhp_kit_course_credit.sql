-- MHP-KITS-002: what a buyer paid for kits in the 90 days before buying Property Done Properly counts in full
-- towards it. Additive: two columns on the kit orders and two definer functions. The course is bought at its
-- normal price; the webhook then claims the buyer's eligible kit orders once, by email, and refunds that amount
-- against the course payment (src/mhp/kit-service.ts). A kit order is credited at most once.

SET LOCAL ROLE r72_owner;
ALTER TABLE app_private.mhp_kit_orders
  ADD COLUMN credited_session text CHECK (credited_session IS NULL OR credited_session ~ '^cs_(test|live)_[A-Za-z0-9]{1,200}$'),
  ADD COLUMN credited_at timestamptz,
  ADD CONSTRAINT mhp_kit_orders_credit_pair CHECK ((credited_session IS NULL) = (credited_at IS NULL));
CREATE INDEX mhp_kit_orders_credited_idx ON app_private.mhp_kit_orders (credited_session) WHERE credited_session IS NOT NULL;

GRANT CREATE ON SCHEMA app_private TO r72_security_definer;
SET LOCAL ROLE r72_security_definer;

-- Once per course checkout: the buyer's kit orders paid in the 90 days before it, not refunded and not already
-- credited, are marked as credited to that checkout. A replay returns the same orders and amount.
CREATE FUNCTION app_private.mhp_claim_kit_credit(p_account text, p_live boolean, p_email text, p_course_session text, p_paid_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE claimed integer; n integer;
BEGIN
  IF p_course_session IS NULL OR p_course_session !~ '^cs_(test|live)_[A-Za-z0-9]{1,200}$' OR p_paid_at IS NULL THEN
    RAISE EXCEPTION 'Invalid course credit claim' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(lower(btrim(p_email)), 150));
  IF NOT EXISTS (SELECT 1 FROM app_private.mhp_kit_orders WHERE credited_session = p_course_session) THEN
    UPDATE app_private.mhp_kit_orders SET credited_session = p_course_session, credited_at = clock_timestamp()
    WHERE stripe_account = p_account AND live = p_live AND email::text = lower(btrim(p_email)) AND refunded_at IS NULL
      AND credited_session IS NULL AND paid_at > p_paid_at - interval '90 days' AND paid_at <= p_paid_at + interval '5 minutes';
  END IF;
  SELECT COALESCE(sum(amount_pence), 0), count(*) INTO claimed, n FROM app_private.mhp_kit_orders WHERE credited_session = p_course_session;
  RETURN jsonb_build_object('amountPence', claimed, 'orders', n);
END $f$;

-- The signed-in member's kits, files and the course credit their kits currently count for.
CREATE OR REPLACE FUNCTION app_private.mhp_my_kits(p_session bytea) RETURNS jsonb
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
      WHERE me.is_admin OR EXISTS (SELECT 1 FROM app_private.mhp_kit_orders o WHERE o.email::text = me.email AND o.refunded_at IS NULL AND f.kit = ANY (o.kits))), '[]'::jsonb),
    'credit', (SELECT jsonb_build_object('amountPence', COALESCE(sum(o.amount_pence), 0), 'nextExpiresAt', min(o.paid_at) + interval '90 days')
      FROM app_private.mhp_kit_orders o
      WHERE o.email::text = me.email AND o.refunded_at IS NULL AND o.credited_session IS NULL AND o.paid_at > clock_timestamp() - interval '90 days'));
END $f$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;
REVOKE ALL ON FUNCTION app_private.mhp_claim_kit_credit(text, boolean, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_claim_kit_credit(text, boolean, text, text, timestamptz) TO r72_webhook;
RESET ROLE;
