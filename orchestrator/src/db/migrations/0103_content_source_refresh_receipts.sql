-- HQ-SOURCE-CHECK-013: source refresh uses its own idempotency receipt. The
-- adapter already writes source attestations, but 0021 allowed only creation
-- receipts. Preserve caller/workspace/status fences and add only this command.
SET LOCAL ROLE r72_owner;

ALTER POLICY command_receipts_content_adapter_select ON app.command_receipts
  USING (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.has_active_workspace_membership(actor_user_id, workspace_id)
    AND command_name IN ('companyContent.createVersion', 'companyContent.refreshSourceAttestation')
  );

ALTER POLICY command_receipts_content_adapter_insert ON app.command_receipts
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(actor_user_id, workspace_id)
    AND command_name IN ('companyContent.createVersion', 'companyContent.refreshSourceAttestation')
    AND status = 'started'
  );

ALTER POLICY command_receipts_content_adapter_update ON app.command_receipts
  USING (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(actor_user_id, workspace_id)
    AND command_name IN ('companyContent.createVersion', 'companyContent.refreshSourceAttestation')
    AND status = 'started'
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(actor_user_id, workspace_id)
    AND command_name IN ('companyContent.createVersion', 'companyContent.refreshSourceAttestation')
    AND status IN ('succeeded', 'failed')
  );

RESET ROLE;
