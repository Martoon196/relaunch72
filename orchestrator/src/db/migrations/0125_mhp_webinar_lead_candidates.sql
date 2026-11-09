-- GHQ-WEBINAR-004. Read only existing campaign/signup evidence under the real
-- selected native owner session. No queue lease, send, table grant or CRM write.
SET LOCAL ROLE r72_mhp_member_definer;
GRANT EXECUTE ON FUNCTION app_private.mhp_marketing_workspace_allowed(uuid,uuid)
 TO r72_mhp_prospect_definer;
RESET ROLE;
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
SET LOCAL ROLE r72_mhp_prospect_definer;

CREATE FUNCTION app_private.mhp_webinar_lead_candidates(
 p_session bytea,p_campaign text,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 25
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid; candidates jsonb; more boolean; next_after uuid;
BEGIN
 IF p_session IS NULL OR octet_length(p_session)<>32
  OR p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$'
  OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25
 THEN RAISE EXCEPTION 'Invalid webinar candidate request' USING ERRCODE='22023'; END IF;
 SELECT r.user_id,r.selected_workspace_id INTO actor,selected
 FROM app_private.resolve_session(p_session) r JOIN app.user_sessions s ON s.id=r.session_id
 WHERE s.product_audience='martin_howard_property';
 IF actor IS NULL OR selected IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'::uuid
  OR NOT app_private.mhp_marketing_workspace_allowed(actor,selected)
 THEN RAISE EXCEPTION 'Selected MHP marketing owner session required' USING ERRCODE='42501'; END IF;

 -- 0121 stores campaign on send rows, not on signups. Capture serializes by
 -- email and writes the signup before its first scheduled campaign rows. The
 -- closest preceding webinar signup is that existing chronological anchor;
 -- this is not a new FK or a guess for a signup without any campaign evidence.
 -- Completed/cancelled/failed sends remain evidence; their state is not changed.
 WITH anchors AS (
  SELECT s.prospect_id,min(s.created_at) AS captured_at
  FROM app_private.mhp_marketing_sends s
  WHERE s.campaign_key=p_campaign
   AND s.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup')
   AND (p_after IS NULL OR s.prospect_id>p_after)
  GROUP BY s.prospect_id
 ), bounded AS (
  SELECT p.id AS prospect_id,p.email::text AS email,p.first_name,p.level,
   p.marketing_consent,p.unsubscribed_at IS NOT NULL AS unsubscribed,
   signup.id AS signup_id,signup.label,signup.created_at AS registered_at,signup.link,signup.consent_given
  FROM anchors a JOIN app_private.mhp_prospects p ON p.id=a.prospect_id
  CROSS JOIN LATERAL (
   SELECT s.id,s.label,s.created_at,s.link,s.consent_given
   FROM app_private.mhp_prospect_signups s
   WHERE s.prospect_id=p.id AND s.kind='webinar' AND s.created_at<=a.captured_at
   ORDER BY s.created_at DESC,s.id DESC LIMIT 1
  ) signup
  ORDER BY p.id LIMIT p_limit+1
 ), page AS (
  SELECT * FROM bounded ORDER BY prospect_id LIMIT p_limit
 )
 SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'prospectId',p.prospect_id,'signupId',p.signup_id,'campaign',p_campaign,
   'email',p.email,'firstName',p.first_name,'level',p.level,'label',p.label,
   'registeredAt',p.registered_at,'link',p.link,'marketingConsent',p.marketing_consent,
   'unsubscribed',p.unsubscribed,'signupConsentGiven',p.consent_given) ORDER BY p.prospect_id) FROM page p),'[]'::jsonb),
  (SELECT count(*)>p_limit FROM bounded),
  (SELECT p.prospect_id FROM page p ORDER BY p.prospect_id DESC LIMIT 1)
 INTO candidates,more,next_after;
 RETURN jsonb_build_object('campaign',p_campaign,'candidates',candidates,
  'hasMore',more,'nextAfter',CASE WHEN more THEN next_after ELSE NULL END);
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_webinar_lead_candidates(bytea,text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_webinar_lead_candidates(bytea,text,uuid,integer) TO r72_web;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
