-- Distributed, bounded admission state for targeted portal abuse controls.
--
-- This migration records only keyed 32-byte digests and fixed allowlisted
-- labels. It stores no address, email, token, user agent, request body, query,
-- object identifier, or provider fact. It performs no provider/live effect.

DO $portal_abuse_roles$
DECLARE
  role_name text;
  expected_login boolean;
  unexpected_member text;
  unexpected_parent text;
BEGIN
  FOR role_name, expected_login IN
    SELECT required.role_name, required.expected_login
    FROM (VALUES
      ('r72_abuse_command', true),
      ('r72_abuse_definer', false)
    ) AS required(role_name, expected_login)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name
    ) THEN
      EXECUTE format(
        'CREATE ROLE %I %s NOINHERIT',
        role_name,
        CASE WHEN expected_login THEN 'LOGIN' ELSE 'NOLOGIN' END
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles
      WHERE rolname = role_name
        AND rolcanlogin = expected_login
        AND NOT rolinherit
        AND NOT rolsuper
        AND NOT rolcreatedb
        AND NOT rolcreaterole
        AND NOT rolreplication
        AND NOT rolbypassrls
    ) THEN
      RAISE EXCEPTION 'Unsafe role attributes: % does not match the required capability shape',
        role_name;
    END IF;
  END LOOP;

  REVOKE r72_owner, r72_security_definer
    FROM r72_abuse_command, r72_abuse_definer;
  REVOKE r72_abuse_command, r72_abuse_definer FROM
    r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command, r72_import_command,
    r72_content_command, r72_content_adapter,
    r72_mailgun_webhook_command, r72_mailgun_worker_command;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname IN ('r72_abuse_command', 'r72_abuse_definer')
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe portal abuse role membership: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_abuse_command'
    AND member.rolname <> current_user
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe portal abuse command grant: % can SET ROLE r72_abuse_command',
      unexpected_member;
  END IF;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_abuse_definer'
    AND member.rolname NOT IN ('r72_owner', current_user)
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe portal abuse definer grant: % can SET ROLE r72_abuse_definer',
      unexpected_member;
  END IF;

  -- The migrator receives only the memberships needed for ownership transfer
  -- and isolated integration proofs. Neither runtime role receives a parent.
  EXECUTE format('GRANT r72_abuse_command TO %I', current_user);
  GRANT r72_abuse_definer TO r72_owner;
END
$portal_abuse_roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private FROM r72_abuse_command, r72_abuse_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_abuse_command, r72_abuse_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_abuse_command, r72_abuse_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_abuse_command, r72_abuse_definer;
REVOKE CREATE ON SCHEMA public FROM r72_abuse_command, r72_abuse_definer;
GRANT USAGE ON SCHEMA app_private TO r72_abuse_command, r72_abuse_definer;

-- A single state row makes the hard cardinality caps transactional. Admission
-- locks it for one short function call, so independent application instances
-- cannot oversubscribe storage or concurrency through a check/insert race.
CREATE TABLE app_private.portal_abuse_storage_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  bucket_count integer NOT NULL DEFAULT 0
    CHECK (bucket_count BETWEEN 0 AND 100000),
  lease_count integer NOT NULL DEFAULT 0
    CHECK (lease_count BETWEEN 0 AND 10000),
  denial_row_count integer NOT NULL DEFAULT 0
    CHECK (denial_row_count BETWEEN 0 AND 100000),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

INSERT INTO app_private.portal_abuse_storage_state (singleton)
VALUES (true);

CREATE TABLE app_private.portal_abuse_buckets (
  route_class text NOT NULL CHECK (route_class IN (
    'auth.login', 'auth.setup', 'auth.sso',
    'read.overview', 'read.page', 'command'
  )),
  dimension_kind text NOT NULL CHECK (dimension_kind IN (
    'source', 'source_daily', 'auth', 'account', 'account_daily',
    'workspace', 'workspace_daily', 'route_account', 'route_workspace'
  )),
  subject_hash bytea NOT NULL CHECK (octet_length(subject_hash) = 32),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 100000),
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 1 AND 86400),
  tokens numeric NOT NULL CHECK (tokens >= 0 AND tokens <= capacity),
  refilled_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  -- Route-specific subjects are derived in the application. Global account,
  -- workspace and daily dimensions therefore remain global across every route.
  PRIMARY KEY (dimension_kind, subject_hash),
  CHECK (last_seen_at >= refilled_at)
);

CREATE INDEX portal_abuse_buckets_expiry_idx
  ON app_private.portal_abuse_buckets (last_seen_at);

-- One row represents one dimension held by one admitted request. A fixed
-- 30-second lease prevents a crashed process from retaining concurrency.
CREATE TABLE app_private.portal_abuse_leases (
  lease_hash bytea NOT NULL CHECK (octet_length(lease_hash) = 32),
  route_class text NOT NULL CHECK (route_class IN (
    'auth.login', 'auth.setup', 'auth.sso',
    'read.overview', 'read.page', 'command'
  )),
  dimension_kind text NOT NULL CHECK (dimension_kind IN (
    'source', 'source_daily', 'auth', 'account', 'account_daily',
    'workspace', 'workspace_daily', 'route_account', 'route_workspace'
  )),
  subject_hash bytea NOT NULL CHECK (octet_length(subject_hash) = 32),
  evidence_hash bytea NOT NULL CHECK (octet_length(evidence_hash) = 32),
  reserved_cost integer NOT NULL CHECK (reserved_cost BETWEEN 1 AND 100000),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (lease_hash, dimension_kind, subject_hash),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '30 seconds')
);

CREATE INDEX portal_abuse_leases_admission_idx
  ON app_private.portal_abuse_leases
    (dimension_kind, subject_hash, expires_at);
CREATE INDEX portal_abuse_leases_expiry_idx
  ON app_private.portal_abuse_leases (expires_at);

-- Denials are minute aggregates rather than per-request events. The only
-- changing evidence value is the most recent keyed request/trace digest.
CREATE TABLE app_private.portal_abuse_denial_aggregates (
  denied_minute timestamptz NOT NULL,
  route_class text NOT NULL CHECK (route_class IN (
    'auth.login', 'auth.setup', 'auth.sso',
    'read.overview', 'read.page', 'command'
  )),
  dimension_kind text NOT NULL CHECK (dimension_kind IN (
    'source', 'source_daily', 'auth', 'account', 'account_daily',
    'workspace', 'workspace_daily', 'route_account', 'route_workspace'
  )),
  subject_hash bytea NOT NULL CHECK (octet_length(subject_hash) = 32),
  denial_reason text NOT NULL CHECK (denial_reason IN (
    'rate', 'concurrency', 'storage'
  )),
  denial_count bigint NOT NULL DEFAULT 1 CHECK (denial_count > 0),
  retry_after_seconds integer NOT NULL
    CHECK (retry_after_seconds BETWEEN 1 AND 86400),
  last_evidence_hash bytea NOT NULL CHECK (octet_length(last_evidence_hash) = 32),
  first_denied_at timestamptz NOT NULL,
  last_denied_at timestamptz NOT NULL,
  PRIMARY KEY (
    denied_minute, route_class, dimension_kind, subject_hash, denial_reason
  ),
  CHECK (last_denied_at >= first_denied_at)
);

CREATE INDEX portal_abuse_denials_retention_idx
  ON app_private.portal_abuse_denial_aggregates
    (last_denied_at, denied_minute);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON app_private.portal_abuse_storage_state,
     app_private.portal_abuse_buckets,
     app_private.portal_abuse_leases,
     app_private.portal_abuse_denial_aggregates
  TO r72_abuse_definer;
GRANT SELECT ON app_private.schema_migrations TO r72_abuse_definer;

GRANT CREATE ON SCHEMA app_private TO r72_abuse_definer;
SET LOCAL ROLE r72_abuse_definer;

CREATE FUNCTION app_private.admit_portal_abuse(
  p_route_class text,
  p_dimension_kinds text[],
  p_subject_hashes bytea[],
  p_capacities integer[],
  p_window_seconds integer[],
  p_costs integer[],
  p_concurrency_limits integer[],
  p_lease_hash bytea,
  p_evidence_hash bytea
)
RETURNS TABLE (
  allowed boolean,
  retry_after_seconds integer,
  lease_hash bytea
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_length integer;
  v_i integer;
  v_j integer;
  v_deleted integer;
  v_changed integer;
  v_reclaimable_buckets integer := 0;
  v_reclaimable_leases integer := 0;
  v_missing_buckets integer := 0;
  v_lease_rows integer := 0;
  v_active_leases integer;
  v_retry integer;
  v_retry_max integer := 0;
  v_denied_index integer := 1;
  v_denial_reason text := 'rate';
  v_denied_minute timestamptz;
  v_next_expiry timestamptz;
  v_elapsed_seconds numeric;
  v_available numeric[];
  v_bucket_present boolean[];
  v_all_allowed boolean := true;
  v_state app_private.portal_abuse_storage_state%ROWTYPE;
  v_bucket app_private.portal_abuse_buckets%ROWTYPE;
BEGIN
  allowed := false;
  retry_after_seconds := 60;
  lease_hash := NULL;

  IF p_route_class IS NULL OR p_route_class NOT IN (
      'auth.login', 'auth.setup', 'auth.sso',
      'read.overview', 'read.page', 'command'
    )
    OR p_dimension_kinds IS NULL
    OR p_subject_hashes IS NULL
    OR p_capacities IS NULL
    OR p_window_seconds IS NULL
    OR p_costs IS NULL
    OR p_concurrency_limits IS NULL
    OR array_ndims(p_dimension_kinds) <> 1
    OR array_ndims(p_subject_hashes) <> 1
    OR array_ndims(p_capacities) <> 1
    OR array_ndims(p_window_seconds) <> 1
    OR array_ndims(p_costs) <> 1
    OR array_ndims(p_concurrency_limits) <> 1
    OR array_lower(p_dimension_kinds, 1) <> 1
    OR array_lower(p_subject_hashes, 1) <> 1
    OR array_lower(p_capacities, 1) <> 1
    OR array_lower(p_window_seconds, 1) <> 1
    OR array_lower(p_costs, 1) <> 1
    OR array_lower(p_concurrency_limits, 1) <> 1
    OR p_lease_hash IS NULL
    OR octet_length(p_lease_hash) <> 32
    OR p_evidence_hash IS NULL
    OR octet_length(p_evidence_hash) <> 32 THEN
    RAISE EXCEPTION 'Portal abuse admission input denied' USING ERRCODE = '22023';
  END IF;

  v_length := array_length(p_dimension_kinds, 1);
  IF v_length IS NULL OR v_length NOT BETWEEN 1 AND 9
    OR array_length(p_subject_hashes, 1) IS DISTINCT FROM v_length
    OR array_length(p_capacities, 1) IS DISTINCT FROM v_length
    OR array_length(p_window_seconds, 1) IS DISTINCT FROM v_length
    OR array_length(p_costs, 1) IS DISTINCT FROM v_length
    OR array_length(p_concurrency_limits, 1) IS DISTINCT FROM v_length THEN
    RAISE EXCEPTION 'Portal abuse admission arrays must have equal bounded lengths'
      USING ERRCODE = '22023';
  END IF;

  FOR v_i IN 1..v_length LOOP
    IF p_dimension_kinds[v_i] IS NULL
      OR p_dimension_kinds[v_i] NOT IN (
        'source', 'source_daily', 'auth', 'account', 'account_daily',
        'workspace', 'workspace_daily', 'route_account', 'route_workspace'
      )
      OR p_subject_hashes[v_i] IS NULL
      OR octet_length(p_subject_hashes[v_i]) <> 32
      OR p_capacities[v_i] IS NULL
      OR p_capacities[v_i] NOT BETWEEN 1 AND 100000
      OR p_window_seconds[v_i] IS NULL
      OR p_window_seconds[v_i] NOT BETWEEN 1 AND 86400
      OR p_costs[v_i] IS NULL
      OR p_costs[v_i] NOT BETWEEN 1 AND p_capacities[v_i]
      OR p_concurrency_limits[v_i] IS NULL
      OR p_concurrency_limits[v_i] NOT BETWEEN 0 AND 1000 THEN
      RAISE EXCEPTION 'Portal abuse admission dimension denied' USING ERRCODE = '22023';
    END IF;
    IF v_i < v_length THEN
      FOR v_j IN (v_i + 1)..v_length LOOP
        IF p_dimension_kinds[v_i] = p_dimension_kinds[v_j]
          AND p_subject_hashes[v_i] = p_subject_hashes[v_j] THEN
          RAISE EXCEPTION 'Portal abuse admission contains a duplicate dimension'
            USING ERRCODE = '22023';
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  SELECT state.* INTO STRICT v_state
  FROM app_private.portal_abuse_storage_state AS state
  WHERE state.singleton = true
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM app_private.portal_abuse_leases AS lease
    WHERE lease.lease_hash = p_lease_hash
  ) THEN
    RAISE EXCEPTION 'Portal abuse lease hash is already present' USING ERRCODE = '22023';
  END IF;

  v_available := array_fill(0::numeric, ARRAY[v_length]);
  v_bucket_present := array_fill(false, ARRAY[v_length]);

  -- Lock and evaluate every requested dimension before changing a live bucket
  -- or inserting a lease. The state-row lock provides a stable all-dimension
  -- view across every application instance.
  FOR v_i IN 1..v_length LOOP
    SELECT bucket.* INTO v_bucket
    FROM app_private.portal_abuse_buckets AS bucket
    WHERE bucket.dimension_kind = p_dimension_kinds[v_i]
      AND bucket.subject_hash = p_subject_hashes[v_i]
    FOR UPDATE;

    v_bucket_present[v_i] := FOUND;
    IF FOUND THEN
      v_elapsed_seconds := greatest(
        0::numeric,
        extract(epoch FROM (v_now - v_bucket.refilled_at))
      );
      v_available[v_i] := least(
        p_capacities[v_i]::numeric,
        v_bucket.tokens
          + (v_elapsed_seconds * p_capacities[v_i]::numeric
             / p_window_seconds[v_i]::numeric)
      );
    ELSE
      v_available[v_i] := p_capacities[v_i]::numeric;
      v_missing_buckets := v_missing_buckets + 1;
    END IF;

    IF v_available[v_i] < p_costs[v_i] THEN
      v_retry := greatest(
        1,
        least(
          86400,
          ceil(
            (p_costs[v_i]::numeric - v_available[v_i])
              * p_window_seconds[v_i]::numeric
              / p_capacities[v_i]::numeric
          )::integer
        )
      );
      v_all_allowed := false;
      IF v_retry > v_retry_max THEN
        v_retry_max := v_retry;
        v_denied_index := v_i;
        v_denial_reason := 'rate';
      END IF;
    END IF;

    IF p_concurrency_limits[v_i] > 0 THEN
      v_lease_rows := v_lease_rows + 1;
      SELECT count(*)::integer, min(lease.expires_at)
        INTO v_active_leases, v_next_expiry
      FROM app_private.portal_abuse_leases AS lease
      WHERE lease.dimension_kind = p_dimension_kinds[v_i]
        AND lease.subject_hash = p_subject_hashes[v_i]
        AND lease.expires_at > v_now;

      IF v_active_leases >= p_concurrency_limits[v_i] THEN
        v_retry := greatest(
          1,
          least(30, ceil(extract(epoch FROM (v_next_expiry - v_now)))::integer)
        );
        v_all_allowed := false;
        IF v_retry >= v_retry_max THEN
          v_retry_max := v_retry;
          v_denied_index := v_i;
          v_denial_reason := 'concurrency';
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Determine a bounded reclaim batch without mutating admission state. This
  -- lets a denied request leave every bucket and lease byte-for-byte intact.
  SELECT count(*)::integer INTO v_reclaimable_buckets
  FROM (
    SELECT bucket.ctid
    FROM app_private.portal_abuse_buckets AS bucket
    WHERE bucket.last_seen_at <= v_now - interval '1 day'
      AND NOT EXISTS (
        SELECT 1
        FROM generate_subscripts(p_dimension_kinds, 1) AS requested(position)
        WHERE bucket.dimension_kind = p_dimension_kinds[requested.position]
          AND bucket.subject_hash = p_subject_hashes[requested.position]
      )
    ORDER BY bucket.last_seen_at
    LIMIT 64
  ) AS reclaimable;

  SELECT count(*)::integer INTO v_reclaimable_leases
  FROM (
    SELECT lease.ctid
    FROM app_private.portal_abuse_leases AS lease
    WHERE lease.expires_at <= v_now
    ORDER BY lease.expires_at
    LIMIT 64
  ) AS reclaimable;

  IF v_state.bucket_count - v_reclaimable_buckets + v_missing_buckets > 100000
    OR v_state.lease_count - v_reclaimable_leases + v_lease_rows > 10000 THEN
    v_all_allowed := false;
    v_retry_max := greatest(v_retry_max, 60);
    v_denied_index := 1;
    v_denial_reason := 'storage';
  END IF;

  IF NOT v_all_allowed THEN
    v_retry_max := greatest(1, v_retry_max);
    v_denied_minute := date_trunc('minute', v_now);

    UPDATE app_private.portal_abuse_denial_aggregates AS denial
    SET denial_count = denial.denial_count + 1,
        retry_after_seconds = greatest(denial.retry_after_seconds, v_retry_max),
        last_evidence_hash = p_evidence_hash,
        last_denied_at = v_now
    WHERE denial.denied_minute = v_denied_minute
      AND denial.route_class = p_route_class
      AND denial.dimension_kind = p_dimension_kinds[v_denied_index]
      AND denial.subject_hash = p_subject_hashes[v_denied_index]
      AND denial.denial_reason = v_denial_reason;
    GET DIAGNOSTICS v_changed = ROW_COUNT;

    IF v_changed = 0 THEN
      IF v_state.denial_row_count >= 100000 THEN
        WITH doomed AS (
          SELECT denial.ctid
          FROM app_private.portal_abuse_denial_aggregates AS denial
          ORDER BY denial.last_denied_at, denial.denied_minute
          LIMIT 1
          FOR UPDATE
        ), deleted AS (
          DELETE FROM app_private.portal_abuse_denial_aggregates AS denial
          USING doomed
          WHERE denial.ctid = doomed.ctid
          RETURNING 1
        )
        SELECT count(*)::integer INTO v_deleted FROM deleted;
        v_state.denial_row_count := greatest(
          0, v_state.denial_row_count - v_deleted
        );
      END IF;

      INSERT INTO app_private.portal_abuse_denial_aggregates (
        denied_minute, route_class, dimension_kind, subject_hash,
        denial_reason, denial_count, retry_after_seconds,
        last_evidence_hash, first_denied_at, last_denied_at
      ) VALUES (
        v_denied_minute, p_route_class, p_dimension_kinds[v_denied_index],
        p_subject_hashes[v_denied_index], v_denial_reason, 1, v_retry_max,
        p_evidence_hash, v_now, v_now
      );
      v_state.denial_row_count := v_state.denial_row_count + 1;
    END IF;

    UPDATE app_private.portal_abuse_storage_state AS state
    SET bucket_count = v_state.bucket_count,
        lease_count = v_state.lease_count,
        denial_row_count = v_state.denial_row_count,
        updated_at = v_now
    WHERE state.singleton = true;

    allowed := false;
    retry_after_seconds := v_retry_max;
    lease_hash := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Housekeeping starts only after the all-dimension decision is allowed.
  -- Stale rows beyond this 64-row batch continue to consume the hard cap.
  WITH doomed AS (
    SELECT bucket.ctid
    FROM app_private.portal_abuse_buckets AS bucket
    WHERE bucket.last_seen_at <= v_now - interval '1 day'
      AND NOT EXISTS (
        SELECT 1
        FROM generate_subscripts(p_dimension_kinds, 1) AS requested(position)
        WHERE bucket.dimension_kind = p_dimension_kinds[requested.position]
          AND bucket.subject_hash = p_subject_hashes[requested.position]
      )
    ORDER BY bucket.last_seen_at
    LIMIT 64
    FOR UPDATE
  ), deleted AS (
    DELETE FROM app_private.portal_abuse_buckets AS bucket
    USING doomed
    WHERE bucket.ctid = doomed.ctid
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted FROM deleted;
  v_state.bucket_count := greatest(0, v_state.bucket_count - v_deleted);

  WITH doomed AS (
    SELECT lease.ctid
    FROM app_private.portal_abuse_leases AS lease
    WHERE lease.expires_at <= v_now
    ORDER BY lease.expires_at
    LIMIT 64
    FOR UPDATE
  ), deleted AS (
    DELETE FROM app_private.portal_abuse_leases AS lease
    USING doomed
    WHERE lease.ctid = doomed.ctid
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted FROM deleted;
  v_state.lease_count := greatest(0, v_state.lease_count - v_deleted);

  WITH doomed AS (
    SELECT denial.ctid
    FROM app_private.portal_abuse_denial_aggregates AS denial
    WHERE denial.last_denied_at <= v_now - interval '7 days'
    ORDER BY denial.last_denied_at
    LIMIT 64
    FOR UPDATE
  ), deleted AS (
    DELETE FROM app_private.portal_abuse_denial_aggregates AS denial
    USING doomed
    WHERE denial.ctid = doomed.ctid
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted FROM deleted;
  v_state.denial_row_count := greatest(0, v_state.denial_row_count - v_deleted);

  -- Only a wholly admitted request reaches these writes. Authentication
  -- subjects are refunded on success/service failure by the completion path;
  -- every other dimension counts every admitted request.
  FOR v_i IN 1..v_length LOOP
    IF v_bucket_present[v_i] THEN
      UPDATE app_private.portal_abuse_buckets AS bucket
      SET route_class = p_route_class,
          capacity = p_capacities[v_i],
          window_seconds = p_window_seconds[v_i],
          tokens = v_available[v_i] - p_costs[v_i],
          refilled_at = v_now,
          last_seen_at = v_now
      WHERE bucket.dimension_kind = p_dimension_kinds[v_i]
        AND bucket.subject_hash = p_subject_hashes[v_i];
    ELSE
      INSERT INTO app_private.portal_abuse_buckets (
        route_class, dimension_kind, subject_hash, capacity, window_seconds,
        tokens, refilled_at, last_seen_at
      ) VALUES (
        p_route_class, p_dimension_kinds[v_i], p_subject_hashes[v_i],
        p_capacities[v_i], p_window_seconds[v_i],
        p_capacities[v_i]::numeric - p_costs[v_i], v_now, v_now
      );
    END IF;

    IF p_concurrency_limits[v_i] > 0 THEN
      INSERT INTO app_private.portal_abuse_leases (
        lease_hash, route_class, dimension_kind, subject_hash,
        evidence_hash, reserved_cost, created_at, expires_at
      ) VALUES (
        p_lease_hash, p_route_class, p_dimension_kinds[v_i],
        p_subject_hashes[v_i], p_evidence_hash, p_costs[v_i],
        v_now, v_now + interval '30 seconds'
      );
    END IF;
  END LOOP;

  v_state.bucket_count := v_state.bucket_count + v_missing_buckets;
  v_state.lease_count := v_state.lease_count + v_lease_rows;
  UPDATE app_private.portal_abuse_storage_state AS state
  SET bucket_count = v_state.bucket_count,
      lease_count = v_state.lease_count,
      denial_row_count = v_state.denial_row_count,
      updated_at = v_now
  WHERE state.singleton = true;

  allowed := true;
  retry_after_seconds := 0;
  lease_hash := p_lease_hash;
  RETURN NEXT;
END
$function$;

CREATE FUNCTION app_private.complete_portal_abuse_lease(
  p_lease_hash bytea,
  p_outcome text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_deleted integer;
  v_state app_private.portal_abuse_storage_state%ROWTYPE;
BEGIN
  IF p_lease_hash IS NULL OR octet_length(p_lease_hash) <> 32
    OR p_outcome IS NULL
    OR p_outcome NOT IN ('success', 'auth_failure', 'service_error') THEN
    RAISE EXCEPTION 'Portal abuse lease completion input denied'
      USING ERRCODE = '22023';
  END IF;

  SELECT state.* INTO STRICT v_state
  FROM app_private.portal_abuse_storage_state AS state
  WHERE state.singleton = true
  FOR UPDATE;

  -- Authentication capacity represents failures, not successful sign-ins or
  -- dependency errors. The state-row lock serialises this refund with every
  -- admission; a repeated completion finds no lease and refunds nothing.
  IF p_outcome IN ('success', 'service_error') THEN
    UPDATE app_private.portal_abuse_buckets AS bucket
    SET tokens = least(
          bucket.capacity::numeric,
          bucket.tokens + lease.reserved_cost::numeric
        )
    FROM app_private.portal_abuse_leases AS lease
    WHERE lease.lease_hash = p_lease_hash
      AND lease.dimension_kind = 'auth'
      AND bucket.dimension_kind = lease.dimension_kind
      AND bucket.subject_hash = lease.subject_hash;
  END IF;

  DELETE FROM app_private.portal_abuse_leases AS lease
  WHERE lease.lease_hash = p_lease_hash;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  v_state.lease_count := greatest(0, v_state.lease_count - v_deleted);
  UPDATE app_private.portal_abuse_storage_state AS state
  SET lease_count = v_state.lease_count,
      updated_at = v_now
  WHERE state.singleton = true;

  -- A missing row means a prior completion or the fixed expiry already won.
  -- Both are successful idempotent release outcomes.
  RETURN true;
END
$function$;

CREATE FUNCTION app_private.portal_abuse_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT session_user = 'r72_abuse_command'
    AND current_user = 'r72_abuse_definer'
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = 'r72_abuse_command'
        AND role.rolcanlogin
        AND NOT role.rolinherit
        AND NOT role.rolsuper
        AND NOT role.rolcreatedb
        AND NOT role.rolcreaterole
        AND NOT role.rolreplication
        AND NOT role.rolbypassrls
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
      WHERE member.rolname = 'r72_abuse_command'
    )
    AND EXISTS (
      SELECT 1
      FROM app_private.schema_migrations AS migration
      WHERE migration.filename = '0036_portal_abuse_limits.sql'
    )
    AND has_schema_privilege('r72_abuse_command', 'app_private', 'USAGE')
    AND has_function_privilege(
      'r72_abuse_command',
      'app_private.admit_portal_abuse(text,text[],bytea[],integer[],integer[],integer[],integer[],bytea,bytea)',
      'EXECUTE'
    )
    AND has_function_privilege(
      'r72_abuse_command',
      'app_private.complete_portal_abuse_lease(bytea,text)',
      'EXECUTE'
    )
    AND has_function_privilege(
      'r72_abuse_command',
      'app_private.portal_abuse_ready()',
      'EXECUTE'
    )
    AND pg_catalog.to_regprocedure(
      'app_private.runtime_database_installation_id()'
    ) IS NOT NULL
    AND has_function_privilege(
      'r72_abuse_command',
      'app_private.runtime_database_installation_id()',
      'EXECUTE'
    )
    AND NOT has_schema_privilege('r72_abuse_command', 'app_private', 'CREATE')
    AND NOT has_schema_privilege('r72_abuse_command', 'app', 'USAGE')
    AND NOT has_schema_privilege('r72_abuse_command', 'public', 'CREATE')
    AND NOT (
      has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_storage_state', 'SELECT')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_storage_state', 'INSERT')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_storage_state', 'UPDATE')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_storage_state', 'DELETE')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_storage_state', 'TRUNCATE')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_storage_state', 'REFERENCES')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_storage_state', 'TRIGGER')
    )
    AND NOT (
      has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_buckets', 'SELECT')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_buckets', 'INSERT')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_buckets', 'UPDATE')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_buckets', 'DELETE')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_buckets', 'TRUNCATE')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_buckets', 'REFERENCES')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_buckets', 'TRIGGER')
    )
    AND NOT (
      has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_leases', 'SELECT')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_leases', 'INSERT')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_leases', 'UPDATE')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_leases', 'DELETE')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_leases', 'TRUNCATE')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_leases', 'REFERENCES')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_leases', 'TRIGGER')
    )
    AND NOT (
      has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_denial_aggregates', 'SELECT')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_denial_aggregates', 'INSERT')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_denial_aggregates', 'UPDATE')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_denial_aggregates', 'DELETE')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_denial_aggregates', 'TRUNCATE')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_denial_aggregates', 'REFERENCES')
      OR has_table_privilege('r72_abuse_command', 'app_private.portal_abuse_denial_aggregates', 'TRIGGER')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('app', 'app_private')
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (
          has_table_privilege('r72_abuse_command', relation.oid, 'SELECT')
          OR has_table_privilege('r72_abuse_command', relation.oid, 'INSERT')
          OR has_table_privilege('r72_abuse_command', relation.oid, 'UPDATE')
          OR has_table_privilege('r72_abuse_command', relation.oid, 'DELETE')
          OR has_table_privilege('r72_abuse_command', relation.oid, 'TRUNCATE')
          OR has_table_privilege('r72_abuse_command', relation.oid, 'REFERENCES')
          OR has_table_privilege('r72_abuse_command', relation.oid, 'TRIGGER')
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname IN ('app', 'app_private')
        AND procedure.oid NOT IN (
          pg_catalog.to_regprocedure(
            'app_private.admit_portal_abuse(text,text[],bytea[],integer[],integer[],integer[],integer[],bytea,bytea)'
          ),
          pg_catalog.to_regprocedure(
            'app_private.complete_portal_abuse_lease(bytea,text)'
          ),
          pg_catalog.to_regprocedure('app_private.portal_abuse_ready()'),
          pg_catalog.to_regprocedure(
            'app_private.runtime_database_installation_id()'
          )
        )
        AND has_function_privilege(
          'r72_abuse_command', procedure.oid, 'EXECUTE'
        )
    )
    AND EXISTS (
      SELECT 1
      FROM app_private.portal_abuse_storage_state AS state
      WHERE state.singleton = true
        AND state.bucket_count = (
          SELECT count(*)::integer FROM app_private.portal_abuse_buckets
        )
        AND state.lease_count = (
          SELECT count(*)::integer FROM app_private.portal_abuse_leases
        )
        AND state.denial_row_count = (
          SELECT count(*)::integer
          FROM app_private.portal_abuse_denial_aggregates
        )
        AND state.bucket_count BETWEEN 0 AND 100000
        AND state.lease_count BETWEEN 0 AND 10000
        AND state.denial_row_count BETWEEN 0 AND 100000
    )
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_abuse_definer;

REVOKE ALL ON FUNCTION app_private.admit_portal_abuse(
  text, text[], bytea[], integer[], integer[], integer[], integer[], bytea, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.complete_portal_abuse_lease(bytea, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.portal_abuse_ready() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.admit_portal_abuse(
  text, text[], bytea[], integer[], integer[], integer[], integer[], bytea, bytea
) TO r72_abuse_command;
GRANT EXECUTE ON FUNCTION app_private.complete_portal_abuse_lease(bytea, text)
  TO r72_abuse_command;
GRANT EXECUTE ON FUNCTION app_private.portal_abuse_ready()
  TO r72_abuse_command;
GRANT EXECUTE ON FUNCTION app_private.runtime_database_installation_id()
  TO r72_abuse_command;

-- Reassert the table-blind runtime boundary after every object and grant exists.
DO $portal_abuse_privilege_audit$
DECLARE
  admit_oid oid := pg_catalog.to_regprocedure(
    'app_private.admit_portal_abuse(text,text[],bytea[],integer[],integer[],integer[],integer[],bytea,bytea)'
  );
  complete_oid oid := pg_catalog.to_regprocedure(
    'app_private.complete_portal_abuse_lease(bytea,text)'
  );
  ready_oid oid := pg_catalog.to_regprocedure(
    'app_private.portal_abuse_ready()'
  );
  installation_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_database_installation_id()'
  );
  unexpected_capability text;
BEGIN
  IF admit_oid IS NULL OR complete_oid IS NULL OR ready_oid IS NULL
    OR installation_oid IS NULL THEN
    RAISE EXCEPTION 'Portal abuse function boundary is incomplete';
  END IF;

  IF NOT has_schema_privilege('r72_abuse_command', 'app_private', 'USAGE')
    OR has_schema_privilege('r72_abuse_command', 'app_private', 'CREATE')
    OR has_schema_privilege('r72_abuse_command', 'app', 'USAGE')
    OR has_schema_privilege('r72_abuse_command', 'public', 'CREATE')
    OR NOT has_function_privilege('r72_abuse_command', admit_oid, 'EXECUTE')
    OR NOT has_function_privilege('r72_abuse_command', complete_oid, 'EXECUTE')
    OR NOT has_function_privilege('r72_abuse_command', ready_oid, 'EXECUTE')
    OR NOT has_function_privilege(
      'r72_abuse_command', installation_oid, 'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Portal abuse exact function boundary is unavailable';
  END IF;

  SELECT namespace.nspname || '.' || relation.relname
    INTO unexpected_capability
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      has_table_privilege('r72_abuse_command', relation.oid, 'SELECT')
      OR has_table_privilege('r72_abuse_command', relation.oid, 'INSERT')
      OR has_table_privilege('r72_abuse_command', relation.oid, 'UPDATE')
      OR has_table_privilege('r72_abuse_command', relation.oid, 'DELETE')
      OR has_table_privilege('r72_abuse_command', relation.oid, 'TRUNCATE')
      OR has_table_privilege('r72_abuse_command', relation.oid, 'REFERENCES')
      OR has_table_privilege('r72_abuse_command', relation.oid, 'TRIGGER')
    )
  LIMIT 1;

  IF unexpected_capability IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe portal abuse capability: r72_abuse_command can access %',
      unexpected_capability;
  END IF;

  unexpected_capability := NULL;
  SELECT namespace.nspname || '.' || procedure.proname
    INTO unexpected_capability
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND procedure.oid <> ALL (ARRAY[
      admit_oid, complete_oid, ready_oid, installation_oid
    ])
    AND has_function_privilege(
      'r72_abuse_command', procedure.oid, 'EXECUTE'
    )
  LIMIT 1;

  IF unexpected_capability IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe portal abuse capability: r72_abuse_command can execute %',
      unexpected_capability;
  END IF;
END
$portal_abuse_privilege_audit$;
