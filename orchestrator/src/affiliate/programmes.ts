/**
 * Affiliate programmes (Affiliate Studio, slice 1): one entry per programme, holding everything the rest of the code
 * may assume about it. A second programme is a new entry here plus its line in each CHECK of migration 0158 that
 * names 'amazon_uk'.
 *
 * Amazon UK links are never taken as pasted. parseLink reads a pasted address and keeps only the product code (the
 * ASIN) and the tracking ID; prepareLink then builds the one canonical link this code ever stores or renders:
 *   https://www.amazon.co.uk/dp/<ASIN>?tag=<tracking ID>
 * Everything else in the pasted address (other query values, the product title, fragments, referral junk) is dropped.
 * Short links, other Amazon shops, other websites, sign-in details, unusual ports and anything that is not one product
 * page are refused. Every refusal carries one plain-English sentence a screen can show exactly as it is.
 *
 * Nothing here fetches Amazon or anything else, and nothing here is imported by a page or worker yet.
 */

export type ProgrammeId = 'amazon_uk';
export const PROGRAMME_IDS: readonly ProgrammeId[] = Object.freeze(['amazon_uk'] as const);

/** A pasted link, read. trackingId is null when the address carried none (a plain product page). */
export interface ParsedLink {
  readonly ok: true;
  readonly programme: ProgrammeId;
  /** The programme's product code (for Amazon UK, the ASIN, upper case). */
  readonly productCode: string;
  /** The product page without any tracking: https://www.amazon.co.uk/dp/<ASIN>. */
  readonly productUrl: string;
  readonly trackingId: string | null;
  /** A product name read from the address's title words, when it had any. Never trusted as fact. */
  readonly suggestedName: string | null;
}
/** A link ready to store: the canonical product page and the canonical affiliate link. */
export interface PreparedLink {
  readonly ok: true;
  readonly programme: ProgrammeId;
  readonly productCode: string;
  readonly productUrl: string;
  readonly affiliateUrl: string;
  readonly trackingId: string;
  readonly suggestedName: string | null;
}
export interface Refusal { readonly ok: false; readonly reason: string }
export type LinkCheck = { readonly ok: true; readonly url: string } | Refusal;

export interface ProgrammeRules {
  /** Prices, discounts or deals may never be written: they change and may only come from the programme itself. */
  readonly mayStatePrices: false;
  /** Star ratings and review counts may never be written. */
  readonly mayShowRatings: false;
  /** Stock, delivery and "best seller" style claims may never be written. */
  readonly mayStateStock: false;
  /** First-hand wording only when the owner ticked "I have used this myself". */
  readonly firstHandNeedsOwnerUse: true;
  /** No short links, redirects or cloaking: the reader always sees the merchant's own address. */
  readonly directLinksOnly: true;
  /** Links may not go into emails, documents or social posts in this slice. */
  readonly linksInEmail: false;
  readonly linksInSocial: false;
  /** An article with these links always waits for the owner's approval and never publishes itself. */
  readonly requiresApproval: true;
  readonly autoPublish: false;
}

export interface Disclosure {
  readonly version: string;
  /** The short label shown first, in bold. */
  readonly label: string;
  /** The sentences after the label. */
  readonly text: string;
}

export interface AffiliateProgramme {
  readonly id: ProgrammeId;
  /** How the programme is named to the owner and readers. */
  readonly name: string;
  /** The merchant as stored on each product. */
  readonly merchantName: string;
  /** The only hosts a stored link may point at. */
  readonly linkHosts: readonly string[];
  readonly disclosure: Disclosure;
  readonly rel: string;
  /** The words of a product's button. */
  linkLabel(productName: string): string;
  /** Shown after every link. */
  readonly paidLinkNote: string;
  readonly rules: ProgrammeRules;
  /** The report files the owner may upload for this programme. */
  readonly reportKinds: readonly string[];
  /** Reads a pasted address. */
  parseLink(input: unknown): ParsedLink | Refusal;
  /** A pasted address plus the business's saved tracking ID (or null), as a link ready to store. */
  prepareLink(input: unknown, savedTrackingId: string | null): PreparedLink | Refusal;
  /** A stored link, checked again (before rendering or approval): exactly canonical, and the saved tracking ID if given. */
  validateLink(url: unknown, savedTrackingId?: string | null): LinkCheck;
  /** A tracking ID the owner typed. */
  validateTrackingId(input: unknown): { readonly ok: true; readonly trackingId: string } | Refusal;
}

const refuse = (reason: string): Refusal => Object.freeze({ ok: false as const, reason });

/** The plain-English sentences. No technical words: a screen shows them exactly as they are. */
export const LINK_MESSAGES = Object.freeze({
  empty: 'Paste the address of the product page on Amazon UK.',
  tooLong: 'That address is too long to be a product page. Copy it again from your browser and paste it here.',
  notAnAddress: 'That does not look like a web address. Copy the address of the product page on Amazon UK and paste it here.',
  notSecure: 'Copy the full address of the product page from your browser while you are on amazon.co.uk, and paste it here.',
  signIn: 'This address contains a sign-in name or password. Copy the plain address of the product page instead.',
  port: 'This address points somewhere unusual on the website. Copy the plain address of the product page on amazon.co.uk.',
  shortLink: 'Short links cannot be used. Paste the full link, or paste the product page and we add your tracking ID.',
  otherAmazon: 'This link is for a different Amazon shop. Use a product page from amazon.co.uk.',
  bareAmazon: 'Copy the address exactly as your browser shows it on the Amazon UK website, starting with www.amazon.co.uk.',
  otherSite: 'This address is not Amazon UK\'s own website. Copy the link from amazon.co.uk itself.',
  notProduct: 'This is not the page of a single product. Open the product on Amazon UK and copy that page\'s address.',
  twoTrackingIds: 'This link carries more than one tracking ID. Copy the link again from your Amazon UK Associates account.',
  badTrackingId: 'The tracking ID in this link does not look like an Amazon UK tracking ID, which ends in -21.',
  trackingIdMismatch: 'This link carries a different tracking ID from the one saved for this business. Use a link made with your saved tracking ID, or paste the product page and we add it.',
  needsTrackingId: 'Add your Amazon UK tracking ID first (it ends in -21), or paste a link made in your Amazon UK Associates account.',
  storedNotCanonical: 'This link is not in the form we make for Amazon UK. Add the product again from its product page.',
  trackingIdEmpty: 'Enter your Amazon UK tracking ID. You can find it in your Amazon UK Associates account; it ends in -21.',
  trackingIdInvalid: 'An Amazon UK tracking ID is letters, numbers and hyphens and ends in -21, for example mysite-21.',
});

/** Amazon UK's short-link and other-shop hosts, by their registrable name. */
const SHORT_HOSTS = new Set(['amzn.to', 'amzn.eu', 'amzn.co.uk', 'amzn.com', 'a.co', 'amzlink.to', 'amzn.asia']);
const AMAZON_UK_HOST = 'www.amazon.co.uk';
const TRACKING_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,60}-21$/u;
const ASIN = /^[A-Za-z0-9]{10}$/u;
const MAX_INPUT = 2048;
// Characters the address parser would quietly drop or rewrite; refused before parsing so what we read is what was pasted.
const UNSAFE_RAW = /[\s\u0000-\u001f\u007f\\\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff]/u;
const CANONICAL = /^https:\/\/www\.amazon\.co\.uk\/dp\/([A-Z0-9]{10})\?tag=([A-Za-z0-9][A-Za-z0-9-]{0,60}-21)$/u;

function registrable(host: string): string {
  const labels = host.split('.');
  return labels.length >= 3 && labels[labels.length - 2] === 'co' ? labels.slice(-3).join('.') : labels.slice(-2).join('.');
}

/** The title words of an Amazon address ("Anker-PowerCore-10000/dp/..."), as a suggested name, or null. */
function suggestedName(slug: string | undefined): string | null {
  if (!slug) return null;
  let text: string;
  try { text = decodeURIComponent(slug); } catch { return null; }
  text = text.replace(/[-_+]+/gu, ' ').replace(/[\p{Cc}\p{Cf}<>"`]/gu, '').replace(/\s+/gu, ' ').trim();
  if (!/\p{L}/u.test(text) || text.length < 2) return null;
  return text.length > 200 ? text.slice(0, 200).trim() : text;
}

/** The product code of one product page, or null. Accepts /dp/X, /<title>/dp/X, /gp/product/X and /gp/aw/d/X. */
function productCodeOf(pathname: string): { code: string; slug?: string } | null {
  const parts = pathname.split('/').slice(1);
  if (parts.length > 12) return null;
  const lower = parts.map(p => p.toLowerCase());
  let index: number; let slug: string | undefined;
  if (lower[0] === 'dp') index = 1;
  else if (lower[1] === 'dp' && parts[0] !== '') { index = 2; slug = parts[0]; }
  else if (lower[0] === 'gp' && lower[1] === 'product') index = 2;
  else if (lower[0] === 'gp' && lower[1] === 'aw' && lower[2] === 'd') index = 3;
  else return null;
  const code = parts[index];
  if (code === undefined || !ASIN.test(code)) return null;
  // Anything after the product code may only be Amazon's own trail ("ref=..."), never a second product.
  for (const rest of parts.slice(index + 1)) if (rest !== '' && !/^ref=[A-Za-z0-9_.-]{0,200}$/u.test(rest)) return null;
  return { code: code.toUpperCase(), slug };
}

function parseAmazonUk(input: unknown): ParsedLink | Refusal {
  if (typeof input !== 'string') return refuse(LINK_MESSAGES.empty);
  const raw = input.trim();
  if (!raw) return refuse(LINK_MESSAGES.empty);
  if (raw.length > MAX_INPUT) return refuse(LINK_MESSAGES.tooLong);
  if (UNSAFE_RAW.test(raw)) return refuse(LINK_MESSAGES.notAnAddress);
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(raw)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    // "amzn.to/abc" or "www.amazon.co.uk/dp/..." typed without the start: tell them which.
    const host = raw.split(/[/?#]/u)[0]!.toLowerCase();
    if (SHORT_HOSTS.has(host)) return refuse(LINK_MESSAGES.shortLink);
    return refuse(/\./u.test(host) ? LINK_MESSAGES.notSecure : LINK_MESSAGES.notAnAddress);
  }
  if (scheme !== 'https') return refuse(scheme === 'http' ? LINK_MESSAGES.notSecure : LINK_MESSAGES.notAnAddress);
  // The authority exactly as pasted ("https://" then up to the first / ? or #): no sign-in details, no port but 443.
  if (!/^https:\/\//iu.test(raw)) return refuse(LINK_MESSAGES.notAnAddress);
  const authority = raw.slice(8).split(/[/?#]/u)[0] ?? '';
  if (authority.includes('@')) return refuse(LINK_MESSAGES.signIn);
  // An encoded character in the website's name is never pasted from a browser: it only disguises where a link goes.
  if (authority.includes('%')) return refuse(LINK_MESSAGES.notAnAddress);
  let url: URL;
  try { url = new URL(raw); } catch { return refuse(LINK_MESSAGES.notAnAddress); }
  if (url.protocol !== 'https:') return refuse(LINK_MESSAGES.notSecure);
  if (url.username || url.password) return refuse(LINK_MESSAGES.signIn);
  if (url.port !== '' || (authority.includes(':') && !authority.startsWith('[') && !/^[^:]+:443$/u.test(authority))) return refuse(LINK_MESSAGES.port);
  const host = url.hostname;
  if (SHORT_HOSTS.has(host) || SHORT_HOSTS.has(registrable(host))) return refuse(LINK_MESSAGES.shortLink);
  if (host !== AMAZON_UK_HOST) {
    if (host === 'amazon.co.uk' || host.endsWith('.amazon.co.uk')) return refuse(LINK_MESSAGES.bareAmazon);
    if (/(?:^|\.)amazon\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/u.test(host)) return refuse(LINK_MESSAGES.otherAmazon);
    return refuse(LINK_MESSAGES.otherSite);
  }
  // Dot segments ("/x/../dp/...") are resolved by the parser; a product page never has them, so they are refused.
  const rawPath = raw.slice(8 + authority.length).split(/[?#]/u)[0] ?? '';
  if (/(?:^|\/)\.\.?(?:\/|$)/u.test(rawPath) || /%2e/iu.test(rawPath)) return refuse(LINK_MESSAGES.notProduct);
  const product = productCodeOf(url.pathname);
  if (!product) return refuse(LINK_MESSAGES.notProduct);
  const tags: string[] = [];
  for (const [key, value] of url.searchParams) if (key.trim().toLowerCase() === 'tag') tags.push(value);
  if (tags.length > 1) return refuse(LINK_MESSAGES.twoTrackingIds);
  const tag = tags[0];
  if (tag !== undefined && !TRACKING_ID.test(tag)) return refuse(LINK_MESSAGES.badTrackingId);
  return Object.freeze({ ok: true as const, programme: 'amazon_uk' as const, productCode: product.code,
    productUrl: `https://${AMAZON_UK_HOST}/dp/${product.code}`, trackingId: tag ?? null, suggestedName: suggestedName(product.slug) });
}

function validateAmazonUkTrackingId(input: unknown): { readonly ok: true; readonly trackingId: string } | Refusal {
  if (typeof input !== 'string' || !input.trim()) return refuse(LINK_MESSAGES.trackingIdEmpty);
  const id = input.trim();
  return id.length <= 64 && TRACKING_ID.test(id) ? Object.freeze({ ok: true as const, trackingId: id }) : refuse(LINK_MESSAGES.trackingIdInvalid);
}

function prepareAmazonUk(input: unknown, savedTrackingId: string | null): PreparedLink | Refusal {
  const parsed = parseAmazonUk(input);
  if (!parsed.ok) return parsed;
  let saved: string | null = null;
  if (savedTrackingId !== null && savedTrackingId !== undefined) {
    const check = validateAmazonUkTrackingId(savedTrackingId);
    if (!check.ok) return check;
    saved = check.trackingId;
  }
  if (parsed.trackingId !== null && saved !== null && parsed.trackingId !== saved) return refuse(LINK_MESSAGES.trackingIdMismatch);
  const trackingId = parsed.trackingId ?? saved;
  if (trackingId === null) return refuse(LINK_MESSAGES.needsTrackingId);
  return Object.freeze({ ok: true as const, programme: 'amazon_uk' as const, productCode: parsed.productCode, productUrl: parsed.productUrl,
    affiliateUrl: `${parsed.productUrl}?tag=${trackingId}`, trackingId, suggestedName: parsed.suggestedName });
}

function validateAmazonUk(url: unknown, savedTrackingId?: string | null): LinkCheck {
  if (typeof url !== 'string') return refuse(LINK_MESSAGES.storedNotCanonical);
  const match = CANONICAL.exec(url);
  if (!match) return refuse(LINK_MESSAGES.storedNotCanonical);
  if (savedTrackingId !== undefined && savedTrackingId !== null && match[2] !== savedTrackingId) return refuse(LINK_MESSAGES.trackingIdMismatch);
  return Object.freeze({ ok: true as const, url });
}

const AMAZON_UK: AffiliateProgramme = Object.freeze({
  id: 'amazon_uk' as const,
  name: 'Amazon UK',
  merchantName: 'Amazon UK',
  linkHosts: Object.freeze([AMAZON_UK_HOST]),
  disclosure: Object.freeze({
    version: 'amazon_uk.2026-11',
    label: 'Ad.',
    text: 'This article contains affiliate links. If you buy through them, we may earn a commission at no extra cost to you. As an Amazon Associate I earn from qualifying purchases.',
  }),
  rel: 'sponsored nofollow noopener',
  linkLabel: (productName: string) => `See ${productName} on Amazon`,
  paidLinkNote: '(paid link)',
  rules: Object.freeze({
    mayStatePrices: false as const, mayShowRatings: false as const, mayStateStock: false as const, firstHandNeedsOwnerUse: true as const,
    directLinksOnly: true as const, linksInEmail: false as const, linksInSocial: false as const, requiresApproval: true as const, autoPublish: false as const,
  }),
  reportKinds: Object.freeze(['user_uploaded_amazon_tracking_id_summary']),
  parseLink: parseAmazonUk,
  prepareLink: prepareAmazonUk,
  validateLink: validateAmazonUk,
  validateTrackingId: validateAmazonUkTrackingId,
});

export const PROGRAMMES: Readonly<Record<ProgrammeId, AffiliateProgramme>> = Object.freeze({ amazon_uk: AMAZON_UK });

/** The programme with this id, or null. */
export function programmeFor(id: unknown): AffiliateProgramme | null {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROGRAMMES, id) ? PROGRAMMES[id as ProgrammeId] : null;
}

export const SITE_MESSAGES = Object.freeze({
  empty: 'Enter the address of the website that will carry these links, for example www.example.co.uk.',
  invalid: 'Enter just the website\'s address, for example www.example.co.uk, without any page after it.',
  notSecure: 'This website needs to open securely (with the padlock in the browser) before it can carry these links.',
});

/**
 * The website that will carry the links, as its secure origin ("https://www.example.co.uk"), from what the owner typed:
 * "www.example.co.uk", "https://www.example.co.uk" or a page on it. Refuses plain-http sites, addresses with sign-in
 * details or a port, numeric addresses and names without a dot.
 */
export function parseRegisteredSite(input: unknown): { readonly ok: true; readonly site: string } | Refusal {
  if (typeof input !== 'string' || !input.trim()) return refuse(SITE_MESSAGES.empty);
  const raw = input.trim();
  if (raw.length > 300 || UNSAFE_RAW.test(raw)) return refuse(SITE_MESSAGES.invalid);
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(raw)?.[1]?.toLowerCase();
  if (scheme === 'http') return refuse(SITE_MESSAGES.notSecure);
  if (scheme !== undefined && scheme !== 'https') return refuse(SITE_MESSAGES.invalid);
  const full = scheme ? raw : `https://${raw}`;
  const authority = full.slice(8).split(/[/?#]/u)[0] ?? '';
  if (authority.includes('@')) return refuse(SITE_MESSAGES.invalid);
  let url: URL;
  try { url = new URL(full); } catch { return refuse(SITE_MESSAGES.invalid); }
  if (url.username || url.password || url.port || authority.includes(':')) return refuse(SITE_MESSAGES.invalid);
  const host = url.hostname;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(host) || host.length > 253
    || /^[0-9.]+$/u.test(host) || !/[a-z]/u.test(host.split('.').pop()!)) return refuse(SITE_MESSAGES.invalid);
  return Object.freeze({ ok: true as const, site: `https://${host}` });
}
