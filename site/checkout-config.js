/*
 * Relaunch72 checkout config — THE STRIPE SEAM.
 *
 * Going live is a paste job, no code change:
 *   1. In Stripe (TEST mode), create a Payment Link for each product below.
 *   2. Set each link's success URL to:  <your-site>/intake/?tier=TIER&session={CHECKOUT_SESSION_ID}
 *   3. Paste the link URLs here. That's it — checkout.html picks them up.
 *
 * Until a link is set, checkout shows an honest "not live yet" state and (in dev)
 * lets you walk straight through to the intake so the flow is testable now.
 * See PAYMENTS.md for the full walkthrough incl. the pipeline-kick webhook.
 */
window.RELAUNCH72_CHECKOUT = {
  // OPTION A — Backend (recommended, auto-starts the build on payment):
  // point this at the payments server (npm run serve). When set, checkout POSTs
  // /api/checkout to create a Stripe Checkout Session. Empty = use Payment Links.
  apiBase: '',   // e.g. 'https://api.relaunch72.com'  or  'http://localhost:4242'

  // OPTION B — Stripe TEST-mode Payment Link URLs (no backend). Empty = not wired.
  paymentLinks: {
    autopsy: '',   // Marketing Autopsy — $97
    core: '',      // Relaunch72 Core — $997
    core_bump: '', // Core + 90-day content engine — $997 + $147 (optional: a separate link, or Stripe optional items)
    pro: '',       // Relaunch72 Pro — $2,497
  },
  // Where Stripe returns after payment. {tier} filled in by checkout; Stripe appends the session id.
  successPath: 'intake/',
  currency: 'usd',
  liveMode: false, // flip true only when real (test-mode-first per hard rule #2) links are in and tested
};
