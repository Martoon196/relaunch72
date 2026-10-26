-- Additive staff-prepared numeric illustrations; no partner/contact submission.
SET LOCAL ROLE r72_owner;
CREATE TABLE app.finance_planning_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  opportunity_version bigint NOT NULL CHECK (opportunity_version > 0),
  creator_user_id uuid NOT NULL,
  review_nonce uuid NOT NULL,
  review_hash bytea NOT NULL CHECK (octet_length(review_hash) = 32),
  packet jsonb NOT NULL CHECK (jsonb_typeof(packet) = 'object' AND octet_length(packet::text) <= 16000),
  illustration jsonb NOT NULL CHECK (jsonb_typeof(illustration) = 'object' AND octet_length(illustration::text) <= 160000),
  calculated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, opportunity_id, version),
  UNIQUE (workspace_id, creator_user_id, review_nonce),
  FOREIGN KEY (workspace_id, opportunity_id, contact_id)
    REFERENCES app.opportunities(workspace_id, id, contact_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, creator_user_id)
    REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (created_at >= calculated_at)
);
CREATE INDEX finance_planning_drafts_contact_idx ON app.finance_planning_drafts(workspace_id, contact_id, created_at DESC);
ALTER TABLE app.finance_planning_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.finance_planning_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY finance_planning_drafts_owner ON app.finance_planning_drafts FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY finance_planning_drafts_read ON app.finance_planning_drafts FOR SELECT TO r72_web, r72_crm_command
  USING (workspace_id = app_private.current_workspace_id() AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id));
CREATE POLICY finance_planning_drafts_insert ON app.finance_planning_drafts FOR INSERT TO r72_crm_command
  WITH CHECK (workspace_id = app_private.current_workspace_id() AND creator_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id));
REVOKE ALL ON app.finance_planning_drafts FROM PUBLIC;
GRANT SELECT ON app.finance_planning_drafts TO r72_web;
GRANT SELECT, INSERT ON app.finance_planning_drafts TO r72_crm_command;
INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
VALUES ('app', 'finance_planning_drafts', 'workspace_id');
-- No UPDATE/DELETE grant: reviewed versions remain immutable. Existing parent
-- workspace/opportunity deletion cascades remove their dependent numeric rows.
