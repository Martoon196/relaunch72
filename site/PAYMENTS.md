# Payments — going live with Stripe

The whole funnel is built **Stripe-ready**. Turning on real payments is a paste job, not a code change. **Stay in Stripe TEST mode until we deliberately go live** (hard rule: Stripe stays test-mode until "go live").

## The flow

```
landing (index.html)  →  checkout.html?tier=X  →  Stripe Payment Link  →  intake/?tier=X&session=…  →  pipeline
```

`checkout.html` reads the tier, shows the order summary + Core order-bump, and sends the buyer to the Stripe Payment Link for that tier. Until a link is set it shows an honest "not live yet" state with a dev path straight to the intake, so the flow is fully walkable now.

## Go-live steps (≈15 min, all in the Stripe dashboard, TEST mode)

1. **Create four Payment Links** (Products → Payment Links), test mode:
   | Key | Product | Price |
   |-----|---------|-------|
   | `autopsy` | Marketing Autopsy | $97 |
   | `core` | Relaunch72 Core | $997 |
   | `core_bump` | Relaunch72 Core + 90-day content engine | $1,144 |
   | `pro` | Relaunch72 Pro | $2,497 |

   (2 × $549 for Core is a Stripe **instalment**/subscription option on the same product — configure on the link if you want it offered.)

2. **Set each link's success URL** to:
   ```
   https://<your-domain>/intake/?tier=<key>&session={CHECKOUT_SESSION_ID}
   ```
   Stripe substitutes the real session id. The intake form captures it as `_stripe_session` in the payload for reconciliation.

3. **Paste the link URLs** into `site/checkout-config.js` → `paymentLinks`, and flip `liveMode: true`. Done — checkout now takes real (test) cards.

4. **Test it** with Stripe's test card `4242 4242 4242 4242`, any future expiry/CVC. You should land on the intake with the tier + session in the URL.

## The pipeline-kick webhook (automation phase — separate task)

Payment Links alone collect money and hand the buyer to the intake. To **auto-start the build on payment**, add a Stripe webhook (`checkout.session.completed`) → a small receiver that records the paid session and, on accepted intake, runs the pipeline (`npm run pipeline -- --input <intake>.json`). That receiver is the automation-glue task; the frontend is already wired for it (the session id flows through).

## What stays manual until then

Concierge-free but human-gated: buyer pays → fills intake → **you** run the pipeline, review at the sign-off gate (`npm run signoff`), and send the delivery pack (`npm run deliver`). Nothing here needs an account beyond Stripe.
