/**
 * Brevo marketing contacts — the OTHER half of email (Postmark = transactional,
 * Brevo = marketing/nurture + onboarding). The actual drip sequences live as
 * automations in Brevo's UI; this code just syncs a contact into the right list
 * so those automations fire. Structurally decoupled via BrevoLike so callers
 * test with a fake (no key, no network). Real client is proxy-aware node:https.
 */

import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';

export interface BrevoContact {
  email: string;
  firstName?: string;
  attributes?: Record<string, string | number | boolean>;
  /** Brevo list IDs to add the contact to (each list can trigger an automation). */
  listIds?: number[];
}

/** The slice of Brevo the sync touches — the real client satisfies it. */
export interface BrevoLike {
  upsertContact(c: BrevoContact): Promise<void>;
}

export class BrevoError extends Error {}

/** Build the Brevo /v3/contacts body. Pure; validates the email. */
export function contactBody(c: BrevoContact): Record<string, unknown> {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) throw new BrevoError(`invalid email "${c.email}"`);
  const attributes: Record<string, unknown> = { ...(c.attributes ?? {}) };
  if (c.firstName) attributes.FIRSTNAME = c.firstName;
  return { email: c.email, attributes, listIds: c.listIds ?? [], updateEnabled: true };
}

/** Real Brevo client over node:https (proxy-aware). Upsert = create or update. */
export function makeBrevo(apiKey: string): BrevoLike {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  return {
    upsertContact(c: BrevoContact): Promise<void> {
      const payload = JSON.stringify(contactBody(c));
      return new Promise<void>((resolve, reject) => {
        const req = https.request(
          {
            method: 'POST',
            host: 'api.brevo.com',
            path: '/v3/contacts',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'api-key': apiKey,
              'Content-Length': Buffer.byteLength(payload),
            },
            agent,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (b: Buffer) => chunks.push(b));
            res.on('end', () => {
              const status = res.statusCode ?? 0;
              // 201 = created, 204 = updated (updateEnabled). Both are success.
              if (status === 201 || status === 204) return resolve();
              const raw = Buffer.concat(chunks).toString('utf8');
              reject(new BrevoError(`Brevo error ${status}: ${raw.slice(0, 200)}`));
            });
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    },
  };
}
