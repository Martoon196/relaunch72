/** Pinned public numeric contract. No contact, attribution or private handoff API. */
export const PACKAGE_VERSION = 'mh196-packages-1.0.0';
export const MODEL_VERSION = 'mh196-planning-v1';
export const PACKAGE_ID = 'pp_affiliate_v1';
export const PRESETS = ['btl', 'brrr', 'bridging_refurb', 'land_development', 'conversion', 'development_exit'] as const;
export type Preset = typeof PRESETS[number];
export type NumericValue = string | number | boolean | null | { month: number; amount: string }[];
export interface Planning { schema_version: '1.0'; preset_id: Preset; inputs: Record<string, NumericValue> }
export interface ReviewPacket { v: 1; package_version: typeof PACKAGE_VERSION; model_version: typeof MODEL_VERSION; assumptions_as_of: string; planning: Planning }
export interface Field { kind: 'amount' | 'percent' | 'integer' | 'boolean' | 'select' | 'schedule'; max?: number; min?: number; nullable?: boolean; options?: readonly string[] }
const fields: Record<string, Field> = {};
for (const key of 'purchase_price loan_requested existing_debt works_cost contingency acquisition_costs professional_costs other_project_costs holding_costs_monthly lender_legal_valuation_costs monitoring_fee_per_draw borrower_broker_fee discharge_costs sale_fixed_costs refinance_costs refi_broker_fee monthly_rent monthly_operating_costs'.split(' ')) fields[key] = { kind: 'amount', max: 50_000_000 };
for (const key of ['current_value', 'exit_value']) fields[key] = { kind: 'amount', min: 0.01, max: 50_000_000 };
fields.facility_limit = { kind: 'amount', min: 0.01, max: 50_000_000, nullable: true };
for (const key of 'rate_pct day_one_ltv_pct works_funding_pct'.split(' ')) fields[key] = { kind: 'percent', max: 100 };
for (const key of ['ltgdv_cap_pct', 'ltc_cap_pct']) fields[key] = { kind: 'percent', max: 100, nullable: true };
for (const key of 'arrangement_fee_pct exit_fee_pct sale_cost_pct btl_stress_margin_pct btl_product_fee_pct'.split(' ')) fields[key] = { kind: 'percent', max: 10 };
fields.btl_ltv_pct = { kind: 'percent', max: 95 };
fields.btl_annual_rate_pct = { kind: 'percent', max: 25 };
fields.btl_stress_floor_pct = { kind: 'percent', min: 0.00001, max: 25 };
fields.btl_icr_pct = { kind: 'percent', min: 100, max: 300 };
for (const key of ['term_months', 'works_months']) fields[key] = { kind: 'integer', min: 1, max: 60 };
fields.minimum_interest_months = { kind: 'integer', max: 60 };
fields.draw_delay_months = { kind: 'integer', max: 6 };
fields.btl_fee_financed = { kind: 'boolean' }; fields.costs_confirmed = { kind: 'boolean' };
fields.rate_period = { kind: 'select', options: ['monthly', 'annual'] };
fields.interest_mode = { kind: 'select', options: ['serviced', 'retained', 'rolled_simple'] };
fields.ltv_basis = { kind: 'select', options: ['current_value', 'lower_purchase_value'] };
fields.exit_fee_basis = { kind: 'select', options: ['initial_advance', 'principal_drawn', 'facility', 'exit_value'] };
fields.exit_strategy = { kind: 'select', options: ['sale', 'refinance'] };
fields.works_schedule = { kind: 'schedule' };
export const FIELDS: Readonly<Record<string, Field>> = Object.freeze(fields);
export class FinanceError extends Error { constructor(public readonly status: number, message: string) { super(message); } }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FinanceError(400, 'Check the finance figures.');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new FinanceError(400, 'The finance fields do not match the supported version.');
}
/** Decimal comparisons use scaled integers, never floating point rounding. */
export function decimal(value: unknown, places = 5, signed = false): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new FinanceError(400, 'Enter a numeric finance figure.');
  const text = String(value).trim();
  if (!(signed ? /^-?\d{1,15}(?:\.\d{1,8})?$/ : /^\d{1,10}(?:\.\d{1,8})?$/).test(text)) throw new FinanceError(400, 'Enter a plain decimal figure without currency symbols.');
  const [whole = '', fraction = ''] = text.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length > places) throw new FinanceError(400, 'A finance figure has too many decimal places.');
  const normalized = whole.startsWith('-') && BigInt(whole) === 0n && trimmed ? '-0' : BigInt(whole).toString();
  return trimmed ? `${normalized}.${trimmed}` : normalized;
}
function scaled(value: string): bigint { const negative = value.startsWith('-'); const [whole = '0', fraction = ''] = value.replace('-', '').split('.'); return (negative ? -1n : 1n) * (BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'))); }
export function validDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new FinanceError(400, 'Use a valid assumptions date.');
  return value;
}
export function parsePlanning(value: unknown): Planning {
  const plan = object(value); exact(plan, ['schema_version', 'preset_id', 'inputs']);
  if (plan.schema_version !== '1.0' || !PRESETS.includes(plan.preset_id as Preset)) throw new FinanceError(400, 'Choose a supported finance model.');
  const raw = object(plan.inputs); exact(raw, Object.keys(FIELDS));
  const inputs: Record<string, NumericValue> = {};
  for (const [key, field] of Object.entries(FIELDS)) {
    const val = raw[key];
    if (field.nullable && val === null) { inputs[key] = null; continue; }
    if (field.kind === 'boolean') { if (typeof val !== 'boolean') throw new FinanceError(400, `Check ${key.replaceAll('_', ' ')}.`); inputs[key] = val; }
    else if (field.kind === 'select') { if (typeof val !== 'string' || !field.options!.includes(val)) throw new FinanceError(400, `Choose ${key.replaceAll('_', ' ')}.`); inputs[key] = val; }
    else if (field.kind === 'integer') { if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < (field.min ?? 0) || val > field.max!) throw new FinanceError(400, `Check ${key.replaceAll('_', ' ')}.`); inputs[key] = val; }
    else if (field.kind === 'schedule') {
      if (!Array.isArray(val) || val.length > 60) throw new FinanceError(400, 'Use at most 60 works entries.');
      inputs[key] = val.map(item => { const row = object(item); exact(row, ['month', 'amount']); const amount = decimal(row.amount, 2); if (typeof row.month !== 'number' || !Number.isInteger(row.month) || row.month < 1 || row.month > 60 || scaled(amount) <= 0n || scaled(amount) > scaled('50000000')) throw new FinanceError(400, 'Check the works schedule.'); return { month: row.month, amount }; });
    } else {
      const num = decimal(val, field.kind === 'amount' ? 2 : 5);
      if (scaled(num) < scaled(String(field.min ?? 0)) || scaled(num) > scaled(String(field.max))) throw new FinanceError(400, `Check ${key.replaceAll('_', ' ')}.`);
      inputs[key] = num;
    }
  }
  const num = (key: string) => scaled(inputs[key] as string);
  const term = inputs.term_months as number, worksMonths = inputs.works_months as number;
  const schedule = inputs.works_schedule as { month: number; amount: string }[];
  if (num('rate_pct') > scaled(inputs.rate_period === 'monthly' ? '5' : '60') || worksMonths > term) throw new FinanceError(400, 'Check the rate and works period against the loan term.');
  if (schedule.length && (new Set(schedule.map(row => row.month)).size !== schedule.length || schedule.some(row => row.month > term) || schedule.reduce((sum, row) => sum + scaled(row.amount), 0n) !== num('works_cost') + num('contingency'))) throw new FinanceError(400, 'Works entries must total works plus contingency, with one entry per month within the term.');
  if (num('works_cost') + num('contingency') > 0n && num('works_funding_pct') > 0n && Math.max(...schedule.map(row => row.month), schedule.length ? 0 : worksMonths) + (inputs.draw_delay_months as number) > term) throw new FinanceError(400, 'Works reimbursement must finish within the loan term.');
  if (inputs.ltv_basis === 'lower_purchase_value' && num('purchase_price') <= 0n) throw new FinanceError(400, 'Enter the purchase price for the selected value basis.');
  if (['land_development', 'conversion'].includes(plan.preset_id as string) && inputs.interest_mode !== 'rolled_simple') throw new FinanceError(400, 'This development model requires simple rolled interest.');
  if (plan.preset_id === 'brrr' && inputs.exit_strategy !== 'refinance') throw new FinanceError(400, 'BRRR requires a refinance exit.');
  if (plan.preset_id === 'btl' && (num('works_funding_pct') > 0n || schedule.length)) throw new FinanceError(400, 'The BTL model does not fund staged works.');
  return { schema_version: '1.0', preset_id: plan.preset_id as Preset, inputs };
}
export function packet(planning: Planning, date: string): ReviewPacket { return { v: 1, package_version: PACKAGE_VERSION, model_version: MODEL_VERSION, assumptions_as_of: validDate(date), planning: parsePlanning(planning) }; }
export interface Product { id: Preset; name: string; as_of: string; inputs: Planning['inputs'] }
export interface Catalog { products: Product[] }
export interface Illustration { results: Record<string, string | null>; schedule: Record<string, string | number>[]; borrower_fee: string; warnings: string[]; assumptions: string[] }
const RESULT_KEYS = new Set('product_fee required_monthly_rent requested_required_monthly_rent gross_initial_advance principal_drawn net_initial_advance total_interest total_finance_cost peak_cash_required redemption exit_net_proceeds exit_surplus project_profit cash_left_invested monthly_payment net_completion_cash requested_initial_advance initial_advance_shortfall requested_works_funding works_funding works_funding_shortfall funding_shortfall day_one_debt_cap gross_facility_cap peak_debt eligible_cost_budget binding_constraint arrangement_fee retained_interest minimum_interest_extra monitoring_costs exit_fee refinance_gross_debt refinance_product_fee refinance_monthly_payment monthly_rental_cash_flow rental_debt_capacity ltv_debt_capacity stress_rate_pct'.split(' '));
const SCHEDULE_KEYS = 'month works_spend drawdown interest serviced_interest rolled_interest debt_balance cash_before_draw cash_after_draw equity_required rental_cash_flow exit_net_proceeds redemption monitoring_cost'.split(' ');
const texts = (value: unknown): string[] => { if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || item.length > 8000 || /#handoff=/.test(item))) throw new FinanceError(502, 'The finance disclosures could not be verified.'); return value as string[]; };
export function validateIllustration(value: unknown, planning: Planning, date: string): Illustration {
  try {
    const answer = object(value); exact(answer, ['schema_version', 'package_version', 'model_version', 'package', 'planning', 'planning_only', 'currency', 'fees', 'warnings', 'assumptions']);
    const pkg = object(answer.package), returned = object(answer.planning), fees = object(answer.fees);
    exact(returned, ['schema_version', 'model_version', 'preset_id', 'planning_only', 'currency', 'preset_assumptions_as_of', 'inputs', 'results', 'schedule', 'warnings', 'assumptions']);
    if (answer.schema_version !== '1.0' || answer.package_version !== PACKAGE_VERSION || answer.model_version !== MODEL_VERSION || answer.planning_only !== true || answer.currency !== 'GBP' || pkg.id !== PACKAGE_ID || pkg.version !== PACKAGE_VERSION || returned.schema_version !== '1.0' || returned.model_version !== MODEL_VERSION || returned.planning_only !== true || returned.currency !== 'GBP' || returned.preset_assumptions_as_of !== date) throw Error();
    const actual = parsePlanning({ schema_version: returned.schema_version, preset_id: returned.preset_id, inputs: returned.inputs });
    const expected = parsePlanning(planning);
    for (const key of Object.keys(FIELDS)) if (key !== 'borrower_broker_fee' && JSON.stringify(expected.inputs[key]) !== JSON.stringify(actual.inputs[key])) throw Error();
    if (actual.preset_id !== expected.preset_id) throw Error();
    const raw = object(returned.results), results: Illustration['results'] = {};
    for (const key of ['gross_initial_advance', 'net_completion_cash', 'total_interest', 'total_finance_cost', 'peak_cash_required', 'funding_shortfall']) if (raw[key] == null) throw Error();
    for (const [key, item] of Object.entries(raw)) {
      if (!RESULT_KEYS.has(key)) throw Error();
      results[key] = key === 'binding_constraint' ? (item === null ? null : typeof item === 'string' && item.length <= 100 ? item : (() => { throw Error(); })()) : item === null ? null : decimal(item, 8, true);
    }
    if (!Array.isArray(returned.schedule) || returned.schedule.length < 1 || returned.schedule.length > 61) throw Error();
    const seen = new Set<number>();
    const schedule = returned.schedule.map(item => { const row = object(item); if (Object.keys(row).some(k => ![...SCHEDULE_KEYS, 'cash_after_exit'].includes(k)) || SCHEDULE_KEYS.some(k => !Object.hasOwn(row, k)) || typeof row.month !== 'number' || !Number.isInteger(row.month) || row.month < 0 || row.month > (planning.inputs.term_months as number) || seen.has(row.month)) throw Error(); seen.add(row.month); return Object.fromEntries(Object.entries(row).map(([key, val]) => [key, key === 'month' ? val as number : decimal(val, 8, true)])); });
    const borrowerFee = decimal(object(fees.borrower).gross, 2);
    if (fees.included_in_planning_total !== true || fees.payment_status !== 'illustration_only' || actual.inputs.borrower_broker_fee !== borrowerFee) throw Error();
    return { results, schedule, borrower_fee: borrowerFee, warnings: [...texts(answer.warnings), ...texts(returned.warnings)], assumptions: [...texts(answer.assumptions), ...texts(returned.assumptions)] };
  } catch { throw new FinanceError(502, 'The returned illustration did not match the reviewed figures or supported version. Nothing was saved.'); }
}
export interface PlanningClient { catalog(): Promise<Catalog>; calculate(planning: Planning, date: string): Promise<Illustration> }
export function createPlanningClient(fetcher: typeof fetch = fetch): PlanningClient {
  async function json(path: '/packages' | '/illustrate', body?: unknown): Promise<unknown> {
    try {
      const response = await fetcher(`https://mh196-finance.onrender.com/api/planning/v1${path}`, { method: body ? 'POST' : 'GET', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000) });
      if (!response.ok || !response.body) throw Error();
      const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 160000) throw Error(); chunks.push(next.value); } } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch { throw new FinanceError(502, 'Finance planning is temporarily unavailable. Your saved illustrations are still available.'); }
  }
  return {
    async catalog() {
      const data = object(await json('/packages'));
      if (data.package_version !== PACKAGE_VERSION || data.model_version !== MODEL_VERSION || !Array.isArray(data.packages) || !data.packages.some(p => object(p).id === PACKAGE_ID) || !Array.isArray(data.products)) throw new FinanceError(502, 'The finance catalogue version changed.');
      const products = data.products.map(item => { const p = object(item); const planning = parsePlanning({ schema_version: '1.0', preset_id: p.id, inputs: p.inputs }); return { id: planning.preset_id, name: typeof p.name === 'string' ? p.name.slice(0, 100) : planning.preset_id.replaceAll('_', ' '), as_of: validDate(p.as_of), inputs: planning.inputs }; });
      if (products.length !== PRESETS.length || new Set(products.map(p => p.id)).size !== PRESETS.length) throw new FinanceError(502, 'The finance catalogue is incomplete.');
      return { products };
    },
    async calculate(planning, date) { return validateIllustration(await json('/illustrate', { schema_version: '1.0', package_id: PACKAGE_ID, package_version: PACKAGE_VERSION, planning: parsePlanning(planning) }), planning, validDate(date)); },
  };
}
