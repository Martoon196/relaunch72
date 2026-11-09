import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMhpDeal, formatMhpMetric, MHP_CALCULATORS, mhpCalculator, MhpCalculatorInputError } from '../src/mhp/calculators.js';

const brrr = {
  purchase_price: 95000, end_value: 140000, refurb_cost: 18000, rent_pcm: 750,
  manual_tax_allowance: 4750, legal_fees: 1500, sourcing_fee: 0, other_buying_costs: 0,
  deposit_pct: 25, refi_ltv_pct: 75, refi_costs: 0, mortgage_rate_pct: 5.25,
  stress_rate_pct: 5.5, icr: 1.25, management_pct: 12, management_pcm: '',
  voids_maintenance_pct: 0, running_costs_pcm: 0,
};
const hmo = {
  rooms: 6, room_rent_weekly: 125, bills_per_room_monthly: 75,
  management_pct: 10, voids_pct: 6, maintenance_pct: 8,
  compliance_annual: 800, insurance_annual: 450, yield_pct: 8, valuation_basis: 'net',
};
const sa = {
  deal_type: 'r2sa', adr: 100, occupancy_pct: 75, average_stay: 3, platform_pct: 15, management_pct: 10,
  cleaning_per_stay: 30, consumables_per_night: 5, utilities_pcm: 200, insurance_pcm: 50,
  council_tax_pcm: 150, subscriptions_pcm: 20, rent_pcm: 800, mortgage_pcm: 0, furnishing: 2500, deposit_months: 1,
};
const development = {
  gdv: 300000, manual_tax_allowance: 5000, legal_fees: 1500, sourcing_fee: 500,
  auction_fees: 1000, planning_costs: 12000, construction_costs: 40000, professional_fees: 5000,
  building_control: 1000, warranty: 1000, utility_connections: 2000, cil: 0, s106: 0,
  finance_costs: 3000, contingency: 5000, selling_costs: 3000,
};
const auction = { ...development, target_profit_on_gdv_pct: 20, buyer_premium_pct: 5 };
const residual = { ...development, land_price: 150000, target_profit_on_cost_pct: 20 };
function close(actual: number | boolean | null | undefined, expected: number, tolerance = 1e-8) {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs((actual as number) - expected) <= tolerance, `Expected ${actual} to be close to ${expected}`);
}
function invalid(id: string, inputs: unknown, field: string) {
  assert.throws(() => calculateMhpDeal(id, inputs), error => error instanceof MhpCalculatorInputError && error.field === field);
}

test('BRRR preserves the existing Stoke parity fixture with a supplied acquisition allowance', () => {
  // Source fixture f2a701280255477b9b0f9c0d3b716d4459b75b06: its precomputed tax amount is an input, never recalculated.
  const result = calculateMhpDeal('brrr', brrr);
  assert.equal(result.results.total_in, 119250);
  assert.equal(result.results.refinance_release, 105000);
  assert.equal(result.results.money_left_in, 14250);
  assert.equal(result.results.equity, 20750);
  assert.equal(result.results.cashflow_pcm, 200.625);
  close(result.results.roce_pct, 16.894736842105263);
  close(result.results.gross_yield_on_value_pct, 6.428571428571428);
  assert.equal(result.inputs.management_pcm, null);
});

test('BRRR keeps refinance, management override and running-cost amounts in their correct stages', () => {
  const result = calculateMhpDeal('brrr', { ...brrr, refi_costs: 2000, management_pcm: 40, running_costs_pcm: 30, voids_maintenance_pct: 5 });
  assert.equal(result.results.total_in, 119250);
  assert.equal(result.results.money_left_in, 16250);
  assert.equal(result.results.management_pcm, 40);
  assert.equal(result.results.voids_pcm, 37.5);
  assert.equal(result.results.cashflow_pcm, 183.125);
  assert.equal(result.results.cash_in_mortgaged, 48000);
  assert.equal(calculateMhpDeal('brrr', { ...brrr, management_pcm: 0 }).results.management_pcm, 0);
});

test('BRRR all-money-out state is JSON-safe and does not report a negative or infinite return ratio', () => {
  const result = calculateMhpDeal('brrr', { ...brrr, purchase_price: 80000, end_value: 160000, refurb_cost: 25000, rent_pcm: 900, manual_tax_allowance: 4000 });
  assert.equal(result.results.total_in, 110500);
  assert.equal(result.results.money_left_in, -9500);
  assert.equal(result.results.cashflow_pcm, 267);
  assert.equal(result.results.all_money_out, true);
  assert.equal(result.results.roce_pct, null);
  assert.equal(result.results.months_to_recycle, 0);
  assert.equal(result.status, 'all_money_out');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('BRRR rent-cover comparison is separate from the requested-LTV cashflow model', () => {
  const result = calculateMhpDeal('brrr', { ...brrr, rent_pcm: 500, stress_rate_pct: 10, icr: 1.5 });
  assert.equal(result.results.lender_rent_cover_binding, true);
  close(result.results.lender_max_loan, 40000);
  close(result.results.money_left_in_stressed, 79250);
  assert.equal(result.results.refinance_release, 105000);
  assert.equal(result.results.mortgage_pcm, 459.375);
  assert.equal(result.results.months_to_recycle, null);
  assert.equal(result.status, 'no_positive_cashflow');
});

test('HMO room income uses 52 weeks, bills use 12 months, and cost lines reconcile', () => {
  const result = calculateMhpDeal('hmo', hmo);
  assert.equal(result.results.annual_gross, 39000);
  assert.equal(result.results.annual_bills, 5400);
  assert.equal(result.results.annual_management, 3900);
  assert.equal(result.results.annual_voids, 2340);
  assert.equal(result.results.annual_maintenance, 3120);
  assert.equal(result.results.annual_fixed, 1250);
  assert.equal(result.results.annual_costs, 16010);
  assert.equal(result.results.annual_noi, 22990);
  close(result.results.monthly_before_finance, 1915.8333333333333);
  assert.equal(result.results.income_value, 287375);
  assert.equal(calculateMhpDeal('hmo', { ...hmo, valuation_basis: 'gross' }).results.income_value, 487500);
});

test('HMO rejects fractional rooms and zero yield instead of applying a hidden default', () => {
  invalid('hmo', { ...hmo, rooms: 6.5 }, 'rooms');
  invalid('hmo', { ...hmo, yield_pct: 0 }, 'yield_pct');
  invalid('hmo', { ...hmo, valuation_basis: 'commercial' }, 'valuation_basis');
  const loss = calculateMhpDeal('hmo', { ...hmo, bills_per_room_monthly: 1000 });
  assert.equal(loss.results.income_value, 0);
  assert.equal(loss.status, 'no_positive_operating_income');
});

test('SA per-stay cleaning and occupied-night consumables flow into contribution and cashflow', () => {
  const result = calculateMhpDeal('sa', sa);
  close(result.results.occupied_nights, 22.8);
  assert.equal(result.results.variable_per_night, 40);
  assert.equal(result.results.net_per_night, 60);
  close(result.results.gross_pcm, 2280);
  close(result.results.variable_pcm, 912);
  assert.equal(result.results.fixed_pcm, 1220);
  close(result.results.net_pcm, 148);
  close(result.results.break_even_occupancy_pct, 66.8859649122807);
  assert.equal(result.results.setup_total, 3300);
  close(result.results.payback_months, 22.2972972972973);
  close(result.results.setup_roi_pct, 53.81818181818182);
});

test('SA owner and rental inputs do not double-count rent, mortgage or the rental deposit', () => {
  const owner = calculateMhpDeal('sa', { ...sa, deal_type: 'owner', mortgage_pcm: 500 });
  assert.equal(owner.results.fixed_pcm, 920);
  assert.equal(owner.results.setup_total, 2500);
  assert.equal(owner.results.rental_deposit, 0);
  close(owner.results.net_pcm, 448);
  const rented = calculateMhpDeal('sa', { ...sa, mortgage_pcm: 500 });
  assert.equal(rented.results.fixed_pcm, 1220);
});

test('SA reports actual occupancy over 100% rather than capping an impossible break-even', () => {
  const result = calculateMhpDeal('sa', { ...sa, rent_pcm: 2000 });
  close(result.results.break_even_occupancy_pct, 132.67543859649123);
  assert.equal(result.results.cannot_break_even, true);
  assert.equal(result.status, 'cannot_break_even');
  assert.equal(result.results.payback_months, null);
  const noContribution = calculateMhpDeal('sa', { ...sa, adr: 0 });
  assert.equal(noContribution.results.break_even_occupancy_pct, null);
  assert.equal(noContribution.results.cannot_break_even, true);
  invalid('sa', { ...sa, average_stay: 0 }, 'average_stay');
  invalid('sa', { ...sa, occupancy_pct: 101 }, 'occupancy_pct');
});

test('auction ceiling includes premium and a fixed manual tax allowance, with profit on GDV', () => {
  const result = calculateMhpDeal('auction', auction);
  assert.equal(result.results.other_costs, 80000);
  assert.equal(result.results.target_profit, 60000);
  assert.equal(result.results.max_hammer_bid, 152380.95);
  close(result.results.buyer_premium, 7619.0475);
  close(result.results.acquisition_allowance, 167999.9975);
  close(result.results.profit_at_max_bid, 60000.0025);
  assert.ok(Number(result.results.profit_at_max_bid) >= 60000, 'Rounding must never break the selected profit margin.');
  const higherAllowance = calculateMhpDeal('auction', { ...auction, manual_tax_allowance: 6000 });
  assert.equal(higherAllowance.results.max_hammer_bid, 151428.57);
});

test('auction zero target is honoured, and unaffordable projects are not presented as a valid zero-price deal', () => {
  const zeroTarget = calculateMhpDeal('auction', { ...auction, target_profit_on_gdv_pct: 0, buyer_premium_pct: 0 });
  assert.equal(zeroTarget.results.max_hammer_bid, 220000);
  assert.equal(zeroTarget.results.target_profit, 0);
  const impossible = calculateMhpDeal('auction', { ...auction, construction_costs: 400000 });
  assert.equal(impossible.results.max_hammer_bid, 0);
  assert.equal(impossible.results.no_affordable_bid, true);
  assert.equal(impossible.status, 'no_affordable_bid');
});

test('residual land uses profit on COST and counts planning once', () => {
  const result = calculateMhpDeal('residual', residual);
  assert.equal(result.results.non_land_costs, 80000);
  assert.equal(result.results.residual_land_value, 170000);
  assert.equal(result.results.gap_to_land_price, 20000);
  assert.equal(result.results.total_cost, 230000);
  assert.equal(result.results.profit, 70000);
  close(result.results.profit_on_cost_pct, 30.434782608695656);
  close(result.results.profit_on_gdv_pct, 23.333333333333332);
  assert.equal(calculateMhpDeal('residual', { ...residual, planning_costs: 0 }).results.residual_land_value, 182000);
});

test('residual zero target is explicit, negative land value remains visible and zero total cost gives no ratio', () => {
  assert.equal(calculateMhpDeal('residual', { ...residual, target_profit_on_cost_pct: 0 }).results.residual_land_value, 220000);
  const negative = calculateMhpDeal('residual', { ...residual, construction_costs: 400000 });
  assert.equal(negative.results.residual_land_value, -190000);
  assert.equal(negative.status, 'negative_residual');
  const noCosts = Object.fromEntries(Object.keys(residual).map(key => [key, key === 'gdv' ? 300000 : 0]));
  assert.equal(calculateMhpDeal('residual', noCosts).results.profit_on_cost_pct, null);
});

test('normalisation accepts form decimals, preserves zero and rejects coercions or hidden assumptions', () => {
  const strings = Object.fromEntries(Object.entries(hmo).map(([key, value]) => [key, String(value)]));
  assert.deepEqual(calculateMhpDeal('hmo', strings), calculateMhpDeal('hmo', hmo));
  for (const value of [Infinity, NaN, -1, true, [], {}, '1,000', '£100', '1e3', '   ', '']) invalid('hmo', { ...hmo, room_rent_weekly: value }, 'room_rent_weekly');
  const missing = { ...hmo } as Record<string, unknown>; delete missing.insurance_annual;
  invalid('hmo', missing, 'insurance_annual');
  invalid('hmo', { ...hmo, annual_noi: 1000000 }, 'annual_noi');
  invalid('hmo', Object.create(hmo), 'rooms');
  invalid('hmo', [], 'inputs');
  invalid('hmo', null, 'inputs');
  invalid('epc', {}, 'calculator');
});

test('all five calculations carry source/version, serialize safely, do not mutate inputs and expose every displayed metric', () => {
  for (const [id, inputs] of [['brrr', brrr], ['hmo', hmo], ['sa', sa], ['auction', auction], ['residual', residual]] as const) {
    const before = JSON.stringify(inputs);
    const result = calculateMhpDeal(id, Object.freeze(inputs));
    assert.equal(JSON.stringify(inputs), before);
    assert.match(result.version, /^mhp-2026-10-28\./);
    assert.match(result.source.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    for (const display of mhpCalculator(id)!.metrics) assert.ok(Object.hasOwn(result.results, display.key), `${id}.${display.key}`);
  }
  assert.equal(MHP_CALCULATORS.length, 5);
  assert.equal(mhpCalculator('epc'), undefined);
});

test('metric formatting consistently labels pounds, percent points and undefined ratios', () => {
  assert.equal(formatMhpMetric(152380.95, 'gbp'), '£152,380.95');
  assert.equal(formatMhpMetric(66.88596, 'percent'), '66.89%');
  assert.equal(formatMhpMetric(0, 'months'), '0 months');
  assert.equal(formatMhpMetric(null, 'percent'), 'Not applicable');
  assert.equal(formatMhpMetric(Infinity, 'number'), 'Not applicable');
});
