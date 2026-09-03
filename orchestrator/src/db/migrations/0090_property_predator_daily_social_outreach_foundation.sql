-- Property Predator Daily Social Outreach: a bounded, evidence-only first
-- database slice. This migration creates no provider operation, provider-call
-- capability, raw profile store, message body, address, legal text or secret.
-- All prospect provenance is hash-only and every durable outreach row is
-- append-only. Cold/manual attempts remain activities rather than LAPS proof.

DO $roles$
DECLARE
  role_name text;
  expected_login boolean;
  unsafe_membership text;
  inbound_member text;
BEGIN
  FOR role_name, expected_login IN
    SELECT required.role_name, required.expected_login
    FROM (VALUES
      ('r72_daily_outreach_definer', false),
      ('r72_daily_outreach_command', true),
      ('r72_daily_outreach_read', true)
    ) AS required(role_name, expected_login)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name
    ) THEN
      EXECUTE pg_catalog.format(
        'CREATE ROLE %I %s NOINHERIT', role_name,
        CASE WHEN expected_login THEN 'LOGIN' ELSE 'NOLOGIN' END
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles
      WHERE rolname = role_name
        AND rolcanlogin = expected_login
        AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
    ) THEN
      RAISE EXCEPTION 'Unsafe Daily Outreach role attributes: %', role_name
        USING ERRCODE = '42501';
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE r72_owner, r72_security_definer, r72_worker,
         r72_provider_operation_definer, r72_operational_inbox_definer,
         r72_zernio_social_definer FROM %I', role_name
    );
    SELECT parent.rolname INTO unsafe_membership
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
    JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
    WHERE member.rolname = role_name
    LIMIT 1;
    IF unsafe_membership IS NOT NULL THEN
      RAISE EXCEPTION 'Unsafe Daily Outreach role membership: % -> %',
        role_name, unsafe_membership USING ERRCODE = '42501';
    END IF;
  END LOOP;

  REVOKE r72_daily_outreach_definer
    FROM r72_daily_outreach_command, r72_daily_outreach_read;
  GRANT r72_daily_outreach_definer TO r72_owner;

  -- Login roles are used directly by the application. Do not let an old role
  -- membership silently retain SET ROLE access to either boundary. The owner
  -- is the sole intentional member of the NOLOGIN function-owner role.
  FOR role_name, inbound_member IN
    SELECT granted.rolname, member.rolname
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
    WHERE granted.rolname IN (
      'r72_daily_outreach_definer',
      'r72_daily_outreach_command',
      'r72_daily_outreach_read'
    )
      AND NOT (
        granted.rolname = 'r72_daily_outreach_definer'
        AND member.rolname = 'r72_owner'
      )
  LOOP
    EXECUTE pg_catalog.format('REVOKE %I FROM %I', role_name, inbound_member);
  END LOOP;
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_daily_outreach_definer, r72_daily_outreach_command,
    r72_daily_outreach_read;
REVOKE ALL ON ALL TABLES IN SCHEMA app, app_private
  FROM r72_daily_outreach_definer, r72_daily_outreach_command,
    r72_daily_outreach_read;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app, app_private
  FROM r72_daily_outreach_definer, r72_daily_outreach_command,
    r72_daily_outreach_read;
-- `REVOKE ... ON ALL FUNCTIONS IN SCHEMA` requires ownership or grant option on
-- every function in the schema. app_private holds definer-owned functions that
-- r72_owner cannot act for, so the blanket form aborts with 42501. The three
-- daily-outreach roles are created by this migration, so only a function whose
-- owner this role can act for could ever hold a grant to them. Revoke exactly
-- those and leave every unrelated definer boundary untouched.
DO $daily_outreach_function_revoke$
DECLARE
  target_function text;
BEGIN
  FOR target_function IN
    SELECT candidate.oid::regprocedure::text
    FROM pg_catalog.pg_proc AS candidate
    JOIN pg_catalog.pg_namespace AS candidate_schema
      ON candidate_schema.oid = candidate.pronamespace
    WHERE candidate_schema.nspname = 'app_private'
      AND pg_catalog.pg_has_role(current_user, candidate.proowner, 'USAGE')
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %s FROM r72_daily_outreach_definer,'
      || ' r72_daily_outreach_command, r72_daily_outreach_read',
      target_function
    );
  END LOOP;
END
$daily_outreach_function_revoke$;
REVOKE CREATE ON SCHEMA public
  FROM r72_daily_outreach_definer, r72_daily_outreach_command,
    r72_daily_outreach_read;
GRANT USAGE ON SCHEMA app, app_private TO r72_daily_outreach_definer;
GRANT USAGE ON SCHEMA app_private
  TO r72_daily_outreach_command, r72_daily_outreach_read;
GRANT EXECUTE ON FUNCTION
  app_private.current_workspace_id(),
  app_private.current_user_id(),
  app_private.current_actor_kind(),
  app_private.current_request_id()
TO r72_daily_outreach_definer;

CREATE TABLE app_private.daily_outreach_programme_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  programme_key text NOT NULL CHECK (
    programme_key = lower(btrim(programme_key))
    AND programme_key ~ '^[a-z][a-z0-9_.-]{0,99}$'
  ),
  version_number integer NOT NULL CHECK (version_number > 0),
  previous_version_id uuid,
  channel text NOT NULL CHECK (
    channel IN ('linkedin', 'instagram', 'other_social')
  ),
  segment_key text NOT NULL CHECK (
    segment_key = lower(btrim(segment_key))
    AND segment_key ~ '^[a-z][a-z0-9_.-]{0,99}$'
  ),
  daily_target smallint NOT NULL CHECK (daily_target BETWEEN 1 AND 250),
  operating_daily_cap smallint NOT NULL
    CHECK (operating_daily_cap BETWEEN 1 AND 250),
  provider_daily_cap smallint NOT NULL
    CHECK (provider_daily_cap BETWEEN 1 AND 250),
  cooldown_seconds integer NOT NULL
    CHECK (cooldown_seconds BETWEEN 3600 AND 7776000),
  configuration_sha256 bytea NOT NULL
    CHECK (octet_length(configuration_sha256) = 32),
  effective_from date NOT NULL,
  effective_until date,
  provider_effects_enabled boolean NOT NULL DEFAULT false
    CHECK (provider_effects_enabled IS FALSE),
  created_by_user_id uuid NOT NULL,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
    AND created_request_id !~ '[^[:graph:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, channel),
  UNIQUE (workspace_id, programme_key, id),
  UNIQUE (workspace_id, programme_key, version_number),
  UNIQUE (workspace_id, programme_key, configuration_sha256),
  FOREIGN KEY (workspace_id, programme_key, previous_version_id)
    REFERENCES app_private.daily_outreach_programme_versions
      (workspace_id, programme_key, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (daily_target <= operating_daily_cap),
  CHECK (daily_target <= provider_daily_cap),
  CHECK ((version_number = 1) = (previous_version_id IS NULL)),
  CHECK (effective_until IS NULL OR effective_until >= effective_from)
);

CREATE UNIQUE INDEX daily_outreach_programme_one_root
  ON app_private.daily_outreach_programme_versions
    (workspace_id, programme_key)
  WHERE previous_version_id IS NULL;
CREATE UNIQUE INDEX daily_outreach_programme_one_child
  ON app_private.daily_outreach_programme_versions
    (workspace_id, programme_key, previous_version_id)
  WHERE previous_version_id IS NOT NULL;

CREATE TABLE app_private.daily_outreach_prospect_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  programme_version_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  channel text NOT NULL CHECK (
    channel IN ('linkedin', 'instagram', 'other_social')
  ),
  source_adapter text NOT NULL CHECK (source_adapter IN (
    'zernio_event', 'founder_watchlist', 'crm', 'affiliate_referral',
    'first_party', 'permissioned_import', 'manual'
  )),
  source_subject_sha256 bytea NOT NULL
    CHECK (octet_length(source_subject_sha256) = 32),
  provenance_sha256 bytea NOT NULL
    CHECK (octet_length(provenance_sha256) = 32),
  audience_fit_sha256 bytea NOT NULL
    CHECK (octet_length(audience_fit_sha256) = 32),
  membership_sha256 bytea NOT NULL
    CHECK (octet_length(membership_sha256) = 32),
  source_observed_at timestamptz NOT NULL,
  source_expires_at timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
    AND created_request_id !~ '[^[:graph:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (
    workspace_id, id, programme_version_id, contact_id,
    contact_point_id, channel
  ),
  UNIQUE (workspace_id, programme_version_id, contact_id),
  UNIQUE (workspace_id, programme_version_id, membership_sha256),
  FOREIGN KEY (workspace_id, programme_version_id, channel)
    REFERENCES app_private.daily_outreach_programme_versions
      (workspace_id, id, channel) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (source_observed_at <= created_at + interval '30 seconds'),
  CHECK (source_expires_at > source_observed_at),
  CHECK (source_expires_at <= source_observed_at + interval '366 days')
);

CREATE TABLE app_private.daily_outreach_queue_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  programme_version_id uuid NOT NULL,
  prospect_membership_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  operator_user_id uuid NOT NULL,
  channel text NOT NULL CHECK (
    channel IN ('linkedin', 'instagram', 'other_social')
  ),
  work_date date NOT NULL,
  priority_rank smallint NOT NULL CHECK (priority_rank BETWEEN 1 AND 250),
  allocation_sha256 bytea NOT NULL
    CHECK (octet_length(allocation_sha256) = 32),
  created_by_user_id uuid NOT NULL,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
    AND created_request_id !~ '[^[:graph:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (
    workspace_id, id, prospect_membership_id, contact_id,
    contact_point_id, channel
  ),
  UNIQUE (
    workspace_id, id, programme_version_id, prospect_membership_id,
    contact_id, contact_point_id, channel
  ),
  UNIQUE (
    workspace_id, id, programme_version_id, prospect_membership_id,
    contact_id, contact_point_id, operator_user_id, channel
  ),
  UNIQUE (
    workspace_id, programme_version_id, prospect_membership_id, work_date
  ),
  UNIQUE (workspace_id, contact_id, channel, work_date),
  UNIQUE (
    workspace_id, programme_version_id, operator_user_id,
    work_date, priority_rank
  ),
  UNIQUE (workspace_id, allocation_sha256),
  FOREIGN KEY (workspace_id, programme_version_id, channel)
    REFERENCES app_private.daily_outreach_programme_versions
      (workspace_id, id, channel) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, prospect_membership_id, programme_version_id,
    contact_id, contact_point_id, channel
  ) REFERENCES app_private.daily_outreach_prospect_memberships (
    workspace_id, id, programme_version_id, contact_id,
    contact_point_id, channel
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, operator_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT
);

CREATE INDEX daily_outreach_queue_next_idx
  ON app_private.daily_outreach_queue_allocations
    (workspace_id, operator_user_id, work_date, channel, priority_rank, id);

CREATE TABLE app_private.daily_outreach_queue_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  allocation_id uuid NOT NULL,
  lease_version bigint NOT NULL CHECK (lease_version > 0),
  previous_lease_id uuid,
  lease_token_sha256 bytea NOT NULL
    CHECK (octet_length(lease_token_sha256) = 32),
  leased_by_user_id uuid NOT NULL,
  leased_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, allocation_id, id),
  UNIQUE (workspace_id, allocation_id, lease_version),
  UNIQUE (workspace_id, allocation_id, lease_token_sha256),
  FOREIGN KEY (workspace_id, allocation_id)
    REFERENCES app_private.daily_outreach_queue_allocations
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, allocation_id, previous_lease_id)
    REFERENCES app_private.daily_outreach_queue_leases
      (workspace_id, allocation_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, leased_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK ((lease_version = 1) = (previous_lease_id IS NULL)),
  CHECK (expires_at > leased_at),
  CHECK (expires_at <= leased_at + interval '15 minutes')
);

CREATE UNIQUE INDEX daily_outreach_lease_one_root
  ON app_private.daily_outreach_queue_leases (workspace_id, allocation_id)
  WHERE previous_lease_id IS NULL;
CREATE UNIQUE INDEX daily_outreach_lease_one_child
  ON app_private.daily_outreach_queue_leases
    (workspace_id, allocation_id, previous_lease_id)
  WHERE previous_lease_id IS NOT NULL;

CREATE TABLE app_private.daily_outreach_channel_eligibility_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  allocation_id uuid NOT NULL,
  prospect_membership_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  channel text NOT NULL CHECK (
    channel IN ('linkedin', 'instagram', 'other_social')
  ),
  previous_decision_id uuid,
  decision text NOT NULL CHECK (decision IN (
    'manual_first_touch', 'zernio_reply_eligible',
    'comment_to_dm_eligible', 'other_channel_review', 'blocked'
  )),
  reason_code text NOT NULL CHECK (reason_code IN (
    'manual_review_confirmed', 'exact_owned_reply_evidence',
    'exact_comment_trigger_evidence', 'channel_review_required',
    'suppressed', 'cooldown_active', 'stopped', 'source_stale',
    'unsupported', 'provider_ambiguous'
  )),
  evidence_snapshot_sha256 bytea NOT NULL
    CHECK (octet_length(evidence_snapshot_sha256) = 32),
  provider_evidence_sha256 bytea CHECK (
    provider_evidence_sha256 IS NULL
    OR octet_length(provider_evidence_sha256) = 32
  ),
  provider_effects_enabled boolean NOT NULL DEFAULT false
    CHECK (provider_effects_enabled IS FALSE),
  evaluated_by_user_id uuid NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  evaluated_request_id text NOT NULL CHECK (
    evaluated_request_id = btrim(evaluated_request_id)
    AND length(evaluated_request_id) BETWEEN 1 AND 128
    AND evaluated_request_id !~ '[^[:graph:]]'
  ),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, allocation_id, id),
  FOREIGN KEY (
    workspace_id, allocation_id, prospect_membership_id, contact_id,
    contact_point_id, channel
  ) REFERENCES app_private.daily_outreach_queue_allocations (
    workspace_id, id, prospect_membership_id, contact_id,
    contact_point_id, channel
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, allocation_id, previous_decision_id)
    REFERENCES app_private.daily_outreach_channel_eligibility_decisions
      (workspace_id, allocation_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, evaluated_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (expires_at > evaluated_at),
  CHECK (expires_at <= evaluated_at + interval '5 minutes'),
  CHECK (
    (decision = 'manual_first_touch'
      AND reason_code = 'manual_review_confirmed'
      AND provider_evidence_sha256 IS NULL)
    OR (decision = 'zernio_reply_eligible'
      AND reason_code = 'exact_owned_reply_evidence'
      AND provider_evidence_sha256 IS NOT NULL)
    OR (decision = 'comment_to_dm_eligible'
      AND reason_code = 'exact_comment_trigger_evidence'
      AND provider_evidence_sha256 IS NOT NULL)
    OR (decision = 'other_channel_review'
      AND reason_code = 'channel_review_required'
      AND provider_evidence_sha256 IS NULL)
    OR (decision = 'blocked'
      AND reason_code IN (
        'suppressed', 'cooldown_active', 'stopped', 'source_stale',
        'unsupported', 'provider_ambiguous'
      ))
  )
);

CREATE UNIQUE INDEX daily_outreach_eligibility_one_root
  ON app_private.daily_outreach_channel_eligibility_decisions
    (workspace_id, allocation_id)
  WHERE previous_decision_id IS NULL;
CREATE UNIQUE INDEX daily_outreach_eligibility_one_child
  ON app_private.daily_outreach_channel_eligibility_decisions
    (workspace_id, allocation_id, previous_decision_id)
  WHERE previous_decision_id IS NOT NULL;

-- 0021 exposes a workspace/id key for approval decisions, but Daily Outreach
-- copies the whole approved evidence tuple. Give that tuple a durable target so
-- an assignment cannot retain a decision id while substituting another
-- request, version or content digest.
ALTER TABLE app.company_content_approval_decisions
  ADD CONSTRAINT daily_outreach_approval_decision_exact_key UNIQUE (
    workspace_id, content_item_id, content_version_id,
    approval_request_id, id, content_sha256
  );

-- An allocation may only use content that was explicitly assigned to that
-- queue item. Reassignment is append-only so the attempt command can prove it
-- used the latest exact social-post version and approval tuple.
CREATE TABLE app_private.daily_outreach_content_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  command_key_sha256 bytea NOT NULL
    CHECK (octet_length(command_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  allocation_id uuid NOT NULL,
  programme_version_id uuid NOT NULL,
  prospect_membership_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  channel text NOT NULL CHECK (
    channel IN ('linkedin', 'instagram', 'other_social')
  ),
  previous_assignment_id uuid,
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  assignment_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(assignment_evidence_sha256) = 32),
  assigned_by_user_id uuid NOT NULL,
  assigned_request_id text NOT NULL CHECK (
    assigned_request_id = btrim(assigned_request_id)
    AND length(assigned_request_id) BETWEEN 1 AND 128
    AND assigned_request_id !~ '[^[:graph:]]'
  ),
  assigned_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  UNIQUE (workspace_id, allocation_id, id),
  UNIQUE (workspace_id, allocation_id, previous_assignment_id),
  UNIQUE (
    workspace_id, allocation_id, id, content_item_id,
    content_version_id, content_sha256, approval_request_id,
    approval_decision_id
  ),
  FOREIGN KEY (
    workspace_id, allocation_id, programme_version_id,
    prospect_membership_id, contact_id, contact_point_id, channel
  ) REFERENCES app_private.daily_outreach_queue_allocations (
    workspace_id, id, programme_version_id, prospect_membership_id,
    contact_id, contact_point_id, channel
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, programme_version_id, channel)
    REFERENCES app_private.daily_outreach_programme_versions
      (workspace_id, id, channel) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, allocation_id, previous_assignment_id)
    REFERENCES app_private.daily_outreach_content_assignments
      (workspace_id, allocation_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, content_item_id, content_version_id, content_sha256
  ) REFERENCES app.company_content_versions (
    workspace_id, content_item_id, id, content_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, content_item_id, content_version_id,
    approval_request_id, content_sha256
  ) REFERENCES app.company_content_approval_requests (
    workspace_id, content_item_id, content_version_id, id, content_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, content_item_id, content_version_id,
    approval_request_id, approval_decision_id, content_sha256
  ) REFERENCES app.company_content_approval_decisions (
    workspace_id, content_item_id, content_version_id,
    approval_request_id, id, content_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, assigned_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX daily_outreach_assignment_one_root
  ON app_private.daily_outreach_content_assignments
    (workspace_id, allocation_id)
  WHERE previous_assignment_id IS NULL;

CREATE TABLE app_private.daily_outreach_manual_attempt_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  command_key_sha256 bytea NOT NULL
    CHECK (octet_length(command_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  allocation_id uuid NOT NULL,
  programme_version_id uuid NOT NULL,
  prospect_membership_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  operator_user_id uuid NOT NULL,
  channel text NOT NULL CHECK (
    channel IN ('linkedin', 'instagram', 'other_social')
  ),
  eligibility_decision_id uuid NOT NULL,
  queue_lease_id uuid NOT NULL,
  content_assignment_id uuid NOT NULL,
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  manual_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(manual_evidence_sha256) = 32),
  -- This receipt counts a completed, evidence-backed first touch. Later
  -- outcomes are separate immutable events and never rewrite quota truth.
  outcome text NOT NULL CHECK (outcome = 'attempted'),
  attempted_at timestamptz NOT NULL,
  attempt_utc_day date GENERATED ALWAYS AS (
    (attempted_at AT TIME ZONE 'UTC')::date
  ) STORED,
  provider_effects_enabled boolean NOT NULL DEFAULT false
    CHECK (provider_effects_enabled IS FALSE),
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
    AND recorded_request_id !~ '[^[:graph:]]'
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  UNIQUE (workspace_id, allocation_id),
  UNIQUE (workspace_id, contact_id, channel, attempt_utc_day),
  UNIQUE (
    workspace_id, id, allocation_id, contact_id, operator_user_id
  ),
  UNIQUE (
    workspace_id, id, prospect_membership_id, contact_id, channel
  ),
  FOREIGN KEY (
    workspace_id, allocation_id, programme_version_id,
    prospect_membership_id, contact_id, contact_point_id,
    operator_user_id, channel
  ) REFERENCES app_private.daily_outreach_queue_allocations (
    workspace_id, id, programme_version_id, prospect_membership_id,
    contact_id, contact_point_id, operator_user_id, channel
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, programme_version_id, channel)
    REFERENCES app_private.daily_outreach_programme_versions
      (workspace_id, id, channel) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, allocation_id, queue_lease_id)
    REFERENCES app_private.daily_outreach_queue_leases
      (workspace_id, allocation_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, allocation_id, eligibility_decision_id)
    REFERENCES app_private.daily_outreach_channel_eligibility_decisions
      (workspace_id, allocation_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, content_item_id, content_version_id, content_sha256
  ) REFERENCES app.company_content_versions (
    workspace_id, content_item_id, id, content_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, content_item_id, content_version_id,
    approval_request_id, content_sha256
  ) REFERENCES app.company_content_approval_requests (
    workspace_id, content_item_id, content_version_id, id, content_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, content_item_id, content_version_id,
    approval_request_id, approval_decision_id, content_sha256
  ) REFERENCES app.company_content_approval_decisions (
    workspace_id, content_item_id, content_version_id,
    approval_request_id, id, content_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, allocation_id, content_assignment_id,
    content_item_id, content_version_id, content_sha256,
    approval_request_id, approval_decision_id
  ) REFERENCES app_private.daily_outreach_content_assignments (
    workspace_id, allocation_id, id, content_item_id,
    content_version_id, content_sha256, approval_request_id,
    approval_decision_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, operator_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (attempted_at <= recorded_at + interval '30 seconds'),
  CHECK (attempted_at >= recorded_at - interval '24 hours')
);

CREATE INDEX daily_outreach_attempt_quota_idx
  ON app_private.daily_outreach_manual_attempt_receipts (
    workspace_id, programme_version_id, operator_user_id,
    attempt_utc_day, channel, id
  );

CREATE TABLE app_private.daily_outreach_outcome_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  command_key_sha256 bytea NOT NULL
    CHECK (octet_length(command_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  attempt_receipt_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  operator_user_id uuid NOT NULL,
  previous_outcome_event_id uuid,
  outcome text NOT NULL CHECK (outcome IN (
    'attempted', 'replied', 'positive', 'referred', 'booked',
    'declined', 'no_response', 'invalid_target', 'suppressed'
  )),
  outcome_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(outcome_evidence_sha256) = 32),
  occurred_at timestamptz NOT NULL,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
    AND recorded_request_id !~ '[^[:graph:]]'
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  UNIQUE (workspace_id, attempt_receipt_id, id),
  UNIQUE (workspace_id, attempt_receipt_id, id, contact_id),
  UNIQUE (workspace_id, attempt_receipt_id, previous_outcome_event_id),
  FOREIGN KEY (
    workspace_id, attempt_receipt_id, allocation_id,
    contact_id, operator_user_id
  ) REFERENCES app_private.daily_outreach_manual_attempt_receipts (
    workspace_id, id, allocation_id, contact_id, operator_user_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, allocation_id)
    REFERENCES app_private.daily_outreach_queue_allocations
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attempt_receipt_id, previous_outcome_event_id)
    REFERENCES app_private.daily_outreach_outcome_events
      (workspace_id, attempt_receipt_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, operator_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK ((previous_outcome_event_id IS NULL) = (outcome = 'attempted')),
  CHECK (occurred_at <= recorded_at + interval '30 seconds'),
  CHECK (occurred_at >= recorded_at - interval '30 days')
);

CREATE UNIQUE INDEX daily_outreach_outcome_one_root
  ON app_private.daily_outreach_outcome_events
    (workspace_id, attempt_receipt_id)
  WHERE previous_outcome_event_id IS NULL;
CREATE INDEX daily_outreach_outcome_timeline_idx
  ON app_private.daily_outreach_outcome_events
    (workspace_id, occurred_at DESC, id DESC);

CREATE TABLE app_private.daily_outreach_control_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  attempt_receipt_id uuid NOT NULL,
  outcome_event_id uuid NOT NULL,
  prospect_membership_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  channel text NOT NULL CHECK (
    channel IN ('linkedin', 'instagram', 'other_social')
  ),
  control_kind text NOT NULL CHECK (control_kind IN ('cooldown', 'stopped')),
  reason_code text NOT NULL CHECK (reason_code IN (
    'attempt_recorded', 'no_response', 'response_received',
    'positive_response', 'referred', 'booked', 'declined',
    'invalid_target', 'suppressed'
  )),
  not_before timestamptz,
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  recorded_by_user_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, outcome_event_id),
  FOREIGN KEY (
    workspace_id, attempt_receipt_id, prospect_membership_id,
    contact_id, channel
  ) REFERENCES app_private.daily_outreach_manual_attempt_receipts (
    workspace_id, id, prospect_membership_id, contact_id, channel
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, attempt_receipt_id, outcome_event_id, contact_id
  ) REFERENCES app_private.daily_outreach_outcome_events (
    workspace_id, attempt_receipt_id, id, contact_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, prospect_membership_id)
    REFERENCES app_private.daily_outreach_prospect_memberships
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (
    (control_kind = 'cooldown'
      AND reason_code IN ('attempt_recorded', 'no_response')
      AND not_before IS NOT NULL AND not_before > recorded_at)
    OR (control_kind = 'stopped'
      AND reason_code IN (
        'response_received', 'positive_response', 'referred', 'booked',
        'declined', 'invalid_target', 'suppressed'
      ) AND not_before IS NULL)
  )
);

CREATE INDEX daily_outreach_control_contact_idx
  ON app_private.daily_outreach_control_events
    (workspace_id, contact_id, channel, recorded_at DESC, id DESC);

CREATE TABLE app_private.daily_outreach_projection_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  projection_key_sha256 bytea NOT NULL
    CHECK (octet_length(projection_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  attempt_receipt_id uuid NOT NULL,
  outcome_event_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  task_disposition text NOT NULL
    CHECK (task_disposition IN ('created', 'not_required')),
  task_kind text NOT NULL CHECK (
    task_kind IN ('follow_up', 'reply_review', 'admin_call', 'none')
  ),
  task_id uuid,
  laps_disposition text NOT NULL CHECK (laps_disposition IN (
    'cold_attempt_not_eligible', 'response_evidence_pending'
  )),
  laps_enrollment_id uuid,
  laps_milestone_fact_id uuid,
  projection_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(projection_evidence_sha256) = 32),
  projected_by_user_id uuid NOT NULL,
  projected_request_id text NOT NULL CHECK (
    projected_request_id = btrim(projected_request_id)
    AND length(projected_request_id) BETWEEN 1 AND 128
    AND projected_request_id !~ '[^[:graph:]]'
  ),
  projected_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, projection_key_sha256),
  UNIQUE (workspace_id, outcome_event_id),
  UNIQUE (workspace_id, task_id),
  UNIQUE (workspace_id, laps_milestone_fact_id),
  FOREIGN KEY (workspace_id, attempt_receipt_id)
    REFERENCES app_private.daily_outreach_manual_attempt_receipts
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, attempt_receipt_id, outcome_event_id, contact_id
  ) REFERENCES app_private.daily_outreach_outcome_events (
    workspace_id, attempt_receipt_id, id, contact_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES app.tasks (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, laps_enrollment_id)
    REFERENCES app.conversion_enrollments (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, laps_milestone_fact_id)
    REFERENCES app.conversion_milestone_facts (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, projected_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (
    (task_disposition = 'created' AND task_kind <> 'none' AND task_id IS NOT NULL)
    OR (task_disposition = 'not_required'
      AND task_kind = 'none' AND task_id IS NULL)
  ),
  CHECK (laps_enrollment_id IS NULL AND laps_milestone_fact_id IS NULL)
);

-- Every outreach relation is private, workspace-scoped and append-only. The
-- definer may read/append only while the trusted user context names the row's
-- workspace. Runtime login roles never receive a relation privilege.
ALTER TABLE app_private.daily_outreach_programme_versions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_programme_versions
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_prospect_memberships
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_prospect_memberships
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_queue_allocations
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_queue_allocations
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_queue_leases
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_queue_leases
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_channel_eligibility_decisions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_channel_eligibility_decisions
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_content_assignments
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_content_assignments
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_manual_attempt_receipts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_manual_attempt_receipts
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_outcome_events
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_outcome_events
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_control_events
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_control_events
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_projection_receipts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_projection_receipts
  FORCE ROW LEVEL SECURITY;

CREATE POLICY outreach_programme_owner_all
  ON app_private.daily_outreach_programme_versions FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY outreach_prospect_owner_all
  ON app_private.daily_outreach_prospect_memberships FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY outreach_allocation_owner_all
  ON app_private.daily_outreach_queue_allocations FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY outreach_lease_owner_all
  ON app_private.daily_outreach_queue_leases FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY outreach_eligibility_owner_all
  ON app_private.daily_outreach_channel_eligibility_decisions
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY outreach_assignment_owner_all
  ON app_private.daily_outreach_content_assignments
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY outreach_attempt_owner_all
  ON app_private.daily_outreach_manual_attempt_receipts FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY outreach_outcome_owner_all
  ON app_private.daily_outreach_outcome_events FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY outreach_control_owner_all
  ON app_private.daily_outreach_control_events FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY outreach_projection_owner_all
  ON app_private.daily_outreach_projection_receipts FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);

CREATE POLICY outreach_programme_definer_select
  ON app_private.daily_outreach_programme_versions FOR SELECT
  TO r72_daily_outreach_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_programme_definer_insert
  ON app_private.daily_outreach_programme_versions FOR INSERT
  TO r72_daily_outreach_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_prospect_definer_select
  ON app_private.daily_outreach_prospect_memberships FOR SELECT
  TO r72_daily_outreach_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_prospect_definer_insert
  ON app_private.daily_outreach_prospect_memberships FOR INSERT
  TO r72_daily_outreach_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_allocation_definer_select
  ON app_private.daily_outreach_queue_allocations FOR SELECT
  TO r72_daily_outreach_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_allocation_definer_insert
  ON app_private.daily_outreach_queue_allocations FOR INSERT
  TO r72_daily_outreach_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_lease_definer_select
  ON app_private.daily_outreach_queue_leases FOR SELECT
  TO r72_daily_outreach_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_lease_definer_insert
  ON app_private.daily_outreach_queue_leases FOR INSERT
  TO r72_daily_outreach_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_eligibility_definer_select
  ON app_private.daily_outreach_channel_eligibility_decisions FOR SELECT
  TO r72_daily_outreach_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_eligibility_definer_insert
  ON app_private.daily_outreach_channel_eligibility_decisions FOR INSERT
  TO r72_daily_outreach_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_assignment_definer_select
  ON app_private.daily_outreach_content_assignments FOR SELECT
  TO r72_daily_outreach_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_assignment_definer_insert
  ON app_private.daily_outreach_content_assignments FOR INSERT
  TO r72_daily_outreach_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_attempt_definer_select
  ON app_private.daily_outreach_manual_attempt_receipts FOR SELECT
  TO r72_daily_outreach_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_attempt_definer_insert
  ON app_private.daily_outreach_manual_attempt_receipts FOR INSERT
  TO r72_daily_outreach_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_outcome_definer_select
  ON app_private.daily_outreach_outcome_events FOR SELECT
  TO r72_daily_outreach_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_outcome_definer_insert
  ON app_private.daily_outreach_outcome_events FOR INSERT
  TO r72_daily_outreach_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_control_definer_select
  ON app_private.daily_outreach_control_events FOR SELECT
  TO r72_daily_outreach_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_control_definer_insert
  ON app_private.daily_outreach_control_events FOR INSERT
  TO r72_daily_outreach_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_projection_definer_select
  ON app_private.daily_outreach_projection_receipts FOR SELECT
  TO r72_daily_outreach_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_projection_definer_insert
  ON app_private.daily_outreach_projection_receipts FOR INSERT
  TO r72_daily_outreach_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );

GRANT SELECT, INSERT ON
  app_private.daily_outreach_programme_versions,
  app_private.daily_outreach_prospect_memberships,
  app_private.daily_outreach_queue_allocations,
  app_private.daily_outreach_queue_leases,
  app_private.daily_outreach_channel_eligibility_decisions,
  app_private.daily_outreach_content_assignments,
  app_private.daily_outreach_manual_attempt_receipts,
  app_private.daily_outreach_outcome_events,
  app_private.daily_outreach_control_events,
  app_private.daily_outreach_projection_receipts
TO r72_daily_outreach_definer;

CREATE FUNCTION app_private.reject_daily_outreach_mutation()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Daily Outreach evidence is append-only'
    USING ERRCODE = '42501';
END
$function$;
REVOKE ALL ON FUNCTION app_private.reject_daily_outreach_mutation()
  FROM PUBLIC;

CREATE TRIGGER daily_outreach_programme_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_programme_versions
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_daily_outreach_mutation();
CREATE TRIGGER daily_outreach_prospect_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_prospect_memberships
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_daily_outreach_mutation();
CREATE TRIGGER daily_outreach_allocation_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_queue_allocations
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_daily_outreach_mutation();
CREATE TRIGGER daily_outreach_lease_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_queue_leases
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_daily_outreach_mutation();
CREATE TRIGGER daily_outreach_eligibility_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_channel_eligibility_decisions
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_daily_outreach_mutation();
CREATE TRIGGER daily_outreach_assignment_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_content_assignments
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_daily_outreach_mutation();
CREATE TRIGGER daily_outreach_attempt_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_manual_attempt_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_daily_outreach_mutation();
CREATE TRIGGER daily_outreach_outcome_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_outcome_events
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_daily_outreach_mutation();
CREATE TRIGGER daily_outreach_control_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_control_events
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_daily_outreach_mutation();
CREATE TRIGGER daily_outreach_projection_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_projection_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_daily_outreach_mutation();

-- Suppression insertion and attempt completion take the same transaction lock.
-- If suppression wins, the attempt's fresh recheck sees it and fails. If the
-- attempt wins, the later suppression starts only after that completed action.
CREATE FUNCTION app_private.serialize_daily_outreach_suppression()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.channel = 'social'
     AND (NEW.purpose IS NULL OR NEW.purpose = 'daily_outreach') THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'daily-outreach-contact:' || NEW.workspace_id::text || ':'
          || NEW.contact_point_id::text,
        0
      )
    );
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.serialize_daily_outreach_suppression()
  FROM PUBLIC;
CREATE TRIGGER daily_outreach_suppression_serialization
  BEFORE INSERT ON app.communication_suppression_events
  FOR EACH ROW EXECUTE FUNCTION app_private.serialize_daily_outreach_suppression();

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app_private', 'daily_outreach_programme_versions', 'workspace_id'),
  ('app_private', 'daily_outreach_prospect_memberships', 'workspace_id'),
  ('app_private', 'daily_outreach_queue_allocations', 'workspace_id'),
  ('app_private', 'daily_outreach_queue_leases', 'workspace_id'),
  ('app_private', 'daily_outreach_channel_eligibility_decisions', 'workspace_id'),
  ('app_private', 'daily_outreach_content_assignments', 'workspace_id'),
  ('app_private', 'daily_outreach_manual_attempt_receipts', 'workspace_id'),
  ('app_private', 'daily_outreach_outcome_events', 'workspace_id'),
  ('app_private', 'daily_outreach_control_events', 'workspace_id'),
  ('app_private', 'daily_outreach_projection_receipts', 'workspace_id');

-- Exact supporting reads. Notice the absence of contact-point values, profile
-- data, suppression evidence JSON, content bodies/metadata and approval notes.
GRANT SELECT (workspace_id, user_id, role, status)
  ON app.workspace_memberships TO r72_daily_outreach_definer;
GRANT SELECT (workspace_id, id, display_name, company_name, deleted_at)
  ON app.contacts TO r72_daily_outreach_definer;
GRANT SELECT (
  workspace_id, id, contact_id, kind, dedupe_state, deleted_at
) ON app.contact_points TO r72_daily_outreach_definer;
GRANT SELECT (
  workspace_id, id, contact_id, contact_point_id, channel, purpose,
  state, occurred_at, recorded_at
) ON app.communication_suppression_events TO r72_daily_outreach_definer;
GRANT SELECT (
  workspace_id, id, content_item_id, version_number, content_kind,
  content_sha256
) ON app.company_content_versions TO r72_daily_outreach_definer;
GRANT SELECT (
  workspace_id, id, content_item_id, content_version_id,
  content_sha256, request_number
) ON app.company_content_approval_requests TO r72_daily_outreach_definer;
GRANT SELECT (
  workspace_id, id, content_item_id, content_version_id,
  approval_request_id, content_sha256, decision, decided_at
) ON app.company_content_approval_decisions TO r72_daily_outreach_definer;
GRANT INSERT (
  id, workspace_id, contact_id, title, description, assignee_user_id,
  priority, status, due_at, completed_at, completed_by_user_id,
  row_version, created_at, updated_at
) ON app.tasks TO r72_daily_outreach_definer;
GRANT SELECT (
  workspace_id, id, contact_id, assignee_user_id, status, due_at,
  completed_at
) ON app.tasks TO r72_daily_outreach_definer;

CREATE POLICY daily_outreach_membership_definer_select
  ON app.workspace_memberships FOR SELECT TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY daily_outreach_contacts_definer_select
  ON app.contacts FOR SELECT TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY daily_outreach_points_definer_select
  ON app.contact_points FOR SELECT TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY daily_outreach_suppression_definer_select
  ON app.communication_suppression_events FOR SELECT
  TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY daily_outreach_content_versions_definer_select
  ON app.company_content_versions FOR SELECT TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY daily_outreach_approval_requests_definer_select
  ON app.company_content_approval_requests FOR SELECT
  TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY daily_outreach_approval_decisions_definer_select
  ON app.company_content_approval_decisions FOR SELECT
  TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY daily_outreach_tasks_definer_insert
  ON app.tasks FOR INSERT TO r72_daily_outreach_definer
  WITH CHECK (workspace_id = app_private.current_workspace_id());
CREATE POLICY daily_outreach_tasks_definer_select
  ON app.tasks FOR SELECT TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());

GRANT CREATE ON SCHEMA app_private TO r72_daily_outreach_definer;
SET LOCAL ROLE r72_daily_outreach_definer;

CREATE FUNCTION app_private.assert_daily_outreach_context(
  p_workspace_id uuid,
  p_expected_session text,
  p_manager_required boolean
)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid := app_private.current_workspace_id();
  trusted_user_id uuid := app_private.current_user_id();
  trusted_actor_kind text := app_private.current_actor_kind();
  trusted_request_id text := app_private.current_request_id();
  membership_role text;
BEGIN
  IF session_user <> p_expected_session
     OR trusted_workspace_id IS NULL
     OR p_workspace_id IS DISTINCT FROM trusted_workspace_id
     OR trusted_user_id IS NULL
     OR trusted_actor_kind IS DISTINCT FROM 'user'
     OR trusted_request_id IS NULL
     OR length(trusted_request_id) NOT BETWEEN 1 AND 128
     OR trusted_request_id ~ '[^[:graph:]]' THEN
    RAISE EXCEPTION 'Daily Outreach context denied'
      USING ERRCODE = '42501';
  END IF;
  IF p_expected_session = 'r72_daily_outreach_command'
     AND pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Daily Outreach commands require READ COMMITTED isolation'
      USING ERRCODE = '25001';
  END IF;

  SELECT membership.role INTO membership_role
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = trusted_user_id
    AND membership.status = 'active';
  IF membership_role IS NULL
     OR (p_manager_required
       AND membership_role NOT IN ('owner', 'admin', 'marketer')) THEN
    RAISE EXCEPTION 'Daily Outreach active workspace authority required'
      USING ERRCODE = '42501';
  END IF;
  RETURN trusted_user_id;
END
$function$;

CREATE FUNCTION app_private.publish_daily_outreach_programme_version(
  p_workspace_id uuid,
  p_programme_key text,
  p_version_number integer,
  p_previous_version_id uuid,
  p_channel text,
  p_segment_key text,
  p_daily_target smallint,
  p_operating_daily_cap smallint,
  p_provider_daily_cap smallint,
  p_cooldown_seconds integer,
  p_configuration_sha256 bytea,
  p_effective_from date,
  p_effective_until date
)
RETURNS TABLE (disposition text, programme_version_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  previous_row app_private.daily_outreach_programme_versions%ROWTYPE;
  existing_row app_private.daily_outreach_programme_versions%ROWTYPE;
  selected_id uuid := gen_random_uuid();
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', true
  );
  IF p_programme_key IS NULL OR p_segment_key IS NULL
     OR p_version_number IS NULL OR p_version_number < 1
     OR p_channel IS NULL
     OR p_channel NOT IN ('linkedin', 'instagram', 'other_social')
     OR p_daily_target IS NULL OR p_daily_target NOT BETWEEN 1 AND 250
     OR p_operating_daily_cap IS NULL
     OR p_operating_daily_cap NOT BETWEEN p_daily_target AND 250
     OR p_provider_daily_cap IS NULL
     OR p_provider_daily_cap NOT BETWEEN p_daily_target AND 250
     OR p_cooldown_seconds IS NULL
     OR p_cooldown_seconds NOT BETWEEN 3600 AND 7776000
     OR p_configuration_sha256 IS NULL
     OR octet_length(p_configuration_sha256) <> 32
     OR p_effective_from IS NULL
     OR (p_effective_until IS NOT NULL
       AND p_effective_until < p_effective_from) THEN
    RAISE EXCEPTION 'Invalid Daily Outreach programme version'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-programme:' || p_workspace_id::text || ':'
        || lower(btrim(p_programme_key)),
      0
    )
  );

  SELECT version.* INTO existing_row
  FROM app_private.daily_outreach_programme_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.programme_key = lower(btrim(p_programme_key))
    AND version.version_number = p_version_number;
  IF FOUND THEN
    IF existing_row.previous_version_id IS NOT DISTINCT FROM p_previous_version_id
       AND existing_row.channel = p_channel
       AND existing_row.segment_key = lower(btrim(p_segment_key))
       AND existing_row.daily_target = p_daily_target
       AND existing_row.operating_daily_cap = p_operating_daily_cap
       AND existing_row.provider_daily_cap = p_provider_daily_cap
       AND existing_row.cooldown_seconds = p_cooldown_seconds
       AND existing_row.configuration_sha256 = p_configuration_sha256
       AND existing_row.effective_from = p_effective_from
       AND existing_row.effective_until IS NOT DISTINCT FROM p_effective_until THEN
      RETURN QUERY SELECT 'replayed'::text, existing_row.id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Daily Outreach programme version conflicts'
      USING ERRCODE = '23505';
  END IF;

  IF p_version_number = 1 THEN
    IF p_previous_version_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM app_private.daily_outreach_programme_versions AS version
      WHERE version.workspace_id = p_workspace_id
        AND version.programme_key = lower(btrim(p_programme_key))
    ) THEN
      RAISE EXCEPTION 'Daily Outreach programme root conflicts'
        USING ERRCODE = '23505';
    END IF;
  ELSE
    SELECT version.* INTO previous_row
    FROM app_private.daily_outreach_programme_versions AS version
    WHERE version.workspace_id = p_workspace_id
      AND version.programme_key = lower(btrim(p_programme_key))
      AND version.id = p_previous_version_id
    FOR UPDATE;
    IF NOT FOUND OR previous_row.version_number <> p_version_number - 1 THEN
      RAISE EXCEPTION 'Daily Outreach previous programme version is invalid'
        USING ERRCODE = '23503';
    END IF;
    IF p_effective_from <= previous_row.effective_from THEN
      RAISE EXCEPTION 'Daily Outreach programme effective dates must advance'
        USING ERRCODE = '22023';
    END IF;
    IF p_effective_from <= (clock_timestamp() AT TIME ZONE 'UTC')::date THEN
      RAISE EXCEPTION 'Daily Outreach replacement versions start on a future UTC day'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM app_private.daily_outreach_programme_versions AS child
      WHERE child.workspace_id = p_workspace_id
        AND child.programme_key = lower(btrim(p_programme_key))
        AND child.previous_version_id = p_previous_version_id
    ) THEN
      RAISE EXCEPTION 'Daily Outreach programme history is stale'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  INSERT INTO app_private.daily_outreach_programme_versions (
    id, workspace_id, programme_key, version_number, previous_version_id,
    channel, segment_key, daily_target, operating_daily_cap,
    provider_daily_cap, cooldown_seconds, configuration_sha256,
    effective_from, effective_until, provider_effects_enabled,
    created_by_user_id, created_request_id
  ) VALUES (
    selected_id, p_workspace_id, lower(btrim(p_programme_key)),
    p_version_number, p_previous_version_id, p_channel,
    lower(btrim(p_segment_key)), p_daily_target, p_operating_daily_cap,
    p_provider_daily_cap, p_cooldown_seconds, p_configuration_sha256,
    p_effective_from, p_effective_until, false,
    trusted_user_id, trusted_request_id
  );
  RETURN QUERY SELECT 'recorded'::text, selected_id;
END
$function$;

CREATE FUNCTION app_private.record_daily_outreach_prospect_membership(
  p_workspace_id uuid,
  p_programme_version_id uuid,
  p_contact_id uuid,
  p_contact_point_id uuid,
  p_source_adapter text,
  p_source_subject_sha256 bytea,
  p_provenance_sha256 bytea,
  p_audience_fit_sha256 bytea,
  p_membership_sha256 bytea,
  p_source_observed_at timestamptz,
  p_source_expires_at timestamptz
)
RETURNS TABLE (disposition text, prospect_membership_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  actor_role text;
  programme app_private.daily_outreach_programme_versions%ROWTYPE;
  existing app_private.daily_outreach_prospect_memberships%ROWTYPE;
  expected_sha256 bytea;
  selected_id uuid := gen_random_uuid();
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', false
  );
  SELECT membership.role INTO actor_role
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = trusted_user_id
    AND membership.status = 'active';
  IF actor_role NOT IN ('owner', 'admin', 'marketer', 'sales') THEN
    RAISE EXCEPTION 'Daily Outreach prospect authority required'
      USING ERRCODE = '42501';
  END IF;
  IF p_source_adapter IS NULL OR p_source_adapter NOT IN (
       'zernio_event', 'founder_watchlist', 'crm', 'affiliate_referral',
       'first_party', 'permissioned_import', 'manual'
     )
     OR p_source_subject_sha256 IS NULL
     OR octet_length(p_source_subject_sha256) <> 32
     OR p_provenance_sha256 IS NULL OR octet_length(p_provenance_sha256) <> 32
     OR p_audience_fit_sha256 IS NULL OR octet_length(p_audience_fit_sha256) <> 32
     OR p_membership_sha256 IS NULL OR octet_length(p_membership_sha256) <> 32
     OR p_source_observed_at IS NULL OR p_source_expires_at IS NULL
     OR p_source_observed_at > clock_timestamp() + interval '30 seconds'
     OR p_source_expires_at <= clock_timestamp()
     OR p_source_expires_at > p_source_observed_at + interval '366 days' THEN
    RAISE EXCEPTION 'Invalid Daily Outreach prospect evidence'
      USING ERRCODE = '22023';
  END IF;

  SELECT version.* INTO programme
  FROM app_private.daily_outreach_programme_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_programme_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach programme version not found'
      USING ERRCODE = '23503';
  END IF;
  IF programme.effective_until IS NOT NULL
     AND programme.effective_until
       < (clock_timestamp() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'Daily Outreach programme version expired'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM app.contacts AS contact
  JOIN app.contact_points AS point
    ON point.workspace_id = contact.workspace_id
   AND point.contact_id = contact.id
   AND point.id = p_contact_point_id
  WHERE contact.workspace_id = p_workspace_id
    AND contact.id = p_contact_id
    AND contact.deleted_at IS NULL
    AND point.kind = 'social'
    AND point.deleted_at IS NULL
    AND point.dedupe_state <> 'quarantined';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach prospect contact point is unavailable'
      USING ERRCODE = '23503';
  END IF;

  expected_sha256 := public.digest(
    pg_catalog.format(
      'propertypredator.daily-outreach-membership/v2|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
      p_workspace_id, p_programme_version_id, p_contact_id,
      p_contact_point_id, p_source_adapter,
      pg_catalog.encode(p_source_subject_sha256, 'hex'),
      pg_catalog.encode(p_provenance_sha256, 'hex'),
      pg_catalog.encode(p_audience_fit_sha256, 'hex'),
      pg_catalog.to_char(
        p_source_observed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      pg_catalog.to_char(
        p_source_expires_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ), 'sha256'
  );
  IF p_membership_sha256 <> expected_sha256 THEN
    RAISE EXCEPTION 'Daily Outreach membership digest mismatch'
      USING ERRCODE = '22000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-prospect:' || p_workspace_id::text || ':'
        || p_programme_version_id::text || ':' || p_contact_id::text,
      0
    )
  );
  SELECT membership.* INTO existing
  FROM app_private.daily_outreach_prospect_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.programme_version_id = p_programme_version_id
    AND membership.contact_id = p_contact_id;
  IF FOUND THEN
    IF existing.contact_point_id = p_contact_point_id
       AND existing.source_adapter = p_source_adapter
       AND existing.source_subject_sha256 = p_source_subject_sha256
       AND existing.provenance_sha256 = p_provenance_sha256
       AND existing.audience_fit_sha256 = p_audience_fit_sha256
       AND existing.membership_sha256 = p_membership_sha256
       AND existing.source_observed_at = p_source_observed_at
       AND existing.source_expires_at = p_source_expires_at THEN
      RETURN QUERY SELECT 'replayed'::text, existing.id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Daily Outreach prospect membership conflicts'
      USING ERRCODE = '23505';
  END IF;
  IF p_source_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Daily Outreach prospect source expired while waiting'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.daily_outreach_prospect_memberships (
    id, workspace_id, programme_version_id, contact_id, contact_point_id,
    channel, source_adapter, source_subject_sha256, provenance_sha256,
    audience_fit_sha256, membership_sha256, source_observed_at,
    source_expires_at, created_by_user_id, created_request_id
  ) VALUES (
    selected_id, p_workspace_id, p_programme_version_id, p_contact_id,
    p_contact_point_id, programme.channel, p_source_adapter,
    p_source_subject_sha256, p_provenance_sha256, p_audience_fit_sha256,
    p_membership_sha256, p_source_observed_at, p_source_expires_at,
    trusted_user_id, trusted_request_id
  );
  RETURN QUERY SELECT 'recorded'::text, selected_id;
END
$function$;

CREATE FUNCTION app_private.allocate_daily_outreach_queue_item(
  p_workspace_id uuid,
  p_programme_version_id uuid,
  p_prospect_membership_id uuid,
  p_operator_user_id uuid,
  p_work_date date,
  p_allocation_sha256 bytea
)
RETURNS TABLE (
  disposition text,
  allocation_id uuid,
  priority_rank smallint
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  programme app_private.daily_outreach_programme_versions%ROWTYPE;
  prospect app_private.daily_outreach_prospect_memberships%ROWTYPE;
  existing app_private.daily_outreach_queue_allocations%ROWTYPE;
  expected_sha256 bytea;
  next_rank smallint;
  selected_id uuid := gen_random_uuid();
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', true
  );
  IF p_work_date IS NULL
     OR p_work_date < (clock_timestamp() AT TIME ZONE 'UTC')::date
     OR p_work_date > (clock_timestamp() AT TIME ZONE 'UTC')::date + 7
     OR p_allocation_sha256 IS NULL
     OR octet_length(p_allocation_sha256) <> 32 THEN
    RAISE EXCEPTION 'Invalid Daily Outreach allocation request'
      USING ERRCODE = '22023';
  END IF;

  SELECT version.* INTO programme
  FROM app_private.daily_outreach_programme_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_programme_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach programme is unavailable'
      USING ERRCODE = '23503';
  END IF;

  -- Serialize the active-version check with programme publication. Without
  -- this shared key, a future-day allocation could race a successor and retain
  -- a version that was already superseded for that UTC quota day.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-programme:' || p_workspace_id::text || ':'
        || programme.programme_key,
      0
    )
  );
  SELECT version.* INTO programme
  FROM app_private.daily_outreach_programme_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_programme_version_id;
  SELECT membership.* INTO prospect
  FROM app_private.daily_outreach_prospect_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.id = p_prospect_membership_id
    AND membership.programme_version_id = p_programme_version_id;
  IF prospect.id IS NULL THEN
    RAISE EXCEPTION 'Daily Outreach programme or prospect is unavailable'
      USING ERRCODE = '23503';
  END IF;
  IF p_work_date < programme.effective_from
     OR (programme.effective_until IS NOT NULL
       AND p_work_date > programme.effective_until)
     OR EXISTS (
       SELECT 1
       FROM app_private.daily_outreach_programme_versions AS successor
       WHERE successor.workspace_id = p_workspace_id
         AND successor.programme_key = programme.programme_key
         AND successor.version_number > programme.version_number
         AND successor.effective_from <= p_work_date
     )
     OR prospect.source_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Daily Outreach source or programme is stale'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = p_operator_user_id
    AND membership.status = 'active'
    AND membership.role IN ('owner', 'admin', 'marketer', 'sales');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach operator is unavailable'
      USING ERRCODE = '23503';
  END IF;

  expected_sha256 := public.digest(
    pg_catalog.format(
      'propertypredator.daily-outreach-allocation/v2|%s|%s|%s|%s|%s',
      p_workspace_id, p_programme_version_id, p_prospect_membership_id,
      p_operator_user_id, pg_catalog.to_char(p_work_date, 'YYYY-MM-DD')
    ), 'sha256'
  );
  IF p_allocation_sha256 <> expected_sha256 THEN
    RAISE EXCEPTION 'Daily Outreach allocation digest mismatch'
      USING ERRCODE = '22000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-quota:' || p_workspace_id::text || ':'
        || programme.programme_key || ':' || p_operator_user_id::text
        || ':' || pg_catalog.to_char(p_work_date, 'YYYY-MM-DD'),
      0
    )
  );
  SELECT allocation.* INTO existing
  FROM app_private.daily_outreach_queue_allocations AS allocation
  WHERE allocation.workspace_id = p_workspace_id
    AND allocation.programme_version_id = p_programme_version_id
    AND allocation.prospect_membership_id = p_prospect_membership_id
    AND allocation.work_date = p_work_date;
  IF FOUND THEN
    IF existing.operator_user_id = p_operator_user_id
       AND existing.allocation_sha256 = p_allocation_sha256 THEN
      RETURN QUERY
        SELECT 'replayed'::text, existing.id, existing.priority_rank;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Daily Outreach allocation conflicts'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1 FROM app_private.daily_outreach_queue_allocations AS duplicate
    WHERE duplicate.workspace_id = p_workspace_id
      AND duplicate.contact_id = prospect.contact_id
      AND duplicate.channel = programme.channel
      AND duplicate.work_date = p_work_date
  ) THEN
    RAISE EXCEPTION 'Daily Outreach duplicate daily prospect'
      USING ERRCODE = '23505';
  END IF;

  SELECT (count(*) + 1)::smallint INTO next_rank
  FROM app_private.daily_outreach_queue_allocations AS allocation
  JOIN app_private.daily_outreach_programme_versions AS version
    ON version.workspace_id = allocation.workspace_id
   AND version.id = allocation.programme_version_id
  WHERE allocation.workspace_id = p_workspace_id
    AND version.programme_key = programme.programme_key
    AND allocation.operator_user_id = p_operator_user_id
    AND allocation.work_date = p_work_date;
  IF next_rank > pg_catalog.least(
       250, pg_catalog.greatest(
         programme.daily_target::integer * 3,
         programme.daily_target::integer + 10
       )
     ) THEN
    RAISE EXCEPTION 'Daily Outreach bounded candidate depth exceeded'
      USING ERRCODE = '54000';
  END IF;

  INSERT INTO app_private.daily_outreach_queue_allocations (
    id, workspace_id, programme_version_id, prospect_membership_id,
    contact_id, contact_point_id, operator_user_id, channel, work_date,
    priority_rank, allocation_sha256, created_by_user_id, created_request_id
  ) VALUES (
    selected_id, p_workspace_id, p_programme_version_id,
    p_prospect_membership_id, prospect.contact_id, prospect.contact_point_id,
    p_operator_user_id, programme.channel, p_work_date, next_rank,
    p_allocation_sha256, trusted_user_id, trusted_request_id
  );
  RETURN QUERY SELECT 'recorded'::text, selected_id, next_rank;
END
$function$;

CREATE FUNCTION app_private.record_daily_outreach_channel_eligibility(
  p_workspace_id uuid,
  p_allocation_id uuid,
  p_decision text,
  p_reason_code text,
  p_evidence_snapshot_sha256 bytea,
  p_provider_evidence_sha256 bytea,
  p_expires_at timestamptz
)
RETURNS TABLE (disposition text, eligibility_decision_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  actor_role text;
  allocation app_private.daily_outreach_queue_allocations%ROWTYPE;
  programme app_private.daily_outreach_programme_versions%ROWTYPE;
  prospect app_private.daily_outreach_prospect_memberships%ROWTYPE;
  previous app_private.daily_outreach_channel_eligibility_decisions%ROWTYPE;
  required_blocker text;
  suppression_active boolean := false;
  selected_id uuid := gen_random_uuid();
  evaluated_now timestamptz;
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', false
  );
  IF p_decision IS NULL OR p_decision NOT IN (
       'manual_first_touch', 'zernio_reply_eligible',
       'comment_to_dm_eligible', 'other_channel_review', 'blocked'
     )
     OR p_reason_code IS NULL OR p_reason_code NOT IN (
       'manual_review_confirmed', 'exact_owned_reply_evidence',
       'exact_comment_trigger_evidence', 'channel_review_required',
       'suppressed', 'cooldown_active', 'stopped', 'source_stale',
       'unsupported', 'provider_ambiguous'
     )
     OR p_evidence_snapshot_sha256 IS NULL
     OR octet_length(p_evidence_snapshot_sha256) <> 32
     OR (p_provider_evidence_sha256 IS NOT NULL
       AND octet_length(p_provider_evidence_sha256) <> 32)
     OR p_expires_at IS NULL
     OR p_expires_at <= clock_timestamp()
     OR p_expires_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Invalid Daily Outreach eligibility decision'
      USING ERRCODE = '22023';
  END IF;
  IF p_decision IN ('zernio_reply_eligible', 'comment_to_dm_eligible') THEN
    RAISE EXCEPTION 'Provider-backed Daily Outreach eligibility requires an exact event binding not available in this evidence-only slice'
      USING ERRCODE = '0A000';
  END IF;

  SELECT candidate.* INTO allocation
  FROM app_private.daily_outreach_queue_allocations AS candidate
  WHERE candidate.workspace_id = p_workspace_id
    AND candidate.id = p_allocation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach allocation not found'
      USING ERRCODE = '23503';
  END IF;
  SELECT membership.role INTO actor_role
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = trusted_user_id
    AND membership.status = 'active';
  IF trusted_user_id <> allocation.operator_user_id
     AND actor_role NOT IN ('owner', 'admin', 'marketer') THEN
    RAISE EXCEPTION 'Daily Outreach allocation authority denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT candidate.* INTO allocation
  FROM app_private.daily_outreach_queue_allocations AS candidate
  WHERE candidate.workspace_id = p_workspace_id
    AND candidate.id = p_allocation_id
  FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM app_private.daily_outreach_manual_attempt_receipts AS attempt
    WHERE attempt.workspace_id = p_workspace_id
      AND attempt.allocation_id = p_allocation_id
  ) THEN
    RAISE EXCEPTION 'Completed Daily Outreach allocation cannot be reclassified'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-contact:' || p_workspace_id::text || ':'
        || allocation.contact_point_id::text,
      0
    )
  );
  SELECT membership.* INTO prospect
  FROM app_private.daily_outreach_prospect_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.id = allocation.prospect_membership_id;
  SELECT version.* INTO programme
  FROM app_private.daily_outreach_programme_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.id = allocation.programme_version_id;

  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT ON (coalesce(event.purpose, ''))
        event.purpose, event.state
      FROM app.communication_suppression_events AS event
      WHERE event.workspace_id = p_workspace_id
        AND event.contact_id = allocation.contact_id
        AND event.contact_point_id = allocation.contact_point_id
        AND event.channel = 'social'
        AND (event.purpose IS NULL OR event.purpose = 'daily_outreach')
      ORDER BY coalesce(event.purpose, ''), event.occurred_at DESC,
        event.recorded_at DESC, event.id DESC
    ) AS latest
    WHERE latest.state = 'suppressed'
  ) INTO suppression_active;

  IF prospect.source_expires_at <= clock_timestamp()
     OR allocation.work_date <> (clock_timestamp() AT TIME ZONE 'UTC')::date
     OR allocation.work_date < programme.effective_from
     OR (programme.effective_until IS NOT NULL
       AND allocation.work_date > programme.effective_until)
     OR EXISTS (
       SELECT 1
       FROM app_private.daily_outreach_programme_versions AS successor
       WHERE successor.workspace_id = p_workspace_id
         AND successor.programme_key = programme.programme_key
         AND successor.version_number > programme.version_number
         AND successor.effective_from <= allocation.work_date
     )
     OR NOT EXISTS (
       SELECT 1
       FROM app.contacts AS contact
       JOIN app.contact_points AS point
         ON point.workspace_id = contact.workspace_id
        AND point.contact_id = contact.id
        AND point.id = allocation.contact_point_id
       WHERE contact.workspace_id = p_workspace_id
         AND contact.id = allocation.contact_id
         AND contact.deleted_at IS NULL
         AND point.kind = 'social'
         AND point.deleted_at IS NULL
         AND point.dedupe_state <> 'quarantined'
     ) THEN
    required_blocker := 'source_stale';
  ELSIF suppression_active THEN
    required_blocker := 'suppressed';
  ELSIF EXISTS (
    SELECT 1 FROM app_private.daily_outreach_control_events AS control
    WHERE control.workspace_id = p_workspace_id
      AND control.contact_id = allocation.contact_id
      AND control.channel = allocation.channel
      AND control.control_kind = 'stopped'
  ) THEN
    required_blocker := 'stopped';
  ELSIF EXISTS (
    SELECT 1 FROM app_private.daily_outreach_control_events AS control
    WHERE control.workspace_id = p_workspace_id
      AND control.contact_id = allocation.contact_id
      AND control.channel = allocation.channel
      AND control.control_kind = 'cooldown'
      AND control.not_before > clock_timestamp()
  ) THEN
    required_blocker := 'cooldown_active';
  END IF;

  IF required_blocker IS NOT NULL THEN
    IF p_decision <> 'blocked' OR p_reason_code <> required_blocker THEN
      RAISE EXCEPTION 'Daily Outreach eligibility must block: %', required_blocker
        USING ERRCODE = '55000';
    END IF;
  ELSIF NOT (
    (p_decision = 'manual_first_touch'
      AND p_reason_code = 'manual_review_confirmed'
      AND p_provider_evidence_sha256 IS NULL)
    OR (p_decision = 'zernio_reply_eligible'
      AND p_reason_code = 'exact_owned_reply_evidence'
      AND p_provider_evidence_sha256 IS NOT NULL)
    OR (p_decision = 'comment_to_dm_eligible'
      AND p_reason_code = 'exact_comment_trigger_evidence'
      AND p_provider_evidence_sha256 IS NOT NULL)
    OR (p_decision = 'other_channel_review'
      AND p_reason_code = 'channel_review_required'
      AND p_provider_evidence_sha256 IS NULL)
    OR (p_decision = 'blocked'
      AND p_reason_code IN ('unsupported', 'provider_ambiguous'))
  ) THEN
    RAISE EXCEPTION 'Daily Outreach decision evidence does not match classification'
      USING ERRCODE = '22023';
  END IF;

  SELECT decision.* INTO previous
  FROM app_private.daily_outreach_channel_eligibility_decisions AS decision
  WHERE decision.workspace_id = p_workspace_id
    AND decision.allocation_id = p_allocation_id
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_channel_eligibility_decisions AS child
      WHERE child.workspace_id = decision.workspace_id
        AND child.allocation_id = decision.allocation_id
        AND child.previous_decision_id = decision.id
    )
  LIMIT 1;

  evaluated_now := clock_timestamp();
  IF p_expires_at <= evaluated_now THEN
    RAISE EXCEPTION 'Daily Outreach eligibility expired while waiting'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.daily_outreach_channel_eligibility_decisions (
    id, workspace_id, allocation_id, prospect_membership_id,
    contact_id, contact_point_id, channel, previous_decision_id,
    decision, reason_code, evidence_snapshot_sha256,
    provider_evidence_sha256, provider_effects_enabled,
    evaluated_by_user_id, evaluated_at, expires_at, evaluated_request_id
  ) VALUES (
    selected_id, p_workspace_id, p_allocation_id,
    allocation.prospect_membership_id, allocation.contact_id,
    allocation.contact_point_id, allocation.channel, previous.id,
    p_decision, p_reason_code, p_evidence_snapshot_sha256,
    p_provider_evidence_sha256, false, trusted_user_id,
    evaluated_now, p_expires_at, trusted_request_id
  );
  RETURN QUERY SELECT 'recorded'::text, selected_id;
END
$function$;

CREATE FUNCTION app_private.assign_daily_outreach_approved_content(
  p_workspace_id uuid,
  p_allocation_id uuid,
  p_content_item_id uuid,
  p_content_version_id uuid,
  p_content_sha256 bytea,
  p_approval_request_id uuid,
  p_approval_decision_id uuid,
  p_assignment_evidence_sha256 bytea,
  p_command_key_sha256 bytea
)
RETURNS TABLE (disposition text, content_assignment_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  actor_role text;
  allocation app_private.daily_outreach_queue_allocations%ROWTYPE;
  existing app_private.daily_outreach_content_assignments%ROWTYPE;
  previous app_private.daily_outreach_content_assignments%ROWTYPE;
  content_version record;
  approval_request record;
  approval_decision record;
  request_digest bytea;
  selected_id uuid := gen_random_uuid();
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', false
  );
  IF p_content_sha256 IS NULL OR octet_length(p_content_sha256) <> 32
     OR p_assignment_evidence_sha256 IS NULL
     OR octet_length(p_assignment_evidence_sha256) <> 32
     OR p_command_key_sha256 IS NULL
     OR octet_length(p_command_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'Invalid Daily Outreach content assignment evidence'
      USING ERRCODE = '22023';
  END IF;

  request_digest := public.digest(
    pg_catalog.format(
      'propertypredator.daily-outreach-content-assignment/v1|%s|%s|%s|%s|%s|%s|%s|%s',
      p_workspace_id, p_allocation_id, p_content_item_id,
      p_content_version_id, pg_catalog.encode(p_content_sha256, 'hex'),
      p_approval_request_id, p_approval_decision_id,
      pg_catalog.encode(p_assignment_evidence_sha256, 'hex')
    ), 'sha256'
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-content-assignment:' || p_workspace_id::text || ':'
        || pg_catalog.encode(p_command_key_sha256, 'hex'),
      0
    )
  );
  SELECT assignment.* INTO existing
  FROM app_private.daily_outreach_content_assignments AS assignment
  WHERE assignment.workspace_id = p_workspace_id
    AND assignment.command_key_sha256 = p_command_key_sha256;
  IF FOUND THEN
    IF existing.request_sha256 <> request_digest THEN
      RAISE EXCEPTION 'Daily Outreach content assignment command conflicts'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT 'replayed'::text, existing.id;
    RETURN;
  END IF;

  SELECT candidate.* INTO allocation
  FROM app_private.daily_outreach_queue_allocations AS candidate
  WHERE candidate.workspace_id = p_workspace_id
    AND candidate.id = p_allocation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach allocation not found'
      USING ERRCODE = '23503';
  END IF;
  SELECT membership.role INTO actor_role
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = trusted_user_id
    AND membership.status = 'active';
  IF trusted_user_id <> allocation.operator_user_id
     AND actor_role NOT IN ('owner', 'admin', 'marketer') THEN
    RAISE EXCEPTION 'Daily Outreach content assignment authority denied'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app_private.daily_outreach_manual_attempt_receipts AS attempt
    WHERE attempt.workspace_id = p_workspace_id
      AND attempt.allocation_id = p_allocation_id
  ) THEN
    RAISE EXCEPTION 'Completed Daily Outreach allocation cannot be reassigned'
      USING ERRCODE = '55000';
  END IF;

  SELECT assignment.* INTO previous
  FROM app_private.daily_outreach_content_assignments AS assignment
  WHERE assignment.workspace_id = p_workspace_id
    AND assignment.allocation_id = p_allocation_id
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_content_assignments AS child
      WHERE child.workspace_id = assignment.workspace_id
        AND child.allocation_id = assignment.allocation_id
        AND child.previous_assignment_id = assignment.id
    )
  LIMIT 1;

  -- Serialize with 0021's version/request/decision guards so currentness cannot
  -- change between this check and the immutable assignment insert.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'company-content:' || p_workspace_id::text || ':'
        || p_content_item_id::text,
      7200021
    )
  );
  SELECT version.workspace_id, version.id, version.content_item_id,
         version.version_number, version.content_kind, version.content_sha256
    INTO content_version
  FROM app.company_content_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.content_item_id = p_content_item_id
    AND version.id = p_content_version_id
    AND version.content_sha256 = p_content_sha256
    AND version.content_kind = 'social_post';
  SELECT request.workspace_id, request.id, request.content_item_id,
         request.content_version_id, request.content_sha256,
         request.request_number
    INTO approval_request
  FROM app.company_content_approval_requests AS request
  WHERE request.workspace_id = p_workspace_id
    AND request.id = p_approval_request_id
    AND request.content_item_id = p_content_item_id
    AND request.content_version_id = p_content_version_id
    AND request.content_sha256 = p_content_sha256;
  SELECT decision.workspace_id, decision.id, decision.content_item_id,
         decision.content_version_id, decision.approval_request_id,
         decision.content_sha256, decision.decision
    INTO approval_decision
  FROM app.company_content_approval_decisions AS decision
  WHERE decision.workspace_id = p_workspace_id
    AND decision.id = p_approval_decision_id
    AND decision.content_item_id = p_content_item_id
    AND decision.content_version_id = p_content_version_id
    AND decision.approval_request_id = p_approval_request_id
    AND decision.content_sha256 = p_content_sha256
    AND decision.decision = 'approved';
  IF content_version.id IS NULL OR approval_request.id IS NULL
     OR approval_decision.id IS NULL
     OR EXISTS (
       SELECT 1 FROM app.company_content_versions AS newer
       WHERE newer.workspace_id = p_workspace_id
         AND newer.content_item_id = p_content_item_id
         AND newer.version_number > content_version.version_number
     )
     OR EXISTS (
       SELECT 1 FROM app.company_content_approval_requests AS later_request
       WHERE later_request.workspace_id = p_workspace_id
         AND later_request.content_item_id = p_content_item_id
         AND later_request.content_version_id = p_content_version_id
         AND later_request.request_number > approval_request.request_number
     ) THEN
    RAISE EXCEPTION 'Daily Outreach content assignment is stale or mismatched'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.daily_outreach_content_assignments (
    id, workspace_id, command_key_sha256, request_sha256,
    allocation_id, programme_version_id, prospect_membership_id,
    contact_id, contact_point_id, channel, previous_assignment_id,
    content_item_id, content_version_id, content_sha256,
    approval_request_id, approval_decision_id, assignment_evidence_sha256,
    assigned_by_user_id, assigned_request_id, assigned_at
  ) VALUES (
    selected_id, p_workspace_id, p_command_key_sha256, request_digest,
    p_allocation_id, allocation.programme_version_id,
    allocation.prospect_membership_id, allocation.contact_id,
    allocation.contact_point_id, allocation.channel, previous.id,
    p_content_item_id, p_content_version_id, p_content_sha256,
    p_approval_request_id, p_approval_decision_id,
    p_assignment_evidence_sha256, trusted_user_id,
    trusted_request_id, clock_timestamp()
  );
  RETURN QUERY SELECT 'recorded'::text, selected_id;
END
$function$;

CREATE FUNCTION app_private.claim_next_manual_daily_outreach(
  p_workspace_id uuid,
  p_operator_user_id uuid,
  p_programme_key text,
  p_work_date date,
  p_channel text,
  p_lease_token bytea,
  p_lease_seconds integer
)
RETURNS TABLE (
  allocation_id uuid,
  queue_lease_id uuid,
  lease_version bigint,
  prospect_membership_id uuid,
  contact_id uuid,
  eligibility_decision_id uuid,
  eligibility_expires_at timestamptz,
  content_assignment_id uuid,
  content_item_id uuid,
  content_version_id uuid,
  content_sha256 bytea,
  approval_request_id uuid,
  approval_decision_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  selected_programme app_private.daily_outreach_programme_versions%ROWTYPE;
  selected_allocation app_private.daily_outreach_queue_allocations%ROWTYPE;
  selected_decision app_private.daily_outreach_channel_eligibility_decisions%ROWTYPE;
  selected_prospect app_private.daily_outreach_prospect_memberships%ROWTYPE;
  selected_assignment app_private.daily_outreach_content_assignments%ROWTYPE;
  previous_lease app_private.daily_outreach_queue_leases%ROWTYPE;
  selected_lease_id uuid := gen_random_uuid();
  next_version bigint;
  completed_count integer;
  leased_now timestamptz;
  suppression_active boolean := false;
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', false
  );
  IF trusted_user_id <> p_operator_user_id THEN
    RAISE EXCEPTION 'Daily Outreach leases are operator-bound'
      USING ERRCODE = '42501';
  END IF;
  IF p_work_date IS NULL
     OR p_work_date <> (clock_timestamp() AT TIME ZONE 'UTC')::date
     OR p_programme_key IS NULL
     OR p_programme_key <> lower(btrim(p_programme_key))
     OR p_programme_key !~ '^[a-z][a-z0-9_.-]{0,99}$'
     OR p_channel IS NULL
     OR p_channel NOT IN ('linkedin', 'instagram', 'other_social')
     OR p_lease_token IS NULL OR octet_length(p_lease_token) <> 32
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'Invalid Daily Outreach lease request'
      USING ERRCODE = '22023';
  END IF;

  SELECT version.* INTO selected_programme
  FROM app_private.daily_outreach_programme_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.programme_key = p_programme_key
    AND version.effective_from <= p_work_date
  ORDER BY version.version_number DESC
  LIMIT 1;
  IF selected_programme.id IS NULL
     OR selected_programme.channel <> p_channel
     OR (selected_programme.effective_until IS NOT NULL
       AND selected_programme.effective_until < p_work_date) THEN
    RAISE EXCEPTION 'Daily Outreach active programme not found for UTC quota day'
      USING ERRCODE = '23503';
  END IF;

  -- Claims and completions take the same programme-key/operator/UTC-day lock.
  -- This keeps cap checks ahead of allocation/contact/content locks and makes
  -- the lock order identical on both command paths.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-quota:' || p_workspace_id::text || ':'
        || p_programme_key || ':' || p_operator_user_id::text || ':'
        || pg_catalog.to_char(p_work_date, 'YYYY-MM-DD'),
      0
    )
  );
  SELECT count(*)::integer INTO completed_count
  FROM app_private.daily_outreach_manual_attempt_receipts AS attempt
  JOIN app_private.daily_outreach_programme_versions AS version
    ON version.workspace_id = attempt.workspace_id
   AND version.id = attempt.programme_version_id
  WHERE attempt.workspace_id = p_workspace_id
    AND version.programme_key = p_programme_key
    AND attempt.operator_user_id = p_operator_user_id
    AND attempt.attempt_utc_day = p_work_date;
  IF completed_count >= selected_programme.operating_daily_cap
     OR completed_count >= selected_programme.provider_daily_cap THEN
    RETURN;
  END IF;

  SELECT allocation.* INTO selected_allocation
  FROM app_private.daily_outreach_queue_allocations AS allocation
  JOIN app_private.daily_outreach_programme_versions AS programme
    ON programme.workspace_id = allocation.workspace_id
   AND programme.id = allocation.programme_version_id
  JOIN LATERAL (
    SELECT decision.*
    FROM app_private.daily_outreach_channel_eligibility_decisions AS decision
    WHERE decision.workspace_id = allocation.workspace_id
      AND decision.allocation_id = allocation.id
      AND NOT EXISTS (
        SELECT 1
        FROM app_private.daily_outreach_channel_eligibility_decisions AS child
        WHERE child.workspace_id = decision.workspace_id
          AND child.allocation_id = decision.allocation_id
          AND child.previous_decision_id = decision.id
      )
    LIMIT 1
  ) AS eligibility ON true
  LEFT JOIN LATERAL (
    SELECT lease.*
    FROM app_private.daily_outreach_queue_leases AS lease
    WHERE lease.workspace_id = allocation.workspace_id
      AND lease.allocation_id = allocation.id
    ORDER BY lease.lease_version DESC
    LIMIT 1
  ) AS latest_lease ON true
  WHERE allocation.workspace_id = p_workspace_id
    AND allocation.operator_user_id = p_operator_user_id
    AND programme.id = selected_programme.id
    AND allocation.work_date = p_work_date
    AND allocation.channel = p_channel
    AND eligibility.decision = 'manual_first_touch'
    AND eligibility.expires_at > clock_timestamp()
    AND programme.effective_from <= p_work_date
    AND (programme.effective_until IS NULL
      OR programme.effective_until >= p_work_date)
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_programme_versions AS successor
      WHERE successor.workspace_id = programme.workspace_id
        AND successor.programme_key = programme.programme_key
        AND successor.version_number > programme.version_number
        AND successor.effective_from <= p_work_date
    )
    AND (latest_lease.id IS NULL OR latest_lease.expires_at <= clock_timestamp())
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_manual_attempt_receipts AS attempt
      WHERE attempt.workspace_id = allocation.workspace_id
        AND attempt.allocation_id = allocation.id
    )
  ORDER BY allocation.priority_rank, allocation.id
  FOR UPDATE OF allocation SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-contact:' || p_workspace_id::text || ':'
        || selected_allocation.contact_point_id::text,
      0
    )
  );
  SELECT decision.* INTO selected_decision
  FROM app_private.daily_outreach_channel_eligibility_decisions AS decision
  WHERE decision.workspace_id = p_workspace_id
    AND decision.allocation_id = selected_allocation.id
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_channel_eligibility_decisions AS child
      WHERE child.workspace_id = decision.workspace_id
        AND child.allocation_id = decision.allocation_id
        AND child.previous_decision_id = decision.id
    )
  LIMIT 1;
  IF selected_decision.decision <> 'manual_first_touch'
     OR selected_decision.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Daily Outreach eligibility became stale'
      USING ERRCODE = '40001';
  END IF;
  SELECT prospect.* INTO selected_prospect
  FROM app_private.daily_outreach_prospect_memberships AS prospect
  WHERE prospect.workspace_id = p_workspace_id
    AND prospect.id = selected_allocation.prospect_membership_id;
  IF selected_prospect.source_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Daily Outreach prospect source became stale'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1
  FROM app.contacts AS contact
  JOIN app.contact_points AS point
    ON point.workspace_id = contact.workspace_id
   AND point.contact_id = contact.id
   AND point.id = selected_allocation.contact_point_id
  WHERE contact.workspace_id = p_workspace_id
    AND contact.id = selected_allocation.contact_id
    AND contact.deleted_at IS NULL
    AND point.kind = 'social'
    AND point.deleted_at IS NULL
    AND point.dedupe_state <> 'quarantined';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach prospect contact point became stale'
      USING ERRCODE = '55000';
  END IF;

  SELECT assignment.* INTO selected_assignment
  FROM app_private.daily_outreach_content_assignments AS assignment
  WHERE assignment.workspace_id = p_workspace_id
    AND assignment.allocation_id = selected_allocation.id
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_content_assignments AS child
      WHERE child.workspace_id = assignment.workspace_id
        AND child.allocation_id = assignment.allocation_id
        AND child.previous_assignment_id = assignment.id
    )
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach allocation has no approved content assignment'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'company-content:' || p_workspace_id::text || ':'
        || selected_assignment.content_item_id::text,
      7200021
    )
  );
  PERFORM 1
  FROM app.company_content_versions AS version
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = version.workspace_id
   AND request.content_item_id = version.content_item_id
   AND request.content_version_id = version.id
   AND request.content_sha256 = version.content_sha256
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.content_item_id = request.content_item_id
   AND decision.content_version_id = request.content_version_id
   AND decision.approval_request_id = request.id
   AND decision.content_sha256 = request.content_sha256
   AND decision.decision = 'approved'
  WHERE version.workspace_id = p_workspace_id
    AND version.id = selected_assignment.content_version_id
    AND version.content_item_id = selected_assignment.content_item_id
    AND version.content_sha256 = selected_assignment.content_sha256
    AND version.content_kind = 'social_post'
    AND request.id = selected_assignment.approval_request_id
    AND decision.id = selected_assignment.approval_decision_id
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_approval_requests AS later_request
      WHERE later_request.workspace_id = request.workspace_id
        AND later_request.content_item_id = request.content_item_id
        AND later_request.content_version_id = request.content_version_id
        AND later_request.request_number > request.request_number
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach assigned content became stale'
      USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT ON (coalesce(event.purpose, ''))
        event.purpose, event.state
      FROM app.communication_suppression_events AS event
      WHERE event.workspace_id = p_workspace_id
        AND event.contact_id = selected_allocation.contact_id
        AND event.contact_point_id = selected_allocation.contact_point_id
        AND event.channel = 'social'
        AND (event.purpose IS NULL OR event.purpose = 'daily_outreach')
      ORDER BY coalesce(event.purpose, ''), event.occurred_at DESC,
        event.recorded_at DESC, event.id DESC
    ) AS latest
    WHERE latest.state = 'suppressed'
  ) INTO suppression_active;
  IF suppression_active OR EXISTS (
    SELECT 1 FROM app_private.daily_outreach_control_events AS control
    WHERE control.workspace_id = p_workspace_id
      AND control.contact_id = selected_allocation.contact_id
      AND control.channel = selected_allocation.channel
      AND (control.control_kind = 'stopped'
        OR control.not_before > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'Daily Outreach prospect is blocked or cooling down'
      USING ERRCODE = '55000';
  END IF;

  SELECT lease.* INTO previous_lease
  FROM app_private.daily_outreach_queue_leases AS lease
  WHERE lease.workspace_id = p_workspace_id
    AND lease.allocation_id = selected_allocation.id
  ORDER BY lease.lease_version DESC
  LIMIT 1;
  IF previous_lease.id IS NOT NULL
     AND previous_lease.expires_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Daily Outreach allocation already leased'
      USING ERRCODE = '55P03';
  END IF;
  next_version := coalesce(previous_lease.lease_version, 0) + 1;
  leased_now := clock_timestamp();
  IF selected_decision.expires_at <= leased_now
     OR selected_prospect.source_expires_at <= leased_now
     OR p_work_date <> (leased_now AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'Daily Outreach lease evidence expired while waiting'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.daily_outreach_queue_leases (
    id, workspace_id, allocation_id, lease_version, previous_lease_id,
    lease_token_sha256, leased_by_user_id, leased_at, expires_at
  ) VALUES (
    selected_lease_id, p_workspace_id, selected_allocation.id, next_version,
    previous_lease.id, public.digest(p_lease_token, 'sha256'),
    trusted_user_id, leased_now,
    leased_now + pg_catalog.make_interval(secs => p_lease_seconds)
  );

  RETURN QUERY SELECT
    selected_allocation.id, selected_lease_id, next_version,
    selected_allocation.prospect_membership_id,
    selected_allocation.contact_id, selected_decision.id,
    selected_decision.expires_at, selected_assignment.id,
    selected_assignment.content_item_id,
    selected_assignment.content_version_id,
    selected_assignment.content_sha256,
    selected_assignment.approval_request_id,
    selected_assignment.approval_decision_id;
END
$function$;

CREATE FUNCTION app_private.record_daily_outreach_manual_attempt(
  p_workspace_id uuid,
  p_allocation_id uuid,
  p_eligibility_decision_id uuid,
  p_queue_lease_id uuid,
  p_lease_token bytea,
  p_content_item_id uuid,
  p_content_version_id uuid,
  p_content_sha256 bytea,
  p_approval_request_id uuid,
  p_approval_decision_id uuid,
  p_manual_evidence_sha256 bytea,
  p_outcome text,
  p_attempted_at timestamptz,
  p_command_key_sha256 bytea
)
RETURNS TABLE (
  disposition text,
  attempt_receipt_id uuid,
  outcome_event_id uuid,
  control_event_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  allocation app_private.daily_outreach_queue_allocations%ROWTYPE;
  programme app_private.daily_outreach_programme_versions%ROWTYPE;
  prospect app_private.daily_outreach_prospect_memberships%ROWTYPE;
  eligibility app_private.daily_outreach_channel_eligibility_decisions%ROWTYPE;
  lease app_private.daily_outreach_queue_leases%ROWTYPE;
  assignment app_private.daily_outreach_content_assignments%ROWTYPE;
  existing app_private.daily_outreach_manual_attempt_receipts%ROWTYPE;
  content_version record;
  approval_request record;
  approval_decision record;
  request_digest bytea;
  suppression_active boolean := false;
  attempt_count integer;
  selected_attempt_id uuid := gen_random_uuid();
  selected_outcome_id uuid := gen_random_uuid();
  selected_control_id uuid := gen_random_uuid();
  selected_control_kind text;
  selected_reason_code text;
  selected_not_before timestamptz;
  recorded_now timestamptz;
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', false
  );
  IF p_command_key_sha256 IS NULL
     OR octet_length(p_command_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'Invalid Daily Outreach manual-attempt command key'
      USING ERRCODE = '22023';
  END IF;

  -- The command key names the immutable receipt. Resolve it before checking
  -- lease tokens, client/server timestamps or their derived evidence digest,
  -- which legitimately change on a retry after the first response is lost.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-command:' || p_workspace_id::text || ':'
        || pg_catalog.encode(p_command_key_sha256, 'hex'),
      0
    )
  );
  SELECT attempt.* INTO existing
  FROM app_private.daily_outreach_manual_attempt_receipts AS attempt
  WHERE attempt.workspace_id = p_workspace_id
    AND attempt.command_key_sha256 = p_command_key_sha256;
  IF FOUND THEN
    IF existing.operator_user_id <> trusted_user_id THEN
      RAISE EXCEPTION 'Daily Outreach manual-attempt replay authority denied'
        USING ERRCODE = '42501';
    END IF;
    IF existing.allocation_id IS DISTINCT FROM p_allocation_id
       OR existing.content_item_id IS DISTINCT FROM p_content_item_id
       OR existing.content_version_id IS DISTINCT FROM p_content_version_id
       OR existing.content_sha256 IS DISTINCT FROM p_content_sha256
       OR existing.approval_request_id IS DISTINCT FROM p_approval_request_id
       OR existing.approval_decision_id IS DISTINCT FROM p_approval_decision_id
       OR existing.outcome IS DISTINCT FROM p_outcome THEN
      RAISE EXCEPTION 'Daily Outreach manual-attempt command conflicts'
        USING ERRCODE = '23505';
    END IF;
    SELECT outcome.id INTO selected_outcome_id
    FROM app_private.daily_outreach_outcome_events AS outcome
    WHERE outcome.workspace_id = p_workspace_id
      AND outcome.attempt_receipt_id = existing.id
      AND outcome.previous_outcome_event_id IS NULL;
    SELECT control.id INTO selected_control_id
    FROM app_private.daily_outreach_control_events AS control
    WHERE control.workspace_id = p_workspace_id
      AND control.outcome_event_id = selected_outcome_id;
    RETURN QUERY
      SELECT 'replayed'::text, existing.id,
        selected_outcome_id, selected_control_id;
    RETURN;
  END IF;

  IF p_lease_token IS NULL OR octet_length(p_lease_token) <> 32
     OR p_content_sha256 IS NULL OR octet_length(p_content_sha256) <> 32
     OR p_manual_evidence_sha256 IS NULL
     OR octet_length(p_manual_evidence_sha256) <> 32
     OR p_outcome IS DISTINCT FROM 'attempted'
     OR p_attempted_at IS NULL
     OR p_attempted_at < clock_timestamp() - interval '5 minutes'
     OR p_attempted_at > clock_timestamp() + interval '30 seconds' THEN
    RAISE EXCEPTION 'Invalid Daily Outreach manual-attempt evidence'
      USING ERRCODE = '22023';
  END IF;

  request_digest := public.digest(
    pg_catalog.format(
      'propertypredator.daily-outreach-manual-attempt/v2|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
      p_workspace_id, p_allocation_id, p_eligibility_decision_id,
      p_queue_lease_id, p_content_item_id, p_content_version_id,
      pg_catalog.encode(p_content_sha256, 'hex'), p_approval_request_id,
      p_approval_decision_id,
      pg_catalog.encode(p_manual_evidence_sha256, 'hex'),
      p_outcome, pg_catalog.to_char(
        p_attempted_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      pg_catalog.encode(public.digest(p_lease_token, 'sha256'), 'hex')
    ), 'sha256'
  );

  SELECT candidate.* INTO allocation
  FROM app_private.daily_outreach_queue_allocations AS candidate
  WHERE candidate.workspace_id = p_workspace_id
    AND candidate.id = p_allocation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach allocation not found'
      USING ERRCODE = '23503';
  END IF;
  IF allocation.operator_user_id <> trusted_user_id THEN
    RAISE EXCEPTION 'Daily Outreach attempt is operator-bound'
      USING ERRCODE = '42501';
  END IF;

  SELECT version.* INTO programme
  FROM app_private.daily_outreach_programme_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.id = allocation.programme_version_id;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-quota:' || p_workspace_id::text || ':'
        || programme.programme_key || ':'
        || allocation.operator_user_id::text || ':'
        || pg_catalog.to_char(allocation.work_date, 'YYYY-MM-DD'),
      0
    )
  );
  SELECT candidate.* INTO allocation
  FROM app_private.daily_outreach_queue_allocations AS candidate
  WHERE candidate.workspace_id = p_workspace_id
    AND candidate.id = p_allocation_id
  FOR UPDATE;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-contact:' || p_workspace_id::text || ':'
        || allocation.contact_point_id::text,
      0
    )
  );

  SELECT membership.* INTO prospect
  FROM app_private.daily_outreach_prospect_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.id = allocation.prospect_membership_id;
  IF prospect.source_expires_at <= clock_timestamp()
     OR allocation.work_date <> (p_attempted_at AT TIME ZONE 'UTC')::date
     OR allocation.work_date <> (clock_timestamp() AT TIME ZONE 'UTC')::date
     OR allocation.channel <> programme.channel
     OR allocation.work_date < programme.effective_from
     OR (programme.effective_until IS NOT NULL
       AND allocation.work_date > programme.effective_until)
     OR EXISTS (
       SELECT 1
       FROM app_private.daily_outreach_programme_versions AS successor
       WHERE successor.workspace_id = p_workspace_id
         AND successor.programme_key = programme.programme_key
         AND successor.version_number > programme.version_number
         AND successor.effective_from <= allocation.work_date
     ) THEN
    RAISE EXCEPTION 'Daily Outreach allocation source is stale'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM app.contacts AS contact
  JOIN app.contact_points AS point
    ON point.workspace_id = contact.workspace_id
   AND point.contact_id = contact.id
   AND point.id = allocation.contact_point_id
  WHERE contact.workspace_id = p_workspace_id
    AND contact.id = allocation.contact_id
    AND contact.deleted_at IS NULL
    AND point.kind = 'social'
    AND point.deleted_at IS NULL
    AND point.dedupe_state <> 'quarantined';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach contact point became unavailable'
      USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT ON (coalesce(event.purpose, ''))
        event.purpose, event.state
      FROM app.communication_suppression_events AS event
      WHERE event.workspace_id = p_workspace_id
        AND event.contact_id = allocation.contact_id
        AND event.contact_point_id = allocation.contact_point_id
        AND event.channel = 'social'
        AND (event.purpose IS NULL OR event.purpose = 'daily_outreach')
      ORDER BY coalesce(event.purpose, ''), event.occurred_at DESC,
        event.recorded_at DESC, event.id DESC
    ) AS latest
    WHERE latest.state = 'suppressed'
  ) INTO suppression_active;
  IF suppression_active THEN
    RAISE EXCEPTION 'Daily Outreach prospect is suppressed'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_private.daily_outreach_control_events AS control
    WHERE control.workspace_id = p_workspace_id
      AND control.contact_id = allocation.contact_id
      AND control.channel = allocation.channel
      AND (control.control_kind = 'stopped'
        OR control.not_before > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'Daily Outreach prospect is stopped or cooling down'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app_private.daily_outreach_manual_attempt_receipts AS duplicate
    WHERE duplicate.workspace_id = p_workspace_id
      AND duplicate.contact_id = allocation.contact_id
      AND duplicate.channel = allocation.channel
      AND duplicate.attempt_utc_day = allocation.work_date
  ) THEN
    RAISE EXCEPTION 'Daily Outreach duplicate attempt blocked'
      USING ERRCODE = '23505';
  END IF;

  SELECT decision.* INTO eligibility
  FROM app_private.daily_outreach_channel_eligibility_decisions AS decision
  WHERE decision.workspace_id = p_workspace_id
    AND decision.allocation_id = p_allocation_id
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_channel_eligibility_decisions AS child
      WHERE child.workspace_id = decision.workspace_id
        AND child.allocation_id = decision.allocation_id
        AND child.previous_decision_id = decision.id
    )
  LIMIT 1;
  IF eligibility.id IS DISTINCT FROM p_eligibility_decision_id
     OR eligibility.decision <> 'manual_first_touch'
     OR eligibility.evaluated_at > p_attempted_at
     OR eligibility.expires_at <= p_attempted_at
     OR eligibility.expires_at <= clock_timestamp()
     OR eligibility.provider_effects_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Daily Outreach manual eligibility is stale or unsupported'
      USING ERRCODE = '55000';
  END IF;

  SELECT candidate.* INTO lease
  FROM app_private.daily_outreach_queue_leases AS candidate
  WHERE candidate.workspace_id = p_workspace_id
    AND candidate.allocation_id = p_allocation_id
  ORDER BY candidate.lease_version DESC
  LIMIT 1;
  IF lease.id IS DISTINCT FROM p_queue_lease_id
     OR lease.leased_by_user_id <> trusted_user_id
     OR lease.leased_at > p_attempted_at
     OR lease.expires_at <= p_attempted_at
     OR lease.expires_at <= clock_timestamp()
     OR lease.lease_token_sha256 <> public.digest(p_lease_token, 'sha256') THEN
    RAISE EXCEPTION 'Daily Outreach lease is stale or invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT candidate.* INTO assignment
  FROM app_private.daily_outreach_content_assignments AS candidate
  WHERE candidate.workspace_id = p_workspace_id
    AND candidate.allocation_id = p_allocation_id
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_content_assignments AS child
      WHERE child.workspace_id = candidate.workspace_id
        AND child.allocation_id = candidate.allocation_id
        AND child.previous_assignment_id = candidate.id
    )
  LIMIT 1;
  IF assignment.id IS NULL
     OR assignment.content_item_id <> p_content_item_id
     OR assignment.content_version_id <> p_content_version_id
     OR assignment.content_sha256 <> p_content_sha256
     OR assignment.approval_request_id <> p_approval_request_id
     OR assignment.approval_decision_id <> p_approval_decision_id
     OR assignment.assigned_at > p_attempted_at THEN
    RAISE EXCEPTION 'Daily Outreach assigned content evidence is stale or mismatched'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'company-content:' || p_workspace_id::text || ':'
        || p_content_item_id::text,
      7200021
    )
  );
  SELECT version.workspace_id, version.id, version.content_item_id,
         version.version_number, version.content_kind, version.content_sha256
    INTO content_version
  FROM app.company_content_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.content_item_id = p_content_item_id
    AND version.id = p_content_version_id
    AND version.content_sha256 = p_content_sha256
    AND version.content_kind = 'social_post';
  SELECT request.workspace_id, request.id, request.content_item_id,
         request.content_version_id, request.content_sha256,
         request.request_number
    INTO approval_request
  FROM app.company_content_approval_requests AS request
  WHERE request.workspace_id = p_workspace_id
    AND request.id = p_approval_request_id
    AND request.content_item_id = p_content_item_id
    AND request.content_version_id = p_content_version_id
    AND request.content_sha256 = p_content_sha256;
  SELECT decision.workspace_id, decision.id, decision.content_item_id,
         decision.content_version_id, decision.approval_request_id,
         decision.content_sha256, decision.decision, decision.decided_at
    INTO approval_decision
  FROM app.company_content_approval_decisions AS decision
  WHERE decision.workspace_id = p_workspace_id
    AND decision.id = p_approval_decision_id
    AND decision.content_item_id = p_content_item_id
    AND decision.content_version_id = p_content_version_id
    AND decision.approval_request_id = p_approval_request_id
    AND decision.content_sha256 = p_content_sha256
    AND decision.decision = 'approved';
  IF content_version.id IS NULL OR approval_request.id IS NULL
     OR approval_decision.id IS NULL
     OR approval_decision.decided_at > p_attempted_at
     OR EXISTS (
       SELECT 1 FROM app.company_content_versions AS newer
       WHERE newer.workspace_id = p_workspace_id
         AND newer.content_item_id = p_content_item_id
         AND newer.version_number > content_version.version_number
     )
     OR EXISTS (
       SELECT 1 FROM app.company_content_approval_requests AS later_request
       WHERE later_request.workspace_id = p_workspace_id
         AND later_request.content_item_id = p_content_item_id
         AND later_request.content_version_id = p_content_version_id
         AND later_request.request_number > approval_request.request_number
     ) THEN
    RAISE EXCEPTION 'Daily Outreach approved content evidence is stale or mismatched'
      USING ERRCODE = '55000';
  END IF;

  -- Content serialization can wait behind a concurrent approval/version
  -- command. Recheck every expiring gate after that final wait, immediately
  -- before the quota count and immutable inserts.
  recorded_now := clock_timestamp();
  IF eligibility.expires_at <= recorded_now
     OR lease.expires_at <= recorded_now
     OR prospect.source_expires_at <= recorded_now
     OR allocation.work_date <> (recorded_now AT TIME ZONE 'UTC')::date
     OR p_attempted_at < recorded_now - interval '5 minutes' THEN
    RAISE EXCEPTION 'Daily Outreach attempt evidence expired while waiting'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::integer INTO attempt_count
  FROM app_private.daily_outreach_manual_attempt_receipts AS prior
  JOIN app_private.daily_outreach_programme_versions AS prior_programme
    ON prior_programme.workspace_id = prior.workspace_id
   AND prior_programme.id = prior.programme_version_id
  WHERE prior.workspace_id = p_workspace_id
    AND prior_programme.programme_key = programme.programme_key
    AND prior.operator_user_id = trusted_user_id
    AND prior.attempt_utc_day = allocation.work_date;
  IF attempt_count >= programme.operating_daily_cap
     OR attempt_count >= programme.provider_daily_cap THEN
    RAISE EXCEPTION 'Daily Outreach daily attempt quota exceeded'
      USING ERRCODE = '54000';
  END IF;

  INSERT INTO app_private.daily_outreach_manual_attempt_receipts (
    id, workspace_id, command_key_sha256, request_sha256,
    allocation_id, programme_version_id, prospect_membership_id,
    contact_id, contact_point_id, operator_user_id, channel,
    eligibility_decision_id, queue_lease_id, content_assignment_id,
    content_item_id,
    content_version_id, content_sha256, approval_request_id,
    approval_decision_id, manual_evidence_sha256, outcome, attempted_at,
    provider_effects_enabled, recorded_request_id, recorded_at
  ) VALUES (
    selected_attempt_id, p_workspace_id, p_command_key_sha256,
    request_digest, p_allocation_id, allocation.programme_version_id,
    allocation.prospect_membership_id, allocation.contact_id,
    allocation.contact_point_id, trusted_user_id, allocation.channel,
    p_eligibility_decision_id, p_queue_lease_id, assignment.id,
    p_content_item_id,
    p_content_version_id, p_content_sha256, p_approval_request_id,
    p_approval_decision_id, p_manual_evidence_sha256, p_outcome,
    p_attempted_at, false, trusted_request_id, recorded_now
  );

  INSERT INTO app_private.daily_outreach_outcome_events (
    id, workspace_id, command_key_sha256, request_sha256,
    attempt_receipt_id, allocation_id, contact_id, operator_user_id,
    previous_outcome_event_id, outcome, outcome_evidence_sha256,
    occurred_at, recorded_by_user_id, recorded_request_id, recorded_at
  ) VALUES (
    selected_outcome_id, p_workspace_id,
    public.digest(
      'daily-outreach-initial-outcome:'
        || pg_catalog.encode(p_command_key_sha256, 'hex'),
      'sha256'
    ),
    request_digest, selected_attempt_id, p_allocation_id,
    allocation.contact_id, trusted_user_id, NULL, 'attempted',
    p_manual_evidence_sha256, p_attempted_at, trusted_user_id,
    trusted_request_id, recorded_now
  );

  selected_control_kind := 'cooldown';
  selected_reason_code := 'attempt_recorded';
  selected_not_before := recorded_now
    + pg_catalog.make_interval(secs => programme.cooldown_seconds);

  INSERT INTO app_private.daily_outreach_control_events (
    id, workspace_id, attempt_receipt_id, outcome_event_id,
    prospect_membership_id,
    contact_id, channel, control_kind, reason_code, not_before,
    evidence_sha256, recorded_by_user_id, recorded_at
  ) VALUES (
    selected_control_id, p_workspace_id, selected_attempt_id,
    selected_outcome_id,
    allocation.prospect_membership_id, allocation.contact_id,
    allocation.channel, selected_control_kind, selected_reason_code,
    selected_not_before, p_manual_evidence_sha256, trusted_user_id,
    recorded_now
  );

  RETURN QUERY
    SELECT 'recorded'::text, selected_attempt_id,
      selected_outcome_id, selected_control_id;
END
$function$;

CREATE FUNCTION app_private.record_daily_outreach_outcome_event(
  p_workspace_id uuid,
  p_attempt_receipt_id uuid,
  p_previous_outcome_event_id uuid,
  p_outcome text,
  p_occurred_at timestamptz,
  p_outcome_evidence_sha256 bytea,
  p_command_key_sha256 bytea
)
RETURNS TABLE (
  disposition text,
  outcome_event_id uuid,
  control_event_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  actor_role text;
  attempt app_private.daily_outreach_manual_attempt_receipts%ROWTYPE;
  programme app_private.daily_outreach_programme_versions%ROWTYPE;
  previous app_private.daily_outreach_outcome_events%ROWTYPE;
  latest app_private.daily_outreach_outcome_events%ROWTYPE;
  existing app_private.daily_outreach_outcome_events%ROWTYPE;
  request_digest bytea;
  selected_outcome_id uuid := gen_random_uuid();
  selected_control_id uuid := gen_random_uuid();
  selected_control_kind text;
  selected_reason_code text;
  selected_not_before timestamptz;
  recorded_now timestamptz;
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', false
  );
  IF p_command_key_sha256 IS NULL
     OR octet_length(p_command_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'Invalid Daily Outreach outcome command key'
      USING ERRCODE = '22023';
  END IF;

  -- Replay is keyed by stable outcome identity. occurred_at and its derived
  -- evidence digest may be generated by a server on every retry, so neither can
  -- turn an already-recorded command into a conflict.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-outcome-command:' || p_workspace_id::text || ':'
        || pg_catalog.encode(p_command_key_sha256, 'hex'),
      0
    )
  );
  SELECT event.* INTO existing
  FROM app_private.daily_outreach_outcome_events AS event
  WHERE event.workspace_id = p_workspace_id
    AND event.command_key_sha256 = p_command_key_sha256;
  IF FOUND THEN
    SELECT membership.role INTO actor_role
    FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = trusted_user_id
      AND membership.status = 'active';
    IF trusted_user_id <> existing.operator_user_id
       AND actor_role NOT IN ('owner', 'admin', 'marketer') THEN
      RAISE EXCEPTION 'Daily Outreach outcome replay authority denied'
        USING ERRCODE = '42501';
    END IF;
    IF existing.attempt_receipt_id IS DISTINCT FROM p_attempt_receipt_id
       OR existing.previous_outcome_event_id
         IS DISTINCT FROM p_previous_outcome_event_id
       OR existing.outcome IS DISTINCT FROM p_outcome THEN
      RAISE EXCEPTION 'Daily Outreach outcome command conflicts'
        USING ERRCODE = '23505';
    END IF;
    SELECT control.id INTO selected_control_id
    FROM app_private.daily_outreach_control_events AS control
    WHERE control.workspace_id = p_workspace_id
      AND control.outcome_event_id = existing.id;
    RETURN QUERY SELECT 'replayed'::text, existing.id, selected_control_id;
    RETURN;
  END IF;

  IF p_previous_outcome_event_id IS NULL
     OR p_outcome IS NULL OR p_outcome NOT IN (
       'replied', 'positive', 'referred', 'booked', 'declined',
       'no_response', 'invalid_target', 'suppressed'
     )
     OR p_occurred_at IS NULL
     OR p_occurred_at < clock_timestamp() - interval '30 days'
     OR p_occurred_at > clock_timestamp() + interval '30 seconds'
     OR p_outcome_evidence_sha256 IS NULL
     OR octet_length(p_outcome_evidence_sha256) <> 32 THEN
    RAISE EXCEPTION 'Invalid Daily Outreach outcome evidence'
      USING ERRCODE = '22023';
  END IF;

  request_digest := public.digest(
    pg_catalog.format(
      'propertypredator.daily-outreach-outcome/v1|%s|%s|%s|%s|%s|%s',
      p_workspace_id, p_attempt_receipt_id, p_previous_outcome_event_id,
      p_outcome,
      pg_catalog.to_char(
        p_occurred_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      pg_catalog.encode(p_outcome_evidence_sha256, 'hex')
    ), 'sha256'
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-outcome-chain:' || p_workspace_id::text || ':'
        || p_attempt_receipt_id::text,
      0
    )
  );
  SELECT receipt.* INTO attempt
  FROM app_private.daily_outreach_manual_attempt_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.id = p_attempt_receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach attempt receipt not found'
      USING ERRCODE = '23503';
  END IF;
  SELECT membership.role INTO actor_role
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = trusted_user_id
    AND membership.status = 'active';
  IF trusted_user_id <> attempt.operator_user_id
     AND actor_role NOT IN ('owner', 'admin', 'marketer') THEN
    RAISE EXCEPTION 'Daily Outreach outcome authority denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT event.* INTO previous
  FROM app_private.daily_outreach_outcome_events AS event
  WHERE event.workspace_id = p_workspace_id
    AND event.attempt_receipt_id = p_attempt_receipt_id
    AND event.id = p_previous_outcome_event_id;
  SELECT event.* INTO latest
  FROM app_private.daily_outreach_outcome_events AS event
  WHERE event.workspace_id = p_workspace_id
    AND event.attempt_receipt_id = p_attempt_receipt_id
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_outcome_events AS child
      WHERE child.workspace_id = event.workspace_id
        AND child.attempt_receipt_id = event.attempt_receipt_id
        AND child.previous_outcome_event_id = event.id
    )
  LIMIT 1;
  IF previous.id IS NULL OR latest.id IS DISTINCT FROM previous.id
     OR p_occurred_at < previous.occurred_at THEN
    RAISE EXCEPTION 'Daily Outreach outcome history is stale'
      USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (previous.outcome = 'attempted' AND p_outcome IN (
      'replied', 'positive', 'referred', 'booked', 'declined',
      'no_response', 'invalid_target', 'suppressed'
    ))
    OR (previous.outcome = 'no_response' AND p_outcome IN (
      'replied', 'positive', 'referred', 'booked', 'declined', 'suppressed'
    ))
    OR (previous.outcome = 'replied' AND p_outcome IN (
      'positive', 'referred', 'booked', 'declined'
    ))
    OR (previous.outcome = 'positive' AND p_outcome IN (
      'referred', 'booked', 'declined'
    ))
    OR (previous.outcome = 'referred' AND p_outcome IN ('booked', 'declined'))
  ) THEN
    RAISE EXCEPTION 'Invalid Daily Outreach outcome transition'
      USING ERRCODE = '22023';
  END IF;

  SELECT version.* INTO programme
  FROM app_private.daily_outreach_programme_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.id = attempt.programme_version_id;
  recorded_now := clock_timestamp();
  IF p_occurred_at < attempt.attempted_at
     OR p_occurred_at < recorded_now - interval '30 days'
     OR p_occurred_at > recorded_now + interval '30 seconds' THEN
    RAISE EXCEPTION 'Daily Outreach outcome time became stale while waiting'
      USING ERRCODE = '55000';
  END IF;
  IF p_outcome = 'no_response' THEN
    selected_control_kind := 'cooldown';
    selected_reason_code := 'no_response';
    selected_not_before := recorded_now
      + pg_catalog.make_interval(secs => programme.cooldown_seconds);
  ELSE
    selected_control_kind := 'stopped';
    selected_reason_code := CASE p_outcome
      WHEN 'replied' THEN 'response_received'
      WHEN 'positive' THEN 'positive_response'
      ELSE p_outcome
    END;
    selected_not_before := NULL;
  END IF;

  INSERT INTO app_private.daily_outreach_outcome_events (
    id, workspace_id, command_key_sha256, request_sha256,
    attempt_receipt_id, allocation_id, contact_id, operator_user_id,
    previous_outcome_event_id, outcome, outcome_evidence_sha256,
    occurred_at, recorded_by_user_id, recorded_request_id, recorded_at
  ) VALUES (
    selected_outcome_id, p_workspace_id, p_command_key_sha256,
    request_digest, p_attempt_receipt_id, attempt.allocation_id,
    attempt.contact_id, attempt.operator_user_id,
    p_previous_outcome_event_id, p_outcome, p_outcome_evidence_sha256,
    p_occurred_at, trusted_user_id, trusted_request_id,
    recorded_now
  );
  INSERT INTO app_private.daily_outreach_control_events (
    id, workspace_id, attempt_receipt_id, outcome_event_id,
    prospect_membership_id, contact_id, channel, control_kind,
    reason_code, not_before, evidence_sha256, recorded_by_user_id,
    recorded_at
  ) VALUES (
    selected_control_id, p_workspace_id, p_attempt_receipt_id,
    selected_outcome_id, attempt.prospect_membership_id,
    attempt.contact_id, attempt.channel, selected_control_kind,
    selected_reason_code, selected_not_before,
    p_outcome_evidence_sha256, trusted_user_id, recorded_now
  );
  RETURN QUERY SELECT 'recorded'::text,
    selected_outcome_id, selected_control_id;
END
$function$;

CREATE FUNCTION app_private.project_daily_outreach_outcome(
  p_workspace_id uuid,
  p_outcome_event_id uuid,
  p_projection_key_sha256 bytea,
  p_task_due_at timestamptz,
  p_existing_laps_milestone_fact_id uuid,
  p_projection_evidence_sha256 bytea
)
RETURNS TABLE (
  disposition text,
  projection_receipt_id uuid,
  task_id uuid,
  laps_disposition text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  actor_role text;
  attempt app_private.daily_outreach_manual_attempt_receipts%ROWTYPE;
  outcome app_private.daily_outreach_outcome_events%ROWTYPE;
  control app_private.daily_outreach_control_events%ROWTYPE;
  existing app_private.daily_outreach_projection_receipts%ROWTYPE;
  existing_for_outcome app_private.daily_outreach_projection_receipts%ROWTYPE;
  request_digest bytea;
  selected_projection_id uuid := gen_random_uuid();
  selected_task_id uuid;
  selected_task_disposition text;
  selected_task_kind text;
  selected_task_title text;
  selected_laps_disposition text;
  projected_now timestamptz;
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', false
  );
  IF p_projection_key_sha256 IS NULL
     OR octet_length(p_projection_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'Invalid Daily Outreach projection command key'
      USING ERRCODE = '22023';
  END IF;

  -- A projection key owns exactly one immutable task receipt. A retry may
  -- recompute its requested due timestamp and derived evidence digest; the
  -- stable outcome event identity is what must match the existing receipt.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-projection:' || p_workspace_id::text || ':'
        || pg_catalog.encode(p_projection_key_sha256, 'hex'),
      0
    )
  );
  SELECT receipt.* INTO existing
  FROM app_private.daily_outreach_projection_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.projection_key_sha256 = p_projection_key_sha256;
  IF FOUND THEN
    SELECT receipt.* INTO attempt
    FROM app_private.daily_outreach_manual_attempt_receipts AS receipt
    WHERE receipt.workspace_id = p_workspace_id
      AND receipt.id = existing.attempt_receipt_id;
    SELECT membership.role INTO actor_role
    FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = trusted_user_id
      AND membership.status = 'active';
    IF trusted_user_id <> attempt.operator_user_id
       AND actor_role NOT IN ('owner', 'admin', 'marketer') THEN
      RAISE EXCEPTION 'Daily Outreach projection replay authority denied'
        USING ERRCODE = '42501';
    END IF;
    IF existing.outcome_event_id IS DISTINCT FROM p_outcome_event_id
       OR p_existing_laps_milestone_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'Daily Outreach projection key conflicts'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT
      'replayed'::text, existing.id, existing.task_id,
      existing.laps_disposition;
    RETURN;
  END IF;

  IF p_projection_evidence_sha256 IS NULL
     OR octet_length(p_projection_evidence_sha256) <> 32
     OR p_existing_laps_milestone_fact_id IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid Daily Outreach projection evidence'
      USING ERRCODE = '22023';
  END IF;

  request_digest := public.digest(
    pg_catalog.format(
      'propertypredator.daily-outreach-projection/v2|%s|%s|%s|%s|%s',
      p_workspace_id, p_outcome_event_id,
      coalesce(pg_catalog.to_char(
        p_task_due_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ), ''),
      coalesce(p_existing_laps_milestone_fact_id::text, ''),
      pg_catalog.encode(p_projection_evidence_sha256, 'hex')
    ), 'sha256'
  );
  SELECT receipt.* INTO existing_for_outcome
  FROM app_private.daily_outreach_projection_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.outcome_event_id = p_outcome_event_id;
  IF FOUND THEN
    RAISE EXCEPTION 'Daily Outreach outcome already projected with another key'
      USING ERRCODE = '23505';
  END IF;

  SELECT event.* INTO outcome
  FROM app_private.daily_outreach_outcome_events AS event
  WHERE event.workspace_id = p_workspace_id
    AND event.id = p_outcome_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach outcome event not found'
      USING ERRCODE = '23503';
  END IF;
  SELECT receipt.* INTO attempt
  FROM app_private.daily_outreach_manual_attempt_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.id = outcome.attempt_receipt_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-outcome-chain:' || p_workspace_id::text || ':'
        || attempt.id::text,
      0
    )
  );
  SELECT event.* INTO outcome
  FROM app_private.daily_outreach_outcome_events AS event
  WHERE event.workspace_id = p_workspace_id
    AND event.id = p_outcome_event_id;
  SELECT event.* INTO control
  FROM app_private.daily_outreach_control_events AS event
  WHERE event.workspace_id = p_workspace_id
    AND event.outcome_event_id = p_outcome_event_id;
  IF control.id IS NULL OR EXISTS (
    SELECT 1
    FROM app_private.daily_outreach_outcome_events AS child
    WHERE child.workspace_id = p_workspace_id
      AND child.attempt_receipt_id = outcome.attempt_receipt_id
      AND child.previous_outcome_event_id = outcome.id
  ) THEN
    RAISE EXCEPTION 'Daily Outreach projection outcome is stale or incomplete'
      USING ERRCODE = '40001';
  END IF;
  SELECT membership.role INTO actor_role
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = trusted_user_id
    AND membership.status = 'active';
  IF trusted_user_id <> attempt.operator_user_id
     AND actor_role NOT IN ('owner', 'admin', 'marketer') THEN
    RAISE EXCEPTION 'Daily Outreach projection authority denied'
      USING ERRCODE = '42501';
  END IF;

  IF outcome.outcome IN ('attempted', 'no_response') THEN
    selected_task_kind := 'follow_up';
    selected_task_title := 'Follow up on Daily Outreach';
  ELSIF outcome.outcome IN ('replied', 'positive', 'referred') THEN
    selected_task_kind := 'reply_review';
    selected_task_title := 'Review Daily Outreach response';
  ELSIF outcome.outcome = 'booked' THEN
    selected_task_kind := 'admin_call';
    selected_task_title := 'Prepare Daily Outreach appointment';
  ELSE
    selected_task_kind := 'none';
  END IF;
  projected_now := clock_timestamp();

  IF selected_task_kind = 'none' THEN
    IF p_task_due_at IS NOT NULL THEN
      RAISE EXCEPTION 'Closed Daily Outreach outcome cannot create a task'
        USING ERRCODE = '22023';
    END IF;
    selected_task_disposition := 'not_required';
    selected_task_id := NULL;
  ELSE
    IF p_task_due_at IS NULL
       OR p_task_due_at <= projected_now
       OR p_task_due_at > projected_now + interval '91 days'
       OR (selected_task_kind = 'follow_up'
         AND control.not_before IS NOT NULL
         AND p_task_due_at < control.not_before) THEN
      RAISE EXCEPTION 'Daily Outreach next-task due time is invalid'
        USING ERRCODE = '22023';
    END IF;
    selected_task_disposition := 'created';
    selected_task_id := gen_random_uuid();
    PERFORM 1
    FROM app.workspace_memberships AS assignee
    WHERE assignee.workspace_id = p_workspace_id
      AND assignee.user_id = attempt.operator_user_id
      AND assignee.status = 'active'
      AND assignee.role IN ('owner', 'admin', 'marketer', 'sales');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Daily Outreach task assignee is unavailable'
        USING ERRCODE = '55000';
    END IF;
    INSERT INTO app.tasks (
      id, workspace_id, contact_id, title, description,
      assignee_user_id, priority, status, due_at,
      completed_at, completed_by_user_id, row_version,
      created_at, updated_at
    ) VALUES (
      selected_task_id, p_workspace_id, attempt.contact_id,
      selected_task_title, NULL, attempt.operator_user_id,
      CASE WHEN selected_task_kind IN ('reply_review', 'admin_call')
        THEN 'high' ELSE 'normal' END,
      'open', p_task_due_at, NULL, NULL, 1,
      projected_now, projected_now
    );
  END IF;

  IF outcome.outcome IN (
    'replied', 'positive', 'referred', 'booked', 'declined'
  ) THEN
    selected_laps_disposition := 'response_evidence_pending';
  ELSE
    selected_laps_disposition := 'cold_attempt_not_eligible';
  END IF;

  INSERT INTO app_private.daily_outreach_projection_receipts (
    id, workspace_id, projection_key_sha256, request_sha256,
    attempt_receipt_id, outcome_event_id, contact_id,
    task_disposition, task_kind, task_id,
    laps_disposition, laps_enrollment_id, laps_milestone_fact_id,
    projection_evidence_sha256, projected_by_user_id,
    projected_request_id, projected_at
  ) VALUES (
    selected_projection_id, p_workspace_id, p_projection_key_sha256,
    request_digest, attempt.id, p_outcome_event_id, attempt.contact_id,
    selected_task_disposition, selected_task_kind, selected_task_id,
    selected_laps_disposition, NULL, NULL, p_projection_evidence_sha256,
    trusted_user_id, trusted_request_id, projected_now
  );
  RETURN QUERY SELECT
    'recorded'::text, selected_projection_id, selected_task_id,
    selected_laps_disposition;
END
$function$;

-- HTTP retries must be able to discover a committed immutable receipt before
-- they refresh the queue or acquire another lease. This table-blind resolver
-- exposes the immutable command identity plus receipt/task identifiers and
-- dispositions. Callers MUST compare that identity with the retry intent
-- before treating the receipt as a replay. It never returns a token, evidence
-- digest, endpoint/provider identity, address or message.
CREATE FUNCTION app_private.resolve_daily_outreach_command_replay(
  p_workspace_id uuid,
  p_command_kind text,
  p_command_key_sha256 bytea
)
RETURNS TABLE (
  disposition text,
  command_kind text,
  allocation_id uuid,
  attempt_receipt_id uuid,
  previous_outcome_event_id uuid,
  outcome text,
  outcome_event_id uuid,
  control_event_id uuid,
  projection_receipt_id uuid,
  task_id uuid,
  laps_disposition text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  actor_role text;
  selected_attempt app_private.daily_outreach_manual_attempt_receipts%ROWTYPE;
  selected_outcome app_private.daily_outreach_outcome_events%ROWTYPE;
  selected_control app_private.daily_outreach_control_events%ROWTYPE;
  selected_projection app_private.daily_outreach_projection_receipts%ROWTYPE;
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', false
  );
  IF p_command_kind IS NULL
     OR p_command_kind NOT IN ('manual_attempt', 'outcome')
     OR p_command_key_sha256 IS NULL
     OR octet_length(p_command_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'Invalid Daily Outreach replay lookup'
      USING ERRCODE = '22023';
  END IF;

  IF p_command_kind = 'manual_attempt' THEN
    SELECT receipt.* INTO selected_attempt
    FROM app_private.daily_outreach_manual_attempt_receipts AS receipt
    WHERE receipt.workspace_id = p_workspace_id
      AND receipt.command_key_sha256 = p_command_key_sha256;
    IF NOT FOUND THEN
      RETURN;
    END IF;
    SELECT event.* INTO selected_outcome
    FROM app_private.daily_outreach_outcome_events AS event
    WHERE event.workspace_id = p_workspace_id
      AND event.attempt_receipt_id = selected_attempt.id
      AND event.previous_outcome_event_id IS NULL;
  ELSE
    SELECT event.* INTO selected_outcome
    FROM app_private.daily_outreach_outcome_events AS event
    WHERE event.workspace_id = p_workspace_id
      AND event.command_key_sha256 = p_command_key_sha256;
    IF NOT FOUND THEN
      RETURN;
    END IF;
    SELECT receipt.* INTO selected_attempt
    FROM app_private.daily_outreach_manual_attempt_receipts AS receipt
    WHERE receipt.workspace_id = p_workspace_id
      AND receipt.id = selected_outcome.attempt_receipt_id;
  END IF;

  SELECT membership.role INTO actor_role
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = trusted_user_id
    AND membership.status = 'active';
  IF trusted_user_id <> selected_attempt.operator_user_id
     AND actor_role NOT IN ('owner', 'admin', 'marketer') THEN
    RAISE EXCEPTION 'Daily Outreach replay lookup authority denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT control.* INTO selected_control
  FROM app_private.daily_outreach_control_events AS control
  WHERE control.workspace_id = p_workspace_id
    AND control.outcome_event_id = selected_outcome.id;
  SELECT receipt.* INTO selected_projection
  FROM app_private.daily_outreach_projection_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.outcome_event_id = selected_outcome.id;

  RETURN QUERY SELECT
    'replayed'::text, p_command_kind, selected_attempt.allocation_id,
    selected_attempt.id, selected_outcome.previous_outcome_event_id,
    selected_outcome.outcome, selected_outcome.id, selected_control.id,
    selected_projection.id,
    selected_projection.task_id, selected_projection.laps_disposition;
END
$function$;

CREATE FUNCTION app_private.read_daily_outreach_cockpit(
  p_workspace_id uuid,
  p_programme_version_id uuid,
  p_operator_user_id uuid,
  p_work_date date
)
RETURNS TABLE (
  daily_target smallint,
  operating_daily_cap smallint,
  provider_daily_cap smallint,
  allocated_count bigint,
  completed_count bigint,
  leased_count bigint,
  blocked_count bigint,
  next_allocation_id uuid,
  next_prospect_membership_id uuid,
  next_contact_id uuid,
  next_channel text,
  next_segment_key text,
  next_source_adapter text,
  next_eligibility_decision text,
  next_reason_code text,
  next_eligibility_expires_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  actor_role text;
  programme app_private.daily_outreach_programme_versions%ROWTYPE;
  next_item record;
  selected_allocated_count bigint;
  selected_completed_count bigint;
  selected_leased_count bigint;
  selected_blocked_count bigint;
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_read', false
  );
  SELECT membership.role INTO actor_role
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = trusted_user_id
    AND membership.status = 'active';
  IF trusted_user_id <> p_operator_user_id
     AND actor_role NOT IN ('owner', 'admin', 'marketer') THEN
    RAISE EXCEPTION 'Daily Outreach cockpit authority denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT version.* INTO programme
  FROM app_private.daily_outreach_programme_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_programme_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach programme version not found'
      USING ERRCODE = '23503';
  END IF;

  SELECT count(*) INTO selected_allocated_count
  FROM app_private.daily_outreach_queue_allocations AS allocation
  WHERE allocation.workspace_id = p_workspace_id
    AND allocation.programme_version_id = p_programme_version_id
    AND allocation.operator_user_id = p_operator_user_id
    AND allocation.work_date = p_work_date;
  SELECT count(*) INTO selected_completed_count
  FROM app_private.daily_outreach_manual_attempt_receipts AS attempt
  JOIN app_private.daily_outreach_queue_allocations AS allocation
    ON allocation.workspace_id = attempt.workspace_id
   AND allocation.id = attempt.allocation_id
  WHERE allocation.workspace_id = p_workspace_id
    AND allocation.programme_version_id = p_programme_version_id
    AND allocation.operator_user_id = p_operator_user_id
    AND allocation.work_date = p_work_date;
  SELECT count(*) INTO selected_leased_count
  FROM app_private.daily_outreach_queue_allocations AS allocation
  WHERE allocation.workspace_id = p_workspace_id
    AND allocation.programme_version_id = p_programme_version_id
    AND allocation.operator_user_id = p_operator_user_id
    AND allocation.work_date = p_work_date
    AND EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_queue_leases AS lease
      WHERE lease.workspace_id = allocation.workspace_id
        AND lease.allocation_id = allocation.id
        AND lease.expires_at > statement_timestamp()
        AND NOT EXISTS (
          SELECT 1 FROM app_private.daily_outreach_queue_leases AS newer
          WHERE newer.workspace_id = lease.workspace_id
            AND newer.allocation_id = lease.allocation_id
            AND newer.lease_version > lease.lease_version
        )
    );
  SELECT count(*) INTO selected_blocked_count
  FROM app_private.daily_outreach_queue_allocations AS allocation
  JOIN LATERAL (
    SELECT decision.decision
    FROM app_private.daily_outreach_channel_eligibility_decisions AS decision
    WHERE decision.workspace_id = allocation.workspace_id
      AND decision.allocation_id = allocation.id
    ORDER BY decision.evaluated_at DESC, decision.id DESC
    LIMIT 1
  ) AS latest ON true
  WHERE allocation.workspace_id = p_workspace_id
    AND allocation.programme_version_id = p_programme_version_id
    AND allocation.operator_user_id = p_operator_user_id
    AND allocation.work_date = p_work_date
    AND latest.decision = 'blocked';

  SELECT allocation.id AS allocation_id,
         allocation.prospect_membership_id,
         allocation.contact_id,
         allocation.channel,
         prospect.source_adapter,
         eligibility.decision,
         eligibility.reason_code,
         eligibility.expires_at
    INTO next_item
  FROM app_private.daily_outreach_queue_allocations AS allocation
  JOIN app_private.daily_outreach_prospect_memberships AS prospect
    ON prospect.workspace_id = allocation.workspace_id
   AND prospect.id = allocation.prospect_membership_id
  JOIN LATERAL (
    SELECT decision.decision, decision.reason_code, decision.expires_at
    FROM app_private.daily_outreach_channel_eligibility_decisions AS decision
    WHERE decision.workspace_id = allocation.workspace_id
      AND decision.allocation_id = allocation.id
    ORDER BY decision.evaluated_at DESC, decision.id DESC
    LIMIT 1
  ) AS eligibility ON true
  WHERE allocation.workspace_id = p_workspace_id
    AND allocation.programme_version_id = p_programme_version_id
    AND allocation.operator_user_id = p_operator_user_id
    AND allocation.work_date = p_work_date
    AND eligibility.decision <> 'blocked'
    AND eligibility.expires_at > statement_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM app_private.daily_outreach_manual_attempt_receipts AS attempt
      WHERE attempt.workspace_id = allocation.workspace_id
        AND attempt.allocation_id = allocation.id
    )
  ORDER BY allocation.priority_rank, allocation.id
  LIMIT 1;

  RETURN QUERY SELECT
    programme.daily_target, programme.operating_daily_cap,
    programme.provider_daily_cap, selected_allocated_count,
    selected_completed_count, selected_leased_count, selected_blocked_count,
    next_item.allocation_id, next_item.prospect_membership_id,
    next_item.contact_id, next_item.channel, programme.segment_key,
    next_item.source_adapter, next_item.decision, next_item.reason_code,
    next_item.expires_at;
END
$function$;

CREATE FUNCTION app_private.read_daily_outreach_cockpit_snapshot(
  p_workspace_id uuid,
  p_programme_key text,
  p_operator_user_id uuid,
  p_quota_day_utc date,
  p_queue_limit smallint,
  p_outcome_limit smallint
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  actor_role text;
  programme app_private.daily_outreach_programme_versions%ROWTYPE;
  queue_payload jsonb;
  recent_payload jsonb;
  manager_payload jsonb;
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_read', false
  );
  SELECT membership.role INTO actor_role
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = trusted_user_id
    AND membership.status = 'active';
  IF trusted_user_id <> p_operator_user_id
     AND actor_role NOT IN ('owner', 'admin', 'marketer') THEN
    RAISE EXCEPTION 'Daily Outreach cockpit authority denied'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = p_operator_user_id
    AND membership.status = 'active'
    AND membership.role IN ('owner', 'admin', 'marketer', 'sales');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach operator is unavailable'
      USING ERRCODE = '23503';
  END IF;
  IF p_programme_key IS NULL
     OR p_programme_key <> lower(btrim(p_programme_key))
     OR p_programme_key !~ '^[a-z][a-z0-9_.-]{0,99}$'
     OR p_quota_day_utc IS NULL
     OR p_quota_day_utc
       < (statement_timestamp() AT TIME ZONE 'UTC')::date - 31
     OR p_quota_day_utc
       > (statement_timestamp() AT TIME ZONE 'UTC')::date + 7
     OR p_queue_limit IS NULL OR p_queue_limit NOT BETWEEN 1 AND 50
     OR p_outcome_limit IS NULL OR p_outcome_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Invalid bounded Daily Outreach cockpit request'
      USING ERRCODE = '22023';
  END IF;

  -- A successor implicitly ends its predecessor. Selecting the greatest
  -- effective version gives one authoritative programme for this UTC day.
  SELECT version.* INTO programme
  FROM app_private.daily_outreach_programme_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.programme_key = p_programme_key
    AND version.effective_from <= p_quota_day_utc
  ORDER BY version.version_number DESC
  LIMIT 1;
  IF programme.id IS NULL
     OR (programme.effective_until IS NOT NULL
       AND programme.effective_until < p_quota_day_utc) THEN
    RAISE EXCEPTION 'Daily Outreach active programme version not found'
      USING ERRCODE = '23503';
  END IF;

  SELECT coalesce(
    pg_catalog.jsonb_agg(item.payload ORDER BY item.priority_rank, item.id),
    '[]'::jsonb
  ) INTO queue_payload
  FROM (
    SELECT allocation.priority_rank, allocation.id,
      pg_catalog.jsonb_build_object(
        'allocationId', allocation.id,
        'programmeVersionId', allocation.programme_version_id,
        'prospectMembershipId', allocation.prospect_membership_id,
        'contact', pg_catalog.jsonb_build_object(
          'id', allocation.contact_id,
          'displayName', contact.display_name,
          'companyName', contact.company_name
        ),
        'operatorUserId', allocation.operator_user_id,
        'channel', allocation.channel,
        'segmentKey', allocation_programme.segment_key,
        'quotaDayUtc', allocation.work_date,
        'priorityRank', allocation.priority_rank,
        'source', pg_catalog.jsonb_build_object(
          'adapter', prospect.source_adapter,
          'observedAt', prospect.source_observed_at,
          'expiresAt', prospect.source_expires_at
        ),
        'eligibility', CASE WHEN eligibility.id IS NULL THEN NULL ELSE
          pg_catalog.jsonb_build_object(
            'id', eligibility.id,
            'decision', eligibility.decision,
            'reasonCode', eligibility.reason_code,
            'evaluatedAt', eligibility.evaluated_at,
            'expiresAt', eligibility.expires_at,
            'providerEffectsEnabled', false
          ) END,
        'lease', CASE WHEN lease.id IS NULL THEN NULL ELSE
          pg_catalog.jsonb_build_object(
            'id', lease.id,
            'version', lease.lease_version,
            'leasedByUserId', lease.leased_by_user_id,
            'ownedByViewer', lease.leased_by_user_id = trusted_user_id,
            'leasedAt', lease.leased_at,
            'expiresAt', lease.expires_at,
            'active', lease.expires_at > statement_timestamp()
          ) END,
        'contentAssignment', CASE WHEN assignment.id IS NULL THEN NULL ELSE
          pg_catalog.jsonb_build_object(
            'id', assignment.id,
            'assignedAt', assignment.assigned_at,
            'contentItemId', assignment.content_item_id,
            'contentVersionId', assignment.content_version_id,
            'contentSha256', pg_catalog.encode(
              assignment.content_sha256, 'hex'
            ),
            'approvalRequestId', assignment.approval_request_id,
            'approvalDecisionId', assignment.approval_decision_id,
            'current', assignment_state.is_current
          ) END,
        'latestOutcome', CASE WHEN outcome.id IS NULL THEN NULL ELSE
          pg_catalog.jsonb_build_object(
            'id', outcome.id,
            'attemptReceiptId', attempt.id,
            'outcome', outcome.outcome,
            'occurredAt', outcome.occurred_at,
            'recordedAt', outcome.recorded_at
          ) END,
        'control', CASE WHEN control.id IS NULL THEN NULL ELSE
          pg_catalog.jsonb_build_object(
            'id', control.id,
            'kind', control.control_kind,
            'reasonCode', control.reason_code,
            'notBefore', control.not_before,
            'recordedAt', control.recorded_at
          ) END,
        'projection', CASE WHEN projection.id IS NULL THEN NULL ELSE
          pg_catalog.jsonb_build_object(
            'id', projection.id,
            'taskDisposition', projection.task_disposition,
            'taskKind', projection.task_kind,
            'taskId', projection.task_id,
            'lapsDisposition', projection.laps_disposition,
            'projectedAt', projection.projected_at
          ) END,
        'task', CASE WHEN task.id IS NULL THEN NULL ELSE
          pg_catalog.jsonb_build_object(
            'id', task.id,
            'assigneeUserId', task.assignee_user_id,
            'status', task.status,
            'dueAt', task.due_at,
            'completedAt', task.completed_at
          ) END,
        'actionState', CASE
          WHEN attempt.id IS NOT NULL THEN 'completed'
          WHEN contact.deleted_at IS NOT NULL THEN 'contact_unavailable'
          WHEN prospect.source_expires_at <= statement_timestamp()
            THEN 'source_stale'
          WHEN suppression.active THEN 'suppressed'
          WHEN control.control_kind = 'stopped' THEN 'stopped'
          WHEN control.control_kind = 'cooldown'
            AND control.not_before > statement_timestamp() THEN 'cooling'
          WHEN eligibility.id IS NULL THEN 'eligibility_missing'
          WHEN eligibility.decision = 'blocked' THEN 'blocked'
          WHEN eligibility.expires_at <= statement_timestamp()
            THEN 'eligibility_stale'
          WHEN assignment.id IS NULL THEN 'content_unassigned'
          WHEN NOT assignment_state.is_current THEN 'content_stale'
          WHEN lease.id IS NOT NULL
            AND lease.expires_at > statement_timestamp()
            AND lease.leased_by_user_id = trusted_user_id THEN 'leased_by_me'
          WHEN lease.id IS NOT NULL
            AND lease.expires_at > statement_timestamp() THEN 'leased'
          WHEN eligibility.decision = 'manual_first_touch' THEN 'manual_ready'
          ELSE 'review_required'
        END,
        'commandRechecksRequired', true
      ) AS payload
    FROM app_private.daily_outreach_queue_allocations AS allocation
    JOIN app_private.daily_outreach_programme_versions AS allocation_programme
      ON allocation_programme.workspace_id = allocation.workspace_id
     AND allocation_programme.id = allocation.programme_version_id
    JOIN app_private.daily_outreach_prospect_memberships AS prospect
      ON prospect.workspace_id = allocation.workspace_id
     AND prospect.id = allocation.prospect_membership_id
    JOIN app.contacts AS contact
      ON contact.workspace_id = allocation.workspace_id
     AND contact.id = allocation.contact_id
    LEFT JOIN LATERAL (
      SELECT decision.*
      FROM app_private.daily_outreach_channel_eligibility_decisions AS decision
      WHERE decision.workspace_id = allocation.workspace_id
        AND decision.allocation_id = allocation.id
        AND NOT EXISTS (
          SELECT 1
          FROM app_private.daily_outreach_channel_eligibility_decisions AS child
          WHERE child.workspace_id = decision.workspace_id
            AND child.allocation_id = decision.allocation_id
            AND child.previous_decision_id = decision.id
        )
      LIMIT 1
    ) AS eligibility ON true
    LEFT JOIN LATERAL (
      SELECT candidate.*
      FROM app_private.daily_outreach_queue_leases AS candidate
      WHERE candidate.workspace_id = allocation.workspace_id
        AND candidate.allocation_id = allocation.id
      ORDER BY candidate.lease_version DESC
      LIMIT 1
    ) AS lease ON true
    LEFT JOIN LATERAL (
      SELECT candidate.*
      FROM app_private.daily_outreach_content_assignments AS candidate
      WHERE candidate.workspace_id = allocation.workspace_id
        AND candidate.allocation_id = allocation.id
        AND NOT EXISTS (
          SELECT 1
          FROM app_private.daily_outreach_content_assignments AS child
          WHERE child.workspace_id = candidate.workspace_id
            AND child.allocation_id = candidate.allocation_id
            AND child.previous_assignment_id = candidate.id
        )
      LIMIT 1
    ) AS assignment ON true
    LEFT JOIN LATERAL (
      SELECT receipt.*
      FROM app_private.daily_outreach_manual_attempt_receipts AS receipt
      WHERE receipt.workspace_id = allocation.workspace_id
        AND receipt.allocation_id = allocation.id
      LIMIT 1
    ) AS attempt ON true
    LEFT JOIN LATERAL (
      SELECT event.*
      FROM app_private.daily_outreach_outcome_events AS event
      WHERE event.workspace_id = attempt.workspace_id
        AND event.attempt_receipt_id = attempt.id
        AND NOT EXISTS (
          SELECT 1
          FROM app_private.daily_outreach_outcome_events AS child
          WHERE child.workspace_id = event.workspace_id
            AND child.attempt_receipt_id = event.attempt_receipt_id
            AND child.previous_outcome_event_id = event.id
        )
      LIMIT 1
    ) AS outcome ON true
    LEFT JOIN app_private.daily_outreach_control_events AS control
      ON control.workspace_id = outcome.workspace_id
     AND control.outcome_event_id = outcome.id
    LEFT JOIN app_private.daily_outreach_projection_receipts AS projection
      ON projection.workspace_id = outcome.workspace_id
     AND projection.outcome_event_id = outcome.id
    LEFT JOIN app.tasks AS task
      ON task.workspace_id = projection.workspace_id
     AND task.id = projection.task_id
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1
        FROM (
          SELECT DISTINCT ON (coalesce(event.purpose, ''))
            event.purpose, event.state
          FROM app.communication_suppression_events AS event
          WHERE event.workspace_id = allocation.workspace_id
            AND event.contact_id = allocation.contact_id
            AND event.contact_point_id = allocation.contact_point_id
            AND event.channel = 'social'
            AND (event.purpose IS NULL OR event.purpose = 'daily_outreach')
          ORDER BY coalesce(event.purpose, ''), event.occurred_at DESC,
            event.recorded_at DESC, event.id DESC
        ) AS latest
        WHERE latest.state = 'suppressed'
      ) AS active
    ) AS suppression
    CROSS JOIN LATERAL (
      SELECT assignment.id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM app.company_content_versions AS version
        JOIN app.company_content_approval_requests AS request
          ON request.workspace_id = version.workspace_id
         AND request.content_item_id = version.content_item_id
         AND request.content_version_id = version.id
         AND request.content_sha256 = version.content_sha256
        JOIN app.company_content_approval_decisions AS decision
          ON decision.workspace_id = request.workspace_id
         AND decision.content_item_id = request.content_item_id
         AND decision.content_version_id = request.content_version_id
         AND decision.approval_request_id = request.id
         AND decision.content_sha256 = request.content_sha256
         AND decision.decision = 'approved'
        WHERE version.workspace_id = allocation.workspace_id
          AND version.id = assignment.content_version_id
          AND version.content_item_id = assignment.content_item_id
          AND version.content_sha256 = assignment.content_sha256
          AND version.content_kind = 'social_post'
          AND request.id = assignment.approval_request_id
          AND decision.id = assignment.approval_decision_id
          AND NOT EXISTS (
            SELECT 1 FROM app.company_content_versions AS newer
            WHERE newer.workspace_id = version.workspace_id
              AND newer.content_item_id = version.content_item_id
              AND newer.version_number > version.version_number
          )
          AND NOT EXISTS (
            SELECT 1
            FROM app.company_content_approval_requests AS later_request
            WHERE later_request.workspace_id = request.workspace_id
              AND later_request.content_item_id = request.content_item_id
              AND later_request.content_version_id = request.content_version_id
              AND later_request.request_number > request.request_number
          )
      ) AS is_current
    ) AS assignment_state
    WHERE allocation.workspace_id = p_workspace_id
      AND allocation.programme_version_id = programme.id
      AND allocation.operator_user_id = p_operator_user_id
      AND allocation.work_date = p_quota_day_utc
    ORDER BY allocation.priority_rank, allocation.id
    LIMIT p_queue_limit
  ) AS item;

  SELECT pg_catalog.jsonb_build_object(
    'prospectsReviewed', count(*),
    'validAttempts', count(attempt_id),
    'responses', count(*) FILTER (WHERE latest_outcome IN (
      'replied', 'positive', 'referred', 'booked', 'declined'
    )),
    'positiveResponses', count(*) FILTER (WHERE latest_outcome IN (
      'positive', 'referred', 'booked'
    )),
    'booked', count(*) FILTER (WHERE latest_outcome = 'booked'),
    'noResponse', count(*) FILTER (WHERE latest_outcome = 'no_response'),
    'invalidTargets', count(*) FILTER (WHERE latest_outcome = 'invalid_target'),
    'suppressed', count(*) FILTER (
      WHERE latest_outcome = 'suppressed' OR suppression_active
    ),
    'blocked', count(*) FILTER (
      WHERE attempt_id IS NULL AND eligibility_decision = 'blocked'
    ),
    'activeLeases', count(*) FILTER (
      WHERE attempt_id IS NULL AND lease_expires_at > statement_timestamp()
    ),
    'cooling', count(*) FILTER (
      WHERE control_kind = 'cooldown'
        AND control_not_before > statement_timestamp()
    ),
    'stopped', count(*) FILTER (WHERE control_kind = 'stopped'),
    'tasksCreated', count(*) FILTER (WHERE task_disposition = 'created'),
    'responseEvidencePending', count(*) FILTER (
      WHERE laps_disposition = 'response_evidence_pending'
    ),
    'target', programme.daily_target,
    'operatingDailyCap', programme.operating_daily_cap,
    'providerDailyCap', programme.provider_daily_cap,
    'remainingToTarget', pg_catalog.greatest(
      programme.daily_target::bigint - count(attempt_id), 0
    ),
    'metricAvailability', pg_catalog.jsonb_build_object(
      'conversationsCreated', 'not_linked_in_slice',
      'lapsLinked', 'causal_response_binding_not_available',
      'duplicateCollisions', 'rejected_not_receipted',
      'providerFailures', 'no_provider_effects_in_slice',
      'timeToFirstResponse', 'response_correlation_not_available',
      'timeToHumanHandoff', 'handoff_correlation_not_available',
      'angleBreakdown', 'angle_not_persisted_in_slice'
    )
  ) INTO manager_payload
  FROM (
    SELECT allocation.id,
      attempt.id AS attempt_id,
      outcome.outcome AS latest_outcome,
      eligibility.decision AS eligibility_decision,
      lease.expires_at AS lease_expires_at,
      control.control_kind AS control_kind,
      control.not_before AS control_not_before,
      projection.task_disposition,
      projection.laps_disposition,
      EXISTS (
        SELECT 1
        FROM (
          SELECT DISTINCT ON (coalesce(event.purpose, ''))
            event.purpose, event.state
          FROM app.communication_suppression_events AS event
          WHERE event.workspace_id = allocation.workspace_id
            AND event.contact_id = allocation.contact_id
            AND event.contact_point_id = allocation.contact_point_id
            AND event.channel = 'social'
            AND (event.purpose IS NULL OR event.purpose = 'daily_outreach')
          ORDER BY coalesce(event.purpose, ''), event.occurred_at DESC,
            event.recorded_at DESC, event.id DESC
        ) AS latest
        WHERE latest.state = 'suppressed'
      ) AS suppression_active
    FROM app_private.daily_outreach_queue_allocations AS allocation
    JOIN app_private.daily_outreach_programme_versions AS version
      ON version.workspace_id = allocation.workspace_id
     AND version.id = allocation.programme_version_id
    LEFT JOIN LATERAL (
      SELECT receipt.*
      FROM app_private.daily_outreach_manual_attempt_receipts AS receipt
      WHERE receipt.workspace_id = allocation.workspace_id
        AND receipt.allocation_id = allocation.id
      LIMIT 1
    ) AS attempt ON true
    LEFT JOIN LATERAL (
      SELECT event.*
      FROM app_private.daily_outreach_outcome_events AS event
      WHERE event.workspace_id = attempt.workspace_id
        AND event.attempt_receipt_id = attempt.id
        AND NOT EXISTS (
          SELECT 1
          FROM app_private.daily_outreach_outcome_events AS child
          WHERE child.workspace_id = event.workspace_id
            AND child.attempt_receipt_id = event.attempt_receipt_id
            AND child.previous_outcome_event_id = event.id
        )
      LIMIT 1
    ) AS outcome ON true
    LEFT JOIN app_private.daily_outreach_control_events AS control
      ON control.workspace_id = outcome.workspace_id
     AND control.outcome_event_id = outcome.id
    LEFT JOIN app_private.daily_outreach_projection_receipts AS projection
      ON projection.workspace_id = outcome.workspace_id
     AND projection.outcome_event_id = outcome.id
    LEFT JOIN LATERAL (
      SELECT decision.*
      FROM app_private.daily_outreach_channel_eligibility_decisions AS decision
      WHERE decision.workspace_id = allocation.workspace_id
        AND decision.allocation_id = allocation.id
        AND NOT EXISTS (
          SELECT 1
          FROM app_private.daily_outreach_channel_eligibility_decisions AS child
          WHERE child.workspace_id = decision.workspace_id
            AND child.allocation_id = decision.allocation_id
            AND child.previous_decision_id = decision.id
        )
      LIMIT 1
    ) AS eligibility ON true
    LEFT JOIN LATERAL (
      SELECT candidate.*
      FROM app_private.daily_outreach_queue_leases AS candidate
      WHERE candidate.workspace_id = allocation.workspace_id
        AND candidate.allocation_id = allocation.id
      ORDER BY candidate.lease_version DESC
      LIMIT 1
    ) AS lease ON true
    WHERE allocation.workspace_id = p_workspace_id
      AND allocation.programme_version_id = programme.id
      AND allocation.operator_user_id = p_operator_user_id
      AND allocation.work_date = p_quota_day_utc
  ) AS facts;

  SELECT coalesce(
    pg_catalog.jsonb_agg(item.payload ORDER BY item.occurred_at DESC, item.id DESC),
    '[]'::jsonb
  ) INTO recent_payload
  FROM (
    SELECT outcome.occurred_at, outcome.id,
      pg_catalog.jsonb_build_object(
        'id', outcome.id,
        'attemptReceiptId', attempt.id,
        'allocationId', attempt.allocation_id,
        'programmeVersionId', attempt.programme_version_id,
        'cooldownSeconds', version.cooldown_seconds,
        'quotaDayUtc', attempt.attempt_utc_day,
        'attemptedAt', attempt.attempted_at,
        'contact', pg_catalog.jsonb_build_object(
          'id', attempt.contact_id,
          'displayName', contact.display_name,
          'companyName', contact.company_name
        ),
        'channel', attempt.channel,
        'outcome', outcome.outcome,
        'occurredAt', outcome.occurred_at,
        'recordedAt', outcome.recorded_at,
        'isLatest', true,
        'canRecordOutcome', outcome.outcome IN (
          'attempted', 'no_response', 'replied', 'positive', 'referred'
        ),
        'contentAssignmentId', attempt.content_assignment_id,
        'contentItemId', attempt.content_item_id,
        'contentVersionId', attempt.content_version_id,
        'contentSha256', pg_catalog.encode(attempt.content_sha256, 'hex'),
        'approvalRequestId', attempt.approval_request_id,
        'approvalDecisionId', attempt.approval_decision_id,
        'control', CASE WHEN control.id IS NULL THEN NULL ELSE
          pg_catalog.jsonb_build_object(
            'id', control.id,
            'kind', control.control_kind,
            'reasonCode', control.reason_code,
            'notBefore', control.not_before
          ) END,
        'projection', CASE WHEN projection.id IS NULL THEN NULL ELSE
          pg_catalog.jsonb_build_object(
            'id', projection.id,
            'taskDisposition', projection.task_disposition,
            'taskKind', projection.task_kind,
            'taskId', projection.task_id,
            'lapsDisposition', projection.laps_disposition,
            'projectedAt', projection.projected_at
          ) END,
        'task', CASE WHEN task.id IS NULL THEN NULL ELSE
          pg_catalog.jsonb_build_object(
            'id', task.id,
            'assigneeUserId', task.assignee_user_id,
            'status', task.status,
            'dueAt', task.due_at,
            'completedAt', task.completed_at
          ) END
      ) AS payload
    FROM app_private.daily_outreach_outcome_events AS outcome
    JOIN app_private.daily_outreach_manual_attempt_receipts AS attempt
      ON attempt.workspace_id = outcome.workspace_id
     AND attempt.id = outcome.attempt_receipt_id
    JOIN app_private.daily_outreach_programme_versions AS version
      ON version.workspace_id = attempt.workspace_id
     AND version.id = attempt.programme_version_id
    JOIN app.contacts AS contact
      ON contact.workspace_id = attempt.workspace_id
     AND contact.id = attempt.contact_id
    LEFT JOIN app_private.daily_outreach_control_events AS control
      ON control.workspace_id = outcome.workspace_id
     AND control.outcome_event_id = outcome.id
    LEFT JOIN app_private.daily_outreach_projection_receipts AS projection
      ON projection.workspace_id = outcome.workspace_id
     AND projection.outcome_event_id = outcome.id
    LEFT JOIN app.tasks AS task
      ON task.workspace_id = projection.workspace_id
     AND task.id = projection.task_id
    WHERE outcome.workspace_id = p_workspace_id
      AND version.programme_key = p_programme_key
      AND attempt.operator_user_id = p_operator_user_id
      AND attempt.attempt_utc_day BETWEEN p_quota_day_utc - 29
        AND p_quota_day_utc
      AND NOT EXISTS (
        SELECT 1
        FROM app_private.daily_outreach_outcome_events AS child
        WHERE child.workspace_id = outcome.workspace_id
          AND child.attempt_receipt_id = outcome.attempt_receipt_id
          AND child.previous_outcome_event_id = outcome.id
      )
    ORDER BY outcome.occurred_at DESC, outcome.id DESC
    LIMIT p_outcome_limit
  ) AS item;

  RETURN pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'quotaTimezone', 'UTC',
    'quotaDayUtc', p_quota_day_utc,
    'snapshotAt', statement_timestamp(),
    'workspace', pg_catalog.jsonb_build_object('id', p_workspace_id),
    'operator', pg_catalog.jsonb_build_object(
      'id', p_operator_user_id,
      'viewerUserId', trusted_user_id,
      'viewerIsOperator', trusted_user_id = p_operator_user_id
    ),
    'programme', pg_catalog.jsonb_build_object(
      'id', programme.id,
      'key', programme.programme_key,
      'versionNumber', programme.version_number,
      'channel', programme.channel,
      'segmentKey', programme.segment_key,
      'dailyTarget', programme.daily_target,
      'operatingDailyCap', programme.operating_daily_cap,
      'providerDailyCap', programme.provider_daily_cap,
      'cooldownSeconds', programme.cooldown_seconds,
      'effectiveFrom', programme.effective_from,
      'effectiveUntil', programme.effective_until,
      'providerEffectsEnabled', false
    ),
    'manager', manager_payload,
    'queue', queue_payload,
    'recentOutcomes', recent_payload
  );
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

-- Row-lock privilege is deliberately column-minimal. Any attempted mutation is
-- still rejected by the append-only triggers above.
GRANT UPDATE (id) ON
  app_private.daily_outreach_programme_versions,
  app_private.daily_outreach_queue_allocations
TO r72_daily_outreach_definer;
CREATE POLICY outreach_programme_definer_lock
  ON app_private.daily_outreach_programme_versions FOR UPDATE
  TO r72_daily_outreach_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );
CREATE POLICY outreach_allocation_definer_lock
  ON app_private.daily_outreach_queue_allocations FOR UPDATE
  TO r72_daily_outreach_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
  );

REVOKE CREATE ON SCHEMA app_private FROM r72_daily_outreach_definer;

REVOKE ALL ON FUNCTION app_private.assert_daily_outreach_context(
  uuid, text, boolean
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.publish_daily_outreach_programme_version(
  uuid, text, integer, uuid, text, text, smallint, smallint, smallint,
  integer, bytea, date, date
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.record_daily_outreach_prospect_membership(
  uuid, uuid, uuid, uuid, text, bytea, bytea, bytea, bytea,
  timestamptz, timestamptz
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.allocate_daily_outreach_queue_item(
  uuid, uuid, uuid, uuid, date, bytea
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.record_daily_outreach_channel_eligibility(
  uuid, uuid, text, text, bytea, bytea, timestamptz
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.assign_daily_outreach_approved_content(
  uuid, uuid, uuid, uuid, bytea, uuid, uuid, bytea, bytea
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.claim_next_manual_daily_outreach(
  uuid, uuid, text, date, text, bytea, integer
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.record_daily_outreach_manual_attempt(
  uuid, uuid, uuid, uuid, bytea, uuid, uuid, bytea, uuid, uuid,
  bytea, text, timestamptz, bytea
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.record_daily_outreach_outcome_event(
  uuid, uuid, uuid, text, timestamptz, bytea, bytea
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.project_daily_outreach_outcome(
  uuid, uuid, bytea, timestamptz, uuid, bytea
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.resolve_daily_outreach_command_replay(
  uuid, text, bytea
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.read_daily_outreach_cockpit(
  uuid, uuid, uuid, date
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.read_daily_outreach_cockpit_snapshot(
  uuid, text, uuid, date, smallint, smallint
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;

GRANT EXECUTE ON FUNCTION app_private.publish_daily_outreach_programme_version(
  uuid, text, integer, uuid, text, text, smallint, smallint, smallint,
  integer, bytea, date, date
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.record_daily_outreach_prospect_membership(
  uuid, uuid, uuid, uuid, text, bytea, bytea, bytea, bytea,
  timestamptz, timestamptz
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.allocate_daily_outreach_queue_item(
  uuid, uuid, uuid, uuid, date, bytea
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.record_daily_outreach_channel_eligibility(
  uuid, uuid, text, text, bytea, bytea, timestamptz
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.assign_daily_outreach_approved_content(
  uuid, uuid, uuid, uuid, bytea, uuid, uuid, bytea, bytea
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.claim_next_manual_daily_outreach(
  uuid, uuid, text, date, text, bytea, integer
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.record_daily_outreach_manual_attempt(
  uuid, uuid, uuid, uuid, bytea, uuid, uuid, bytea, uuid, uuid,
  bytea, text, timestamptz, bytea
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.record_daily_outreach_outcome_event(
  uuid, uuid, uuid, text, timestamptz, bytea, bytea
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.project_daily_outreach_outcome(
  uuid, uuid, bytea, timestamptz, uuid, bytea
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.resolve_daily_outreach_command_replay(
  uuid, text, bytea
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.read_daily_outreach_cockpit_snapshot(
  uuid, text, uuid, date, smallint, smallint
) TO r72_daily_outreach_read;

DO $capability_audit$
DECLARE
  unsafe_object text;
  unsafe_function text;
  unexpected_acl text;
  unsafe_membership text;
  expected_oid oid;
  command_functions oid[] := ARRAY[
    'app_private.publish_daily_outreach_programme_version(uuid,text,integer,uuid,text,text,smallint,smallint,smallint,integer,bytea,date,date)'::regprocedure::oid,
    'app_private.record_daily_outreach_prospect_membership(uuid,uuid,uuid,uuid,text,bytea,bytea,bytea,bytea,timestamptz,timestamptz)'::regprocedure::oid,
    'app_private.allocate_daily_outreach_queue_item(uuid,uuid,uuid,uuid,date,bytea)'::regprocedure::oid,
    'app_private.record_daily_outreach_channel_eligibility(uuid,uuid,text,text,bytea,bytea,timestamptz)'::regprocedure::oid,
    'app_private.assign_daily_outreach_approved_content(uuid,uuid,uuid,uuid,bytea,uuid,uuid,bytea,bytea)'::regprocedure::oid,
    'app_private.claim_next_manual_daily_outreach(uuid,uuid,text,date,text,bytea,integer)'::regprocedure::oid,
    'app_private.record_daily_outreach_manual_attempt(uuid,uuid,uuid,uuid,bytea,uuid,uuid,bytea,uuid,uuid,bytea,text,timestamptz,bytea)'::regprocedure::oid,
    'app_private.record_daily_outreach_outcome_event(uuid,uuid,uuid,text,timestamptz,bytea,bytea)'::regprocedure::oid,
    'app_private.project_daily_outreach_outcome(uuid,uuid,bytea,timestamptz,uuid,bytea)'::regprocedure::oid,
    'app_private.resolve_daily_outreach_command_replay(uuid,text,bytea)'::regprocedure::oid
  ];
  read_functions oid[] := ARRAY[
    'app_private.read_daily_outreach_cockpit_snapshot(uuid,text,uuid,date,smallint,smallint)'::regprocedure::oid
  ];
  definer_functions oid[] := ARRAY[
    'app_private.current_workspace_id()'::regprocedure::oid,
    'app_private.current_user_id()'::regprocedure::oid,
    'app_private.current_actor_kind()'::regprocedure::oid,
    'app_private.current_request_id()'::regprocedure::oid,
    'app_private.assert_daily_outreach_context(uuid,text,boolean)'::regprocedure::oid,
    'app_private.read_daily_outreach_cockpit(uuid,uuid,uuid,date)'::regprocedure::oid
  ] || command_functions || read_functions;
  owned_functions oid[] := ARRAY[
    'app_private.assert_daily_outreach_context(uuid,text,boolean)'::regprocedure::oid,
    'app_private.read_daily_outreach_cockpit(uuid,uuid,uuid,date)'::regprocedure::oid
  ] || command_functions || read_functions;
BEGIN
  SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
    INTO unsafe_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      pg_catalog.has_table_privilege(
        'r72_daily_outreach_command', relation.oid, 'SELECT'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_command', relation.oid, 'INSERT'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_command', relation.oid, 'UPDATE'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_command', relation.oid, 'DELETE'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_command', relation.oid, 'TRUNCATE'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_command', relation.oid, 'REFERENCES'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_command', relation.oid, 'TRIGGER'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_read', relation.oid, 'SELECT'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_read', relation.oid, 'INSERT'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_read', relation.oid, 'UPDATE'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_read', relation.oid, 'DELETE'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_read', relation.oid, 'TRUNCATE'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_read', relation.oid, 'REFERENCES'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_read', relation.oid, 'TRIGGER'
      ) OR pg_catalog.has_any_column_privilege(
        'r72_daily_outreach_command', relation.oid, 'SELECT'
      ) OR pg_catalog.has_any_column_privilege(
        'r72_daily_outreach_command', relation.oid, 'INSERT'
      ) OR pg_catalog.has_any_column_privilege(
        'r72_daily_outreach_command', relation.oid, 'UPDATE'
      ) OR pg_catalog.has_any_column_privilege(
        'r72_daily_outreach_command', relation.oid, 'REFERENCES'
      ) OR pg_catalog.has_any_column_privilege(
        'r72_daily_outreach_read', relation.oid, 'SELECT'
      ) OR pg_catalog.has_any_column_privilege(
        'r72_daily_outreach_read', relation.oid, 'INSERT'
      ) OR pg_catalog.has_any_column_privilege(
        'r72_daily_outreach_read', relation.oid, 'UPDATE'
      ) OR pg_catalog.has_any_column_privilege(
        'r72_daily_outreach_read', relation.oid, 'REFERENCES'
      )
    )
  LIMIT 1;
  IF unsafe_object IS NOT NULL THEN
    RAISE EXCEPTION 'Daily Outreach login role has direct table capability: %',
      unsafe_object USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
    INTO unsafe_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind = 'S'
    AND (
      pg_catalog.has_sequence_privilege(
        'r72_daily_outreach_command', relation.oid, 'USAGE'
      ) OR pg_catalog.has_sequence_privilege(
        'r72_daily_outreach_command', relation.oid, 'SELECT'
      ) OR pg_catalog.has_sequence_privilege(
        'r72_daily_outreach_command', relation.oid, 'UPDATE'
      ) OR pg_catalog.has_sequence_privilege(
        'r72_daily_outreach_read', relation.oid, 'USAGE'
      ) OR pg_catalog.has_sequence_privilege(
        'r72_daily_outreach_read', relation.oid, 'SELECT'
      ) OR pg_catalog.has_sequence_privilege(
        'r72_daily_outreach_read', relation.oid, 'UPDATE'
      )
    )
  LIMIT 1;
  IF unsafe_object IS NOT NULL THEN
    RAISE EXCEPTION 'Daily Outreach login role has direct sequence capability: %',
      unsafe_object USING ERRCODE = '42501';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unsafe_function
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) AS privilege
  WHERE namespace.nspname = 'app_private'
    AND procedure.oid = ANY(definer_functions)
    AND privilege.grantee = 0
    AND privilege.privilege_type = 'EXECUTE'
  LIMIT 1;
  IF unsafe_function IS NOT NULL THEN
    RAISE EXCEPTION 'Daily Outreach function remains executable by PUBLIC: %',
      unsafe_function USING ERRCODE = '42501';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unexpected_acl
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND pg_catalog.has_function_privilege(
      'r72_daily_outreach_command', procedure.oid, 'EXECUTE'
    )
    AND NOT procedure.oid = ANY(command_functions)
  LIMIT 1;
  IF unexpected_acl IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Daily Outreach command function ACL: %',
      unexpected_acl USING ERRCODE = '42501';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unexpected_acl
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND pg_catalog.has_function_privilege(
      'r72_daily_outreach_read', procedure.oid, 'EXECUTE'
    )
    AND NOT procedure.oid = ANY(read_functions)
  LIMIT 1;
  IF unexpected_acl IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Daily Outreach read function ACL: %',
      unexpected_acl USING ERRCODE = '42501';
  END IF;

  FOREACH expected_oid IN ARRAY command_functions LOOP
    IF NOT pg_catalog.has_function_privilege(
      'r72_daily_outreach_command', expected_oid, 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'Daily Outreach command function grant is missing: %',
        expected_oid::regprocedure USING ERRCODE = '42501';
    END IF;
  END LOOP;
  FOREACH expected_oid IN ARRAY read_functions LOOP
    IF NOT pg_catalog.has_function_privilege(
      'r72_daily_outreach_read', expected_oid, 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'Daily Outreach read function grant is missing: %',
        expected_oid::regprocedure USING ERRCODE = '42501';
    END IF;
  END LOOP;

  SELECT procedure.oid::regprocedure::text INTO unsafe_function
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
  WHERE procedure.oid = ANY(owned_functions)
    AND (NOT procedure.prosecdef
      OR owner.rolname <> 'r72_daily_outreach_definer')
  LIMIT 1;
  IF unsafe_function IS NOT NULL THEN
    RAISE EXCEPTION 'Daily Outreach function owner/security is unsafe: %',
      unsafe_function USING ERRCODE = '42501';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unexpected_acl
  FROM pg_catalog.pg_proc AS procedure
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) AS privilege
  WHERE procedure.oid = ANY(owned_functions)
    AND privilege.privilege_type = 'EXECUTE'
    AND privilege.grantee <> procedure.proowner
    AND NOT (
      procedure.oid = ANY(command_functions)
      AND privilege.grantee = (
        SELECT oid FROM pg_catalog.pg_roles
        WHERE rolname = 'r72_daily_outreach_command'
      )
    )
    AND NOT (
      procedure.oid = ANY(read_functions)
      AND privilege.grantee = (
        SELECT oid FROM pg_catalog.pg_roles
        WHERE rolname = 'r72_daily_outreach_read'
      )
    )
  LIMIT 1;
  IF unexpected_acl IS NOT NULL THEN
    RAISE EXCEPTION 'Daily Outreach function has an unexpected grantee: %',
      unexpected_acl USING ERRCODE = '42501';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unsafe_function
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND pg_catalog.has_function_privilege(
      'r72_daily_outreach_definer', procedure.oid, 'EXECUTE'
    )
    AND NOT procedure.oid = ANY(definer_functions)
  LIMIT 1;
  IF unsafe_function IS NOT NULL THEN
    RAISE EXCEPTION 'Daily Outreach definer has unexpected executable capability: %',
      unsafe_function USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.format('%I<-%I', granted.rolname, member.rolname)
    INTO unsafe_membership
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  WHERE granted.rolname IN (
    'r72_daily_outreach_definer',
    'r72_daily_outreach_command',
    'r72_daily_outreach_read'
  )
    AND NOT (
      (
        granted.rolname = 'r72_daily_outreach_definer'
        AND member.rolname = 'r72_owner'
        AND NOT membership.admin_option
        AND coalesce(
          (pg_catalog.to_jsonb(membership)->>'set_option')::boolean,
          true
        ) IS TRUE
      )
      OR (
        -- PostgreSQL 16+ gives a non-superuser CREATEROLE session an
        -- unavoidable bootstrap grant on every role it creates. Neon exposes
        -- that grant as ADMIN TRUE, INHERIT FALSE, SET FALSE: it can administer
        -- the role but cannot assume its privileges. Accept only that exact
        -- non-effective tuple for the migration session. The managed platform
        -- may record its bootstrap administrator, rather than the session, as
        -- grantor.
        member.rolname = session_user
        AND membership.admin_option
        AND NOT membership.inherit_option
        AND coalesce(
          (pg_catalog.to_jsonb(membership)->>'set_option')::boolean,
          true
        ) IS NOT TRUE
      )
    )
  LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Daily Outreach role has unsafe inbound membership: %',
      unsafe_membership USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_has_role(
    'r72_owner', 'r72_daily_outreach_definer', 'MEMBER'
  ) THEN
    RAISE EXCEPTION 'Daily Outreach definer owner membership is missing'
      USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.format('%I->%I', member.rolname, granted.rolname)
    INTO unsafe_membership
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  WHERE member.rolname IN (
    'r72_daily_outreach_definer',
    'r72_daily_outreach_command',
    'r72_daily_outreach_read'
  )
  LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Daily Outreach role has unsafe outbound membership: %',
      unsafe_membership USING ERRCODE = '42501';
  END IF;

  IF pg_catalog.has_table_privilege(
       'r72_daily_outreach_definer', 'app.provider_operations', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_daily_outreach_definer', 'app.provider_operations', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_daily_outreach_definer', 'app.provider_operations', 'DELETE'
     )
     OR pg_catalog.has_any_column_privilege(
       'r72_daily_outreach_definer', 'app.provider_operations', 'INSERT'
     )
     OR pg_catalog.has_any_column_privilege(
       'r72_daily_outreach_definer', 'app.provider_operations', 'UPDATE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_daily_outreach_command', 'app_private', 'CREATE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_daily_outreach_read', 'app_private', 'CREATE'
     ) THEN
    RAISE EXCEPTION 'Daily Outreach gained provider-effect capability'
      USING ERRCODE = '42501';
  END IF;
END
$capability_audit$;

RESET ROLE;
