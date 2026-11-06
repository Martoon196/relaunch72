# Growth HQ personal inbox → canonical CRM

Task GHQ-UNIFIED-INBOX-002. Base 459554640eeddae9c0120857bf087d60f2b5652b. Code-only on schema 0141; no migration or provider message send is part of this boundary.

`POST /api/group-hq/inbox/crm` on the canonical HQ host authenticates exact raw bytes, path, method and five-minute timestamp with a dedicated HMAC secret. A separate environment mapping explicitly delegates known Growth HQ owner email addresses to distinct native business workspaces, owner users, pipelines and initial stages. Each read and command rechecks the native owner's active workspace membership. This is server-to-server delegation, not a fabricated portal session.

Create/link/search/contact/activity use native CRM records and transactions. Social identity is an exact account + participant digest, unverified with unknown consent; no fake email or marketing permission. Replies are outside this API. Message projection carries connector-asserted evidence, not Meta-signed evidence. Conflicting replays refuse; identical concurrent/repeated commands do not create duplicates.

The native receipt read after INSERT ON CONFLICT no longer uses FOR UPDATE: its UPDATE RLS policy intentionally hides completed rows, while SELECT permits the immutable completed receipt. The unique insert already serialises the claim. Existing status, actor, payload-hash and workspace checks remain. Real-role proof reproduced the blocker and verifies the correction plus concurrent duplicate creation.

Configuration: `R72_GROUP_HQ_INBOX_SECRET` (dedicated 32–256-character secret) and `R72_GROUP_HQ_INBOX_SCOPES` (JSON by brand: label, workspaceId, organizationId, ownerUserId, pipelineId, stageId, actorEmails). Unconfigured/invalid configuration leaves the optional boundary unavailable and preserves customer journeys. Never commit credentials.

Cutover: exact-source CI → configure the shared secret/scopes privately in both services → publish the exact tested tree → deploy HQ → verify /ready on both hosts and signed read-only search → release Growth HQ's compatible 0011 registry bridge before its additive migration/final UI → owner walkthrough. Key Properties needs its own bounded data bootstrap; never reuse PP's workspace for Durham leads. The prior 4595546 application remains a compatible schema-0141 recovery; disable the optional bridge configuration on recovery if needed. CRM records already created remain canonical and are not rolled back/deleted.

Local evidence: focused native CRM/signature neighbours 39 pass, zero fail/skip; real-role integration one pass, zero fail/skip. Exact-source GitHub gate independently repeats the affected tests and real-role proof. This document does not claim a connected personal account or production deployment.
