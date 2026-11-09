-- Cover the stable keyset order used by the bounded CRM list pages.
-- This changes no data, role, provider capability or external effect.

SET LOCAL ROLE r72_owner;

CREATE INDEX opportunities_workspace_updated_page_idx
  ON app.opportunities (workspace_id, updated_at DESC, id);

CREATE INDEX tasks_workspace_queue_page_idx
  ON app.tasks (
    workspace_id,
    (CASE status WHEN 'open' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END),
    due_at ASC NULLS LAST,
    updated_at DESC,
    id
  );
