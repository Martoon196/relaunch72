import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS,
  installPropertyPredatorConversionBlueprints,
  type PublishConversionBlueprintResult,
} from '../src/conversion-pg/index.js';

const context = Object.freeze({
  actorKind: 'user' as const,
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  requestId: 'install-property-predator-v2',
});

function result(seed: string): PublishConversionBlueprintResult {
  return Object.freeze({
    disposition: 'applied',
    scoreModelId: `${seed}0000000-0000-4000-8000-000000000001`,
    scoreModelVersionId: `${seed}0000000-0000-4000-8000-000000000002`,
    journeyId: `${seed}0000000-0000-4000-8000-000000000003`,
    journeyVersionId: `${seed}0000000-0000-4000-8000-000000000004`,
    milestoneIds: Object.freeze({}),
    triggerIds: Object.freeze({}),
  });
}

test('the installer publishes self-serve and agency atomically through the manager command boundary', async () => {
  const calls: string[] = [];
  const first = result('1');
  const second = result('2');
  const service = {
    publishBlueprints: async (
      receivedContext: typeof context,
      blueprints: typeof PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS,
    ) => {
      assert.equal(receivedContext, context);
      calls.push(...blueprints.map((blueprint) => blueprint.slug));
      return [first, second];
    },
  };

  const installed = await installPropertyPredatorConversionBlueprints(service, context);

  assert.deepEqual(calls, [
    'property-predator-self-serve',
    'property-predator-agency-laps',
  ]);
  assert.deepEqual(installed, { selfServe: first, agencyLaps: second });
  assert.ok(Object.isFrozen(installed));
});

test('an atomic publication failure escapes without a partial result', async () => {
  const failure = new Error('foundation unavailable');
  let calls = 0;
  await assert.rejects(installPropertyPredatorConversionBlueprints({
    publishBlueprints: async () => {
      calls += 1;
      throw failure;
    },
  }, context), failure);
  assert.equal(calls, 1);
});

test('the installer rejects a missing publication service before doing work', async () => {
  await assert.rejects(
    installPropertyPredatorConversionBlueprints({} as never, context),
    /must provide publishBlueprints/,
  );
});
