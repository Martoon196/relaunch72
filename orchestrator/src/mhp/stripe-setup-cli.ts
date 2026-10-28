import Stripe from 'stripe';
import { setupMhpStripe } from './stripe-setup.js';

const key = process.env.MHP_STRIPE_SECRET_KEY?.trim() ?? '';
const account = process.env.MHP_STRIPE_ACCOUNT_ID?.trim() ?? '';
const activate = process.argv.includes('--activate');
if (!/^rk_(test|live)_[A-Za-z0-9]+$/.test(key) || !/^acct_[A-Za-z0-9]+$/.test(account)) {
  throw new Error('Configure MHP_STRIPE_SECRET_KEY and MHP_STRIPE_ACCOUNT_ID in the hosting secret environment.');
}
if (activate && (process.env.MHP_STRIPE_ACTIVATION_READY !== 'true' || !/^whsec_[A-Za-z0-9]+$/.test(process.env.MHP_STRIPE_WEBHOOK_SECRET ?? ''))) {
  throw new Error('Activation requires the recorded signed-webhook, finite-instalment and refund rehearsal before MHP_STRIPE_ACTIVATION_READY=true.');
}
try {
  const result = await setupMhpStripe(new Stripe(key, { apiVersion: '2026-06-24.dahlia', maxNetworkRetries: 2 }), account, key.startsWith('rk_live_'), activate);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write('Copy the webhook signing secret from the Stripe endpoint dashboard directly into MHP_STRIPE_WEBHOOK_SECRET on Render. No secret is printed by this command.\n');
} catch {
  // SDK errors can include request data. Operators use Stripe Workbench for
  // restricted-permission diagnostics; keys and request bodies stay out of logs.
  process.stderr.write('MHP Stripe setup did not complete. Check the account, permissions and Stripe request log; rerunning is idempotent.\n');
  process.exitCode = 1;
}
