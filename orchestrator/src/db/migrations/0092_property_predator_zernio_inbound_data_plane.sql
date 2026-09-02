-- Durable, replay-safe Zernio inbound evidence for Instagram DMs and
-- Instagram/LinkedIn comments on owned posts.
--
-- This boundary performs no provider call and owns no send capability. The
-- LOGIN is table-blind and may execute only the two bounded domain functions
-- plus the standard schema/installation readiness readers.
-- The function accepts signature-verification evidence from the isolated
-- webhook service, binds only an existing verified canonical social contact
-- point, and quarantines hash-only evidence when that exact match is absent or
-- conflicting. It never creates or merges a contact or contact point.

DO $roles$
DECLARE
  unsafe_parent text;
  unsafe_member text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_zernio_inbound_webhook_command'
  ) THEN
    CREATE ROLE r72_zernio_inbound_webhook_command LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_zernio_inbound_definer'
  ) THEN
    CREATE ROLE r72_zernio_inbound_definer NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_zernio_inbound_webhook_command'
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_zernio_inbound_definer'
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe Zernio inbound role attributes'
      USING ERRCODE = '42501';
  END IF;

  REVOKE r72_owner, r72_security_definer, r72_zernio_social_definer,
    r72_operational_inbox_definer, r72_daily_outreach_definer
  FROM r72_zernio_inbound_webhook_command, r72_zernio_inbound_definer;
  REVOKE r72_zernio_inbound_definer
  FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_zernio_social_command,
    r72_daily_outreach_command, r72_daily_outreach_read,
    r72_zernio_inbound_webhook_command;
  GRANT r72_zernio_inbound_definer TO r72_owner;

  SELECT parent.rolname INTO unsafe_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname IN (
    'r72_zernio_inbound_webhook_command', 'r72_zernio_inbound_definer'
  )
  LIMIT 1;
  IF unsafe_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Zernio inbound role parent: %', unsafe_parent
      USING ERRCODE = '42501';
  END IF;

  SELECT member.rolname INTO unsafe_member
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE (
    parent.rolname = 'r72_zernio_inbound_webhook_command'
    OR (parent.rolname = 'r72_zernio_inbound_definer'
        AND member.rolname <> 'r72_owner')
  )
  LIMIT 1;
  IF unsafe_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Zernio inbound role member: %', unsafe_member
      USING ERRCODE = '42501';
  END IF;
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_zernio_inbound_webhook_command, r72_zernio_inbound_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_zernio_inbound_webhook_command, r72_zernio_inbound_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_zernio_inbound_webhook_command, r72_zernio_inbound_definer;
REVOKE CREATE ON SCHEMA public
  FROM r72_zernio_inbound_webhook_command, r72_zernio_inbound_definer;
GRANT USAGE ON SCHEMA app, app_private
  TO r72_zernio_inbound_webhook_command, r72_zernio_inbound_definer;

-- LinkedIn comments are genuine Inbox conversations, not Instagram aliases.
-- Extend only the canonical channel vocabulary needed to preserve that truth.
ALTER TABLE app.channel_endpoints
  DROP CONSTRAINT channel_endpoints_channel_check;
ALTER TABLE app.channel_endpoints
  ADD CONSTRAINT channel_endpoints_channel_check
  CHECK (channel IN (
    'email', 'sms', 'whatsapp', 'instagram', 'facebook', 'linkedin'
  )) NOT VALID;
ALTER TABLE app.channel_endpoints
  VALIDATE CONSTRAINT channel_endpoints_channel_check;

ALTER TABLE app.inboxes DROP CONSTRAINT inboxes_channel_check;
ALTER TABLE app.inboxes ADD CONSTRAINT inboxes_channel_check
  CHECK (channel IN (
    'email', 'sms', 'whatsapp', 'instagram', 'facebook', 'linkedin'
  )) NOT VALID;
ALTER TABLE app.inboxes VALIDATE CONSTRAINT inboxes_channel_check;

ALTER TABLE app.conversations DROP CONSTRAINT conversations_channel_check;
ALTER TABLE app.conversations ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN (
    'email', 'sms', 'whatsapp', 'instagram', 'facebook', 'linkedin'
  )) NOT VALID;
ALTER TABLE app.conversations VALIDATE CONSTRAINT conversations_channel_check;

ALTER TABLE app.messages DROP CONSTRAINT messages_channel_check;
ALTER TABLE app.messages ADD CONSTRAINT messages_channel_check
  CHECK (channel IN (
    'email', 'sms', 'whatsapp', 'instagram', 'facebook', 'linkedin'
  )) NOT VALID;
ALTER TABLE app.messages VALIDATE CONSTRAINT messages_channel_check;

ALTER TABLE app.message_versions
  DROP CONSTRAINT message_versions_channel_check;
ALTER TABLE app.message_versions
  ADD CONSTRAINT message_versions_channel_check
  CHECK (channel IN (
    'email', 'sms', 'whatsapp', 'instagram', 'facebook', 'linkedin'
  )) NOT VALID;
ALTER TABLE app.message_versions
  VALIDATE CONSTRAINT message_versions_channel_check;

ALTER TABLE app.property_predator_admin_call_task_origins
  DROP CONSTRAINT property_predator_admin_call_task_origins_source_channel_check;
ALTER TABLE app.property_predator_admin_call_task_origins
  ADD CONSTRAINT property_predator_admin_call_task_origins_source_channel_check
  CHECK (source_channel IN (
    'email', 'sms', 'whatsapp', 'instagram', 'facebook', 'linkedin'
  )) NOT VALID;
ALTER TABLE app.property_predator_admin_call_task_origins
  VALIDATE CONSTRAINT property_predator_admin_call_task_origins_source_channel_check;

ALTER TABLE app.property_predator_admin_call_task_origins
  DROP CONSTRAINT property_predator_admin_call_task_origins_source_provider_check;
ALTER TABLE app.property_predator_admin_call_task_origins
  ADD CONSTRAINT property_predator_admin_call_task_origins_source_provider_check
  CHECK (source_provider IN (
    'operator', 'mailgun_eu', 'twilio_messaging',
    'meta_whatsapp_cloud', 'zernio'
  )) NOT VALID;
ALTER TABLE app.property_predator_admin_call_task_origins
  VALIDATE CONSTRAINT property_predator_admin_call_task_origins_source_provider_check;

-- This exact account tuple allows every receipt to retain a real FK to the
-- already connected Zernio account whose hashes it claims.
ALTER TABLE app.property_predator_zernio_accounts
  ADD CONSTRAINT property_predator_zernio_accounts_inbound_exact_uq
  UNIQUE (
    workspace_id, id, provider_connection_id,
    provider_account_id_sha256, network
  );

-- Authentication, routing and person resolution are explicit account-scoped
-- bindings. They contain hashes and canonical UUIDs only: no webhook secret,
-- provider identifier, username, message body or attachment URL is retained.
ALTER TABLE app.property_predator_zernio_accounts
  ADD CONSTRAINT property_predator_zernio_accounts_inbound_profile_uq
  UNIQUE (
    workspace_id, id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network
  );
ALTER TABLE app.inboxes
  ADD CONSTRAINT inboxes_zernio_inbound_exact_uq
  UNIQUE (
    workspace_id, id, provider_connection_id, channel, environment
  );

CREATE TABLE app.property_predator_zernio_inbound_credential_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  provider_profile_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_profile_id_sha256) = 32),
  credential_version_sha256 bytea NOT NULL
    CHECK (octet_length(credential_version_sha256) = 32),
  credential_binding_sha256 bytea NOT NULL
    CHECK (octet_length(credential_binding_sha256) = 32),
  environment text NOT NULL DEFAULT 'live' CHECK (environment = 'live'),
  state text NOT NULL DEFAULT 'active' CHECK (state = 'active'),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  CONSTRAINT zernio_inbound_credential_binding_uq UNIQUE (
    workspace_id, provider_connection_id, provider_profile_id_sha256,
    credential_version_sha256, credential_binding_sha256
  ),
  CONSTRAINT zernio_inbound_credential_binding_exact_uq UNIQUE (
    workspace_id, id, provider_connection_id,
    provider_profile_id_sha256, credential_version_sha256,
    credential_binding_sha256
  ),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections
      (workspace_id, id, environment) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_zernio_inbound_inbox_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  zernio_account_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('instagram', 'linkedin')),
  provider_profile_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_profile_id_sha256) = 32),
  provider_account_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_account_id_sha256) = 32),
  inbox_id uuid NOT NULL,
  environment text NOT NULL DEFAULT 'live' CHECK (environment = 'live'),
  state text NOT NULL DEFAULT 'active' CHECK (state = 'active'),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  CONSTRAINT zernio_inbound_inbox_account_uq
    UNIQUE (workspace_id, zernio_account_id),
  CONSTRAINT zernio_inbound_inbox_id_uq
    UNIQUE (workspace_id, inbox_id),
  CONSTRAINT zernio_inbound_inbox_binding_exact_uq UNIQUE (
    workspace_id, id, zernio_account_id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network, inbox_id
  ),
  CONSTRAINT zernio_inbound_inbox_projection_uq UNIQUE (
    workspace_id, id, zernio_account_id, network, inbox_id
  ),
  FOREIGN KEY (
    workspace_id, zernio_account_id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network
  ) REFERENCES app.property_predator_zernio_accounts (
    workspace_id, id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, inbox_id, provider_connection_id, network, environment
  ) REFERENCES app.inboxes (
    workspace_id, id, provider_connection_id, channel, environment
  ) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_zernio_inbound_person_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  zernio_account_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('instagram', 'linkedin')),
  provider_profile_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_profile_id_sha256) = 32),
  provider_account_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_account_id_sha256) = 32),
  provider_person_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_person_id_sha256) = 32),
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state = 'active'),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  CONSTRAINT zernio_inbound_person_identity_uq UNIQUE (
    workspace_id, zernio_account_id, provider_person_id_sha256
  ),
  CONSTRAINT zernio_inbound_person_point_uq UNIQUE (
    workspace_id, zernio_account_id, contact_point_id
  ),
  CONSTRAINT zernio_inbound_person_binding_exact_uq UNIQUE (
    workspace_id, id, zernio_account_id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network,
    provider_person_id_sha256, contact_point_id, contact_id
  ),
  CONSTRAINT zernio_inbound_person_projection_uq UNIQUE (
    workspace_id, id, zernio_account_id, network, contact_point_id, contact_id
  ),
  FOREIGN KEY (
    workspace_id, zernio_account_id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network
  ) REFERENCES app.property_predator_zernio_accounts (
    workspace_id, id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points
      (workspace_id, id, contact_id) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_zernio_inbound_owned_author_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  zernio_account_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('instagram', 'linkedin')),
  provider_profile_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_profile_id_sha256) = 32),
  provider_account_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_account_id_sha256) = 32),
  provider_owned_author_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_owned_author_id_sha256) = 32),
  state text NOT NULL DEFAULT 'active' CHECK (state = 'active'),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  CONSTRAINT zernio_inbound_owned_author_account_uq UNIQUE (
    workspace_id, zernio_account_id
  ),
  FOREIGN KEY (
    workspace_id, zernio_account_id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network
  ) REFERENCES app.property_predator_zernio_accounts (
    workspace_id, id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network
  ) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_zernio_inbound_transport_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  credential_binding_id uuid NOT NULL,
  zernio_account_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('instagram', 'linkedin')),
  inbound_kind text NOT NULL CHECK (
    inbound_kind IN ('instagram_dm', 'owned_post_comment')
  ),
  provider_profile_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_profile_id_sha256) = 32),
  credential_version_sha256 bytea NOT NULL
    CHECK (octet_length(credential_version_sha256) = 32),
  credential_binding_sha256 bytea NOT NULL
    CHECK (octet_length(credential_binding_sha256) = 32),
  provider_account_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_account_id_sha256) = 32),
  provider_person_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_person_id_sha256) = 32),
  provider_thread_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_thread_id_sha256) = 32),
  provider_event_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_event_id_sha256) = 32),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  signature_sha256 bytea NOT NULL CHECK (octet_length(signature_sha256) = 32),
  event_identity_sha256 bytea NOT NULL
    CHECK (octet_length(event_identity_sha256) = 32),
  delivery_identity_sha256 bytea NOT NULL
    CHECK (octet_length(delivery_identity_sha256) = 32),
  provider_ownership_assertion text NOT NULL CHECK (
    provider_ownership_assertion IN ('not_applicable', 'not_owned', 'unknown')
  ),
  signature_verified_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  request_id text NOT NULL CHECK (
    request_id = btrim(request_id)
    AND length(request_id) BETWEEN 1 AND 128
    AND request_id !~ '[^[:graph:]]'
  ),
  UNIQUE (workspace_id, id),
  CONSTRAINT zernio_inbound_transport_delivery_uq
    UNIQUE (workspace_id, delivery_identity_sha256),
  FOREIGN KEY (
    workspace_id, credential_binding_id, provider_connection_id,
    provider_profile_id_sha256, credential_version_sha256,
    credential_binding_sha256
  ) REFERENCES app.property_predator_zernio_inbound_credential_bindings (
    workspace_id, id, provider_connection_id,
    provider_profile_id_sha256, credential_version_sha256,
    credential_binding_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, zernio_account_id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network
  ) REFERENCES app.property_predator_zernio_accounts (
    workspace_id, id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network
  ) ON DELETE RESTRICT,
  CHECK (
    (inbound_kind = 'instagram_dm' AND network = 'instagram')
    OR inbound_kind = 'owned_post_comment'
  ),
  CHECK (
    (inbound_kind = 'instagram_dm'
      AND provider_ownership_assertion = 'not_applicable')
    OR (inbound_kind = 'owned_post_comment'
      AND provider_ownership_assertion IN ('not_owned', 'unknown'))
  ),
  CHECK (
    signature_verified_at <= received_at + interval '30 seconds'
    AND signature_verified_at >= received_at - interval '10 minutes'
  )
);

CREATE TABLE app.property_predator_zernio_inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  transport_receipt_id uuid NOT NULL,
  credential_binding_id uuid NOT NULL,
  zernio_account_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('instagram', 'linkedin')),
  inbound_kind text NOT NULL CHECK (
    inbound_kind IN ('instagram_dm', 'owned_post_comment')
  ),
  provider_account_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_account_id_sha256) = 32),
  provider_profile_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_profile_id_sha256) = 32),
  credential_version_sha256 bytea NOT NULL
    CHECK (octet_length(credential_version_sha256) = 32),
  credential_binding_sha256 bytea NOT NULL
    CHECK (octet_length(credential_binding_sha256) = 32),
  provider_person_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_person_id_sha256) = 32),
  provider_thread_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_thread_id_sha256) = 32),
  provider_event_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_event_id_sha256) = 32),
  event_key_sha256 bytea NOT NULL CHECK (octet_length(event_key_sha256) = 32),
  event_identity_sha256 bytea NOT NULL
    CHECK (octet_length(event_identity_sha256) = 32),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  provider_ownership_assertion text NOT NULL CHECK (
    provider_ownership_assertion IN ('not_applicable', 'not_owned', 'unknown')
  ),
  admission_disposition text NOT NULL CHECK (
    admission_disposition IN ('projected', 'quarantined')
  ),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, transport_receipt_id),
  CONSTRAINT zernio_inbound_event_key_uq
    UNIQUE (workspace_id, event_key_sha256),
  FOREIGN KEY (workspace_id, transport_receipt_id)
    REFERENCES app.property_predator_zernio_inbound_transport_receipts
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, credential_binding_id, provider_connection_id,
    provider_profile_id_sha256, credential_version_sha256,
    credential_binding_sha256
  ) REFERENCES app.property_predator_zernio_inbound_credential_bindings (
    workspace_id, id, provider_connection_id,
    provider_profile_id_sha256, credential_version_sha256,
    credential_binding_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, zernio_account_id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network
  ) REFERENCES app.property_predator_zernio_accounts (
    workspace_id, id, provider_connection_id,
    provider_profile_id_sha256, provider_account_id_sha256, network
  ) ON DELETE RESTRICT,
  CHECK (
    (inbound_kind = 'instagram_dm' AND network = 'instagram')
    OR inbound_kind = 'owned_post_comment'
  ),
  CHECK (
    (inbound_kind = 'instagram_dm'
      AND provider_ownership_assertion = 'not_applicable')
    OR (inbound_kind = 'owned_post_comment'
      AND provider_ownership_assertion IN ('not_owned', 'unknown'))
  ),
  CHECK (occurred_at <= recorded_at + interval '5 minutes')
);

CREATE INDEX property_predator_zernio_inbound_events_time_idx
  ON app.property_predator_zernio_inbound_events
    (workspace_id, occurred_at DESC, id DESC);

CREATE TABLE app.property_predator_zernio_inbound_quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  transport_receipt_id uuid NOT NULL,
  event_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('instagram', 'linkedin')),
  inbound_kind text NOT NULL CHECK (
    inbound_kind IN ('instagram_dm', 'owned_post_comment')
  ),
  reason_code text NOT NULL CHECK (reason_code IN (
    'provider_event_conflict', 'unmatched_contact_point',
    'conflicting_contact_point', 'inbox_not_composed',
    'assignee_not_available', 'owned_author_binding_missing',
    'owned_author_comment'
  )),
  provider_account_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_account_id_sha256) = 32),
  provider_person_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_person_id_sha256) = 32),
  provider_event_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_event_id_sha256) = 32),
  provider_ownership_assertion text NOT NULL CHECK (
    provider_ownership_assertion IN ('not_applicable', 'not_owned', 'unknown')
  ),
  conflict_fingerprint_sha256 bytea NOT NULL
    CHECK (octet_length(conflict_fingerprint_sha256) = 32),
  review_state text NOT NULL DEFAULT 'pending' CHECK (review_state = 'pending'),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (
    workspace_id, transport_receipt_id,
    reason_code, conflict_fingerprint_sha256
  ),
  FOREIGN KEY (workspace_id, transport_receipt_id)
    REFERENCES app.property_predator_zernio_inbound_transport_receipts
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES app.property_predator_zernio_inbound_events
      (workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (inbound_kind = 'instagram_dm' AND network = 'instagram'
      AND provider_ownership_assertion = 'not_applicable')
    OR (inbound_kind = 'owned_post_comment'
      AND provider_ownership_assertion IN ('not_owned', 'unknown'))
  )
);

CREATE INDEX property_predator_zernio_inbound_quarantine_queue_idx
  ON app.property_predator_zernio_inbound_quarantine
    (workspace_id, recorded_at, id);

CREATE TABLE app.property_predator_zernio_inbound_projections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  transport_receipt_id uuid NOT NULL,
  event_id uuid NOT NULL,
  zernio_account_id uuid NOT NULL,
  account_inbox_binding_id uuid NOT NULL,
  person_binding_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('instagram', 'linkedin')),
  inbound_kind text NOT NULL CHECK (
    inbound_kind IN ('instagram_dm', 'owned_post_comment')
  ),
  inbox_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  inbound_message_id uuid NOT NULL,
  inbound_message_version_id uuid NOT NULL,
  inbound_version_number integer NOT NULL DEFAULT 1
    CHECK (inbound_version_number = 1),
  admin_review_task_id uuid NOT NULL,
  admin_call_origin_id uuid NOT NULL,
  lead360_activity_id uuid NOT NULL,
  outreach_attempt_receipt_id uuid,
  outreach_outcome_candidate text NOT NULL DEFAULT 'replied'
    CHECK (outreach_outcome_candidate = 'replied'),
  outreach_candidate_disposition text NOT NULL CHECK (
    outreach_candidate_disposition IN ('linked', 'unlinked')
  ),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  event_identity_sha256 bytea NOT NULL
    CHECK (octet_length(event_identity_sha256) = 32),
  occurred_at timestamptz NOT NULL,
  request_id text NOT NULL CHECK (
    request_id = btrim(request_id)
    AND length(request_id) BETWEEN 1 AND 128
    AND request_id !~ '[^[:graph:]]'
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, event_id),
  UNIQUE (workspace_id, inbound_message_id),
  UNIQUE (workspace_id, admin_review_task_id),
  UNIQUE (workspace_id, admin_call_origin_id),
  UNIQUE (workspace_id, lead360_activity_id),
  FOREIGN KEY (workspace_id, transport_receipt_id)
    REFERENCES app.property_predator_zernio_inbound_transport_receipts
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES app.property_predator_zernio_inbound_events
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, zernio_account_id)
    REFERENCES app.property_predator_zernio_accounts
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, account_inbox_binding_id, zernio_account_id,
    network, inbox_id
  ) REFERENCES app.property_predator_zernio_inbound_inbox_bindings
      (workspace_id, id, zernio_account_id, network, inbox_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, person_binding_id, zernio_account_id,
    network, contact_point_id, contact_id
  ) REFERENCES app.property_predator_zernio_inbound_person_bindings
      (workspace_id, id, zernio_account_id, network, contact_point_id, contact_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, inbox_id)
    REFERENCES app.inboxes (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id, contact_id)
    REFERENCES app.conversations
      (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points
      (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, conversation_id, inbound_message_id,
    inbound_message_version_id, inbound_version_number, body_sha256
  ) REFERENCES app.message_versions (
    workspace_id, conversation_id, message_id,
    id, version_number, body_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, admin_review_task_id)
    REFERENCES app.tasks (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, admin_call_origin_id)
    REFERENCES app.property_predator_admin_call_task_origins
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, lead360_activity_id)
    REFERENCES app.activities (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, outreach_attempt_receipt_id)
    REFERENCES app_private.daily_outreach_manual_attempt_receipts
      (workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (outreach_candidate_disposition = 'linked'
      AND outreach_attempt_receipt_id IS NOT NULL)
    OR (outreach_candidate_disposition = 'unlinked'
      AND outreach_attempt_receipt_id IS NULL)
  ),
  CHECK (
    (inbound_kind = 'instagram_dm' AND network = 'instagram')
    OR inbound_kind = 'owned_post_comment'
  ),
  CHECK (recorded_at >= occurred_at - interval '5 minutes')
);

CREATE INDEX property_predator_zernio_inbound_projection_conversation_idx
  ON app.property_predator_zernio_inbound_projections
    (workspace_id, conversation_id, occurred_at DESC, id DESC);

CREATE FUNCTION app_private.reject_zernio_inbound_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Zernio inbound evidence is append-only'
    USING ERRCODE = '55000';
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION app_private.reject_zernio_inbound_evidence_mutation()
  FROM PUBLIC;

DO $immutable$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'property_predator_zernio_inbound_credential_bindings',
    'property_predator_zernio_inbound_inbox_bindings',
    'property_predator_zernio_inbound_person_bindings',
    'property_predator_zernio_inbound_owned_author_bindings',
    'property_predator_zernio_inbound_transport_receipts',
    'property_predator_zernio_inbound_events',
    'property_predator_zernio_inbound_quarantine',
    'property_predator_zernio_inbound_projections'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I
       FOR EACH ROW EXECUTE FUNCTION app_private.reject_zernio_inbound_evidence_mutation()',
      'zernio_inbound_' || substring(pg_catalog.md5(table_name) FROM 1 FOR 12)
        || '_append_only',
      table_name
    );
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_owner
       USING (true) WITH CHECK (true)',
      'zernio_inbound_' || substring(pg_catalog.md5(table_name) FROM 1 FOR 12)
        || '_owner_all',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_zernio_inbound_definer
       USING (
         workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
         AND current_setting(''app.actor_kind'', true) = ''webhook''
       )',
      'zernio_inbound_' || substring(pg_catalog.md5(table_name) FROM 1 FOR 12)
        || '_definer_select',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR INSERT TO r72_zernio_inbound_definer
       WITH CHECK (
         workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
         AND current_setting(''app.actor_kind'', true) = ''webhook''
       )',
      'zernio_inbound_' || substring(pg_catalog.md5(table_name) FROM 1 FOR 12)
        || '_definer_insert',
      table_name
    );
  END LOOP;
END
$immutable$;

REVOKE ALL ON
  app.property_predator_zernio_inbound_credential_bindings,
  app.property_predator_zernio_inbound_inbox_bindings,
  app.property_predator_zernio_inbound_person_bindings,
  app.property_predator_zernio_inbound_owned_author_bindings,
  app.property_predator_zernio_inbound_transport_receipts,
  app.property_predator_zernio_inbound_events,
  app.property_predator_zernio_inbound_quarantine,
  app.property_predator_zernio_inbound_projections
FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook,
  r72_readonly, r72_crm_command, r72_zernio_social_command,
  r72_daily_outreach_command, r72_daily_outreach_read,
  r72_zernio_inbound_webhook_command;

GRANT SELECT, INSERT ON
  app.property_predator_zernio_inbound_transport_receipts,
  app.property_predator_zernio_inbound_events,
  app.property_predator_zernio_inbound_quarantine,
  app.property_predator_zernio_inbound_projections
TO r72_zernio_inbound_definer;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'property_predator_zernio_inbound_credential_bindings', 'workspace_id'),
  ('app', 'property_predator_zernio_inbound_inbox_bindings', 'workspace_id'),
  ('app', 'property_predator_zernio_inbound_person_bindings', 'workspace_id'),
  ('app', 'property_predator_zernio_inbound_owned_author_bindings', 'workspace_id'),
  ('app', 'property_predator_zernio_inbound_transport_receipts', 'workspace_id'),
  ('app', 'property_predator_zernio_inbound_events', 'workspace_id'),
  ('app', 'property_predator_zernio_inbound_quarantine', 'workspace_id'),
  ('app', 'property_predator_zernio_inbound_projections', 'workspace_id');

-- Exact dependency surface for the table-owning definer. No provider intent,
-- operation, delivery or outbound/reply table is writable by this role.
GRANT SELECT ON app.provider_connections,
  app.property_predator_zernio_accounts,
  app.property_predator_zernio_inbound_credential_bindings,
  app.property_predator_zernio_inbound_inbox_bindings,
  app.property_predator_zernio_inbound_person_bindings,
  app.property_predator_zernio_inbound_owned_author_bindings,
  app.contact_points, app.contacts, app.inboxes,
  app.conversations, app.workspace_memberships
TO r72_zernio_inbound_definer;
GRANT SELECT ON app_private.daily_outreach_manual_attempt_receipts
TO r72_zernio_inbound_definer;
GRANT INSERT ON app.conversations, app.messages, app.message_versions,
  app.tasks, app.activities,
  app.property_predator_admin_call_task_origins
TO r72_zernio_inbound_definer;
GRANT UPDATE (
  assigned_user_id, unread_count, last_message_at, row_version, updated_at
) ON app.conversations TO r72_zernio_inbound_definer;

CREATE POLICY zernio_inbound_provider_connection_select
  ON app.provider_connections FOR SELECT TO r72_zernio_inbound_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
  );
CREATE POLICY zernio_inbound_account_select
  ON app.property_predator_zernio_accounts FOR SELECT
  TO r72_zernio_inbound_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
  );
CREATE POLICY zernio_inbound_contact_point_select
  ON app.contact_points FOR SELECT TO r72_zernio_inbound_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
  );
CREATE POLICY zernio_inbound_contact_select
  ON app.contacts FOR SELECT TO r72_zernio_inbound_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
  );
CREATE POLICY zernio_inbound_inbox_select
  ON app.inboxes FOR SELECT TO r72_zernio_inbound_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
  );
CREATE POLICY zernio_inbound_membership_select
  ON app.workspace_memberships FOR SELECT TO r72_zernio_inbound_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
  );
CREATE POLICY zernio_inbound_conversation_select
  ON app.conversations FOR SELECT TO r72_zernio_inbound_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND channel IN ('instagram', 'linkedin')
  );
CREATE POLICY zernio_inbound_conversation_insert
  ON app.conversations FOR INSERT TO r72_zernio_inbound_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND channel IN ('instagram', 'linkedin') AND environment = 'live'
  );
CREATE POLICY zernio_inbound_conversation_update
  ON app.conversations FOR UPDATE TO r72_zernio_inbound_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND channel IN ('instagram', 'linkedin') AND environment = 'live'
  ) WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND channel IN ('instagram', 'linkedin') AND environment = 'live'
  );
CREATE POLICY zernio_inbound_message_insert
  ON app.messages FOR INSERT TO r72_zernio_inbound_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND channel IN ('instagram', 'linkedin') AND environment = 'live'
    AND direction = 'inbound' AND lifecycle = 'received'
    AND source_kind = 'verified_webhook'
    AND created_by_actor_kind = 'webhook' AND created_by_user_id IS NULL
  );
CREATE POLICY zernio_inbound_message_version_insert
  ON app.message_versions FOR INSERT TO r72_zernio_inbound_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND channel IN ('instagram', 'linkedin') AND environment = 'live'
    AND created_by_actor_kind = 'webhook' AND created_by_user_id IS NULL
    AND created_request_id = current_setting('app.request_id', true)
  );
CREATE POLICY zernio_inbound_task_insert
  ON app.tasks FOR INSERT TO r72_zernio_inbound_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND status = 'open'
  );
CREATE POLICY zernio_inbound_activity_insert
  ON app.activities FOR INSERT TO r72_zernio_inbound_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND actor_kind = 'webhook' AND actor_user_id IS NULL
    AND channel = 'social'
  );
CREATE POLICY zernio_inbound_admin_origin_insert
  ON app.property_predator_admin_call_task_origins FOR INSERT
  TO r72_zernio_inbound_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND source_channel IN ('instagram', 'linkedin')
    AND origin_kind = 'signed_inbound' AND source_provider = 'zernio'
    AND actor_kind = 'webhook' AND actor_user_id IS NULL
    AND command_receipt_id IS NULL
    AND request_id = current_setting('app.request_id', true)
  );
CREATE POLICY zernio_inbound_daily_attempt_select
  ON app_private.daily_outreach_manual_attempt_receipts FOR SELECT
  TO r72_zernio_inbound_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
  );
GRANT CREATE ON SCHEMA app_private TO r72_zernio_inbound_definer;
SET LOCAL ROLE r72_zernio_inbound_definer;

-- Resolve only the already-connected account tuple carried by a verified
-- webhook. The LOGIN remains table-blind; this function returns one internal
-- UUID and no profile, username, token or provider identifier.
CREATE FUNCTION app_private.resolve_zernio_inbound_account(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_network text,
  p_provider_profile_id_sha256 bytea,
  p_provider_account_id_sha256 bytea,
  p_credential_version_sha256 bytea,
  p_credential_binding_sha256 bytea
)
RETURNS TABLE (zernio_account_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_request_id text := current_setting('app.request_id', true);
BEGIN
  IF session_user <> 'r72_zernio_inbound_webhook_command'
     OR current_setting('app.workspace_id', true)
          IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'webhook'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR selected_request_id IS NULL
     OR selected_request_id <> btrim(selected_request_id)
     OR length(selected_request_id) NOT BETWEEN 1 AND 128
     OR selected_request_id ~ '[^[:graph:]]'
     OR p_provider_connection_id IS NULL
     OR p_network NOT IN ('instagram', 'linkedin')
     OR p_provider_profile_id_sha256 IS NULL
     OR octet_length(p_provider_profile_id_sha256) <> 32
     OR p_provider_account_id_sha256 IS NULL
     OR octet_length(p_provider_account_id_sha256) <> 32
     OR p_credential_version_sha256 IS NULL
     OR octet_length(p_credential_version_sha256) <> 32
     OR p_credential_binding_sha256 IS NULL
     OR octet_length(p_credential_binding_sha256) <> 32 THEN
    RAISE EXCEPTION 'Zernio inbound account binding is invalid'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT account.id
  FROM app.property_predator_zernio_accounts AS account
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = account.workspace_id
   AND connection.id = account.provider_connection_id
   AND connection.environment = account.environment
  JOIN app.property_predator_zernio_inbound_credential_bindings AS credential
    ON credential.workspace_id = account.workspace_id
   AND credential.provider_connection_id = account.provider_connection_id
   AND credential.provider_profile_id_sha256
     = account.provider_profile_id_sha256
   AND credential.credential_version_sha256
     = p_credential_version_sha256
   AND credential.credential_binding_sha256
     = p_credential_binding_sha256
   AND credential.environment = 'live' AND credential.state = 'active'
  WHERE account.workspace_id = p_workspace_id
    AND account.provider_connection_id = p_provider_connection_id
    AND account.provider_profile_id_sha256 = p_provider_profile_id_sha256
    AND account.provider_account_id_sha256 = p_provider_account_id_sha256
    AND account.network = p_network
    AND account.environment = 'live' AND account.status = 'active'
    AND connection.provider_id = 'zernio'
    AND connection.provider_kind = 'social'
    AND connection.environment = 'live' AND connection.status = 'active'
  ORDER BY account.id
  LIMIT 2;
END
$function$;

CREATE FUNCTION app_private.record_zernio_signed_inbound(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_zernio_account_id uuid,
  p_network text,
  p_inbound_kind text,
  p_provider_profile_id_sha256 bytea,
  p_credential_version_sha256 bytea,
  p_credential_binding_sha256 bytea,
  p_provider_account_id_sha256 bytea,
  p_provider_person_id_sha256 bytea,
  p_provider_thread_id_sha256 bytea,
  p_provider_event_id_sha256 bytea,
  p_body_text text,
  p_body_sha256 bytea,
  p_payload_sha256 bytea,
  p_signature_sha256 bytea,
  p_event_identity_sha256 bytea,
  p_provider_ownership_assertion text,
  p_occurred_at timestamptz,
  p_signature_verified_at timestamptz
)
RETURNS TABLE (
  disposition text,
  transport_receipt_id uuid,
  event_id uuid,
  quarantine_id uuid,
  projection_id uuid,
  conversation_id uuid,
  inbound_message_id uuid,
  admin_review_task_id uuid,
  outreach_attempt_receipt_id uuid,
  outreach_candidate_disposition text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_request_id text := current_setting('app.request_id', true);
  selected_transport app.property_predator_zernio_inbound_transport_receipts%ROWTYPE;
  selected_event app.property_predator_zernio_inbound_events%ROWTYPE;
  selected_projection app.property_predator_zernio_inbound_projections%ROWTYPE;
  selected_quarantine app.property_predator_zernio_inbound_quarantine%ROWTYPE;
  selected_credential app.property_predator_zernio_inbound_credential_bindings%ROWTYPE;
  selected_account app.property_predator_zernio_accounts%ROWTYPE;
  selected_inbox_binding app.property_predator_zernio_inbound_inbox_bindings%ROWTYPE;
  selected_person_binding app.property_predator_zernio_inbound_person_bindings%ROWTYPE;
  selected_point app.contact_points%ROWTYPE;
  selected_contact app.contacts%ROWTYPE;
  selected_inbox app.inboxes%ROWTYPE;
  selected_conversation app.conversations%ROWTYPE;
  selected_assignee_user_id uuid;
  selected_attempt_id uuid;
  selected_quarantine_reason text;
  owned_author_binding_count integer := 0;
  expected_event_key_sha256 bytea;
  expected_event_identity_sha256 bytea;
  expected_delivery_identity_sha256 bytea;
  selected_conflict_fingerprint_sha256 bytea;
  created_transport_id uuid := gen_random_uuid();
  created_event_id uuid := gen_random_uuid();
  created_quarantine_id uuid := gen_random_uuid();
  created_projection_id uuid := gen_random_uuid();
  created_conversation_id uuid := gen_random_uuid();
  created_message_id uuid := gen_random_uuid();
  created_version_id uuid := gen_random_uuid();
  created_task_id uuid := gen_random_uuid();
  created_origin_id uuid := gen_random_uuid();
  created_activity_id uuid := gen_random_uuid();
BEGIN
  IF session_user <> 'r72_zernio_inbound_webhook_command'
     OR current_setting('app.workspace_id', true)
          IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'webhook'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR selected_request_id IS NULL
     OR selected_request_id <> btrim(selected_request_id)
     OR length(selected_request_id) NOT BETWEEN 1 AND 128
     OR selected_request_id ~ '[^[:graph:]]'
     OR p_provider_connection_id IS NULL OR p_zernio_account_id IS NULL
     OR p_network NOT IN ('instagram', 'linkedin')
     OR p_inbound_kind NOT IN ('instagram_dm', 'owned_post_comment')
     OR (p_inbound_kind = 'instagram_dm' AND p_network <> 'instagram')
     OR p_provider_profile_id_sha256 IS NULL
     OR octet_length(p_provider_profile_id_sha256) <> 32
     OR p_credential_version_sha256 IS NULL
     OR octet_length(p_credential_version_sha256) <> 32
     OR p_credential_binding_sha256 IS NULL
     OR octet_length(p_credential_binding_sha256) <> 32
     OR p_provider_account_id_sha256 IS NULL
     OR octet_length(p_provider_account_id_sha256) <> 32
     OR p_provider_person_id_sha256 IS NULL
     OR octet_length(p_provider_person_id_sha256) <> 32
     OR p_provider_thread_id_sha256 IS NULL
     OR octet_length(p_provider_thread_id_sha256) <> 32
     OR p_provider_event_id_sha256 IS NULL
     OR octet_length(p_provider_event_id_sha256) <> 32
     OR p_body_text IS NULL OR btrim(p_body_text) = ''
     OR octet_length(p_body_text) NOT BETWEEN 1 AND 65536
     OR p_body_sha256 IS NULL OR octet_length(p_body_sha256) <> 32
     OR p_payload_sha256 IS NULL OR octet_length(p_payload_sha256) <> 32
     OR p_signature_sha256 IS NULL OR octet_length(p_signature_sha256) <> 32
     OR p_event_identity_sha256 IS NULL
     OR octet_length(p_event_identity_sha256) <> 32
     OR p_provider_ownership_assertion IS NULL
     OR p_provider_ownership_assertion NOT IN (
       'not_applicable', 'not_owned', 'unknown'
     )
     OR (p_inbound_kind = 'instagram_dm'
       AND p_provider_ownership_assertion <> 'not_applicable')
     OR (p_inbound_kind = 'owned_post_comment'
       AND p_provider_ownership_assertion NOT IN ('not_owned', 'unknown'))
     OR p_occurred_at IS NULL
     OR p_occurred_at < statement_timestamp() - interval '30 days'
     OR p_occurred_at > statement_timestamp() + interval '5 minutes'
     OR p_signature_verified_at IS NULL
     OR p_signature_verified_at < statement_timestamp() - interval '10 minutes'
     OR p_signature_verified_at > statement_timestamp() + interval '30 seconds'
     OR p_body_sha256 <> public.digest(p_body_text, 'sha256') THEN
    RAISE EXCEPTION 'Zernio signed inbound evidence is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- Zernio's payload.id is the canonical provider delivery identity. Keeping
  -- that hash as the global event key makes a crossed account/network replay
  -- conflict instead of projecting a second event.
  expected_event_key_sha256 := p_provider_event_id_sha256;
  expected_event_identity_sha256 := public.digest(
    pg_catalog.encode(expected_event_key_sha256, 'hex')
      || pg_catalog.chr(31) || p_network
      || pg_catalog.chr(31) || p_inbound_kind
      || pg_catalog.chr(31)
      || pg_catalog.encode(p_provider_account_id_sha256, 'hex')
      || pg_catalog.chr(31)
      || pg_catalog.encode(p_provider_person_id_sha256, 'hex')
      || pg_catalog.chr(31)
      || pg_catalog.encode(p_provider_thread_id_sha256, 'hex')
      || pg_catalog.chr(31)
      || pg_catalog.encode(p_body_sha256, 'hex')
      || pg_catalog.chr(31)
      || pg_catalog.encode(p_payload_sha256, 'hex')
      || pg_catalog.chr(31)
      || pg_catalog.to_char(
        p_occurred_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
    'sha256'
  );
  IF p_event_identity_sha256 IS DISTINCT FROM expected_event_identity_sha256 THEN
    RAISE EXCEPTION 'Zernio signed inbound event identity is invalid'
      USING ERRCODE = '22023';
  END IF;
  expected_delivery_identity_sha256 := public.digest(
    pg_catalog.encode(p_event_identity_sha256, 'hex')
      || pg_catalog.chr(31)
      || pg_catalog.encode(p_payload_sha256, 'hex')
      || pg_catalog.chr(31)
      || pg_catalog.encode(p_signature_sha256, 'hex'),
    'sha256'
  );

  SELECT credential.* INTO selected_credential
  FROM app.property_predator_zernio_inbound_credential_bindings AS credential
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = credential.workspace_id
   AND connection.id = credential.provider_connection_id
   AND connection.environment = credential.environment
  WHERE credential.workspace_id = p_workspace_id
    AND credential.provider_connection_id = p_provider_connection_id
    AND credential.provider_profile_id_sha256 = p_provider_profile_id_sha256
    AND credential.credential_version_sha256 = p_credential_version_sha256
    AND credential.credential_binding_sha256 = p_credential_binding_sha256
    AND credential.environment = 'live' AND credential.state = 'active'
    AND connection.provider_id = 'zernio'
    AND connection.provider_kind = 'social'
    AND connection.environment = 'live' AND connection.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio signed inbound credential binding denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT account.* INTO selected_account
  FROM app.property_predator_zernio_accounts AS account
  JOIN app.provider_connections AS connection
      ON connection.workspace_id = account.workspace_id
     AND connection.id = account.provider_connection_id
     AND connection.environment = account.environment
  WHERE account.workspace_id = p_workspace_id
    AND account.id = p_zernio_account_id
    AND account.provider_connection_id = p_provider_connection_id
    AND account.provider_profile_id_sha256 = p_provider_profile_id_sha256
    AND account.provider_account_id_sha256 = p_provider_account_id_sha256
    AND account.network = p_network
    AND account.environment = 'live' AND account.status = 'active'
    AND connection.provider_id = 'zernio'
    AND connection.provider_kind = 'social'
    AND connection.environment = 'live' AND connection.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio signed inbound active account denied'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-inbound-event:' || p_workspace_id::text || ':'
        || pg_catalog.encode(expected_event_key_sha256, 'hex'),
      7200092
    )
  );

  SELECT receipt.* INTO selected_transport
  FROM app.property_predator_zernio_inbound_transport_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.delivery_identity_sha256 = expected_delivery_identity_sha256;
  IF NOT FOUND THEN
    INSERT INTO app.property_predator_zernio_inbound_transport_receipts (
      id, workspace_id, credential_binding_id,
      zernio_account_id, provider_connection_id,
      network, inbound_kind, provider_profile_id_sha256,
      credential_version_sha256, credential_binding_sha256,
      provider_account_id_sha256,
      provider_person_id_sha256, provider_thread_id_sha256,
      provider_event_id_sha256, payload_sha256, signature_sha256,
      event_identity_sha256, delivery_identity_sha256,
      provider_ownership_assertion, signature_verified_at, request_id
    ) VALUES (
      created_transport_id, p_workspace_id, selected_credential.id,
      p_zernio_account_id,
      p_provider_connection_id, p_network, p_inbound_kind,
      p_provider_profile_id_sha256, p_credential_version_sha256,
      p_credential_binding_sha256, p_provider_account_id_sha256,
      p_provider_person_id_sha256,
      p_provider_thread_id_sha256, p_provider_event_id_sha256,
      p_payload_sha256, p_signature_sha256, p_event_identity_sha256,
      expected_delivery_identity_sha256, p_provider_ownership_assertion,
      p_signature_verified_at,
      selected_request_id
    );
    SELECT receipt.* INTO selected_transport
    FROM app.property_predator_zernio_inbound_transport_receipts AS receipt
    WHERE receipt.workspace_id = p_workspace_id
      AND receipt.id = created_transport_id;
  END IF;

  SELECT event.* INTO selected_event
  FROM app.property_predator_zernio_inbound_events AS event
  WHERE event.workspace_id = p_workspace_id
    AND event.event_key_sha256 = expected_event_key_sha256;
  IF FOUND THEN
    IF selected_event.event_identity_sha256
         IS DISTINCT FROM p_event_identity_sha256 THEN
      selected_conflict_fingerprint_sha256 := public.digest(
        pg_catalog.encode(selected_event.event_identity_sha256, 'hex')
          || pg_catalog.chr(31)
          || pg_catalog.encode(p_event_identity_sha256, 'hex')
          || pg_catalog.chr(31)
          || pg_catalog.encode(expected_delivery_identity_sha256, 'hex'),
        'sha256'
      );
      INSERT INTO app.property_predator_zernio_inbound_quarantine (
        id, workspace_id, transport_receipt_id, event_id,
        network, inbound_kind, reason_code,
        provider_account_id_sha256, provider_person_id_sha256,
        provider_event_id_sha256, provider_ownership_assertion,
        conflict_fingerprint_sha256
      ) VALUES (
        created_quarantine_id, p_workspace_id, selected_transport.id,
        selected_event.id, p_network, p_inbound_kind,
        'provider_event_conflict', p_provider_account_id_sha256,
        p_provider_person_id_sha256, p_provider_event_id_sha256,
        p_provider_ownership_assertion,
        selected_conflict_fingerprint_sha256
      ) ON CONFLICT (
        workspace_id, transport_receipt_id,
        reason_code, conflict_fingerprint_sha256
      ) DO NOTHING;
      SELECT quarantine.* INTO selected_quarantine
      FROM app.property_predator_zernio_inbound_quarantine AS quarantine
      WHERE quarantine.workspace_id = p_workspace_id
        AND quarantine.transport_receipt_id = selected_transport.id
        AND quarantine.reason_code = 'provider_event_conflict'
        AND quarantine.conflict_fingerprint_sha256
          = selected_conflict_fingerprint_sha256;
      RETURN QUERY SELECT
        'conflict'::text, selected_transport.id, selected_event.id,
        selected_quarantine.id, NULL::uuid, NULL::uuid, NULL::uuid,
        NULL::uuid, NULL::uuid, NULL::text;
      RETURN;
    END IF;

    SELECT projection.* INTO selected_projection
    FROM app.property_predator_zernio_inbound_projections AS projection
    WHERE projection.workspace_id = p_workspace_id
      AND projection.event_id = selected_event.id;
    IF FOUND THEN
      RETURN QUERY SELECT
        'replayed'::text, selected_transport.id, selected_event.id,
        NULL::uuid, selected_projection.id,
        selected_projection.conversation_id,
        selected_projection.inbound_message_id,
        selected_projection.admin_review_task_id,
        selected_projection.outreach_attempt_receipt_id,
        selected_projection.outreach_candidate_disposition;
      RETURN;
    END IF;
    SELECT quarantine.* INTO selected_quarantine
    FROM app.property_predator_zernio_inbound_quarantine AS quarantine
    WHERE quarantine.workspace_id = p_workspace_id
      AND quarantine.event_id = selected_event.id
    ORDER BY quarantine.recorded_at, quarantine.id
    LIMIT 1;
    RETURN QUERY SELECT
      'quarantined'::text, selected_transport.id, selected_event.id,
      selected_quarantine.id, NULL::uuid, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Routing and person resolution are explicit account-scoped composition.
  -- No provider identity is compared with a global CRM value, and this writer
  -- cannot create or choose a different person or inbox.
  SELECT binding.* INTO selected_inbox_binding
  FROM app.property_predator_zernio_inbound_inbox_bindings AS binding
  WHERE binding.workspace_id = p_workspace_id
    AND binding.zernio_account_id = p_zernio_account_id
    AND binding.provider_connection_id = p_provider_connection_id
    AND binding.provider_profile_id_sha256 = p_provider_profile_id_sha256
    AND binding.provider_account_id_sha256 = p_provider_account_id_sha256
    AND binding.network = p_network
    AND binding.environment = 'live' AND binding.state = 'active';
  IF NOT FOUND THEN
    selected_quarantine_reason := 'inbox_not_composed';
  ELSE
    SELECT inbox.* INTO selected_inbox
    FROM app.inboxes AS inbox
    WHERE inbox.workspace_id = p_workspace_id
      AND inbox.id = selected_inbox_binding.inbox_id
      AND inbox.provider_connection_id = p_provider_connection_id
      AND inbox.channel = p_network
      AND inbox.environment = 'live' AND inbox.status = 'active';
    IF NOT FOUND THEN
      selected_quarantine_reason := 'inbox_not_composed';
    END IF;
  END IF;

  -- Zernio does not currently guarantee author.isOwnAccount for LinkedIn.
  -- An absent assertion is therefore safe only when this exact account has a
  -- configured owned-author hash and the inbound author differs from it.
  IF selected_quarantine_reason IS NULL
     AND p_inbound_kind = 'owned_post_comment' THEN
    SELECT count(*)::integer INTO owned_author_binding_count
    FROM app.property_predator_zernio_inbound_owned_author_bindings AS binding
    WHERE binding.workspace_id = p_workspace_id
      AND binding.zernio_account_id = p_zernio_account_id
      AND binding.provider_connection_id = p_provider_connection_id
      AND binding.provider_profile_id_sha256 = p_provider_profile_id_sha256
      AND binding.provider_account_id_sha256 = p_provider_account_id_sha256
      AND binding.network = p_network
      AND binding.state = 'active';

    IF EXISTS (
      SELECT 1
      FROM app.property_predator_zernio_inbound_owned_author_bindings AS binding
      WHERE binding.workspace_id = p_workspace_id
        AND binding.zernio_account_id = p_zernio_account_id
        AND binding.provider_connection_id = p_provider_connection_id
        AND binding.provider_profile_id_sha256 = p_provider_profile_id_sha256
        AND binding.provider_account_id_sha256 = p_provider_account_id_sha256
        AND binding.network = p_network
        AND binding.provider_owned_author_id_sha256
          = p_provider_person_id_sha256
        AND binding.state = 'active'
    ) THEN
      selected_quarantine_reason := 'owned_author_comment';
    ELSIF p_provider_ownership_assertion = 'unknown'
          AND owned_author_binding_count = 0 THEN
      selected_quarantine_reason := 'owned_author_binding_missing';
    END IF;
  END IF;

  IF selected_quarantine_reason IS NULL THEN
    SELECT binding.* INTO selected_person_binding
    FROM app.property_predator_zernio_inbound_person_bindings AS binding
    WHERE binding.workspace_id = p_workspace_id
      AND binding.zernio_account_id = p_zernio_account_id
      AND binding.provider_connection_id = p_provider_connection_id
      AND binding.provider_profile_id_sha256 = p_provider_profile_id_sha256
      AND binding.provider_account_id_sha256 = p_provider_account_id_sha256
      AND binding.network = p_network
      AND binding.provider_person_id_sha256 = p_provider_person_id_sha256
      AND binding.state = 'active';
    IF NOT FOUND THEN
      selected_quarantine_reason := 'unmatched_contact_point';
    ELSE
      SELECT point.* INTO selected_point
      FROM app.contact_points AS point
      WHERE point.workspace_id = p_workspace_id
        AND point.id = selected_person_binding.contact_point_id
        AND point.contact_id = selected_person_binding.contact_id
        AND point.kind = 'social'
        AND lower(coalesce(point.label, '')) = p_network
        AND point.deleted_at IS NULL AND point.is_verified
        AND point.dedupe_state = 'normal';
      IF NOT FOUND THEN
        selected_quarantine_reason := 'conflicting_contact_point';
      ELSE
        SELECT contact.* INTO selected_contact
        FROM app.contacts AS contact
        WHERE contact.workspace_id = p_workspace_id
          AND contact.id = selected_person_binding.contact_id
          AND contact.deleted_at IS NULL;
        IF NOT FOUND THEN
          selected_quarantine_reason := 'conflicting_contact_point';
        END IF;
      END IF;
    END IF;
  END IF;

  IF selected_quarantine_reason IS NULL THEN
    -- Distinct events for the same person can arrive concurrently. Serialize
    -- the open-thread decision on the canonical inbox/contact pair so the
    -- partial unique index never becomes a retry-only control path.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'zernio-inbound-conversation:' || p_workspace_id::text || ':'
          || selected_inbox.id::text || ':' || selected_contact.id::text,
        7200092
      )
    );
    SELECT conversation.* INTO selected_conversation
    FROM app.conversations AS conversation
    WHERE conversation.workspace_id = p_workspace_id
      AND conversation.inbox_id = selected_inbox.id
      AND conversation.contact_id = selected_contact.id
      AND conversation.channel = p_network
      AND conversation.environment = 'live'
      AND conversation.state IN ('open', 'snoozed')
    FOR UPDATE;

    IF selected_conversation.assigned_user_id IS NOT NULL THEN
      SELECT membership.user_id INTO selected_assignee_user_id
      FROM app.workspace_memberships AS membership
      WHERE membership.workspace_id = p_workspace_id
        AND membership.user_id = selected_conversation.assigned_user_id
        AND membership.status = 'active' AND membership.role <> 'viewer';
    END IF;
    IF selected_assignee_user_id IS NULL
       AND selected_contact.owner_user_id IS NOT NULL THEN
      SELECT membership.user_id INTO selected_assignee_user_id
      FROM app.workspace_memberships AS membership
      WHERE membership.workspace_id = p_workspace_id
        AND membership.user_id = selected_contact.owner_user_id
        AND membership.status = 'active' AND membership.role <> 'viewer';
    END IF;
    IF selected_assignee_user_id IS NULL THEN
      SELECT membership.user_id INTO selected_assignee_user_id
      FROM app.workspace_memberships AS membership
      WHERE membership.workspace_id = p_workspace_id
        AND membership.status = 'active'
        AND membership.role IN ('owner', 'admin')
      ORDER BY CASE membership.role WHEN 'owner' THEN 1 ELSE 2 END,
        membership.granted_at, membership.user_id
      LIMIT 1;
    END IF;
    IF selected_assignee_user_id IS NULL THEN
      selected_quarantine_reason := 'assignee_not_available';
    END IF;
  END IF;

  INSERT INTO app.property_predator_zernio_inbound_events (
    id, workspace_id, transport_receipt_id, credential_binding_id,
    zernio_account_id, provider_connection_id, network, inbound_kind,
    provider_profile_id_sha256, credential_version_sha256,
    credential_binding_sha256, provider_account_id_sha256,
    provider_person_id_sha256,
    provider_thread_id_sha256, provider_event_id_sha256,
    event_key_sha256, event_identity_sha256, body_sha256,
    payload_sha256, provider_ownership_assertion,
    admission_disposition, occurred_at
  ) VALUES (
    created_event_id, p_workspace_id, selected_transport.id,
    selected_credential.id, p_zernio_account_id,
    p_provider_connection_id, p_network, p_inbound_kind,
    p_provider_profile_id_sha256, p_credential_version_sha256,
    p_credential_binding_sha256, p_provider_account_id_sha256,
    p_provider_person_id_sha256, p_provider_thread_id_sha256,
    p_provider_event_id_sha256, expected_event_key_sha256,
    p_event_identity_sha256, p_body_sha256, p_payload_sha256,
    p_provider_ownership_assertion,
    CASE WHEN selected_quarantine_reason IS NULL
      THEN 'projected' ELSE 'quarantined' END,
    p_occurred_at
  );

  IF selected_quarantine_reason IS NOT NULL THEN
    selected_conflict_fingerprint_sha256 := public.digest(
      selected_quarantine_reason || pg_catalog.chr(31)
        || pg_catalog.encode(p_event_identity_sha256, 'hex'),
      'sha256'
    );
    INSERT INTO app.property_predator_zernio_inbound_quarantine (
      id, workspace_id, transport_receipt_id, event_id,
      network, inbound_kind, reason_code,
      provider_account_id_sha256, provider_person_id_sha256,
      provider_event_id_sha256, provider_ownership_assertion,
      conflict_fingerprint_sha256
    ) VALUES (
      created_quarantine_id, p_workspace_id, selected_transport.id,
      created_event_id, p_network, p_inbound_kind,
      selected_quarantine_reason, p_provider_account_id_sha256,
      p_provider_person_id_sha256, p_provider_event_id_sha256,
      p_provider_ownership_assertion,
      selected_conflict_fingerprint_sha256
    );
    RETURN QUERY SELECT
      'quarantined'::text, selected_transport.id, created_event_id,
      created_quarantine_id, NULL::uuid, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  IF selected_conversation.id IS NULL THEN
    INSERT INTO app.conversations (
      id, workspace_id, inbox_id, channel, environment, contact_id,
      assigned_user_id, state, subject, unread_count, last_message_at
    ) VALUES (
      created_conversation_id, p_workspace_id, selected_inbox.id,
      p_network, 'live', selected_contact.id, selected_assignee_user_id,
      'open', CASE p_inbound_kind
        WHEN 'instagram_dm' THEN 'Instagram direct message'
        ELSE CASE p_network WHEN 'linkedin' THEN 'LinkedIn' ELSE 'Instagram' END
          || ' owned-post comment'
      END,
      0, greatest(p_occurred_at, statement_timestamp())
    );
    SELECT conversation.* INTO selected_conversation
    FROM app.conversations AS conversation
    WHERE conversation.workspace_id = p_workspace_id
      AND conversation.id = created_conversation_id
    FOR UPDATE;
  END IF;

  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO app.messages (
    id, workspace_id, conversation_id, contact_id, contact_point_id,
    channel, environment, direction, lifecycle, source_kind,
    current_version_id, current_version_number, current_body_sha256,
    created_by_actor_kind, created_by_user_id, occurred_at
  ) VALUES (
    created_message_id, p_workspace_id, selected_conversation.id,
    selected_contact.id, selected_point.id, p_network, 'live',
    'inbound', 'received', 'verified_webhook', created_version_id,
    1, p_body_sha256, 'webhook', NULL, p_occurred_at
  );
  INSERT INTO app.message_versions (
    id, workspace_id, conversation_id, message_id,
    channel, environment, version_number, body_format, body_text,
    created_by_actor_kind, created_by_user_id, created_request_id
  ) VALUES (
    created_version_id, p_workspace_id, selected_conversation.id,
    created_message_id, p_network, 'live', 1, 'plain_text', p_body_text,
    'webhook', NULL, selected_request_id
  );
  UPDATE app.conversations AS conversation
  SET assigned_user_id = selected_assignee_user_id,
      unread_count = least(conversation.unread_count + 1, 1000000),
      last_message_at = greatest(
        coalesce(conversation.last_message_at, p_occurred_at),
        p_occurred_at, conversation.created_at
      ),
      row_version = conversation.row_version + 1,
      updated_at = statement_timestamp()
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = selected_conversation.id;

  INSERT INTO app.tasks (
    id, workspace_id, contact_id, title, description,
    assignee_user_id, priority, status, due_at
  ) VALUES (
    created_task_id, p_workspace_id, selected_contact.id,
    CASE p_inbound_kind
      WHEN 'instagram_dm' THEN 'Review verified Instagram DM reply'
      ELSE 'Review verified '
        || CASE p_network WHEN 'linkedin' THEN 'LinkedIn' ELSE 'Instagram' END
        || ' comment reply'
    END,
    'A signed Zernio inbound event matched an existing CRM person. Review the Conversion Inbox thread and record the next human action.',
    selected_assignee_user_id, 'high', 'open',
    statement_timestamp() + interval '15 minutes'
  );
  INSERT INTO app.property_predator_admin_call_task_origins (
    id, workspace_id, task_id, conversation_id, contact_id,
    source_message_id, source_channel, origin_kind, source_provider,
    source_receipt_id, source_event_identity_sha256,
    actor_kind, actor_user_id, command_receipt_id,
    request_id, occurred_at
  ) VALUES (
    created_origin_id, p_workspace_id, created_task_id,
    selected_conversation.id, selected_contact.id, created_message_id,
    p_network, 'signed_inbound', 'zernio', created_event_id,
    p_event_identity_sha256, 'webhook', NULL, NULL,
    selected_request_id, p_occurred_at
  );
  INSERT INTO app.activities (
    id, workspace_id, contact_id, task_id,
    activity_type, channel, actor_kind, actor_user_id,
    subject, body, metadata, request_id, correlation_id, occurred_at
  ) VALUES (
    created_activity_id, p_workspace_id, selected_contact.id,
    created_task_id, 'inbox.zernio.reply_received', 'social',
    'webhook', NULL,
    CASE p_inbound_kind
      WHEN 'instagram_dm' THEN 'Verified Instagram DM received'
      ELSE 'Verified '
        || CASE p_network WHEN 'linkedin' THEN 'LinkedIn' ELSE 'Instagram' END
        || ' comment received'
    END,
    'A signed Zernio inbound event was linked to Conversion Inbox and queued for human review.',
    pg_catalog.jsonb_build_object(
      'provider', 'zernio', 'network', p_network,
      'inboundKind', p_inbound_kind,
      'eventId', created_event_id,
      'conversationId', selected_conversation.id,
      'messageId', created_message_id
    ),
    selected_request_id, created_event_id::text,
    least(p_occurred_at, statement_timestamp())
  );

  SELECT attempt.id INTO selected_attempt_id
  FROM app_private.daily_outreach_manual_attempt_receipts AS attempt
  WHERE attempt.workspace_id = p_workspace_id
    AND attempt.contact_id = selected_contact.id
    AND attempt.contact_point_id = selected_point.id
    AND attempt.channel = p_network
    AND attempt.attempted_at <= p_occurred_at + interval '5 minutes'
    AND attempt.attempted_at >= p_occurred_at - interval '30 days'
  ORDER BY attempt.attempted_at DESC, attempt.id DESC
  LIMIT 1;

  INSERT INTO app.property_predator_zernio_inbound_projections (
    id, workspace_id, transport_receipt_id, event_id,
    zernio_account_id, account_inbox_binding_id, person_binding_id,
    network, inbound_kind,
    inbox_id, conversation_id, contact_id, contact_point_id,
    inbound_message_id, inbound_message_version_id,
    admin_review_task_id, admin_call_origin_id, lead360_activity_id,
    outreach_attempt_receipt_id, outreach_candidate_disposition,
    body_sha256, event_identity_sha256, occurred_at, request_id
  ) VALUES (
    created_projection_id, p_workspace_id, selected_transport.id,
    created_event_id, p_zernio_account_id, selected_inbox_binding.id,
    selected_person_binding.id, p_network, p_inbound_kind,
    selected_inbox.id, selected_conversation.id, selected_contact.id,
    selected_point.id, created_message_id, created_version_id,
    created_task_id, created_origin_id, created_activity_id,
    selected_attempt_id,
    CASE WHEN selected_attempt_id IS NULL THEN 'unlinked' ELSE 'linked' END,
    p_body_sha256, p_event_identity_sha256, p_occurred_at,
    selected_request_id
  );

  RETURN QUERY SELECT
    'applied'::text, selected_transport.id, created_event_id,
    NULL::uuid, created_projection_id, selected_conversation.id,
    created_message_id, created_task_id, selected_attempt_id,
    CASE WHEN selected_attempt_id IS NULL THEN 'unlinked' ELSE 'linked' END;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE CREATE ON SCHEMA app_private FROM r72_zernio_inbound_definer;
REVOKE ALL ON FUNCTION app_private.resolve_zernio_inbound_account(
  uuid, uuid, text, bytea, bytea, bytea, bytea
) FROM PUBLIC, r72_zernio_inbound_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.resolve_zernio_inbound_account(
  uuid, uuid, text, bytea, bytea, bytea, bytea
) TO r72_zernio_inbound_webhook_command;
REVOKE ALL ON FUNCTION app_private.record_zernio_signed_inbound(
  uuid, uuid, uuid, text, text, bytea, bytea, bytea, bytea,
  bytea, bytea, bytea, text, bytea, bytea, bytea, bytea,
  text, timestamptz, timestamptz
) FROM PUBLIC, r72_zernio_inbound_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.record_zernio_signed_inbound(
  uuid, uuid, uuid, text, text, bytea, bytea, bytea, bytea,
  bytea, bytea, bytea, text, bytea, bytea, bytea, bytea,
  text, timestamptz, timestamptz
) TO r72_zernio_inbound_webhook_command;
GRANT EXECUTE ON FUNCTION
  app_private.runtime_schema_migrations(),
  app_private.runtime_database_installation_id()
TO r72_zernio_inbound_webhook_command;

-- Conversion Inbox reads live conversations only when exact rail evidence
-- exists. Extend that reader through the existing table-blind definer rather
-- than granting the web role a new evidence table.
GRANT SELECT (
  workspace_id, event_id, conversation_id,
  inbound_message_id, network, recorded_at
) ON app.property_predator_zernio_inbound_projections
TO r72_operational_inbox_reader_definer;
CREATE POLICY zernio_inbound_projection_reader_select
  ON app.property_predator_zernio_inbound_projections FOR SELECT
  TO r72_operational_inbox_reader_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );

GRANT CREATE ON SCHEMA app_private TO r72_operational_inbox_reader_definer;
SET LOCAL ROLE r72_operational_inbox_reader_definer;

CREATE OR REPLACE FUNCTION app_private.operational_inbox_live_conversation_visible(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_channel text
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
  SELECT p_conversation_id IS NOT NULL
    AND app_private.operational_inbox_live_read_allowed(p_workspace_id)
    AND CASE p_channel
      WHEN 'email' THEN (
        EXISTS (
          SELECT 1
          FROM app.property_predator_mailgun_inbound_receipts AS owned_reply
          WHERE owned_reply.workspace_id = p_workspace_id
            AND owned_reply.conversation_id = p_conversation_id
        )
        OR EXISTS (
          SELECT 1
          FROM app.message_deliveries AS live_delivery
          JOIN app.property_predator_customer_email_jobs AS live_email
            ON live_email.workspace_id = live_delivery.workspace_id
           AND live_email.message_delivery_id = live_delivery.id
          WHERE live_delivery.workspace_id = p_workspace_id
            AND live_delivery.conversation_id = p_conversation_id
            AND live_delivery.environment = 'live'
        )
      )
      WHEN 'whatsapp' THEN EXISTS (
        SELECT 1
        FROM app.property_predator_whatsapp_live_inbox_projections AS live_whatsapp
        WHERE live_whatsapp.workspace_id = p_workspace_id
          AND live_whatsapp.conversation_id = p_conversation_id
      )
      WHEN 'sms' THEN (
        EXISTS (
          SELECT 1
          FROM app.property_predator_sms_inbox_projections AS live_sms
          WHERE live_sms.workspace_id = p_workspace_id
            AND live_sms.conversation_id = p_conversation_id
        )
        OR EXISTS (
          SELECT 1
          FROM app.message_deliveries AS live_delivery
          JOIN app.property_predator_sms_jobs AS live_sms_job
            ON live_sms_job.workspace_id = live_delivery.workspace_id
           AND live_sms_job.message_delivery_id = live_delivery.id
          WHERE live_delivery.workspace_id = p_workspace_id
            AND live_delivery.conversation_id = p_conversation_id
            AND live_delivery.environment = 'live'
        )
      )
      WHEN 'instagram' THEN EXISTS (
        SELECT 1
        FROM app.property_predator_zernio_inbound_projections AS live_social
        WHERE live_social.workspace_id = p_workspace_id
          AND live_social.conversation_id = p_conversation_id
          AND live_social.network = 'instagram'
      )
      WHEN 'linkedin' THEN EXISTS (
        SELECT 1
        FROM app.property_predator_zernio_inbound_projections AS live_social
        WHERE live_social.workspace_id = p_workspace_id
          AND live_social.conversation_id = p_conversation_id
          AND live_social.network = 'linkedin'
      )
      ELSE false
    END
$function$;

CREATE OR REPLACE FUNCTION app_private.operational_inbox_live_message_provenance(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_message_id uuid
)
RETURNS TABLE (
  receipt_id uuid,
  provider_family text,
  network text,
  verified_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
  SELECT provenance.receipt_id, provenance.provider_family,
         provenance.network, provenance.verified_at
  FROM (
    SELECT 1 AS rail_rank, owned_reply.id AS receipt_id,
           'mailgun_email'::text AS provider_family, 'email'::text AS network,
           owned_reply.received_at AS verified_at
    FROM app.property_predator_mailgun_inbound_receipts AS owned_reply
    WHERE app_private.operational_inbox_live_read_allowed(p_workspace_id)
      AND p_conversation_id IS NOT NULL AND p_message_id IS NOT NULL
      AND owned_reply.workspace_id = p_workspace_id
      AND owned_reply.conversation_id = p_conversation_id
      AND owned_reply.inbound_message_id = p_message_id
    UNION ALL
    SELECT 2, live_whatsapp.receipt_id, 'meta_whatsapp_live'::text,
           'whatsapp'::text, live_whatsapp.recorded_at
    FROM app.property_predator_whatsapp_live_inbox_projections AS live_whatsapp
    WHERE app_private.operational_inbox_live_read_allowed(p_workspace_id)
      AND p_conversation_id IS NOT NULL AND p_message_id IS NOT NULL
      AND live_whatsapp.workspace_id = p_workspace_id
      AND live_whatsapp.conversation_id = p_conversation_id
      AND live_whatsapp.inbound_message_id = p_message_id
    UNION ALL
    SELECT 3, live_sms.receipt_id, 'twilio_sms_live'::text,
           'sms'::text, live_sms.recorded_at
    FROM app.property_predator_sms_inbox_projections AS live_sms
    WHERE app_private.operational_inbox_live_read_allowed(p_workspace_id)
      AND p_conversation_id IS NOT NULL AND p_message_id IS NOT NULL
      AND live_sms.workspace_id = p_workspace_id
      AND live_sms.conversation_id = p_conversation_id
      AND live_sms.inbound_message_id = p_message_id
    UNION ALL
    SELECT 4, live_social.event_id, 'zernio_social_live'::text,
           live_social.network, live_social.recorded_at
    FROM app.property_predator_zernio_inbound_projections AS live_social
    WHERE app_private.operational_inbox_live_read_allowed(p_workspace_id)
      AND p_conversation_id IS NOT NULL AND p_message_id IS NOT NULL
      AND live_social.workspace_id = p_workspace_id
      AND live_social.conversation_id = p_conversation_id
      AND live_social.inbound_message_id = p_message_id
  ) AS provenance
  ORDER BY provenance.rail_rank
  LIMIT 1
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private
  FROM r72_operational_inbox_reader_definer;

REVOKE ALL ON FUNCTION app_private.operational_inbox_live_conversation_visible(
  uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.operational_inbox_live_message_provenance(
  uuid, uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.operational_inbox_live_conversation_visible(
  uuid, uuid, text
) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.operational_inbox_live_message_provenance(
  uuid, uuid, uuid
) TO r72_web;

DO $capability_audit$
DECLARE
  unsafe_object text;
  unsafe_function text;
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
        'r72_zernio_inbound_webhook_command', relation.oid, 'SELECT'
      ) OR pg_catalog.has_table_privilege(
        'r72_zernio_inbound_webhook_command', relation.oid, 'INSERT'
      ) OR pg_catalog.has_table_privilege(
        'r72_zernio_inbound_webhook_command', relation.oid, 'UPDATE'
      ) OR pg_catalog.has_table_privilege(
        'r72_zernio_inbound_webhook_command', relation.oid, 'DELETE'
      ) OR pg_catalog.has_table_privilege(
        'r72_zernio_inbound_webhook_command', relation.oid, 'TRUNCATE'
      ) OR pg_catalog.has_any_column_privilege(
        'r72_zernio_inbound_webhook_command', relation.oid, 'SELECT'
      ) OR pg_catalog.has_any_column_privilege(
        'r72_zernio_inbound_webhook_command', relation.oid, 'INSERT'
      ) OR pg_catalog.has_any_column_privilege(
        'r72_zernio_inbound_webhook_command', relation.oid, 'UPDATE'
      ) OR pg_catalog.has_any_column_privilege(
        'r72_zernio_inbound_webhook_command', relation.oid, 'REFERENCES'
      )
    )
  LIMIT 1;
  IF unsafe_object IS NOT NULL THEN
    RAISE EXCEPTION 'Zernio inbound webhook LOGIN has table capability: %',
      unsafe_object USING ERRCODE = '42501';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unsafe_function
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'app_private'
    AND pg_catalog.has_function_privilege(
      'r72_zernio_inbound_webhook_command', procedure.oid, 'EXECUTE'
    )
    AND procedure.oid::regprocedure::text NOT IN (
      'app_private.resolve_zernio_inbound_account(uuid,uuid,text,bytea,bytea,bytea,bytea)',
      'app_private.record_zernio_signed_inbound(uuid,uuid,uuid,text,text,bytea,bytea,bytea,bytea,bytea,bytea,bytea,text,bytea,bytea,bytea,bytea,text,timestamp with time zone,timestamp with time zone)',
      'app_private.runtime_schema_migrations()',
      'app_private.runtime_database_installation_id()'
    )
  LIMIT 1;
  IF unsafe_function IS NOT NULL THEN
    RAISE EXCEPTION 'Zernio inbound webhook LOGIN has unexpected function: %',
      unsafe_function USING ERRCODE = '42501';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'r72_zernio_inbound_webhook_command',
       'app_private.resolve_zernio_inbound_account(uuid,uuid,text,bytea,bytea,bytea,bytea)',
       'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'PUBLIC',
       'app_private.resolve_zernio_inbound_account(uuid,uuid,text,bytea,bytea,bytea,bytea)',
       'EXECUTE'
     ) OR NOT pg_catalog.has_function_privilege(
       'r72_zernio_inbound_webhook_command',
       'app_private.record_zernio_signed_inbound(uuid,uuid,uuid,text,text,bytea,bytea,bytea,bytea,bytea,bytea,bytea,text,bytea,bytea,bytea,bytea,text,timestamptz,timestamptz)',
       'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'PUBLIC',
       'app_private.record_zernio_signed_inbound(uuid,uuid,uuid,text,text,bytea,bytea,bytea,bytea,bytea,bytea,bytea,text,bytea,bytea,bytea,bytea,text,timestamptz,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Zernio inbound exact function ACL is not intact'
      USING ERRCODE = '42501';
  END IF;

  IF pg_catalog.has_table_privilege(
       'r72_zernio_inbound_definer', 'app.provider_operations', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'r72_zernio_inbound_definer', 'app.message_deliveries', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'r72_zernio_inbound_definer',
       'app.property_predator_zernio_reply_deliveries', 'INSERT'
     ) THEN
    RAISE EXCEPTION 'Zernio inbound definer gained provider-effect capability'
      USING ERRCODE = '42501';
  END IF;

  IF pg_catalog.has_table_privilege(
       'r72_web',
       'app.property_predator_zernio_inbound_projections',
       'SELECT, INSERT, UPDATE, DELETE'
     ) THEN
    RAISE EXCEPTION 'Web role must remain blind to Zernio inbound evidence'
      USING ERRCODE = '42501';
  END IF;
END
$capability_audit$;

RESET ROLE;
