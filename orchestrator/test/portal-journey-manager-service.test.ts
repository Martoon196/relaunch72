import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { PublishConversionBlueprintResult } from '../src/conversion-pg/commands.js';
import { ConversionBlueprintVersionConflictError } from '../src/conversion-pg/commands.js';
import type { JourneyManagerReadSnapshot } from '../src/conversion-pg/journey-manager.js';
import { PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS } from '../src/conversion-pg/property-predator-blueprints.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import { PgPortalJourneyManagerService } from '../src/portal/journey-manager-service.js';

const SESSION = 'opaque-portal-session';
const identity = Object.freeze({ sessionToken: SESSION, requestId: 'journey-install-1' });
const principal = Object.freeze({
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
});

function snapshot(canManage: boolean): JourneyManagerReadSnapshot {
  const [selfServe, agency] = PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS;
  const score = selfServe!.scoreModel;
  return Object.freeze({
    snapshotAt: '2026-08-25T12:00:00.000Z',
    canManage,
    foundationState: 'not_installed',
    runtimeReady: false,
    routes: Object.freeze([selfServe!, agency!].map((route) => Object.freeze({
      slug: route.slug as 'property-predator-self-serve' | 'property-predator-agency-laps',
      name: route.name,
      description: route.description,
      version: route.version,
      definitionHash: route.definitionHash,
      publication: 'missing' as const,
      activeVersion: null,
      publishedAt: null,
      runtimeReady: false,
      milestones: route.milestones,
      triggers: route.triggers,
    }))),
    scoreModel: Object.freeze({
      slug: score.slug,
      name: score.name,
      version: score.version,
      definitionHash: score.definitionHash,
      publication: 'missing',
      activeVersion: null,
      publishedAt: null,
      maxScore: 100,
      components: score.components,
      bands: score.bands,
      rules: score.rules,
    }),
    safety: Object.freeze({
      definitionsOnly: true,
      sendsMessages: false,
      publishesSocialPosts: false,
      triggersProviders: false,
    }),
  });
}

function publishResult(disposition: 'applied' | 'replayed', seed: string): PublishConversionBlueprintResult {
  return Object.freeze({
    disposition,
    scoreModelId: `${seed}1111111-1111-4111-8111-111111111111`,
    scoreModelVersionId: `${seed}2222222-2222-4222-8222-222222222222`,
    journeyId: `${seed}3333333-3333-4333-8333-333333333333`,
    journeyVersionId: `${seed}4444444-4444-4444-8444-444444444444`,
    milestoneIds: Object.freeze({}),
    triggerIds: Object.freeze({}),
  });
}

function contextAssertions(context: DatabaseRequestContext): void {
  assert.equal(context.actorKind, 'user');
  assert.equal(context.userId, principal.userId);
  assert.equal(context.workspaceId, principal.workspaceId);
  assert.equal(context.requestId, identity.requestId);
  assert.deepEqual(context.portalSessionTokenHash, createHash('sha256').update(SESSION).digest());
}

test('portal Journey Manager resolves the opaque session and returns the read snapshot', async () => {
  const expected = snapshot(true);
  const service = new PgPortalJourneyManagerService({
    principalResolver: { resolve: async (token) => token === SESSION ? principal : null },
    readService: {
      load: async (context) => {
        contextAssertions(context);
        return expected;
      },
    },
    commandService: { publishBlueprints: async () => assert.fail('snapshot must not publish') },
  });

  assert.equal(await service.snapshot(identity), expected);
  assert.equal(await service.snapshot({ ...identity, sessionToken: 'invalid' }), null);
});

test('manager install publishes only the two reviewed blueprints and reports replay safety', async () => {
  const calls: string[] = [];
  const service = new PgPortalJourneyManagerService({
    principalResolver: { resolve: async () => principal },
    readService: { load: async (context) => (contextAssertions(context), snapshot(true)) },
    commandService: {
      publishBlueprints: async (context, blueprints) => {
        contextAssertions(context);
        calls.push(...blueprints.map((blueprint) => blueprint.slug));
        return [publishResult('replayed', '1'), publishResult('applied', '2')];
      },
    },
  });

  const outcome = await service.installFoundation(identity);

  assert.deepEqual(calls, [
    'property-predator-self-serve',
    'property-predator-agency-laps',
  ]);
  assert.deepEqual(outcome, {
    ok: true,
    disposition: 'applied',
    routes: { selfServe: 'replayed', agencyLaps: 'applied' },
  });
});

test('manager install reports an exact rerun without duplicating definitions', async () => {
  const service = new PgPortalJourneyManagerService({
    principalResolver: { resolve: async () => principal },
    readService: { load: async () => snapshot(true) },
    commandService: {
      publishBlueprints: async () => [publishResult('replayed', '1'), publishResult('replayed', '2')],
    },
  });

  const outcome = await service.installFoundation(identity);

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.disposition, 'replayed');
});

test('non-managers and inactive sessions cannot reach the publication command', async () => {
  let calls = 0;
  const commandService = {
    publishBlueprints: async () => {
      calls += 1;
      return [publishResult('applied', '1'), publishResult('applied', '2')];
    },
  };
  const nonManager = new PgPortalJourneyManagerService({
    principalResolver: { resolve: async () => principal },
    readService: { load: async () => snapshot(false) },
    commandService,
  });
  const inactive = new PgPortalJourneyManagerService({
    principalResolver: { resolve: async () => null },
    readService: { load: async () => assert.fail('inactive session must not read') },
    commandService,
  });

  assert.deepEqual(await nonManager.installFoundation(identity), {
    ok: false,
    kind: 'forbidden',
    message: 'Only a workspace owner or admin can install the journey foundation.',
  });
  assert.equal((await inactive.installFoundation(identity)).ok, false);
  assert.equal(calls, 0);
});

test('a stored definition conflict is blocked server-side before the atomic publisher', async () => {
  let calls = 0;
  const current = snapshot(true);
  const conflicted: JourneyManagerReadSnapshot = Object.freeze({
    ...current,
    foundationState: 'action_required',
    routes: Object.freeze(current.routes.map((route, index) => index === 0
      ? Object.freeze({ ...route, publication: 'conflict' as const })
      : route)),
  });
  const service = new PgPortalJourneyManagerService({
    principalResolver: { resolve: async () => principal },
    readService: { load: async () => conflicted },
    commandService: {
      publishBlueprints: async () => {
        calls += 1;
        return [publishResult('applied', '1'), publishResult('applied', '2')];
      },
    },
  });

  const outcome = await service.installFoundation(identity);

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.kind, 'conflict');
  assert.equal(calls, 0);
});

test('database manager denial and immutable version conflicts are sanitised', async () => {
  const denied = new PgPortalJourneyManagerService({
    principalResolver: { resolve: async () => principal },
    readService: { load: async () => snapshot(true) },
    commandService: {
      publishBlueprints: async () => {
        throw Object.assign(new Error('private database detail'), { code: '42501' });
      },
    },
  });
  const conflict = new PgPortalJourneyManagerService({
    principalResolver: { resolve: async () => principal },
    readService: { load: async () => snapshot(true) },
    commandService: {
      publishBlueprints: async () => {
        throw new ConversionBlueprintVersionConflictError('journey', 'property-predator-self-serve', 2);
      },
    },
  });

  const deniedOutcome = await denied.installFoundation(identity);
  assert.equal(deniedOutcome.ok, false);
  if (!deniedOutcome.ok) {
    assert.equal(deniedOutcome.kind, 'forbidden');
    assert.doesNotMatch(deniedOutcome.message, /private database detail/);
  }
  const conflictOutcome = await conflict.installFoundation(identity);
  assert.equal(conflictOutcome.ok, false);
  if (!conflictOutcome.ok) assert.equal(conflictOutcome.kind, 'conflict');
});
