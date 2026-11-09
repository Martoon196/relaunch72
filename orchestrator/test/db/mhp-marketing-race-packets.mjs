/**
 * GHQ-WEBINAR-003. ROOT EXECUTION ONLY on a disposable, exact-0124 clone.
 * This module generates SQL; it does not open a connection or execute a query.
 * Execute seed once, then each phase's two calls in separate simultaneous
 * transactions, then its assertion transaction. Inspect actual overlap from
 * startedAt/completedAt; sequential success is not a concurrency pass.
 * All hashes are synthetic. Delete the disposable branch after evidence capture.
 */
export const raceGuard = `DO $guard$ BEGIN
 IF current_setting('mhp.proof.enabled',true) IS DISTINCT FROM 'isolated'
 THEN RAISE EXCEPTION 'Isolated MHP proof not enabled'; END IF;
END $guard$;`;

const brand = '2789228d-55a6-4688-b1e8-2f70abca990b';
const org = 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';

export const raceSeed = `${raceGuard}
SET LOCAL ROLE r72_owner;
DO $seed$
DECLARE actor uuid; personal uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.schema_migrations
   WHERE filename='0124_mhp_brand_marketing_workspace.sql')
  OR EXISTS(SELECT 1 FROM app.workspaces WHERE id='${brand}'
   OR(organization_id='${org}' AND slug::text='mhp-brand-marketing'))
  OR EXISTS(SELECT 1 FROM app.user_sessions WHERE token_hash IN(
   public.digest('marketing-race-owner-a','sha256'),public.digest('marketing-race-owner-b','sha256'),public.digest('marketing-race-owner-c','sha256')))
 THEN RAISE EXCEPTION 'Require a fresh disposable 0124 marketing race branch'; END IF;
 SELECT u.id,m.workspace_id INTO actor,personal FROM app.users u
 JOIN app_private.investor_programme_admins a ON a.user_id=u.id
 JOIN app.organization_memberships om ON om.user_id=u.id AND om.organization_id='${org}'
  AND om.role='owner' AND om.status='active' AND om.revoked_at IS NULL
 JOIN app_private.mhp_members m ON m.user_id=u.id
 JOIN app.workspace_memberships wm ON wm.workspace_id=m.workspace_id AND wm.user_id=u.id
  AND wm.role='owner' AND wm.status='active' AND wm.revoked_at IS NULL
 WHERE lower(u.email::text)='martin.howard1984@gmail.com' AND u.status='active' AND u.email_verified_at IS NOT NULL;
 IF actor IS NULL OR personal IS NULL THEN RAISE EXCEPTION 'Cloned verified founder and personal Desk are required'; END IF;
 INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
 SELECT public.digest(label,'sha256'),public.digest(label||'-csrf','sha256'),actor,personal,clock_timestamp()+interval '1 hour','martin_howard_property'
 FROM(VALUES('marketing-race-owner-a'),('marketing-race-owner-b'),('marketing-race-owner-c')) t(label);
END $seed$;`;

function command(source, action, target, commandId) {
  return `${raceGuard}
SET LOCAL ROLE r72_identity_command;
SELECT set_config('mhp.race.started',clock_timestamp()::text,true);
DO $race$
DECLARE result record;
BEGIN
 BEGIN
  SELECT * INTO result FROM app_private.select_mhp_marketing_workspace(
   public.digest('${source}','sha256'),'${action}',public.digest('${target}','sha256'),
   public.digest('${target}-csrf','sha256'),'${commandId}');
  PERFORM set_config('mhp.race.result',jsonb_build_object('outcome','selected','workspaceId',result.selected_workspace_id)::text,true);
 EXCEPTION WHEN insufficient_privilege THEN
  PERFORM set_config('mhp.race.result','{"outcome":"denied","sqlstate":"42501"}',true);
 END;
END $race$;
-- Hold the successful command's transaction lock briefly, giving the other
-- simultaneous request time to contend. No lease/session rule is bypassed.
SELECT pg_sleep(1) WHERE current_setting('mhp.race.result')::jsonb->>'outcome'='selected';
SELECT current_setting('mhp.race.result')::jsonb || jsonb_build_object(
 'startedAt',current_setting('mhp.race.started'),'completedAt',clock_timestamp()) AS race_result;`;
}

function assertion(body) {
  return `${raceGuard}
SET LOCAL ROLE r72_owner;
DO $assert$
DECLARE actor uuid; personal uuid;
BEGIN
 SELECT u.id,m.workspace_id INTO actor,personal FROM app.users u
 JOIN app_private.mhp_members m ON m.user_id=u.id WHERE lower(u.email::text)='martin.howard1984@gmail.com';
 IF actor IS NULL OR personal IS NULL THEN RAISE EXCEPTION 'Race actor missing'; END IF;
 ${body}
END $assert$;
SELECT 'race assertions passed' AS proof;`;
}

export const racePhases = [
  {
    name: 'independent owner opens create one workspace and retain both devices',
    expectedOutcomes: ['selected', 'selected'],
    calls: [
      command('marketing-race-owner-a', 'open', 'marketing-race-brand-a', 'ed124001-0000-4000-8000-000000000001'),
      command('marketing-race-owner-b', 'open', 'marketing-race-brand-b', 'ed124001-0000-4000-8000-000000000002'),
    ],
    assert: assertion(`IF (SELECT count(*) FROM app.workspaces WHERE organization_id='${org}' AND slug::text='mhp-brand-marketing')<>1
  OR (SELECT count(*) FROM app.workspace_memberships WHERE workspace_id='${brand}' AND user_id=actor AND role='owner' AND status='active' AND revoked_at IS NULL)<>1
  OR (SELECT count(*) FROM app.pipelines WHERE workspace_id='${brand}')<>1
  OR (SELECT count(*) FROM app.pipeline_stages WHERE workspace_id='${brand}')<>8
  OR EXISTS(SELECT 1 FROM app_private.mhp_members WHERE workspace_id='${brand}')
  OR EXISTS(SELECT 1 FROM app.investor_businesses WHERE workspace_id='${brand}')
  OR (SELECT count(*) FROM app_private.mhp_marketing_workspace_events)<>2
  OR (SELECT count(*) FROM app.user_sessions WHERE token_hash IN(public.digest('marketing-race-brand-a','sha256'),public.digest('marketing-race-brand-b','sha256')) AND revoked_at IS NULL AND selected_workspace_id='${brand}')<>2
  OR (SELECT count(*) FROM app.user_sessions WHERE token_hash IN(public.digest('marketing-race-owner-a','sha256'),public.digest('marketing-race-owner-b','sha256')) AND revoked_at IS NOT NULL)<>2
  OR NOT EXISTS(SELECT 1 FROM app.user_sessions WHERE token_hash=public.digest('marketing-race-owner-c','sha256') AND revoked_at IS NULL AND selected_workspace_id=personal)
 THEN RAISE EXCEPTION 'Independent owner open race invariant failed'; END IF;`),
  },
  {
    name: 'same source session cannot fork two selected sessions',
    expectedOutcomes: ['denied', 'selected'],
    calls: [
      command('marketing-race-owner-c', 'open', 'marketing-race-brand-c1', 'ed124001-0000-4000-8000-000000000003'),
      command('marketing-race-owner-c', 'open', 'marketing-race-brand-c2', 'ed124001-0000-4000-8000-000000000004'),
    ],
    assert: assertion(`IF (SELECT count(*) FROM app.user_sessions WHERE token_hash IN(public.digest('marketing-race-brand-c1','sha256'),public.digest('marketing-race-brand-c2','sha256')))<>1
  OR (SELECT count(*) FROM app_private.mhp_marketing_workspace_events)<>3
  OR (SELECT count(*) FROM app_private.mhp_marketing_workspace_events e JOIN app.user_sessions s ON s.id=e.source_session_id WHERE s.token_hash=public.digest('marketing-race-owner-c','sha256'))<>1
  OR (SELECT count(*) FROM app.user_sessions WHERE token_hash IN(public.digest('marketing-race-brand-a','sha256'),public.digest('marketing-race-brand-b','sha256')) AND revoked_at IS NULL)<>2
 THEN RAISE EXCEPTION 'Concurrent open forked a session or revoked another device'; END IF;`),
  },
  {
    name: 'same brand session returns once without orphan successors',
    expectedOutcomes: ['denied', 'selected'],
    calls: [
      command('marketing-race-brand-a', 'return', 'marketing-race-personal-a1', 'ed124001-0000-4000-8000-000000000005'),
      command('marketing-race-brand-a', 'return', 'marketing-race-personal-a2', 'ed124001-0000-4000-8000-000000000006'),
    ],
    assert: assertion(`IF (SELECT count(*) FROM app.user_sessions WHERE token_hash IN(public.digest('marketing-race-personal-a1','sha256'),public.digest('marketing-race-personal-a2','sha256')))<>1
  OR (SELECT count(*) FROM app.user_sessions WHERE token_hash IN(public.digest('marketing-race-personal-a1','sha256'),public.digest('marketing-race-personal-a2','sha256')) AND revoked_at IS NULL AND selected_workspace_id=personal)<>1
  OR (SELECT count(*) FROM app_private.mhp_marketing_workspace_events)<>4
  OR (SELECT count(*) FROM app_private.mhp_marketing_workspace_events e JOIN app.user_sessions s ON s.id=e.source_session_id WHERE s.token_hash=public.digest('marketing-race-brand-a','sha256') AND e.action='return')<>1
  OR NOT EXISTS(SELECT 1 FROM app.user_sessions WHERE token_hash=public.digest('marketing-race-brand-a','sha256') AND revoked_at IS NOT NULL)
  OR NOT EXISTS(SELECT 1 FROM app.user_sessions WHERE token_hash=public.digest('marketing-race-brand-b','sha256') AND revoked_at IS NULL AND selected_workspace_id='${brand}')
  OR EXISTS(SELECT 1 FROM app_private.mhp_marketing_workspace_events e LEFT JOIN app.user_sessions s ON s.id=e.target_session_id WHERE s.id IS NULL)
 THEN RAISE EXCEPTION 'Concurrent return forked a session, lost audit, or revoked another device'; END IF;`),
  },
];
