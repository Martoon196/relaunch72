# MHP payments integration and cutover — 6 November 2026

Root is integrating Claude's b4d2df7 candidate onto foundation c95dcc5432978bee5f2ee59327f01a741a05b374. The earlier payment branch with migration 0138 is superseded. Migration 0142 is additive; it adds the approved catalogue and a transactional purchase-welcome outbox. Nothing in this document establishes production acceptance.

## Offer policy

The £997 / 3 × £349 course offer is available to everyone strictly before 11 November 2026 19:30 GMT. Afterwards the server chooses £1,497 / 3 × £525. One Lane Mentoring refunds run for 30 days from the first successful payment, including instalments. One Lane Private retains its separate first-session terms. Align the static site's terms before exposing checkout.

## Prerequisites and source gates

1. Confirm production ledger 0141 and exact active source for every schema-strict consumer. Preserve all working customer journeys.
2. Record the final candidate SHA/tree, exact Linux CI, focused payment tests and isolated 141→142 rehearsal under actual runtime roles. The outbox rehearsal covers atomic trigger creation, receipt replay, account/live isolation, lease recovery, ambiguous provider outcomes and runtime ACL/RLS.
3. Prepare an executable recovery release from the live base that accepts only the final 0142 checksum. Review and deploy the compatibility release to every strict consumer before applying 0142. Verify each consumer and both Growth HQ host readiness endpoints. Do not substitute /health for /ready.
4. Verify MHP Stripe account, restricted-key permissions, webhook role, Postmark transactional sender and billing settings. Do not print secrets. MHP keys belong on property-predator-growth-hq, not group-hq. Stripe activation is founder-reported complete; verify account requirements and terms settings through the provider.

## Stripe and proof

Use the MH196 Ltd sandbox first. Set public business/support details, terms https://martinhowardproperty.co.uk/terms/ and privacy https://martinhowardproperty.co.uk/privacy/, and successful-payment/refund receipts. Use the permissions in mhp-stripe-operations.md, including finite subscription schedules.

The setup CLI verifies the exact account and reconciles GBP products/prices, webhook and customer portal. It inventories older reusable payment links but leaves them active. Install non-secret price/configuration IDs and transfer webhook/key secrets privately to the existing app. Do not change working checkout until replacement validation is ready.

Sandbox acceptance: course full payment and 3 instalments; one private applicant link with a 6 or 12-payment schedule; signed webhook, verified-email account access, one purchase welcome and Stripe receipt; self-serve refund and seven-day read-only grace; window cutover and expiry. Test overrides must never reach a live key.

## Cutover and recovery

After compatible consumers are deployed and readiness is verified, apply only final 0142 using the migrator connection. Check readiness again. Deploy the exact ratified capable SHA. Enable the new routes only when their account/configuration and proof requirements are met. The new worker starts only with MHP and billing enabled; keep it out of the pre-migration compatibility release.

If the capable release fails, deploy the prepared exact-0142-compatible recovery source. Leave additive tables and recorded receipts intact. Do not roll back the ledger, delete payment evidence, reset unknown welcome deliveries or deactivate existing checkout links. Preserve the existing route until the replacement is accepted.

Martin completes the live card transaction himself. Verify purchase, access, receipt and welcome, then the requested refund. Publish the static site's payment branch only after acceptance. Retire an obsolete reusable payment link only after checking it belongs to MHP and its replacement is live; applicant links and other brands remain untouched.

Welcome recovery is documented in mhp-stripe-operations.md. Unknown outcomes require Postmark Activity reconciliation, never an automatic resend.
