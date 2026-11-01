import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { CENTRAL_ACTION_FEEDBACK_SCRIPT } from '../src/portal/action-feedback.js';
import { loginPage, accountSetupPage } from '../src/portal/views.js';
import { layout } from '../src/portal/seo-blog-view.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE, PROPERTY_PREDATOR_GROWTH_PROFILE, RELAUNCH72_PRODUCT_PROFILE } from '../src/portal/product-profile.js';

function element(attributes: Record<string, string> = {}) {
  return { attributes: { ...attributes }, getAttribute(name: string) { return this.attributes[name] ?? null; }, hasAttribute(name: string) { return name in this.attributes; }, setAttribute(name: string, value: string) { this.attributes[name] = value; }, removeAttribute(name: string) { delete this.attributes[name]; } };
}
function browser(regionExists = true) {
  const status = { hidden: true, textContent: '' };
  const main = element(); const body = element(); const listeners = new Map<string, (event: any) => void>(); const windowListeners = new Map<string, () => void>(); const tasks: (() => void)[] = [];
  runInNewContext(CENTRAL_ACTION_FEEDBACK_SCRIPT, {
    URL, location: new URL('https://app.relaunch72.com/portal/seo-blog'), setTimeout: (task: () => void) => tasks.push(task),
    document: { getElementById: () => regionExists ? status : null, querySelector: () => main, body, addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener) },
    window: { addEventListener: (name: string, listener: () => void) => windowListeners.set(name, listener) },
  });
  const flush = () => { while (tasks.length) tasks.shift()!(); };
  const submit = (attributes: Record<string, string> = {}, submitterAttributes: Record<string, string> = {}, valid = true) => {
    const form = { ...element({ method: 'post', action: '/portal/seo-blog/b/brand/profile/extract', ...attributes }), tagName: 'FORM', noValidate: false, checkValidity: () => valid };
    const submitter = { ...element({ name: 'command', value: 'confirm', ...submitterAttributes }), disabled: false, formNoValidate: false };
    Object.defineProperty(form, 'elements', { get() { throw new Error('must not inspect form controls'); } });
    Object.defineProperty(submitter, 'value', { get() { throw new Error('must not inspect submitted values'); } });
    const event = { target: form, submitter, defaultPrevented: false };
    listeners.get('submit')?.(event); return { event, form, submitter };
  };
  const click = (attributes: Record<string, string>, overrides: Record<string, unknown> = {}) => {
    const anchor = element(attributes); const event = { target: { closest: () => anchor }, defaultPrevented: false, button: 0, ...overrides };
    listeners.get('click')?.(event); return event;
  };
  return { status, main, body, listeners, windowListeners, flush, submit, click };
}

test('valid native submit gives accessible working feedback without changing controls, submitter payload or action overrides', () => {
  const b = browser();
  const submitted = b.submit({}, { formaction: '/portal/seo-blog/b/brand/profile/extract', formmethod: 'post', formtarget: '_self' });
  const before = JSON.stringify([submitted.form.attributes, submitted.submitter.attributes]);
  assert.equal(b.status.hidden, true, 'feedback waits until owner handlers finish');
  b.flush(); assert.equal(b.status.hidden, false); assert.match(b.status.textContent, /Working.*brand profile can take a moment/);
  assert.equal(submitted.form.getAttribute('aria-busy'), 'true'); assert.equal(b.body.getAttribute('aria-busy'), null); assert.equal(submitted.submitter.disabled, false);
  assert.equal(JSON.stringify([Object.fromEntries(Object.entries(submitted.form.attributes).filter(([name]) => name !== 'aria-busy')), submitted.submitter.attributes]), before);
  assert.equal(submitted.event.defaultPrevented, false);
});
test('invalid, AJAX-owned, overridden nonself/external and download/export/preview forms keep their existing behaviour', () => {
  const cases: [Record<string, string>, Record<string, string>, boolean][] = [
    [{}, {}, false], [{}, { formtarget: '_blank' }, true], [{}, { formaction: 'https://outside.example/action' }, true],
    [{}, { formaction: '/portal/seo-blog/b/brand/articles/id/export' }, true], [{}, { formaction: '/portal/seo-blog/b/brand/articles/id/preview' }, true],
    [{}, { formmethod: 'dialog' }, true], [{ 'data-action-feedback-skip': '' }, {}, true],
  ];
  for (const [attributes, overrides, valid] of cases) { const b = browser(); b.submit(attributes, overrides, valid); b.flush(); assert.equal(b.status.hidden, true); }
  const b = browser(); const { event } = b.submit(); event.defaultPrevented = true; b.flush(); assert.equal(b.status.hidden, true, 'a later AJAX owner prevents feedback');
});
test('normal internal links show Loading; hash, external, downloads, previews, new tabs and modifier clicks do not', () => {
  const b = browser(); b.click({ href: '/portal/seo-blog/b/brand/setup' }); b.flush(); assert.equal(b.status.textContent, 'Loading…');
  const cases: Record<string, string>[] = [
    { href: '#writing-budget' }, { href: '/portal/seo-blog#same-page' }, { href: 'https://outside.example/' },
    { href: '/portal/seo-blog/b/brand/articles/id/export' }, { href: '/portal/seo-blog/b/brand/articles/id/preview' },
    { href: '/portal/seo-blog?download=1' }, { href: '/portal/seo-blog', download: '' }, { href: '/portal/seo-blog', target: '_blank' },
  ];
  for (const attributes of cases) { const other = browser(); other.click(attributes); other.flush(); assert.equal(other.status.hidden, true); }
  for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) { const other = browser(); other.click({ href: '/portal/seo-blog/b/brand/setup' }, { [modifier]: true }); other.flush(); assert.equal(other.status.hidden, true); }
  const ajax = browser(); const event = ajax.click({ href: '/portal/seo-blog/b/brand/setup' }); event.defaultPrevented = true; ajax.flush(); assert.equal(ajax.status.hidden, true);
});
test('pageshow resets restored pending UI, and pages without the central status region are inert', () => {
  const b = browser(); const { form } = b.submit(); b.flush(); b.click({ href: '/portal/seo-blog/b/brand/setup' }); b.flush();
  assert.equal(b.main.getAttribute('aria-busy'), 'true'); assert.equal(b.body.getAttribute('aria-busy'), null);
  b.windowListeners.get('pageshow')!();
  assert.equal(b.status.hidden, true); assert.equal(b.status.textContent, ''); assert.equal(form.getAttribute('aria-busy'), null); assert.equal(b.main.getAttribute('aria-busy'), null);
  assert.equal(browser(false).listeners.size, 0);
});
test('only explicit central native views and central SEO shell receive the shared self-hosted asset and live region', () => {
  const central = loginPage(undefined, '', 'csrf', RELAUNCH72_PRODUCT_PROFILE, { actionFeedback: true });
  assert.match(central, /action-feedback\.js" defer/); assert.match(central, /role="status" aria-live="polite"/);
  assert.match(accountSetupPage('csrf', undefined, RELAUNCH72_PRODUCT_PROFILE, 'same-origin', true), /central-action-feedback/);
  const shell = { brands: [], brand: null, tab: null, csrf: 'csrf' };
  assert.match(layout({ ...shell, applicationName: 'Relaunch72 Content' }, 'Brands', '<p>Server result</p>'), /central-action-feedback/);
  assert.doesNotMatch(layout(shell, 'Brands', ''), /central-action-feedback/);
  for (const profile of [PROPERTY_PREDATOR_GROWTH_PROFILE, MARTIN_HOWARD_PROPERTY_PROFILE]) {
    assert.doesNotMatch(loginPage(undefined, '', 'csrf', profile), /central-action-feedback|action-feedback\.js/);
    assert.doesNotMatch(accountSetupPage('csrf', undefined, profile), /central-action-feedback|action-feedback\.js/);
  }
});
