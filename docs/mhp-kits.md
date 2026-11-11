# Module kits (MHP-KITS-001)

Kits are sold from martinhowardproperty.co.uk/kits through the members app (app.martinhowardproperty.co.uk), on the
Martin Howard Property (MH196 Ltd) Stripe account. The catalogue and prices that are charged live in
`orchestrator/src/mhp/kits.ts` (mirroring the site's `/assets/kits.json`, which only displays them).

- `POST /api/mhp/checkout/kit` (form field `kit`): one kit at the price of this moment. A launch price
  (`introPricePence` until `introEndsAt`) is chosen by the server clock; the checkout expires at the launch end
  (Stripe's 30-minute floor applies in the final half hour). Success returns to `/kits/thanks/?kit=<slug>`.
- `POST /api/mhp/checkout/kit-pair` (field `kits` twice): two different kits for the higher standard price, once.
  Launch prices do not apply. Success returns to `/app/kits`.
- Checkout requires the terms box: immediate access to digital content, ending the statutory 14-day cancellation
  right; the voluntary 14-day refund is restated. The seller footer is shown under the pay button and in the receipt.
- The MHP Stripe webhook routes kit events (`metadata.mhp_checkout` = `kit` / `kit_pair`) to `PgMhpKitService`;
  course events are untouched. A full refund (`charge.refunded`) ends that kit's access.
- Migration `0149_mhp_kits.sql` records orders by the buyer's email. A kit buyer can sign in (one OR clause on
  `mhp_has_purchase_email`) and the kit's module opens in the training centre (one OR clause on
  `mhp_course_outline`, `mhp_course_content` and `mhp_save_lesson_progress`).
- After payment, once per order: a receipt email (never resent after an unknown outcome), registration for the
  webinar replay where the kit has one (Land Gap: "The Land Nobody Seems to Own"), and a CRM record in the MHP
  workspace through the operator's create-lead tool (contact, opportunity "<Kit> · <name>" at the won stage, and a
  "Bought <kit> on <date>" first task). Replay and CRM retry with backoff.
- Files: the owner uploads `kit-deliverables-v3.zip` at `/hq/kits`. Each folder (kit slug) replaces that kit's files,
  stored in the database, never in a public repository. Members download at `/app/kits` and at the top of the
  module page ("Your kit downloads").

Course credit (migration `0150_mhp_kit_course_credit.sql`): what a buyer paid for kits in the 90 days before
buying Property Done Properly counts in full towards it. The course is bought at its normal price; when its signed
receipt is recorded, the buyer's eligible kit orders (same email, same Stripe account, not refunded, not already
credited) are claimed once for that course checkout and the total is refunded against the first course payment,
always leaving at least £1 paid so the credit can never read as a full refund of the course. Replays are idempotent
(the claim returns the same orders; the refund uses the key `mhp-kit-credit:<course session>`). A capped credit is
logged as `mhp.kit.credit.capped` for the owner to settle by hand. `/app/kits` shows the credit a member's kits
currently count for. Until 0150 is applied, course receipts are recorded without the credit.

Release order: deploy this binary to every RL72 service first (it runs with 0149 pending: kit routes say "opening
shortly"), then apply 0149, then restart the web service so the kit service composes.
