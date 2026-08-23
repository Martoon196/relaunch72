import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSetupPage, billingPage, dashboardPage, loginPage } from '../src/portal/views.js';
import { planOptions } from '../src/portal/billing.js';
import { CORE_PLATFORM_MODULES } from '../src/platform/modules.js';
import { PORTAL_STYLE } from '../src/portal/ui.js';
import type { DashboardData } from '../src/portal/data.js';

function colourToken(name: string): string {
  const match = PORTAL_STYLE.match(new RegExp(`--${name}:(#[0-9a-f]{3}(?:[0-9a-f]{3})?)`, 'i'));
  assert.ok(match, `missing colour token --${name}`);
  const hex = match[1]!;
  return hex.length === 4
    ? `#${hex.slice(1).split('').map((digit) => `${digit}${digit}`).join('')}`
    : hex;
}

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)!.map((value) => Number.parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function dashboard(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    tenant: { id: 'workspace-1', name: 'Northstar Property', createdAt: '2026-08-23T00:00:00Z' },
    contacts: [],
    pipeline: { lead: 0, contacted: 0, qualified: 0, won: 0, lost: 0 },
    activity: [],
    artifacts: {},
    ...overrides,
  };
}

test('portal shell provides native keyboard navigation and responsive landmarks', () => {
  const html = dashboardPage(dashboard());
  assert.match(html, /<html lang="en">/);
  assert.match(html, /class="skip-link" href="#main-content"/);
  assert.match(html, /<aside class="sidebar" aria-label="Workspace navigation">/);
  assert.match(html, /<nav class="primary-nav" aria-label="Primary">/);
  assert.match(html, /<details class="quick-menu">/);
  assert.match(html, /<summary aria-label="Open quick navigation">/);
  assert.match(html, /<span>Quick navigation<\/span>/);
  assert.doesNotMatch(html, /Search or jump to|<kbd>Quick jump<\/kbd>/);
  assert.match(html, /<main class="main" id="main-content" tabindex="-1">/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /\.field input:focus-visible\{outline:3px solid var\(--accent\);outline-offset:2px\}/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, /\.field input:focus-visible\{outline:3px solid Highlight\}/);
  assert.doesNotMatch(html, /\.field input:focus\{[^}]*outline:0/);
  assert.match(html, /<nav class="mobile-nav" aria-label="Mobile navigation" style="--mobile-nav-count:4">/);
  assert.match(html, /\.command-popover\{position:fixed;top:70px;left:18px;right:18px;width:auto/);
  assert.match(html, /Workspace settings<small>.*Setup/s);
  assert.match(html, /href="\/portal#crm"[^>]*>.*CRM<\/a>/s);
  assert.match(html, /href="\/portal" aria-current="page"/);
  assert.doesNotMatch(html, /href="\/portal\/billing"/);
});

test('small semantic text tokens retain WCAG AA contrast on their surfaces', () => {
  for (const [foreground, background] of [
    ['faint', 'panel'],
    ['faint', 'panel-subtle'],
    ['muted', 'panel'],
    ['success', 'success-soft'],
    ['info', 'info-soft'],
  ]) {
    assert.ok(
      contrastRatio(colourToken(foreground!), colourToken(background!)) >= 4.5,
      `--${foreground} must retain 4.5:1 contrast on --${background}`,
    );
  }
});

test('planned platform modules are discoverable but never rendered as working links', () => {
  const html = dashboardPage(dashboard());
  const planned = CORE_PLATFORM_MODULES.filter((module) => module.stage === 'planned');
  assert.ok(planned.length >= 5);
  for (const module of planned) {
    assert.match(html, new RegExp(module.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /Designed into the platform boundary · not available in this sandbox/);
  assert.doesNotMatch(html, /href="\/portal\/(social|listening|inbox|webinars|automations)"/);
});

test('empty CRM and content states explain what is absent without fake controls', () => {
  const html = dashboardPage(dashboard());
  assert.match(html, /No contacts yet/);
  assert.match(html, /Contact creation and import controls are not connected in this sandbox/);
  assert.match(html, /No drafts generated yet/);
  assert.match(html, /Nothing will be scheduled or published/);
  assert.match(html, /No recorded activity/);
  assert.doesNotMatch(html, />Create contact</);
  assert.doesNotMatch(html, />Schedule</);
});

test('an existing social artifact is presented as a reviewable unscheduled draft', () => {
  const html = dashboardPage(dashboard({
    artifacts: { post: { platform: 'LinkedIn', hook: 'A real saved hook', body: 'A real saved body.' } },
  }));
  assert.match(html, /LinkedIn draft/);
  assert.match(html, /Not scheduled/);
  assert.match(html, /A real saved hook/);
  assert.match(html, /A real saved body/);
  assert.doesNotMatch(html, /Published successfully|Scheduled for/i);
});

test('workspace and artifact content is escaped in the premium shell', () => {
  const html = dashboardPage(dashboard({
    tenant: { id: 'workspace-1', name: '<img src=x onerror=alert(1)>', createdAt: '2026-08-23T00:00:00Z' },
    artifacts: { post: { platform: 'LinkedIn', hook: '<script>alert(1)</script>', body: 'Safe & sound' } },
  }));
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Safe &amp; sound/);
});

test('malformed persisted keyword volumes cannot execute markup or custom methods', () => {
  let customFormatterCalled = false;
  const maliciousVolume = { toLocaleString: () => {
    customFormatterCalled = true;
    return '<img src=x onerror=alert(1)>';
  } };
  const html = dashboardPage(dashboard({
    artifacts: {
      keywords: [
        { query: 'valid', volume: 1234 },
        { query: 'malformed', volume: maliciousVolume as unknown as number },
      ],
    },
  }));
  assert.match(html, /~1,234/);
  assert.match(html, /malformed<\/span><span class="volume">—/);
  assert.doesNotMatch(html, /<img src=x|onerror=alert/);
  assert.equal(customFormatterCalled, false);
});

test('login and billing keep the same accessible premium shell semantics', () => {
  const login = loginPage('Wrong email or password.');
  assert.match(login, /role="alert"/);
  assert.match(login, /autocomplete="username"/);
  assert.match(login, /autocomplete="current-password"/);
  assert.match(login, /Private sandbox · secure session · no public publishing/);

  const setup = accountSetupPage('one-use-token', 'Those passwords do not match.');
  assert.match(setup, /role="alert"/);
  assert.match(setup, /name="token" value="one-use-token"/);
  assert.match(setup, /autocomplete="new-password"/);
  assert.match(setup, /Private one-time setup · the link cannot be reused/);

  const billing = billingPage('Northstar Property', {
    status: 'none', active: false, planKey: null, planName: null, currentPeriodEnd: null,
    customerId: null, email: 'owner@example.test', options: planOptions(),
  });
  assert.match(billing, /Workspace navigation/);
  assert.match(billing, /aria-current="page"/);
  assert.match(billing, /<nav class="mobile-nav"[^>]*>.*href="\/portal\/billing" aria-current="page".*Settings<\/a>/s);
  assert.doesNotMatch(billing, /href="\/portal" aria-current="page"/);
  assert.match(billing, /Plan preview only/);
  assert.doesNotMatch(billing, /action="\/portal\/subscribe"/);
});
