-- Property Predator Daily Outreach: controlled message-family and Creator
-- Watch evidence. This migration stores only identifiers, references, hashes,
-- structured classifications and bounded timestamps. It creates no provider
-- operation, send queue, scraped profile/post store, credential surface or
-- autonomous-comment capability.

DO $role_integrity$
DECLARE
  role_name text;
  expected_login boolean;
  unsafe_parent text;
  unsafe_member text;
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
      SELECT 1
      FROM pg_catalog.pg_roles
      WHERE rolname = role_name
        AND rolcanlogin = expected_login
        AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
    ) THEN
      RAISE EXCEPTION 'Unsafe Daily Outreach role attributes in 0091: %',
        role_name USING ERRCODE = '42501';
    END IF;

    SELECT parent.rolname INTO unsafe_parent
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
    JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
    WHERE member.rolname = role_name
    LIMIT 1;
    IF unsafe_parent IS NOT NULL THEN
      RAISE EXCEPTION 'Unsafe Daily Outreach role membership in 0091: % -> %',
        role_name, unsafe_parent USING ERRCODE = '42501';
    END IF;

    SELECT member.rolname INTO unsafe_member
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
    JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
    WHERE parent.rolname = role_name
      AND NOT (
        role_name = 'r72_daily_outreach_definer'
        AND member.rolname = 'r72_owner'
      )
    LIMIT 1;
    IF unsafe_member IS NOT NULL THEN
      RAISE EXCEPTION 'Unsafe inbound Daily Outreach role grant in 0091: % -> %',
        unsafe_member, role_name USING ERRCODE = '42501';
    END IF;
  END LOOP;
END
$role_integrity$;

SET LOCAL ROLE r72_owner;

CREATE TABLE app_private.daily_outreach_message_family_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  programme_version_id uuid NOT NULL,
  family_key text NOT NULL CHECK (
    family_key = lower(btrim(family_key))
    AND family_key ~ '^[a-z][a-z0-9_.-]{0,99}$'
  ),
  version_number integer NOT NULL CHECK (version_number > 0),
  previous_version_id uuid,
  channel text NOT NULL CHECK (
    channel IN ('linkedin', 'instagram', 'other_social')
  ),
  purpose text NOT NULL CHECK (purpose IN (
    'cold_first_touch', 'reply_follow_up', 'authority_comment',
    'comment_to_dm'
  )),
  laps_stage text NOT NULL CHECK (
    laps_stage IN ('prospect', 'lead', 'pitch', 'appointment')
  ),
  audience_segment_key text NOT NULL CHECK (
    audience_segment_key = lower(btrim(audience_segment_key))
    AND audience_segment_key ~ '^[a-z][a-z0-9_.-]{0,99}$'
  ),
  next_action text NOT NULL CHECK (next_action IN (
    'open_conversation', 'reply', 'book_call', 'visit_demo', 'download'
  )),
  allowed_context_fields text[] NOT NULL CHECK (
    cardinality(allowed_context_fields) BETWEEN 1 AND 6
    AND array_position(allowed_context_fields, NULL) IS NULL
    AND allowed_context_fields <@ ARRAY[
      'post_topic', 'role', 'company', 'observed_problem',
      'relationship_context', 'campaign_context'
    ]::text[]
  ),
  tone_variant text NOT NULL CHECK (tone_variant IN (
    'founder_direct', 'helpful_expert', 'curious_peer', 'evidence_led'
  )),
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  cooldown_seconds integer NOT NULL
    CHECK (cooldown_seconds BETWEEN 3600 AND 7776000),
  max_per_creator_per_utc_day smallint NOT NULL
    CHECK (max_per_creator_per_utc_day BETWEEN 1 AND 10),
  max_per_channel_per_utc_day smallint NOT NULL
    CHECK (max_per_channel_per_utc_day BETWEEN 1 AND 250),
  max_per_creator_rolling_7_days smallint NOT NULL
    CHECK (max_per_creator_rolling_7_days BETWEEN 1 AND 50),
  configuration_sha256 bytea NOT NULL
    CHECK (octet_length(configuration_sha256) = 32),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  review_mode text NOT NULL DEFAULT 'one_tap_review'
    CHECK (review_mode = 'one_tap_review'),
  requires_human_approval boolean NOT NULL DEFAULT true
    CHECK (requires_human_approval IS TRUE),
  autonomous_comment_enabled boolean NOT NULL DEFAULT false
    CHECK (autonomous_comment_enabled IS FALSE),
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
  UNIQUE (workspace_id, family_key, id),
  UNIQUE (workspace_id, id, channel, purpose),
  UNIQUE (workspace_id, family_key, version_number),
  UNIQUE (workspace_id, family_key, configuration_sha256),
  FOREIGN KEY (workspace_id, programme_version_id, channel)
    REFERENCES app_private.daily_outreach_programme_versions
      (workspace_id, id, channel) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, family_key, previous_version_id)
    REFERENCES app_private.daily_outreach_message_family_versions
      (workspace_id, family_key, id) ON DELETE RESTRICT,
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
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK ((version_number = 1) = (previous_version_id IS NULL)),
  CHECK (max_per_creator_per_utc_day <= max_per_creator_rolling_7_days),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE UNIQUE INDEX daily_outreach_message_family_one_root
  ON app_private.daily_outreach_message_family_versions
    (workspace_id, family_key)
  WHERE previous_version_id IS NULL;
CREATE UNIQUE INDEX daily_outreach_message_family_one_child
  ON app_private.daily_outreach_message_family_versions
    (workspace_id, family_key, previous_version_id)
  WHERE previous_version_id IS NOT NULL;

CREATE TABLE app_private.daily_outreach_creator_watch_subject_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  subject_key text NOT NULL CHECK (
    subject_key = lower(btrim(subject_key))
    AND subject_key ~ '^[a-z][a-z0-9_.-]{0,99}$'
  ),
  version_number integer NOT NULL CHECK (version_number > 0),
  previous_version_id uuid,
  network text NOT NULL CHECK (network IN ('linkedin', 'instagram')),
  provider_subject_ref_sha256 bytea NOT NULL
    CHECK (octet_length(provider_subject_ref_sha256) = 32),
  source_adapter text NOT NULL CHECK (
    source_adapter IN ('founder_watchlist', 'manual')
  ),
  provenance_sha256 bytea NOT NULL
    CHECK (octet_length(provenance_sha256) = 32),
  status text NOT NULL CHECK (status IN (
    'active_review', 'paused', 'retired'
  )),
  minimum_comment_interval_seconds integer NOT NULL
    CHECK (minimum_comment_interval_seconds BETWEEN 3600 AND 7776000),
  max_comments_per_utc_day smallint NOT NULL
    CHECK (max_comments_per_utc_day BETWEEN 1 AND 10),
  max_comments_rolling_7_days smallint NOT NULL
    CHECK (max_comments_rolling_7_days BETWEEN 1 AND 50),
  observation_ttl_seconds integer NOT NULL
    CHECK (observation_ttl_seconds BETWEEN 300 AND 604800),
  configuration_sha256 bytea NOT NULL
    CHECK (octet_length(configuration_sha256) = 32),
  review_mode text NOT NULL DEFAULT 'one_tap_review'
    CHECK (review_mode = 'one_tap_review'),
  autonomous_comment_enabled boolean NOT NULL DEFAULT false
    CHECK (autonomous_comment_enabled IS FALSE),
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
  UNIQUE (workspace_id, subject_key, id),
  UNIQUE (workspace_id, id, network),
  UNIQUE (workspace_id, subject_key, version_number),
  UNIQUE (workspace_id, subject_key, configuration_sha256),
  FOREIGN KEY (workspace_id, subject_key, previous_version_id)
    REFERENCES app_private.daily_outreach_creator_watch_subject_versions
      (workspace_id, subject_key, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK ((version_number = 1) = (previous_version_id IS NULL)),
  CHECK (max_comments_per_utc_day <= max_comments_rolling_7_days)
);

CREATE UNIQUE INDEX daily_outreach_creator_subject_one_root
  ON app_private.daily_outreach_creator_watch_subject_versions
    (workspace_id, subject_key)
  WHERE previous_version_id IS NULL;
CREATE UNIQUE INDEX daily_outreach_creator_subject_one_child
  ON app_private.daily_outreach_creator_watch_subject_versions
    (workspace_id, subject_key, previous_version_id)
  WHERE previous_version_id IS NOT NULL;

CREATE TABLE app_private.daily_outreach_creator_watch_observed_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  command_key_sha256 bytea NOT NULL
    CHECK (octet_length(command_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  subject_version_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('linkedin', 'instagram')),
  source_kind text NOT NULL CHECK (
    source_kind IN ('official_provider_event', 'operator_supplied_reference')
  ),
  provider_post_ref_sha256 bytea NOT NULL
    CHECK (octet_length(provider_post_ref_sha256) = 32),
  source_reference_sha256 bytea NOT NULL
    CHECK (octet_length(source_reference_sha256) = 32),
  post_content_sha256 bytea NOT NULL
    CHECK (octet_length(post_content_sha256) = 32),
  observation_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(observation_evidence_sha256) = 32),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  raw_content_stored boolean NOT NULL DEFAULT false
    CHECK (raw_content_stored IS FALSE),
  provider_effects_enabled boolean NOT NULL DEFAULT false
    CHECK (provider_effects_enabled IS FALSE),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
    AND recorded_request_id !~ '[^[:graph:]]'
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  UNIQUE (workspace_id, subject_version_id, provider_post_ref_sha256),
  UNIQUE (workspace_id, id, subject_version_id, network),
  FOREIGN KEY (workspace_id, subject_version_id, network)
    REFERENCES app_private.daily_outreach_creator_watch_subject_versions
      (workspace_id, id, network) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (observed_at <= recorded_at + interval '30 seconds'),
  CHECK (observed_at >= recorded_at - interval '7 days'),
  CHECK (expires_at > observed_at)
);

CREATE INDEX daily_outreach_creator_posts_review_idx
  ON app_private.daily_outreach_creator_watch_observed_posts
    (workspace_id, expires_at, observed_at DESC, id);

CREATE TABLE app_private.daily_outreach_creator_watch_relevance_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  command_key_sha256 bytea NOT NULL
    CHECK (octet_length(command_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  observed_post_id uuid NOT NULL,
  subject_version_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('linkedin', 'instagram')),
  previous_decision_id uuid,
  decision text NOT NULL CHECK (decision IN ('comment', 'no_comment')),
  comment_purpose text CHECK (comment_purpose IN (
    'add_useful_evidence', 'extend_the_idea', 'ask_sharp_question',
    'offer_counterpoint', 'open_genuine_conversation'
  )),
  no_comment_reason text CHECK (no_comment_reason IN (
    'irrelevant', 'insufficient_context', 'no_useful_contribution',
    'cooldown_active', 'frequency_cap', 'stale_evidence',
    'subject_paused', 'unsupported_action', 'policy_blocked'
  )),
  decision_source text NOT NULL CHECK (
    decision_source IN ('human_review', 'brand_brain_assist')
  ),
  grounding_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(grounding_evidence_sha256) = 32),
  decision_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(decision_evidence_sha256) = 32),
  review_mode text NOT NULL DEFAULT 'one_tap_review'
    CHECK (review_mode = 'one_tap_review'),
  requires_human_approval boolean NOT NULL DEFAULT true
    CHECK (requires_human_approval IS TRUE),
  autonomous_comment_enabled boolean NOT NULL DEFAULT false
    CHECK (autonomous_comment_enabled IS FALSE),
  provider_effects_enabled boolean NOT NULL DEFAULT false
    CHECK (provider_effects_enabled IS FALSE),
  decided_by_user_id uuid NOT NULL,
  decided_request_id text NOT NULL CHECK (
    decided_request_id = btrim(decided_request_id)
    AND length(decided_request_id) BETWEEN 1 AND 128
    AND decided_request_id !~ '[^[:graph:]]'
  ),
  decided_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, observed_post_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  UNIQUE (workspace_id, id, observed_post_id, subject_version_id, network),
  UNIQUE (workspace_id, observed_post_id, previous_decision_id),
  FOREIGN KEY (
    workspace_id, observed_post_id, subject_version_id, network
  ) REFERENCES app_private.daily_outreach_creator_watch_observed_posts (
    workspace_id, id, subject_version_id, network
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, observed_post_id, previous_decision_id)
    REFERENCES app_private.daily_outreach_creator_watch_relevance_decisions
      (workspace_id, observed_post_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, decided_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (
    (decision = 'comment'
      AND comment_purpose IS NOT NULL AND no_comment_reason IS NULL)
    OR
    (decision = 'no_comment'
      AND comment_purpose IS NULL AND no_comment_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX daily_outreach_creator_decision_one_root
  ON app_private.daily_outreach_creator_watch_relevance_decisions
    (workspace_id, observed_post_id)
  WHERE previous_decision_id IS NULL;
CREATE UNIQUE INDEX daily_outreach_creator_decision_one_child
  ON app_private.daily_outreach_creator_watch_relevance_decisions
    (workspace_id, observed_post_id, previous_decision_id)
  WHERE previous_decision_id IS NOT NULL;

CREATE TABLE app_private.daily_outreach_creator_watch_comment_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  command_key_sha256 bytea NOT NULL
    CHECK (octet_length(command_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  observed_post_id uuid NOT NULL,
  subject_version_id uuid NOT NULL,
  relevance_decision_id uuid NOT NULL,
  message_family_version_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('linkedin', 'instagram')),
  purpose text NOT NULL DEFAULT 'authority_comment'
    CHECK (purpose = 'authority_comment'),
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  assignment_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(assignment_evidence_sha256) = 32),
  review_mode text NOT NULL DEFAULT 'one_tap_review'
    CHECK (review_mode = 'one_tap_review'),
  effect_state text NOT NULL DEFAULT 'review_only'
    CHECK (effect_state = 'review_only'),
  requires_human_approval boolean NOT NULL DEFAULT true
    CHECK (requires_human_approval IS TRUE),
  autonomous_comment_enabled boolean NOT NULL DEFAULT false
    CHECK (autonomous_comment_enabled IS FALSE),
  provider_effects_enabled boolean NOT NULL DEFAULT false
    CHECK (provider_effects_enabled IS FALSE),
  assigned_by_user_id uuid NOT NULL,
  assigned_request_id text NOT NULL CHECK (
    assigned_request_id = btrim(assigned_request_id)
    AND length(assigned_request_id) BETWEEN 1 AND 128
    AND assigned_request_id !~ '[^[:graph:]]'
  ),
  assigned_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  cooldown_until timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_key_sha256),
  UNIQUE (workspace_id, observed_post_id),
  FOREIGN KEY (
    workspace_id, observed_post_id, subject_version_id, network
  ) REFERENCES app_private.daily_outreach_creator_watch_observed_posts (
    workspace_id, id, subject_version_id, network
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, relevance_decision_id, observed_post_id,
    subject_version_id, network
  ) REFERENCES app_private.daily_outreach_creator_watch_relevance_decisions (
    workspace_id, id, observed_post_id, subject_version_id, network
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_family_version_id, network, purpose)
    REFERENCES app_private.daily_outreach_message_family_versions
      (workspace_id, id, channel, purpose) ON DELETE RESTRICT,
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
    ON DELETE RESTRICT,
  CHECK (cooldown_until > assigned_at)
);

CREATE INDEX daily_outreach_creator_assignment_frequency_idx
  ON app_private.daily_outreach_creator_watch_comment_assignments
    (workspace_id, subject_version_id, network, assigned_at DESC, id);

ALTER TABLE app_private.daily_outreach_message_family_versions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_message_family_versions
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_creator_watch_subject_versions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_creator_watch_subject_versions
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_creator_watch_observed_posts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_creator_watch_observed_posts
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_creator_watch_relevance_decisions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_creator_watch_relevance_decisions
  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_creator_watch_comment_assignments
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.daily_outreach_creator_watch_comment_assignments
  FORCE ROW LEVEL SECURITY;

CREATE POLICY creator_message_family_owner_all
  ON app_private.daily_outreach_message_family_versions
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY creator_subject_owner_all
  ON app_private.daily_outreach_creator_watch_subject_versions
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY creator_post_owner_all
  ON app_private.daily_outreach_creator_watch_observed_posts
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY creator_decision_owner_all
  ON app_private.daily_outreach_creator_watch_relevance_decisions
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY creator_assignment_owner_all
  ON app_private.daily_outreach_creator_watch_comment_assignments
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);

CREATE POLICY creator_message_family_definer_select
  ON app_private.daily_outreach_message_family_versions
  FOR SELECT TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY creator_message_family_definer_insert
  ON app_private.daily_outreach_message_family_versions
  FOR INSERT TO r72_daily_outreach_definer
  WITH CHECK (workspace_id = app_private.current_workspace_id());
CREATE POLICY creator_subject_definer_select
  ON app_private.daily_outreach_creator_watch_subject_versions
  FOR SELECT TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY creator_subject_definer_insert
  ON app_private.daily_outreach_creator_watch_subject_versions
  FOR INSERT TO r72_daily_outreach_definer
  WITH CHECK (workspace_id = app_private.current_workspace_id());
CREATE POLICY creator_post_definer_select
  ON app_private.daily_outreach_creator_watch_observed_posts
  FOR SELECT TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY creator_post_definer_insert
  ON app_private.daily_outreach_creator_watch_observed_posts
  FOR INSERT TO r72_daily_outreach_definer
  WITH CHECK (workspace_id = app_private.current_workspace_id());
CREATE POLICY creator_decision_definer_select
  ON app_private.daily_outreach_creator_watch_relevance_decisions
  FOR SELECT TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY creator_decision_definer_insert
  ON app_private.daily_outreach_creator_watch_relevance_decisions
  FOR INSERT TO r72_daily_outreach_definer
  WITH CHECK (workspace_id = app_private.current_workspace_id());
CREATE POLICY creator_assignment_definer_select
  ON app_private.daily_outreach_creator_watch_comment_assignments
  FOR SELECT TO r72_daily_outreach_definer
  USING (workspace_id = app_private.current_workspace_id());
CREATE POLICY creator_assignment_definer_insert
  ON app_private.daily_outreach_creator_watch_comment_assignments
  FOR INSERT TO r72_daily_outreach_definer
  WITH CHECK (workspace_id = app_private.current_workspace_id());

GRANT SELECT, INSERT ON
  app_private.daily_outreach_message_family_versions,
  app_private.daily_outreach_creator_watch_subject_versions,
  app_private.daily_outreach_creator_watch_observed_posts,
  app_private.daily_outreach_creator_watch_relevance_decisions,
  app_private.daily_outreach_creator_watch_comment_assignments
TO r72_daily_outreach_definer;

CREATE FUNCTION app_private.reject_creator_watch_mutation()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Creator Watch evidence is append-only'
    USING ERRCODE = '42501';
END
$function$;
REVOKE ALL ON FUNCTION app_private.reject_creator_watch_mutation()
  FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read,
    r72_daily_outreach_definer;

CREATE TRIGGER daily_outreach_message_family_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_message_family_versions
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_creator_watch_mutation();
CREATE TRIGGER daily_outreach_creator_subject_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_creator_watch_subject_versions
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_creator_watch_mutation();
CREATE TRIGGER daily_outreach_creator_post_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_creator_watch_observed_posts
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_creator_watch_mutation();
CREATE TRIGGER daily_outreach_creator_decision_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_creator_watch_relevance_decisions
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_creator_watch_mutation();
CREATE TRIGGER daily_outreach_creator_assignment_immutable
  BEFORE UPDATE OR DELETE
  ON app_private.daily_outreach_creator_watch_comment_assignments
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_creator_watch_mutation();

INSERT INTO app_private.workspace_table_registry (
  schema_name, table_name, workspace_column
) VALUES
  ('app_private', 'daily_outreach_message_family_versions', 'workspace_id'),
  ('app_private', 'daily_outreach_creator_watch_subject_versions', 'workspace_id'),
  ('app_private', 'daily_outreach_creator_watch_observed_posts', 'workspace_id'),
  ('app_private', 'daily_outreach_creator_watch_relevance_decisions', 'workspace_id'),
  ('app_private', 'daily_outreach_creator_watch_comment_assignments', 'workspace_id');

GRANT CREATE ON SCHEMA app_private TO r72_daily_outreach_definer;
SET LOCAL ROLE r72_daily_outreach_definer;

CREATE FUNCTION app_private.assert_current_approved_creator_content(
  p_workspace_id uuid,
  p_content_item_id uuid,
  p_content_version_id uuid,
  p_content_sha256 bytea,
  p_approval_request_id uuid,
  p_approval_decision_id uuid
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_version_number integer;
  selected_request_number integer;
  selected_decision_id uuid;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'company-content:' || p_workspace_id::text || ':'
        || p_content_item_id::text,
      7200021
    )
  );
  SELECT version.version_number INTO selected_version_number
  FROM app.company_content_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.content_item_id = p_content_item_id
    AND version.id = p_content_version_id
    AND version.content_sha256 = p_content_sha256
    AND version.content_kind = 'social_post';
  IF selected_version_number IS NULL OR EXISTS (
    SELECT 1
    FROM app.company_content_versions AS newer
    WHERE newer.workspace_id = p_workspace_id
      AND newer.content_item_id = p_content_item_id
      AND newer.version_number > selected_version_number
  ) THEN
    RAISE EXCEPTION 'Creator Watch content version is missing or stale'
      USING ERRCODE = '55000';
  END IF;

  SELECT request.request_number INTO selected_request_number
  FROM app.company_content_approval_requests AS request
  WHERE request.workspace_id = p_workspace_id
    AND request.content_item_id = p_content_item_id
    AND request.content_version_id = p_content_version_id
    AND request.id = p_approval_request_id
    AND request.content_sha256 = p_content_sha256;
  IF selected_request_number IS NULL OR EXISTS (
    SELECT 1
    FROM app.company_content_approval_requests AS later_request
    WHERE later_request.workspace_id = p_workspace_id
      AND later_request.content_item_id = p_content_item_id
      AND later_request.content_version_id = p_content_version_id
      AND later_request.request_number > selected_request_number
  ) THEN
    RAISE EXCEPTION 'Creator Watch approval request is missing or stale'
      USING ERRCODE = '55000';
  END IF;

  SELECT decision.id INTO selected_decision_id
  FROM app.company_content_approval_decisions AS decision
  WHERE decision.workspace_id = p_workspace_id
    AND decision.id = p_approval_decision_id
    AND decision.content_item_id = p_content_item_id
    AND decision.content_version_id = p_content_version_id
    AND decision.approval_request_id = p_approval_request_id
    AND decision.content_sha256 = p_content_sha256
    AND decision.decision = 'approved';
  IF selected_decision_id IS NULL THEN
    RAISE EXCEPTION 'Creator Watch content lacks exact current approval'
      USING ERRCODE = '55000';
  END IF;
END
$function$;

CREATE FUNCTION app_private.publish_daily_outreach_message_family_version(
  p_workspace_id uuid,
  p_programme_version_id uuid,
  p_family_key text,
  p_version_number integer,
  p_previous_version_id uuid,
  p_purpose text,
  p_laps_stage text,
  p_audience_segment_key text,
  p_next_action text,
  p_allowed_context_fields text[],
  p_tone_variant text,
  p_content_item_id uuid,
  p_content_version_id uuid,
  p_content_sha256 bytea,
  p_approval_request_id uuid,
  p_approval_decision_id uuid,
  p_cooldown_seconds integer,
  p_max_per_creator_per_utc_day smallint,
  p_max_per_channel_per_utc_day smallint,
  p_max_per_creator_rolling_7_days smallint,
  p_configuration_sha256 bytea,
  p_effective_from timestamptz,
  p_effective_until timestamptz
)
RETURNS TABLE (disposition text, message_family_version_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  programme app_private.daily_outreach_programme_versions%ROWTYPE;
  previous_row app_private.daily_outreach_message_family_versions%ROWTYPE;
  existing_row app_private.daily_outreach_message_family_versions%ROWTYPE;
  selected_id uuid := gen_random_uuid();
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', true
  );
  IF p_family_key IS NULL
     OR p_family_key <> lower(btrim(p_family_key))
     OR p_family_key !~ '^[a-z][a-z0-9_.-]{0,99}$'
     OR p_version_number IS NULL OR p_version_number < 1
     OR p_purpose NOT IN (
       'cold_first_touch', 'reply_follow_up', 'authority_comment',
       'comment_to_dm'
     )
     OR p_laps_stage NOT IN ('prospect', 'lead', 'pitch', 'appointment')
     OR p_audience_segment_key IS NULL
     OR p_audience_segment_key <> lower(btrim(p_audience_segment_key))
     OR p_audience_segment_key !~ '^[a-z][a-z0-9_.-]{0,99}$'
     OR p_next_action NOT IN (
       'open_conversation', 'reply', 'book_call', 'visit_demo', 'download'
     )
     OR p_allowed_context_fields IS NULL
     OR cardinality(p_allowed_context_fields) NOT BETWEEN 1 AND 6
     OR array_position(p_allowed_context_fields, NULL) IS NOT NULL
     OR NOT p_allowed_context_fields <@ ARRAY[
       'post_topic', 'role', 'company', 'observed_problem',
       'relationship_context', 'campaign_context'
     ]::text[]
     OR p_tone_variant NOT IN (
       'founder_direct', 'helpful_expert', 'curious_peer', 'evidence_led'
     )
     OR p_content_sha256 IS NULL OR octet_length(p_content_sha256) <> 32
     OR p_cooldown_seconds IS NULL
     OR p_cooldown_seconds NOT BETWEEN 3600 AND 7776000
     OR p_max_per_creator_per_utc_day IS NULL
     OR p_max_per_creator_per_utc_day NOT BETWEEN 1 AND 10
     OR p_max_per_channel_per_utc_day IS NULL
     OR p_max_per_channel_per_utc_day NOT BETWEEN 1 AND 250
     OR p_max_per_creator_rolling_7_days IS NULL
     OR p_max_per_creator_rolling_7_days NOT BETWEEN
       p_max_per_creator_per_utc_day AND 50
     OR p_configuration_sha256 IS NULL
     OR octet_length(p_configuration_sha256) <> 32
     OR p_effective_from IS NULL
     OR (p_effective_until IS NOT NULL
       AND p_effective_until <= p_effective_from) THEN
    RAISE EXCEPTION 'Invalid Daily Outreach message-family version'
      USING ERRCODE = '22023';
  END IF;

  SELECT version.* INTO programme
  FROM app_private.daily_outreach_programme_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_programme_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Outreach programme version not found for family'
      USING ERRCODE = '23503';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-message-family:' || p_workspace_id::text || ':'
        || p_family_key,
      0
    )
  );

  PERFORM app_private.assert_current_approved_creator_content(
    p_workspace_id, p_content_item_id, p_content_version_id,
    p_content_sha256, p_approval_request_id, p_approval_decision_id
  );

  SELECT family.* INTO existing_row
  FROM app_private.daily_outreach_message_family_versions AS family
  WHERE family.workspace_id = p_workspace_id
    AND family.family_key = p_family_key
    AND family.version_number = p_version_number;
  IF FOUND THEN
    IF existing_row.previous_version_id IS NOT DISTINCT FROM p_previous_version_id
       AND existing_row.programme_version_id = p_programme_version_id
       AND existing_row.channel = programme.channel
       AND existing_row.purpose = p_purpose
       AND existing_row.laps_stage = p_laps_stage
       AND existing_row.audience_segment_key = p_audience_segment_key
       AND existing_row.next_action = p_next_action
       AND existing_row.allowed_context_fields = p_allowed_context_fields
       AND existing_row.tone_variant = p_tone_variant
       AND existing_row.content_item_id = p_content_item_id
       AND existing_row.content_version_id = p_content_version_id
       AND existing_row.content_sha256 = p_content_sha256
       AND existing_row.approval_request_id = p_approval_request_id
       AND existing_row.approval_decision_id = p_approval_decision_id
       AND existing_row.cooldown_seconds = p_cooldown_seconds
       AND existing_row.max_per_creator_per_utc_day
         = p_max_per_creator_per_utc_day
       AND existing_row.max_per_channel_per_utc_day
         = p_max_per_channel_per_utc_day
       AND existing_row.max_per_creator_rolling_7_days
         = p_max_per_creator_rolling_7_days
       AND existing_row.configuration_sha256 = p_configuration_sha256
       AND existing_row.effective_from = p_effective_from
       AND existing_row.effective_until IS NOT DISTINCT FROM p_effective_until THEN
      RETURN QUERY SELECT 'replayed'::text, existing_row.id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Daily Outreach message-family version conflict'
      USING ERRCODE = '23505';
  END IF;

  IF p_version_number = 1 THEN
    IF p_previous_version_id IS NOT NULL OR EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_message_family_versions AS family
      WHERE family.workspace_id = p_workspace_id
        AND family.family_key = p_family_key
    ) THEN
      RAISE EXCEPTION 'Invalid Daily Outreach message-family root'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT family.* INTO previous_row
    FROM app_private.daily_outreach_message_family_versions AS family
    WHERE family.workspace_id = p_workspace_id
      AND family.family_key = p_family_key
      AND family.id = p_previous_version_id;
    IF NOT FOUND
       OR previous_row.version_number <> p_version_number - 1
       OR previous_row.programme_version_id <> p_programme_version_id
       OR previous_row.channel <> programme.channel
       OR EXISTS (
         SELECT 1
         FROM app_private.daily_outreach_message_family_versions AS child
         WHERE child.workspace_id = p_workspace_id
           AND child.family_key = p_family_key
           AND child.previous_version_id = p_previous_version_id
       ) THEN
      RAISE EXCEPTION 'Non-linear Daily Outreach message-family version'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO app_private.daily_outreach_message_family_versions (
    id, workspace_id, programme_version_id, family_key, version_number,
    previous_version_id, channel, purpose, laps_stage,
    audience_segment_key, next_action, allowed_context_fields, tone_variant,
    content_item_id, content_version_id, content_sha256,
    approval_request_id, approval_decision_id, cooldown_seconds,
    max_per_creator_per_utc_day, max_per_channel_per_utc_day,
    max_per_creator_rolling_7_days, configuration_sha256,
    effective_from, effective_until, created_by_user_id, created_request_id
  ) VALUES (
    selected_id, p_workspace_id, p_programme_version_id, p_family_key,
    p_version_number, p_previous_version_id, programme.channel, p_purpose,
    p_laps_stage, p_audience_segment_key, p_next_action,
    p_allowed_context_fields, p_tone_variant, p_content_item_id,
    p_content_version_id, p_content_sha256, p_approval_request_id,
    p_approval_decision_id, p_cooldown_seconds,
    p_max_per_creator_per_utc_day, p_max_per_channel_per_utc_day,
    p_max_per_creator_rolling_7_days, p_configuration_sha256,
    p_effective_from, p_effective_until, trusted_user_id, trusted_request_id
  );
  RETURN QUERY SELECT 'recorded'::text, selected_id;
END
$function$;

CREATE FUNCTION app_private.publish_daily_outreach_creator_watch_subject_version(
  p_workspace_id uuid,
  p_subject_key text,
  p_version_number integer,
  p_previous_version_id uuid,
  p_network text,
  p_provider_subject_ref_sha256 bytea,
  p_source_adapter text,
  p_provenance_sha256 bytea,
  p_status text,
  p_minimum_comment_interval_seconds integer,
  p_max_comments_per_utc_day smallint,
  p_max_comments_rolling_7_days smallint,
  p_observation_ttl_seconds integer,
  p_configuration_sha256 bytea
)
RETURNS TABLE (disposition text, subject_version_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  previous_row app_private.daily_outreach_creator_watch_subject_versions%ROWTYPE;
  existing_row app_private.daily_outreach_creator_watch_subject_versions%ROWTYPE;
  selected_id uuid := gen_random_uuid();
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', true
  );
  IF p_subject_key IS NULL
     OR p_subject_key <> lower(btrim(p_subject_key))
     OR p_subject_key !~ '^[a-z][a-z0-9_.-]{0,99}$'
     OR p_version_number IS NULL OR p_version_number < 1
     OR p_network NOT IN ('linkedin', 'instagram')
     OR p_provider_subject_ref_sha256 IS NULL
     OR octet_length(p_provider_subject_ref_sha256) <> 32
     OR p_source_adapter NOT IN ('founder_watchlist', 'manual')
     OR p_provenance_sha256 IS NULL
     OR octet_length(p_provenance_sha256) <> 32
     OR p_status NOT IN ('active_review', 'paused', 'retired')
     OR p_minimum_comment_interval_seconds IS NULL
     OR p_minimum_comment_interval_seconds NOT BETWEEN 3600 AND 7776000
     OR p_max_comments_per_utc_day IS NULL
     OR p_max_comments_per_utc_day NOT BETWEEN 1 AND 10
     OR p_max_comments_rolling_7_days IS NULL
     OR p_max_comments_rolling_7_days NOT BETWEEN
       p_max_comments_per_utc_day AND 50
     OR p_observation_ttl_seconds IS NULL
     OR p_observation_ttl_seconds NOT BETWEEN 300 AND 604800
     OR p_configuration_sha256 IS NULL
     OR octet_length(p_configuration_sha256) <> 32 THEN
    RAISE EXCEPTION 'Invalid Creator Watch subject version'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-creator-subject:' || p_workspace_id::text || ':'
        || p_subject_key,
      0
    )
  );

  SELECT subject.* INTO existing_row
  FROM app_private.daily_outreach_creator_watch_subject_versions AS subject
  WHERE subject.workspace_id = p_workspace_id
    AND subject.subject_key = p_subject_key
    AND subject.version_number = p_version_number;
  IF FOUND THEN
    IF existing_row.previous_version_id IS NOT DISTINCT FROM p_previous_version_id
       AND existing_row.network = p_network
       AND existing_row.provider_subject_ref_sha256
         = p_provider_subject_ref_sha256
       AND existing_row.source_adapter = p_source_adapter
       AND existing_row.provenance_sha256 = p_provenance_sha256
       AND existing_row.status = p_status
       AND existing_row.minimum_comment_interval_seconds
         = p_minimum_comment_interval_seconds
       AND existing_row.max_comments_per_utc_day
         = p_max_comments_per_utc_day
       AND existing_row.max_comments_rolling_7_days
         = p_max_comments_rolling_7_days
       AND existing_row.observation_ttl_seconds = p_observation_ttl_seconds
       AND existing_row.configuration_sha256 = p_configuration_sha256 THEN
      RETURN QUERY SELECT 'replayed'::text, existing_row.id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Creator Watch subject version conflict'
      USING ERRCODE = '23505';
  END IF;

  IF p_version_number = 1 THEN
    IF p_previous_version_id IS NOT NULL OR EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_creator_watch_subject_versions AS subject
      WHERE subject.workspace_id = p_workspace_id
        AND subject.subject_key = p_subject_key
    ) THEN
      RAISE EXCEPTION 'Invalid Creator Watch subject root'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT subject.* INTO previous_row
    FROM app_private.daily_outreach_creator_watch_subject_versions AS subject
    WHERE subject.workspace_id = p_workspace_id
      AND subject.subject_key = p_subject_key
      AND subject.id = p_previous_version_id;
    IF NOT FOUND
       OR previous_row.version_number <> p_version_number - 1
       OR previous_row.network <> p_network
       OR EXISTS (
         SELECT 1
         FROM app_private.daily_outreach_creator_watch_subject_versions AS child
         WHERE child.workspace_id = p_workspace_id
           AND child.subject_key = p_subject_key
           AND child.previous_version_id = p_previous_version_id
       ) THEN
      RAISE EXCEPTION 'Non-linear Creator Watch subject version'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO app_private.daily_outreach_creator_watch_subject_versions (
    id, workspace_id, subject_key, version_number, previous_version_id,
    network, provider_subject_ref_sha256, source_adapter, provenance_sha256,
    status, minimum_comment_interval_seconds, max_comments_per_utc_day,
    max_comments_rolling_7_days, observation_ttl_seconds,
    configuration_sha256, created_by_user_id, created_request_id
  ) VALUES (
    selected_id, p_workspace_id, p_subject_key, p_version_number,
    p_previous_version_id, p_network, p_provider_subject_ref_sha256,
    p_source_adapter, p_provenance_sha256, p_status,
    p_minimum_comment_interval_seconds, p_max_comments_per_utc_day,
    p_max_comments_rolling_7_days, p_observation_ttl_seconds,
    p_configuration_sha256, trusted_user_id, trusted_request_id
  );
  RETURN QUERY SELECT 'recorded'::text, selected_id;
END
$function$;

CREATE FUNCTION app_private.record_daily_outreach_creator_watch_post(
  p_workspace_id uuid,
  p_subject_version_id uuid,
  p_source_kind text,
  p_provider_post_ref_sha256 bytea,
  p_source_reference_sha256 bytea,
  p_post_content_sha256 bytea,
  p_observation_evidence_sha256 bytea,
  p_observed_at timestamptz,
  p_expires_at timestamptz,
  p_command_key_sha256 bytea
)
RETURNS TABLE (disposition text, observed_post_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  subject app_private.daily_outreach_creator_watch_subject_versions%ROWTYPE;
  existing_row app_private.daily_outreach_creator_watch_observed_posts%ROWTYPE;
  request_digest bytea;
  selected_id uuid := gen_random_uuid();
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', true
  );
  IF p_source_kind NOT IN (
       'official_provider_event', 'operator_supplied_reference'
     )
     OR p_provider_post_ref_sha256 IS NULL
     OR octet_length(p_provider_post_ref_sha256) <> 32
     OR p_source_reference_sha256 IS NULL
     OR octet_length(p_source_reference_sha256) <> 32
     OR p_post_content_sha256 IS NULL
     OR octet_length(p_post_content_sha256) <> 32
     OR p_observation_evidence_sha256 IS NULL
     OR octet_length(p_observation_evidence_sha256) <> 32
     OR p_observed_at IS NULL OR p_expires_at IS NULL
     OR p_observed_at > statement_timestamp() + interval '30 seconds'
     OR p_observed_at < statement_timestamp() - interval '7 days'
     OR p_expires_at <= statement_timestamp()
     OR p_command_key_sha256 IS NULL
     OR octet_length(p_command_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'Invalid Creator Watch observed-post evidence'
      USING ERRCODE = '22023';
  END IF;

  SELECT version.* INTO subject
  FROM app_private.daily_outreach_creator_watch_subject_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_subject_version_id;
  IF FOUND THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'daily-outreach-creator-subject:' || p_workspace_id::text || ':'
          || subject.subject_key,
        0
      )
    );
  END IF;
  IF NOT FOUND
     OR subject.status <> 'active_review'
     OR EXISTS (
       SELECT 1
       FROM app_private.daily_outreach_creator_watch_subject_versions AS newer
       WHERE newer.workspace_id = subject.workspace_id
         AND newer.subject_key = subject.subject_key
         AND newer.version_number > subject.version_number
     ) THEN
    RAISE EXCEPTION 'Creator Watch subject is missing, paused or stale'
      USING ERRCODE = '55000';
  END IF;
  IF p_expires_at > p_observed_at
       + pg_catalog.make_interval(secs => subject.observation_ttl_seconds) THEN
    RAISE EXCEPTION 'Creator Watch observation exceeds subject TTL'
      USING ERRCODE = '22023';
  END IF;

  request_digest := public.digest(pg_catalog.format(
    'propertypredator.creator-watch-post/v1|%s|%s|%s|%s|%s|%s|%s|%s|%s',
    p_workspace_id, p_subject_version_id, p_source_kind,
    pg_catalog.encode(p_provider_post_ref_sha256, 'hex'),
    pg_catalog.encode(p_source_reference_sha256, 'hex'),
    pg_catalog.encode(p_post_content_sha256, 'hex'),
    pg_catalog.encode(p_observation_evidence_sha256, 'hex'),
    p_observed_at, p_expires_at
  ), 'sha256');

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-creator-post:' || p_workspace_id::text || ':'
        || p_subject_version_id::text || ':'
        || pg_catalog.encode(p_provider_post_ref_sha256, 'hex'),
      0
    )
  );

  SELECT post.* INTO existing_row
  FROM app_private.daily_outreach_creator_watch_observed_posts AS post
  WHERE post.workspace_id = p_workspace_id
    AND post.command_key_sha256 = p_command_key_sha256;
  IF FOUND THEN
    IF existing_row.request_sha256 = request_digest THEN
      RETURN QUERY SELECT 'replayed'::text, existing_row.id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Creator Watch observed-post command conflict'
      USING ERRCODE = '23505';
  END IF;

  SELECT post.* INTO existing_row
  FROM app_private.daily_outreach_creator_watch_observed_posts AS post
  WHERE post.workspace_id = p_workspace_id
    AND post.subject_version_id = p_subject_version_id
    AND post.provider_post_ref_sha256 = p_provider_post_ref_sha256;
  IF FOUND THEN
    IF existing_row.source_kind = p_source_kind
       AND existing_row.source_reference_sha256 = p_source_reference_sha256
       AND existing_row.post_content_sha256 = p_post_content_sha256
       AND existing_row.observation_evidence_sha256
         = p_observation_evidence_sha256
       AND existing_row.observed_at = p_observed_at
       AND existing_row.expires_at = p_expires_at THEN
      RETURN QUERY SELECT 'existing'::text, existing_row.id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Creator Watch post identity conflicts with evidence'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO app_private.daily_outreach_creator_watch_observed_posts (
    id, workspace_id, command_key_sha256, request_sha256,
    subject_version_id, network, source_kind, provider_post_ref_sha256,
    source_reference_sha256, post_content_sha256,
    observation_evidence_sha256, observed_at, expires_at,
    recorded_by_user_id, recorded_request_id
  ) VALUES (
    selected_id, p_workspace_id, p_command_key_sha256, request_digest,
    p_subject_version_id, subject.network, p_source_kind,
    p_provider_post_ref_sha256, p_source_reference_sha256,
    p_post_content_sha256, p_observation_evidence_sha256,
    p_observed_at, p_expires_at, trusted_user_id, trusted_request_id
  );
  RETURN QUERY SELECT 'recorded'::text, selected_id;
END
$function$;

CREATE FUNCTION app_private.record_daily_outreach_creator_watch_relevance(
  p_workspace_id uuid,
  p_observed_post_id uuid,
  p_previous_decision_id uuid,
  p_decision text,
  p_comment_purpose text,
  p_no_comment_reason text,
  p_decision_source text,
  p_grounding_evidence_sha256 bytea,
  p_decision_evidence_sha256 bytea,
  p_command_key_sha256 bytea
)
RETURNS TABLE (disposition text, relevance_decision_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  post app_private.daily_outreach_creator_watch_observed_posts%ROWTYPE;
  subject app_private.daily_outreach_creator_watch_subject_versions%ROWTYPE;
  previous_row app_private.daily_outreach_creator_watch_relevance_decisions%ROWTYPE;
  existing_row app_private.daily_outreach_creator_watch_relevance_decisions%ROWTYPE;
  request_digest bytea;
  selected_id uuid := gen_random_uuid();
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', true
  );
  IF p_decision NOT IN ('comment', 'no_comment')
     OR p_decision_source NOT IN ('human_review', 'brand_brain_assist')
     OR p_grounding_evidence_sha256 IS NULL
     OR octet_length(p_grounding_evidence_sha256) <> 32
     OR p_decision_evidence_sha256 IS NULL
     OR octet_length(p_decision_evidence_sha256) <> 32
     OR p_command_key_sha256 IS NULL
     OR octet_length(p_command_key_sha256) <> 32
     OR (
       p_decision = 'comment' AND (
         p_comment_purpose IS NULL OR p_comment_purpose NOT IN (
           'add_useful_evidence', 'extend_the_idea', 'ask_sharp_question',
           'offer_counterpoint', 'open_genuine_conversation'
         ) OR p_no_comment_reason IS NOT NULL
       )
     )
     OR (
       p_decision = 'no_comment' AND (
         p_comment_purpose IS NOT NULL OR p_no_comment_reason IS NULL
         OR p_no_comment_reason NOT IN (
           'irrelevant', 'insufficient_context', 'no_useful_contribution',
           'cooldown_active', 'frequency_cap', 'stale_evidence',
           'subject_paused', 'unsupported_action', 'policy_blocked'
         )
       )
     ) THEN
    RAISE EXCEPTION 'Invalid Creator Watch relevance decision'
      USING ERRCODE = '22023';
  END IF;

  SELECT observed.* INTO post
  FROM app_private.daily_outreach_creator_watch_observed_posts AS observed
  WHERE observed.workspace_id = p_workspace_id
    AND observed.id = p_observed_post_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Creator Watch observed post not found'
      USING ERRCODE = '23503';
  END IF;
  SELECT version.* INTO subject
  FROM app_private.daily_outreach_creator_watch_subject_versions AS version
  WHERE version.workspace_id = post.workspace_id
    AND version.id = post.subject_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Creator Watch subject not found for post'
      USING ERRCODE = '23503';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-creator-subject:' || p_workspace_id::text || ':'
        || subject.subject_key,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-creator-decision:' || p_workspace_id::text || ':'
        || p_observed_post_id::text,
      0
    )
  );
  IF p_decision = 'comment' AND (
       post.expires_at <= statement_timestamp()
       OR subject.status <> 'active_review'
       OR EXISTS (
         SELECT 1
         FROM app_private.daily_outreach_creator_watch_subject_versions AS newer
         WHERE newer.workspace_id = subject.workspace_id
           AND newer.subject_key = subject.subject_key
           AND newer.version_number > subject.version_number
       )
     ) THEN
    RAISE EXCEPTION 'Creator Watch comment decision requires fresh active evidence'
      USING ERRCODE = '55000';
  END IF;

  request_digest := public.digest(pg_catalog.format(
    'propertypredator.creator-watch-relevance/v1|%s|%s|%s|%s|%s|%s|%s|%s|%s',
    p_workspace_id, p_observed_post_id, p_previous_decision_id,
    p_decision, p_comment_purpose, p_no_comment_reason, p_decision_source,
    pg_catalog.encode(p_grounding_evidence_sha256, 'hex'),
    pg_catalog.encode(p_decision_evidence_sha256, 'hex')
  ), 'sha256');

  SELECT decision.* INTO existing_row
  FROM app_private.daily_outreach_creator_watch_relevance_decisions AS decision
  WHERE decision.workspace_id = p_workspace_id
    AND decision.command_key_sha256 = p_command_key_sha256;
  IF FOUND THEN
    IF existing_row.request_sha256 = request_digest THEN
      RETURN QUERY SELECT 'replayed'::text, existing_row.id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Creator Watch relevance command conflict'
      USING ERRCODE = '23505';
  END IF;

  IF p_previous_decision_id IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_creator_watch_relevance_decisions AS decision
      WHERE decision.workspace_id = p_workspace_id
        AND decision.observed_post_id = p_observed_post_id
    ) THEN
      RAISE EXCEPTION 'Creator Watch relevance root already exists'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT decision.* INTO previous_row
    FROM app_private.daily_outreach_creator_watch_relevance_decisions AS decision
    WHERE decision.workspace_id = p_workspace_id
      AND decision.observed_post_id = p_observed_post_id
      AND decision.id = p_previous_decision_id;
    IF NOT FOUND
       OR EXISTS (
         SELECT 1
         FROM app_private.daily_outreach_creator_watch_relevance_decisions AS child
         WHERE child.workspace_id = p_workspace_id
           AND child.observed_post_id = p_observed_post_id
           AND child.previous_decision_id = p_previous_decision_id
       )
       OR EXISTS (
         SELECT 1
         FROM app_private.daily_outreach_creator_watch_comment_assignments AS assignment
         WHERE assignment.workspace_id = p_workspace_id
           AND assignment.relevance_decision_id = p_previous_decision_id
       ) THEN
      RAISE EXCEPTION 'Creator Watch relevance revision is not latest/unassigned'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO app_private.daily_outreach_creator_watch_relevance_decisions (
    id, workspace_id, command_key_sha256, request_sha256,
    observed_post_id, subject_version_id, network, previous_decision_id,
    decision, comment_purpose, no_comment_reason, decision_source,
    grounding_evidence_sha256, decision_evidence_sha256,
    decided_by_user_id, decided_request_id
  ) VALUES (
    selected_id, p_workspace_id, p_command_key_sha256, request_digest,
    post.id, post.subject_version_id, post.network, p_previous_decision_id,
    p_decision, p_comment_purpose, p_no_comment_reason, p_decision_source,
    p_grounding_evidence_sha256, p_decision_evidence_sha256,
    trusted_user_id, trusted_request_id
  );
  RETURN QUERY SELECT 'recorded'::text, selected_id;
END
$function$;

CREATE FUNCTION app_private.assign_daily_outreach_creator_watch_comment(
  p_workspace_id uuid,
  p_observed_post_id uuid,
  p_relevance_decision_id uuid,
  p_message_family_version_id uuid,
  p_content_item_id uuid,
  p_content_version_id uuid,
  p_content_sha256 bytea,
  p_approval_request_id uuid,
  p_approval_decision_id uuid,
  p_assignment_evidence_sha256 bytea,
  p_command_key_sha256 bytea
)
RETURNS TABLE (
  disposition text,
  comment_assignment_id uuid,
  effect_state text,
  cooldown_until timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  trusted_request_id text := app_private.current_request_id();
  post app_private.daily_outreach_creator_watch_observed_posts%ROWTYPE;
  subject app_private.daily_outreach_creator_watch_subject_versions%ROWTYPE;
  decision app_private.daily_outreach_creator_watch_relevance_decisions%ROWTYPE;
  family app_private.daily_outreach_message_family_versions%ROWTYPE;
  existing_row app_private.daily_outreach_creator_watch_comment_assignments%ROWTYPE;
  request_digest bytea;
  selected_id uuid := gen_random_uuid();
  selected_assigned_at timestamptz := statement_timestamp();
  selected_cooldown_until timestamptz;
  creator_day_count bigint;
  creator_week_count bigint;
  channel_day_count bigint;
  latest_creator_assignment_at timestamptz;
  utc_day_start timestamptz :=
    pg_catalog.date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC')
      AT TIME ZONE 'UTC';
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', true
  );
  IF p_content_sha256 IS NULL OR octet_length(p_content_sha256) <> 32
     OR p_assignment_evidence_sha256 IS NULL
     OR octet_length(p_assignment_evidence_sha256) <> 32
     OR p_command_key_sha256 IS NULL
     OR octet_length(p_command_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'Invalid Creator Watch comment assignment evidence'
      USING ERRCODE = '22023';
  END IF;

  request_digest := public.digest(pg_catalog.format(
    'propertypredator.creator-watch-assignment/v1|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
    p_workspace_id, p_observed_post_id, p_relevance_decision_id,
    p_message_family_version_id, p_content_item_id, p_content_version_id,
    pg_catalog.encode(p_content_sha256, 'hex'), p_approval_request_id,
    p_approval_decision_id,
    pg_catalog.encode(p_assignment_evidence_sha256, 'hex')
  ), 'sha256');

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-creator-assignment-command:' || p_workspace_id::text || ':'
        || pg_catalog.encode(p_command_key_sha256, 'hex'),
      0
    )
  );

  SELECT assignment.* INTO existing_row
  FROM app_private.daily_outreach_creator_watch_comment_assignments AS assignment
  WHERE assignment.workspace_id = p_workspace_id
    AND assignment.command_key_sha256 = p_command_key_sha256;
  IF FOUND THEN
    IF existing_row.request_sha256 = request_digest THEN
      RETURN QUERY SELECT 'replayed'::text, existing_row.id,
        existing_row.effect_state, existing_row.cooldown_until;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Creator Watch comment-assignment command conflict'
      USING ERRCODE = '23505';
  END IF;

  SELECT observed.* INTO post
  FROM app_private.daily_outreach_creator_watch_observed_posts AS observed
  WHERE observed.workspace_id = p_workspace_id
    AND observed.id = p_observed_post_id;
  IF NOT FOUND OR post.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'Creator Watch assignment requires fresh post evidence'
      USING ERRCODE = '55000';
  END IF;
  SELECT version.* INTO subject
  FROM app_private.daily_outreach_creator_watch_subject_versions AS version
  WHERE version.workspace_id = post.workspace_id
    AND version.id = post.subject_version_id;
  IF FOUND THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'daily-outreach-creator-subject:' || p_workspace_id::text || ':'
          || subject.subject_key,
        0
      )
    );
  END IF;
  IF NOT FOUND
     OR subject.status <> 'active_review'
     OR EXISTS (
       SELECT 1
       FROM app_private.daily_outreach_creator_watch_subject_versions AS newer
       WHERE newer.workspace_id = subject.workspace_id
         AND newer.subject_key = subject.subject_key
         AND newer.version_number > subject.version_number
     ) THEN
    RAISE EXCEPTION 'Creator Watch assignment requires latest active subject'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-creator-decision:' || p_workspace_id::text || ':'
        || p_observed_post_id::text,
      0
    )
  );
  SELECT relevance.* INTO decision
  FROM app_private.daily_outreach_creator_watch_relevance_decisions AS relevance
  WHERE relevance.workspace_id = p_workspace_id
    AND relevance.id = p_relevance_decision_id
    AND relevance.observed_post_id = p_observed_post_id
    AND relevance.subject_version_id = post.subject_version_id
    AND relevance.network = post.network;
  IF NOT FOUND
     OR decision.decision <> 'comment'
     OR EXISTS (
       SELECT 1
       FROM app_private.daily_outreach_creator_watch_relevance_decisions AS newer
       WHERE newer.workspace_id = decision.workspace_id
         AND newer.observed_post_id = decision.observed_post_id
         AND newer.previous_decision_id = decision.id
     ) THEN
    RAISE EXCEPTION 'Creator Watch assignment requires latest comment decision'
      USING ERRCODE = '55000';
  END IF;

  SELECT version.* INTO family
  FROM app_private.daily_outreach_message_family_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_message_family_version_id
    AND version.channel = post.network
    AND version.purpose = 'authority_comment';
  IF FOUND THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'daily-outreach-message-family:' || p_workspace_id::text || ':'
          || family.family_key,
        0
      )
    );
  END IF;
  IF NOT FOUND
     OR family.effective_from > statement_timestamp()
     OR (family.effective_until IS NOT NULL
       AND family.effective_until <= statement_timestamp())
     OR EXISTS (
       SELECT 1
       FROM app_private.daily_outreach_message_family_versions AS newer
       WHERE newer.workspace_id = family.workspace_id
         AND newer.family_key = family.family_key
         AND newer.version_number > family.version_number
     ) THEN
    RAISE EXCEPTION 'Creator Watch assignment requires current authority-comment family'
      USING ERRCODE = '55000';
  END IF;

  IF family.content_item_id <> p_content_item_id
     OR family.content_version_id <> p_content_version_id
     OR family.content_sha256 <> p_content_sha256
     OR family.approval_request_id <> p_approval_request_id
     OR family.approval_decision_id <> p_approval_decision_id THEN
    RAISE EXCEPTION 'Creator Watch assignment must use exact message-family content'
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.assert_current_approved_creator_content(
    p_workspace_id, p_content_item_id, p_content_version_id,
    p_content_sha256, p_approval_request_id, p_approval_decision_id
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-creator-frequency:' || p_workspace_id::text || ':'
        || subject.subject_key,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'daily-outreach-channel-frequency:' || p_workspace_id::text || ':'
        || post.network || ':' || utc_day_start::text,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM app_private.daily_outreach_creator_watch_comment_assignments AS assignment
    WHERE assignment.workspace_id = p_workspace_id
      AND assignment.observed_post_id = p_observed_post_id
  ) THEN
    RAISE EXCEPTION 'Creator Watch post already has a comment assignment'
      USING ERRCODE = '23505';
  END IF;

  SELECT
    count(*) FILTER (WHERE assignment.assigned_at >= utc_day_start),
    count(*) FILTER (
      WHERE assignment.assigned_at
        >= statement_timestamp() - interval '7 days'
    ),
    max(assignment.assigned_at)
  INTO creator_day_count, creator_week_count, latest_creator_assignment_at
  FROM app_private.daily_outreach_creator_watch_comment_assignments AS assignment
  JOIN app_private.daily_outreach_creator_watch_subject_versions AS historical_subject
    ON historical_subject.workspace_id = assignment.workspace_id
   AND historical_subject.id = assignment.subject_version_id
  WHERE assignment.workspace_id = p_workspace_id
    AND historical_subject.subject_key = subject.subject_key;

  SELECT count(*) INTO channel_day_count
  FROM app_private.daily_outreach_creator_watch_comment_assignments AS assignment
  WHERE assignment.workspace_id = p_workspace_id
    AND assignment.network = post.network
    AND assignment.assigned_at >= utc_day_start;

  IF creator_day_count >= least(
       subject.max_comments_per_utc_day,
       family.max_per_creator_per_utc_day
     )
     OR creator_week_count >= least(
       subject.max_comments_rolling_7_days,
       family.max_per_creator_rolling_7_days
     )
     OR channel_day_count >= family.max_per_channel_per_utc_day THEN
    RAISE EXCEPTION 'Creator Watch frequency cap reached'
      USING ERRCODE = '54000';
  END IF;
  IF latest_creator_assignment_at IS NOT NULL
     AND latest_creator_assignment_at + pg_catalog.make_interval(
       secs => greatest(
         subject.minimum_comment_interval_seconds,
         family.cooldown_seconds
       )
     ) > selected_assigned_at THEN
    RAISE EXCEPTION 'Creator Watch cooldown is active'
      USING ERRCODE = '55000';
  END IF;

  selected_cooldown_until := selected_assigned_at
    + pg_catalog.make_interval(secs => greatest(
      subject.minimum_comment_interval_seconds, family.cooldown_seconds
    ));

  INSERT INTO app_private.daily_outreach_creator_watch_comment_assignments (
    id, workspace_id, command_key_sha256, request_sha256,
    observed_post_id, subject_version_id, relevance_decision_id,
    message_family_version_id, network, content_item_id, content_version_id,
    content_sha256, approval_request_id, approval_decision_id,
    assignment_evidence_sha256, assigned_by_user_id, assigned_request_id,
    assigned_at, cooldown_until
  ) VALUES (
    selected_id, p_workspace_id, p_command_key_sha256, request_digest,
    post.id, post.subject_version_id, decision.id, family.id, post.network,
    p_content_item_id, p_content_version_id, p_content_sha256,
    p_approval_request_id, p_approval_decision_id,
    p_assignment_evidence_sha256, trusted_user_id, trusted_request_id,
    selected_assigned_at, selected_cooldown_until
  );
  RETURN QUERY SELECT 'recorded'::text, selected_id,
    'review_only'::text, selected_cooldown_until;
END
$function$;

-- Portal callers select only the already-read immutable message-family id.
-- Exact content and approval identifiers stay behind the command boundary and
-- are resolved here before the lower-level evidence function revalidates them.
CREATE FUNCTION app_private.assign_current_daily_outreach_creator_watch_comment(
  p_workspace_id uuid,
  p_observed_post_id uuid,
  p_relevance_decision_id uuid,
  p_message_family_version_id uuid,
  p_assignment_evidence_sha256 bytea,
  p_command_key_sha256 bytea
)
RETURNS TABLE (
  disposition text,
  comment_assignment_id uuid,
  effect_state text,
  cooldown_until timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  family app_private.daily_outreach_message_family_versions%ROWTYPE;
BEGIN
  PERFORM app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', true
  );
  IF p_assignment_evidence_sha256 IS NULL
     OR octet_length(p_assignment_evidence_sha256) <> 32
     OR p_command_key_sha256 IS NULL
     OR octet_length(p_command_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'Invalid current Creator Watch assignment evidence'
      USING ERRCODE = '22023';
  END IF;

  SELECT version.* INTO family
  FROM app_private.daily_outreach_message_family_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_message_family_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current Creator Watch message family not found'
      USING ERRCODE = '23503';
  END IF;

  RETURN QUERY
  SELECT assignment.disposition, assignment.comment_assignment_id,
    assignment.effect_state, assignment.cooldown_until
  FROM app_private.assign_daily_outreach_creator_watch_comment(
    p_workspace_id, p_observed_post_id, p_relevance_decision_id,
    family.id, family.content_item_id, family.content_version_id,
    family.content_sha256, family.approval_request_id,
    family.approval_decision_id, p_assignment_evidence_sha256,
    p_command_key_sha256
  ) AS assignment;
END
$function$;

-- A browser may retry after the relevance decision and optional review-only
-- assignment have committed but before it receives the response. Resolve that
-- immutable receipt before refreshing the mutable queue. The caller must
-- compare every returned stable intent field before accepting the replay.
-- No post body, provider identifier, content body or provider operation is
-- exposed through this table-blind command-role function.
CREATE FUNCTION app_private.resolve_daily_outreach_creator_watch_replay(
  p_workspace_id uuid,
  p_command_key_sha256 bytea
)
RETURNS TABLE (
  disposition text,
  observed_post_id uuid,
  previous_decision_id uuid,
  decision text,
  comment_purpose text,
  no_comment_reason text,
  decision_source text,
  relevance_decision_id uuid,
  decided_by_user_id uuid,
  message_family_version_id uuid,
  comment_assignment_id uuid,
  assigned_by_user_id uuid,
  effect_state text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_user_id uuid;
  selected_decision
    app_private.daily_outreach_creator_watch_relevance_decisions%ROWTYPE;
  selected_assignment
    app_private.daily_outreach_creator_watch_comment_assignments%ROWTYPE;
BEGIN
  trusted_user_id := app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_command', true
  );
  IF p_command_key_sha256 IS NULL
     OR octet_length(p_command_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'Invalid Creator Watch replay lookup'
      USING ERRCODE = '22023';
  END IF;

  SELECT relevance.* INTO selected_decision
  FROM app_private.daily_outreach_creator_watch_relevance_decisions AS relevance
  WHERE relevance.workspace_id = p_workspace_id
    AND relevance.command_key_sha256 = p_command_key_sha256;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT assignment.* INTO selected_assignment
  FROM app_private.daily_outreach_creator_watch_comment_assignments AS assignment
  WHERE assignment.workspace_id = p_workspace_id
    AND assignment.relevance_decision_id = selected_decision.id;

  RETURN QUERY SELECT
    'replayed'::text,
    selected_decision.observed_post_id,
    selected_decision.previous_decision_id,
    selected_decision.decision,
    selected_decision.comment_purpose,
    selected_decision.no_comment_reason,
    selected_decision.decision_source,
    selected_decision.id,
    selected_decision.decided_by_user_id,
    selected_assignment.message_family_version_id,
    selected_assignment.id,
    selected_assignment.assigned_by_user_id,
    selected_assignment.effect_state;
END
$function$;

CREATE FUNCTION app_private.read_daily_outreach_message_families(
  p_workspace_id uuid,
  p_channel text
)
RETURNS TABLE (
  message_family_version_id uuid,
  family_key text,
  version_number integer,
  programme_version_id uuid,
  channel text,
  purpose text,
  laps_stage text,
  audience_segment_key text,
  next_action text,
  allowed_context_fields text[],
  tone_variant text,
  cooldown_seconds integer,
  max_per_creator_per_utc_day smallint,
  max_per_channel_per_utc_day smallint,
  max_per_creator_rolling_7_days smallint,
  configuration_sha256 bytea,
  content_version_id uuid,
  content_sha256 bytea,
  effective_from timestamptz,
  effective_until timestamptz,
  execution_state text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_read', true
  );
  IF p_channel NOT IN ('linkedin', 'instagram', 'other_social') THEN
    RAISE EXCEPTION 'Invalid Daily Outreach message-family channel'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT family.id, family.family_key, family.version_number,
    family.programme_version_id, family.channel, family.purpose,
    family.laps_stage, family.audience_segment_key, family.next_action,
    family.allowed_context_fields, family.tone_variant,
    family.cooldown_seconds, family.max_per_creator_per_utc_day,
    family.max_per_channel_per_utc_day,
    family.max_per_creator_rolling_7_days, family.configuration_sha256,
    family.content_version_id, family.content_sha256,
    family.effective_from, family.effective_until,
    'approved_review_only'::text
  FROM app_private.daily_outreach_message_family_versions AS family
  WHERE family.workspace_id = p_workspace_id
    AND family.channel = p_channel
    AND family.effective_from <= statement_timestamp()
    AND (
      family.effective_until IS NULL
      OR family.effective_until > statement_timestamp()
    )
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_message_family_versions AS newer
      WHERE newer.workspace_id = family.workspace_id
        AND newer.family_key = family.family_key
        AND newer.version_number > family.version_number
    )
    AND EXISTS (
      SELECT 1
      FROM app.company_content_versions AS content_version
      JOIN app.company_content_approval_requests AS request
        ON request.workspace_id = content_version.workspace_id
       AND request.content_item_id = content_version.content_item_id
       AND request.content_version_id = content_version.id
       AND request.id = family.approval_request_id
       AND request.content_sha256 = content_version.content_sha256
      JOIN app.company_content_approval_decisions AS decision
        ON decision.workspace_id = request.workspace_id
       AND decision.content_item_id = request.content_item_id
       AND decision.content_version_id = request.content_version_id
       AND decision.approval_request_id = request.id
       AND decision.id = family.approval_decision_id
       AND decision.content_sha256 = request.content_sha256
       AND decision.decision = 'approved'
      WHERE content_version.workspace_id = family.workspace_id
        AND content_version.content_item_id = family.content_item_id
        AND content_version.id = family.content_version_id
        AND content_version.content_sha256 = family.content_sha256
        AND content_version.content_kind = 'social_post'
        AND NOT EXISTS (
          SELECT 1
          FROM app.company_content_versions AS newer_content
          WHERE newer_content.workspace_id = content_version.workspace_id
            AND newer_content.content_item_id = content_version.content_item_id
            AND newer_content.version_number > content_version.version_number
        )
        AND NOT EXISTS (
          SELECT 1
          FROM app.company_content_approval_requests AS later_request
          WHERE later_request.workspace_id = request.workspace_id
            AND later_request.content_item_id = request.content_item_id
            AND later_request.content_version_id = request.content_version_id
            AND later_request.request_number > request.request_number
        )
    )
  ORDER BY family.family_key;
END
$function$;

CREATE FUNCTION app_private.read_daily_outreach_creator_watch_queue(
  p_workspace_id uuid,
  p_limit smallint
)
RETURNS TABLE (
  observed_post_id uuid,
  subject_version_id uuid,
  subject_key text,
  subject_version_number integer,
  network text,
  source_kind text,
  provider_post_ref_sha256 bytea,
  source_reference_sha256 bytea,
  post_content_sha256 bytea,
  observed_at timestamptz,
  expires_at timestamptz,
  latest_relevance_decision_id uuid,
  relevance_decision text,
  comment_purpose text,
  no_comment_reason text,
  comment_assignment_id uuid,
  effect_state text,
  cooldown_until timestamptz,
  creator_day_count bigint,
  creator_week_count bigint,
  max_comments_per_utc_day smallint,
  max_comments_rolling_7_days smallint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM app_private.assert_daily_outreach_context(
    p_workspace_id, 'r72_daily_outreach_read', true
  );
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid Creator Watch queue limit'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT post.id, subject.id, subject.subject_key, subject.version_number,
    post.network, post.source_kind, post.provider_post_ref_sha256,
    post.source_reference_sha256, post.post_content_sha256,
    post.observed_at, post.expires_at, latest.id, latest.decision,
    latest.comment_purpose, latest.no_comment_reason, assignment.id,
    coalesce(assignment.effect_state, 'unassigned_review_only'),
    assignment.cooldown_until,
    (
      SELECT count(*)
      FROM app_private.daily_outreach_creator_watch_comment_assignments AS counted
      JOIN app_private.daily_outreach_creator_watch_subject_versions AS counted_subject
        ON counted_subject.workspace_id = counted.workspace_id
       AND counted_subject.id = counted.subject_version_id
      WHERE counted.workspace_id = p_workspace_id
        AND counted_subject.subject_key = subject.subject_key
        AND counted.assigned_at >= (
          pg_catalog.date_trunc(
            'day', statement_timestamp() AT TIME ZONE 'UTC'
          ) AT TIME ZONE 'UTC'
        )
    ),
    (
      SELECT count(*)
      FROM app_private.daily_outreach_creator_watch_comment_assignments AS counted
      JOIN app_private.daily_outreach_creator_watch_subject_versions AS counted_subject
        ON counted_subject.workspace_id = counted.workspace_id
       AND counted_subject.id = counted.subject_version_id
      WHERE counted.workspace_id = p_workspace_id
        AND counted_subject.subject_key = subject.subject_key
        AND counted.assigned_at >= statement_timestamp() - interval '7 days'
    ),
    subject.max_comments_per_utc_day,
    subject.max_comments_rolling_7_days
  FROM app_private.daily_outreach_creator_watch_observed_posts AS post
  JOIN app_private.daily_outreach_creator_watch_subject_versions AS subject
    ON subject.workspace_id = post.workspace_id
   AND subject.id = post.subject_version_id
  LEFT JOIN LATERAL (
    SELECT relevance.*
    FROM app_private.daily_outreach_creator_watch_relevance_decisions AS relevance
    WHERE relevance.workspace_id = post.workspace_id
      AND relevance.observed_post_id = post.id
    ORDER BY relevance.decided_at DESC, relevance.id DESC
    LIMIT 1
  ) AS latest ON true
  LEFT JOIN app_private.daily_outreach_creator_watch_comment_assignments AS assignment
    ON assignment.workspace_id = post.workspace_id
   AND assignment.observed_post_id = post.id
  WHERE post.workspace_id = p_workspace_id
    AND subject.status <> 'retired'
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.daily_outreach_creator_watch_subject_versions AS newer
      WHERE newer.workspace_id = subject.workspace_id
        AND newer.subject_key = subject.subject_key
        AND newer.version_number > subject.version_number
    )
  ORDER BY
    (assignment.id IS NULL) DESC,
    (latest.id IS NULL) DESC,
    post.observed_at DESC,
    post.id
  LIMIT p_limit;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE CREATE ON SCHEMA app_private FROM r72_daily_outreach_definer;

REVOKE ALL ON FUNCTION app_private.assert_current_approved_creator_content(
  uuid, uuid, uuid, bytea, uuid, uuid
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.publish_daily_outreach_message_family_version(
  uuid, uuid, text, integer, uuid, text, text, text, text, text[], text,
  uuid, uuid, bytea, uuid, uuid, integer, smallint, smallint, smallint,
  bytea, timestamptz, timestamptz
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.publish_daily_outreach_creator_watch_subject_version(
  uuid, text, integer, uuid, text, bytea, text, bytea, text, integer,
  smallint, smallint, integer, bytea
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.record_daily_outreach_creator_watch_post(
  uuid, uuid, text, bytea, bytea, bytea, bytea, timestamptz,
  timestamptz, bytea
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.record_daily_outreach_creator_watch_relevance(
  uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.assign_daily_outreach_creator_watch_comment(
  uuid, uuid, uuid, uuid, uuid, uuid, bytea, uuid, uuid, bytea, bytea
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.assign_current_daily_outreach_creator_watch_comment(
  uuid, uuid, uuid, uuid, bytea, bytea
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.resolve_daily_outreach_creator_watch_replay(
  uuid, bytea
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.read_daily_outreach_message_families(
  uuid, text
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;
REVOKE ALL ON FUNCTION app_private.read_daily_outreach_creator_watch_queue(
  uuid, smallint
) FROM PUBLIC, r72_daily_outreach_command, r72_daily_outreach_read;

GRANT EXECUTE ON FUNCTION app_private.publish_daily_outreach_message_family_version(
  uuid, uuid, text, integer, uuid, text, text, text, text, text[], text,
  uuid, uuid, bytea, uuid, uuid, integer, smallint, smallint, smallint,
  bytea, timestamptz, timestamptz
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.publish_daily_outreach_creator_watch_subject_version(
  uuid, text, integer, uuid, text, bytea, text, bytea, text, integer,
  smallint, smallint, integer, bytea
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.record_daily_outreach_creator_watch_post(
  uuid, uuid, text, bytea, bytea, bytea, bytea, timestamptz,
  timestamptz, bytea
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.record_daily_outreach_creator_watch_relevance(
  uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.assign_current_daily_outreach_creator_watch_comment(
  uuid, uuid, uuid, uuid, bytea, bytea
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.resolve_daily_outreach_creator_watch_replay(
  uuid, bytea
) TO r72_daily_outreach_command;
GRANT EXECUTE ON FUNCTION app_private.read_daily_outreach_message_families(
  uuid, text
) TO r72_daily_outreach_read;
GRANT EXECUTE ON FUNCTION app_private.read_daily_outreach_creator_watch_queue(
  uuid, smallint
) TO r72_daily_outreach_read;

DO $capability_audit$
DECLARE
  unsafe_object text;
  unsafe_function text;
  unexpected_acl text;
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
        'r72_daily_outreach_read', relation.oid, 'SELECT'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_read', relation.oid, 'INSERT'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_read', relation.oid, 'UPDATE'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_read', relation.oid, 'DELETE'
      ) OR pg_catalog.has_table_privilege(
        'r72_daily_outreach_read', relation.oid, 'TRUNCATE'
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
    RAISE EXCEPTION 'Creator Watch login role has direct table capability: %',
      unsafe_object USING ERRCODE = '42501';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unsafe_function
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(
      procedure.proacl,
      pg_catalog.acldefault('f', procedure.proowner)
    )
  ) AS privilege
  WHERE namespace.nspname = 'app_private'
    AND procedure.proname IN (
      'assert_current_approved_creator_content',
      'publish_daily_outreach_message_family_version',
      'publish_daily_outreach_creator_watch_subject_version',
      'record_daily_outreach_creator_watch_post',
      'record_daily_outreach_creator_watch_relevance',
      'assign_daily_outreach_creator_watch_comment',
      'assign_current_daily_outreach_creator_watch_comment',
      'resolve_daily_outreach_creator_watch_replay',
      'read_daily_outreach_message_families',
      'read_daily_outreach_creator_watch_queue'
    )
    AND privilege.grantee = 0
    AND privilege.privilege_type = 'EXECUTE'
  LIMIT 1;
  IF unsafe_function IS NOT NULL THEN
    RAISE EXCEPTION 'Creator Watch function remains executable by PUBLIC: %',
      unsafe_function USING ERRCODE = '42501';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unexpected_acl
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'app_private'
    AND pg_catalog.has_function_privilege(
      'r72_daily_outreach_command', procedure.oid, 'EXECUTE'
    )
    AND procedure.proname NOT IN (
      'publish_daily_outreach_programme_version',
      'record_daily_outreach_prospect_membership',
      'allocate_daily_outreach_queue_item',
      'record_daily_outreach_channel_eligibility',
      'assign_daily_outreach_approved_content',
      'claim_next_manual_daily_outreach',
      'record_daily_outreach_manual_attempt',
      'record_daily_outreach_outcome_event',
      'project_daily_outreach_outcome',
      'resolve_daily_outreach_command_replay',
      'publish_daily_outreach_message_family_version',
      'publish_daily_outreach_creator_watch_subject_version',
      'record_daily_outreach_creator_watch_post',
      'record_daily_outreach_creator_watch_relevance',
      'assign_current_daily_outreach_creator_watch_comment',
      'resolve_daily_outreach_creator_watch_replay'
    )
  LIMIT 1;
  IF unexpected_acl IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Creator Watch command function ACL: %',
      unexpected_acl USING ERRCODE = '42501';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unexpected_acl
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'app_private'
    AND pg_catalog.has_function_privilege(
      'r72_daily_outreach_read', procedure.oid, 'EXECUTE'
    )
    AND procedure.proname NOT IN (
      'read_daily_outreach_cockpit_snapshot',
      'read_daily_outreach_message_families',
      'read_daily_outreach_creator_watch_queue'
    )
  LIMIT 1;
  IF unexpected_acl IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Creator Watch read function ACL: %',
      unexpected_acl USING ERRCODE = '42501';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'r72_daily_outreach_command',
       'app_private.publish_daily_outreach_message_family_version(uuid,uuid,text,integer,uuid,text,text,text,text,text[],text,uuid,uuid,bytea,uuid,uuid,integer,smallint,smallint,smallint,bytea,timestamptz,timestamptz)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'r72_daily_outreach_command',
       'app_private.assign_current_daily_outreach_creator_watch_comment(uuid,uuid,uuid,uuid,bytea,bytea)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'r72_daily_outreach_command',
       'app_private.resolve_daily_outreach_creator_watch_replay(uuid,bytea)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'r72_daily_outreach_command',
       'app_private.assign_daily_outreach_creator_watch_comment(uuid,uuid,uuid,uuid,uuid,uuid,bytea,uuid,uuid,bytea,bytea)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'r72_daily_outreach_command',
       'app_private.read_daily_outreach_creator_watch_queue(uuid,smallint)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'r72_daily_outreach_read',
       'app_private.read_daily_outreach_creator_watch_queue(uuid,smallint)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'r72_daily_outreach_read',
       'app_private.assign_current_daily_outreach_creator_watch_comment(uuid,uuid,uuid,uuid,bytea,bytea)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'r72_daily_outreach_read',
       'app_private.resolve_daily_outreach_creator_watch_replay(uuid,bytea)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Creator Watch exact command/read ACL is not intact'
      USING ERRCODE = '42501';
  END IF;

  IF pg_catalog.has_table_privilege(
       'r72_daily_outreach_definer', 'app.provider_operations', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_daily_outreach_definer',
       'app.property_predator_zernio_reply_deliveries', 'INSERT'
     )
     OR pg_catalog.pg_has_role(
       'r72_daily_outreach_command', 'r72_provider_operation_definer', 'MEMBER'
     )
     OR pg_catalog.pg_has_role(
       'r72_daily_outreach_command', 'r72_zernio_social_definer', 'MEMBER'
     )
     OR pg_catalog.pg_has_role(
       'r72_daily_outreach_command', 'r72_owned_social_definer', 'MEMBER'
     ) THEN
    RAISE EXCEPTION 'Creator Watch gained provider-effect capability'
      USING ERRCODE = '42501';
  END IF;
END
$capability_audit$;

RESET ROLE;
