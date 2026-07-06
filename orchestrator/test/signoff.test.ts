import test from 'node:test';
import assert from 'node:assert/strict';
import { approve, sendBack, allFlags, bundleStatusFor, summarize, SignoffError, type BundleLike } from '../src/signoff/signoff.js';

function bundle(over: Partial<BundleLike> = {}): BundleLike {
  return {
    run_id: 'r1', business: 'Acme', mode: 'live', status: 'awaiting_signoff',
    deliverables: [
      { stage: 'S6', name: 'Website copy pack', file: 's6.json' },
      { stage: 'S8', name: '30-Day Content Engine', file: 's8.json' },
    ],
    qa: {
      stage_flags: { S8: ['used "scale" once'] },
      s10_issues: [{ check: 's10.s3_banned_word', message: 'S8 contains "scale"' }],
    },
    ...over,
  };
}

test('allFlags flattens stage flags and s10 issues into one list', () => {
  const f = allFlags(bundle());
  assert.equal(f.length, 2);
  assert.ok(f.some((x) => x.includes('S8: used "scale"')));
  assert.ok(f.some((x) => x.includes('s10.s3_banned_word')));
});

test('approve records every QA flag the founder acknowledged', () => {
  const s = approve(bundle(), { by: 'Martin', at: 'T' });
  assert.equal(s.decision, 'approved');
  assert.equal(s.by, 'Martin');
  assert.equal(s.acknowledged_flags?.length, 2);
});

test('approve refuses a mock run unless forced', () => {
  assert.throws(() => approve(bundle({ mode: 'mock' }), { by: 'x', at: 'T' }), SignoffError);
  const s = approve(bundle({ mode: 'mock' }), { by: 'x', at: 'T', force: true });
  assert.equal(s.decision, 'approved');
});

test('send-back requires a note', () => {
  assert.throws(() => sendBack(bundle(), { by: 'x', at: 'T', stages: ['S6'], notes: '   ' }), SignoffError);
});

test('send-back rejects a stage the pack does not have', () => {
  assert.throws(() => sendBack(bundle(), { by: 'x', at: 'T', stages: ['S3'], notes: 'redo' }), SignoffError);
});

test('send-back records upper-cased stages and the note', () => {
  const s = sendBack(bundle(), { by: 'x', at: 'T', stages: ['s6'], notes: '  tighten the hero  ' });
  assert.deepEqual(s.send_back?.stages, ['S6']);
  assert.equal(s.send_back?.notes, 'tighten the hero');
});

test('bundleStatusFor maps the decision to the pack status', () => {
  assert.equal(bundleStatusFor('approved'), 'approved');
  assert.equal(bundleStatusFor('sent_back'), 'sent_back');
});

test('summarize surfaces deliverables and flags for the reviewer', () => {
  const text = summarize(bundle());
  assert.match(text, /Website copy pack/);
  assert.match(text, /QA flags to weigh/);
  assert.match(text, /scale/);
});
