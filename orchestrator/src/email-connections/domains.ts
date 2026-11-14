/**
 * Pure checks on the owner's addresses and domain, our own DNS look-ups (only ever used to word a clearer message;
 * Postmark's answer alone decides whether a record is verified), and which DNS host a domain uses.
 */
import { Resolver } from 'node:dns/promises';
import { isReservedEmailAddress } from '../email-bounces/undeliverable.js';

const LOCAL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/u;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** A lower-case domain name of two or more labels, ending in a letter label. */
export function validDomain(domain: string): boolean {
  if (domain.length < 4 || domain.length > 253) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(label => LABEL.test(label)) && /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/u.test(labels.at(-1)!);
}

/** "Hello@Example.co.uk " → { address: "hello@example.co.uk", domain: "example.co.uk" }, or null. */
export function parseEmailAddress(raw: string): { readonly address: string; readonly domain: string } | null {
  const address = raw.trim().toLowerCase();
  if (address.length > 254) return null;
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  const local = address.slice(0, at), domain = address.slice(at + 1);
  if (!LOCAL.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !validDomain(domain)) return null;
  return Object.freeze({ address, domain });
}

const FREE = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'ymail.com', 'rocketmail.com',
  'proton.me', 'protonmail.com', 'pm.me', 'mail.com', 'zoho.com', 'zohomail.com', 'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io',
  'btinternet.com', 'btopenworld.com', 'sky.com', 'virginmedia.com', 'blueyonder.co.uk', 'ntlworld.com', 'talktalk.net', 'tiscali.co.uk',
  'gmx.com', 'gmx.co.uk', 'web.de', 'qq.com', '163.com', 'mail.ru', 'yandex.com']);
/** Brands whose free mailboxes run under many country endings (yahoo.co.uk, hotmail.fr, live.com …). */
const FREE_BRANDS = new Set(['yahoo', 'hotmail', 'live', 'outlook', 'gmx', 'yandex', 'aol', 'windowslive']);

/** True for a free mailbox domain (or one of its subdomains): an address there cannot be sent from by a business. */
export function freeMailboxDomain(domain: string): boolean {
  const labels = domain.toLowerCase().split('.');
  for (let start = 0; start < labels.length - 1; start++) {
    const candidate = labels.slice(start).join('.');
    if (FREE.has(candidate)) return true;
    // yahoo.com, yahoo.co.uk, hotmail.fr: the brand followed by a short country or generic ending only.
    if (FREE_BRANDS.has(labels[start]!) && /^(?:[a-z]{2,3}\.)?[a-z]{2,3}$/u.test(labels.slice(start + 1).join('.'))) return true;
  }
  return false;
}

/** True for a domain reserved for testing or documentation (the platform's one rule, shared with every send path). */
export function reservedDomain(domain: string): boolean { return isReservedEmailAddress(`postmaster@${domain}`); }

/** "20240101pm._domainkey.example.co.uk" with domain "example.co.uk" → "20240101pm._domainkey". */
export function shortHost(host: string, domain: string): string {
  const full = host.toLowerCase().replace(/\.$/u, ''), suffix = `.${domain.toLowerCase()}`;
  return full === domain.toLowerCase() ? '@' : full.endsWith(suffix) ? full.slice(0, -suffix.length) : full;
}

export type DnsHost = 'cloudflare' | 'godaddy' | 'namecheap' | '123-reg' | 'ionos' | 'other';
/** Who answers for the domain, read from its name servers. */
export function dnsHostFromNameServers(nameServers: readonly string[]): DnsHost {
  const all = nameServers.map(ns => ns.toLowerCase().replace(/\.$/u, ''));
  const any = (test: (ns: string) => boolean) => all.some(test);
  if (any(ns => ns.endsWith('.ns.cloudflare.com'))) return 'cloudflare';
  if (any(ns => ns.endsWith('.domaincontrol.com'))) return 'godaddy';
  if (any(ns => ns.endsWith('.registrar-servers.com'))) return 'namecheap';
  if (any(ns => ns.endsWith('.123-reg.co.uk'))) return '123-reg';
  if (any(ns => /\.ui-dns\.(?:com|de|org|biz)$/u.test(ns))) return 'ionos';
  return 'other';
}

export interface DnsResolver {
  resolveTxt(host: string): Promise<string[][]>;
  resolveCname(host: string): Promise<string[]>;
  resolveNs(host: string): Promise<string[]>;
}
const LOOKUP_TIMEOUT_MS = 3_000;

/** The system resolver with a short timeout and a single try. */
export function systemDnsResolver(): DnsResolver {
  const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });
  return { resolveTxt: host => resolver.resolveTxt(host), resolveCname: host => resolver.resolveCname(host), resolveNs: host => resolver.resolveNs(host) };
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), LOOKUP_TIMEOUT_MS + 500); timer.unref?.(); })]);
  } finally { clearTimeout(timer); }
}

/** What our own look-up saw: the record is there with the right value, there with another value, absent, or unknown. */
export type DnsSeen = 'found' | 'different' | 'missing' | 'unknown';
const ABSENT_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);
const squash = (value: string): string => value.replace(/["\s]/gu, '');
const bare = (value: string): string => value.toLowerCase().replace(/\.$/u, '');

export async function lookUpTxt(resolver: DnsResolver, host: string, expected: string): Promise<DnsSeen> {
  try {
    const records = (await bounded(resolver.resolveTxt(host))).map(chunks => chunks.join(''));
    if (!records.length) return 'missing';
    return records.some(value => squash(value) === squash(expected)) ? 'found' : 'different';
  } catch (error) {
    return ABSENT_CODES.has(String((error as { code?: unknown })?.code)) ? 'missing' : 'unknown';
  }
}

export async function lookUpCname(resolver: DnsResolver, host: string, expected: string): Promise<DnsSeen> {
  try {
    const records = await bounded(resolver.resolveCname(host));
    if (!records.length) return 'missing';
    return records.some(value => bare(value) === bare(expected)) ? 'found' : 'different';
  } catch (error) {
    return ABSENT_CODES.has(String((error as { code?: unknown })?.code)) ? 'missing' : 'unknown';
  }
}

/** The DNS host for a domain (looking one level up if the name itself has no NS records), or 'other'. Never throws. */
export async function lookUpDnsHost(resolver: DnsResolver, domain: string): Promise<DnsHost> {
  const labels = domain.split('.');
  for (let start = 0; start < Math.min(3, labels.length - 1); start++) {
    try {
      const servers = await bounded(resolver.resolveNs(labels.slice(start).join('.')));
      if (servers.length) return dnsHostFromNameServers(servers);
    } catch { /* look one level up */ }
  }
  return 'other';
}
