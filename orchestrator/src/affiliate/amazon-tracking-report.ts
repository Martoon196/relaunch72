/**
 * Reads an Amazon UK Associates "Tracking ID Summary" download the owner uploads (Affiliate Studio, slice 1). Ported
 * from the media branch's creative-studio/amazon-tracking-report.ts (52173b7) with its behaviour kept:
 *
 *   - tab- or comma-separated (Amazon's ".txt" downloads are often tab-separated), quoted cells honoured;
 *   - a cell Amazon leaves blank or hides ("-", "n/a", "hidden"...) stays null: unknown is never zero;
 *   - the "Others" row is kept as Amazon reported it and never given to any tracking ID;
 *   - total rows are skipped so nothing is counted twice;
 *   - 2 MB at most.
 *
 * Added here: parseAmazonTrackingReport still throws AmazonReportError (for the faithful API), and
 * readAmazonTrackingReport never throws on any input: it answers { ok, report } or { ok: false, reason } with a
 * plain-English reason. readAmazonTrackingReportBytes decodes an uploaded file first (UTF-8, UTF-16 with a byte-order
 * mark, or the Windows encoding spreadsheets save in). Cells that look like spreadsheet formulas ("=cmd", "+1", "@x")
 * are refused as tracking IDs, so an export of these rows can never carry one.
 *
 * These are the figures Amazon reported in the file the owner uploaded. Nothing here is checked with Amazon, and
 * nothing here turns them into per-article or per-product figures.
 */
export interface TrackingIdReportRow {
  readonly trackingId: string;
  readonly clicks: number | null;
  readonly orderedItems: number | null;
  readonly shippedItems: number | null;
  readonly earningsMinor: number | null;
  readonly isOther: boolean;
}
export interface AmazonTrackingIdReport {
  readonly source: 'user_uploaded_amazon_tracking_id_summary';
  readonly currency: 'GBP';
  readonly rows: readonly TrackingIdReportRow[];
  readonly knownEarningsMinor: number;
  readonly unallocatedEarningsMinor: number;
  readonly unknownEarningsRows: number;
  readonly clicksKnown: number;
  readonly clicksUnknownRows: number;
  readonly hasUnallocatedEarnings: boolean;
  readonly warning: string;
}
export class AmazonReportError extends Error {
  constructor(message: string) { super(message); this.name = 'AmazonReportError'; }
}
export type AmazonReportReading = { readonly ok: true; readonly report: AmazonTrackingIdReport } | { readonly ok: false; readonly reason: string };

export const MAX_REPORT_BYTES = 2_000_000;
export const REPORT_MESSAGES = Object.freeze({
  size: 'Choose the report file you downloaded from Amazon UK. It must not be empty or larger than 2 MB.',
  tooManyLines: 'This file has more than 3,000 lines. Download a shorter period from Amazon and try again.',
  unclosedQuote: 'This file looks damaged (a quotation mark is never closed). Download it from Amazon again.',
  noData: 'This file has no tracking ID figures in it.',
  notSummary: 'This is not a Tracking ID Summary report. In your Amazon UK Associates account, download the Tracking ID Summary and upload that file.',
  needsColumns: 'This report is missing its Tracking ID or Earnings column. Download the Tracking ID Summary from Amazon again.',
  tooManyIds: 'This report has too many tracking IDs to read at once. Download a shorter period from Amazon and try again.',
  badCount: 'One of the counts in this file is not a whole number we can read. Download the report from Amazon again.',
  countTooLarge: 'One of the counts in this file is too large to be right. Download the report from Amazon again.',
  foreignCurrency: 'This report has amounts in another currency. Upload an Amazon UK report, which is in pounds.',
  badAmount: 'One of the amounts in this file is not a sum in pounds and pence we can read. Download the report from Amazon again.',
  amountTooLarge: 'One of the amounts in this file is too large to be right. Download the report from Amazon again.',
  badTrackingId: 'One of the tracking IDs in this file is not one Amazon would make. Download the report from Amazon again.',
  noRows: 'This report has no tracking ID rows.',
  unreadable: 'We could not read this file. Download the Tracking ID Summary from Amazon again and upload it without changing it.',
  encoding: 'We could not read the letters in this file. Upload the file exactly as Amazon gave it to you.',
  extraCells: 'One of the rows in this file has more figures than there are column names, so we cannot tell which figure is which. This can happen when an amount is written with a comma, such as 1,50. Download the Tracking ID Summary from Amazon again and upload it without changing it.',
});

function normalise(s: string): string { return s.trim().toLowerCase().replace(/[\u00a0\s\-_./()]+/gu, ''); }
function parseDelimited(text: string, delimiter: string): string[][] {
  // `blank` says whether the cell so far is only spaces, so a quotation mark never re-reads a growing cell (that took
  // minutes on a small hostile file).
  const lines: string[][] = []; let row: string[] = [], cell = '', quoted = false, blank = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; blank = false; i++; continue; }
      if (ch === '"') { quoted = false; continue; }
      cell += ch; if (blank && !/\s/u.test(ch)) blank = false;
    } else {
      if (ch === '"' && blank) { quoted = true; cell = ''; continue; }
      if (ch === delimiter) { row.push(cell.trim()); cell = ''; blank = true; continue; }
      if (ch === '\n') { row.push(cell.trim()); cell = ''; blank = true; if (row.some(Boolean)) lines.push(row); row = []; continue; }
      if (ch === '\r') { if (text[i + 1] === '\n') continue; row.push(cell.trim()); cell = ''; blank = true; if (row.some(Boolean)) lines.push(row); row = []; continue; }
      cell += ch; if (blank && !/\s/u.test(ch)) blank = false;
    }
    if (lines.length > 3000) throw new AmazonReportError(REPORT_MESSAGES.tooManyLines);
  }
  if (quoted) throw new AmazonReportError(REPORT_MESSAGES.unclosedQuote);
  if (cell || row.length) { row.push(cell.trim()); if (row.some(Boolean)) lines.push(row); }
  return lines;
}
function chooseDelimiter(text: string): string {
  const first = (text.split(/\r?\n/u)[0] ?? '').slice(0, 2000);
  return (first.match(/\t/gu) ?? []).length > (first.match(/,/gu) ?? []).length ? '\t' : ',';
}
const isUnknown = (s: string): boolean => !s.trim() || /^(?:\u2014|\u2013|-|n\/a|hidden|suppressed|not available)$/iu.test(s.trim());
// A comma is only ever a thousands separator ("1,204", "1,234.56"); "1,50" or "1,2" is ambiguous and refused, never guessed (review S4).
const GROUPED = /^-?[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?$/u;
function numberCell(v: string): number | null {
  if (isUnknown(v)) return null;
  if (v.includes(',') && !GROUPED.test(v.trim())) throw new AmazonReportError(REPORT_MESSAGES.badCount);
  const value = v.replace(/,/gu, '').trim();
  if (!/^[0-9]{1,15}$/u.test(value)) throw new AmazonReportError(/^[0-9]+$/u.test(value) ? REPORT_MESSAGES.countTooLarge : REPORT_MESSAGES.badCount);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > 1_000_000_000) throw new AmazonReportError(REPORT_MESSAGES.countTooLarge);
  return n;
}
function poundsCell(v: string): number | null {
  if (isUnknown(v)) return null;
  let s = v.trim();
  const accounting = s.startsWith('(') && s.endsWith(')');
  if (accounting) s = s.slice(1, -1);
  if (/[$\u20ac]/u.test(s)) throw new AmazonReportError(REPORT_MESSAGES.foreignCurrency);
  // "(-1.50)" says minus twice: ambiguous, so refused rather than read as plus (review S4).
  if (accounting && /-/u.test(s)) throw new AmazonReportError(REPORT_MESSAGES.badAmount);
  s = s.replace(/[\u00a3\u00a0\s]/gu, '');
  if (s.includes(',') && !GROUPED.test(s)) throw new AmazonReportError(REPORT_MESSAGES.badAmount);
  s = s.replace(/,/gu, '');
  if (/^-?[0-9]{14,}(?:\.[0-9]{1,2})?$/u.test(s)) throw new AmazonReportError(REPORT_MESSAGES.amountTooLarge);
  if (!/^-?[0-9]+(?:\.[0-9]{1,2})?$/u.test(s)) throw new AmazonReportError(REPORT_MESSAGES.badAmount);
  if (accounting) s = '-' + s;
  const [whole, fraction = ''] = s.replace('-', '').split('.');
  const pennies = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(pennies) || pennies > 9_000_000_000_000) throw new AmazonReportError(REPORT_MESSAGES.amountTooLarge);
  return s.startsWith('-') ? -pennies : pennies;
}
function column(headers: string[], names: string[]): number {
  return headers.findIndex(h => names.includes(normalise(h)));
}
/**
 * A totals line in any spelling Amazon or a spreadsheet uses ("Total", "Totals:", "Grand Total:", "TOTAL (all IDs)",
 * "Total for period"), so nothing is counted twice (review S4). A tracking ID never has spaces, a colon or brackets,
 * so "total-21" is still a tracking ID.
 */
function isTotalRow(id: string): boolean {
  const k = id.toLowerCase().replace(/\([^)]*\)/gu, ' ').replace(/[:.\s]+$/u, '').replace(/\s+/gu, ' ').trim();
  return /^(?:grand )?(?:total|totals|sum|overall)(?: for (?:the )?(?:period|month|all))?$|^(?:all|all tracking ids|summary)$/u.test(k);
}

/** Amazon UK tracking IDs only, besides the Others row (review N6): letters, numbers and hyphens, ending in -21. */
const UK_TRACKING_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,60}-21$/u;
/** Why this report cannot be kept as an Amazon UK report (a row's tracking ID is not one Amazon UK makes), or null. */
export function reportTrackingIdProblem(report: Pick<AmazonTrackingIdReport, 'rows'>): string | null {
  return report.rows.some((r) => !r.isOther && !UK_TRACKING_ID.test(r.trackingId)) ? REPORT_MESSAGES.badTrackingId : null;
}

// A spreadsheet would run a cell starting with one of these as a formula.
const FORMULA_START = /^[=+\-@\t\r|%]/u;

export function parseAmazonTrackingReport(text: string): AmazonTrackingIdReport {
  if (typeof text !== 'string' || text.length < 15 || Buffer.byteLength(text, 'utf8') > MAX_REPORT_BYTES) throw new AmazonReportError(REPORT_MESSAGES.size);
  const clean = text.replace(/^\ufeff/u, '').replace(/\u0000/gu, '');
  const rows = parseDelimited(clean, chooseDelimiter(clean));
  if (rows.length < 2) throw new AmazonReportError(REPORT_MESSAGES.noData);
  // Some exported files put a title or date above the column names.
  const headerAt = rows.findIndex(r => r.some(c => ['trackingid', 'trackingids'].includes(normalise(c))));
  if (headerAt < 0 || headerAt > 12) throw new AmazonReportError(REPORT_MESSAGES.notSummary);
  const headers = rows[headerAt]!;
  const idColumn = column(headers, ['trackingid', 'trackingids']);
  const clicks = column(headers, ['clicks', 'productlinkclicks', 'linkclicks']);
  const ordered = column(headers, ['ordereditems', 'itemsordered', 'orders']);
  const shipped = column(headers, ['shippeditems', 'itemsshipped', 'dispatcheditems', 'itemsdispatched']);
  const earnings = column(headers, ['earnings', 'totalearnings', 'commissionincome', 'referralfees', 'advertisingfees', 'totaladvertisingfees']);
  if (idColumn < 0 || earnings < 0) throw new AmazonReportError(REPORT_MESSAGES.needsColumns);
  if (rows.length - headerAt - 1 > 2000) throw new AmazonReportError(REPORT_MESSAGES.tooManyIds);
  const output: TrackingIdReportRow[] = [];
  for (const r of rows.slice(headerAt + 1)) {
    // A row with more filled cells than the header has columns is never read by position (review S-c): "1,50" unquoted in
    // a comma file would otherwise be read as £1.00 with the 50 dropped. Empty cells at the end are harmless.
    if (r.length > headers.length && r.slice(headers.length).some(Boolean)) throw new AmazonReportError(REPORT_MESSAGES.extraCells);
    const id = (r[idColumn] ?? '').trim();
    if (!id) continue;
    if (isTotalRow(id)) continue; // never counted twice
    if (id.length > 120 || /[\u0000-\u001f\u007f<>\ufffd]/u.test(id) || FORMULA_START.test(id)) throw new AmazonReportError(REPORT_MESSAGES.badTrackingId);
    output.push(Object.freeze({
      trackingId: id,
      clicks: clicks < 0 ? null : numberCell(r[clicks] ?? ''),
      orderedItems: ordered < 0 ? null : numberCell(r[ordered] ?? ''),
      shippedItems: shipped < 0 ? null : numberCell(r[shipped] ?? ''),
      earningsMinor: poundsCell(r[earnings] ?? ''),
      isOther: /^(?:others?|unattributed|unallocated)$/iu.test(id),
    }));
  }
  if (!output.length) throw new AmazonReportError(REPORT_MESSAGES.noRows);
  const known = output.reduce((n, r) => n + (r.earningsMinor ?? 0), 0);
  const unallocated = output.filter(x => x.isOther).reduce((n, r) => n + (r.earningsMinor ?? 0), 0);
  const unknown = output.filter(x => x.earningsMinor === null).length;
  const clicksUnknown = output.filter(x => x.clicks === null).length;
  const clicksKnown = output.reduce((n, r) => n + (r.clicks ?? 0), 0);
  if (!Number.isSafeInteger(known) || !Number.isSafeInteger(clicksKnown)) throw new AmazonReportError(REPORT_MESSAGES.amountTooLarge);
  return Object.freeze({
    source: 'user_uploaded_amazon_tracking_id_summary' as const,
    currency: 'GBP' as const, rows: Object.freeze(output),
    knownEarningsMinor: known, unallocatedEarningsMinor: unallocated,
    unknownEarningsRows: unknown, clicksKnown, clicksUnknownRows: clicksUnknown,
    hasUnallocatedEarnings: output.some(x => x.isOther),
    warning: 'User-uploaded Amazon report. Unknown cells are not zero; Others cannot be allocated to a campaign or product. Report periods may not align with individual outbound clicks.',
  });
}

/** The same reading, never throwing: any input at all answers a report or a plain-English reason. */
export function readAmazonTrackingReport(text: unknown): AmazonReportReading {
  try {
    if (typeof text !== 'string') return { ok: false, reason: REPORT_MESSAGES.size };
    return { ok: true, report: parseAmazonTrackingReport(text) };
  } catch (error) {
    return { ok: false, reason: error instanceof AmazonReportError ? error.message : REPORT_MESSAGES.unreadable };
  }
}

/**
 * An uploaded file's bytes as text: UTF-16 (little or big endian) with its byte-order mark, UTF-8 (with or without a
 * mark), or else the Windows encoding spreadsheets save in (where the pound sign is one byte). Never throws.
 */
export function decodeReportBytes(bytes: Uint8Array): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 15 || bytes.byteLength > MAX_REPORT_BYTES) return { ok: false, reason: REPORT_MESSAGES.size };
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { ok: true, text: new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2)) };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { ok: true, text: new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2)) };
    try { return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; } catch { /* not UTF-8: try the Windows encoding */ }
    return { ok: true, text: new TextDecoder('windows-1252', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: REPORT_MESSAGES.encoding };
  }
}

/** An uploaded file, decoded and read. Never throws. */
export function readAmazonTrackingReportBytes(bytes: Uint8Array): AmazonReportReading {
  const decoded = decodeReportBytes(bytes);
  return decoded.ok ? readAmazonTrackingReport(decoded.text) : decoded;
}
