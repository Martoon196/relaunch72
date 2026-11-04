# MHP Stripe setup and release boundary

MHP uses the separate Stripe account of **MH196 Ltd** (company number 15060897, registered in England and Wales; registered office 5 Clothier Meadow, Castle Cary, Somerset BA7 7HA; trading name Martin Howard Property). Property Predator's `STRIPE_*` variables, keys, links and payment services are never used, and the MHP code has no fallback to them.

## What is sold and how (go-live, 4 November 2026)

| Offer | SKU | Price | Route |
| --- | --- | --- | --- |
| Property Done Properly, webinar price | `mhp_course_web` / `mhp_course_web_3x` | £997, or 3 × £349 (£1,047) | Public course checkout, until 11 November 2026 19:30 GMT |
| Property Done Properly | `mhp_course` / `mhp_course_3x` | £1,497, or 3 × £525 (£1,575) | Public course checkout, from 11 November 2026 19:30 GMT |
| One Lane Mentoring, founding | `mhp_mentoring_early` / `_6x` | £2,997, or 6 × £525 (£3,150) | Single-use applicant link; application received before 8 November 2026 00:00 GMT |
| One Lane Mentoring | `mhp_mentoring` / `_6x` | £3,997, or 6 × £699 (£4,194) | Single-use applicant link |
| One Lane Private | `mhp_private` / `mhp_private_12x` | £25,000, or 12 × £2,250 (£27,000) | Single-use applicant link |

Prices include any VAT (VAT status is being confirmed by the founder; no tax logic exists). Deal Desk, Members' Room and Partnership have no purchase route in this release.

**Public course checkout.** The site's course buttons post `plan=full|3x` to `https://app.martinhowardproperty.co.uk/api/mhp/checkout/course` (exact apex/www Origin, abuse admission). The server's clock picks the SKU: webinar price strictly before `2026-11-11T19:30:00Z`, list price from that moment. The browser cannot choose a price. Each Stripe Checkout Session requires the terms of service consent, collects the billing address, shows the plan statement ("3 monthly payments of £349, £1,047 in total. Payments stop automatically after the third.") above the pay button, has no promotion codes and returns to `/join/welcome/`.

**How the window end is enforced.**
1. From 19:30:00 GMT no webinar-price checkout can be created (server clock).
2. A webinar-price checkout created before 18:59 GMT expires in Stripe no later than 19:30:00 (`expires_at` is the window end).
3. Stripe's shortest expiry is 30 minutes, so a checkout created between 18:59 and 19:30 expires up to 31 minutes later. The window closer (`window-closer.ts`, in the web process) expires every open MHP webinar-price session at 19:30:00 and re-checks every minute for 25 hours.
4. A receipt for a webinar price is rejected unless its session was created by the course checkout before the window end.
5. The site switches its buttons and hides the webinar-price copy at the same moment (`windowEndsAt` in `assets/config.js`), but the site never decides the price.
If the closer could not reach Stripe and a late payment still completed, the purchase is recorded (money and access stay consistent) and the log shows `mhp.window.late-payment` for the owner to decide on a refund. In a sandbox only, `MHP_COURSE_WINDOW_ENDS_AT` (ISO UTC) moves the window end so the cut-over can be proved; a live key ignores it.

**Applicant links.** `/hq/applications` (owners only) shows a "Payment link" column. Choose the offer agreed on the call and press "Create single-use link". The app creates a Stripe Payment Link limited to one completed payment, with the applicant's email prefilled, the terms consent required (Private shows the Private terms), and the plan statement shown. Founding prices are offered only for applications received before the founding deadline; the server re-checks this. "Email this link" opens a ready-written email in the owner's mail program; "Withdraw link" switches it off. Stripe is the record of links; nothing is copied into the database. A receipt for a mentoring or Private SKU is rejected unless it came from such a link.

**Instalments.** 3, 6 and 12-payment plans are adopted by a Subscription Schedule with `end_behavior=cancel` and an absolute end 3, 6 or 12 months after the first paid invoice's period start. The hourly reconciler adopts a missing schedule and cancels an overdue plan without charging or refunding. Plans cannot run on indefinitely.

**Access.** The signed webhook records the purchase and the entitlement; the buyer's email binds when they sign in with it (mailbox proof). After a recorded checkout the app sends a welcome email (sign-in link and next steps); Stripe sends the receipt. Course: training centre and Your Desk. Mentoring and Private: also email workflow and LeadRelay.

**Refunds.** Course and mentoring: 30 days from the first successful payment, self-serve on `/app/account` (stops future instalments, then refunds every charge). Private: no self-serve refund (`refund_days=0`); the written terms apply (full refund up to the first one-to-one session). The owner refunds Private in the Stripe Dashboard: for an instalment plan, **cancel the subscription first**, then refund each payment. The signed `charge.refunded` receipt then moves access to seven days read-only.

## Provider setup

Keep the restricted key in Render's secret environment as `MHP_STRIPE_SECRET_KEY`, never in chat, a command argument, a checked-in file or a screenshot. Set `MHP_STRIPE_ACCOUNT_ID` to the MH196 Ltd account ID. Start with its sandbox restricted key. Run on the hosting environment:

```
node --import tsx orchestrator/src/mhp/stripe-setup-cli.ts
```

The command verifies `/v1/account`, reconciles fixed product IDs, names and lookup keys, creates or reuses the GBP prices, switches off any older reusable MHP Payment Link (applicant links and other brands are untouched), and creates or reuses the webhook endpoint and billing portal configuration. It prints only non-secret IDs and the `environment` values to install: every `MHP_STRIPE_PRICE_*` and `MHP_STRIPE_PORTAL_CONFIGURATION_ID`. It never creates a purchase route, a purchase or a refund.

The webhook endpoint is `https://app.martinhowardproperty.co.uk/api/stripe/webhook`, API version `2026-06-24.dahlia`. Events: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`. Copy its signing secret **directly from Stripe's endpoint dashboard into Render** as `MHP_STRIPE_WEBHOOK_SECRET`. Then set `MHP_BILLING_ENABLED=true`. `DATABASE_WEBHOOK_URL` for role `r72_webhook` is required when billing is enabled.

Stripe account settings the checkout relies on: Public details must have the terms of service URL `https://martinhowardproperty.co.uk/terms/` (Checkout refuses terms consent without it) and privacy URL; customer emails for successful payments and refunds must be on.

## Restricted-key permissions

Write: Products, Prices, Payment Links, Checkout Sessions, Webhook Endpoints, Customers, Subscriptions / Subscription Schedules, Refunds, Customer portal (configuration and sessions). Read: the authenticated account, Checkout Sessions and line items, Invoices, Invoice Payments, Payment Intents, Charges and the written resources above. No payout, transfer, account-update or tax write permission is needed. Test the restricted key's request log in the sandbox; do not solve a missing permission by switching to an unrestricted secret key.

## Database

Migration `0138_mhp_payments_live.sql` activates the webinar and founding SKUs, sets public product names, allows 12 instalments and adds the two One Lane Private products (with permanent owner entitlements as 0118 did). The release that bundles it stays ready while 0138 is still pending (exact checksum, exact 0137 ledger), so every consumer is deployed first and the migration is applied once afterwards. Until 0138 is applied, receipts for the new SKUs fail closed and Stripe retries them.

## Proof before live sales

Sandbox: one purchase of course in full, course 3 × (including the schedule end date), one applicant link (6 × or 12 ×); webhook receipt and access; receipt email; one self-serve refund; a webinar-price checkout refused after a sandbox `MHP_COURSE_WINDOW_ENDS_AT`, and an open one expired by the closer. Live: the owner buys the course with their own card, confirms access and receipt, and refunds it. Record the outcomes in the release notes before the site's course buttons are published.

## Bounded limits

Commerce reconciliation refuses subscriptions with more than 100 paid invoices. One payment intent per paid invoice is required; split/partial invoice payments and manually edited prices fail closed for operator review. No discount, promotion, tax or multi-item checkout logic exists. Founding/early offers have no public route.

Sources: [Checkout Sessions](https://docs.stripe.com/api/checkout/sessions/create), [Payment Links](https://docs.stripe.com/api/payment-link/create), [Subscription Schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules), [Billing portal configuration](https://docs.stripe.com/api/customer_portal/configurations/create), [Stripe API keys](https://docs.stripe.com/keys).
