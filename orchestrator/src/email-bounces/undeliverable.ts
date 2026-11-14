/**
 * Addresses that can never be delivered because their domain is reserved for testing or documentation.
 *
 *   top-level domains   .invalid  .test  .example  .localhost   (RFC 2606, RFC 6761)
 *   second-level        example.com  example.net  example.org     (RFC 2606), and any subdomain of them
 *
 * An email to one of these is never received by a person. Sending it anyway still counts against the account's
 * bounce rate at the provider (Postmark pauses accounts whose bounce rate is high), so every real send path refuses
 * them before any provider call. The sign-up forms still accept them (hundreds of tests and fixtures rely on that),
 * so a reserved-address sign-up is captured and then simply never emailed.
 *
 * The check is exact on whole domain labels: myexample.com, test.co.uk, invalid.co.uk and example.com.au are real
 * domains and are NOT reserved. No regular expression is used on the whole address, so a display name or a second
 * '@' cannot hide the domain: the domain is always what follows the LAST '@'.
 */
import { domainToASCII } from 'node:url';

const RESERVED_TOP_LEVEL: ReadonlySet<string> = new Set(['invalid', 'test', 'example', 'localhost']);
const RESERVED_SECOND_LEVEL: ReadonlySet<string> = new Set(['example.com', 'example.net', 'example.org']);

/**
 * The address's domain in lower-case ASCII (internationalised names converted the way mail software converts them),
 * or null when there is no usable domain. `Name <a@b.c>` is read as a@b.c.
 */
function domainOf(value: string): string | null {
  let address = value.trim().toLowerCase();
  if (address.endsWith('>')) {
    const open = address.lastIndexOf('<');
    if (open < 0) return null;
    address = address.slice(open + 1, -1).trim();
  }
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  let domain = address.slice(at + 1);
  // One trailing dot is the fully-qualified spelling of the same domain.
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (!domain || domain.length > 253) return null;
  // A name the converter rejects (for example an invalid "xn--" label under .test) is checked as typed: a crafted
  // label must not hide a reserved ending.
  const ascii = domainToASCII(domain) || domain;
  if (ascii.split('.').some(label => label.length === 0)) return null;
  return ascii;
}

/** True when the address's domain is reserved for testing or documentation, so no email to it can ever arrive. */
export function isReservedEmailAddress(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 1024) return false;
  const domain = domainOf(value);
  if (!domain) return false;
  const labels = domain.split('.');
  if (RESERVED_TOP_LEVEL.has(labels[labels.length - 1]!)) return true;
  return labels.length >= 2 && RESERVED_SECOND_LEVEL.has(labels.slice(-2).join('.'));
}

/**
 * The explicit test-transport seam. A unit test that hands a real sender a FAKE fetch function and deliberately
 * uses reserved addresses (example.com fixtures) wraps that fake with this; nothing else turns the guard off.
 * It is not read from the environment or configuration, and production code never calls it (a test checks that).
 * A wrapped function is only ever a test double: the real network fetch is never marked.
 */
const TEST_TRANSPORTS = new WeakSet<object>();
export function allowReservedRecipientsForTestTransport<T extends object>(fake: T): T {
  if (fake === (globalThis as { fetch?: unknown }).fetch) throw new Error('The real fetch can never send to reserved addresses');
  TEST_TRANSPORTS.add(fake);
  return fake;
}

/** What a real send path asks just before a provider call: refuse this address? False only for a marked test transport. */
export function refusesReservedRecipient(transport: unknown, address: unknown): boolean {
  if ((typeof transport === 'object' || typeof transport === 'function') && transport !== null && TEST_TRANSPORTS.has(transport)) return false;
  return isReservedEmailAddress(address);
}
