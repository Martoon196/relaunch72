# MHP Stripe setup and release boundary

MHP-DESK-001 uses the separate **MH196 2026 Ltd** Stripe account. Property Predator's `STRIPE_*` variables and existing payment services are not used. No live catalog or Payment Link was created during implementation; up to twelve real URLs are produced by the setup command after the account is connected.

## Provider setup

Keep the restricted key in Render's secret environment as `MHP_STRIPE_SECRET_KEY`, never in chat, a command argument, a checked-in file or a screenshot. Set `MHP_STRIPE_ACCOUNT_ID` to the account ID shown in the MH196 account. Start with its sandbox restricted key. Run on the hosting environment:

```
node --import tsx orchestrator/src/mhp/stripe-setup-cli.ts
```

The command verifies `/v1/account`, reconciles fixed product IDs and lookup keys, creates or reuses the twelve GBP prices for catalogue v3, creates the Payment Links, and immediately disables each newly created link before printing its URL. Stripe's Payment Link create API does not accept `active`; disabling is the next API call. If that call fails, the command does not print URLs and the operator must deactivate the identified MHP link in Stripe before continuing. V3 uses new fixed product IDs and lookup keys; older MHP links are deactivated, while their provider history remains. Special-offer links are always kept inactive. Successful output includes only non-secret IDs, price environment values and URLs.

The webhook endpoint is `https://app.martinhowardproperty.co.uk/api/stripe/webhook`, API version `2026-06-24.dahlia` (the version of the pinned Stripe SDK). Events: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`. Copy its signing secret **directly from Stripe's endpoint dashboard into Render** as `MHP_STRIPE_WEBHOOK_SECRET`. The command does not print or persist that secret.

Install the seven standard `MHP_STRIPE_PRICE_*` values; gated offer IDs are optional and never enable those offers. Do not configure a Partnership Stripe price. Also install the emitted `MHP_STRIPE_PORTAL_CONFIGURATION_ID`. A scoped `DATABASE_WEBHOOK_URL` for existing role `r72_webhook` is required only when `MHP_BILLING_ENABLED=true`. Without billing enabled, manual member access and account views work and all provider-changing actions return unavailable.

## Restricted-key permissions

Write: Products, Prices, Payment Links, Checkout Sessions (including course-credit Checkout), Webhook Endpoints, Customers, **Subscriptions / Subscription Schedules**, **Refunds**, and **Customer portal** (configuration and sessions). Stripe's dashboard may group related resources; grant the displayed permission covering the actual endpoint. Read: the authenticated account, Checkout Sessions/line items, Invoices, Invoice Payments, Payment Intents, Charges and the written resources above. Everything else can remain read-only as requested; no payout, transfer, account-update, or tax write permission is needed.

The implementation calls `POST /v1/subscription_schedules`, its update/cancel endpoints, `DELETE /v1/subscriptions/:id`, `POST /v1/refunds`, and `POST /v1/billing_portal/configurations|sessions`. The original proposed restricted permissions did not include those write operations. Test the restricted key's request log in the sandbox; do not solve a missing permission by switching to an unrestricted secret key.

## Paid access and refunds

Course and an active paid Members' Room period grant CRM + enquiry site. Mentoring and manually assigned partnership add email workflow + LeadRelay. The retired Kit retains its historical account/receipt meaning and is unavailable for new purchases. A purchase's email remains unclaimed until the custom auth service verifies mailbox control; later verified password logins also bind newly purchased items.

Instalment subscriptions are adopted by a Subscription Schedule with an absolute end date 3 or 6 months after the first paid invoice's original period start and `end_behavior=cancel`. A delayed webhook retains only the remaining part of that total term; retries validate the saved phase, price, quantity, anchor and end date and do not restart the clock. All eligible links remain unpublished/inactive until this workflow is proved through the signed endpoint. A completely paid instalment course or mentoring purchase keeps its purchased access after the schedule cancels; an early cancellation ends incomplete-plan access. Failed renewals do not advance access beyond the last paid invoice's line period. Ordinary Members' Room cancellations use the Stripe portal's period-end cancellation and retain the paid period.

Because a Payment Link cannot create a finite schedule itself, enabled MHP billing also starts a bounded schedule-only recovery sweep on service startup and hourly. It checks only MHP-tagged finite-plan subscriptions in the verified separate account. Missing schedules are adopted using the same original paid-period anchor; overdue unscheduled plans are cancelled automatically with no extra invoice or proration. It creates no charges, refunds, synthetic webhook receipts or entitlements. A cursor continues across invocations; overlapping runs share one promise. A run scans at most four pages of 25 subscriptions with time checks between pages/items and eight-second provider request timeouts. Errors expose counts only and a malformed item does not starve later members. A stopped/restarted process resumes from a fresh sweep; actual purchase entitlement recovery still uses Stripe's signed webhook replay.

The founder delegated refund-window judgement: **30 days from the first successful payment** for course, Room, mentoring and Partnership, including instalment plans. The revised Deal Desk offer has a **14-day** window and remains unavailable until its purchase journey is implemented. A full-purchase refund stops future instalments/subscription payments before refunding every successful charge. The saved refund request permits safe retries after the applicable refund deadline; provider idempotency is stable per purchase/charge. Reconciliation after cancellation includes a renewal that settled concurrently. Partial refunds record money movement without revoking the whole purchase; a full refund changes that purchase's entitlement to seven days of read-only access. Another valid purchase/manual entitlement continues granting its independent features. Statutory rights are unaffected.

Receipts and cancellation controls live in the Stripe billing portal. One-off links create a Customer and invoice so invoice history is available. Receipt email delivery still depends on the Stripe account's customer-email settings; it is not claimed solely from enabling portal history.

## Release prerequisites and activation

Use a sandbox purchase for each billing shape, verify signed duplicate/out-of-order receipt handling, all 3/6 instalments and automatic cancellation with a Stripe test clock or controlled schedule proof, then exercise the full refund and portal cancellation. Verify DNS/TLS, `/ready`, exact account/mode and prices, webhook delivery and refund permissions. Record the source/receipt before enabling live sales. The setup command never performs purchases or refunds for validation.

After the recorded proof and live configuration are ready, set `MHP_STRIPE_ACTIVATION_READY=true` in the operator environment and run the same command with `--activate`. It requires an existing enabled endpoint and the webhook-secret variable before activation. Activation happens only after all catalog, endpoint and portal checks pass. The approval flag is an operator assertion, not a substitute for the test receipt. Publish only the six standard course/Room/mentoring URLs after their `active` values are true. The six gated offer URLs remain inactive even with `--activate`; Partnership has no Stripe price or link. Keep the setup flag out of the web process environment after use.

## Bounded limits

Commerce reconciliation currently refuses subscriptions with more than 100 paid invoices rather than silently ignoring old payments. This is over eight years of monthly Room payments and should be lifted with a bounded paging implementation before such an account reaches that limit. One payment intent per paid invoice is required; split/partial invoice payments and manually edited prices fail closed for operator review. No discount/promotion, tax or multi-item checkout logic is introduced in this pass. The code validates the founder's exact GBP catalog totals.

Sources checked during implementation: [Payment Link creation](https://docs.stripe.com/api/payment-link/create), [Subscription Schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules), [Billing portal configuration](https://docs.stripe.com/api/customer_portal/configurations/create), [Stripe API keys](https://docs.stripe.com/keys). Installed SDK type declarations confirm `duration: {interval, interval_count}`, Invoice Payments, and the pinned API version.

Founder catalogue v3 authorises thirteen offers: twelve priced offers and Partnership by invoice/manual access. Seven runtime IDs are now standard: Deal Desk, course/course_3x, room_monthly/room_annual and mentoring/mentoring_6x. Five webinar/referral, founders and early-application offers remain database-inactive and webhook-rejected. Migration0118 was catalogue-only;0119/0120 now supply five calculators, three lifetime files, thirty-day writes, permanent reading, the GBP47 credit and verdict workflow. No sixth/EPC calculator is claimed. See [Deal Desk commerce](mhp-deal-desk-commerce.md). Actual Stripe setup and sandbox proof still precede billing activation.
