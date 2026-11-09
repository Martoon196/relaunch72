# Deal Desk purchase credit and email handoff

MHP-DEALDESK-001 extends the existing MHP commerce receipt path. The Deal Desk is GBP47 once, with a 14-day refund window. The other catalogue prices and refund windows are unchanged. The seven standard products now include `mhp_deal_desk`; the five eligibility-dependent offers remain gated, and Partnership remains manual/invoice only.

## Course credit

Only a recorded paid `mhp_deal_desk` purchase creates a credit. Manual owner/staff grants create neither credit, paid revenue nor buyer attributes. `app_private.mhp_course_credits` records GBP47 against that purchase and expires it 30 days after its first successful payment. The credit applies only to the list-price one-off `mhp_course`: GBP1,497 less GBP47 means GBP1,450 paid. It does not change the original Stripe catalogue Price or discount an instalment, webinar, room or mentoring offer.

`PgMhpCommerceService.courseCheckout(sessionToken, commandId)` accepts a verified MHP session and a form command UUID. `mhp_begin_course_checkout` serialises reservations per account, retains a single open attempt per credit and binds the attempt to the source purchase's account, customer and email. The founder approved 30 minutes to finish plus up to one minute for checkout setup. The exact 31-minute maximum deadline is recorded once and shown to the buyer. Repeated form submissions reuse the same attempt and never extend it.

The Stripe Checkout uses `price_data` for GBP1,450 on the existing MHP course Product. Both Checkout and PaymentIntent carry the immutable attempt/account metadata. Signed receipt processing verifies the configured account and mode, customer, verified email, product, net amount, payment-intent metadata, paid timestamp and database reservation before assigning a course entitlement. An arbitrary discounted Checkout cannot create a course purchase. The payment record stores the actual GBP1,450 revenue.

Provider session IDs are recovered by their attempt metadata after an uncertain create response. The same idempotency key is reused. An expired attempt is released only after provider expiry evidence or Stripe's explicit non-executed `expires_at` rejection; a network failure does not free a potentially payable checkout. Discovery is bounded to 100 sessions for that customer and fails closed when pagination is needed. This bound needs an operator adjustment if a real customer accumulates that many sessions.

An in-app Desk refund writes its refund-request barrier before closing open credit checkouts. A signed external full-refund receipt first calls webhook-only `mhp_freeze_course_credit`, then expires/reconciles outstanding checkouts, then records the financial receipt. New reservations cannot slip between enumeration and revocation. A course that was already paid remains a separate purchase; the system does not silently charge GBP47 back or revoke it. A refunded course does not automatically recreate its redeemed credit. Any exceptional access restoration uses the existing audited manual-grant action.

`invoice.paid` for a one-off Checkout with `invoice_creation` resolves through the invoice's successful PaymentIntent to its Checkout session, then uses the same receipt validation as `checkout.session.completed`.

Stripe's documented expiry floor is [30 minutes from Checkout creation](https://docs.stripe.com/api/checkout/sessions/create). The setup allowance accommodates database/provider round trips while leaving that floor intact. [Expiring a Checkout](https://docs.stripe.com/api/checkout/sessions/expire) prevents it being completed. Existing Checkout write access covers creation and expiry; this implementation does not require Coupons or Promotion Codes access.

## D4 handoff, held for approved content

`mhp_project_deal_desk_commerce` runs atomically with a recorded purchase. It writes `DESK_BUYER`, `DESK_PURCHASE_DATE`, the credit end date in words (`DESK_CREDIT_END`) and `VERDICT_FORM_SENT` to `app_private.mhp_purchase_contact_attributes`. A verdict submission updates that last flag through a trigger.

`app_private.mhp_email_handoffs` records D4 template 27 at purchase, 28 one day later and 29 four days later, uniquely per purchase/template. All are **held**, with an explicit missing-content/delivery reason. Refund or a real course purchase cancels them. Replay does not duplicate or re-enable them.

No marketing messages are sent by this change. Before activating D4, supply the approved HTML for templates 27–29 and connect the marketing delivery/consent/suppression path. The authentication mail adapter is not used as a substitute marketing sender. A manual owner pilot can test calculators, saved files and verdicts without connecting Stripe or sending these emails.

## Validation and activation limits

Focused provider-mocked tests cover normal credit creation/reuse, account and catalogue mismatch, customer/product/PaymentIntent provenance, unknown discounts, late payment, orphan recovery, refund ordering, expiry and one-off invoice receipts. `test/fixtures/mhp-course-credit.proof.sql` contains 18 isolated database assertions covering purchase-only credit, held D4, replay, verified binding, manual exclusion, verdict flag, ownership, reservation reuse, amount checks, redemption, D4 exit, refund freeze and ACLs.

These tests are not a live Stripe sandbox or production receipt. Root's exact-source release evidence records the checks actually run. Billing stays disabled for the owner pilot until credentials and the separate provider rehearsal are complete. Payment Links should be activated only through the existing explicit setup/activation procedure after its webhook and refund/instalment proofs.
