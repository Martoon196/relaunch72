-- PRIVATE DRAFT. Tombstone immediately, erase payload separately with fenced retry.
-- Audit identities/digests remain; private payloads are removed. No provider deletion.
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_erasures(
 workspace_id uuid NOT NULL,id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('source','local_output')),
 requested_by uuid,reason text NOT NULL CHECK(reason IN('owner','retention')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 erased_at timestamptz,PRIMARY KEY(workspace_id,kind,id)
);
ALTER TABLE app.creative_media_erasures ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.creative_media_erasures FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.creative_media_erasures FROM PUBLIC,r72_web,r72_worker,r72_content_command;
CREATE POLICY media_erasure_owner ON app.creative_media_erasures FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY media_erasure_studio ON app.creative_media_erasures FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
CREATE POLICY media_erasure_worker ON app.creative_media_erasures FOR ALL TO r72_native_video_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT SELECT,INSERT ON app.creative_media_erasures TO r72_creative_studio_definer;
GRANT SELECT,INSERT,UPDATE ON app.creative_media_erasures TO r72_native_video_definer;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app','creative_media_erasures','workspace_id');
