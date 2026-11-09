import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleInvestorPublicSite } from '../src/portal/investor-site.js';
import type { InvestorService } from '../src/portal/investor-service.js';

const secret = 'mhp-embed-isolated-form-secret-at-least-32-characters';
const site = { slug: 'sample-mentee', headline: 'Invest with us', introduction: '', locations: '',
  contactEmail: 'hello@example.invalid', privacyUrl: 'https://example.invalid/privacy',
  brandName: 'Sample Mentee', accentColor: '#142019' };

function harness() {
  const captured: { slug: string; name: string; email: string; message: string }[] = [];
  const service = { publicSite: async (slug: string) => slug === site.slug ? site : null,
    captureSiteEnquiry: async (slug: string, _token: string, name: string, email: string, message: string) => {
      captured.push({ slug, name, email, message });
    } } as unknown as InvestorService;
  const run = async (method: string, url: string, form = '') => {
    const output = { status: 0, body: '', headers: {} as Record<string, string> };
    const req = Object.assign(Readable.from([Buffer.from(form)]), { method, url, headers: { 'content-type': 'application/x-www-form-urlencoded' } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, headers: Record<string, string>) { output.status = status; output.headers = headers; }, end(body = '') { output.body = body; } } as unknown as ServerResponse;
    await handleInvestorPublicSite(req, res, service, secret);
    return output;
  };
  return { captured, run };
}

test('published mentee form embeds safely and stores a consented request in only that business', async () => {
  const h = harness();
  const url = '/investor-sites/sample-mentee/embed?offer=BRR%20guide';
  const page = await h.run('GET', url);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.headers['content-security-policy']!, /frame-ancestors 'none'/);
  assert.match(page.body, /BRR guide/);
  assert.match(page.body, /privacy notice/);
  const token = page.body.match(/name="token" value="([^"]+)"/)?.[1];
  assert.ok(token);
  const fields = new URLSearchParams({ token, website: '', name: 'Investor One', email: 'one@example.invalid', contactRequest: 'yes' });
  const result = await h.run('POST', url, fields.toString());
  assert.equal(result.status, 200);
  assert.match(result.body, /Request received/);
  assert.deepEqual(h.captured, [{ slug: 'sample-mentee', name: 'Investor One', email: 'one@example.invalid', message: 'Requested lead magnet: BRR guide' }]);
  const missingConsent = await h.run('POST', url, new URLSearchParams({ token, name: 'Investor Two', email: 'two@example.invalid' }).toString());
  assert.equal(missingConsent.status, 400);
  assert.equal(h.captured.length, 1);
});

test('embed rejects unknown and unpublished sites and unbounded resource labels', async () => {
  const h = harness();
  assert.equal((await h.run('GET', '/investor-sites/unknown/embed')).status, 404);
  assert.equal((await h.run('GET', `/investor-sites/sample-mentee/embed?offer=${'x'.repeat(101)}`)).status, 400);
  assert.equal(h.captured.length, 0);
});
