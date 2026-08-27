-- Property Predator affiliate compliance: private, workspace-scoped metadata
-- and append-only evidence. No document bodies, personal contact details,
-- affiliate links, provider credentials or external-effect capability live here.

DO $affiliate_compliance_role$
DECLARE
  role_name text;
  role_record record;
  unsafe_memberships text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'r72_affiliate_draft_command',
    'r72_affiliate_lifecycle_command',
    'r72_affiliate_legal_command',
    'r72_affiliate_commercial_command',
    'r72_affiliate_acceptance_command',
    'r72_affiliate_capacity_command',
    'r72_affiliate_declaration_command',
    'r72_affiliate_training_authority_command',
    'r72_affiliate_training_evidence_command',
    'r72_affiliate_specialist_command',
    'r72_affiliate_channel_command',
    'r72_affiliate_effect_command',
    'r72_affiliate_case_command',
    'r72_affiliate_receipt_command'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name
    ) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT', role_name);
    END IF;

    SELECT rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
           rolreplication, rolbypassrls
      INTO role_record
    FROM pg_catalog.pg_roles
    WHERE rolname = role_name;
    IF role_record.rolsuper OR role_record.rolinherit OR role_record.rolcreaterole
       OR role_record.rolcreatedb OR NOT role_record.rolcanlogin
       OR role_record.rolreplication OR role_record.rolbypassrls THEN
      RAISE EXCEPTION 'Unsafe role attributes: %', role_name;
    END IF;

    EXECUTE format(
      'REVOKE r72_owner, r72_security_definer, r72_worker,
         r72_provider_operation_definer FROM %I', role_name
    );
    SELECT string_agg(parent.rolname, ', ' ORDER BY parent.rolname)
      INTO unsafe_memberships
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
    JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
    WHERE member.rolname = role_name;
    IF unsafe_memberships IS NOT NULL THEN
      RAISE EXCEPTION 'Unsafe affiliate compliance role membership for %: %',
        role_name, unsafe_memberships;
    END IF;
    EXECUTE format('GRANT %I TO %I', role_name, current_user);
  END LOOP;
END;
$affiliate_compliance_role$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_affiliate_draft_command, r72_affiliate_lifecycle_command,
    r72_affiliate_legal_command, r72_affiliate_commercial_command,
    r72_affiliate_acceptance_command, r72_affiliate_capacity_command,
    r72_affiliate_declaration_command,
    r72_affiliate_training_authority_command,
    r72_affiliate_training_evidence_command, r72_affiliate_specialist_command,
    r72_affiliate_channel_command, r72_affiliate_effect_command,
    r72_affiliate_case_command, r72_affiliate_receipt_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app, app_private
  FROM r72_affiliate_draft_command, r72_affiliate_lifecycle_command,
    r72_affiliate_legal_command, r72_affiliate_commercial_command,
    r72_affiliate_acceptance_command, r72_affiliate_capacity_command,
    r72_affiliate_declaration_command,
    r72_affiliate_training_authority_command,
    r72_affiliate_training_evidence_command, r72_affiliate_specialist_command,
    r72_affiliate_channel_command, r72_affiliate_effect_command,
    r72_affiliate_case_command, r72_affiliate_receipt_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_affiliate_draft_command, r72_affiliate_lifecycle_command,
    r72_affiliate_legal_command, r72_affiliate_commercial_command,
    r72_affiliate_acceptance_command, r72_affiliate_capacity_command,
    r72_affiliate_declaration_command,
    r72_affiliate_training_authority_command,
    r72_affiliate_training_evidence_command, r72_affiliate_specialist_command,
    r72_affiliate_channel_command, r72_affiliate_effect_command,
    r72_affiliate_case_command, r72_affiliate_receipt_command;
GRANT USAGE ON SCHEMA app, app_private
  TO r72_affiliate_draft_command, r72_affiliate_lifecycle_command,
    r72_affiliate_legal_command, r72_affiliate_commercial_command,
    r72_affiliate_acceptance_command, r72_affiliate_capacity_command,
    r72_affiliate_declaration_command,
    r72_affiliate_training_authority_command,
    r72_affiliate_training_evidence_command, r72_affiliate_specialist_command,
    r72_affiliate_channel_command, r72_affiliate_effect_command,
    r72_affiliate_case_command, r72_affiliate_receipt_command;
GRANT EXECUTE ON FUNCTION
  app_private.current_workspace_id(),
  app_private.current_user_id(),
  app_private.current_actor_kind(),
  app_private.current_request_id(),
  app_private.has_active_workspace_membership(uuid, uuid),
  app_private.can_manage_workspace(uuid, uuid)
TO r72_affiliate_draft_command, r72_affiliate_lifecycle_command,
  r72_affiliate_legal_command, r72_affiliate_commercial_command,
  r72_affiliate_acceptance_command, r72_affiliate_capacity_command,
  r72_affiliate_declaration_command,
  r72_affiliate_training_authority_command,
  r72_affiliate_training_evidence_command, r72_affiliate_specialist_command,
  r72_affiliate_channel_command, r72_affiliate_effect_command,
  r72_affiliate_case_command, r72_affiliate_receipt_command;

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
  reason_code text NOT NULL CHECK (reason_code IN (
    'account_created', 'application_started', 'identity_review_started',
    'legal_bundle_presented', 'legal_accepted', 'training_required',
    'declarations_required', 'compliance_review_started',
    'approved_activation', 'reacceptance_required', 'correction_required',
    'suspension_imposed', 'terminated_for_cause', 'affiliate_withdrawal',
    'migrated_unverified'
  )),
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
  CHECK (publication_state = 'published')
);

CREATE TABLE app_private.affiliate_compliance_capacity_decision_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  decision_state text NOT NULL CHECK (
    decision_state IN ('verified', 'blocked', 'withdrawn')
  ),
  capacity_reference text NOT NULL CHECK (
    capacity_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
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
    REFERENCES app_private.affiliate_compliance_capacity_decision_events (
      workspace_id, subject_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > occurred_at),
  CHECK (occurred_at <= recorded_at + interval '30 seconds')
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
  UNIQUE (workspace_id, id, training_key, course_sha256, quiz_sha256),
  UNIQUE (workspace_id, training_key, training_version),
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app_private.affiliate_compliance_training_approval_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  training_version_id uuid NOT NULL,
  training_key text NOT NULL CHECK (training_key ~ '^[a-z][a-z0-9_-]{0,99}$'),
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
  UNIQUE (workspace_id, training_key, id),
  UNIQUE (workspace_id, training_key, id, training_version_id),
  UNIQUE (
    workspace_id, id, training_key, training_version_id, course_sha256,
    quiz_sha256, approval_state
  ),
  FOREIGN KEY (
    workspace_id, training_version_id, training_key, course_sha256, quiz_sha256
  ) REFERENCES app_private.affiliate_compliance_training_versions (
    workspace_id, id, training_key, course_sha256, quiz_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, training_key, supersedes_event_id)
    REFERENCES app_private.affiliate_compliance_training_approval_events (
      workspace_id, training_key, id
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
  training_key text NOT NULL CHECK (training_key ~ '^[a-z][a-z0-9_-]{0,99}$'),
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
  UNIQUE (workspace_id, subject_id, training_key, id),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, training_version_id, training_key, course_sha256, quiz_sha256
  ) REFERENCES app_private.affiliate_compliance_training_versions (
    workspace_id, id, training_key, course_sha256, quiz_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, training_approval_event_id, training_key, training_version_id,
    course_sha256, quiz_sha256, training_approval_state
  ) REFERENCES app_private.affiliate_compliance_training_approval_events (
    workspace_id, id, training_key, training_version_id,
    course_sha256, quiz_sha256, approval_state
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, subject_id, training_key, supersedes_event_id)
    REFERENCES app_private.affiliate_compliance_training_completion_events (
      workspace_id, subject_id, training_key, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > completed_at),
  CHECK (outcome <> 'passed' OR expires_at IS NOT NULL),
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
  UNIQUE (workspace_id, subject_id, declaration_type, id),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, subject_id, declaration_type, supersedes_event_id)
    REFERENCES app_private.affiliate_compliance_declaration_events (
      workspace_id, subject_id, declaration_type, id
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
  action_scope_sha256 bytea NOT NULL CHECK (octet_length(action_scope_sha256) = 32),
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
  UNIQUE (workspace_id, subject_id, id, decision_kind, action_scope_sha256),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, subject_id, supersedes_event_id, decision_kind,
    action_scope_sha256
  )
    REFERENCES app_private.affiliate_compliance_specialist_decision_events (
      workspace_id, subject_id, id, decision_kind, action_scope_sha256
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
    decision_kind IN ('pecr_sender_route', 'pecr_instigator_route')
    OR (
      route_classification IS NULL
      AND party_reference IS NULL
      AND responsibility_reference IS NULL
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
    OR (
      ownership_control_checked IS TRUE
      AND freeze_or_hold_required IS FALSE
      AND valid_until IS NOT NULL
    )
  )
);

CREATE TABLE app_private.affiliate_compliance_channel_authority_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN (
    'affiliate_link', 'content_export', 'public_social',
    'affiliate_recruitment', 'email', 'sms', 'whatsapp', 'social_dm',
    'audience_upload', 'paid_ads', 'phone', 'tracking',
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
  action_scope_sha256 bytea NOT NULL CHECK (octet_length(action_scope_sha256) = 32),
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
  UNIQUE (workspace_id, subject_id, id, channel, action_scope_sha256),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, subject_id, supersedes_event_id, channel, action_scope_sha256
  )
    REFERENCES app_private.affiliate_compliance_channel_authority_events (
      workspace_id, subject_id, id, channel, action_scope_sha256
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
  ),
  CHECK (
    (channel IN ('audience_upload', 'phone', 'tracking', 'payout'))
      = (content_class = 'operational_only')
  )
);

CREATE TABLE app_private.affiliate_compliance_effect_evidence_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  effect_kind text NOT NULL CHECK (effect_kind IN (
    'content_classification', 'content_scope_approval',
    'rendered_disclosure_check', 'claim_evidence', 'recipient_route',
    'suppression', 'visitor_choice', 'payout_checks'
  )),
  decision_state text NOT NULL CHECK (
    decision_state IN ('satisfied', 'blocked', 'withdrawn')
  ),
  content_classification text CHECK (
    content_classification IS NULL
    OR content_classification IN ('ordinary_product', 'property_investment')
  ),
  action_scope_sha256 bytea NOT NULL CHECK (octet_length(action_scope_sha256) = 32),
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
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
  UNIQUE (workspace_id, subject_id, id, effect_kind, action_scope_sha256),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, subject_id, supersedes_event_id, effect_kind,
    action_scope_sha256
  ) REFERENCES app_private.affiliate_compliance_effect_evidence_events (
    workspace_id, subject_id, id, effect_kind, action_scope_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (valid_from <= recorded_at + interval '30 seconds'),
  CHECK (
    (effect_kind = 'content_classification')
      = (content_classification IS NOT NULL)
  ),
  CHECK (
    effect_kind <> 'content_classification'
    OR decision_state <> 'satisfied'
    OR content_classification IS NOT NULL
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
  hold_kind text NOT NULL CHECK (
    hold_kind IN ('reacceptance', 'correction', 'suspension', 'fraud', 'security')
  ),
  reason_code text NOT NULL CHECK (reason_code IN (
    'reacceptance_required', 'content_correction_required',
    'suspension_review', 'suspected_fraud', 'fraud_review',
    'security_incident', 'security_hold', 'policy_breach'
  )),
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  permission_effect text NOT NULL CHECK (permission_effect IN ('block', 'monitor')),
  occurred_at timestamptz NOT NULL,
  supersedes_event_id uuid,
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, subject_id, case_reference, id),
  UNIQUE (workspace_id, subject_id, case_reference, id, hold_kind),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, subject_id, case_reference, supersedes_event_id, hold_kind
  )
    REFERENCES app_private.affiliate_compliance_case_events (
      workspace_id, subject_id, case_reference, id, hold_kind
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (occurred_at <= recorded_at + interval '30 seconds')
);

CREATE TABLE app_private.affiliate_compliance_permission_fact_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  permission text NOT NULL CHECK (permission IN (
    'affiliate_link.issue', 'content.export_linked',
    'public_social.manual_publish', 'public_social.provider_publish',
    'affiliate_recruitment.manual_publish',
    'affiliate_recruitment.provider_publish',
    'email.send', 'sms.send', 'whatsapp.send', 'social_dm.send',
    'audience.upload', 'paid_ads.launch', 'phone.marketing',
    'affiliate_attribution.write', 'commission.payout'
  )),
  permission_state text NOT NULL CHECK (
    permission_state IN ('requested', 'blocked', 'revoked', 'expired')
  ),
  policy_pack_id uuid,
  bundle_sha256 bytea CHECK (
    bundle_sha256 IS NULL OR octet_length(bundle_sha256) = 32
  ),
  channel_authority_event_id uuid,
  channel text CHECK (channel IS NULL OR channel IN (
    'affiliate_link', 'content_export', 'public_social',
    'affiliate_recruitment', 'email', 'sms', 'whatsapp', 'social_dm',
    'audience_upload', 'paid_ads', 'phone', 'tracking', 'payout'
  )),
  action_scope_sha256 bytea NOT NULL CHECK (
    octet_length(action_scope_sha256) = 32
  ),
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  reason_code text NOT NULL CHECK (reason_code IN (
    'policy_gate', 'lifecycle_gate', 'case_gate', 'channel_gate',
    'specialist_gate', 'provider_effects_off', 'manual_block',
    'expired_evidence', 'revoked_authority'
  )),
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
  UNIQUE (
    workspace_id, subject_id, id, permission, action_scope_sha256
  ),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, policy_pack_id, bundle_sha256)
    REFERENCES app_private.affiliate_compliance_policy_pack_versions (
      workspace_id, id, bundle_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, subject_id, channel_authority_event_id, channel,
    action_scope_sha256
  )
    REFERENCES app_private.affiliate_compliance_channel_authority_events (
      workspace_id, subject_id, id, channel, action_scope_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, subject_id, supersedes_event_id, permission,
    action_scope_sha256
  )
    REFERENCES app_private.affiliate_compliance_permission_fact_events (
      workspace_id, subject_id, id, permission, action_scope_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (policy_pack_id IS NULL AND bundle_sha256 IS NULL)
    OR (policy_pack_id IS NOT NULL AND bundle_sha256 IS NOT NULL)
  ),
  CHECK (
    (channel_authority_event_id IS NULL AND channel IS NULL)
    OR (channel_authority_event_id IS NOT NULL AND channel IS NOT NULL)
  ),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (valid_from <= recorded_at + interval '30 seconds'),
  CHECK (channel IS NULL OR channel = CASE permission
    WHEN 'affiliate_link.issue' THEN 'affiliate_link'
    WHEN 'content.export_linked' THEN 'content_export'
    WHEN 'public_social.manual_publish' THEN 'public_social'
    WHEN 'public_social.provider_publish' THEN 'public_social'
    WHEN 'affiliate_recruitment.manual_publish' THEN 'affiliate_recruitment'
    WHEN 'affiliate_recruitment.provider_publish' THEN 'affiliate_recruitment'
    WHEN 'email.send' THEN 'email'
    WHEN 'sms.send' THEN 'sms'
    WHEN 'whatsapp.send' THEN 'whatsapp'
    WHEN 'social_dm.send' THEN 'social_dm'
    WHEN 'audience.upload' THEN 'audience_upload'
    WHEN 'paid_ads.launch' THEN 'paid_ads'
    WHEN 'phone.marketing' THEN 'phone'
    WHEN 'affiliate_attribution.write' THEN 'tracking'
    WHEN 'commission.payout' THEN 'payout'
  END)
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
    'audience.upload', 'paid_ads.launch', 'phone.marketing',
    'affiliate_attribution.write', 'commission.payout'
  )),
  decision text NOT NULL CHECK (decision = 'deny'),
  reason_codes text[] NOT NULL CHECK (
    cardinality(reason_codes) BETWEEN 1 AND 50
    AND reason_codes <@ ARRAY[
      'UNKNOWN_PERMISSION', 'EVIDENCE_INVALID', 'POLICY_PACK_MISSING',
      'LEGAL_APPROVAL_MISSING', 'COMMERCIAL_APPROVAL_MISSING',
      'POLICY_PACK_NOT_PUBLISHED', 'POLICY_PACK_NOT_EFFECTIVE',
      'POLICY_PACK_EXPIRED', 'ACCEPTANCE_MISSING',
      'ACCEPTANCE_BUNDLE_MISMATCH', 'ACCEPTANCE_EXPIRED',
      'SIGNATORY_AUTHORITY_UNVERIFIED', 'REACCEPTANCE_REQUIRED',
      'TRAINING_MISSING', 'TRAINING_EXPIRED',
      'BUSINESS_TAX_DECLARATION_MISSING',
      'DISCLOSURE_CLAIMS_ACKNOWLEDGEMENT_MISSING',
      'DATA_PROTECTION_DECLARATION_MISSING', 'LIFECYCLE_TERMINATED',
      'LIFECYCLE_WITHDRAWN', 'LIFECYCLE_NOT_ELIGIBLE',
      'PROMOTION_CHANNEL_NOT_APPROVED', 'CHANNEL_AUTHORITY_MISSING',
      'CONTENT_CLASSIFICATION_MISSING', 'CONTENT_SCOPE_NOT_APPROVED',
      'DISCLOSURE_CHECK_MISSING', 'CLAIM_EVIDENCE_MISSING',
      'RECIPIENT_ROUTE_MISSING', 'PECR_SENDER_ROUTE_MISSING',
      'PECR_INSTIGATOR_DECISION_MISSING',
      'AFFILIATE_RECRUITMENT_POLICY_MISSING',
      'FINANCIAL_PROMOTION_PERIMETER_MISSING',
      'CONSUMER_ELIGIBILITY_REVIEW_MISSING',
      'SANCTIONS_SCREENING_MISSING', 'SUPPRESSION_CHECK_FAILED',
      'VISITOR_CHOICE_MISSING', 'PAYOUT_CHECKS_MISSING',
      'PROVIDER_EFFECTS_OFF', 'PERMISSION_BLOCK_ACTIVE',
      'CORRECTION_REQUIRED', 'SUSPENSION_ACTIVE',
      'FRAUD_HOLD_ACTIVE', 'SECURITY_HOLD_ACTIVE'
    ]::text[]
  ),
  action_scope_sha256 bytea NOT NULL CHECK (octet_length(action_scope_sha256) = 32),
  decision_nonce_sha256 bytea NOT NULL CHECK (octet_length(decision_nonce_sha256) = 32),
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
  UNIQUE (
    workspace_id, subject_id, id, permission, action_scope_sha256
  ),
  UNIQUE (workspace_id, decision_nonce_sha256),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, policy_pack_id, bundle_sha256)
    REFERENCES app_private.affiliate_compliance_policy_pack_versions (
      workspace_id, id, bundle_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, subject_id, previous_receipt_id, permission,
    action_scope_sha256
  )
    REFERENCES app_private.affiliate_compliance_permission_decision_receipts (
      workspace_id, subject_id, id, permission, action_scope_sha256
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

CREATE TABLE app_private.affiliate_compliance_permission_use_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  permission text NOT NULL CHECK (permission IN (
    'affiliate_link.issue', 'content.export_linked',
    'public_social.manual_publish', 'public_social.provider_publish',
    'affiliate_recruitment.manual_publish',
    'affiliate_recruitment.provider_publish',
    'email.send', 'sms.send', 'whatsapp.send', 'social_dm.send',
    'audience.upload', 'paid_ads.launch', 'phone.marketing',
    'affiliate_attribution.write', 'commission.payout'
  )),
  -- Digest binds action + recipient/audience + content version + provider/account.
  action_scope_sha256 bytea NOT NULL CHECK (octet_length(action_scope_sha256) = 32),
  evidence_snapshot_sha256 bytea NOT NULL CHECK (
    octet_length(evidence_snapshot_sha256) = 32
  ),
  decision_nonce_sha256 bytea NOT NULL CHECK (
    octet_length(decision_nonce_sha256) = 32
  ),
  -- Audit-only consumption fact: never a permission grant or provider capability.
  eligibility_decision text NOT NULL DEFAULT 'allow' CHECK (
    eligibility_decision = 'allow'
  ),
  use_state text NOT NULL DEFAULT 'consumed' CHECK (use_state = 'consumed'),
  evaluated_at timestamptz NOT NULL,
  decision_expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL,
  provider_effects boolean NOT NULL DEFAULT false CHECK (provider_effects IS FALSE),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, decision_nonce_sha256),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (evaluated_at <= consumed_at),
  CHECK (consumed_at < decision_expires_at),
  CHECK (decision_expires_at <= evaluated_at + interval '5 minutes'),
  CHECK (consumed_at <= recorded_at + interval '30 seconds')
);

-- Every semantic evidence stream has exactly one root and at most one child per
-- predecessor. Composite foreign keys above keep a successor in the same scope;
-- these indexes make the history a canonical linear chain rather than a graph.
CREATE UNIQUE INDEX affiliate_policy_review_one_root
  ON app_private.affiliate_compliance_policy_review_events (
    workspace_id, policy_pack_id, review_dimension
  ) WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_policy_review_one_child
  ON app_private.affiliate_compliance_policy_review_events (
    workspace_id, policy_pack_id, review_dimension, supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_policy_publication_one_root
  ON app_private.affiliate_compliance_policy_publication_events (
    workspace_id, policy_pack_id
  ) WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_policy_publication_one_child
  ON app_private.affiliate_compliance_policy_publication_events (
    workspace_id, policy_pack_id, supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_lifecycle_one_root
  ON app_private.affiliate_compliance_lifecycle_events (workspace_id, subject_id)
  WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_lifecycle_one_child
  ON app_private.affiliate_compliance_lifecycle_events (
    workspace_id, subject_id, supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_acceptance_one_root
  ON app_private.affiliate_compliance_acceptance_events (workspace_id, subject_id)
  WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_acceptance_one_child
  ON app_private.affiliate_compliance_acceptance_events (
    workspace_id, subject_id, supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_capacity_one_root
  ON app_private.affiliate_compliance_capacity_decision_events (
    workspace_id, subject_id
  ) WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_capacity_one_child
  ON app_private.affiliate_compliance_capacity_decision_events (
    workspace_id, subject_id, supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_training_approval_one_root
  ON app_private.affiliate_compliance_training_approval_events (
    workspace_id, training_key
  ) WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_training_approval_one_child
  ON app_private.affiliate_compliance_training_approval_events (
    workspace_id, training_key, supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_training_completion_one_root
  ON app_private.affiliate_compliance_training_completion_events (
    workspace_id, subject_id, training_key
  ) WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_training_completion_one_child
  ON app_private.affiliate_compliance_training_completion_events (
    workspace_id, subject_id, training_key, supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_declaration_one_root
  ON app_private.affiliate_compliance_declaration_events (
    workspace_id, subject_id, declaration_type
  ) WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_declaration_one_child
  ON app_private.affiliate_compliance_declaration_events (
    workspace_id, subject_id, declaration_type, supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_specialist_one_root
  ON app_private.affiliate_compliance_specialist_decision_events (
    workspace_id, subject_id, decision_kind, action_scope_sha256
  ) WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_specialist_one_child
  ON app_private.affiliate_compliance_specialist_decision_events (
    workspace_id, subject_id, decision_kind, action_scope_sha256,
    supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_channel_one_root
  ON app_private.affiliate_compliance_channel_authority_events (
    workspace_id, subject_id, channel, action_scope_sha256
  ) WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_channel_one_child
  ON app_private.affiliate_compliance_channel_authority_events (
    workspace_id, subject_id, channel, action_scope_sha256, supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_effect_one_root
  ON app_private.affiliate_compliance_effect_evidence_events (
    workspace_id, subject_id, effect_kind, action_scope_sha256
  ) WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_effect_one_child
  ON app_private.affiliate_compliance_effect_evidence_events (
    workspace_id, subject_id, effect_kind, action_scope_sha256,
    supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_case_one_root
  ON app_private.affiliate_compliance_case_events (
    workspace_id, subject_id, case_reference
  ) WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_case_one_child
  ON app_private.affiliate_compliance_case_events (
    workspace_id, subject_id, case_reference, supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_permission_fact_one_root
  ON app_private.affiliate_compliance_permission_fact_events (
    workspace_id, subject_id, permission, action_scope_sha256
  ) WHERE supersedes_event_id IS NULL;
CREATE UNIQUE INDEX affiliate_permission_fact_one_child
  ON app_private.affiliate_compliance_permission_fact_events (
    workspace_id, subject_id, permission, action_scope_sha256,
    supersedes_event_id
  ) WHERE supersedes_event_id IS NOT NULL;
CREATE UNIQUE INDEX affiliate_decision_receipt_one_root
  ON app_private.affiliate_compliance_permission_decision_receipts (
    workspace_id, subject_id, permission, action_scope_sha256
  ) WHERE previous_receipt_id IS NULL;
CREATE UNIQUE INDEX affiliate_decision_receipt_one_child
  ON app_private.affiliate_compliance_permission_decision_receipts (
    workspace_id, subject_id, permission, action_scope_sha256,
    previous_receipt_id
  ) WHERE previous_receipt_id IS NOT NULL;

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
    AND version.training_key = approval.training_key
    AND version.course_sha256 = approval.course_sha256
    AND version.quiz_sha256 = approval.quiz_sha256
  WHERE approval.workspace_id = NEW.workspace_id
    AND approval.id = NEW.training_approval_event_id
    AND approval.training_version_id = NEW.training_version_id
    AND approval.training_key = NEW.training_key
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
          AND later.training_key = NEW.training_key
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
  role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'affiliate_compliance_policy_pack_versions',
    'affiliate_compliance_policy_review_events',
    'affiliate_compliance_policy_publication_events',
    'affiliate_compliance_subjects',
    'affiliate_compliance_lifecycle_events',
    'affiliate_compliance_acceptance_events',
    'affiliate_compliance_capacity_decision_events',
    'affiliate_compliance_training_versions',
    'affiliate_compliance_training_approval_events',
    'affiliate_compliance_training_completion_events',
    'affiliate_compliance_declaration_events',
    'affiliate_compliance_specialist_decision_events',
    'affiliate_compliance_channel_authority_events',
    'affiliate_compliance_effect_evidence_events',
    'affiliate_compliance_case_events',
    'affiliate_compliance_permission_fact_events',
    'affiliate_compliance_permission_decision_receipts',
    'affiliate_compliance_permission_use_receipts'
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
    'affiliate_compliance_capacity_decision_events',
    'affiliate_compliance_training_versions',
    'affiliate_compliance_training_approval_events',
    'affiliate_compliance_training_completion_events',
    'affiliate_compliance_declaration_events',
    'affiliate_compliance_specialist_decision_events',
    'affiliate_compliance_channel_authority_events',
    'affiliate_compliance_effect_evidence_events',
    'affiliate_compliance_case_events',
    'affiliate_compliance_permission_fact_events',
    'affiliate_compliance_permission_decision_receipts',
    'affiliate_compliance_permission_use_receipts'
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
       TO r72_web, r72_affiliate_draft_command, r72_affiliate_lifecycle_command,
          r72_affiliate_legal_command, r72_affiliate_commercial_command,
          r72_affiliate_acceptance_command, r72_affiliate_capacity_command,
          r72_affiliate_declaration_command,
          r72_affiliate_training_authority_command,
          r72_affiliate_training_evidence_command,
          r72_affiliate_specialist_command, r72_affiliate_channel_command,
          r72_affiliate_effect_command, r72_affiliate_case_command,
          r72_affiliate_receipt_command
       USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), workspace_id
         )
       )',
      table_name || '_workspace_select', table_name
    );
  END LOOP;
END;
$affiliate_compliance_rls$;

CREATE POLICY affiliate_policy_pack_draft_insert
  ON app_private.affiliate_compliance_policy_pack_versions FOR INSERT
  TO r72_affiliate_draft_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_subject_draft_insert
  ON app_private.affiliate_compliance_subjects FOR INSERT
  TO r72_affiliate_draft_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_lifecycle_authority_insert
  ON app_private.affiliate_compliance_lifecycle_events FOR INSERT
  TO r72_affiliate_lifecycle_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_legal_review_insert
  ON app_private.affiliate_compliance_policy_review_events FOR INSERT
  TO r72_affiliate_legal_command WITH CHECK (
    review_dimension = 'legal'
    AND workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_commercial_review_insert
  ON app_private.affiliate_compliance_policy_review_events FOR INSERT
  TO r72_affiliate_commercial_command WITH CHECK (
    review_dimension = 'commercial'
    AND workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_publication_commercial_insert
  ON app_private.affiliate_compliance_policy_publication_events FOR INSERT
  TO r72_affiliate_commercial_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_acceptance_evidence_insert
  ON app_private.affiliate_compliance_acceptance_events FOR INSERT
  TO r72_affiliate_acceptance_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_capacity_decision_insert
  ON app_private.affiliate_compliance_capacity_decision_events FOR INSERT
  TO r72_affiliate_capacity_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_declaration_evidence_insert
  ON app_private.affiliate_compliance_declaration_events FOR INSERT
  TO r72_affiliate_declaration_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_training_version_authority_insert
  ON app_private.affiliate_compliance_training_versions FOR INSERT
  TO r72_affiliate_training_authority_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_training_approval_authority_insert
  ON app_private.affiliate_compliance_training_approval_events FOR INSERT
  TO r72_affiliate_training_authority_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_training_completion_evidence_insert
  ON app_private.affiliate_compliance_training_completion_events FOR INSERT
  TO r72_affiliate_training_evidence_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_specialist_decision_insert
  ON app_private.affiliate_compliance_specialist_decision_events FOR INSERT
  TO r72_affiliate_specialist_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_channel_authority_insert
  ON app_private.affiliate_compliance_channel_authority_events FOR INSERT
  TO r72_affiliate_channel_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_effect_evidence_insert
  ON app_private.affiliate_compliance_effect_evidence_events FOR INSERT
  TO r72_affiliate_effect_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_case_evidence_insert
  ON app_private.affiliate_compliance_case_events FOR INSERT
  TO r72_affiliate_case_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_permission_fact_receipt_insert
  ON app_private.affiliate_compliance_permission_fact_events FOR INSERT
  TO r72_affiliate_receipt_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_deny_receipt_insert
  ON app_private.affiliate_compliance_permission_decision_receipts FOR INSERT
  TO r72_affiliate_receipt_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );
CREATE POLICY affiliate_nonce_use_receipt_insert
  ON app_private.affiliate_compliance_permission_use_receipts FOR INSERT
  TO r72_affiliate_receipt_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND recorded_by_user_id = app_private.current_user_id()
    AND recorded_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(recorded_by_user_id, workspace_id)
  );

GRANT SELECT ON
  app_private.affiliate_compliance_policy_pack_versions,
  app_private.affiliate_compliance_policy_review_events,
  app_private.affiliate_compliance_policy_publication_events,
  app_private.affiliate_compliance_subjects,
  app_private.affiliate_compliance_lifecycle_events,
  app_private.affiliate_compliance_acceptance_events,
  app_private.affiliate_compliance_capacity_decision_events,
  app_private.affiliate_compliance_training_versions,
  app_private.affiliate_compliance_training_approval_events,
  app_private.affiliate_compliance_training_completion_events,
  app_private.affiliate_compliance_declaration_events,
  app_private.affiliate_compliance_specialist_decision_events,
  app_private.affiliate_compliance_channel_authority_events,
  app_private.affiliate_compliance_effect_evidence_events,
  app_private.affiliate_compliance_case_events,
  app_private.affiliate_compliance_permission_fact_events,
  app_private.affiliate_compliance_permission_decision_receipts,
  app_private.affiliate_compliance_permission_use_receipts
TO r72_web, r72_affiliate_draft_command, r72_affiliate_lifecycle_command,
  r72_affiliate_legal_command, r72_affiliate_commercial_command,
  r72_affiliate_acceptance_command, r72_affiliate_capacity_command,
  r72_affiliate_declaration_command,
  r72_affiliate_training_authority_command,
  r72_affiliate_training_evidence_command, r72_affiliate_specialist_command,
  r72_affiliate_channel_command, r72_affiliate_effect_command,
  r72_affiliate_case_command, r72_affiliate_receipt_command;

GRANT INSERT ON
  app_private.affiliate_compliance_policy_pack_versions,
  app_private.affiliate_compliance_subjects
TO r72_affiliate_draft_command;
GRANT INSERT ON app_private.affiliate_compliance_lifecycle_events
TO r72_affiliate_lifecycle_command;
GRANT INSERT ON app_private.affiliate_compliance_policy_review_events
TO r72_affiliate_legal_command, r72_affiliate_commercial_command;
GRANT INSERT ON app_private.affiliate_compliance_policy_publication_events
TO r72_affiliate_commercial_command;
GRANT INSERT ON app_private.affiliate_compliance_acceptance_events
TO r72_affiliate_acceptance_command;
GRANT INSERT ON app_private.affiliate_compliance_capacity_decision_events
TO r72_affiliate_capacity_command;
GRANT INSERT ON app_private.affiliate_compliance_declaration_events
TO r72_affiliate_declaration_command;
GRANT INSERT ON
  app_private.affiliate_compliance_training_versions,
  app_private.affiliate_compliance_training_approval_events
TO r72_affiliate_training_authority_command;
GRANT INSERT ON app_private.affiliate_compliance_training_completion_events
TO r72_affiliate_training_evidence_command;
GRANT INSERT ON app_private.affiliate_compliance_specialist_decision_events
TO r72_affiliate_specialist_command;
GRANT INSERT ON app_private.affiliate_compliance_channel_authority_events
TO r72_affiliate_channel_command;
GRANT INSERT ON app_private.affiliate_compliance_effect_evidence_events
TO r72_affiliate_effect_command;
GRANT INSERT ON app_private.affiliate_compliance_case_events
TO r72_affiliate_case_command;
GRANT INSERT ON
  app_private.affiliate_compliance_permission_fact_events,
  app_private.affiliate_compliance_permission_decision_receipts,
  app_private.affiliate_compliance_permission_use_receipts
TO r72_affiliate_receipt_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app_private', 'affiliate_compliance_policy_pack_versions', 'workspace_id'),
  ('app_private', 'affiliate_compliance_policy_review_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_policy_publication_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_subjects', 'workspace_id'),
  ('app_private', 'affiliate_compliance_lifecycle_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_acceptance_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_capacity_decision_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_training_versions', 'workspace_id'),
  ('app_private', 'affiliate_compliance_training_approval_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_training_completion_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_declaration_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_specialist_decision_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_channel_authority_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_effect_evidence_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_case_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_permission_fact_events', 'workspace_id'),
  ('app_private', 'affiliate_compliance_permission_decision_receipts', 'workspace_id'),
  ('app_private', 'affiliate_compliance_permission_use_receipts', 'workspace_id');

DO $affiliate_compliance_capability_check$
DECLARE
  table_name text;
  role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'affiliate_compliance_policy_pack_versions',
    'affiliate_compliance_policy_review_events',
    'affiliate_compliance_policy_publication_events',
    'affiliate_compliance_subjects',
    'affiliate_compliance_lifecycle_events',
    'affiliate_compliance_acceptance_events',
    'affiliate_compliance_capacity_decision_events',
    'affiliate_compliance_training_versions',
    'affiliate_compliance_training_approval_events',
    'affiliate_compliance_training_completion_events',
    'affiliate_compliance_declaration_events',
    'affiliate_compliance_specialist_decision_events',
    'affiliate_compliance_channel_authority_events',
    'affiliate_compliance_effect_evidence_events',
    'affiliate_compliance_case_events',
    'affiliate_compliance_permission_fact_events',
    'affiliate_compliance_permission_decision_receipts',
    'affiliate_compliance_permission_use_receipts'
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
       THEN
      RAISE EXCEPTION 'Unsafe affiliate compliance capability on %', table_name;
    END IF;
    FOREACH role_name IN ARRAY ARRAY[
      'r72_affiliate_draft_command', 'r72_affiliate_lifecycle_command',
      'r72_affiliate_legal_command', 'r72_affiliate_commercial_command',
      'r72_affiliate_acceptance_command', 'r72_affiliate_capacity_command',
      'r72_affiliate_declaration_command',
      'r72_affiliate_training_authority_command',
      'r72_affiliate_training_evidence_command',
      'r72_affiliate_specialist_command', 'r72_affiliate_channel_command',
      'r72_affiliate_effect_command', 'r72_affiliate_case_command',
      'r72_affiliate_receipt_command'
    ]
    LOOP
      IF pg_catalog.has_table_privilege(
           role_name, 'app_private.' || table_name, 'UPDATE'
         ) OR pg_catalog.has_table_privilege(
           role_name, 'app_private.' || table_name, 'DELETE'
         ) THEN
        RAISE EXCEPTION 'Unsafe mutation capability for % on %', role_name, table_name;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH role_name IN ARRAY ARRAY[
    'r72_affiliate_draft_command', 'r72_affiliate_lifecycle_command',
    'r72_affiliate_legal_command', 'r72_affiliate_commercial_command',
    'r72_affiliate_acceptance_command', 'r72_affiliate_capacity_command',
    'r72_affiliate_declaration_command',
    'r72_affiliate_training_authority_command',
    'r72_affiliate_training_evidence_command',
    'r72_affiliate_specialist_command', 'r72_affiliate_channel_command',
    'r72_affiliate_effect_command', 'r72_affiliate_case_command',
    'r72_affiliate_receipt_command'
  ]
  LOOP
    IF pg_catalog.has_table_privilege(
         role_name, 'app.provider_operations', 'INSERT'
       ) OR pg_catalog.pg_has_role(role_name, 'r72_worker', 'MEMBER')
       OR pg_catalog.pg_has_role(
         role_name, 'r72_provider_operation_definer', 'MEMBER'
       ) THEN
      RAISE EXCEPTION 'Affiliate role % unexpectedly has provider capability', role_name;
    END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege(
       'r72_affiliate_draft_command',
       'app_private.affiliate_compliance_policy_review_events', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'r72_affiliate_draft_command',
       'app_private.affiliate_compliance_lifecycle_events', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'r72_affiliate_acceptance_command',
       'app_private.affiliate_compliance_capacity_decision_events', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'r72_affiliate_capacity_command',
       'app_private.affiliate_compliance_acceptance_events', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'r72_affiliate_capacity_command',
       'app_private.affiliate_compliance_declaration_events', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'r72_affiliate_declaration_command',
       'app_private.affiliate_compliance_acceptance_events', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'r72_affiliate_capacity_command',
       'app_private.affiliate_compliance_policy_review_events', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'r72_affiliate_training_evidence_command',
       'app_private.affiliate_compliance_training_approval_events', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'r72_affiliate_specialist_command',
       'app_private.affiliate_compliance_channel_authority_events', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'r72_affiliate_channel_command',
       'app_private.affiliate_compliance_specialist_decision_events', 'INSERT'
     ) THEN
    RAISE EXCEPTION 'Affiliate evidence authority separation is not intact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.check_constraints
    WHERE constraint_schema = 'app_private'
      AND constraint_name LIKE 'affiliate_compliance_permission_fact_events%'
      AND check_clause ~* '(granted|active)'
  ) THEN
    RAISE EXCEPTION 'Affiliate compliance migration must not create an active grant state';
  END IF;
END;
$affiliate_compliance_capability_check$;

RESET ROLE;
