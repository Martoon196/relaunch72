-- Configurable, version-pinned conversion journeys for the first Property
-- Predator growth slice. Definitions, milestone achievements, score snapshots,
-- communication evidence and conversion-commerce records are immutable facts.
-- This is deliberately separate from app_private.platform_orders, which is the
-- commercial ledger for purchases of Relaunch72 itself.

SET LOCAL ROLE r72_owner;

CREATE TABLE app.lead_score_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  slug citext NOT NULL CHECK (
    slug::text = lower(slug::text)
    AND slug::text ~ '^[a-z0-9][a-z0-9-]{0,62}$'
  ),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived')),
  active_version_id uuid,
  created_by_user_id uuid NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, slug),
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (status = 'draft' OR active_version_id IS NOT NULL),
  CHECK (updated_at >= created_at)
);

CREATE TABLE app.lead_score_model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  model_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  definition_sha256 bytea NOT NULL CHECK (octet_length(definition_sha256) = 32),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  published_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, model_id, id),
  UNIQUE (workspace_id, model_id, version_no),
  UNIQUE (workspace_id, model_id, definition_sha256),
  FOREIGN KEY (workspace_id, model_id)
    REFERENCES app.lead_score_models (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (published_at IS NULL OR published_at >= created_at)
);

ALTER TABLE app.lead_score_models
  ADD CONSTRAINT lead_score_models_active_version_fk
  FOREIGN KEY (workspace_id, id, active_version_id)
  REFERENCES app.lead_score_model_versions (workspace_id, model_id, id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.conversion_journeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  slug citext NOT NULL CHECK (
    slug::text = lower(slug::text)
    AND slug::text ~ '^[a-z0-9][a-z0-9-]{0,62}$'
  ),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text CHECK (
    description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000
  ),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived')),
  active_version_id uuid,
  created_by_user_id uuid NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, slug),
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (status = 'draft' OR active_version_id IS NOT NULL),
  CHECK (updated_at >= created_at)
);

CREATE TABLE app.conversion_journey_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  journey_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  score_model_version_id uuid,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(settings) = 'object'),
  definition_sha256 bytea NOT NULL CHECK (octet_length(definition_sha256) = 32),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  published_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, journey_id, id),
  UNIQUE (workspace_id, journey_id, version_no),
  UNIQUE (workspace_id, journey_id, definition_sha256),
  FOREIGN KEY (workspace_id, journey_id)
    REFERENCES app.conversion_journeys (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, score_model_version_id)
    REFERENCES app.lead_score_model_versions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (published_at IS NULL OR published_at >= created_at)
);

ALTER TABLE app.conversion_journeys
  ADD CONSTRAINT conversion_journeys_active_version_fk
  FOREIGN KEY (workspace_id, id, active_version_id)
  REFERENCES app.conversion_journey_versions (workspace_id, journey_id, id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.conversion_journey_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  journey_version_id uuid NOT NULL,
  milestone_key citext NOT NULL CHECK (
    milestone_key::text = lower(milestone_key::text)
    AND milestone_key::text ~ '^[a-z0-9][a-z0-9-]{0,62}$'
  ),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  position integer NOT NULL CHECK (position > 0),
  semantic text NOT NULL CHECK (
    semantic IN (
      'lead', 'appointment', 'presentation', 'activation', 'offer',
      'sale', 'retention', 'custom'
    )
  ),
  is_completion boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, journey_version_id, id),
  UNIQUE (workspace_id, journey_version_id, id, semantic),
  UNIQUE (workspace_id, journey_version_id, milestone_key),
  UNIQUE (workspace_id, journey_version_id, position),
  FOREIGN KEY (workspace_id, journey_version_id)
    REFERENCES app.conversion_journey_versions (workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX conversion_journey_milestones_one_completion_uq
  ON app.conversion_journey_milestones (workspace_id, journey_version_id)
  WHERE is_completion;

CREATE INDEX conversion_journey_milestones_order_idx
  ON app.conversion_journey_milestones
    (workspace_id, journey_version_id, position, id);

-- The partial unique index above gives every version at most one completion.
-- This deferred activation gate supplies the other half: a journey cannot be
-- made active until its selected immutable version has exactly one.
CREATE FUNCTION app_private.require_active_journey_completion()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  completion_count integer;
BEGIN
  IF NEW.status = 'active' THEN
    SELECT count(*)::integer
      INTO completion_count
      FROM app.conversion_journey_milestones AS milestone
     WHERE milestone.workspace_id = NEW.workspace_id
       AND milestone.journey_version_id = NEW.active_version_id
       AND milestone.is_completion;

    IF completion_count <> 1 THEN
      RAISE EXCEPTION
        'an active conversion journey version must have exactly one completion milestone'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app_private.require_active_journey_completion() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER conversion_journeys_active_completion_ck
  AFTER INSERT OR UPDATE OF status, active_version_id
  ON app.conversion_journeys
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION app_private.require_active_journey_completion();

CREATE TABLE app.conversion_journey_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  journey_version_id uuid NOT NULL,
  milestone_id uuid NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('event', 'commerce')),
  source_key text NOT NULL CHECK (
    source_key = lower(btrim(source_key))
    AND source_key ~ '^[a-z][a-z0-9_.-]{0,149}$'
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, journey_version_id, trigger_kind, source_key),
  FOREIGN KEY (workspace_id, journey_version_id)
    REFERENCES app.conversion_journey_versions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, journey_version_id, milestone_id)
    REFERENCES app.conversion_journey_milestones
      (workspace_id, journey_version_id, id) ON DELETE CASCADE,
  -- Mirror the reviewed V1 positive registry at the durable boundary. Direct
  -- command-role inserts must not turn arbitrary, consent or privacy events
  -- into conversion triggers by bypassing the TypeScript publisher.
  CHECK (
    (trigger_kind = 'event' AND source_key IN (
      'identity.account.created',
      'product.analysis.completed'
    ))
    OR (trigger_kind = 'commerce' AND source_key = 'payment_collected')
  )
);

CREATE INDEX conversion_journey_triggers_lookup_idx
  ON app.conversion_journey_triggers
    (workspace_id, journey_version_id, trigger_kind, source_key);

-- Activation is a one-way publication boundary. The marker remains on a
-- version after its container is archived or another version becomes active,
-- so a once-published definition can never become an editable draft again.
CREATE FUNCTION app_private.require_monotonic_score_model_activation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  target_version integer;
  latest_published_version integer;
BEGIN
  IF NEW.status = 'active' THEN
    SELECT version_row.version_no
      INTO target_version
      FROM app.lead_score_model_versions AS version_row
     WHERE version_row.workspace_id = NEW.workspace_id
       AND version_row.model_id = NEW.id
       AND version_row.id = NEW.active_version_id;

    IF target_version IS NULL THEN
      RAISE EXCEPTION 'active score model version does not exist'
        USING ERRCODE = '23503';
    END IF;

    SELECT max(version_row.version_no)
      INTO latest_published_version
      FROM app.lead_score_model_versions AS version_row
     WHERE version_row.workspace_id = NEW.workspace_id
       AND version_row.model_id = NEW.id
       AND version_row.published_at IS NOT NULL;

    IF latest_published_version IS NOT NULL
       AND target_version < latest_published_version THEN
      RAISE EXCEPTION
        'cannot activate score model version % after published version %',
        target_version, latest_published_version
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE FUNCTION app_private.mark_score_model_version_published()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  UPDATE app.lead_score_model_versions AS version_row
     SET published_at = coalesce(version_row.published_at, statement_timestamp())
   WHERE version_row.workspace_id = NEW.workspace_id
     AND version_row.model_id = NEW.id
     AND version_row.id = NEW.active_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active score model version could not be published'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION app_private.require_monotonic_journey_activation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  target_version integer;
  latest_published_version integer;
BEGIN
  IF NEW.status = 'active' THEN
    SELECT version_row.version_no
      INTO target_version
      FROM app.conversion_journey_versions AS version_row
     WHERE version_row.workspace_id = NEW.workspace_id
       AND version_row.journey_id = NEW.id
       AND version_row.id = NEW.active_version_id;

    IF target_version IS NULL THEN
      RAISE EXCEPTION 'active conversion journey version does not exist'
        USING ERRCODE = '23503';
    END IF;

    SELECT max(version_row.version_no)
      INTO latest_published_version
      FROM app.conversion_journey_versions AS version_row
     WHERE version_row.workspace_id = NEW.workspace_id
       AND version_row.journey_id = NEW.id
       AND version_row.published_at IS NOT NULL;

    IF latest_published_version IS NOT NULL
       AND target_version < latest_published_version THEN
      RAISE EXCEPTION
        'cannot activate conversion journey version % after published version %',
        target_version, latest_published_version
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE FUNCTION app_private.mark_journey_version_published()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  UPDATE app.conversion_journey_versions AS version_row
     SET published_at = coalesce(version_row.published_at, statement_timestamp())
   WHERE version_row.workspace_id = NEW.workspace_id
     AND version_row.journey_id = NEW.id
     AND version_row.id = NEW.active_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active conversion journey version could not be published'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$function$;

-- A child insert takes a row lock on its parent version. Publisher replay takes
-- the same lock before verification, closing the MVCC race between appending a
-- child and first activation. Once published_at is set, even archived versions
-- remain frozen.
CREATE FUNCTION app_private.require_unpublished_journey_version()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  version_published_at timestamptz;
BEGIN
  SELECT version_row.published_at
    INTO version_published_at
    FROM app.conversion_journey_versions AS version_row
   WHERE version_row.workspace_id = NEW.workspace_id
     AND version_row.id = NEW.journey_version_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversion journey version does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF version_published_at IS NOT NULL THEN
    RAISE EXCEPTION 'published conversion journey versions are frozen'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$function$;

-- r72_crm_command deliberately has no UPDATE privilege on immutable version
-- rows, so it cannot take a direct FOR UPDATE lock. This narrow capability
-- locks exactly one current-workspace manager-owned version and returns the
-- immutable fields required for replay verification.
CREATE FUNCTION app_private.lock_conversion_journey_version(
  p_journey_id uuid,
  p_version_no integer
)
RETURNS TABLE (
  id uuid,
  score_model_version_id uuid,
  settings jsonb,
  definition_sha256 bytea
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid;
  trusted_user_id uuid;
BEGIN
  trusted_workspace_id := app_private.current_workspace_id();
  trusted_user_id := app_private.current_user_id();
  IF NOT app_private.can_manage_workspace(trusted_user_id, trusted_workspace_id) THEN
    RAISE EXCEPTION 'conversion journey version lock is not authorised'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT version_row.id,
         version_row.score_model_version_id,
         version_row.settings,
         version_row.definition_sha256
    FROM app.conversion_journey_versions AS version_row
   WHERE version_row.workspace_id = trusted_workspace_id
     AND version_row.journey_id = p_journey_id
     AND version_row.version_no = p_version_no
   FOR UPDATE;
END
$function$;

REVOKE ALL ON FUNCTION app_private.require_monotonic_score_model_activation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.mark_score_model_version_published() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.require_monotonic_journey_activation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.mark_journey_version_published() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.require_unpublished_journey_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.lock_conversion_journey_version(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.lock_conversion_journey_version(uuid, integer)
  TO r72_crm_command;

CREATE TRIGGER lead_score_models_monotonic_activation_ck
  BEFORE UPDATE OF status, active_version_id ON app.lead_score_models
  FOR EACH ROW EXECUTE FUNCTION app_private.require_monotonic_score_model_activation();
CREATE TRIGGER lead_score_models_publish_version
  AFTER INSERT OR UPDATE OF status, active_version_id ON app.lead_score_models
  FOR EACH ROW WHEN (NEW.status = 'active')
  EXECUTE FUNCTION app_private.mark_score_model_version_published();
CREATE TRIGGER conversion_journeys_monotonic_activation_ck
  BEFORE UPDATE OF status, active_version_id ON app.conversion_journeys
  FOR EACH ROW EXECUTE FUNCTION app_private.require_monotonic_journey_activation();
CREATE TRIGGER conversion_journeys_publish_version
  AFTER INSERT OR UPDATE OF status, active_version_id ON app.conversion_journeys
  FOR EACH ROW WHEN (NEW.status = 'active')
  EXECUTE FUNCTION app_private.mark_journey_version_published();
CREATE TRIGGER conversion_journey_milestones_unpublished_ck
  BEFORE INSERT ON app.conversion_journey_milestones
  FOR EACH ROW EXECUTE FUNCTION app_private.require_unpublished_journey_version();
CREATE TRIGGER conversion_journey_triggers_unpublished_ck
  BEFORE INSERT ON app.conversion_journey_triggers
  FOR EACH ROW EXECUTE FUNCTION app_private.require_unpublished_journey_version();

CREATE TABLE app.conversion_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  journey_id uuid NOT NULL,
  journey_version_id uuid NOT NULL,
  score_model_version_id uuid,
  contact_id uuid NOT NULL,
  opportunity_id uuid,
  enrollment_key text NOT NULL CHECK (
    enrollment_key = btrim(enrollment_key)
    AND length(enrollment_key) BETWEEN 1 AND 200
  ),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'withdrawn', 'disqualified')),
  current_milestone_id uuid,
  source text NOT NULL CHECK (
    source = lower(btrim(source))
    AND source ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  enrolled_by_kind text NOT NULL
    CHECK (enrolled_by_kind IN ('user', 'worker', 'webhook', 'system')),
  enrolled_by_user_id uuid,
  enrolled_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_event_at timestamptz,
  ended_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, contact_id),
  UNIQUE (workspace_id, id, contact_id, journey_version_id),
  UNIQUE (workspace_id, id, contact_id, score_model_version_id),
  UNIQUE (workspace_id, journey_id, enrollment_key),
  FOREIGN KEY (workspace_id, journey_id)
    REFERENCES app.conversion_journeys (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, journey_id, journey_version_id)
    REFERENCES app.conversion_journey_versions
      (workspace_id, journey_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, score_model_version_id)
    REFERENCES app.lead_score_model_versions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, opportunity_id, contact_id)
    REFERENCES app.opportunities (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, journey_version_id, current_milestone_id)
    REFERENCES app.conversion_journey_milestones
      (workspace_id, journey_version_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, enrolled_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((enrolled_by_kind = 'user') = (enrolled_by_user_id IS NOT NULL)),
  CHECK ((status = 'active') = (ended_at IS NULL)),
  CHECK (status <> 'completed' OR current_milestone_id IS NOT NULL),
  CHECK (ended_at IS NULL OR ended_at >= enrolled_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX conversion_enrollments_queue_idx
  ON app.conversion_enrollments
    (workspace_id, journey_id, status, last_event_at DESC NULLS LAST, id);

CREATE INDEX conversion_enrollments_contact_idx
  ON app.conversion_enrollments
    (workspace_id, contact_id, status, enrolled_at DESC, id);

-- Existing point IDs are globally unique, so this additive key cannot collide.
-- It allows evidence rows to prove that endpoint and contact are the same CRM
-- subject rather than trusting application-side joins.
ALTER TABLE app.contact_points
  ADD CONSTRAINT contact_points_workspace_id_id_contact_id_uq
  UNIQUE (workspace_id, id, contact_id);

CREATE TABLE app.communication_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  channel text NOT NULL CHECK (
    channel IN ('email', 'sms', 'whatsapp', 'phone', 'social', 'webinar', 'web')
  ),
  purpose text NOT NULL CHECK (
    purpose = lower(btrim(purpose))
    AND purpose ~ '^[a-z][a-z0-9_.-]{0,99}$'
  ),
  state text NOT NULL CHECK (state IN ('granted', 'denied', 'withdrawn')),
  lawful_basis text CHECK (
    lawful_basis IS NULL OR lawful_basis IN (
      'consent', 'legitimate_interests', 'contract',
      'legal_obligation', 'vital_interests', 'public_task'
    )
  ),
  source text NOT NULL CHECK (
    source = lower(btrim(source))
    AND source ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  policy_version text CHECK (
    policy_version IS NULL OR length(btrim(policy_version)) BETWEEN 1 AND 100
  ),
  policy_text_sha256 bytea CHECK (
    policy_text_sha256 IS NULL OR octet_length(policy_text_sha256) = 32
  ),
  source_event_id text CHECK (
    source_event_id IS NULL OR (
      source_event_id = btrim(source_event_id)
      AND length(source_event_id) BETWEEN 1 AND 255
    )
  ),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'worker', 'webhook', 'system')),
  actor_user_id uuid,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object'),
  endpoint_identity_sha256 bytea NOT NULL
    CHECK (octet_length(endpoint_identity_sha256) = 32),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (state <> 'granted' OR lawful_basis IS NOT NULL),
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL))
);

CREATE UNIQUE INDEX communication_consent_events_source_uq
  ON app.communication_consent_events
    (workspace_id, source, source_event_id, contact_point_id, channel, purpose)
  WHERE source_event_id IS NOT NULL;

CREATE INDEX communication_consent_events_effective_idx
  ON app.communication_consent_events
    (workspace_id, contact_point_id, channel, purpose,
     occurred_at DESC, recorded_at DESC, id DESC);

CREATE TABLE app.communication_suppression_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  channel text NOT NULL CHECK (
    channel IN ('email', 'sms', 'whatsapp', 'phone', 'social', 'webinar', 'web')
  ),
  purpose text CHECK (
    purpose IS NULL OR (
      purpose = lower(btrim(purpose))
      AND purpose ~ '^[a-z][a-z0-9_.-]{0,99}$'
    )
  ),
  state text NOT NULL CHECK (state IN ('suppressed', 'released')),
  reason text NOT NULL CHECK (
    reason = lower(btrim(reason))
    AND reason ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  source text NOT NULL CHECK (
    source = lower(btrim(source))
    AND source ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  source_event_id text CHECK (
    source_event_id IS NULL OR (
      source_event_id = btrim(source_event_id)
      AND length(source_event_id) BETWEEN 1 AND 255
    )
  ),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'worker', 'webhook', 'system')),
  actor_user_id uuid,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object'),
  endpoint_identity_sha256 bytea NOT NULL
    CHECK (octet_length(endpoint_identity_sha256) = 32),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL))
);

CREATE UNIQUE INDEX communication_suppression_events_source_uq
  ON app.communication_suppression_events
    (workspace_id, source, source_event_id, contact_point_id, channel,
     coalesce(purpose, ''))
  WHERE source_event_id IS NOT NULL;

CREATE INDEX communication_suppression_events_effective_idx
  ON app.communication_suppression_events
    (workspace_id, contact_point_id, channel, purpose,
     occurred_at DESC, recorded_at DESC, id DESC);

-- Bind every permission/suppression fact to the endpoint identity that existed
-- when it was recorded. Eligibility recomputes the same digest, so even owner
-- maintenance or a future privileged integration cannot make evidence for an
-- old address/number authorise a replacement that reuses the point UUID.
CREATE FUNCTION app_private.capture_communication_endpoint_identity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  endpoint_kind text;
  endpoint_value text;
  endpoint_normalized_value text;
BEGIN
  SELECT point.kind, point.value, point.normalized_value
    INTO endpoint_kind, endpoint_value, endpoint_normalized_value
    FROM app.contact_points AS point
   WHERE point.workspace_id = NEW.workspace_id
     AND point.id = NEW.contact_point_id
     AND point.contact_id = NEW.contact_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'communication endpoint does not exist for contact'
      USING ERRCODE = '23503';
  END IF;

  NEW.endpoint_identity_sha256 := public.digest(
    endpoint_kind || pg_catalog.chr(31)
      || endpoint_value || pg_catalog.chr(31)
      || endpoint_normalized_value,
    'sha256'
  );
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app_private.capture_communication_endpoint_identity() FROM PUBLIC;

CREATE TRIGGER communication_consent_events_capture_endpoint_identity
  BEFORE INSERT ON app.communication_consent_events
  FOR EACH ROW EXECUTE FUNCTION app_private.capture_communication_endpoint_identity();
CREATE TRIGGER communication_suppression_events_capture_endpoint_identity
  BEFORE INSERT ON app.communication_suppression_events
  FOR EACH ROW EXECUTE FUNCTION app_private.capture_communication_endpoint_identity();

CREATE TABLE app.conversion_commerce_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  source_system text NOT NULL CHECK (
    source_system = lower(btrim(source_system))
    AND source_system ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  source_event_id text NOT NULL CHECK (
    source_event_id = btrim(source_event_id)
    AND length(source_event_id) BETWEEN 1 AND 255
  ),
  source_payload_sha256 bytea NOT NULL CHECK (octet_length(source_payload_sha256) = 32),
  fact_type text NOT NULL CHECK (
    fact_type IN ('payment_collected', 'refund_issued', 'subscription_cancelled')
  ),
  external_order_id text NOT NULL CHECK (
    external_order_id = btrim(external_order_id)
    AND length(external_order_id) BETWEEN 1 AND 255
  ),
  product_key text NOT NULL CHECK (
    product_key = lower(btrim(product_key))
    AND product_key ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'worker', 'webhook', 'system')),
  actor_user_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, fact_type, enrollment_id, contact_id),
  UNIQUE (workspace_id, source_system, source_event_id),
  FOREIGN KEY (workspace_id, enrollment_id, contact_id)
    REFERENCES app.conversion_enrollments (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL)),
  CHECK (
    (fact_type IN ('payment_collected', 'refund_issued') AND amount_minor > 0)
    OR (fact_type = 'subscription_cancelled' AND amount_minor = 0)
  )
);

CREATE INDEX conversion_commerce_facts_timeline_idx
  ON app.conversion_commerce_facts
    (workspace_id, enrollment_id, occurred_at DESC, id DESC);

CREATE TABLE app.conversion_milestone_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  journey_version_id uuid NOT NULL,
  milestone_id uuid NOT NULL,
  milestone_semantic text NOT NULL CHECK (
    milestone_semantic IN (
      'lead', 'appointment', 'presentation', 'activation', 'offer',
      'sale', 'retention', 'custom'
    )
  ),
  source_kind text NOT NULL CHECK (source_kind IN ('event', 'commerce', 'manual')),
  source_system text CHECK (
    source_system IS NULL OR (
      source_system = lower(btrim(source_system))
      AND source_system ~ '^[a-z][a-z0-9_.:-]{0,99}$'
    )
  ),
  source_event_id text CHECK (
    source_event_id IS NULL OR (
      source_event_id = btrim(source_event_id)
      AND length(source_event_id) BETWEEN 1 AND 255
    )
  ),
  commerce_fact_id uuid,
  commerce_fact_type text,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'worker', 'webhook', 'system')),
  actor_user_id uuid,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, enrollment_id, milestone_id),
  FOREIGN KEY (workspace_id, enrollment_id, contact_id, journey_version_id)
    REFERENCES app.conversion_enrollments
      (workspace_id, id, contact_id, journey_version_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, journey_version_id, milestone_id, milestone_semantic)
    REFERENCES app.conversion_journey_milestones
      (workspace_id, journey_version_id, id, semantic) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, commerce_fact_id, commerce_fact_type, enrollment_id, contact_id
  ) REFERENCES app.conversion_commerce_facts
      (workspace_id, id, fact_type, enrollment_id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL)),
  CHECK (
    (source_kind = 'event'
      AND source_system IS NOT NULL AND source_event_id IS NOT NULL
      AND commerce_fact_id IS NULL AND commerce_fact_type IS NULL)
    OR
    (source_kind = 'commerce'
      AND source_system IS NULL AND source_event_id IS NULL
      AND commerce_fact_id IS NOT NULL AND commerce_fact_type = 'payment_collected')
    OR
    (source_kind = 'manual'
      AND source_system IS NULL AND source_event_id IS NULL
      AND commerce_fact_id IS NULL AND commerce_fact_type IS NULL
      AND actor_kind = 'user')
  ),
  CHECK (
    (milestone_semantic = 'sale') = (source_kind = 'commerce')
  )
);

CREATE UNIQUE INDEX conversion_milestone_facts_source_uq
  ON app.conversion_milestone_facts
    (workspace_id, source_system, source_event_id, milestone_id)
  WHERE source_event_id IS NOT NULL;

CREATE INDEX conversion_milestone_facts_timeline_idx
  ON app.conversion_milestone_facts
    (workspace_id, enrollment_id, occurred_at DESC, id DESC);

CREATE TABLE app.lead_score_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  score_model_version_id uuid NOT NULL,
  total_score smallint NOT NULL CHECK (total_score BETWEEN 0 AND 100),
  band_key text NOT NULL CHECK (
    band_key = lower(btrim(band_key))
    AND band_key ~ '^[a-z][a-z0-9_.-]{0,62}$'
  ),
  component_scores jsonb NOT NULL CHECK (jsonb_typeof(component_scores) = 'object'),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  applied_rules jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(applied_rules) = 'array'),
  source_system text NOT NULL CHECK (
    source_system = lower(btrim(source_system))
    AND source_system ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  source_event_id text NOT NULL CHECK (
    source_event_id = btrim(source_event_id)
    AND length(source_event_id) BETWEEN 1 AND 255
  ),
  source_payload_sha256 bytea NOT NULL CHECK (octet_length(source_payload_sha256) = 32),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'worker', 'webhook', 'system')),
  actor_user_id uuid,
  source_occurred_at timestamptz NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (
    workspace_id, enrollment_id, score_model_version_id,
    source_system, source_event_id
  ),
  FOREIGN KEY (workspace_id, enrollment_id, contact_id, score_model_version_id)
    REFERENCES app.conversion_enrollments
      (workspace_id, id, contact_id, score_model_version_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL))
);

CREATE INDEX lead_score_snapshots_latest_idx
  ON app.lead_score_snapshots
    (workspace_id, enrollment_id, evaluated_at DESC, id DESC);

-- The old mutable column predates durable evidence and is retained only so the
-- CRM first-loop API remains backward compatible during the cutover.
COMMENT ON COLUMN app.contact_points.consent_status IS
  'Compatibility hint only; outbound eligibility must use communication consent and suppression events.';

-- No workspace-owned table exists for even one transaction without forced RLS.
DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'lead_score_models', 'lead_score_model_versions',
    'conversion_journeys', 'conversion_journey_versions',
    'conversion_journey_milestones', 'conversion_journey_triggers',
    'conversion_enrollments', 'communication_consent_events',
    'communication_suppression_events', 'conversion_commerce_facts',
    'conversion_milestone_facts', 'lead_score_snapshots'
  ]
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)',
      table_name || '_owner_all',
      table_name
    );
  END LOOP;
END
$rls$;

-- Portal reads require a live membership. The isolated command role gets the
-- same scoped read surface needed to execute a user command transaction.
DO $member_read_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'lead_score_models', 'lead_score_model_versions',
    'conversion_journeys', 'conversion_journey_versions',
    'conversion_journey_milestones', 'conversion_journey_triggers',
    'conversion_enrollments', 'communication_consent_events',
    'communication_suppression_events', 'conversion_commerce_facts',
    'conversion_milestone_facts', 'lead_score_snapshots'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_web, r72_crm_command USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.has_active_workspace_membership(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
      table_name || '_member_select',
      table_name
    );
  END LOOP;
END
$member_read_policies$;

-- Workers remain read-only in this release. A verified webhook can project an
-- already accepted external event, but neither role can publish definitions.
DO $service_read_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'lead_score_models', 'lead_score_model_versions',
    'conversion_journeys', 'conversion_journey_versions',
    'conversion_journey_milestones', 'conversion_journey_triggers',
    'conversion_enrollments', 'communication_consent_events',
    'communication_suppression_events', 'conversion_commerce_facts',
    'conversion_milestone_facts', 'lead_score_snapshots'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_worker, r72_webhook
       USING (workspace_id = app_private.current_workspace_id())',
      table_name || '_service_select',
      table_name
    );
  END LOOP;
END
$service_read_policies$;

-- Journey/model containers are mutable configuration; only owner/admin users
-- may create or activate versions. Published version rows have no UPDATE or
-- DELETE policy or grant.
DO $configuration_container_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['lead_score_models', 'conversion_journeys']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR INSERT TO r72_crm_command WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
         AND created_by_user_id = app_private.current_user_id()
         AND status = ''draft''
         AND active_version_id IS NULL
       )',
      table_name || '_manager_insert',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR UPDATE TO r72_crm_command USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       ) WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
      table_name || '_manager_update',
      table_name
    );
  END LOOP;
END
$configuration_container_policies$;

DO $configuration_version_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'lead_score_model_versions', 'conversion_journey_versions'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR INSERT TO r72_crm_command WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
         AND created_by_user_id = app_private.current_user_id()
       )',
      table_name || '_manager_insert',
      table_name
    );
  END LOOP;
END
$configuration_version_policies$;

DO $configuration_child_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'conversion_journey_milestones', 'conversion_journey_triggers'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR INSERT TO r72_crm_command WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
         AND EXISTS (
           SELECT 1
             FROM app.conversion_journey_versions AS draft_version
            WHERE draft_version.workspace_id = %I.workspace_id
              AND draft_version.id = %I.journey_version_id
              AND draft_version.published_at IS NULL
         )
       )',
      table_name || '_manager_insert',
      table_name,
      table_name,
      table_name
    );
  END LOOP;
END
$configuration_child_policies$;

CREATE POLICY conversion_enrollments_command_insert
  ON app.conversion_enrollments FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND enrolled_by_kind = 'user'
    AND enrolled_by_user_id = app_private.current_user_id()
    AND EXISTS (
      SELECT 1
        FROM app.conversion_journey_versions AS selected_version
       WHERE selected_version.workspace_id = conversion_enrollments.workspace_id
         AND selected_version.journey_id = conversion_enrollments.journey_id
         AND selected_version.id = conversion_enrollments.journey_version_id
         AND selected_version.score_model_version_id IS NOT DISTINCT FROM
             conversion_enrollments.score_model_version_id
    )
    AND (
      status <> 'completed'
      OR EXISTS (
        SELECT 1
          FROM app.conversion_journey_milestones AS completion
         WHERE completion.workspace_id = conversion_enrollments.workspace_id
           AND completion.journey_version_id = conversion_enrollments.journey_version_id
           AND completion.id = conversion_enrollments.current_milestone_id
           AND completion.is_completion
      )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM app.conversion_journey_milestones AS milestone
       WHERE milestone.workspace_id = conversion_enrollments.workspace_id
         AND milestone.journey_version_id = conversion_enrollments.journey_version_id
         AND milestone.id = conversion_enrollments.current_milestone_id
         AND milestone.semantic = 'sale'
    )
  );
CREATE POLICY conversion_enrollments_command_update
  ON app.conversion_enrollments FOR UPDATE TO r72_crm_command USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND (
      status <> 'completed'
      OR EXISTS (
        SELECT 1
          FROM app.conversion_journey_milestones AS completion
         WHERE completion.workspace_id = conversion_enrollments.workspace_id
           AND completion.journey_version_id = conversion_enrollments.journey_version_id
           AND completion.id = conversion_enrollments.current_milestone_id
           AND completion.is_completion
      )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM app.conversion_journey_milestones AS milestone
       WHERE milestone.workspace_id = conversion_enrollments.workspace_id
         AND milestone.journey_version_id = conversion_enrollments.journey_version_id
         AND milestone.id = conversion_enrollments.current_milestone_id
         AND milestone.semantic = 'sale'
    )
  );
CREATE POLICY conversion_enrollments_webhook_insert
  ON app.conversion_enrollments FOR INSERT TO r72_webhook WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND enrolled_by_kind = 'webhook'
    AND enrolled_by_user_id IS NULL
    AND EXISTS (
      SELECT 1
        FROM app.conversion_journey_versions AS selected_version
       WHERE selected_version.workspace_id = conversion_enrollments.workspace_id
         AND selected_version.journey_id = conversion_enrollments.journey_id
         AND selected_version.id = conversion_enrollments.journey_version_id
         AND selected_version.score_model_version_id IS NOT DISTINCT FROM
             conversion_enrollments.score_model_version_id
    )
    AND (
      status <> 'completed'
      OR EXISTS (
        SELECT 1
          FROM app.conversion_journey_milestones AS completion
         WHERE completion.workspace_id = conversion_enrollments.workspace_id
           AND completion.journey_version_id = conversion_enrollments.journey_version_id
           AND completion.id = conversion_enrollments.current_milestone_id
           AND completion.is_completion
      )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM app.conversion_journey_milestones AS milestone
       WHERE milestone.workspace_id = conversion_enrollments.workspace_id
         AND milestone.journey_version_id = conversion_enrollments.journey_version_id
         AND milestone.id = conversion_enrollments.current_milestone_id
         AND milestone.semantic = 'sale'
    )
  );
CREATE POLICY conversion_enrollments_webhook_update
  ON app.conversion_enrollments FOR UPDATE TO r72_webhook USING (
    workspace_id = app_private.current_workspace_id()
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND (
      status <> 'completed'
      OR EXISTS (
        SELECT 1
          FROM app.conversion_journey_milestones AS completion
         WHERE completion.workspace_id = conversion_enrollments.workspace_id
           AND completion.journey_version_id = conversion_enrollments.journey_version_id
           AND completion.id = conversion_enrollments.current_milestone_id
           AND completion.is_completion
      )
    )
    AND (
      NOT EXISTS (
        SELECT 1
          FROM app.conversion_journey_milestones AS milestone
         WHERE milestone.workspace_id = conversion_enrollments.workspace_id
           AND milestone.journey_version_id = conversion_enrollments.journey_version_id
           AND milestone.id = conversion_enrollments.current_milestone_id
           AND milestone.semantic = 'sale'
      )
      OR EXISTS (
        SELECT 1
          FROM app.conversion_milestone_facts AS fact
         WHERE fact.workspace_id = conversion_enrollments.workspace_id
           AND fact.enrollment_id = conversion_enrollments.id
           AND fact.contact_id = conversion_enrollments.contact_id
           AND fact.journey_version_id = conversion_enrollments.journey_version_id
           AND fact.milestone_id = conversion_enrollments.current_milestone_id
           AND fact.milestone_semantic = 'sale'
           AND fact.source_kind = 'commerce'
      )
    )
  );

CREATE POLICY communication_consent_events_command_insert
  ON app.communication_consent_events FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND actor_kind = 'user'
    AND actor_user_id = app_private.current_user_id()
  );
CREATE POLICY communication_consent_events_webhook_insert
  ON app.communication_consent_events FOR INSERT TO r72_webhook WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND actor_kind = 'webhook'
    AND actor_user_id IS NULL
  );

CREATE POLICY communication_suppression_events_manager_insert
  ON app.communication_suppression_events FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(app_private.current_user_id(), workspace_id)
    AND actor_kind = 'user'
    AND actor_user_id = app_private.current_user_id()
  );
CREATE POLICY communication_suppression_events_webhook_insert
  ON app.communication_suppression_events FOR INSERT TO r72_webhook WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND state = 'suppressed'
    AND actor_kind = 'webhook'
    AND actor_user_id IS NULL
  );

CREATE POLICY conversion_commerce_facts_webhook_insert
  ON app.conversion_commerce_facts FOR INSERT TO r72_webhook WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND actor_kind = 'webhook'
    AND actor_user_id IS NULL
  );

CREATE POLICY conversion_milestone_facts_command_insert
  ON app.conversion_milestone_facts FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND source_kind = 'manual'
    AND actor_kind = 'user'
    AND actor_user_id = app_private.current_user_id()
  );
CREATE POLICY conversion_milestone_facts_webhook_insert
  ON app.conversion_milestone_facts FOR INSERT TO r72_webhook WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND source_kind IN ('event', 'commerce')
    AND actor_kind = 'webhook'
    AND actor_user_id IS NULL
  );

CREATE POLICY lead_score_snapshots_webhook_insert
  ON app.lead_score_snapshots FOR INSERT TO r72_webhook WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND actor_kind = 'webhook'
    AND actor_user_id IS NULL
  );

-- This role can append only conversion-domain events. It cannot mutate or read
-- the outbox, and the immutable pending shape from 0003 remains enforced.
CREATE POLICY outbox_events_conversion_webhook_insert
  ON app.outbox_events FOR INSERT TO r72_webhook WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND event_type IN (
      'conversion.enrollment.started',
      'conversion.milestone.achieved',
      'conversion.score.updated',
      'conversion.commerce.fact_recorded',
      'communication.consent.recorded',
      'communication.suppression.recorded'
    )
    AND status = 'pending'
    AND attempt_count = 0
    AND published_at IS NULL
    AND last_error IS NULL
  );

GRANT SELECT ON
  app.lead_score_models, app.lead_score_model_versions,
  app.conversion_journeys, app.conversion_journey_versions,
  app.conversion_journey_milestones, app.conversion_journey_triggers,
  app.conversion_enrollments, app.communication_consent_events,
  app.communication_suppression_events, app.conversion_commerce_facts,
  app.conversion_milestone_facts, app.lead_score_snapshots
  TO r72_web, r72_crm_command, r72_worker, r72_webhook;

GRANT INSERT ON app.lead_score_models, app.conversion_journeys
  TO r72_crm_command;
GRANT UPDATE (name, status, active_version_id, row_version, updated_at)
  ON app.lead_score_models TO r72_crm_command;
GRANT UPDATE (name, description, status, active_version_id, row_version, updated_at)
  ON app.conversion_journeys TO r72_crm_command;

-- Endpoint identities become durable evidence subjects in this migration.
-- Runtime commands can still label, verify, quarantine or retire a point, but
-- cannot silently retarget its UUID to a different address or number.
REVOKE UPDATE (kind, value, normalized_value)
  ON app.contact_points FROM r72_crm_command;

GRANT INSERT ON
  app.lead_score_model_versions, app.conversion_journey_versions,
  app.conversion_journey_milestones, app.conversion_journey_triggers
  TO r72_crm_command;

GRANT INSERT ON app.conversion_enrollments TO r72_crm_command, r72_webhook;
GRANT UPDATE (
  status, current_milestone_id, last_event_at, ended_at, row_version, updated_at
) ON app.conversion_enrollments TO r72_crm_command, r72_webhook;

GRANT INSERT ON app.communication_consent_events
  TO r72_crm_command, r72_webhook;
GRANT INSERT ON app.communication_suppression_events
  TO r72_crm_command, r72_webhook;
GRANT INSERT ON app.conversion_commerce_facts TO r72_webhook;
GRANT INSERT ON app.conversion_milestone_facts
  TO r72_crm_command, r72_webhook;
GRANT INSERT ON app.lead_score_snapshots TO r72_webhook;
GRANT INSERT ON app.outbox_events TO r72_webhook;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'lead_score_models', 'workspace_id'),
  ('app', 'lead_score_model_versions', 'workspace_id'),
  ('app', 'conversion_journeys', 'workspace_id'),
  ('app', 'conversion_journey_versions', 'workspace_id'),
  ('app', 'conversion_journey_milestones', 'workspace_id'),
  ('app', 'conversion_journey_triggers', 'workspace_id'),
  ('app', 'conversion_enrollments', 'workspace_id'),
  ('app', 'communication_consent_events', 'workspace_id'),
  ('app', 'communication_suppression_events', 'workspace_id'),
  ('app', 'conversion_commerce_facts', 'workspace_id'),
  ('app', 'conversion_milestone_facts', 'workspace_id'),
  ('app', 'lead_score_snapshots', 'workspace_id');
