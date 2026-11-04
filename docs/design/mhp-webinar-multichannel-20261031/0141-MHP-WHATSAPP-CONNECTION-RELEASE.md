# MHP-WA-CONNECT-002 — current-source connection and release candidate

Status: source integrated on 0f0323b64ad4bdeedd49df4fd41050bbeabc2f60. Review candidate, not ratified or deployed. Root retains the founder's deployment authority once the exact source is ratified. No production migration, credential binding, worker, webhook, app publication or message has been performed by this candidate.

## Reuse and bounded additions

The 009C delta is reused from claude/009c-r3 head2a25a31ba82695f2aa6f81033e0c74947b09bdc1 (code2e9c5d51c50c9bb01630671795ca577b31dbd2ca), using corrected SMS161b1b9 as its merge base. Current SMS0134/0135 signup, mobile hint, QR/deep link, UK-time editor and original emails stay intact. No historical migration1–140 is edited. Old0132 WhatsApp is re-slotted to0141; source and bridge pins use SHA256344810a1dc167168ca822c95755d4c800703282702436a55d425db57d3f39777.

The historical handoff named an off-web sealing CLI but supplied none. This patch fills that producer within the agreed custody design: the existing PP ownership GET helper is reused unchanged, then the existing AES-GCM binding envelope is produced by an off-web one-use loopback tool. The tool holds the worker key; the public web process receives only the encrypted packet. No raw token or sealing key is placed in the public app environment, source, file upload, receipt, error or log. The local tool does not itself write the database or send a message.

The native MHP owner page accepts the fresh encrypted file with same-origin/CSRF protection, authorises the actual selected marketing workspace and real owner session, and invokes the existing mhp_whatsapp_connect command. Its receipt covers connection, endpoint, inbox and first binding atomically; retries are effect-free and changed payload conflicts. The operation creates no message jobs. The owner page is linked from the selected MHP marketing workspace only when its real service is composed.

## Evidence actually run

- Final current-source typecheck passed, including the producer/navigation changes and version141 readiness test; exact-release CI remains required.
- Final focused source gate:94 passed,0 failed,0 skipped (owner packet/local form, retained SMS/public UX, Meta read failure, worker/webhook/repository, marketing navigation and schema compatibility).
- Real roles on isolated branch br-orange-silence-b2683tci, database relaunch72_test: existing JOIN/STOP, replay/conflict, observation/owner-batch/due worker proof1 passed; new owner connection/save/atomic receipt/replay/conflict/exact three role boundaries proof1 passed. Production was untouched. Only0141 was pending on the production-derived140 branch.
- Bridge initial37/0/0; portable bridge-test revision2/0/0. No migration or application suite is repeated merely for this document.
- Retained existing AES-GCM, cross-brand, payment, email and CRM contracts are reused; this does not claim renewed end-to-end product acceptance for unchanged systems.

## Provider and configuration prerequisites

Known registered sender: MHP +447861935832, WABA1874194210608511, phone1412753418582729, app1451249570430398; workspace2789228d-55a6-4688-b1e8-2f70abca990b. Provider registration returned actual HTTP200/success:true and the independent Manager read showed Connected. The dedicated MHP system-user token is already generated and saved by Martin; do not generate another or ask for it in chat. Its saved token lifetime is60days; operational renewal is still required.

Render main app srv-da7fv1gn74is73d58hb0, My Workspace tea-d8k12nl7vvec73e83jpg, foundation branch, strict /ready, manual deployment. Add separate MHP worker/webhook using the existing reviewed executables and least-privilege roles. The founder already approved the remaining two Starter services within the53USD/month hosting ceiling; do not re-ask that spending decision. Neither the MHP worker nor webhook has yet been created.

The shared Meta app was Unpublished, its production callback/verify token blank, and the inspected MHP privacy page did not describe Meta processing. Resolve those factual publication prerequisites and obtain action-time confirmation where the browser policy requires public-access/terms approval. Do not silently publish or substitute a different brand's token/sender. Current template status must be read freshly from this WABA by the worker, never typed as approved.

## Executable cutover and recovery order

1. Astra ratifies exact capable and bridge SHAs plus this off-web producer. Exact-release CI must pass on both. Verify the foundation remains the expected direct base; re-integrate/review relevant changes if it moved. Never overwrite concurrent SEO or booking work.
2. Publish/deploy the140/141-compatible bridge to all active shared runtimes whose exact grant probes would otherwise reject141 (main app and any enabled WhatsApp worker/webhook). Confirm both canonical app /ready endpoints return200. Keep existing email, checkout and SMS enabled.
3. Apply only0141 using the direct production migrator connection. Recheck bridge /ready. Deploy the capable141 release immediately; verify strict ledger/role/installation readiness. Unknown/missing/changed migrations must still fail. Do not replace /ready with /health.
4. Configure the native MHP owner service using reviewed public binding/connection IDs. Provision the separate MHP worker and webhook initially without sending enabled, with their own role URLs/installation identity. Worker has the sealing key only; webhook has the app-signature and challenge credentials only. Neither gets another runtime's database identity.
5. Run the off-web seal tool with the worker key and reviewed MHP IDs. Martin enters the existing MHP token in the local form. Upload the resulting encrypted file from the genuine native owner session. Verify its saved receipt/actual binding; never fabricate an owner session or insert a fake provider connection directly.
6. Complete the real Meta challenge, subscribe the actual MHP WABA/app, and freshly observe the approved template with the bound worker credential. Then enable only the reviewed owned acceptance journey. One concrete recipient/message needs explicit WhatsApp approval; earlier SMS tests do not substitute for it. Verify delivery and a real reply; retain existing opt-out proof without unnecessarily opting Martin out again.
7. If a capable release fails after141: stop the new MHP sender, use its existing hold function to fence queued event sends, report leased/calling/awaiting-status attempts without retrying unknown outcomes, then deploy the exact140/141-compatible bridge. Preserve the signed MHP webhook if needed for in-flight outcomes. No schema rollback or old incompatible140 binary. Restore working app /ready and existing email/SMS before resuming setup.

## Material limits requiring a recorded decision

The inherited rail still caps the ENTIRE BINDING at1/day and3/month. Those caps are unchanged on explicit instruction; Meta's allowance email does not change SQL authority. This release can establish an owned connection/pilot but cannot serve a webinar cohort under those caps. Any production campaign-cap change requires Astra's bounded decision and proof; do not call a three-message monthly sender a complete marketing launch.

The relative follow-up editor still reports WhatsApp unavailable. This candidate exposes the existing absolute-time webinar programme; it does not pretend relative WhatsApp sequence execution is connected. The current programme editor retains the candidate's technical source/time inputs; further usability work requires its own named bound.

## Income bot follow-on

Founder confirmed group-listening account +447510243096. Keywords, private-message copy, links and deliberate group choices must be editable in Growth HQ; Income is only the first rule. Reuse Claude's matcher. Ordinary phone-created groups require its separate linked-device adapter; they are not made visible by registering the new Cloud API number. No QR login, automatic DM or ingestion endpoint has been activated. New intake must keep its source distinct from Meta signatures, use durable replay/conflict/dedupe/outbox handling, and compose existing verified-contact inbox/notes/tasks with unknown/conflicting identities held for owner review. One keyword request is not cross-brand continuing marketing consent. No n8n dependency is needed.
