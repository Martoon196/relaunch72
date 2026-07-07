import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provisionCatalog, CATALOG, type StripeCatalogLike } from '../src/server/catalog.js';
import { upsertEnv } from '../src/server/setup.js';

function fakeCatalogStripe(existing: Record<string, string> = {}): StripeCatalogLike {
  let nProd = 0, nPrice = 0;
  return {
    products: { create: async () => ({ id: `prod_${++nProd}` }) },
    prices: {
      create: async () => ({ id: `price_new_${++nPrice}` }),
      list: async (p) => {
        const lk = (p.lookup_keys as string[])[0]!;
        return { data: existing[lk] ? [{ id: existing[lk]!, lookup_key: lk }] : [] };
      },
    },
  };
}

test('provisionCatalog creates all four when none exist', async () => {
  const r = await provisionCatalog(fakeCatalogStripe());
  assert.equal(r.created.length, 4);
  assert.equal(r.reused.length, 0);
  assert.deepEqual(Object.keys(r.priceIds).sort(), CATALOG.map((c) => c.key).sort());
  for (const c of CATALOG) assert.ok(r.priceIds[c.key], `${c.key} got a price id`);
});

test('provisionCatalog is idempotent — reuses existing prices by lookup_key', async () => {
  const r = await provisionCatalog(fakeCatalogStripe({ r72_core: 'price_existing_core', r72_pro: 'price_existing_pro' }));
  assert.equal(r.priceIds.core, 'price_existing_core');
  assert.equal(r.priceIds.pro, 'price_existing_pro');
  assert.ok(r.reused.includes('core') && r.reused.includes('pro'));
  assert.ok(r.created.includes('autopsy') && r.created.includes('core_bump'));
  assert.equal(r.created.length, 2);
});

test('upsertEnv replaces an existing key and appends a new one', () => {
  const f = path.join(os.tmpdir(), `r72-env-${process.pid}-${Math.round(performance.now())}`);
  fs.writeFileSync(f, 'STRIPE_SECRET_KEY=sk_test_x\nSTRIPE_PRICE_CORE=\n', 'utf8');
  upsertEnv(f, { STRIPE_PRICE_CORE: 'price_c', STRIPE_PRICE_PRO: 'price_p' });
  const out = fs.readFileSync(f, 'utf8');
  assert.match(out, /^STRIPE_PRICE_CORE=price_c$/m);
  assert.match(out, /^STRIPE_PRICE_PRO=price_p$/m);
  assert.match(out, /^STRIPE_SECRET_KEY=sk_test_x$/m); // untouched
  fs.rmSync(f, { force: true });
});
