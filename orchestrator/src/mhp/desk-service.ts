import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { MhpCommerceError } from './commerce-service.js';
import { calculateMhpDeal, mhpCalculator, type MhpCalculation } from './calculators.js';

export interface MhpDealFile {
  id: string; title: string; calculator: string; property: { address: string; notes: string };
  inputs: Record<string, number | string | null>; result: MhpCalculation; formulaVersion: string;
  archived: boolean; version: number; createdAt: string; updatedAt: string;
}
export interface MhpVerdict {
  id: string; status: string; answers: Record<string, string> | null; dueAt: string;
  submittedAt: string | null; response: string | null; reviewedAt: string | null; version: number;
}
export interface MhpDeskSnapshot {
  access: { calculators: boolean; crm: boolean; readOnly: boolean; isAdmin: boolean; deskWriteEndsAt: string | null };
  files: MhpDealFile[]; selected: MhpDealFile | null; lifetimeFileCount: number; fileLimit: number | null;
  verdict: MhpVerdict | null; canSubmitVerdict: boolean;
}
export interface MhpVerdictQueue { requests: (MhpVerdict & { memberName: string; memberEmail: string })[] }
export const VERDICT_FIELDS = [
  { key: 'experience', label: 'Your property experience', help: 'What have you tried so far, and what felt easy or difficult?', maximum: 2000 },
  { key: 'budget', label: 'Budget you can put to work', help: 'Share a rough amount and any funding constraints. Do not include account details.', maximum: 1000 },
  { key: 'weeklyTime', label: 'Time available each week', help: 'How many hours can you realistically give this?', maximum: 1000 },
  { key: 'areas', label: 'Areas you want to work in', help: 'Where do you know the market, or where would you consider investing?', maximum: 2000 },
  { key: 'goals', label: 'What you want property to do for you', help: 'Tell Martin your goals and the timescale you have in mind.', maximum: 3000 },
  { key: 'questions', label: 'Questions for Martin', help: 'What would help you choose your next step?', maximum: 3000 },
] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (token: string): Buffer => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new MhpCommerceError(403, 'Sign in to Martin Howard Property again.');
  return createHash('sha256').update(token).digest();
};
function id(value: string): string {
  if (!uuid.test(value)) throw new MhpCommerceError(400, 'Refresh this page before continuing.');
  return value;
}
function version(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new MhpCommerceError(400, 'Reload the saved file before continuing.');
  return Number(value);
}
function bounded(value: string, label: string, maximum: number, required = false): string {
  const text = value.trim();
  if ((required && !text) || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new MhpCommerceError(400, `Check ${label.toLowerCase()} (${maximum} characters maximum).`);
  }
  return text;
}
function failure(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new MhpCommerceError(403, 'Your access does not allow this action. Your saved records remain available where your membership allows.');
  if (code === '22023') throw new MhpCommerceError(400, 'Check the details and try again.');
  if (code === 'P0002') throw new MhpCommerceError(404, 'This record is not available in your workspace.');
  if (code === '54000') throw new MhpCommerceError(409, 'You have used your three lifetime deal files. Update an existing file or open your course access to add more. Archiving does not free a slot.');
  if (code === '40001' || code === '23505') throw new MhpCommerceError(409, 'This record changed or your three-file allowance has been reached. Reload Your Desk before trying again.');
  throw new MhpCommerceError(503, 'Your Desk is temporarily unavailable. Please try again shortly.');
}

export class PgMhpDeskService {
  constructor(private readonly readPool: Pick<Pool, 'query'>, private readonly commandPool: Pick<Pool, 'query'>) {}
  async snapshot(token: string, fileId?: string): Promise<MhpDeskSnapshot> {
    try {
      const result = await this.readPool.query<{ snapshot: MhpDeskSnapshot }>('SELECT app_private.mhp_desk_snapshot($1,$2) AS snapshot', [hash(token), fileId ? id(fileId) : null]);
      const snapshot = result.rows[0]?.snapshot;
      if (!snapshot || !Array.isArray(snapshot.files) || typeof snapshot.access?.calculators !== 'boolean') throw new MhpCommerceError(503, 'Your Desk could not load.');
      return snapshot;
    } catch (error) { failure(error); }
  }
  async save(token: string, form: Record<string, string>): Promise<string> {
    const calculator = mhpCalculator(form.calculator ?? '');
    if (!calculator) throw new MhpCommerceError(400, 'Choose one of the five calculators.');
    const inputs = Object.fromEntries(calculator.fields.map(field => [field.key, form[`input_${field.key}`] ?? '']));
    // Never accept posted totals: every save uses this server's versioned engine.
    const calculation = calculateMhpDeal(calculator.id, inputs);
    const title = bounded(form.title ?? '', 'File name', 120, true);
    const property = { address: bounded(form.address ?? '', 'Property address', 500), notes: bounded(form.notes ?? '', 'Deal notes', 4000) };
    try {
      const result = await this.commandPool.query<{ id: string }>(
        'SELECT app_private.mhp_save_deal_file($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS id',
        [hash(token), id(form.commandId ?? ''), form.fileId ? id(form.fileId) : null, form.fileId ? version(form.version ?? '') : null,
          title, property, calculator.id, calculation.inputs, calculation, calculation.version]);
      return id(result.rows[0]?.id ?? '');
    } catch (error) { failure(error); }
  }
  async archive(token: string, form: Record<string, string>): Promise<string> {
    if (!['true', 'false'].includes(form.archived ?? '')) throw new MhpCommerceError(400, 'Choose archive or restore.');
    try {
      const result = await this.commandPool.query<{ id: string }>('SELECT app_private.mhp_archive_deal_file($1,$2,$3,$4,$5) AS id',
        [hash(token), id(form.commandId ?? ''), id(form.fileId ?? ''), version(form.version ?? ''), form.archived === 'true']);
      return id(result.rows[0]?.id ?? '');
    } catch (error) { failure(error); }
  }
  async submitVerdict(token: string, form: Record<string, string>): Promise<string> {
    if (form.confirm !== 'yes') throw new MhpCommerceError(400, 'Confirm that your answers are ready for Martin.');
    const answers = Object.fromEntries(VERDICT_FIELDS.map(field => [field.key, bounded(form[field.key] ?? '', field.label, field.maximum, field.key !== 'questions')]));
    try {
      const result = await this.commandPool.query<{ id: string }>('SELECT app_private.mhp_submit_verdict($1,$2,$3) AS id', [hash(token), id(form.commandId ?? ''), answers]);
      return id(result.rows[0]?.id ?? '');
    } catch (error) { failure(error); }
  }
  async queue(token: string): Promise<MhpVerdictQueue> {
    try {
      const result = await this.readPool.query<{ queue: MhpVerdictQueue }>('SELECT app_private.mhp_verdict_queue($1) AS queue', [hash(token)]);
      if (!Array.isArray(result.rows[0]?.queue?.requests)) throw new MhpCommerceError(503, 'The verdict queue could not load.');
      return result.rows[0].queue;
    } catch (error) { failure(error); }
  }
  async review(token: string, form: Record<string, string>): Promise<string> {
    const response = bounded(form.response ?? '', 'Your verdict', 8000, true);
    try {
      const result = await this.commandPool.query<{ id: string }>('SELECT app_private.mhp_review_verdict($1,$2,$3,$4,$5) AS id',
        [hash(token), id(form.commandId ?? ''), id(form.verdictId ?? ''), version(form.version ?? ''), response]);
      return id(result.rows[0]?.id ?? '');
    } catch (error) { failure(error); }
  }
}
