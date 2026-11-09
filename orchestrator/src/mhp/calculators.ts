/** Pure, versioned arithmetic shared by the member UI and server-side deal-file saves. */
export type MhpCalculatorId = 'brrr' | 'hmo' | 'sa' | 'auction' | 'residual';
export type MhpMetricFormat = 'gbp' | 'percent' | 'number' | 'months';
export interface MhpCalculatorField {
  key: string; label: string; unit: string; group: string; kind: 'number' | 'select'; required: boolean;
  min?: number; max?: number; step?: string; integer?: boolean;
  options?: readonly { value: string; label: string }[]; help?: string;
}
export interface MhpCalculatorMetric { key: string; label: string; format: MhpMetricFormat; help?: string }
export interface MhpCalculatorSource { repository: string; commit: string; path: string }
export interface MhpCalculatorDefinition {
  id: MhpCalculatorId; title: string; summary: string; version: string; source: MhpCalculatorSource;
  fields: readonly MhpCalculatorField[]; metrics: readonly MhpCalculatorMetric[]; notes: readonly string[];
}
export interface MhpCalculation {
  calculator: MhpCalculatorId; version: string; source: MhpCalculatorSource;
  inputs: Record<string, number | string | null>; results: Record<string, number | boolean | null>;
  status: string; notes: string[];
}
export class MhpCalculatorInputError extends Error {
  constructor(readonly field: string, message: string) { super(message); this.name = 'MhpCalculatorInputError'; }
}

const VERSION = 'mhp-2026-10-28.1';
const PP = { repository: 'Martoon196/propertypredator', commit: '20834b6861d8b6d0bdad1139d27dfd14c2b6749a' };
const KPUK = { repository: 'Martoon196/kpuk-deal-portal', commit: '0526f9f07992f18cd0719b4d47051cae0b2fda89' };
const money = (key: string, label: string, group: string, help?: string): MhpCalculatorField =>
  ({ key, label, group, unit: 'GBP', kind: 'number', required: true, min: 0, max: 1e12, step: '0.01', help });
const percentage = (key: string, label: string, group: string, help?: string): MhpCalculatorField =>
  ({ key, label, group, unit: '%', kind: 'number', required: true, min: 0, max: 100, step: '0.01', help });
const metric = (key: string, label: string, format: MhpMetricFormat = 'gbp', help?: string): MhpCalculatorMetric =>
  ({ key, label, format, help });
const acquisitionFields = [
  money('manual_tax_allowance', 'Acquisition tax allowance', 'Purchase costs', 'Enter your own allowance. This calculator does not calculate tax.'),
  money('legal_fees', 'Legal fees', 'Purchase costs'),
  money('sourcing_fee', 'Sourcing fee', 'Purchase costs'),
];
const developmentFields = [
  ...acquisitionFields,
  money('auction_fees', 'Fixed auction fees', 'Purchase costs', 'Exclude the percentage buyer’s premium entered separately.'),
  money('planning_costs', 'Planning costs', 'Project costs', 'Count planning costs here once; exclude them from professional fees.'),
  money('construction_costs', 'Construction / works', 'Project costs'),
  money('professional_fees', 'Professional fees', 'Project costs'),
  money('building_control', 'Building control', 'Project costs'),
  money('warranty', 'Warranty', 'Project costs'),
  money('utility_connections', 'Utility connections', 'Project costs'),
  money('cil', 'CIL allowance', 'Project costs', 'Enter a supplied cost allowance; no liability is calculated.'),
  money('s106', 'Section 106 allowance', 'Project costs', 'Enter a supplied cost allowance; no liability is calculated.'),
  money('finance_costs', 'Total finance costs', 'Project costs'),
  money('contingency', 'Contingency allowance', 'Project costs'),
  money('selling_costs', 'Selling costs', 'Project costs'),
];

export const MHP_CALCULATORS: readonly MhpCalculatorDefinition[] = [
  {
    id: 'brrr', title: 'BRRR money-out', version: VERSION, source: { ...KPUK, path: 'src/calc.js#L187-L220' },
    summary: 'Compare money invested, refinance proceeds and cashflow using your own costs and lending assumptions.',
    fields: [
      { ...money('purchase_price', 'Purchase price', 'Property'), min: 0.01 },
      { ...money('end_value', 'Value after works', 'Property'), min: 0.01 },
      money('refurb_cost', 'Refurbishment cost', 'Property'),
      { ...money('rent_pcm', 'Monthly rent', 'Income'), unit: 'GBP / month' },
      ...acquisitionFields, money('other_buying_costs', 'Other purchase costs', 'Purchase costs'),
      percentage('deposit_pct', 'Initial deposit', 'Finance', 'Percentage of the purchase price, used for the initial mortgaged-cash comparison.'),
      percentage('refi_ltv_pct', 'Refinance loan to value', 'Finance'),
      money('refi_costs', 'Refinance fees', 'Finance'),
      percentage('mortgage_rate_pct', 'Annual mortgage interest rate', 'Finance', 'Interest-only cost on the refinance loan; not a repayment-mortgage quote.'),
      { ...percentage('stress_rate_pct', 'Lender stress interest rate', 'Finance'), min: 0.01 },
      { key: 'icr', label: 'Interest cover ratio', group: 'Finance', unit: 'ratio', kind: 'number', required: true, min: 0.01, max: 100, step: '0.01', help: 'Use a ratio: 1.25 means rent cover of 125%.' },
      percentage('management_pct', 'Letting management allowance', 'Running costs'),
      { ...money('management_pcm', 'Monthly management override', 'Running costs', 'Optional: leave blank to use the percentage allowance. Zero means no management cost.'), required: false, unit: 'GBP / month' },
      percentage('voids_maintenance_pct', 'Voids and maintenance allowance', 'Running costs'),
      { ...money('running_costs_pcm', 'Other running costs', 'Running costs'), unit: 'GBP / month' },
    ],
    metrics: [
      metric('money_left_in', 'Money left in after refinance'), metric('cashflow_pcm', 'Monthly cashflow'),
      metric('refinance_release', 'Gross refinance loan'), metric('total_in', 'Total cash purchase and works'),
      metric('cash_in_mortgaged', 'Initial cash with purchase mortgage'), metric('equity', 'Value less purchase and works costs'),
      metric('net_annual_return', 'Annual cashflow'), metric('roce_pct', 'Annual return on money left in', 'percent'),
      metric('months_to_recycle', 'Months to recover money left in', 'months'),
      metric('gross_yield_on_cost_pct', 'Gross rent yield on purchase and works', 'percent'),
      metric('gross_yield_on_value_pct', 'Gross rent yield on end value', 'percent'),
      metric('lender_max_loan', 'Loan limited by entered LTV and rent cover'),
      metric('money_left_in_stressed', 'Money left in using that loan limit'),
    ],
    notes: ['Refinance proceeds are a gross loan, not net cash after repaying an existing purchase loan.',
      'The cashflow model uses the requested LTV loan. The separate rent-cover result shows whether your entered stress assumptions imply a lower loan.',
      'Acquisition costs are supplied amounts. No tax calculation or lender offer is included.'],
  },
  {
    id: 'hmo', title: 'HMO room-rent', version: VERSION, source: { ...PP, path: 'frontend/pp-hmo.js#L14-L35' },
    summary: 'Build annual room income, operating costs and an income-based value from explicit assumptions.',
    fields: [
      { key: 'rooms', label: 'Lettable rooms', group: 'Income', unit: 'rooms', kind: 'number', required: true, min: 1, max: 10000, step: '1', integer: true },
      { ...money('room_rent_weekly', 'Rent per room', 'Income'), unit: 'GBP / room / week' },
      { ...money('bills_per_room_monthly', 'Bills per room', 'Running costs'), unit: 'GBP / room / month' },
      percentage('management_pct', 'Management allowance', 'Running costs'),
      percentage('voids_pct', 'Voids allowance', 'Running costs'),
      percentage('maintenance_pct', 'Maintenance allowance', 'Running costs'),
      { ...money('compliance_annual', 'Annual compliance costs', 'Running costs'), unit: 'GBP / year' },
      { ...money('insurance_annual', 'Annual insurance', 'Running costs'), unit: 'GBP / year' },
      { ...percentage('yield_pct', 'Valuation yield', 'Value'), min: 0.01 },
      { key: 'valuation_basis', label: 'Valuation income basis', group: 'Value', unit: '', kind: 'select', required: true, options: [
        { value: 'net', label: 'Net operating income' }, { value: 'gross', label: 'Gross income' },
      ], help: 'Use a yield that matches the selected net or gross income basis.' },
    ],
    metrics: [metric('annual_gross', 'Annual gross room income'), metric('annual_costs', 'Annual operating costs'),
      metric('annual_noi', 'Annual net operating income'), metric('monthly_before_finance', 'Monthly income before finance'),
      metric('income_value', 'Income-based value'), metric('annual_bills', 'Annual bills'),
      metric('annual_management', 'Annual management'), metric('annual_voids', 'Annual voids'), metric('annual_maintenance', 'Annual maintenance')],
    notes: ['Weekly rent uses 52 weeks per year. Bills use 12 months.',
      'Income-based value uses your selected income basis and yield. No mortgage, room-licensing or planning assessment is included.'],
  },
  {
    id: 'sa', title: 'Serviced accommodation', version: VERSION, source: { ...PP, path: 'frontend/sa.html#L179-L197' },
    summary: 'See monthly cashflow, occupancy needed to break even and recovery of your setup costs.',
    fields: [
      { key: 'deal_type', label: 'Property arrangement', group: 'Income', unit: '', kind: 'select', required: true, options: [
        { value: 'owner', label: 'I own the property' }, { value: 'r2sa', label: 'I rent the property' },
      ] },
      { ...money('adr', 'Average nightly rate', 'Income'), unit: 'GBP / occupied night' },
      percentage('occupancy_pct', 'Expected occupancy', 'Income'),
      { key: 'average_stay', label: 'Average stay', group: 'Income', unit: 'nights', kind: 'number', required: true, min: 0.01, max: 3650, step: '0.01' },
      percentage('platform_pct', 'Booking platform fee', 'Variable costs'), percentage('management_pct', 'Management fee', 'Variable costs'),
      { ...money('cleaning_per_stay', 'Cleaning cost per stay', 'Variable costs'), unit: 'GBP / stay' },
      { ...money('consumables_per_night', 'Consumables', 'Variable costs'), unit: 'GBP / occupied night' },
      ...['utilities', 'insurance', 'council_tax', 'subscriptions'].map((key) => ({ ...money(`${key}_pcm`, `${key.replaceAll('_', ' ')} per month`, 'Fixed costs'), unit: 'GBP / month' })),
      { ...money('rent_pcm', 'Monthly rent paid to landlord', 'Fixed costs', 'Used only when you rent the property. Enter zero for an owned property.'), unit: 'GBP / month' },
      { ...money('mortgage_pcm', 'Monthly mortgage cost', 'Fixed costs', 'Used only when you own the property. Enter zero for a rented property.'), unit: 'GBP / month' },
      money('furnishing', 'Furnishing and setup spend', 'Setup'),
      { key: 'deposit_months', label: 'Rental deposit', group: 'Setup', unit: 'months of rent', kind: 'number', required: true, min: 0, max: 120, step: '0.01', help: 'Used only for a rented property. Enter zero for an owned property.' },
    ],
    metrics: [metric('net_pcm', 'Monthly net cashflow'), metric('break_even_occupancy_pct', 'Occupancy needed to break even', 'percent'),
      metric('gross_pcm', 'Monthly gross income'), metric('variable_pcm', 'Monthly variable costs'), metric('fixed_pcm', 'Monthly fixed costs'),
      metric('net_annual', 'Annual net cashflow'), metric('occupied_nights', 'Occupied nights per model month', 'number'),
      metric('net_per_night', 'Contribution per occupied night'), metric('setup_total', 'Setup spend and rental deposit'),
      metric('payback_months', 'Setup payback', 'months'), metric('setup_roi_pct', 'Annual cashflow / setup total', 'percent')],
    notes: ['Uses 30.4 nights per month. Cleaning is charged per stay, not as a fixed monthly amount.',
      'An owned-property setup total excludes the purchase price and equity. Setup ROI is not a return on the total property investment.',
      'Occupancy is your assumption. These figures do not include a market-data lookup or a personal One Lane Verdict.'],
  },
  {
    id: 'auction', title: 'Auction maximum bid', version: VERSION, source: { ...PP, path: 'frontend/deal-analyser.html#L556-L569' },
    summary: 'Work backwards from the finished value and your chosen profit margin to a maximum hammer bid.',
    fields: [
      { ...money('gdv', 'Gross development / resale value', 'Target'), min: 0.01 },
      percentage('target_profit_on_gdv_pct', 'Target profit as a share of resale value', 'Target', '20 means profit equal to 20% of GDV, not 20% of costs.'),
      percentage('buyer_premium_pct', 'Buyer’s premium on hammer bid', 'Purchase costs'), ...developmentFields,
    ],
    metrics: [metric('max_hammer_bid', 'Maximum hammer bid'), metric('buyer_premium', 'Buyer’s premium at that bid'),
      metric('acquisition_allowance', 'Hammer, premium and purchase-cost allowance'), metric('other_costs', 'All fixed costs excluding hammer and premium'),
      metric('target_profit', 'Target profit'), metric('profit_at_max_bid', 'Profit at maximum bid')],
    notes: ['The target margin is profit divided by GDV. The residual-land calculator uses a different profit-on-cost basis.',
      'The maximum bid is rounded down to the penny. The supplied acquisition-tax allowance is fixed; it is not recalculated at a different bid.'],
  },
  {
    id: 'residual', title: 'Residual land value', version: VERSION, source: { ...PP, path: 'frontend/deal-analyser.html#L571-L579' },
    summary: 'Compare a proposed land price with the amount left after costs and your chosen profit-on-cost target.',
    fields: [
      { ...money('gdv', 'Gross development / resale value', 'Target'), min: 0.01 },
      money('land_price', 'Proposed land price', 'Target'),
      { ...percentage('target_profit_on_cost_pct', 'Target profit on total cost', 'Target', '20 means profit equal to 20% of total cost. Zero is a valid explicit target.'), max: 1000 },
      ...developmentFields.map(field => field.key === 'auction_fees' ? { ...field, help: 'Enter all auction fees as a fixed allowance for this land appraisal.' } : field),
    ],
    metrics: [metric('residual_land_value', 'Residual land value'), metric('gap_to_land_price', 'Residual less proposed land price'),
      metric('total_cost', 'Total cost at proposed land price'), metric('profit', 'Profit at proposed land price'),
      metric('profit_on_cost_pct', 'Profit on total cost', 'percent'), metric('profit_on_gdv_pct', 'Profit as a share of GDV', 'percent'),
      metric('non_land_costs', 'All costs excluding land price')],
    notes: ['Residual land value = GDV / (1 + target profit on cost) − non-land costs.',
      'Planning costs are included once. Acquisition tax and other obligations are supplied fixed allowances, not calculated liabilities.'],
  },
];

export function mhpCalculator(id: string): MhpCalculatorDefinition | undefined { return MHP_CALCULATORS.find(item => item.id === id); }

function normalize(definition: MhpCalculatorDefinition, value: unknown): MhpCalculation['inputs'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MhpCalculatorInputError('inputs', 'Enter the calculator inputs.');
  const raw = value as Record<string, unknown>;
  const allowed = new Set(definition.fields.map(field => field.key));
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new MhpCalculatorInputError(key, 'An unrecognised calculator field was supplied.');
  const result: MhpCalculation['inputs'] = {};
  for (const field of definition.fields) {
    const supplied = Object.hasOwn(raw, field.key) ? raw[field.key] : undefined;
    const text = typeof supplied === 'string' ? supplied.trim() : supplied;
    if (text === undefined || text === null || text === '') {
      if (field.required) throw new MhpCalculatorInputError(field.key, `Enter ${field.label.toLowerCase()}. Use zero when there is no cost.`);
      result[field.key] = null; continue;
    }
    if (field.kind === 'select') {
      if (typeof text !== 'string' || !field.options?.some(option => option.value === text)) throw new MhpCalculatorInputError(field.key, `Choose ${field.label.toLowerCase()}.`);
      result[field.key] = text; continue;
    }
    if ((typeof text !== 'number' && typeof text !== 'string') || (typeof text === 'string' && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)))
      throw new MhpCalculatorInputError(field.key, `${field.label} must be a number without currency symbols or commas.`);
    const number = Number(text);
    if (!Number.isFinite(number) || number < (field.min ?? 0) || number > (field.max ?? 1e12) || (field.integer && !Number.isInteger(number)))
      throw new MhpCalculatorInputError(field.key, `${field.label} must be ${field.integer ? 'a whole number' : 'a number'} between ${field.min ?? 0} and ${field.max ?? 1e12}.`);
    result[field.key] = Object.is(number, -0) ? 0 : number;
  }
  return result;
}

export function calculateMhpDeal(id: string, value: unknown): MhpCalculation {
  const definition = mhpCalculator(id);
  if (!definition) throw new MhpCalculatorInputError('calculator', 'Choose one of the five available calculators.');
  const inputs = normalize(definition, value);
  const n = (key: string): number => inputs[key] as number;
  const pct = (key: string): number => n(key) / 100;
  const results: MhpCalculation['results'] = {};
  const notes = [...definition.notes];
  let status = 'calculated';
  if (id === 'brrr') {
    const buying = n('manual_tax_allowance') + n('legal_fees') + n('sourcing_fee') + n('other_buying_costs');
    const total = n('purchase_price') + buying + n('refurb_cost');
    const loan = n('end_value') * pct('refi_ltv_pct');
    const left = total + n('refi_costs') - loan;
    const management = inputs.management_pcm === null ? n('rent_pcm') * pct('management_pct') : n('management_pcm');
    const voids = n('rent_pcm') * pct('voids_maintenance_pct');
    const netRent = n('rent_pcm') - management - voids - n('running_costs_pcm');
    const mortgage = loan * pct('mortgage_rate_pct') / 12;
    const cashflow = netRent - mortgage;
    const rentCoverLoan = n('rent_pcm') * 12 / (n('icr') * pct('stress_rate_pct'));
    const lenderLoan = Math.min(loan, rentCoverLoan);
    Object.assign(results, {
      buying_costs: buying, total_in: total, deposit: n('purchase_price') * pct('deposit_pct'),
      cash_in_mortgaged: n('purchase_price') * pct('deposit_pct') + buying + n('refurb_cost'),
      refinance_release: loan, money_left_in: left, equity: n('end_value') - total,
      management_pcm: management, voids_pcm: voids, net_monthly_rent: netRent, mortgage_pcm: mortgage,
      cashflow_pcm: cashflow, net_annual_return: cashflow * 12, all_money_out: left <= 0,
      roce_pct: left > 0 ? cashflow * 12 / left * 100 : null,
      months_to_recycle: left <= 0 ? 0 : cashflow > 0 ? left / cashflow : null,
      gross_annual_rent: n('rent_pcm') * 12,
      gross_yield_on_cost_pct: n('rent_pcm') * 12 / total * 100,
      gross_yield_on_value_pct: n('rent_pcm') * 12 / n('end_value') * 100,
      lender_loan_by_ltv: loan, lender_loan_by_icr: rentCoverLoan, lender_max_loan: lenderLoan,
      lender_rent_cover_binding: rentCoverLoan < loan, money_left_in_stressed: total + n('refi_costs') - lenderLoan,
    });
    if (left <= 0) { status = 'all_money_out'; notes.push('The model returns all invested cash. A percentage return on money left in is not defined.'); }
    if (cashflow <= 0) { if (status === 'calculated') status = 'no_positive_cashflow'; notes.push('The model has no positive monthly cashflow to recover remaining capital.'); }
  } else if (id === 'hmo') {
    const gross = n('rooms') * n('room_rent_weekly') * 52;
    const bills = n('rooms') * n('bills_per_room_monthly') * 12;
    const management = gross * pct('management_pct'), voids = gross * pct('voids_pct'), maintenance = gross * pct('maintenance_pct');
    const fixed = n('compliance_annual') + n('insurance_annual');
    const costs = bills + management + voids + maintenance + fixed, noi = gross - costs;
    const basis = inputs.valuation_basis === 'gross' ? gross : noi;
    Object.assign(results, { annual_gross: gross, annual_bills: bills, annual_management: management, annual_voids: voids,
      annual_maintenance: maintenance, annual_fixed: fixed, annual_costs: costs, annual_noi: noi,
      monthly_before_finance: noi / 12, income_value: basis > 0 ? basis / pct('yield_pct') : 0 });
    if (noi <= 0) { status = 'no_positive_operating_income'; notes.push('The entered operating costs use all of the room income or exceed it.'); }
  } else if (id === 'sa') {
    const rented = inputs.deal_type === 'r2sa';
    const rent = rented ? n('rent_pcm') : 0, mortgage = rented ? 0 : n('mortgage_pcm');
    const variablePerNight = n('adr') * (pct('platform_pct') + pct('management_pct')) + n('cleaning_per_stay') / n('average_stay') + n('consumables_per_night');
    const contribution = n('adr') - variablePerNight;
    const fixed = n('utilities_pcm') + n('insurance_pcm') + n('council_tax_pcm') + n('subscriptions_pcm') + rent + mortgage;
    const nights = 30.4 * pct('occupancy_pct'), gross = n('adr') * nights, variable = variablePerNight * nights, net = gross - variable - fixed;
    const breakeven = contribution > 0 ? fixed / contribution / 30.4 * 100 : contribution === 0 && fixed === 0 ? 0 : null;
    const impossible = breakeven === null || breakeven > 100;
    const deposit = rented ? rent * n('deposit_months') : 0, setup = n('furnishing') + deposit;
    Object.assign(results, { occupied_nights: nights, gross_pcm: gross, variable_pcm: variable, fixed_pcm: fixed, net_pcm: net,
      net_annual: net * 12, variable_per_night: variablePerNight, net_per_night: contribution,
      break_even_occupancy_pct: breakeven, cannot_break_even: impossible, rental_deposit: deposit, setup_total: setup,
      payback_months: net > 0 ? setup / net : null, setup_roi_pct: setup > 0 ? net * 12 / setup * 100 : null });
    if (impossible) { status = 'cannot_break_even'; notes.push('At the entered nightly rate and costs, even 100% occupancy cannot cover the modelled costs.'); }
    else if (net <= 0) { status = 'no_positive_cashflow'; notes.push('The entered occupancy does not produce positive monthly cashflow.'); }
  } else {
    const otherCosts = developmentFields.reduce((sum, field) => sum + n(field.key), 0);
    if (id === 'auction') {
      const target = n('gdv') * pct('target_profit_on_gdv_pct');
      const headroom = n('gdv') - target - otherCosts;
      const exactBid = headroom / (1 + pct('buyer_premium_pct'));
      const bid = Math.max(0, Math.floor(exactBid * 100) / 100), premium = bid * pct('buyer_premium_pct');
      const purchaseCosts = n('manual_tax_allowance') + n('legal_fees') + n('sourcing_fee') + n('auction_fees');
      Object.assign(results, { max_hammer_bid: bid, unrounded_hammer_bid: exactBid, buyer_premium: premium,
        acquisition_allowance: bid + premium + purchaseCosts, other_costs: otherCosts,
        target_profit: target, profit_at_max_bid: n('gdv') - otherCosts - bid - premium, no_affordable_bid: headroom < 0 });
      if (headroom < 0) { status = 'no_affordable_bid'; notes.push('Fixed costs and your target profit exceed GDV before any hammer bid. A zero bid does not meet the target.'); }
    } else {
      const total = n('land_price') + otherCosts, profit = n('gdv') - total;
      const residual = n('gdv') / (1 + pct('target_profit_on_cost_pct')) - otherCosts;
      Object.assign(results, { non_land_costs: otherCosts, total_cost: total, profit,
        profit_on_cost_pct: total > 0 ? profit / total * 100 : null, profit_on_gdv_pct: profit / n('gdv') * 100,
        residual_land_value: residual, gap_to_land_price: residual - n('land_price') });
      if (residual < 0) { status = 'negative_residual'; notes.push('The target leaves no positive residual for land at the entered costs and GDV.'); }
    }
  }
  for (const [key, result] of Object.entries(results)) {
    if (typeof result === 'number' && !Number.isFinite(result)) throw new MhpCalculatorInputError('inputs', 'These inputs produce a result outside the supported numeric range.');
    if (Object.is(result, -0)) results[key] = 0;
  }
  return { calculator: definition.id, version: definition.version, source: { ...definition.source }, inputs, results, status, notes };
}

export function formatMhpMetric(value: number | boolean | null | undefined, format: MhpMetricFormat): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not applicable';
  if (format === 'gbp') return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value);
  return format === 'percent' ? `${number}%` : format === 'months' ? `${number} months` : number;
}
