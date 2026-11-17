import test from 'node:test';
import assert from 'node:assert/strict';
import { LINK_MESSAGES, PROGRAMMES, PROGRAMME_IDS, SITE_MESSAGES, parseRegisteredSite, programmeFor } from '../src/affiliate/programmes.js';

const amazon = PROGRAMMES.amazon_uk;
const ASIN = 'B08N5WRWNW';
const PAGE = `https://www.amazon.co.uk/dp/${ASIN}`;
const ch = (code: number) => String.fromCodePoint(code);

/** Every refusal sentence a screen may show: plain English, no technical words, ends with a full stop. */
const TECHNICAL = /\b(?:url|uri|asin|param(?:eter)?s?|query|host(?:name)?|domain|https?|punycode|regex|encod(?:ed|ing)|utf|null|undefined|error|invalid|exception|json|sql|42501|port\b)/iu;

test('the registry: one entry per programme, with its rules, disclosure, rel, label and report kinds', () => {
  assert.deepEqual([...PROGRAMME_IDS], ['amazon_uk']);
  assert.deepEqual(Object.keys(PROGRAMMES), ['amazon_uk']);
  assert.equal(programmeFor('amazon_uk'), amazon);
  for (const id of ['amazon_com', 'other', '', '__proto__', 'constructor', 'toString', null, 1]) assert.equal(programmeFor(id), null, String(id));
  assert.equal(amazon.name, 'Amazon UK');
  assert.equal(amazon.merchantName, 'Amazon UK');
  assert.deepEqual([...amazon.linkHosts], ['www.amazon.co.uk']);
  assert.equal(amazon.rel, 'sponsored nofollow noopener');
  assert.equal(amazon.linkLabel('Kettle'), 'See Kettle on Amazon');
  assert.equal(amazon.paidLinkNote, '(paid link)');
  assert.equal(amazon.disclosure.label, 'Ad.');
  assert.match(amazon.disclosure.text, /As an Amazon Associate I earn from qualifying purchases\.$/u);
  assert.match(amazon.disclosure.version, /^amazon_uk\.\d{4}-\d{2}$/u);
  assert.deepEqual(amazon.rules, { mayStatePrices: false, mayShowRatings: false, mayStateStock: false, firstHandNeedsOwnerUse: true, directLinksOnly: true,
    linksInEmail: false, linksInSocial: false, requiresApproval: true, autoPublish: false });
  assert.deepEqual([...amazon.reportKinds], ['user_uploaded_amazon_tracking_id_summary']);
  assert.ok(Object.isFrozen(PROGRAMMES) && Object.isFrozen(amazon) && Object.isFrozen(amazon.rules));
});

test('every refusal sentence is plain English a screen can show as it is', () => {
  for (const [key, sentence] of [...Object.entries(LINK_MESSAGES), ...Object.entries(SITE_MESSAGES)]) {
    assert.doesNotMatch(sentence, TECHNICAL, key);
    assert.match(sentence, /^[A-Z].*[.]$/u, key);
    assert.ok(sentence.length <= 220, key);
  }
});

test('Amazon UK product pages in every usual shape read to one canonical product page', () => {
  const shapes = [
    PAGE,
    `${PAGE}/`,
    `${PAGE}?th=1&psc=1`,
    `https://www.amazon.co.uk/Anker-PowerCore-10000-Ultra-Compact/dp/${ASIN}/ref=sr_1_3?crid=2X&keywords=power+bank&qid=1700000000&sr=8-3`,
    `https://www.amazon.co.uk/gp/product/${ASIN}?pf_rd_r=XYZ&pd_rd_w=abc`,
    `https://www.amazon.co.uk/gp/aw/d/${ASIN}/ref=ox_sc_act_image_1`,
    `https://www.amazon.co.uk/dp/${ASIN.toLowerCase()}`,
    `https://WWW.Amazon.CO.UK/dp/${ASIN}`,
    `HTTPS://www.amazon.co.uk/dp/${ASIN}`,
    `https://www.amazon.co.uk:443/dp/${ASIN}`,
    `https://www.amazon.co.uk/dp/${ASIN}#customerReviews`,
    `https://www.amazon.co.uk/dp/${ASIN}?_encoding=UTF8&linkCode=ll1&linkId=0123456789abcdef&ref_=as_li_ss_tl&ascsubtag=reader-42&smid=A3P5ROKL5A1OLE`,
    `   ${PAGE}   `,
  ];
  for (const shape of shapes) {
    const parsed = amazon.parseLink(shape);
    assert.ok(parsed.ok, shape);
    assert.equal(parsed.productCode, ASIN, shape);
    assert.equal(parsed.productUrl, PAGE, shape);
    assert.equal(parsed.trackingId, null, shape);
    assert.equal(parsed.programme, 'amazon_uk');
  }
  const titled = amazon.parseLink(`https://www.amazon.co.uk/Anker-PowerCore-10000-Ultra-Compact/dp/${ASIN}/`);
  assert.ok(titled.ok);
  assert.equal(titled.suggestedName, 'Anker PowerCore 10000 Ultra Compact');
  const plain = amazon.parseLink(PAGE);
  assert.ok(plain.ok);
  assert.equal(plain.suggestedName, null);
  // Title words are cleaned and never carry markup.
  const marked = amazon.parseLink(`https://www.amazon.co.uk/%3Cb%3EBold%3C%2Fb%3E-Kettle/dp/${ASIN}`);
  assert.ok(marked.ok);
  assert.equal(marked.suggestedName, 'bBold/b Kettle');
  const broken = amazon.parseLink(`https://www.amazon.co.uk/%E0%A4%A/dp/${ASIN}`);
  assert.ok(broken.ok);
  assert.equal(broken.suggestedName, null, 'an undecodable title is simply not suggested');
});

test('exactly one tracking ID ending -21 is kept; every other value and the junk is dropped', () => {
  const parsed = amazon.parseLink(`https://www.amazon.co.uk/Some-Thing/dp/${ASIN}/ref=as_li_ss_tl?ie=UTF8&linkCode=ll1&tag=mysite-21&linkId=abc&language=en_GB&ref_=as_li_ss_tl`);
  assert.ok(parsed.ok);
  assert.equal(parsed.trackingId, 'mysite-21');
  const prepared = amazon.prepareLink(`https://www.amazon.co.uk/Some-Thing/dp/${ASIN}/ref=as_li_ss_tl?ie=UTF8&tag=mysite-21&linkId=abc`, null);
  assert.ok(prepared.ok);
  assert.equal(prepared.affiliateUrl, `${PAGE}?tag=mysite-21`);
  assert.equal(prepared.trackingId, 'mysite-21');
  // An encoded tracking ID reads as itself.
  const encoded = amazon.parseLink(`${PAGE}?%74ag=my%2Dsite-21`);
  assert.ok(encoded.ok);
  assert.equal(encoded.trackingId, 'my-site-21');
  for (const [link, reason] of [
    [`${PAGE}?tag=mysite-21&tag=mysite-21`, LINK_MESSAGES.twoTrackingIds],
    [`${PAGE}?tag=mysite-21&tag=other-21`, LINK_MESSAGES.twoTrackingIds],
    [`${PAGE}?tag=mysite-21&TAG=other-21`, LINK_MESSAGES.twoTrackingIds],
    [`${PAGE}?tag=mysite-21&%54ag=other-21`, LINK_MESSAGES.twoTrackingIds],
    [`${PAGE}?tag=mysite-20`, LINK_MESSAGES.badTrackingId],
    [`${PAGE}?tag=mysite-21x`, LINK_MESSAGES.badTrackingId],
    [`${PAGE}?tag=`, LINK_MESSAGES.badTrackingId],
    [`${PAGE}?tag=-21`, LINK_MESSAGES.badTrackingId],
    [`${PAGE}?tag=my%20site-21`, LINK_MESSAGES.badTrackingId],
    [`${PAGE}?tag=my%00site-21`, LINK_MESSAGES.badTrackingId],
    [`${PAGE}?tag=my%3Csite-21`, LINK_MESSAGES.badTrackingId],
    [`${PAGE}?tag=${'a'.repeat(70)}-21`, LINK_MESSAGES.badTrackingId],
    [`${PAGE}?tag=mysite-21%23`, LINK_MESSAGES.badTrackingId],
  ] as const) {
    const result = amazon.parseLink(link);
    assert.equal(result.ok, false, link);
    assert.equal(!result.ok && result.reason, reason, link);
  }
});

test('a plain product page plus the saved tracking ID builds the canonical link; a different tag is refused', () => {
  const built = amazon.prepareLink(`https://www.amazon.co.uk/Kettle/dp/${ASIN}?th=1`, 'mysite-21');
  assert.deepEqual(built, { ok: true, programme: 'amazon_uk', productCode: ASIN, productUrl: PAGE, affiliateUrl: `${PAGE}?tag=mysite-21`, trackingId: 'mysite-21',
    suggestedName: 'Kettle' });
  const same = amazon.prepareLink(`${PAGE}?tag=mysite-21`, 'mysite-21');
  assert.ok(same.ok);
  assert.equal(same.affiliateUrl, `${PAGE}?tag=mysite-21`);
  assert.deepEqual(amazon.prepareLink(`${PAGE}?tag=someoneelse-21`, 'mysite-21'), { ok: false, reason: LINK_MESSAGES.trackingIdMismatch });
  assert.deepEqual(amazon.prepareLink(PAGE, null), { ok: false, reason: LINK_MESSAGES.needsTrackingId });
  assert.deepEqual(amazon.prepareLink(PAGE, 'not-a-tag'), { ok: false, reason: LINK_MESSAGES.trackingIdInvalid });
  assert.deepEqual(amazon.prepareLink('https://amzn.to/3abcDEF', 'mysite-21'), { ok: false, reason: LINK_MESSAGES.shortLink });
});

test('short links, other Amazon shops, look-alikes and other websites are refused, each with its sentence', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['https://amzn.to/3abcDEF', LINK_MESSAGES.shortLink],
    ['https://amzn.eu/d/abc123', LINK_MESSAGES.shortLink],
    ['https://AMZN.TO/3abcDEF', LINK_MESSAGES.shortLink],
    ['amzn.to/3abcDEF', LINK_MESSAGES.shortLink],
    ['https://a.co/d/abc', LINK_MESSAGES.shortLink],
    ['https://www.amzn.co.uk/x', LINK_MESSAGES.shortLink],
    [`https://www.amazon.com/dp/${ASIN}`, LINK_MESSAGES.otherAmazon],
    [`https://www.amazon.de/dp/${ASIN}?tag=mysite-21`, LINK_MESSAGES.otherAmazon],
    [`https://www.amazon.com.au/dp/${ASIN}`, LINK_MESSAGES.otherAmazon],
    [`https://www.amazon.co.jp/dp/${ASIN}`, LINK_MESSAGES.otherAmazon],
    [`https://amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.bareAmazon],
    [`https://smile.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.bareAmazon],
    [`https://m.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.bareAmazon],
    [`https://www.amazon.co.uk./dp/${ASIN}`, LINK_MESSAGES.otherSite],
    [`https://www.amazon.co.uk.evil.example/dp/${ASIN}`, LINK_MESSAGES.otherSite],
    [`https://www.amazon.co.uk-deals.example/dp/${ASIN}`, LINK_MESSAGES.otherSite],
    [`https://wwwamazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.otherSite],
    [`https://www.amaz0n.co.uk/dp/${ASIN}`, LINK_MESSAGES.otherSite],
    [`https://www.xn--amzon-hwe.co.uk/dp/${ASIN}`, LINK_MESSAGES.otherSite],
    [`https://www.am${ch(0x0430)}zon.co.uk/dp/${ASIN}`, LINK_MESSAGES.otherSite],
    [`https://www.amazon.co.uk${ch(0x3002)}evil.example/dp/${ASIN}`, LINK_MESSAGES.otherSite],
    [`https://www.amazon.co.uk%2Eevil.example/dp/${ASIN}`, LINK_MESSAGES.notAnAddress],
    [`https://xn--www-amazon-co-uk.example/dp/${ASIN}`, LINK_MESSAGES.notAnAddress],
    [`https://xn--amazon-9ya.co.uk/dp/${ASIN}`, LINK_MESSAGES.otherSite],
    [`https://evil.example/https://www.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.otherSite],
    [`https://evil.example/?u=https://www.amazon.co.uk/dp/${ASIN}?tag=mysite-21`, LINK_MESSAGES.otherSite],
    [`https://203.0.113.9/dp/${ASIN}`, LINK_MESSAGES.otherSite],
    [`https://[2001:db8::1]/dp/${ASIN}`, LINK_MESSAGES.otherSite],
  ];
  for (const [link, reason] of cases) {
    const result = amazon.parseLink(link);
    assert.equal(result.ok, false, link);
    assert.equal(!result.ok && result.reason, reason, link);
  }
});

test('addresses with sign-in details, ports, other schemes, hidden characters or backslashes are refused', () => {
  const cases: readonly (readonly [string, string])[] = [
    [`https://user:pass@www.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.signIn],
    [`https://www.amazon.co.uk@evil.example/dp/${ASIN}`, LINK_MESSAGES.signIn],
    [`https://evil.example@www.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.signIn],
    [`https://www.amazon.co.uk%40evil.example/dp/${ASIN}`, LINK_MESSAGES.notAnAddress],
    [`https://www.amazon.co.uk:8443/dp/${ASIN}`, LINK_MESSAGES.port],
    [`https://www.amazon.co.uk:80/dp/${ASIN}`, LINK_MESSAGES.port],
    [`https://www.amazon.co.uk:/dp/${ASIN}`, LINK_MESSAGES.port],
    [`https://www.amazon.co.uk:0443/dp/${ASIN}`, LINK_MESSAGES.port],
    [`http://www.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.notSecure],
    [`www.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.notSecure],
    [`//www.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.notAnAddress],
    [`javascript:alert(1)//www.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.notAnAddress],
    [`data:text/html,<a href="https://www.amazon.co.uk/dp/${ASIN}">`, LINK_MESSAGES.notAnAddress],
    [`ftp://www.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.notAnAddress],
    [`https:/www.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.notAnAddress],
    [`https:www.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.notAnAddress],
    [`https://www.amazon.co.uk\\dp\\${ASIN}`, LINK_MESSAGES.notAnAddress],
    [`https://evil.example\\@www.amazon.co.uk/dp/${ASIN}`, LINK_MESSAGES.notAnAddress],
    [`https://www.amazon.co.uk/dp/${ASIN}\t?tag=x-21`, LINK_MESSAGES.notAnAddress],
    [`https://www.amaz\non.co.uk/dp/${ASIN}`, LINK_MESSAGES.notAnAddress],
    [`https://www.amazon.co.uk/dp/${ASIN} extra`, LINK_MESSAGES.notAnAddress],
    [`https://www.amazon.co.uk/dp/${ASIN}${ch(0x200b)}`, LINK_MESSAGES.notAnAddress],
    [`https://www.amazon.co.uk/dp/${ASIN}${ch(0x202e)}12-ti`, LINK_MESSAGES.notAnAddress],
    [`https://www.amazon.co.uk/dp/${ASIN}${ch(0xfeff)}?tag=mysite-21`, LINK_MESSAGES.notAnAddress],
    [`https://www.amazon.co.uk/dp/${ch(0x00a0)}${ASIN}`, LINK_MESSAGES.notAnAddress],
    [`https://www.amazon.co.uk/dp/${ASIN}${ch(0)}`, LINK_MESSAGES.notAnAddress],
    ['https://', LINK_MESSAGES.notAnAddress],
    ['amazon', LINK_MESSAGES.notAnAddress],
    ['', LINK_MESSAGES.empty],
    ['    ', LINK_MESSAGES.empty],
  ];
  for (const [link, reason] of cases) {
    const result = amazon.parseLink(link);
    assert.equal(result.ok, false, JSON.stringify(link));
    assert.equal(!result.ok && result.reason, reason, JSON.stringify(link));
  }
  for (const value of [null, undefined, 42, {}, [PAGE], Symbol('x')]) assert.deepEqual(amazon.parseLink(value), { ok: false, reason: LINK_MESSAGES.empty });
});

test('anything that is not one product page is refused', () => {
  for (const link of [
    'https://www.amazon.co.uk/',
    'https://www.amazon.co.uk/s?k=kettle&tag=mysite-21',
    'https://www.amazon.co.uk/b?node=391784011',
    'https://www.amazon.co.uk/stores/Anker/page/0D0B0',
    'https://www.amazon.co.uk/hz/wishlist/ls/2ABCDEF',
    'https://www.amazon.co.uk/gp/cart/view.html',
    'https://www.amazon.co.uk/shop/someone',
    'https://www.amazon.co.uk/dp/',
    'https://www.amazon.co.uk/dp/B08N5WRWN',
    'https://www.amazon.co.uk/dp/B08N5WRWNWX',
    'https://www.amazon.co.uk/dp/B08N5-RWNW',
    `https://www.amazon.co.uk/dp/${ASIN}/dp/B000000001`,
    `https://www.amazon.co.uk/dp/${ASIN}/B000000001`,
    `https://www.amazon.co.uk/dp/${ASIN}/something-else`,
    `https://www.amazon.co.uk/dp/%42${ASIN.slice(1)}`,
    `https://www.amazon.co.uk/dp/${ASIN}%2Fref=x`,
    `https://www.amazon.co.uk/dp%2F${ASIN}`,
    `https://www.amazon.co.uk//dp/${ASIN}`,
    `https://www.amazon.co.uk/x/y/dp/${ASIN}`,
    `https://www.amazon.co.uk/gp/offer-listing/${ASIN}`,
    `https://www.amazon.co.uk/product-reviews/${ASIN}`,
    `https://www.amazon.co.uk/exec/obidos/ASIN/${ASIN}`,
    `https://www.amazon.co.uk/dp/${ASIN}/ref=x/../../s`,
    `https://www.amazon.co.uk/s/../dp/${ASIN}`,
    `https://www.amazon.co.uk/./dp/${ASIN}`,
    `https://www.amazon.co.uk/s/%2e%2e/dp/${ASIN}`,
    `https://www.amazon.co.uk/Kettle.%2E/dp/${ASIN}`,
    `https://www.amazon.co.uk${'/a'.repeat(20)}/dp/${ASIN}`,
  ]) {
    const result = amazon.parseLink(link);
    assert.equal(result.ok, false, link);
    assert.equal(!result.ok && result.reason, LINK_MESSAGES.notProduct, link);
  }
});

test('very long and junk input never throws and is refused plainly', () => {
  const long = `${PAGE}?x=${'a'.repeat(5000)}&tag=mysite-21`;
  assert.deepEqual(amazon.parseLink(long), { ok: false, reason: LINK_MESSAGES.tooLong });
  assert.deepEqual(amazon.parseLink('h'.repeat(1_000_000)), { ok: false, reason: LINK_MESSAGES.tooLong });
  // Exactly at the limit still reads.
  const atLimit = `${PAGE}?x=${'a'.repeat(2048 - PAGE.length - 3)}`;
  assert.equal(atLimit.length, 2048);
  assert.equal(amazon.parseLink(atLimit).ok, true);
  const junk = ['%', '%%%', '?', '#', 'https://%', 'https://www.amazon.co.uk/%', 'https://www.amazon.co.uk/dp/%E0%A4%A',
    `https://www.amazon.co.uk/dp/${ASIN}?tag=%E0%A4%A-21`, ch(0xd800), `${PAGE}${ch(0xdfff)}`, 'https://' + 'a.'.repeat(500) + 'uk'];
  for (const value of junk) {
    const result = amazon.parseLink(value);
    assert.equal(result.ok, false, JSON.stringify(value).slice(0, 80));
    assert.ok(!result.ok && typeof result.reason === 'string');
  }
  for (let i = 0; i < 2000; i++) {
    let s = 'https://www.amazon.co.uk/';
    for (let j = 0; j < 40; j++) s += String.fromCharCode(32 + ((i * 7919 + j * 104729) % 95));
    assert.doesNotThrow(() => amazon.parseLink(s));
    assert.doesNotThrow(() => amazon.prepareLink(s, 'mysite-21'));
    assert.doesNotThrow(() => amazon.validateLink(s, 'mysite-21'));
  }
});

test('validateLink accepts only the canonical stored link (and the saved tracking ID when given)', () => {
  const good = `${PAGE}?tag=mysite-21`;
  assert.deepEqual(amazon.validateLink(good), { ok: true, url: good });
  assert.deepEqual(amazon.validateLink(good, 'mysite-21'), { ok: true, url: good });
  assert.deepEqual(amazon.validateLink(good, null), { ok: true, url: good });
  assert.deepEqual(amazon.validateLink(good, 'other-21'), { ok: false, reason: LINK_MESSAGES.trackingIdMismatch });
  for (const bad of [PAGE, `${good}&x=1`, `${good}#x`, `https://www.amazon.co.uk/dp/${ASIN.toLowerCase()}?tag=mysite-21`, `http://www.amazon.co.uk/dp/${ASIN}?tag=mysite-21`,
    `https://amazon.co.uk/dp/${ASIN}?tag=mysite-21`, `https://www.amazon.co.uk/Title/dp/${ASIN}?tag=mysite-21`, `https://www.amazon.co.uk/dp/${ASIN}/?tag=mysite-21`,
    `https://www.amazon.co.uk/dp/${ASIN}?tag=mysite-20`, ` ${good}`, `${good}\n`, '', null, 7]) {
    assert.deepEqual(amazon.validateLink(bad), { ok: false, reason: LINK_MESSAGES.storedNotCanonical }, String(bad));
  }
  // Whatever prepareLink builds, validateLink accepts.
  for (const shape of [PAGE, `https://www.amazon.co.uk/A-B/dp/${ASIN.toLowerCase()}/ref=x?th=1`, `https://www.amazon.co.uk/gp/product/${ASIN}`]) {
    const prepared = amazon.prepareLink(shape, 'my-site-2-21');
    assert.ok(prepared.ok);
    assert.deepEqual(amazon.validateLink(prepared.affiliateUrl, 'my-site-2-21'), { ok: true, url: prepared.affiliateUrl });
  }
});

test('tracking IDs the owner types', () => {
  assert.deepEqual(amazon.validateTrackingId('  mysite-21 '), { ok: true, trackingId: 'mysite-21' });
  assert.deepEqual(amazon.validateTrackingId('My-Site2-21'), { ok: true, trackingId: 'My-Site2-21' });
  for (const value of ['', '   ', null, 21]) assert.deepEqual(amazon.validateTrackingId(value), { ok: false, reason: LINK_MESSAGES.trackingIdEmpty });
  for (const value of ['mysite', 'mysite-20', '-21', 'my site-21', 'my_site-21', 'mysite-21-', '=cmd-21', 'a'.repeat(62) + '-21', `my${ch(0x0430)}-21`]) {
    assert.deepEqual(amazon.validateTrackingId(value), { ok: false, reason: LINK_MESSAGES.trackingIdInvalid }, value);
  }
});

test('the website that carries the links becomes its secure origin', () => {
  for (const [input, site] of [['www.example.co.uk', 'https://www.example.co.uk'], ['https://www.Example.co.uk/', 'https://www.example.co.uk'],
    ['https://blog.example.com/posts/1?x=y#z', 'https://blog.example.com'], [' example.org ', 'https://example.org'], ['HTTPS://EXAMPLE.ORG', 'https://example.org'],
    ['https://bücher.example', 'https://xn--bcher-kva.example']] as const) {
    assert.deepEqual(parseRegisteredSite(input), { ok: true, site }, input);
  }
  assert.deepEqual(parseRegisteredSite('http://example.com'), { ok: false, reason: SITE_MESSAGES.notSecure });
  assert.deepEqual(parseRegisteredSite(''), { ok: false, reason: SITE_MESSAGES.empty });
  for (const bad of ['localhost', 'https://203.0.113.4', 'https://user@example.com', 'https://example.com:8443', 'ftp://example.com', 'example', 'exa mple.com',
    'https://example.com\\@evil.example', 'https://-bad-.example', 'x'.repeat(400), 'https://example.123']) {
    assert.equal(parseRegisteredSite(bad).ok, false, bad);
  }
});
