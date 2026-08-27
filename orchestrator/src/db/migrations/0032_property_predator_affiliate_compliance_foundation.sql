-- Property Predator affiliate compliance: private, workspace-scoped metadata
-- and append-only evidence. No document bodies, personal contact details,
-- affiliate links, provider credentials or external-effect capability live here.

DO $affiliate_compliance_role$
DECLARE
  role_record record;
  unsafe_memberships text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_affiliate_compliance_command'
  ) THEN
    CREATE ROLE r72_affiliate_compliance_command LOGIN NOINHERIT;
  END IF;

  SELECT rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
         rolreplication, rolbypassrls
    INTO role_record
  FROM pg_catalog.pg_roles
  WHERE rolname = 'r72_affiliate_compliance_command';
  IF role_record.rolsuper OR role_record.rolinherit OR role_record.rolcreaterole
     OR role_record.rolcreatedb OR NOT role_record.rolcanlogin
     OR role_record.rolreplication OR role_record.rolbypassrls THEN
    RAISE EXCEPTION 'Unsafe role attributes: r72_affiliate_compliance_command';
  END IF;

  REVOKE r72_owner, r72_security_definer, r72_worker,
    r72_provider_operation_definer FROM r72_affiliate_compliance_command;
  SELECT string_agg(parent.rolname, ', ' ORDER BY parent.rolname)
    INTO unsafe_memberships
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_affiliate_compliance_command';
  IF unsafe_memberships IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe affiliate compliance role membership: %', unsafe_memberships;
  END IF;
  EXECUTE format(
    'GRANT r72_affiliate_compliance_command TO %I', current_user
  );
END;
$affiliate_compliance_role$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_affiliate_compliance_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app, app_private
  FROM r72_affiliate_compliance_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_affiliate_compliance_command;
GRANT USAGE ON SCHEMA app, app_private
  TO r72_affiliate_compliance_command;
GRANT EXECUTE ON FUNCTION
  app_private.current_workspace_id(),
  app_private.current_user_id(),
  app_private.current_actor_kind(),
  app_private.current_request_id(),
  app_private.has_active_workspace_membership(uuid, uuid),
  app_private.can_manage_workspace(uuid, uuid)
TO r72_affiliate_compliance_command;

CREATE TABLE app_private.affiliate_compliance_policy_pack_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  pack_key text NOT NULL CHECK (
    pack_key ~ '^[a-z][a-z0-9_-]{0,99}$'
  ),
  pack_version text NOT NULL CHECK (
    pack_version = btrim(pack_version) AND length(pack_version) BETWEEN 1 AND 100
  ),
  bundle_sha256 bytea NOT NULL CHECK (octet_length(bundle_sha256) = 32),
  document_refs jsonb NOT NULL CHECK (
    jsonb_typeof(document_refs) = 'array'
    AND jsonb_array_length(document_refs) BETWEEN 5 AND 20
    AND octet_length(document_refs::text) <= 65536
  ),
  drafting_status text NOT NULL CHECK (drafting_status = 'draft_complete'),
  source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{7,40}$'),
  source_commit_meaning text NOT NULL CHECK (
    source_commit_meaning = 'drafting-provenance-only'
  ),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, bundle_sha256),
  UNIQUE (workspace_id, pack_key, pack_version),
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app_private.affiliate_compliance_policy_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  policy_pack_id uuid NOT NULL,
  bundle_sha256 bytea NOT NULL CHECK (octet_length(bundle_sha256) = 32),
  review_dimension text NOT NULL CHECK (review_dimension IN ('legal', 'commercial')),
  decision text NOT NULL CHECK (
    decision IN ('approved', 'qualified_approval', 'rejected', 'withdrawn')
  ),
  specialist_reference text NOT NULL CHECK (
    specialist_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  decision_reference text NOT NULL CHECK (
    decision_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  decision_sha256 bytea NOT NULL CHECK (octet_length(decision_sha256) = 32),
  occurred_at timestamptz NOT NULL,
  supersedes_event_id uuid,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, policy_pack_id, id, review_dimension),
  UNIQUE (workspace_id, policy_pack_id, id, bundle_sha256, review_dimension, decision),
  FOREIGN KEY (workspace_id, policy_pack_id, bundle_sha256)
    REFERENCES app_private.affiliate_compliance_policy_pack_versions (
      workspace_id, id, bundle_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, policy_pack_id, supersedes_event_id, review_dimension
  ) REFERENCES app_private.affiliate_compliance_policy_review_events (
    workspace_id, policy_pack_id, id, review_dimension
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (occurred_at <= recorded_at + interval '30 seconds')
);

CREATE TABLE app_private.affiliate_compliance_policy_publication_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  policy_pack_id uuid NOT NULL,
  bundle_sha256 bytea NOT NULL CHECK (octet_length(bundle_sha256) = 32),
  publication_state text NOT NULL CHECK (
    publication_state IN ('published', 'superseded', 'withdrawn')
  ),
  legal_review_event_id uuid NOT NULL,
  commercial_review_event_id uuid NOT NULL,
  legal_review_dimension text NOT NULL DEFAULT 'legal' CHECK (
    legal_review_dimension = 'legal'
  ),
  legal_decision text NOT NULL DEFAULT 'approved' CHECK (
    legal_decision = 'approved'
  ),
  commercial_review_dimension text NOT NULL DEFAULT 'commercial' CHECK (
    commercial_review_dimension = 'commercial'
  ),
  commercial_decision text NOT NULL DEFAULT 'approved' CHECK (
    commercial_decision = 'approved'
  ),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  reacceptance_class text NOT NULL CHECK (
    reacceptance_class IN ('none', 'affected_permissions', 'all_permissions')
  ),
  publication_reference text NOT NULL CHECK (
    publication_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  supersedes_event_id uuid,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, policy_pack_id, bundle_sha256, publication_state),
  UNIQUE (workspace_id, policy_pack_id, id),
  FOREIGN KEY (workspace_id, policy_pack_id, bundle_sha256)
    REFERENCES app_private.affiliate_compliance_policy_pack_versions (
      workspace_id, id, bundle_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, policy_pack_id, legal_review_event_id,
    bundle_sha256, legal_review_dimension, legal_decision
  ) REFERENCES app_private.affiliate_compliance_policy_review_events (
    workspace_id, policy_pack_id, id, bundle_sha256, review_dimension, decision
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, policy_pack_id, commercial_review_event_id,
    bundle_sha256, commercial_review_dimension, commercial_decision
  ) REFERENCES app_private.affiliate_compliance_policy_review_events (
    workspace_id, policy_pack_id, id, bundle_sha256, review_dimension, decision
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, policy_pack_id, supersedes_event_id)
    REFERENCES app_private.affiliate_compliance_policy_publication_events (
      workspace_id, policy_pack_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > effective_at)
);

CREATE TABLE app_private.affiliate_compliance_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_system text NOT NULL CHECK (
    source_system IN ('property-predator-main', 'legacy-import', 'test-fixture')
  ),
  source_subject_key text NOT NULL CHECK (
    source_subject_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  legal_identity_sha256 bytea NOT NULL CHECK (octet_length(legal_identity_sha256) = 32),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_system, source_subject_key),
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app_private.affiliate_compliance_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  lifecycle_status text NOT NULL CHECK (
    lifecycle_status IN (
      'account_only', 'application_draft', 'identity_review',
      'legal_bundle_presented', 'legal_accepted', 'training_required',
      'declarations_required', 'compliance_review', 'active_limited',
      'active', 'reacceptance_required', 'correction_required',
      'suspended_interim', 'suspended_final', 'terminated', 'withdrawn',
      'migrated_unverified'
    )
  ),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_-]{0,99}$'),
  occurred_at timestamptz NOT NULL,
  supersedes_event_id uuid,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, subject_id, id),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, subject_id, supersedes_event_id)
    REFERENCES app_private.affiliate_compliance_lifecycle_events (
      workspace_id, subject_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (occurred_at <= recorded_at + interval '30 seconds')
);

CREATE TABLE app_private.affiliate_compliance_acceptance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  policy_pack_id uuid NOT NULL,
  publication_event_id uuid NOT NULL,
  publication_state text NOT NULL DEFAULT 'published' CHECK (
    publication_state = 'published'
  ),
  bundle_sha256 bytea NOT NULL CHECK (octet_length(bundle_sha256) = 32),
  action text NOT NULL CHECK (action IN ('explicit_accept', 'explicit_decline')),
  accepted_legal_name_sha256 bytea NOT NULL CHECK (
    octet_length(accepted_legal_name_sha256) = 32
  ),
  capacity text NOT NULL CHECK (
    capacity IN ('self', 'director', 'authorised_signatory', 'other')
  ),
  capacity_verified boolean NOT NULL,
  affirmation_sha256 bytea NOT NULL CHECK (octet_length(affirmation_sha256) = 32),
  receipt_sha256 bytea NOT NULL CHECK (octet_length(receipt_sha256) = 32),
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz,
  authentication_strength text NOT NULL CHECK (
    authentication_strength IN ('session', 'verified_email', 'mfa')
  ),
  interface_version text NOT NULL CHECK (
    interface_version = btrim(interface_version)
    AND length(interface_version) BETWEEN 1 AND 100
  ),
  supersedes_event_id uuid,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, subject_id, id),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, policy_pack_id, bundle_sha256)
    REFERENCES app_private.affiliate_compliance_policy_pack_versions (
      workspace_id, id, bundle_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, publication_event_id, policy_pack_id,
    bundle_sha256, publication_state
  ) REFERENCES app_private.affiliate_compliance_policy_publication_events (
    workspace_id, id, policy_pack_id, bundle_sha256, publication_state
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, subject_id, supersedes_event_id)
    REFERENCES app_private.affiliate_compliance_acceptance_events (
      workspace_id, subject_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > occurred_at),
  CHECK (occurred_at <= recorded_at + interval '30 seconds'),
  CHECK (publication_state = 'published'),
  CHECK (action = 'explicit_accept' OR capacity_verified IS FALSE)
);

CREATE TABLE app_private.affiliate_compliance_training_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  training_key text NOT NULL CHECK (training_key ~ '^[a-z][a-z0-9_-]{0,99}$'),
  training_version text NOT NULL CHECK (
    training_version = btrim(training_version)
    AND length(training_version) BETWEEN 1 AND 100
  ),
  course_sha256 bytea NOT NULL CHECK (octet_length(course_sha256) = 32),
  quiz_sha256 bytea NOT NULL CHECK (octet_length(quiz_sha256) = 32),
  pass_percentage smallint NOT NULL CHECK (pass_percentage BETWEEN 1 AND 100),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, course_sha256, quiz_sha256),
  UNIQUE (workspace_id, training_key, training_version),
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app_private.affiliate_compliance_training_approval_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  training_version_id uuid NOT NULL,
  course_sha256 bytea NOT NULL CHECK (octet_length(course_sha256) = 32),
  quiz_sha256 bytea NOT NULL CHECK (octet_length(quiz_sha256) = 32),
  approval_state text NOT NULL CHECK (
    approval_state IN ('approved', 'rejected', 'withdrawn')
  ),
  approval_reference text NOT NULL CHECK (
    approval_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  approval_sha256 bytea NOT NULL CHECK (octet_length(approval_sha256) = 32),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  supersedes_event_id uuid,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, training_version_id, id),
  UNIQUE (
    workspace_id, id, training_version_id, course_sha256,
    quiz_sha256, approval_state
  ),
  FOREIGN KEY (
    workspace_id, training_version_id, course_sha256, quiz_sha256
  ) REFERENCES app_private.affiliate_compliance_training_versions (
    workspace_id, id, course_sha256, quiz_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, training_version_id, supersedes_event_id)
    REFERENCES app_private.affiliate_compliance_training_approval_events (
      workspace_id, training_version_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > effective_at),
  CHECK (effective_at <= recorded_at + interval '30 seconds')
);

CREATE TABLE app_private.affiliate_compliance_training_completion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  training_version_id uuid NOT NULL,
  training_approval_event_id uuid NOT NULL,
  training_approval_state text NOT NULL DEFAULT 'approved' CHECK (
    training_approval_state = 'approved'
  ),
  course_sha256 bytea NOT NULL CHECK (octet_length(course_sha256) = 32),
  quiz_sha256 bytea NOT NULL CHECK (octet_length(quiz_sha256) = 32),
  outcome text NOT NULL CHECK (outcome IN ('passed', 'failed', 'incomplete')),
  score_percentage smallint CHECK (score_percentage BETWEEN 0 AND 100),
  quiz_attempt_sha256 bytea NOT NULL CHECK (octet_length(quiz_attempt_sha256) = 32),
  attestation_sha256 bytea NOT NULL CHECK (octet_length(attestation_sha256) = 32),
  completed_at timestamptz NOT NULL,
  expires_at timestamptz,
  supersedes_event_id uuid,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, subject_id, id),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, training_version_id, course_sha256, quiz_sha256
  ) REFERENCES app_private.affiliate_compliance_training_versions (
    workspace_id, id, course_sha256, quiz_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, training_approval_event_id, training_version_id,
    course_sha256, quiz_sha256, training_approval_state
  ) REFERENCES app_private.affiliate_compliance_training_approval_events (
    workspace_id, id, training_version_id,
    course_sha256, quiz_sha256, approval_state
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, subject_id, supersedes_event_id)
    REFERENCES app_private.affiliate_compliance_training_completion_events (
      workspace_id, subject_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > completed_at),
  CHECK (completed_at <= recorded_at + interval '30 seconds'),
  CHECK ((outcome = 'incomplete') = (score_percentage IS NULL))
);

CREATE TABLE app_private.affiliate_compliance_declaration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  declaration_type text NOT NULL CHECK (
    declaration_type IN ('business_tax', 'disclosure_claims', 'data_protection')
  ),
  declaration_version text NOT NULL CHECK (
    declaration_version = btrim(declaration_version)
    AND length(declaration_version) BETWEEN 1 AND 100
  ),
  declaration_sha256 bytea NOT NULL CHECK (octet_length(declaration_sha256) = 32),
  decision text NOT NULL CHECK (decision IN ('affirmed', 'declined', 'withdrawn')),
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz,
  supersedes_event_id uuid,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, subject_id, id),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, subject_id, supersedes_event_id)
    REFERENCES app_private.affiliate_compliance_declaration_events (
      workspace_id, subject_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > occurred_at),
  CHECK (occurred_at <= recorded_at + interval '30 seconds')
);

CREATE TABLE app_private.affiliate_compliance_specialist_decision_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  decision_kind text NOT NULL CHECK (decision_kind IN (
    'pecr_sender_route', 'pecr_instigator_route',
    'affiliate_recruitment_policy', 'financial_promotion_perimeter',
    'consumer_eligibility_review', 'sanctions_screening'
  )),
  decision_scope_ref text NOT NULL CHECK (
    decision_scope_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  decision_state text NOT NULL CHECK (
    decision_state IN ('approved', 'blocked', 'withdrawn')
  ),
  route_classification text CHECK (route_classification IN (
    'solicited_request', 'individual_consent', 'individual_soft_opt_in',
    'corporate_subscriber_reg23', 'unknown'
  )),
  party_reference text CHECK (
    party_reference IS NULL OR (
      party_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
    )
  ),
  responsibility_reference text CHECK (
    responsibility_reference IS NULL OR (
      responsibility_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
    )
  ),
  specialist_reference text NOT NULL CHECK (
    specialist_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  decision_sha256 bytea NOT NULL CHECK (octet_length(decision_sha256) = 32),
  ownership_control_checked boolean NOT NULL DEFAULT false,
  freeze_or_hold_required boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  supersedes_event_id uuid,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, subject_id, id, decision_kind),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, subject_id, supersedes_event_id, decision_kind
  )
    REFERENCES app_private.affiliate_compliance_specialist_decision_events (
      workspace_id, subject_id, id, decision_kind
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (valid_from <= recorded_at + interval '30 seconds'),
  CHECK (
    decision_kind NOT IN ('pecr_sender_route', 'pecr_instigator_route')
    OR (
      route_classification IS NOT NULL
      AND party_reference IS NOT NULL
      AND responsibility_reference IS NOT NULL
    )
  ),
  CHECK (
    decision_state <> 'approved'
    OR decision_kind NOT IN ('pecr_sender_route', 'pecr_instigator_route')
    OR route_classification <> 'unknown'
  ),
  CHECK (
    decision_kind = 'sanctions_screening'
    OR (ownership_control_checked IS FALSE AND freeze_or_hold_required IS FALSE)
  ),
  CHECK (
    decision_kind <> 'sanctions_screening'
    OR decision_state <> 'approved'
    OR (ownership_control_checked IS TRUE AND freeze_or_hold_required IS FALSE)
  )
);

CREATE TABLE app_private.affiliate_compliance_channel_authority_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN (
    'affiliate_link', 'content_export', 'public_social',
    'affiliate_recruitment', 'email', 'sms', 'whatsapp', 'social_dm',
    'audience_upload', 'paid_advertising', 'phone', 'website_tracking',
    'payout'
  )),
  content_class text NOT NULL CHECK (content_class IN (
    'ordinary_product', 'affiliate_recruitment', 'property_investment',
    'operational_only'
  )),
  authority_state text NOT NULL CHECK (
    authority_state IN ('approved', 'blocked', 'revoked', 'expired')
  ),
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[a-z][a-z0-9_-]{0,99}$'),
  territory_code text NOT NULL CHECK (territory_code ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  sender_party_reference text NOT NULL CHECK (
    sender_party_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  account_scope_reference text NOT NULL CHECK (
    account_scope_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  authority_sha256 bytea NOT NULL CHECK (octet_length(authority_sha256) = 32),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  supersedes_event_id uuid,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, subject_id, id),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, subject_id, supersedes_event_id)
    REFERENCES app_private.affiliate_compliance_channel_authority_events (
      workspace_id, subject_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (valid_from <= recorded_at + interval '30 seconds'),
  CHECK (
    channel = 'affiliate_recruitment'
    OR content_class <> 'affiliate_recruitment'
  ),
  CHECK (
    channel <> 'affiliate_recruitment'
    OR content_class = 'affiliate_recruitment'
  )
);

CREATE TABLE app_private.affiliate_compliance_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  case_reference text NOT NULL CHECK (
    case_reference ~ '^[A-Z0-9][A-Z0-9._-]{0,99}$'
  ),
  event_type text NOT NULL CHECK (event_type IN (
    'opened', 'takedown_requested', 'correction_requested',
    'suspended_interim', 'suspended_final', 'reinstated', 'closed'
  )),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_-]{0,99}$'),
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  blocks_permissions boolean NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, subject_id, case_reference, id),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (occurred_at <= recorded_at + interval '30 seconds')
);

CREATE TABLE app_private.affiliate_compliance_permission_grant_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  permission text NOT NULL CHECK (permission IN (
    'affiliate_link.issue', 'content.export_linked',
    'public_social.manual_publish', 'public_social.provider_publish',
    'affiliate_recruitment.manual_publish',
    'affiliate_recruitment.provider_publish',
    'email.send', 'sms.send', 'whatsapp.send', 'social_dm.send',
    'audience.upload', 'paid_advertising.publish', 'phone.call',
    'website.track_optional', 'payout.release'
  )),
  grant_state text NOT NULL CHECK (
    grant_state IN ('requested', 'blocked', 'revoked', 'expired')
  ),
  policy_pack_id uuid NOT NULL,
  bundle_sha256 bytea NOT NULL CHECK (octet_length(bundle_sha256) = 32),
  channel_authority_event_id uuid,
  permission_scope_sha256 bytea NOT NULL CHECK (
    octet_length(permission_scope_sha256) = 32
  ),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_-]{0,99}$'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  provider_effects boolean NOT NULL DEFAULT false CHECK (provider_effects IS FALSE),
  supersedes_event_id uuid,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, subject_id, id),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, policy_pack_id, bundle_sha256)
    REFERENCES app_private.affiliate_compliance_policy_pack_versions (
      workspace_id, id, bundle_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, subject_id, channel_authority_event_id)
    REFERENCES app_private.affiliate_compliance_channel_authority_events (
      workspace_id, subject_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, subject_id, supersedes_event_id)
    REFERENCES app_private.affiliate_compliance_permission_grant_events (
      workspace_id, subject_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (valid_from <= recorded_at + interval '30 seconds')
);

CREATE TABLE app_private.affiliate_compliance_permission_decision_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  permission text NOT NULL CHECK (permission IN (
    'affiliate_link.issue', 'content.export_linked',
    'public_social.manual_publish', 'public_social.provider_publish',
    'affiliate_recruitment.manual_publish',
    'affiliate_recruitment.provider_publish',
    'email.send', 'sms.send', 'whatsapp.send', 'social_dm.send',
    'audience.upload', 'paid_advertising.publish', 'phone.call',
    'website.track_optional', 'payout.release'
  )),
  decision text NOT NULL CHECK (decision = 'deny'),
  reason_codes jsonb NOT NULL CHECK (
    jsonb_typeof(reason_codes) = 'array'
    AND jsonb_array_length(reason_codes) BETWEEN 1 AND 50
    AND octet_length(reason_codes::text) <= 8192
  ),
  policy_pack_id uuid,
  bundle_sha256 bytea CHECK (
    bundle_sha256 IS NULL OR octet_length(bundle_sha256) = 32
  ),
  evidence_snapshot_sha256 bytea NOT NULL CHECK (
    octet_length(evidence_snapshot_sha256) = 32
  ),
  evaluated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  provider_effects boolean NOT NULL DEFAULT false CHECK (provider_effects IS FALSE),
  previous_receipt_id uuid,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, subject_id, id),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, policy_pack_id, bundle_sha256)
    REFERENCES app_private.affiliate_compliance_policy_pack_versions (
      workspace_id, id, bundle_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, subject_id, previous_receipt_id)
    REFERENCES app_private.affiliate_compliance_permission_decision_receipts (
      workspace_id, subject_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (policy_pack_id IS NULL AND bundle_sha256 IS NULL)
    OR (policy_pack_id IS NOT NULL AND bundle_sha256 IS NOT NULL)
  ),
  CHECK (evaluated_at <= recorded_at + interval '30 seconds'),
  CHECK (expires_at > evaluated_at),
  CHECK (expires_at <= evaluated_at + interval '5 minutes')
);

CREATE FUNCTION app_private.stamp_affiliate_compliance_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  current_request text;
BEGIN
  current_request := app_private.current_request_id();
  IF current_request !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'Affiliate compliance request references must be opaque tokens'
      USING ERRCODE = '23514';
  END IF;
  NEW.recorded_by_user_id := app_private.current_user_id();
  NEW.recorded_request_id := current_request;
  NEW.recorded_at := statement_timestamp();
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_affiliate_compliance_policy_pack_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  document_ref jsonb;
  document_keys text[];
  seen_document_types text[] := ARRAY[]::text[];
  document_type text;
BEGIN
  FOR document_ref IN
    SELECT value FROM jsonb_array_elements(NEW.document_refs)
  LOOP
    IF jsonb_typeof(document_ref) <> 'object' THEN
      RAISE EXCEPTION 'Affiliate policy document references must be metadata objects'
        USING ERRCODE = '23514';
    END IF;
    SELECT array_agg(key ORDER BY key)
      INTO document_keys
    FROM jsonb_object_keys(document_ref) AS key;
    IF document_keys IS DISTINCT FROM ARRAY[
      'contentSha256', 'documentId', 'documentType', 'documentVersion'
    ]::text[] THEN
      RAISE EXCEPTION 'Affiliate policy document references have an unknown or missing field'
        USING ERRCODE = '23514';
    END IF;
    IF jsonb_typeof(document_ref -> 'contentSha256') <> 'string'
       OR jsonb_typeof(document_ref -> 'documentId') <> 'string'
       OR jsonb_typeof(document_ref -> 'documentType') <> 'string'
       OR jsonb_typeof(document_ref -> 'documentVersion') <> 'string'
       OR (document_ref ->> 'contentSha256') !~ '^[0-9a-f]{64}$'
       OR (document_ref ->> 'documentId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
       OR (document_ref ->> 'documentType') !~ '^[a-z][a-z0-9_-]{0,99}$'
       OR (document_ref ->> 'documentVersion') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' THEN
      RAISE EXCEPTION 'Affiliate policy document reference metadata is invalid'
        USING ERRCODE = '23514';
    END IF;
    document_type := document_ref ->> 'documentType';
    IF document_type = ANY(seen_document_types) THEN
      RAISE EXCEPTION 'Affiliate policy document types must be unique inside a bundle'
        USING ERRCODE = '23514';
    END IF;
    seen_document_types := array_append(seen_document_types, document_type);
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_affiliate_compliance_acceptance_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  selected_pack record;
BEGIN
  IF NEW.action = 'explicit_decline' THEN
    RETURN NEW;
  END IF;

  SELECT publication_state, effective_at, expires_at,
         legal_review_event_id, commercial_review_event_id
    INTO selected_pack
  FROM app_private.affiliate_compliance_policy_publication_events
  WHERE workspace_id = NEW.workspace_id
    AND id = NEW.publication_event_id
    AND policy_pack_id = NEW.policy_pack_id
    AND bundle_sha256 = NEW.bundle_sha256
    AND publication_state = NEW.publication_state;

  IF NOT FOUND
     OR selected_pack.publication_state <> 'published'
     OR selected_pack.effective_at IS NULL
     OR selected_pack.effective_at > NEW.occurred_at
     OR (selected_pack.expires_at IS NOT NULL
         AND selected_pack.expires_at <= NEW.occurred_at)
     OR EXISTS (
       SELECT 1
       FROM app_private.affiliate_compliance_policy_publication_events AS later
       WHERE later.workspace_id = NEW.workspace_id
         AND later.supersedes_event_id = NEW.publication_event_id
         AND later.effective_at <= NEW.occurred_at
     )
     OR EXISTS (
       SELECT 1
       FROM app_private.affiliate_compliance_policy_review_events AS later_review
       WHERE later_review.workspace_id = NEW.workspace_id
         AND later_review.supersedes_event_id IN (
           selected_pack.legal_review_event_id,
           selected_pack.commercial_review_event_id
         )
         AND later_review.occurred_at <= NEW.occurred_at
     ) THEN
    RAISE EXCEPTION 'Affiliate acceptance requires the exact current approved published bundle'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_affiliate_compliance_training_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  selected_training record;
BEGIN
  SELECT approval.approval_state, version.pass_percentage,
         approval.effective_at, approval.expires_at
    INTO selected_training
  FROM app_private.affiliate_compliance_training_approval_events AS approval
  JOIN app_private.affiliate_compliance_training_versions AS version
    ON version.workspace_id = approval.workspace_id
    AND version.id = approval.training_version_id
    AND version.course_sha256 = approval.course_sha256
    AND version.quiz_sha256 = approval.quiz_sha256
  WHERE approval.workspace_id = NEW.workspace_id
    AND approval.id = NEW.training_approval_event_id
    AND approval.training_version_id = NEW.training_version_id
    AND approval.course_sha256 = NEW.course_sha256
    AND approval.quiz_sha256 = NEW.quiz_sha256
    AND approval.approval_state = NEW.training_approval_state;

  IF NOT FOUND
     OR selected_training.approval_state <> 'approved'
     OR selected_training.effective_at IS NULL
     OR selected_training.effective_at > NEW.completed_at
     OR (selected_training.expires_at IS NOT NULL
         AND selected_training.expires_at <= NEW.completed_at)
     OR EXISTS (
       SELECT 1
       FROM app_private.affiliate_compliance_training_approval_events AS later
       WHERE later.workspace_id = NEW.workspace_id
         AND later.training_version_id = NEW.training_version_id
         AND later.supersedes_event_id = NEW.training_approval_event_id
         AND later.effective_at <= NEW.completed_at
     ) THEN
    RAISE EXCEPTION 'Affiliate training evidence requires an approved current version'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome = 'passed'
     AND (NEW.score_percentage IS NULL
          OR NEW.score_percentage < selected_training.pass_percentage) THEN
    RAISE EXCEPTION 'Affiliate training pass is below the approved threshold'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.reject_affiliate_compliance_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Affiliate compliance metadata, evidence and decisions are append-only'
    USING ERRCODE = '55000';
END;
$function$;

REVOKE ALL ON FUNCTION app_private.stamp_affiliate_compliance_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_affiliate_compliance_policy_pack_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_affiliate_compliance_acceptance_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_affiliate_compliance_training_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reject_affiliate_compliance_mutation() FROM PUBLIC;

DO $affiliate_compliance_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'affiliate_compliance_policy_pack_versions',
    'affiliate_compliance_policy_review_events',
    'affiliate_compliance_policy_publication_events',
    'affiliate_compliance_subjects',
    'affiliate_compliance_lifecycle_events',
    'affiliate_compliance_acceptance_events',
    'affiliate_compliance_training_versions',
    'affiliate_compliance_training_approval_events',
    'affiliate_compliance_training_completion_events',
    'affiliate_compliance_declaration_events',
    'affiliate_compliance_specialist_decision_events',
    'affiliate_compliance_channel_authority_events',
    'affiliate_compliance_case_events',
    'affiliate_compliance_permission_grant_events',
    'affiliate_compliance_permission_decision_receipts'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON app_private.%I
       FOR EACH ROW EXECUTE FUNCTION app_private.stamp_affiliate_compliance_insert()',
      table_name || '_stamp_insert', table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app_private.%I
       FOR EACH ROW EXECUTE FUNCTION app_private.reject_affiliate_compliance_mutation()',
      table_name || '_immutable', table_name
    );
  END LOOP;
END;
$affiliate_compliance_triggers$;

CREATE TRIGGER affiliate_compliance_acceptance_gate
BEFORE INSERT ON app_private.affiliate_compliance_acceptance_events
FOR EACH ROW EXECUTE FUNCTION app_private.guard_affiliate_compliance_acceptance_insert();

CREATE TRIGGER affiliate_compliance_policy_pack_metadata_gate
BEFORE INSERT ON app_private.affiliate_compliance_policy_pack_versions
FOR EACH ROW EXECUTE FUNCTION app_private.guard_affiliate_compliance_policy_pack_insert();

CREATE TRIGGER affiliate_compliance_training_gate
BEFORE INSERT ON app_private.affiliate_compliance_training_completion_events
FOR EACH ROW EXECUTE FUNCTION app_private.guard_affiliate_compliance_training_insert();

DO $affiliate_compliance_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'affiliate_compliance_policy_pack_versions',
    'affiliate_compliance_policy_review_events',
    'affiliate_compliance_policy_publication_events',
    'affiliate_compliance_subjects',
    'affiliate_compliance_lifecycle_events',
    'affiliate_compliance_acceptance_events',
    'affiliate_compliance_training_versions',
    'affiliate_compliance_training_approval_events',
    'affiliate_compliance_training_completion_events',
    'affiliate_compliance_declaration_events',
    'affiliate_compliance_specialist_decision_events',
    'affiliate_compliance_channel_authority_events',
    'affiliate_compliance_case_events',
    'affiliate_compliance_permission_grant_events',
    'affiliate_compliance_permission_decision_receipts'
  ]
  LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I FOR ALL TO r72_owner
       USING (true) WITH CHECK (true)',
      table_name || '_owner_all', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I FOR SELECT
       TO r72_web, r72_affiliate_compliance_command
       USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.has_active_workspace_membership(
           app_private.current_user_id(), workspace_id
         )
       )',
      table_name || '_workspace_select', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I FOR INSERT
       TO r72_affiliate_compliance_command
       WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND recorded_by_user_id = app_private.current_user_id()
         AND recorded_request_id = app_private.current_request_id()
         AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
       )',
      table_name || '_manager_insert', table_name
    );
  END LOOP;
END;
$affiliate_compliance_rls$;

GRANT SELECT ON
  app_private.affiliate_compliance_policy_pack_versions,
  app_private.affiliate_compliance_policy_review_events,
  app_private.affiliate_compliance_policy_publication_events,
  app_private.affiliate_compliance_subjects,
  app_private.affiliate_compliance_lifecycle_events,
  app_private.affiliate_compliance_acceptance_events,
  app_private.affiliate_compliance_training_versions,
  app_private.affiliate_compliance_training_approval_events,
  app_private.affiliate_compliance_training_completion_events,
  app_private.affiliate_compliance_declaration_events,
  app_private.affiliate_compliance_specialist_decision_events,
  app_private.affiliate_compliance_channel_authority_events,
  app_private.affiliate_compliance_case_events,
  app_private.affiliate_compliance_permission_grant_events,
  app_private.affiliate_compliance_permission_decision_receipts
TO r72_web, r72_affiliate_compliance_command;

GRANT INSERT ON
  app_private.affiliate_compliance_policy_pack_versions,
  app_private.affiliate_compliance_policy_review_events,
  app_private.affiliate_compliance_policy_publication_events,
  app_private.affiliate_compliance_subjects,
  app_private.affiliate_compliance_lifecycle_events,
  app_private.affiliate_compliance_acceptance_events,
  app_private.affiliate_compliance_training_versions,
  app_private.affiliate_compliance_training_approval_events,
  app_private.affiliate_compliance_training_completion_events,
  app_private.affiliate_compliance_declaration_events,
  app_private.affiliate_compliance_specialist_decision_events,
  app_private.affiliate_compliance_channel_authority_events,
  app_private.affiliate_compliance_case_events,
  app_private.affiliate_compliance_permission_grant_events,
  app_private.affiliate_compliance_permission_decision_receipts
TO r72_affiliate_compliance_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app_private', 'affiliate_compliance_policy_pack_versions', 'workspace_id'),
  ('app_private', 'affiliate_compliance_policy_review_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_policy_publication_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_subjects', 'workspace_id'),
  ('app_private', 'affiliate_compliance_lifecycle_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_acceptance_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_training_versions', 'workspace_id'),
  ('app_private', 'affiliate_compliance_training_approval_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_training_completion_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_declaration_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_specialist_decision_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_channel_authority_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_case_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_permission_grant_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_permission_decision_receipts', 'workspace_id');

DO $affiliate_compliance_capability_check$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'affiliate_compliance_policy_pack_versions',
    'affiliate_compliance_policy_review_events',
    'affiliate_compliance_policy_publication_events',
    'affiliate_compliance_subjects',
    'affiliate_compliance_lifecycle_events',
    'affiliate_compliance_acceptance_events',
    'affiliate_compliance_training_versions',
    'affiliate_compliance_training_approval_events',
    'affiliate_compliance_training_completion_events',
    'affiliate_compliance_declaration_events',
    'affiliate_compliance_specialist_decision_events',
    'affiliate_compliance_channel_authority_events',
    'affiliate_compliance_case_events',
    'affiliate_compliance_permission_grant_events',
    'affiliate_compliance_permission_decision_receipts'
  ]
  LOOP
    IF pg_catalog.has_table_privilege(
         'r72_web', 'app_private.' || table_name, 'INSERT'
       )
       OR pg_catalog.has_table_privilege(
         'r72_web', 'app_private.' || table_name, 'UPDATE'
       )
       OR pg_catalog.has_table_privilege(
         'r72_web', 'app_private.' || table_name, 'DELETE'
       )
       OR pg_catalog.has_table_privilege(
         'r72_affiliate_compliance_command',
         'app_private.' || table_name, 'UPDATE'
       )
       OR pg_catalog.has_table_privilege(
         'r72_affiliate_compliance_command',
         'app_private.' || table_name, 'DELETE'
       ) THEN
      RAISE EXCEPTION 'Unsafe affiliate compliance capability on %', table_name;
    END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege(
       'r72_affiliate_compliance_command', 'app.provider_operations', 'INSERT'
     )
     OR pg_catalog.pg_has_role(
       'r72_affiliate_compliance_command', 'r72_worker', 'MEMBER'
     )
     OR pg_catalog.pg_has_role(
       'r72_affiliate_compliance_command',
       'r72_provider_operation_definer', 'MEMBER'
     ) THEN
    RAISE EXCEPTION 'Affiliate compliance role unexpectedly has provider capability';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.check_constraints
    WHERE constraint_schema = 'app_private'
      AND constraint_name LIKE 'affiliate_compliance_permission_grant_events%'
      AND check_clause ~* '(granted|active)'
  ) THEN
    RAISE EXCEPTION 'Affiliate compliance migration must not create an active grant state';
  END IF;
END;
$affiliate_compliance_capability_check$;

RESET ROLE;
