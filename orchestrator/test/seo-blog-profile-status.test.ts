import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PROFILE_STATUS_SCRIPT } from '../src/portal/profile-status.js';

function browser(response: { state: string; detail: string } | null) {
  const detail = { textContent: 'queued' }; const review = { hidden: true }; const timers: (() => Promise<void>)[] = []; const events = new Map<string, () => void>(); let requests = 0;
  const status = { getAttribute: () => '/portal/seo-blog/b/brand/profile/status?job=job', querySelector: (selector: string) => selector.includes('detail') ? detail : review };
  const context = { document: { querySelector: () => status }, window: { addEventListener: (event: string, callback: () => void) => events.set(event, callback) },
    setTimeout: (callback: () => Promise<void>) => { timers.push(callback); return 1; }, clearTimeout: () => {},
    fetch: async (_url: string, options: { credentials: string; cache: string }) => { requests++; assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); if (!response) throw new Error('network failed'); return { ok: true, json: async () => response }; },
  };
  runInNewContext(PROFILE_STATUS_SCRIPT, context);
  return { detail, review, events, timers, requests: () => requests };
}
test('read-only profile polling reveals ready/held results without navigation, form access or automatic replacement', async () => {
  for (const state of ['done', 'blocked', 'cancelled']) {
    const b = browser({ state, detail: 'Truthful saved outcome' }); await b.timers.shift()!();
    assert.equal(b.detail.textContent, `${state}: Truthful saved outcome`); assert.equal(b.review.hidden, false); assert.equal(b.requests(), 1); assert.equal(b.timers.length, 0);
  }
});
test('poll failures remain unknown and pagehide prevents pending polling from reviving restored UI', async () => {
  const b = browser(null); await b.timers.shift()!(); assert.match(b.detail.textContent, /may still be running/); assert.equal(b.review.hidden, true);
  const hidden = browser({ state: 'done', detail: 'Ready' }); hidden.events.get('pagehide')!(); await hidden.timers.shift()!(); assert.equal(hidden.requests(), 0); assert.equal(hidden.detail.textContent, 'queued');
});
