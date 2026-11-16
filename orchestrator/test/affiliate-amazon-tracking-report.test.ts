import test from 'node:test';
import assert from 'node:assert/strict';
import { AmazonReportError, REPORT_MESSAGES, decodeReportBytes, parseAmazonTrackingReport, readAmazonTrackingReport, readAmazonTrackingReportBytes }
  from '../src/affiliate/amazon-tracking-report.js';

const POUND = String.fromCharCode(0xa3), EM_DASH = String.fromCharCode(0x2014), BOM = String.fromCharCode(0xfeff);

// Ported from the media branch's test/amazon-tracking-report.test.ts (52173b7). The behaviour is unchanged; the
// messages are now plain English, so the expected wording follows them.
test('Amazon UK tab-delimited Tracking ID Summary differentiates real numbers from suppressed cells', () => {
  const report = `${BOM}Tracking ID\tClicks\tOrdered Items\tShipped Items\tEarnings\n`
    + `survival-21\t100\t3\t2\t${POUND}17.25\n`
    + 'property-21\t-\t-\t-\t-\n'
    + `Others\t20\t3\t2\t${POUND}5.75\n`
    + `Total\t120\t6\t4\t${POUND}23.00\n`;
  const result = parseAmazonTrackingReport(report);
  assert.equal(result.source, 'user_uploaded_amazon_tracking_id_summary');
  assert.equal(result.rows.length, 3); // total is excluded to avoid double-count
  assert.equal(result.knownEarningsMinor, 2300);
  assert.equal(result.unallocatedEarningsMinor, 575);
  assert.equal(result.unknownEarningsRows, 1);
  assert.equal(result.clicksUnknownRows, 1);
  assert.equal(result.clicksKnown, 120);
  assert.equal(result.rows[1]?.earningsMinor, null, 'Hidden is unknown, not zero');
  assert.equal(result.rows[2]?.isOther, true);
});
test('accepts legitimate quoted CSV with separators and negative refunds', () => {
  const r = parseAmazonTrackingReport(`Tracking ID,Product Link Clicks,Earnings\n"my,shop",12,"${POUND}1,234.05"\nothers,9,(${POUND}5.25)\n`);
  assert.equal(r.rows[0]?.trackingId, 'my,shop');
  assert.equal(r.knownEarningsMinor, 122880);
  assert.equal(r.unallocatedEarningsMinor, -525);
});
test('rejects unsupported report type, foreign currency and malformed monetary figures', () => {
  assert.throws(() => parseAmazonTrackingReport(`Order ID,ASIN,Earnings\n111,222,${POUND}5.00\n`), /Tracking ID Summary/);
  assert.throws(() => parseAmazonTrackingReport('Tracking ID,Earnings\nabc,$5.00\n'), new RegExp(REPORT_MESSAGES.foreignCurrency.slice(0, 30)));
  assert.throws(() => parseAmazonTrackingReport(`Tracking ID,Earnings\nabc,${POUND}5.001\n`), (e: unknown) => e instanceof AmazonReportError && e.message === REPORT_MESSAGES.badAmount);
  assert.throws(() => parseAmazonTrackingReport('Tracking ID,Earnings\nabc,garbage\n'), AmazonReportError);
});
test('suppressed-only report never fabricates income, commissions or click-to-sale attribution', () => {
  const r = parseAmazonTrackingReport(`Tracking ID\tEarnings\nshop-21\t${EM_DASH}\nOthers\t-\n`);
  assert.equal(r.knownEarningsMinor, 0);
  assert.equal(r.unknownEarningsRows, 2);
  assert.equal(r.rows[0]?.earningsMinor, null);
  assert.equal('orders' in r, false);
  assert.match(r.warning, /Unknown cells are not zero/);
});
test('report sizes are bounded and no HTML/markup tracking IDs accepted', () => {
  assert.throws(() => parseAmazonTrackingReport(`Tracking ID,Earnings\n<script>,${POUND}5.00\n`), (e: unknown) => e instanceof Error && e.message === REPORT_MESSAGES.badTrackingId);
  assert.throws(() => parseAmazonTrackingReport('x'.repeat(2_100_000)), (e: unknown) => e instanceof Error && e.message === REPORT_MESSAGES.size);
});

// Added here.
const ok = (text: string) => {
  const reading = readAmazonTrackingReport(text);
  assert.ok(reading.ok, !reading.ok ? reading.reason : '');
  return reading.report;
};
const refused = (text: unknown, reason: string) => assert.deepEqual(readAmazonTrackingReport(text), { ok: false, reason }, JSON.stringify(text).slice(0, 80));

test('the Others row is kept as reported and never becomes any tracking ID, wherever it sits', () => {
  const r = ok(`Tracking ID\tClicks\tEarnings\nOthers\t5\t${POUND}2.00\nmysite-21\t10\t${POUND}3.00\nUnattributed\t1\t${POUND}0.50\n`);
  assert.deepEqual(r.rows.map(x => [x.trackingId, x.isOther]), [['Others', true], ['mysite-21', false], ['Unattributed', true]]);
  assert.equal(r.unallocatedEarningsMinor, 250);
  assert.equal(r.rows.find(x => x.trackingId === 'mysite-21')!.earningsMinor, 300, 'the Others figures are not added to the tracking ID');
  assert.equal(r.hasUnallocatedEarnings, true);
});

test('title lines above the header, totals in any spelling, blank lines and CRLF are all handled', () => {
  const r = ok(`Tracking ID Summary Report\r\nFrom 01/10/2026 to 31/10/2026\r\n\r\nTracking ID,Clicks,Ordered Items,Items Shipped,Earnings\r\nmysite-21,412,9,8,${POUND}23.40\r\nGrand Total,412,9,8,${POUND}23.40\r\nTOTALS,412,9,8,${POUND}23.40\r\n`);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0], { trackingId: 'mysite-21', clicks: 412, orderedItems: 9, shippedItems: 8, earningsMinor: 2340, isOther: false });
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.rows) && Object.isFrozen(r.rows[0]));
  const cr = ok(`Tracking ID\tEarnings\rmysite-21\t${POUND}1.00\r`);
  assert.equal(cr.knownEarningsMinor, 100);
});

test('missing optional columns stay unknown (null), never zero', () => {
  const r = ok(`Tracking ID,Earnings\nmysite-21,${POUND}1.00\n`);
  assert.deepEqual(r.rows[0], { trackingId: 'mysite-21', clicks: null, orderedItems: null, shippedItems: null, earningsMinor: 100, isOther: false });
  assert.equal(r.clicksUnknownRows, 1);
  const hidden = ok(`Tracking ID,Clicks,Earnings\nmysite-21,n/a,Hidden\nb-21,Not Available,suppressed\n`);
  assert.deepEqual(hidden.rows.map(x => [x.clicks, x.earningsMinor]), [[null, null], [null, null]]);
  assert.equal(hidden.knownEarningsMinor, 0);
});

test('formula-looking cells are refused as tracking IDs and never parsed as numbers', () => {
  for (const id of ['=cmd|\' /C calc\'!A0', '+1+1', '-2+3', '@SUM(1+1)', '=HYPERLINK("https://evil.example")', '|calc', '%0A']) {
    refused(`Tracking ID,Earnings\n"${id.replace(/"/g, '""')}",${POUND}1.00\n`, REPORT_MESSAGES.badTrackingId);
  }
  refused(`Tracking ID,Clicks,Earnings\nmysite-21,=1+1,${POUND}1.00\n`, REPORT_MESSAGES.badCount);
  refused('Tracking ID,Earnings\nmysite-21,=SUM(A1:A9)\n', REPORT_MESSAGES.badAmount);
  refused(`Tracking ID,Earnings\nmy\u0007site-21,${POUND}1.00\n`, REPORT_MESSAGES.badTrackingId);
  refused(`Tracking ID,Earnings\n${'a'.repeat(121)},${POUND}1.00\n`, REPORT_MESSAGES.badTrackingId);
});

test('huge numbers are refused, never rounded', () => {
  refused(`Tracking ID,Clicks,Earnings\nmysite-21,1000000001,${POUND}1.00\n`, REPORT_MESSAGES.countTooLarge);
  refused(`Tracking ID,Clicks,Earnings\nmysite-21,99999999999999999999999,${POUND}1.00\n`, REPORT_MESSAGES.countTooLarge);
  refused(`Tracking ID,Clicks,Earnings\nmysite-21,1e9,${POUND}1.00\n`, REPORT_MESSAGES.badCount);
  refused(`Tracking ID,Clicks,Earnings\nmysite-21,-5,${POUND}1.00\n`, REPORT_MESSAGES.badCount);
  refused(`Tracking ID,Clicks,Earnings\nmysite-21,1.5,${POUND}1.00\n`, REPORT_MESSAGES.badCount);
  refused(`Tracking ID,Earnings\nmysite-21,${POUND}${'9'.repeat(30)}.00\n`, REPORT_MESSAGES.amountTooLarge);
  refused(`Tracking ID,Earnings\nmysite-21,${POUND}90000000000000.01\n`, REPORT_MESSAGES.amountTooLarge);
  refused('Tracking ID,Earnings\nmysite-21,Infinity\n', REPORT_MESSAGES.badAmount);
  refused('Tracking ID,Earnings\nmysite-21,NaN\n', REPORT_MESSAGES.badAmount);
  refused('Tracking ID,Earnings\nmysite-21,1e400\n', REPORT_MESSAGES.badAmount);
  refused('Tracking ID,Earnings\nmysite-21,0x10\n', REPORT_MESSAGES.badAmount);
  const big = ok(`Tracking ID,Clicks,Earnings\nmysite-21,"1,000,000,000","${POUND}9,999,999,999.99"\n`);
  assert.equal(big.rows[0]!.clicks, 1_000_000_000);
  assert.equal(big.rows[0]!.earningsMinor, 999_999_999_999);
  refused(`Tracking ID,Earnings\nmysite-21,€5.00\n`, REPORT_MESSAGES.foreignCurrency);
});

test('a file with no recognisable header, or nothing in it, is refused plainly', () => {
  refused('Date,Clicks,Earnings\n2026-10-01,5,1.00\n2026-10-02,5,1.00\n', REPORT_MESSAGES.notSummary);
  refused('Tracking ID,Clicks\nmysite-21,5\n', REPORT_MESSAGES.needsColumns);
  refused(`${'title line\n'.repeat(14)}Tracking ID,Earnings\nmysite-21,1.00\n`, REPORT_MESSAGES.notSummary);
  refused('Tracking ID,Earnings\n\n\n,,\n', REPORT_MESSAGES.noData);
  refused('Tracking ID,Earnings\nTotal,1.00\nSummary,1.00\n', REPORT_MESSAGES.noRows);
  refused('Tracking ID,Earnings\n"mysite-21,1.00\n', REPORT_MESSAGES.unclosedQuote);
  refused('short', REPORT_MESSAGES.size);
  refused('', REPORT_MESSAGES.size);
  refused('x'.repeat(2_000_001), REPORT_MESSAGES.size);
  refused(`${'\n'.repeat(10)}${'a,b\n'.repeat(3100)}`, REPORT_MESSAGES.tooManyLines);
  refused(`Tracking ID,Earnings\n${Array.from({ length: 2001 }, (_, i) => `id${i}-21,1.00`).join('\n')}\n`, REPORT_MESSAGES.tooManyIds);
});

test('junk never throws: any value, binary noise, wrong encodings', () => {
  for (const value of [null, undefined, 42, {}, [], Symbol('x'), Buffer.from('Tracking ID,Earnings\nx-21,1.00\n')]) {
    const reading = readAmazonTrackingReport(value);
    assert.equal(reading.ok, false);
  }
  let seed = 7;
  for (let i = 0; i < 300; i++) {
    let s = i % 2 ? 'Tracking ID,Clicks,Earnings\n' : '';
    for (let j = 0; j < 200; j++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; s += String.fromCharCode(seed % 0xd7ff); }
    assert.doesNotThrow(() => readAmazonTrackingReport(s));
    const bytes = new Uint8Array(400);
    for (let j = 0; j < bytes.length; j++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; bytes[j] = seed & 0xff; }
    assert.doesNotThrow(() => readAmazonTrackingReportBytes(bytes));
  }
  // A Windows-encoded file (the pound sign as one byte) is read; so are UTF-16 files with their mark.
  const text = `Tracking ID,Earnings\nmysite-21,${POUND}4.20\n`;
  const latin = Uint8Array.from([...text].map(c => c.charCodeAt(0)));
  const fromLatin = readAmazonTrackingReportBytes(latin);
  assert.ok(fromLatin.ok);
  assert.equal(fromLatin.report.knownEarningsMinor, 420);
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const fromLe = readAmazonTrackingReportBytes(le);
  assert.ok(fromLe.ok);
  assert.equal(fromLe.report.knownEarningsMinor, 420);
  const be = Buffer.from(text, 'utf16le').swap16();
  const fromBe = readAmazonTrackingReportBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  assert.ok(fromBe.ok);
  assert.equal(fromBe.report.knownEarningsMinor, 420);
  const utf8 = readAmazonTrackingReportBytes(Buffer.from(`${BOM}${text}`, 'utf8'));
  assert.ok(utf8.ok);
  // UTF-16 without its mark decodes as UTF-8 with a zero byte between letters; the zero bytes are dropped (as the
  // original parser does), so the same figures are read.
  const unmarked = readAmazonTrackingReportBytes(Buffer.from(text, 'utf16le'));
  assert.ok(unmarked.ok);
  assert.equal(unmarked.report.knownEarningsMinor, 420);
  // A broken UTF-16 file (odd length) is refused as unreadable letters.
  assert.deepEqual(decodeReportBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le'), Buffer.from([0x41])])), { ok: false, reason: REPORT_MESSAGES.encoding });
  assert.deepEqual(decodeReportBytes(new Uint8Array(3)), { ok: false, reason: REPORT_MESSAGES.size });
  assert.deepEqual(decodeReportBytes(new Uint8Array(2_000_001)), { ok: false, reason: REPORT_MESSAGES.size });
  assert.deepEqual(decodeReportBytes('not bytes' as never), { ok: false, reason: REPORT_MESSAGES.size });
  // A pound sign that arrived broken (decoded the wrong way) is refused, never read as some other amount.
  refused(`Tracking ID,Earnings\nmysite-21,�4.20\n`, REPORT_MESSAGES.badAmount);
  refused(`Tracking ID,Earnings\nmy�site-21,${POUND}4.20\n`, REPORT_MESSAGES.badTrackingId);
});

test('every message is plain English', () => {
  for (const [key, sentence] of Object.entries(REPORT_MESSAGES)) {
    assert.doesNotMatch(sentence, /\b(?:csv|tsv|utf|encoding|delimiter|parse|null|json|error|invalid|exception|row\b)/iu, key);
    assert.match(sentence, /^[A-Z].*\.$/u, key);
  }
});
