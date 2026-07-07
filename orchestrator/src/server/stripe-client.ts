/**
 * Build the real Stripe client. The Stripe SDK does NOT read HTTPS_PROXY by
 * default, so in a proxied environment (e.g. an egress-policy sandbox) its
 * requests bypass the proxy and fail opaquely. Wiring the proxy agent in makes
 * a policy denial surface as a clean 403 and lets it work the moment the host
 * is allowlisted. With no proxy set, it's a plain direct client.
 */

import Stripe from 'stripe';
import { HttpsProxyAgent } from 'https-proxy-agent';

export function makeStripe(secretKey: string): Stripe {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return proxy ? new Stripe(secretKey, { httpAgent: new HttpsProxyAgent(proxy) }) : new Stripe(secretKey);
}
