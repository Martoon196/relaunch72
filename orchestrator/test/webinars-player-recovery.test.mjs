import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { PUBLIC_ROOM_SCRIPT } from '../src/webinars/client-scripts.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(rejections = []) {
  const timers = new Map(), signals = [], listeners = new Map();
  let sequence = 0, loads = 0, plays = 0;
  function element() {
    const events = new Map();
    return { textContent: '', hidden: true, className: '',
      addEventListener(name, fn) { const a = events.get(name) || []; a.push(fn); events.set(name, a); },
      removeEventListener(name, fn) { events.set(name, (events.get(name) || []).filter(x => x !== fn)); },
      emit(name) { for (const fn of events.get(name) || []) fn(); } };
  }
  const video = { ...element(), currentTime: 0, duration: 0, paused: true, controls: false, error: null,
    canPlayType: () => 'maybe',
    play() { plays++; const name = rejections.shift(); return name ? Promise.reject(Object.assign(new Error(name), { name })) : Promise.resolve(); },
    load() { loads++; }, removeAttribute() {} };
  const nodes = new Map(['[data-overlay]', '[data-state-label]', '[data-state-message]', '[data-countdown]', '[data-play]',
    '[data-note]', '[data-cta]', '[data-cta-label]', '[data-cta-body]', '[data-cta-link]'].map(k => [k, element()]));
  nodes.set('[data-video]', video);
  const root = { getAttribute: () => 'synthetic-native-startup', querySelector: k => nodes.get(k) || null };
  const state = { state: 'live', label: 'Live', message: 'You are watching live.', playMode: 'live',
    hlsUrl: 'https://video.invalid/synthetic/manifest.m3u8', expiresAt: new Date(Date.now() + 3600000).toISOString(),
    serverNow: new Date().toISOString(), cta: null };
  vm.runInNewContext(PUBLIC_ROOM_SCRIPT, {
    document: { querySelector: () => root, querySelectorAll: () => [], hidden: false,
      addEventListener(name, fn) { listeners.set(name, fn); } }, window: {}, location: {},
    localStorage: { getItem: () => null }, Date, Number, Math, Promise,
    fetch: async (url, options) => {
      if (url.endsWith('/signal')) signals.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ...state }) };
    },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() {},
  });
  function run(delay) {
    const item = [...timers].find(([, value]) => value.delay === delay);
    assert.ok(item, `expected a ${delay}ms timer`); timers.delete(item[0]); item[1].fn(); return item[1].fn;
  }
  return { video, nodes, state, signals, run, timers, listeners,
    counts: () => ({ loads, plays }), retryCount: () => [...timers.values()].filter(x => x.delay === 3000).length };
}

test('native live manifest failure retries automatically and only reports viewing after real playing', async () => {
  const h = harness(['NotSupportedError']); await flush();
  assert.equal(h.nodes.get('[data-play]').hidden, true, 'media failure is not an autoplay permission prompt');
  assert.match(h.nodes.get('[data-note]').textContent, /retrying automatically/);
  assert.doesNotMatch(h.nodes.get('[data-note]').textContent, /You are watching live/);
  assert.equal(h.retryCount(), 1); assert.equal(h.signals.length, 0);
  h.video.emit('error'); assert.equal(h.retryCount(), 1, 'duplicate native error does not create parallel retries');
  h.run(3000); await flush();
  assert.deepEqual(h.counts(), { loads: 1, plays: 2 }); assert.equal(h.signals.length, 0);
  h.video.emit('playing'); await flush();
  assert.equal(h.retryCount(), 0); assert.equal(h.nodes.get('[data-overlay]').hidden, true);
  assert.match(h.nodes.get('[data-note]').textContent, /You are watching live/);
  assert.deepEqual(h.signals, [{ kind: 'player_started', mode: 'live' }]);
});

test('genuine autoplay rejection offers a tap without reloading healthy media', async () => {
  const h = harness(['NotAllowedError']); await flush();
  assert.equal(h.nodes.get('[data-play]').hidden, false); assert.equal(h.nodes.get('[data-play]').textContent, 'Start watching');
  assert.match(h.nodes.get('[data-note]').textContent, /tap to play sound/); assert.equal(h.retryCount(), 0);
  h.run(10000); await flush();
  assert.equal(h.nodes.get('[data-overlay]').hidden, false, 'state polling must not hide the required play control');
  h.nodes.get('[data-play]').emit('click'); await flush(); h.video.emit('playing'); await flush();
  assert.equal(h.nodes.get('[data-play]').hidden, true); assert.equal(h.counts().loads, 0);
});

test('native recovery is bounded, offers an explicit retry and preserves truthful status across polls', async () => {
  const h = harness(Array(20).fill('NotSupportedError')); await flush();
  for (let i = 0; i < 12; i++) { h.run(3000); await flush(); }
  assert.equal(h.retryCount(), 0); assert.equal(h.counts().loads, 12);
  assert.equal(h.nodes.get('[data-play]').hidden, false); assert.equal(h.nodes.get('[data-play]').textContent, 'Try playback again');
  h.run(10000); await flush();
  assert.match(h.nodes.get('[data-note]').textContent, /could not start/); assert.equal(h.signals.length, 0);
  h.nodes.get('[data-play]').emit('click'); await flush(); assert.equal(h.retryCount(), 1);
});

test('leaving a playable state cancels pending native retries and stale callbacks', async () => {
  const h = harness(['NotSupportedError']); await flush();
  const old = [...h.timers.values()].find(x => x.delay === 3000).fn;
  h.state.state = 'interrupted'; h.state.hlsUrl = null; h.state.message = 'Presenter reconnecting';
  h.run(10000); await flush();
  const before = h.counts(); assert.equal(h.retryCount(), 0); old(); await flush();
  assert.deepEqual(h.counts(), before); assert.equal(h.nodes.get('[data-play]').hidden, true);
});

test('a delayed native failure after playback reconnects without claiming another attendance start', async () => {
  const h = harness(); await flush(); h.video.emit('playing'); await flush();
  h.video.emit('error'); await flush(); assert.equal(h.retryCount(), 1);
  assert.match(h.nodes.get('[data-note]').textContent, /retrying/);
  h.run(3000); await flush(); h.video.emit('playing'); await flush();
  assert.equal(h.signals.filter(x => x.kind === 'player_started').length, 1);
});
