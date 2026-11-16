/**
 * The earnings reports one business uploads (migration 0158, app.affiliate_report_imports), behind the
 * r72_affiliate_definer report function only, on the content-command connection, with the owner's session exactly as
 * product-store.ts calls its functions. Adapted from the media branch's creative-studio/amazon-report-pg-store.ts
 * (52173b7): the function is renamed, the owner picks a month (stored as its first and last day), and the file is
 * read locally by amazon-tracking-report.ts before anything is sent. The figures are what Amazon reported in the file
 * the owner uploaded; nothing here allocates the "Others" row or works out per-article numbers.
 *
 * While the database still ends at 0157 every call answers NOT_OPENED_YET. Nothing imports this module yet except tests.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { readAmazonTrackingReport, type AmazonTrackingIdReport } from './amazon-tracking-report.js';
import { callAffiliateFunction, refused, type AffiliateOwner, type AffiliateResult } from './product-store.js';

export interface SavedReportSummary {
  readonly id: string;
  readonly programme: 'amazon_uk';
  readonly source: string;
  readonly reportStart: string;
  readonly reportEnd: string;
  readonly currency: 'GBP';
  readonly summary: Omit<AmazonTrackingIdReport, 'rows'>;
  readonly rowCount: number;
  readonly createdAt: string;
}
export interface SavedReport {
  readonly id: string;
  readonly programme: 'amazon_uk';
  readonly reportStart: string;
  readonly reportEnd: string;
  readonly currency: 'GBP';
  readonly payload: AmazonTrackingIdReport;
  readonly createdAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// The database keeps at most 512 KiB of figures per report (its own text form adds spaces), so stop well short of it.
const MAX_PAYLOAD_JSON = 440_000;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A month "YYYY-MM" (from 2000 to 2099) as its first and last day, or null. */
export function monthRange(month: unknown): { readonly start: string; readonly end: string } | null {
  if (typeof month !== 'string') return null;
  const match = /^(20[0-9]{2})-(0[1-9]|1[0-2])$/u.exec(month);
  if (!match) return null;
  const year = Number(match[1]), m = Number(match[2]);
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return Object.freeze({ start: `${match[1]}-${match[2]}-01`, end: `${match[1]}-${match[2]}-${String(last).padStart(2, '0')}` });
}

export const REPORT_STORE_MESSAGES = Object.freeze({
  month: 'Choose the month this report covers.',
  tooBig: 'This report has too much in it to keep. Download one month at a time from Amazon and try again.',
});

export class PgAffiliateReportStore {
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly owner: AffiliateOwner) {}

  async list(workspaceId: string): Promise<AffiliateResult<readonly SavedReportSummary[]>> {
    const result = await callAffiliateFunction<unknown>(this.pool, this.owner, 'affiliate_report_command', workspaceId, 'list', {});
    if (!result.ok) return result;
    const rows = Array.isArray(result.value) ? result.value.filter(record) : [];
    return { ok: true, value: Object.freeze(rows.map(r => Object.freeze({ id: String(r.id), programme: 'amazon_uk' as const, source: String(r.source),
      reportStart: String(r.reportStart), reportEnd: String(r.reportEnd), currency: 'GBP' as const, summary: r.summary as Omit<AmazonTrackingIdReport, 'rows'>,
      rowCount: Number(r.rowCount), createdAt: String(r.createdAt) }))) };
  }

  async get(workspaceId: string, id: string): Promise<AffiliateResult<SavedReport | null>> {
    if (!UUID.test(id)) return refused('invalid');
    const result = await callAffiliateFunction<unknown>(this.pool, this.owner, 'affiliate_report_command', workspaceId, 'get', { id });
    if (!result.ok) return result;
    const r = result.value;
    return { ok: true, value: record(r) ? Object.freeze({ id: String(r.id), programme: 'amazon_uk' as const, reportStart: String(r.reportStart),
      reportEnd: String(r.reportEnd), currency: 'GBP' as const, payload: r.payload as AmazonTrackingIdReport, createdAt: String(r.createdAt) }) : null };
  }

  /**
   * Reads the uploaded file and keeps Amazon's figures for the month chosen. The same file for the same month is kept
   * once: uploading it again answers the first report's id. A file that cannot be read is refused with a plain reason.
   */
  async save(input: { readonly workspaceId: string; readonly month: string; readonly originalText: string; readonly commandId?: string }):
    Promise<AffiliateResult<{ readonly replayed: boolean; readonly id: string }>> {
    const range = monthRange(input.month);
    if (!range) return refused('invalid', REPORT_STORE_MESSAGES.month);
    const reading = readAmazonTrackingReport(input.originalText);
    if (!reading.ok) return refused('report_unreadable', reading.reason);
    const id = input.commandId ?? randomUUID();
    if (!UUID.test(id)) return refused('invalid');
    const payload = reading.report;
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_JSON) return refused('report_unreadable', REPORT_STORE_MESSAGES.tooBig);
    const sourceSha = createHash('sha256').update(input.originalText, 'utf8').digest('hex');
    const result = await callAffiliateFunction<{ replayed: boolean; id: string }>(this.pool, this.owner, 'affiliate_report_command', input.workspaceId, 'save', {
      id, programme: 'amazon_uk', source: payload.source, sourceSha, reportStart: range.start, reportEnd: range.end, currency: payload.currency, payload,
    });
    if (!result.ok) return result;
    return { ok: true, value: Object.freeze({ replayed: result.value.replayed === true, id: String(result.value.id) }) };
  }
}
