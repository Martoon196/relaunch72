import test from 'node:test';
import assert from 'node:assert/strict';
import { appShell } from '../src/portal/ui.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../src/portal/product-profile.js';
import type { PlatformCapability } from '../src/platform/capabilities.js';

test('entitled MHP Desk and AI team navigation no longer carries generic preview badges', () => {
  const profile = { ...MARTIN_HOWARD_PROPERTY_PROFILE, visibleNavigation: ['investors', 'crm', 'leadrelay'] as typeof MARTIN_HOWARD_PROPERTY_PROFILE.visibleNavigation };
  const html = appShell({ title: 'Your Desk', tenantName: 'Mentee', active: 'investors', body: '', productProfile: profile,
    crmAvailable: true, capabilities: new Set<PlatformCapability>(['workspace.overview.read', 'crm.contacts.read']) });
  assert.match(html, /Your Desk/);
  assert.match(html, /Your AI team/);
  assert.doesNotMatch(html, /class="module-state">Preview/);
});
