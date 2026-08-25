-- Canonical, workspace-isolated conversation state and provider-operation
-- intent. This release is deliberately test-transport only: it creates no
-- credential store, performs no network call and grants no live provider path.

SET LOCAL ROLE r72_owner;

CREATE TABLE app.provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  provider_id text NOT NULL CHECK (
    provider_id = lower(btrim(provider_id))
    AND provider_id ~ '^[a-z][a-z0-9_.-]{0,99}$'
  ),
  provider_kind text NOT NULL CHECK (
    provider_kind IN ('messaging', 'email', 'social')
  ),
  environment text NOT NULL CHECK (environment IN ('test', 'sandbox', 'live')),
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'degraded', 'disabled')
  ),
  display_name text NOT NULL CHECK (
    display_name = btrim(display_name)
    AND length(display_name) BETWEEN 1 AND 120
  ),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(capabilities) = 'array'
  ),
  created_by_user_id uuid NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, environment),
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  -- A live/sandbox connection is a later, separately authorised capability.
  CHECK (provider_id <> 'test_conversation' OR environment = 'test')
);

CREATE UNIQUE INDEX provider_connections_active_provider_uq
  ON app.provider_connections (workspace_id, provider_id, environment)
  WHERE status <> 'disabled';

CREATE TABLE app.channel_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  provider_connection_id uuid NOT NULL,
  channel text NOT NULL CHECK (
    channel IN ('email', 'sms', 'whatsapp', 'instagram', 'facebook')
  ),
  environment text NOT NULL CHECK (environment IN ('test', 'sandbox', 'live')),
  direction text NOT NULL CHECK (
    direction IN ('inbound', 'outbound', 'bidirectional')
  ),
  address text NOT NULL CHECK (
    address = btrim(address) AND length(address) BETWEEN 1 AND 500
  ),
  normalized_address text NOT NULL CHECK (
    normalized_address = btrim(normalized_address)
    AND length(normalized_address) BETWEEN 1 AND 500
  ),
  display_name text NOT NULL CHECK (
    display_name = btrim(display_name)
    AND length(display_name) BETWEEN 1 AND 120
  ),
  provider_endpoint_ref text CHECK (
    provider_endpoint_ref IS NULL OR (
      provider_endpoint_ref = btrim(provider_endpoint_ref)
      AND length(provider_endpoint_ref) BETWEEN 1 AND 500
    )
  ),
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'degraded', 'disabled')
  ),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (
    workspace_id, id, provider_connection_id, channel, environment
  ),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment)
    ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX channel_endpoints_active_address_uq
  ON app.channel_endpoints (
    workspace_id, provider_connection_id, channel, normalized_address
  ) WHERE status <> 'disabled';

CREATE TABLE app.inboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  channel_endpoint_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  channel text NOT NULL CHECK (
    channel IN ('email', 'sms', 'whatsapp', 'instagram', 'facebook')
  ),
  environment text NOT NULL CHECK (environment IN ('test', 'sandbox', 'live')),
  name text NOT NULL CHECK (
    name = btrim(name) AND length(name) BETWEEN 1 AND 120
  ),
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'disabled')
  ),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, channel, environment),
  UNIQUE (workspace_id, channel_endpoint_id),
  FOREIGN KEY (
    workspace_id, channel_endpoint_id, provider_connection_id,
    channel, environment
  ) REFERENCES app.channel_endpoints (
    workspace_id, id, provider_connection_id, channel, environment
  ) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

CREATE TABLE app.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  inbox_id uuid NOT NULL,
  channel text NOT NULL CHECK (
    channel IN ('email', 'sms', 'whatsapp', 'instagram', 'facebook')
  ),
  environment text NOT NULL CHECK (environment IN ('test', 'sandbox', 'live')),
  contact_id uuid,
  assigned_user_id uuid,
  state text NOT NULL DEFAULT 'open' CHECK (
    state IN ('open', 'snoozed', 'closed', 'quarantined')
  ),
  subject text CHECK (
    subject IS NULL OR (subject = btrim(subject) AND length(subject) BETWEEN 1 AND 500)
  ),
  unread_count integer NOT NULL DEFAULT 0 CHECK (unread_count BETWEEN 0 AND 1000000),
  last_message_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, channel, environment),
  UNIQUE (workspace_id, id, contact_id),
  FOREIGN KEY (workspace_id, inbox_id, channel, environment)
    REFERENCES app.inboxes (workspace_id, id, channel, environment)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, assigned_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (last_message_at IS NULL OR last_message_at >= created_at)
);

CREATE UNIQUE INDEX conversations_open_contact_inbox_uq
  ON app.conversations (workspace_id, inbox_id, contact_id)
  WHERE contact_id IS NOT NULL AND state IN ('open', 'snoozed');
CREATE INDEX conversations_inbox_queue_idx
  ON app.conversations (
    workspace_id, inbox_id, state, last_message_at DESC NULLS LAST, id
  );
CREATE INDEX conversations_contact_idx
  ON app.conversations (workspace_id, contact_id, last_message_at DESC NULLS LAST, id)
  WHERE contact_id IS NOT NULL;

-- The current-version foreign key is installed after message_versions exists.
-- It is deferred so a command can reserve both IDs, insert the message, then
-- append the exact immutable version in the same transaction.
CREATE TABLE app.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  contact_id uuid,
  contact_point_id uuid,
  channel text NOT NULL CHECK (
    channel IN ('email', 'sms', 'whatsapp', 'instagram', 'facebook')
  ),
  environment text NOT NULL CHECK (environment IN ('test', 'sandbox', 'live')),
  direction text NOT NULL CHECK (
    direction IN ('inbound', 'outbound', 'internal_note')
  ),
  lifecycle text NOT NULL CHECK (
    lifecycle IN ('received', 'draft', 'approval_pending', 'approved', 'committed')
  ),
  source_kind text NOT NULL CHECK (
    source_kind IN ('user', 'verified_webhook', 'test_fixture', 'automation', 'system')
  ),
  current_version_id uuid NOT NULL,
  current_version_number integer NOT NULL CHECK (current_version_number > 0),
  current_body_sha256 bytea NOT NULL CHECK (octet_length(current_body_sha256) = 32),
  created_by_actor_kind text NOT NULL CHECK (
    created_by_actor_kind IN ('user', 'webhook', 'system')
  ),
  created_by_user_id uuid,
  occurred_at timestamptz NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, conversation_id, id),
  UNIQUE (
    workspace_id, conversation_id, id,
    current_version_id, current_version_number, current_body_sha256
  ),
  FOREIGN KEY (workspace_id, conversation_id, channel, environment)
    REFERENCES app.conversations (workspace_id, id, channel, environment)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id, contact_id)
    REFERENCES app.conversations (workspace_id, id, contact_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((created_by_actor_kind = 'user') = (created_by_user_id IS NOT NULL)),
  CHECK (direction <> 'outbound' OR lifecycle <> 'received'),
  CHECK (direction = 'outbound' OR lifecycle = 'received'),
  CHECK (updated_at >= created_at)
);

CREATE TABLE app.message_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  channel text NOT NULL CHECK (
    channel IN ('email', 'sms', 'whatsapp', 'instagram', 'facebook')
  ),
  environment text NOT NULL CHECK (environment IN ('test', 'sandbox', 'live')),
  version_number integer NOT NULL CHECK (version_number > 0),
  body_format text NOT NULL DEFAULT 'plain_text' CHECK (body_format = 'plain_text'),
  body_text text NOT NULL CHECK (octet_length(body_text) BETWEEN 1 AND 65536),
  body_sha256 bytea GENERATED ALWAYS AS (
    public.digest(body_text, 'sha256')
  ) STORED,
  source_content_version_ref text CHECK (
    source_content_version_ref IS NULL OR (
      source_content_version_ref = btrim(source_content_version_ref)
      AND length(source_content_version_ref) BETWEEN 1 AND 500
    )
  ),
  source_content_sha256 bytea CHECK (
    source_content_sha256 IS NULL OR octet_length(source_content_sha256) = 32
  ),
  source_content_approval_ref text CHECK (
    source_content_approval_ref IS NULL OR (
      source_content_approval_ref = btrim(source_content_approval_ref)
      AND length(source_content_approval_ref) BETWEEN 1 AND 500
    )
  ),
  created_by_actor_kind text NOT NULL CHECK (
    created_by_actor_kind IN ('user', 'webhook', 'system')
  ),
  created_by_user_id uuid,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, conversation_id, message_id, version_number),
  UNIQUE (
    workspace_id, conversation_id, message_id,
    id, version_number, body_sha256
  ),
  FOREIGN KEY (workspace_id, conversation_id, message_id)
    REFERENCES app.messages (workspace_id, conversation_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((created_by_actor_kind = 'user') = (created_by_user_id IS NOT NULL)),
  CHECK (
    (source_content_version_ref IS NULL)
      = (source_content_sha256 IS NULL)
    AND (source_content_version_ref IS NULL)
      = (source_content_approval_ref IS NULL)
  )
);

ALTER TABLE app.messages
  ADD CONSTRAINT messages_current_version_exact_fk
  FOREIGN KEY (
    workspace_id, conversation_id, id,
    current_version_id, current_version_number, current_body_sha256
  ) REFERENCES app.message_versions (
    workspace_id, conversation_id, message_id,
    id, version_number, body_sha256
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX messages_conversation_time_idx
  ON app.messages (workspace_id, conversation_id, occurred_at DESC, id DESC);

CREATE TABLE app.message_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  message_version_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  request_number integer NOT NULL CHECK (request_number > 0),
  review_note text CHECK (
    review_note IS NULL OR (
      review_note = btrim(review_note) AND length(review_note) BETWEEN 1 AND 2000
    )
  ),
  requested_by_user_id uuid NOT NULL,
  requested_request_id text NOT NULL CHECK (
    requested_request_id = btrim(requested_request_id)
    AND length(requested_request_id) BETWEEN 1 AND 128
  ),
  requested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, conversation_id, message_id, message_version_id, request_number),
  UNIQUE (
    workspace_id, conversation_id, message_id, message_version_id,
    id, version_number, body_sha256
  ),
  FOREIGN KEY (
    workspace_id, conversation_id, message_id,
    message_version_id, version_number, body_sha256
  ) REFERENCES app.message_versions (
    workspace_id, conversation_id, message_id,
    id, version_number, body_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app.message_approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  message_version_id uuid NOT NULL,
  approval_request_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  decision text NOT NULL CHECK (
    decision IN ('approved', 'rejected', 'changes_requested')
  ),
  decision_note text CHECK (
    decision_note IS NULL OR (
      decision_note = btrim(decision_note)
      AND length(decision_note) BETWEEN 1 AND 4000
    )
  ),
  decided_by_user_id uuid NOT NULL,
  decided_request_id text NOT NULL CHECK (
    decided_request_id = btrim(decided_request_id)
    AND length(decided_request_id) BETWEEN 1 AND 128
  ),
  decided_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, approval_request_id),
  UNIQUE (
    workspace_id, conversation_id, message_id, message_version_id,
    approval_request_id, id, version_number, body_sha256, decision
  ),
  FOREIGN KEY (
    workspace_id, conversation_id, message_id, message_version_id,
    approval_request_id, version_number, body_sha256
  ) REFERENCES app.message_approval_requests (
    workspace_id, conversation_id, message_id, message_version_id,
    id, version_number, body_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, decided_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (decision = 'approved' OR decision_note IS NOT NULL)
);

CREATE TABLE app.provider_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  provider_connection_id uuid NOT NULL,
  message_delivery_id uuid NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind = 'conversation.send'),
  environment text NOT NULL CHECK (environment IN ('test', 'sandbox', 'live')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'leased', 'calling', 'retry_wait', 'accepted', 'succeeded',
    'failed', 'reconciliation_required', 'dead_letter', 'cancelled'
  )),
  idempotency_key text NOT NULL CHECK (
    idempotency_key = btrim(idempotency_key)
    AND length(idempotency_key) BETWEEN 1 AND 200
  ),
  correlation_id uuid NOT NULL,
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  max_attempts smallint NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 8),
  next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  lease_token_hash bytea CHECK (
    lease_token_hash IS NULL OR octet_length(lease_token_hash) = 32
  ),
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  lease_expires_at timestamptz,
  provider_reference text CHECK (
    provider_reference IS NULL OR (
      provider_reference = btrim(provider_reference)
      AND length(provider_reference) BETWEEN 1 AND 500
    )
  ),
  last_error_code text CHECK (
    last_error_code IS NULL OR (
      last_error_code = lower(btrim(last_error_code))
      AND last_error_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'
    )
  ),
  last_summary text CHECK (
    last_summary IS NULL OR length(btrim(last_summary)) BETWEEN 1 AND 500
  ),
  created_by_actor_kind text NOT NULL CHECK (
    created_by_actor_kind IN ('user', 'worker', 'system')
  ),
  created_by_user_id uuid,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  completed_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, message_delivery_id),
  UNIQUE (workspace_id, id, provider_connection_id, environment),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((created_by_actor_kind = 'user') = (created_by_user_id IS NOT NULL)),
  CHECK ((state IN ('leased', 'calling')) =
    (lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state IN ('accepted', 'succeeded', 'failed', 'dead_letter', 'cancelled'))
    = (completed_at IS NOT NULL)),
  CHECK (state NOT IN ('accepted', 'succeeded') OR provider_reference IS NOT NULL),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX provider_operations_claim_idx
  ON app.provider_operations (state, next_attempt_at, created_at, id)
  WHERE state IN ('queued', 'leased', 'calling', 'retry_wait');

CREATE TABLE app.message_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  message_version_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  approval_decision text NOT NULL DEFAULT 'approved' CHECK (
    approval_decision = 'approved'
  ),
  provider_operation_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  channel_endpoint_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  conversation_channel text NOT NULL CHECK (
    conversation_channel IN ('email', 'sms', 'whatsapp', 'instagram', 'facebook')
  ),
  consent_channel text NOT NULL CHECK (
    consent_channel IN ('email', 'sms', 'whatsapp', 'social')
  ),
  purpose text NOT NULL CHECK (
    purpose = lower(btrim(purpose))
    AND purpose ~ '^[a-z][a-z0-9_.-]{0,99}$'
  ),
  consent_event_id uuid NOT NULL,
  endpoint_identity_sha256 bytea NOT NULL CHECK (
    octet_length(endpoint_identity_sha256) = 32
  ),
  environment text NOT NULL CHECK (environment IN ('test', 'sandbox', 'live')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'sending', 'accepted', 'delivered', 'read', 'failed',
    'reconciliation_required', 'cancelled'
  )),
  idempotency_key text NOT NULL CHECK (
    idempotency_key = btrim(idempotency_key)
    AND length(idempotency_key) BETWEEN 1 AND 200
  ),
  created_by_user_id uuid NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  accepted_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, provider_operation_id),
  UNIQUE (workspace_id, provider_operation_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (
    workspace_id, conversation_id, message_id,
    message_version_id, version_number, body_sha256
  ) REFERENCES app.message_versions (
    workspace_id, conversation_id, message_id,
    id, version_number, body_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, conversation_id, message_id, message_version_id,
    approval_request_id, approval_decision_id,
    version_number, body_sha256, approval_decision
  ) REFERENCES app.message_approval_decisions (
    workspace_id, conversation_id, message_id, message_version_id,
    approval_request_id, id, version_number, body_sha256, decision
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, provider_operation_id, provider_connection_id, environment
  ) REFERENCES app.provider_operations (
    workspace_id, id, provider_connection_id, environment
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, channel_endpoint_id, provider_connection_id,
    conversation_channel, environment
  ) REFERENCES app.channel_endpoints (
    workspace_id, id, provider_connection_id, channel, environment
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, consent_event_id)
    REFERENCES app.communication_consent_events (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (updated_at >= queued_at),
  CHECK (status NOT IN ('accepted', 'delivered', 'read') OR accepted_at IS NOT NULL),
  CHECK (status NOT IN ('queued', 'sending', 'reconciliation_required', 'cancelled')
    OR accepted_at IS NULL),
  CHECK ((status IN ('delivered', 'read')) = (delivered_at IS NOT NULL)),
  CHECK ((status = 'read') = (read_at IS NOT NULL)),
  CHECK ((status = 'failed') = (failed_at IS NOT NULL)),
  CHECK (accepted_at IS NULL OR accepted_at >= queued_at),
  CHECK (delivered_at IS NULL OR delivered_at >= queued_at),
  CHECK (read_at IS NULL OR read_at >= queued_at),
  CHECK (failed_at IS NULL OR failed_at >= queued_at)
);

ALTER TABLE app.provider_operations
  ADD CONSTRAINT provider_operations_exact_delivery_fk
  FOREIGN KEY (workspace_id, id, message_delivery_id)
  REFERENCES app.message_deliveries (workspace_id, provider_operation_id, id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.provider_operation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  provider_operation_id uuid NOT NULL,
  attempt_number smallint NOT NULL CHECK (attempt_number BETWEEN 1 AND 8),
  worker_id uuid NOT NULL,
  lease_version bigint NOT NULL CHECK (lease_version > 0),
  attempt_kind text NOT NULL CHECK (attempt_kind IN ('dispatch', 'reconcile')),
  state text NOT NULL CHECK (state IN (
    'leased', 'calling', 'accepted', 'pending', 'succeeded', 'failed',
    'needs_attention'
  )),
  retryable boolean,
  error_code text CHECK (
    error_code IS NULL OR (
      error_code = lower(btrim(error_code))
      AND error_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'
    )
  ),
  safe_summary text CHECK (
    safe_summary IS NULL OR length(btrim(safe_summary)) BETWEEN 1 AND 500
  ),
  provider_occurred_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  completed_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, provider_operation_id, attempt_number),
  UNIQUE (workspace_id, provider_operation_id, lease_version),
  FOREIGN KEY (workspace_id, provider_operation_id)
    REFERENCES app.provider_operations (workspace_id, id) ON DELETE RESTRICT,
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK ((state IN ('leased', 'calling')) = (completed_at IS NULL))
);

CREATE TABLE app.provider_operation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  provider_operation_id uuid NOT NULL,
  message_delivery_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (
    source_kind IN ('test_provider', 'verified_webhook', 'worker_reconcile')
  ),
  external_event_id text NOT NULL CHECK (
    external_event_id = btrim(external_event_id)
    AND length(external_event_id) BETWEEN 1 AND 500
  ),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  delivery_status text NOT NULL CHECK (
    delivery_status IN ('accepted', 'delivered', 'read', 'failed')
  ),
  error_code text CHECK (
    error_code IS NULL OR (
      error_code = lower(btrim(error_code))
      AND error_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'
    )
  ),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'worker', 'webhook', 'system')),
  actor_user_id uuid,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, provider_operation_id, external_event_id),
  FOREIGN KEY (workspace_id, provider_operation_id)
    REFERENCES app.provider_operations (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, provider_operation_id, message_delivery_id)
    REFERENCES app.message_deliveries (workspace_id, provider_operation_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL))
);

-- Reusable guards keep direct SQL under the command identity inside the same
-- state machine as the TypeScript service.
CREATE FUNCTION app_private.touch_inbox_mutable_row()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.row_version IS DISTINCT FROM OLD.row_version + 1 THEN
    RAISE EXCEPTION 'invalid inbox row version transition' USING ERRCODE = '40001';
  END IF;
  IF TG_TABLE_NAME = 'provider_connections' THEN
    IF NEW.provider_id IS DISTINCT FROM OLD.provider_id
       OR NEW.provider_kind IS DISTINCT FROM OLD.provider_kind
       OR NEW.environment IS DISTINCT FROM OLD.environment
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
      RAISE EXCEPTION 'immutable inbox identity cannot be changed' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'channel_endpoints' THEN
    IF NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id
       OR NEW.channel IS DISTINCT FROM OLD.channel
       OR NEW.environment IS DISTINCT FROM OLD.environment THEN
      RAISE EXCEPTION 'immutable inbox identity cannot be changed' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'inboxes' THEN
    IF NEW.channel_endpoint_id IS DISTINCT FROM OLD.channel_endpoint_id
       OR NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id
       OR NEW.channel IS DISTINCT FROM OLD.channel
       OR NEW.environment IS DISTINCT FROM OLD.environment THEN
      RAISE EXCEPTION 'immutable inbox identity cannot be changed' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'conversations' THEN
    IF NEW.inbox_id IS DISTINCT FROM OLD.inbox_id
       OR NEW.channel IS DISTINCT FROM OLD.channel
       OR NEW.environment IS DISTINCT FROM OLD.environment
       OR NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
      RAISE EXCEPTION 'immutable inbox identity cannot be changed' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unexpected mutable inbox table' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_message_update()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.contact_point_id IS DISTINCT FROM OLD.contact_point_id
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.created_by_actor_kind IS DISTINCT FROM OLD.created_by_actor_kind
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.row_version IS DISTINCT FROM OLD.row_version + 1 THEN
    RAISE EXCEPTION 'invalid message row version transition' USING ERRCODE = '40001';
  END IF;

  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
     OR NEW.current_version_number IS DISTINCT FROM OLD.current_version_number
     OR NEW.current_body_sha256 IS DISTINCT FROM OLD.current_body_sha256 THEN
    IF OLD.lifecycle <> 'draft' OR NEW.lifecycle <> 'draft'
       OR NEW.current_version_number <> OLD.current_version_number + 1 THEN
      RAISE EXCEPTION 'message revision must create the next draft version'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.lifecycle IS NOT DISTINCT FROM OLD.lifecycle THEN
    RAISE EXCEPTION 'message update must advance lifecycle or append a version'
      USING ERRCODE = '23514';
  ELSIF OLD.lifecycle = 'draft' AND NEW.lifecycle = 'approval_pending' AND NOT EXISTS (
    SELECT 1 FROM app.message_approval_requests AS request
    LEFT JOIN app.message_approval_decisions AS decision
      ON decision.workspace_id = request.workspace_id
     AND decision.approval_request_id = request.id
    WHERE request.workspace_id = NEW.workspace_id
      AND request.message_id = NEW.id
      AND request.message_version_id = NEW.current_version_id
      AND request.body_sha256 = NEW.current_body_sha256
      AND decision.id IS NULL
  ) THEN
    RAISE EXCEPTION 'message approval-pending state needs an exact pending request'
      USING ERRCODE = '23514';
  ELSIF OLD.lifecycle = 'approval_pending' AND NEW.lifecycle = 'approved' AND NOT EXISTS (
    SELECT 1 FROM app.message_approval_decisions AS decision
    WHERE decision.workspace_id = NEW.workspace_id
      AND decision.message_id = NEW.id
      AND decision.message_version_id = NEW.current_version_id
      AND decision.body_sha256 = NEW.current_body_sha256
      AND decision.decision = 'approved'
  ) THEN
    RAISE EXCEPTION 'message approved state needs an exact approval decision'
      USING ERRCODE = '23514';
  ELSIF OLD.lifecycle = 'approval_pending' AND NEW.lifecycle = 'draft' AND NOT EXISTS (
    SELECT 1 FROM app.message_approval_decisions AS decision
    WHERE decision.workspace_id = NEW.workspace_id
      AND decision.message_id = NEW.id
      AND decision.message_version_id = NEW.current_version_id
      AND decision.body_sha256 = NEW.current_body_sha256
      AND decision.decision IN ('rejected', 'changes_requested')
  ) THEN
    RAISE EXCEPTION 'message draft return needs an exact non-approval decision'
      USING ERRCODE = '23514';
  ELSIF OLD.lifecycle = 'approved' AND NEW.lifecycle = 'committed' AND NOT EXISTS (
    SELECT 1 FROM app.message_deliveries AS delivery
    WHERE delivery.workspace_id = NEW.workspace_id
      AND delivery.message_id = NEW.id
      AND delivery.message_version_id = NEW.current_version_id
      AND delivery.body_sha256 = NEW.current_body_sha256
  ) THEN
    RAISE EXCEPTION 'message committed state needs an exact delivery intent'
      USING ERRCODE = '23514';
  ELSIF NOT (
    (OLD.lifecycle = 'draft' AND NEW.lifecycle = 'approval_pending')
    OR (OLD.lifecycle = 'approval_pending' AND NEW.lifecycle IN ('approved', 'draft'))
    OR (OLD.lifecycle = 'approved' AND NEW.lifecycle = 'committed')
  ) THEN
    RAISE EXCEPTION 'invalid message lifecycle transition' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_message_approval_request_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  expected_number integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.messages AS message
    WHERE message.workspace_id = NEW.workspace_id
      AND message.id = NEW.message_id
      AND message.direction = 'outbound'
      AND message.lifecycle = 'draft'
      AND message.current_version_id = NEW.message_version_id
      AND message.current_version_number = NEW.version_number
      AND message.current_body_sha256 = NEW.body_sha256
  ) THEN
    RAISE EXCEPTION 'approval request must bind the exact current outbound draft'
      USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM app.message_approval_requests AS request
    LEFT JOIN app.message_approval_decisions AS decision
      ON decision.workspace_id = request.workspace_id
     AND decision.approval_request_id = request.id
    WHERE request.workspace_id = NEW.workspace_id
      AND request.message_id = NEW.message_id
      AND request.message_version_id = NEW.message_version_id
      AND decision.id IS NULL
  ) THEN
    RAISE EXCEPTION 'message version already has a pending approval request'
      USING ERRCODE = '23505';
  END IF;

  SELECT coalesce(max(request.request_number), 0) + 1
    INTO expected_number
  FROM app.message_approval_requests AS request
  WHERE request.workspace_id = NEW.workspace_id
    AND request.message_id = NEW.message_id
    AND request.message_version_id = NEW.message_version_id;

  IF NEW.request_number <> expected_number THEN
    RAISE EXCEPTION 'message approval request number must be the next value'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_message_approval_decision_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.messages AS message
    WHERE message.workspace_id = NEW.workspace_id
      AND message.id = NEW.message_id
      AND message.lifecycle = 'approval_pending'
      AND message.current_version_id = NEW.message_version_id
      AND message.current_version_number = NEW.version_number
      AND message.current_body_sha256 = NEW.body_sha256
  ) THEN
    RAISE EXCEPTION 'approval decision must bind the exact pending message version'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.guard_message_delivery_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  point_kind text;
  point_value text;
  point_normalized text;
  expected_consent_channel text;
  active_suppression uuid;
  latest_consent uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.messages AS message
    JOIN app.message_approval_decisions AS decision
      ON decision.workspace_id = message.workspace_id
     AND decision.id = NEW.approval_decision_id
     AND decision.message_id = message.id
     AND decision.message_version_id = message.current_version_id
     AND decision.body_sha256 = message.current_body_sha256
     AND decision.decision = 'approved'
    JOIN app.provider_operations AS operation
      ON operation.workspace_id = message.workspace_id
     AND operation.id = NEW.provider_operation_id
     AND operation.provider_connection_id = NEW.provider_connection_id
     AND operation.environment = NEW.environment
     AND operation.operation_kind = 'conversation.send'
     AND operation.state = 'queued'
    WHERE message.workspace_id = NEW.workspace_id
      AND message.id = NEW.message_id
      AND message.conversation_id = NEW.conversation_id
      AND message.contact_id = NEW.contact_id
      AND message.direction = 'outbound'
      AND message.lifecycle = 'approved'
      AND message.current_version_id = NEW.message_version_id
      AND message.current_version_number = NEW.version_number
      AND message.current_body_sha256 = NEW.body_sha256
  ) THEN
    RAISE EXCEPTION 'delivery needs the exact approved message and queued operation'
      USING ERRCODE = '40001';
  END IF;

  SELECT point.kind, point.value, point.normalized_value
    INTO point_kind, point_value, point_normalized
  FROM app.contact_points AS point
  WHERE point.workspace_id = NEW.workspace_id
    AND point.id = NEW.contact_point_id
    AND point.contact_id = NEW.contact_id
    AND point.deleted_at IS NULL
    AND point.is_verified
    AND point.dedupe_state = 'normal';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery contact endpoint is unavailable'
      USING ERRCODE = '23514';
  END IF;

  expected_consent_channel := CASE NEW.conversation_channel
    WHEN 'email' THEN 'email'
    WHEN 'sms' THEN 'sms'
    WHEN 'whatsapp' THEN 'whatsapp'
    WHEN 'instagram' THEN 'social'
    WHEN 'facebook' THEN 'social'
  END;
  IF NEW.consent_channel IS DISTINCT FROM expected_consent_channel
     OR point_kind IS DISTINCT FROM (CASE NEW.consent_channel
       WHEN 'email' THEN 'email'
       WHEN 'sms' THEN 'phone'
       WHEN 'whatsapp' THEN 'whatsapp'
       WHEN 'social' THEN 'social'
     END) THEN
    RAISE EXCEPTION 'delivery channel does not match the contact endpoint'
      USING ERRCODE = '23514';
  END IF;

  NEW.endpoint_identity_sha256 := public.digest(
    point_kind || pg_catalog.chr(31)
      || point_value || pg_catalog.chr(31) || point_normalized,
    'sha256'
  );

  SELECT event.id
    INTO latest_consent
  FROM app.communication_consent_events AS event
  WHERE event.workspace_id = NEW.workspace_id
    AND event.contact_id = NEW.contact_id
    AND event.contact_point_id = NEW.contact_point_id
    AND event.channel = NEW.consent_channel
    AND event.purpose = NEW.purpose
    AND event.endpoint_identity_sha256 = NEW.endpoint_identity_sha256
    AND event.occurred_at <= statement_timestamp() + interval '5 minutes'
  ORDER BY event.occurred_at DESC, event.recorded_at DESC, event.id DESC
  LIMIT 1;

  SELECT suppression.id
    INTO active_suppression
  FROM (
    SELECT DISTINCT ON (coalesce(event.purpose, ''))
      event.id, event.state, event.occurred_at, event.recorded_at
    FROM app.communication_suppression_events AS event
    WHERE event.workspace_id = NEW.workspace_id
      AND event.contact_id = NEW.contact_id
      AND event.contact_point_id = NEW.contact_point_id
      AND event.channel = NEW.consent_channel
      AND (event.purpose IS NULL OR event.purpose = NEW.purpose)
      AND event.endpoint_identity_sha256 = NEW.endpoint_identity_sha256
      AND event.occurred_at <= statement_timestamp() + interval '5 minutes'
    ORDER BY coalesce(event.purpose, ''), event.occurred_at DESC,
      event.recorded_at DESC, event.id DESC
  ) AS suppression
  WHERE suppression.state = 'suppressed'
  ORDER BY suppression.occurred_at DESC, suppression.recorded_at DESC,
    suppression.id DESC
  LIMIT 1;

  IF active_suppression IS NOT NULL
     OR latest_consent IS DISTINCT FROM NEW.consent_event_id
     OR NOT EXISTS (
       SELECT 1 FROM app.communication_consent_events AS consent
       WHERE consent.workspace_id = NEW.workspace_id
         AND consent.id = latest_consent
         AND consent.state = 'granted'
     ) THEN
    RAISE EXCEPTION 'delivery is not authorised by current consent evidence'
      USING ERRCODE = '42501';
  END IF;

  -- The only provider this migration permits command code to queue is an
  -- in-process test adapter, and its destinations are deliberately non-routable.
  IF NEW.environment <> 'test'
     OR NOT EXISTS (
       SELECT 1 FROM app.provider_connections AS connection
       WHERE connection.workspace_id = NEW.workspace_id
         AND connection.id = NEW.provider_connection_id
         AND connection.provider_id = 'test_conversation'
         AND connection.environment = 'test'
         AND connection.status = 'active'
     )
     OR NOT (
       (NEW.conversation_channel = 'email'
         AND point_normalized ~* '^[^[:space:]@]+@[^[:space:]@]+[.]invalid$')
        OR (NEW.conversation_channel IN ('sms', 'whatsapp')
          AND point_normalized ~ '^[+]447700900[0-9]{3}$')
       OR (NEW.conversation_channel IN ('instagram', 'facebook')
         AND point_normalized ~ '^test:[a-z0-9_.-]{1,100}$')
     ) THEN
    RAISE EXCEPTION 'test delivery requires a reserved non-routable destination'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.reject_inbox_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'inbox versions, approvals and receipts are append-only'
    USING ERRCODE = '55000';
END;
$function$;

DO $mutable_row_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'provider_connections', 'channel_endpoints', 'inboxes', 'conversations'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON app.%I
       FOR EACH ROW EXECUTE FUNCTION app_private.touch_inbox_mutable_row()',
      table_name || '_touch_update', table_name
    );
  END LOOP;
END;
$mutable_row_triggers$;

CREATE TRIGGER messages_guard_update
BEFORE UPDATE ON app.messages
FOR EACH ROW EXECUTE FUNCTION app_private.guard_message_update();
CREATE TRIGGER message_approval_requests_guard_insert
BEFORE INSERT ON app.message_approval_requests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_message_approval_request_insert();
CREATE TRIGGER message_approval_decisions_guard_insert
BEFORE INSERT ON app.message_approval_decisions
FOR EACH ROW EXECUTE FUNCTION app_private.guard_message_approval_decision_insert();
CREATE TRIGGER message_deliveries_guard_insert
BEFORE INSERT ON app.message_deliveries
FOR EACH ROW EXECUTE FUNCTION app_private.guard_message_delivery_insert();

REVOKE ALL ON FUNCTION app_private.touch_inbox_mutable_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_message_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_message_approval_request_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_message_approval_decision_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_message_delivery_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reject_inbox_append_only_mutation() FROM PUBLIC;

DO $append_only_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'message_versions', 'message_approval_requests',
    'message_approval_decisions', 'provider_operation_receipts'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I
       FOR EACH ROW EXECUTE FUNCTION app_private.reject_inbox_append_only_mutation()',
      table_name || '_append_only', table_name
    );
  END LOOP;
END;
$append_only_triggers$;

DO $inbox_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'provider_connections', 'channel_endpoints', 'inboxes', 'conversations',
    'messages', 'message_versions', 'message_approval_requests',
    'message_approval_decisions', 'provider_operations', 'message_deliveries',
    'provider_operation_attempts', 'provider_operation_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)',
      table_name || '_owner_all', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_web, r72_crm_command
       USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.has_active_workspace_membership(
           app_private.current_user_id(), workspace_id
         )
       )',
      table_name || '_member_select', table_name
    );
  END LOOP;
END;
$inbox_rls$;

-- This release can create test connections only. Live/sandbox onboarding is a
-- later provider-specific OAuth/credential boundary.
CREATE POLICY provider_connections_test_manager_insert
  ON app.provider_connections FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(app_private.current_user_id(), workspace_id)
    AND created_by_user_id = app_private.current_user_id()
    AND provider_id = 'test_conversation'
    AND environment = 'test'
  );
CREATE POLICY provider_connections_test_manager_update
  ON app.provider_connections FOR UPDATE TO r72_crm_command USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(app_private.current_user_id(), workspace_id)
    AND provider_id = 'test_conversation' AND environment = 'test'
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(app_private.current_user_id(), workspace_id)
    AND provider_id = 'test_conversation' AND environment = 'test'
  );

DO $test_configuration_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['channel_endpoints', 'inboxes'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR INSERT TO r72_crm_command WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), workspace_id
         )
         AND environment = ''test''
       )', table_name || '_test_manager_insert', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR UPDATE TO r72_crm_command USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), workspace_id
         )
         AND environment = ''test''
       ) WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), workspace_id
         )
         AND environment = ''test''
       )', table_name || '_test_manager_update', table_name
    );
  END LOOP;
END;
$test_configuration_policies$;

CREATE POLICY conversations_command_insert ON app.conversations
  FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND environment = 'test'
  );
CREATE POLICY conversations_command_update ON app.conversations
  FOR UPDATE TO r72_crm_command USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND environment = 'test'
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND environment = 'test'
  );

CREATE POLICY messages_command_insert ON app.messages
  FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND environment = 'test'
    AND created_by_actor_kind = 'user'
    AND created_by_user_id = app_private.current_user_id()
    AND source_kind IN ('user', 'test_fixture')
  );
CREATE POLICY messages_command_update ON app.messages
  FOR UPDATE TO r72_crm_command USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND environment = 'test'
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND environment = 'test'
  );
CREATE POLICY message_versions_command_insert ON app.message_versions
  FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND environment = 'test'
    AND created_by_actor_kind = 'user'
    AND created_by_user_id = app_private.current_user_id()
    AND created_request_id = app_private.current_request_id()
  );
CREATE POLICY message_approval_requests_command_insert
  ON app.message_approval_requests FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND requested_by_user_id = app_private.current_user_id()
    AND requested_request_id = app_private.current_request_id()
  );
CREATE POLICY message_approval_decisions_manager_insert
  ON app.message_approval_decisions FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(app_private.current_user_id(), workspace_id)
    AND decided_by_user_id = app_private.current_user_id()
    AND decided_request_id = app_private.current_request_id()
  );
CREATE POLICY provider_operations_test_manager_insert
  ON app.provider_operations FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(app_private.current_user_id(), workspace_id)
    AND environment = 'test' AND state = 'queued' AND attempt_count = 0
    AND lease_token_hash IS NULL AND lease_expires_at IS NULL
    AND created_by_actor_kind = 'user'
    AND created_by_user_id = app_private.current_user_id()
  );
CREATE POLICY message_deliveries_test_manager_insert
  ON app.message_deliveries FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(app_private.current_user_id(), workspace_id)
    AND environment = 'test' AND status = 'queued'
    AND created_by_user_id = app_private.current_user_id()
  );

CREATE POLICY command_receipts_inbox_select ON app.command_receipts
  FOR SELECT TO r72_crm_command USING (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.has_active_workspace_membership(actor_user_id, workspace_id)
    AND command_name LIKE 'inbox.%'
  );
CREATE POLICY command_receipts_inbox_insert ON app.command_receipts
  FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(actor_user_id, workspace_id)
    AND command_name LIKE 'inbox.%' AND status = 'started'
  );
CREATE POLICY command_receipts_inbox_update ON app.command_receipts
  FOR UPDATE TO r72_crm_command USING (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(actor_user_id, workspace_id)
    AND command_name LIKE 'inbox.%' AND status = 'started'
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(actor_user_id, workspace_id)
    AND command_name LIKE 'inbox.%' AND status IN ('succeeded', 'failed')
  );

GRANT SELECT ON app.provider_connections, app.channel_endpoints, app.inboxes,
  app.conversations, app.messages, app.message_versions,
  app.message_approval_requests, app.message_approval_decisions,
  app.provider_operations, app.message_deliveries,
  app.provider_operation_attempts, app.provider_operation_receipts
TO r72_web, r72_crm_command;

GRANT INSERT ON app.provider_connections, app.channel_endpoints, app.inboxes,
  app.conversations, app.messages, app.message_versions,
  app.message_approval_requests, app.message_approval_decisions,
  app.provider_operations, app.message_deliveries
TO r72_crm_command;
GRANT UPDATE ON app.provider_connections, app.channel_endpoints, app.inboxes,
  app.conversations, app.messages TO r72_crm_command;
GRANT SELECT, INSERT ON app.command_receipts TO r72_crm_command;
GRANT UPDATE (result, status, response_status, completed_at)
  ON app.command_receipts TO r72_crm_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'provider_connections', 'workspace_id'),
  ('app', 'channel_endpoints', 'workspace_id'),
  ('app', 'inboxes', 'workspace_id'),
  ('app', 'conversations', 'workspace_id'),
  ('app', 'messages', 'workspace_id'),
  ('app', 'message_versions', 'workspace_id'),
  ('app', 'message_approval_requests', 'workspace_id'),
  ('app', 'message_approval_decisions', 'workspace_id'),
  ('app', 'provider_operations', 'workspace_id'),
  ('app', 'message_deliveries', 'workspace_id'),
  ('app', 'provider_operation_attempts', 'workspace_id'),
  ('app', 'provider_operation_receipts', 'workspace_id');

DO $inbox_capability_check$
DECLARE
  immutable_table text;
  worker_table text;
BEGIN
  IF pg_catalog.has_table_privilege('r72_web', 'app.messages', 'INSERT')
     OR pg_catalog.has_table_privilege('r72_worker', 'app.provider_operations', 'UPDATE')
     OR pg_catalog.has_table_privilege('r72_crm_command', 'app.provider_operation_attempts', 'INSERT')
     OR pg_catalog.has_table_privilege('r72_crm_command', 'app.provider_operation_receipts', 'INSERT')
     OR pg_catalog.has_table_privilege('r72_crm_command', 'app.message_deliveries', 'UPDATE') THEN
    RAISE EXCEPTION 'unsafe inbox/provider-operation runtime table capability';
  END IF;

  FOREACH immutable_table IN ARRAY ARRAY[
    'message_versions', 'message_approval_requests',
    'message_approval_decisions', 'provider_operation_receipts'
  ] LOOP
    IF pg_catalog.has_table_privilege(
         'r72_crm_command', 'app.' || immutable_table, 'UPDATE'
       ) OR pg_catalog.has_table_privilege(
         'r72_crm_command', 'app.' || immutable_table, 'DELETE'
       ) THEN
      RAISE EXCEPTION 'unsafe append-only inbox capability on %', immutable_table;
    END IF;
  END LOOP;

  -- The worker receives exact leased payloads only through the fenced
  -- SECURITY DEFINER functions installed by 0023. It must never be able to
  -- select arbitrary message bodies by choosing a workspace GUC.
  FOREACH worker_table IN ARRAY ARRAY[
    'provider_connections', 'channel_endpoints', 'inboxes', 'conversations',
    'messages', 'message_versions', 'message_approval_requests',
    'message_approval_decisions', 'provider_operations', 'message_deliveries',
    'provider_operation_attempts', 'provider_operation_receipts'
  ] LOOP
    IF pg_catalog.has_table_privilege(
         'r72_worker', 'app.' || worker_table, 'SELECT'
       ) THEN
      RAISE EXCEPTION 'unsafe direct worker read capability on %', worker_table;
    END IF;
  END LOOP;
END;
$inbox_capability_check$;
