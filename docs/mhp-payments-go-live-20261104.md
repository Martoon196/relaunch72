# MHP payments go-live runbook (4 to 5 November 2026)

Target: course checkout live on the site before the replay email on Thursday 5 November, 08:00 GMT. Everything uses the MH196 Ltd Stripe account only. Secrets go straight into Render; never into chat, commands or files.

Source: branch `codex/mhp-payments-live-20261104` (app, direct child of `codex/relaunch72-platform-foundation` 2bd3219) and branch `mhp-payments-live-20261104` in the `martinhowardproperty` site repo. Neither is pushed until the owner says so.

## 0. Before anything: confirm what is live

In Render, open `property-predator-growth-hq` and note the deployed commit. This release sits on top of 2bd3219 (SEO media 0137). If production is not already on 2bd3219 with 0137 applied, the SEO 0137 release must finish first, or this branch must be rebased onto what is live. Do not deploy until this is settled.

## 1. Stripe (MH196 Ltd account, sandbox first)

Settings → Business → Public details and Branding:
- Public business name: Martin Howard Property. Statement descriptor: MARTINHOWARDPROPERTY. Shortened descriptor: MHP.
- Brand colour #142019, accent #E8A33D. Icon: square PNG of the "M" from https://martinhowardproperty.co.uk/assets/favicon.svg.
- Support email martin@propinvestuk.co.uk; website https://martinhowardproperty.co.uk.
- Terms of service URL https://martinhowardproperty.co.uk/terms/ (Checkout cannot ask for terms consent without it). Privacy URL https://martinhowardproperty.co.uk/privacy/.
- Settings → Customer emails: turn on successful payments and refunds.

Developers → API keys → Create restricted key (sandbox) with the permissions listed in `docs/mhp-stripe-operations.md`.

## 2. Render environment (growth-hq service), sandbox values

Add: `MHP_STRIPE_SECRET_KEY` (rk_test_…), `MHP_STRIPE_ACCOUNT_ID` (acct_… of MH196 Ltd), and for the sandbox proof only `MHP_COURSE_WINDOW_ENDS_AT` (an ISO UTC time about 40 minutes ahead, set just before step 6). Keep `MHP_BILLING_ENABLED` unset for now. `DATABASE_WEBHOOK_URL` must exist for role `r72_webhook`.

## 3. Deploy the release to every service, then migrate

1. Publish the branch to the deployment branch (owner go-ahead needed).
2. In Render, deploy the same commit to all eight services on `codex/relaunch72-platform-foundation`: growth-hq, meta-whatsapp-live-worker, meta-whatsapp-live-webhook, customer-email-live, email-worker, owned-public-social-live, twilio-sms-live, twilio-sms-live-webhook. Each stays ready on the 0137 database (exact allowance for pending 0138). Check `/ready` on app.martinhowardproperty.co.uk.
3. From the growth-hq Shell, with the owner database URL: `npm run db:migrate`. It applies only 0138. Check `/ready` again on both hosts.

## 4. Stripe setup command (growth-hq Shell)

`node --import tsx orchestrator/src/mhp/stripe-setup-cli.ts`

Copy every value under `environment` into Render. Open the webhook endpoint it created in Stripe (Developers → Webhooks), reveal the signing secret and paste it into Render as `MHP_STRIPE_WEBHOOK_SECRET`. Then set `MHP_BILLING_ENABLED=true` and redeploy growth-hq.

## 5. Sandbox proof (test card 4242 4242 4242 4242, any future date, any CVC)

With a sandbox key, https://app.martinhowardproperty.co.uk/api/mhp/checkout/course shows a plain test page with "Pay in full" and "3 monthly payments" buttons (it does not exist with a live key).
1. Course in full: press "Pay in full". Stripe shows £997, the terms tick box and the statement. Pay. You land on `/join/welcome/`. Check: webhook 200 in Stripe, purchase on the buyer's `/app/account`, `/app/learn` opens after email sign-in, welcome email and Stripe receipt arrive.
2. Course 3 ×: press "3 monthly payments". Check the subscription has a schedule ending 3 months after the first payment (Stripe → Subscriptions → schedule end date).
3. One applicant link: on `/hq/applications`, create a 6 × or 12 × link for a test application, pay it with the prefilled email, check access and the 6 or 12-payment schedule end.
4. Refund: on the course buyer's `/app/account`, refund. Check Stripe shows the refund, the refund email is sent and access becomes read-only.
5. Window end: before `MHP_COURSE_WINDOW_ENDS_AT`, open a £997 checkout and leave it open. After that time: the open checkout is expired (log line `mhp.window.close`), and a new "Pay in full" checkout charges £1,497. Then remove `MHP_COURSE_WINDOW_ENDS_AT` (a live key ignores it anyway).

## 6. Live

Swap in the live restricted key and live account values, run step 4 again with the live key, and redeploy growth-hq. Martin buys the course with his own card from the published buttons, confirms access, welcome email and receipt, then refunds it from `/app/account`.

## 7. Publish the site

Only after steps 5 and 6 pass: merge the site branch into `main` of the `martinhowardproperty` repo and push. GitHub Pages serves it in a minute or two. Check `/join/` and `/webinar/replay/` on the live site.

## If something is not proven by 07:30 on Thursday

- Instalments not proven: hide the 3 × buttons (remove the second button from the two forms) and publish pay-in-full only.
- Webhook access not proven: keep checkout live and grant access by hand in `/hq` (Access: email, product, note "Paid by card, Stripe receipt …"), then press "Send invite".
- Checkout itself not proven: do not publish the site branch. The replay page keeps its current price box and link to `/join/`.
