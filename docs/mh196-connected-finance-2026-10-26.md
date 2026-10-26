# HQ connected indicative finance with MH196

Release guide for PP-MH196-CORE-001, 26 October 2026.

**Status: source integrated and reviewed for release; hosted gate and full finance live acceptance remain outstanding.** The implementation base was `f7627618818cf53cd4fe5a6dfe007a927fe9be98` (tree `11e54bf7e56d2c5f1265d278ccca69ef49c300fd`); the release is a direct child of compatibility bridge `3e183301b90e91a82d0ebfa8082c5198646c779b`. Both bridge web and existing Zernio worker are verified live. Migration0106 was applied atomically after those checks: exact ledger106, forced RLS and registry entry read back; bridge /ready remains200 with no blockers. Final exact commit/deploy and acceptance receipts belong to the release manifest, not a claim inferred from this guide.

## Staff workflow

Open an authorised CRM opportunity and choose **Indicative finance**. The route is `/portal/crm/opportunities/{opportunityId}/finance`, with links from the CRM/contact journey. It identifies the opportunity and contact locally; those identities are not sent to the public calculator.

1. Choose **Prepare an illustration** and the appropriate model. Review the client figures and the dated starting assumptions. Unknown current security value and requested borrowing remain decisions to supply; a mortgage payment or percentage is not a loan instruction. Costs-confirmed starts false.
2. Explicitly calculate. The public MH196 request contains only the complete strict planning inputs and supported package/model versions. Inspect the results, warnings, assumptions and monthly calculation before saving. These are planning figures, not a lender quote, offer or approval.
3. Choose **Save reviewed illustration**. The signed review binds the exact numeric inputs/results to the current workspace, opportunity, contact, actor session and source/version. The save path rechecks authority and current source under the existing command-role locks, then appends an immutable version. A changed opportunity, revoked session or mismatched payload cannot silently save against the old review.
4. Reopen a saved version. Its calculated date, assumptions date, inputs, result and warnings are retained. Opening it does not run another calculation. The page displays recent versions and supports exact-version links. A changed opportunity or finance version is called out for review rather than presented as a newly calculated result.
5. When appropriate, explicitly choose **Copy client review link**. Copying creates no enquiry and sends no message. The notice explains that the link contains the figures and should be shared only with the intended client.

The form presents ordinary labelled fields and collapsible assumptions. Its default works allocation uses the supported even schedule; retained custom schedules display as Month/Amount rows. Results and assumptions use labelled values and a monthly table. Editing and navigation preserve the distinction between an unsaved form, a reviewed calculation and a saved version.

## Client review, privacy and attribution

The copied link opens PP's `/finance.html#import=…`. Its bounded base64url JSON packet contains only:

- `v: 1`;
- `package_version: "mh196-packages-1.0.0"` and `model_version: "mh196-planning-v1"`;
- the declared `assumptions_as_of` date;
- the strict `planning` request: schema `1.0`, supported preset and complete numeric inputs.

It contains no contact details, street address, postcode, HQ IDs, saved results, staff referral, credential or consent assertion. It is a copy of proposed numbers, not a capability to HQ records or evidence of property ownership. Do not place a private MH196 continuation token into this packet.

PP removes the fragment before other page work, validates its exact fields/types/versions/date and schedule coherence, and holds it only in page memory. The client signs into **their own PP account**, reviews the proposal and explicitly recalculates. The proposal does not inherit a previously open PP property or the staff member's introducer. A later MH196 continuation uses PP's existing authenticated server adapter and original-introducer resolution. Contact details and permission remain part of the client's separate MH196 journey.

HQ does not call the private MH196 handoff API in this feature and needs no expanded partner credential. Staff preparation, calculation, saving and link copying do not submit a client enquiry, contact a lender, create marketing consent, charge a fee or establish commission entitlement. No automated client message, lender/status integration, tax change, fee-policy change or automatic replacement of property appraisal figures is included.

## Storage and least privilege

Migration `0106_finance_planning_drafts.sql` adds workspace/opportunity-owned immutable finance versions and the required workspace table registry entry. Existing workspace/contact/opportunity relationships, role predicates, forced row-level security and session boundaries apply. Retained rows follow the existing parent-deletion conventions.

The numeric calculation happens outside the save transaction. The command path locks the session and opportunity, checks the current contact/workspace/source/latest version, and uses the reviewed nonce/hash for replay versus changed-payload conflict. The display query remains separate from the parent-lock query. The latter uses only already-permitted opportunity/contact tables; this release did not solve a command-role denial by granting broader workspace access.

## Exact retained proof

The release-workspace evidence bundle is `overnight-build-2026-09-07/_verification/pp-mh196-core-001/`. These are reused source-bound receipts, not fresh executions by this documentation task or additive totals for one suite.

| Evidence | Result |
| --- | --- |
| `hq-postgres-isolated.log` | **6 passed / 0 failed / 0 skipped**, 9.474 seconds. Real disposable PostgreSQL: migration, workspace isolation, concurrent append-once/replay, viewer/wrong-contact/immutable grants, changed opportunity/revoked session and parent deletion. |
| `hq-source-2026-10-26.md`, final DB01 checkpoint | **18 passed / 0 failed / 0 skipped**, focused finance contract/service/view and command-role regressions. Includes six retained public numeric model responses. |
| `hq-typecheck.log` and `hq-typecheck.exit` | Full local TypeScript 5.9.3 `--noEmit` completed with **exit 0** after the DB01 correction. The log is empty. Earlier pending wrapper attempts are historical, not additional passes. |
| Earlier source receipt | Unchanged CRM/router/Lead360 neighbours are retained from the 49-pass/1-database-skip run. That earlier database skip is superseded by the separate real PostgreSQL proof above; do not sum overlapping counts. |
| `hq-compatibility-bridge-source-2026-10-26.md` | **11 passed / 0 failed / 0 skipped** for the narrow pre/post-0106 readiness bridge, with all other strict ledger checks retained. |
| `independent-review-2026-10-26.md` | Independent source review of the numeric, signed-review, persistence and corrected command-query boundaries; execution receipts reused explicitly. |

The first isolated database execution reproduced a command-role `workspaces` access denial. Root promoted the bounded separate-query correction; the final real database pass above follows that change. Initial fixture/typecheck-wrapper problems are recorded in the receipts rather than hidden or counted as successes. No customer data, live private handoff, client message or lender request was involved. The disposable PostgreSQL proof is not evidence that production migration or deployment has occurred. Actual-browser evidence, when completed, remains a separate receipt and must not be inferred from these tests.

Final relevant SHA-256 bindings:

| File | SHA-256 |
| --- | --- |
| `orchestrator/src/integrations/mh196/planning-client.ts` | `0550641bfb92c805f9da584726de8a7355141ab2a8b22d3816c2c891a4072d2d` |
| `orchestrator/src/portal/finance-drafts-service.ts` | `2e99add3a787d13c1d06d27f8224691e6ed84bd392efc86ae58f93de35ff208b` |
| `orchestrator/src/portal/finance-drafts-pg-service.ts` | `99ef460191d0a62ccc9f0eb886bc76ed11950e04351c0fc8912eb49e94442e34` |
| `orchestrator/src/portal/finance-drafts-view.ts` | `6f38640aadae85309b1834cc4a0009614cedd292d156e06cad5f0d8324b1954a` |
| `orchestrator/src/db/migrations/0106_finance_planning_drafts.sql` | `422d1766390910417b397bb34607f74a56c8d7744c3f88a84c4ae46e39ae40ba` |
| `orchestrator/test/db/finance-planning-drafts.integration.test.ts` | `dc2b394600a4ab66babe4b5fe30b30bbbb5a924ad2b84e3081bf6695652cc49d` |

## Required bridge-first deployment

Although 0106 is additive, an old runtime with strict migration-ledger validation rejects its unknown row. **Do not apply 0106 before both the currently working HQ web and Zernio worker have a verified compatible runtime.** A worker that survives the migration but cannot restart is not an acceptable recovery plan.

The published bridge is commit **`3e183301b90e91a82d0ebfa8082c5198646c779b`**, tree `2e10f8d8fd1842414dc667a5794c0b81332ccd6e`. It bundles 105 migrations and permits only the additional 0106 row with the exact checksum above. Wrong checksums, changed/missing earlier migrations, duplicates and unknown 0107 rows still fail. A full build bundling 0106 follows the ordinary strict readiness rule and requires 0106. The bridge introduces no finance feature, environment bypass, role/grant expansion or health-path change.

Root's cutover sequence:

1. Freeze the full candidate SHA and obtain the normal exact-release gate. Verify authoritative GitHub refs through the approved REST workflow; no Git network transport. Record exact bridge and full-build deployment targets rather than using a moving branch head.
2. Deploy and verify bridge `3e183301…` on **HQ web and the existing Zernio worker before 0106**. Preserve environments, provider modes, pause states, start commands, health paths and disabled auto-deploy settings.
3. Confirm web `/ready` beyond its ten-second cache. For Zernio, verify its startup record has `schemaCurrent:true`, `installationMatched:true` and `functionBoundaryReady:true` with its existing provider mode. Render's Live label alone does not prove the worker loop or a successful outbound action; do not create a test post or alter activation merely for this rollout.
4. Apply only the reviewed 0106 through the established migration procedure. Read back the exact production ledger/checksum and verify the bridge remains ready. Do not weaken readiness or reset the database.
5. Deploy the full strict-106 finance build to HQ web, then verify exact deployed SHA, readiness and the staff opportunity -> prepare -> calculate -> review -> save -> exact reopen journey using the agreed controlled acceptance. Check link copying and the client-own-account PP continuation boundary. Do not send a client message or submit an enquiry as an incidental smoke test.
6. The unchanged Zernio runtime may remain on the verified bridge; it does not need the staff finance feature. Record actual source/status evidence before declaring the release live.

The shared-runtime inventory records the previously live Zernio source as `30973a0debaba27c31e73189e67d9c60c49f871a`. Its startup schema checker would reject 0106 after restart. The failed WhatsApp and SMS webhook services had no evidenced Live deployment in that inventory: leave them unchanged. Deploying/reactivating them would be a separate task, not preservation of an existing working journey. The inventory and bridge receipts provide the bounded source comparison; no architecture re-audit or new provider activation is required here.

## Recovery after 0106

After migration, recover HQ web or the existing Zernio worker **only to verified bridge `3e183301b90e91a82d0ebfa8082c5198646c779b` or a reviewed compatible full build**. Plain pre-bridge HQ `63a44010261d70edd7947d7f71d2869654c380c6` and worker `30973a0…` are pre-0106 recovery sources only and reject the new ledger row.

Retain 0106, its table, registry entry and saved versions. **No down migration, migration-ledger rewrite, data deletion, grant broadening or recreation of inactive workers** is part of recovery. Verify the exact recovered commit, web readiness beyond cache and worker startup boundaries. The bridge can keep the existing portal/social runtime available while the finance UI is absent. Return to finance through a reviewed forward compatible build and confirm retained illustrations reopen.

PP has a separate recovery artifact and no PP migration in this release. Do not substitute its SHA or recovery procedure for HQ's shared-database requirements.

Final controlled browser proof:20passed/0failed/0skipped at390px and1280px inLight/Dark. Actual router/renderer/signed-review service with synthetic auth/repository/numeric client proved opportunityentry, blankunknownfigures, calculate→review→save→zero-callreopen→numericlinkcopy and canonicalPipelinebreadcrumb. No externalrequest/customer/provider effects. Receipt `hq-finance-browser-result.json`; final breadcrumb correction financefile16/0/0 supersedes the changed view's earlier focused receipt. Local TypeScript result predates this one constant-string correction; the exact hosted build rechecks types and its full normal gate. Counts overlap and must not be added.
