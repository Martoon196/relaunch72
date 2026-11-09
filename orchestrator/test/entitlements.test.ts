import test from 'node:test';
import assert from 'node:assert/strict';
import { entitlementForOrder, isCheckoutTier } from '../src/server/entitlements.js';

test('only public one-off tiers can create Checkout Sessions', () => {
  assert.equal(isCheckoutTier('autopsy'), true);
  assert.equal(isCheckoutTier('core'), true);
  assert.equal(isCheckoutTier('pro'), true);
  assert.equal(isCheckoutTier('core_bump'), false, 'the bump is core+bump, never a caller-selected tier');
  assert.equal(isCheckoutTier('platform_pro'), false);
});

test('verified order metadata maps to immutable build entitlements', () => {
  assert.deepEqual(entitlementForOrder({ tier: 'autopsy', bump: false })?.through, 'S1');
  assert.equal(entitlementForOrder({ tier: 'autopsy', bump: false })?.portalAccess, false);
  assert.equal(entitlementForOrder({ tier: 'core', bump: false })?.product, 'core');
  assert.equal(entitlementForOrder({ tier: 'core', bump: true })?.product, 'core_bump');
  assert.equal(entitlementForOrder({ tier: 'core', bump: true })?.through, 'S9');
  assert.equal(entitlementForOrder({ tier: 'pro', bump: false })?.product, 'pro');
  assert.equal(entitlementForOrder({ tier: 'pro', bump: true }), null);
  assert.equal(entitlementForOrder({ tier: 'unknown', bump: false }), null);
});
