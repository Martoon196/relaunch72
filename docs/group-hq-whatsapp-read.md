# GHQ-WHATSAPP-001 — Group HQ status adapter

Authorised founder/Astra connection and readiness slice, 30 October 2026. Exact base `97dcb98f9cdd1ef76e8a96b8ddfbd4c6420a3163`; Group HQ base `6d3440ba0099c1108dd7557f16b202503db708e5`.

`GET /api/group-hq/channels/whatsapp?brand=pp|mhp` reuses the existing Group HQ bearer token and fixed workspace/organisation/owner mapping. It calls `app_private.property_predator_live_channel_truth()` as `r72_web` in a read-only transaction after checking owner authority. Only WhatsApp connection/reply/sending/receipt states, stable blocker codes and timestamps are returned. No provider/recipient identities, messages or secrets cross this boundary. No SQL migration or provider mutation.

PP uses the existing `R72_GROUP_HQ_CRM_PP_WORKSPACE_ID`, `R72_GROUP_HQ_CRM_PP_ORGANIZATION_ID` and `R72_GROUP_HQ_CRM_OWNER_USER_ID`. Optional MHP mapping requires both `R72_GROUP_HQ_CRM_MHP_WORKSPACE_ID` and `R72_GROUP_HQ_CRM_MHP_ORGANIZATION_ID`, distinct from PP, and the configured owner must have authority there. Until an actual MHP brand workspace is established and verified, leave both absent: the endpoint reports `availability=not_connected` without reading PP data. No default or tenant workspace is invented.

The snapshot proves saved channel state, not service uptime or a successful real delivery. Production read proof using the actual web role returned `not_configured / not_ready / blocked / none`, blockers `PROVIDER_NOT_CONFIGURED`, `INGRESS_NOT_READY`, `TEMPLATE_REQUIRED`. Zero bindings/templates/jobs/receipts were observed. The old WhatsApp worker is suspended and the webhook's initial deployment failed. This adapter does not resume them.

Checks: focused auth/brand/read-only/malformed-response tests and TypeScript check; exact-release CI before integration. No rerun of unchanged privacy/payment migration rehearsals. Recovery: redeploy the prior exact app source or stop using this new read endpoint; no data/schema/provider rollback. Main Group HQ remains the operator front door. Provider setup and one real owner WhatsApp pilot are later cutover work, not claimed live by this adapter.
