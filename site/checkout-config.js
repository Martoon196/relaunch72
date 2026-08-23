/*
 * Relaunch72 checkout config — PRIVATE TEST SANDBOX ONLY.
 *
 * The server requires a private access code in production test mode. The founder
 * enters it in the browser prompt; it is kept only in sessionStorage and is never
 * hard-coded here. Live Stripe keys are intentionally locked by the backend.
 */
window.RELAUNCH72_CHECKOUT = {
  // The Render TEST service. Public requests cannot create checkout without the
  // server-side SANDBOX_ACCESS_TOKEN entered via the founder-only prompt.
  apiBase: 'https://relaunch72-payments.onrender.com',

  // Payment Links are deliberately unsupported: they do not create the trusted
  // backend entitlement needed by /api/intake.
  paymentLinks: {},
  successPath: 'intake/',
  currency: 'usd',
  liveMode: false,
};
