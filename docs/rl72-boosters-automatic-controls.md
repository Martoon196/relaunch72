# Automatic private packs and owner switches

This supplements the reviewed 0.1.1 implementation. User authorisation on
4 November 2026 now includes controlled production deployment and applying
138/139. The new automatic-default/off-switch requirement adds migration
140; frozen 138 and 139 are unchanged.

The owning brand's **Production rules** screen shows all eight packs,
individual specialist switches, all-on and all-off actions. Engine Room is
included when another pack needs it. Forms use genuine owner authority,
same-origin/CSRF checks and the expected assignment revision. Disabled
creators stop new generation and retain saved drafts.

Automatic assignment is opt-in at the verified private-organisation boundary.
An operator enrollment carries `automatic_defaults=true` and a genuine
`default_owner_user_id`. The configured owner must still manage the brand.
An authorised snapshot of a brand with no prior assignment installs the
eight exact approved 0.1.1 pins under a brand lock, with origin
`private-default`. This works for current and future registered content
brands in the enrolled organisation. No profile, spending or publication
approval is inferred.

Any explicit assignment wins, including an empty off revision. Reloads,
worker reads and restarts never reset an owner's off choice. No public
tenant, un-enrolled organisation or old 0.1.0 email/referral release gains
access. Existing manual enrollments default to automatic assignment off.

The controlled compatibility setting is now
`RL72_METHOD_SCHEMA_BRIDGE=138-140`. It admits only the exact bundled
137/138/139 prefixes while both feature flags are false. Strict operation
requires all 140 migrations. Deploy this compatible source to every affected
runtime before applying 138, 139 and 140; then disable the bridge and enable
the relevant portal/worker feature flags. Keep provider/image/publishing
permissions and existing uncertain-job holds unchanged.

Migration 140 LF SHA-256:
`a4b53f5721855e300cd49665cc5faa773f3c80240fbcca3fe3f31379c7f3a378`.
