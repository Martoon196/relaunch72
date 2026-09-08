# Property Predator Growth HQ — overnight release handover

## Content flow follow-up — 8 September 2026

The first interface release `a1bee92792edea528379e159ce8bc6855b8cef6b` is verified live. This follow-up makes Content start with Create drafts, Plan & schedule, and Your library. The empty library leaves useful next steps visible and keeps technical details collapsed. Specialist controls stay available under Content tools and settings with their existing permissions. Campaign creation and draft review support Light, Dark and System appearance. The mobile header fits narrow phones and keeps its icon link labelled.

Full regression: **2,951 passed, 0 failed, 38 database cases skipped**. Final focused content, portal and fixture checks: **81 passed**; typecheck and supply-chain checks passed. Independent browser review inspected the populated and empty library, real single/channel-pack draft renderers, persisted Dark selection across routes, light contrast and the 360px layout. Preview routes use fictional records and cause no generation or outbound action. Production deployment remains a separate exact-revision check. No schema, publishing permission or provider command changed.

## Original interface release baseline (historical)

On 7 September 2026 the founder authorised implementation, testing, documentation and verified GitHub, Render, Neon and Zernio release work. Existing tenant isolation, exact-account binding, version-specific approval, consent, suppression, idempotency and unknown-outcome protections remain mandatory.

The verified baseline is:

- live Render revision observed: `016f102104c6727bba80b74a7ad352c41435938a`;
- authoritative GitHub tip: `11adb48a347568ed0406e642315e78569f721ae0`, a direct descendant of the observed live revision;
- Neon migration ledger: **97/97 contiguous entries with matching checksums**; and
- current implementation checkout: `worktrees/astra-overnight-hq-current`.

The 2 September `0090` Neon role-membership failure and `0093`-not-deployed statements are historical incident evidence. They do not describe the verified 7 September database state.

## Current release work

The HQ usability package provides a persisted Light/Dark/System appearance control, work-first Today page, ordered `Today / People / Inbox / Content / Results` navigation, simpler Content workspace, and clearer connection/permission/outcome wording. Quick navigation keeps specialist routes available under the existing capability checks. Results opens the existing authenticated overview reporting section. Drafts, Campaigns, Calendar and Library inherit the shared theme; social post previews preserve their channel appearance. It preserves the newer Zernio calendar, channel-pack and provider work on the authoritative source line.

## Candidate verification

- Complete local regression: **2,949 passed, 0 failed, 38 database cases skipped** (2,987 cases). Those database cases were not executed by this interface-only verification. No database schema or role changes are in this release.
- TypeScript typecheck passed. Supply-chain gate passed for 67 external packages with current SBOM.
- Final fixture-preview regression: 4/4 passed after adding the existing overview reporting capability to the preview fixture.
- Independent browser checks: actual fixture-rendered Today page, persisted appearance selection across routes, light/dark Drafts, ordered primary navigation, and expanded Results anchor. These are fixture visual checks, not live customer workflow or outbound-provider proof.
- Root review corrected light-theme navigation/button contrast and restored Actions, Journeys and Affiliates in quick navigation after the primary-menu simplification.
- Evidence outside the repository: `overnight-build-2026-09-07/_verification/hq-full-tests-final.log`, `hq-preview-final.log`, and `HQ-INTERFACE-RESULT.md`.

This is a first interface release. Deeper specialist pages still contain existing preview controls and technical wording. Theme preference is remembered separately on the HQ and main-product origins. This package does not claim the full CRM, social sending or entire nine-phase plan complete.

Release verification must record the exact committed SHA, authoritative remote SHA, Render deployed SHA and Neon ledger separately. A successful build or push is not a deployment claim. No outbound communication should be replayed merely to recreate proof.
