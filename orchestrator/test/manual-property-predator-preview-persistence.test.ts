import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PROPERTY_PREDATOR_PREVIEW_IMPORT_ONLY = '1';

const preview = await import('./manual-property-predator-preview.js');

const CSRF = 'preview-only-csrf-token-0000000000000000';

function baseForm(commandKey: string): URLSearchParams {
  return new URLSearchParams({
    _csrf: CSRF,
    command_key: commandKey,
    environment: 'test',
  });
}

test('preview campaign create persists across independent calendar rebuilds and replays safely', () => {
  preview.resetPreviewCampaignState();
  const form = baseForm('preview-campaign-create:test-create-0001');
  form.set('timezone', 'Europe/London');
  form.set('title', 'Investor evidence rehearsal');
  form.set('objective', 'Prove the approved signal across two owned TEST rails.');
  form.set('content_version_id', '82000000-0000-4000-8000-000000000001');
  form.append('target_ids', 'a7000000-0000-4000-8000-000000000001');
  form.append('target_ids', 'a7000000-0000-4000-8000-000000000003');
  form.set('desired_for_local', '2026-08-28T14:00');
  form.set('max_attempts', '2');
  form.set('confirm_test_only', 'confirmed');

  const result = preview.applyPreviewCampaignCreate(form);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'planned');
  assert.ok(result.intentId);
  assert.equal(preview.previewCampaignStateForTest().active.length, 3);

  const firstReload = preview.createPersistentPreviewContentCalendar();
  const secondReload = preview.createPersistentPreviewContentCalendar();
  const createdFirst = firstReload.slots.filter((slot) => slot.planning?.intentId === result.intentId);
  const createdSecond = secondReload.slots.filter((slot) => slot.planning?.intentId === result.intentId);
  assert.equal(createdFirst.length, 2);
  assert.deepEqual(createdSecond, createdFirst);
  assert.ok(createdFirst.every((slot) => slot.executionMode === 'simulated'));
  assert.ok(createdFirst.every((slot) => slot.planning?.providerEffects === 'none'));

  const replay = preview.applyPreviewCampaignCreate(form);
  assert.equal(replay.ok, true);
  assert.equal(replay.code, 'replayed');
  assert.equal(preview.previewCampaignStateForTest().active.length, 3);
});

test('preview reschedule and cancellation survive reload with append-only history evidence', () => {
  preview.resetPreviewCampaignState();
  const seeded = preview.previewCampaignStateForTest().active[0];
  assert.ok(seeded);

  const reschedule = baseForm(
    `preview-calendar-reschedule:${seeded.intentId}:${seeded.targetId}:v${seeded.version}`,
  );
  reschedule.set('intent_id', seeded.intentId);
  reschedule.set('target_id', seeded.targetId);
  reschedule.set('intent_sha256', seeded.intentSha256);
  reschedule.set('expected_updated_at', seeded.updatedAt);
  reschedule.set('desired_for_local', '2026-08-29T15:30');
  reschedule.set('reason', 'Move the local rehearsal beside the launch briefing.');
  reschedule.set('confirm_change', 'confirmed');

  const moved = preview.applyPreviewCampaignReschedule(reschedule);
  assert.equal(moved.ok, true);
  assert.equal(moved.code, 'rescheduled');
  assert.notEqual(moved.intentId, seeded.intentId);
  const afterMove = preview.previewCampaignStateForTest();
  const current = afterMove.active.find((state) => state.slotId === seeded.slotId);
  assert.ok(current);
  assert.equal(current.desiredFor, '2026-08-29T14:30:00.000Z');
  assert.equal(afterMove.history.length, 1);
  assert.equal(afterMove.history[0]?.planningState, 'superseded');
  assert.equal(
    preview.createPersistentPreviewContentCalendar().slots
      .find((slot) => slot.slotId === seeded.slotId)?.scheduledFor,
    '2026-08-29T14:30:00.000Z',
  );

  const cancel = baseForm(
    `preview-calendar-cancel:${current.intentId}:${current.targetId}:v${current.version}`,
  );
  cancel.set('intent_id', current.intentId);
  cancel.set('target_id', current.targetId);
  cancel.set('intent_sha256', current.intentSha256);
  cancel.set('expected_updated_at', current.updatedAt);
  cancel.set('reason', 'Stop this exact local TEST target.');
  cancel.set('confirm_cancel', 'confirmed');

  const stopped = preview.applyPreviewCampaignCancel(cancel);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.code, 'cancelled');
  const afterCancel = preview.previewCampaignStateForTest();
  assert.equal(afterCancel.active.find((state) => state.slotId === seeded.slotId)?.planningState, 'cancelled');
  assert.equal(afterCancel.history.length, 2);
  assert.equal(
    preview.createPersistentPreviewContentCalendar().slots
      .find((slot) => slot.slotId === seeded.slotId)?.planning?.planningState,
    'cancelled',
  );
});

test('preview campaign mutations reject incomplete commands without changing state', () => {
  preview.resetPreviewCampaignState();
  const before = preview.previewCampaignStateForTest();
  const result = preview.applyPreviewCampaignCreate(new URLSearchParams({
    _csrf: 'wrong',
    command_key: 'preview-campaign-create:rejected',
    environment: 'test',
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid');
  assert.deepEqual(preview.previewCampaignStateForTest(), before);
});
