import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import { createPropertyPredatorCompanyAssetsFixture } from '../src/portal/company-assets-fixtures.js';
import {
  PgPortalCompanyAssetsService,
  type PgPortalCompanyAssetsDependencies,
} from '../src/portal/company-assets-pg-service.js';
import {
  CompanyAssetsPresentationError,
  presentCompanyAssets,
} from '../src/portal/company-assets-presenter.js';
import type {
  PortalCompanyAssetsSnapshot,
  PortalQuarantineCompanyAssetInput,
} from '../src/portal/company-assets-service.js';
import { renderCompanyAssetsBody } from '../src/portal/company-assets-view.js';

const SESSION = Buffer.alloc(32, 19).toString('base64url');
const IDENTITY = Object.freeze({ sessionToken: SESSION, requestId: 'company-assets-request-1' });
const PRINCIPAL = Object.freeze({
  userId: 'a7400000-0000-4000-8000-000000000001',
  workspaceId: 'a7000000-0000-4000-8000-000000000001',
});

function authoritativeSnapshot(): PortalCompanyAssetsSnapshot {
  return { ...createPropertyPredatorCompanyAssetsFixture(), dataset: 'postgres_authoritative' };
}

function quarantineInput(snapshot = authoritativeSnapshot()): PortalQuarantineCompanyAssetInput {
  const item = snapshot.itemPage.items[0]!;
  return {
    commandKey: 'company-assets-quarantine-command-1',
    sourceReleaseId: item.sourceReleaseId,
    releaseItemId: item.releaseItemId,
    itemType: item.itemType,
    itemId: item.itemId,
    itemContentSha256: item.contentSha256,
    itemBrandSha256: item.brandSha256,
    dimension: 'visual_policy',
    outcome: 'quarantined',
    reasonCode: 'visual_policy_conflict',
    evidenceSha256: item.contentSha256,
  };
}

test('company-assets presenter and view allowlist migration 0033 metadata and keep preview read-only', () => {
  const fixture = createPropertyPredatorCompanyAssetsFixture();
  const preview = presentCompanyAssets(fixture);
  assert.equal(preview.metrics.loadedItems, 3);
  assert.equal(preview.metrics.assetItems, 1);
  assert.equal(preview.metrics.quarantinedItems, 1);
  assert.equal(preview.canQuarantine, false, 'illustrative fixtures never gain command forms');
  assert.equal(preview.clearLocked, true);
  assert.equal(preview.approvalLocked, true);
  assert.equal(preview.providerEffectsOff, true);

  const authoritative = presentCompanyAssets(authoritativeSnapshot());
  assert.equal(authoritative.canQuarantine, true);
  const quarantineKeys = Object.fromEntries(authoritative.items.flatMap((item) => (
    item.quarantineActions.map((action) => [
      `${item.releaseItemId}:${action.dimension}`,
      `asset-command-${item.releaseItemId}-${action.dimension}`,
    ])
  )));
  const html = renderCompanyAssetsBody(authoritative, {
    security: { csrfToken: 'csrf-token-at-least-sixteen-bytes', quarantineKeys },
    brandBrainAvailable: true,
  });
  assert.match(html, /Company asset library/);
  assert.match(html, /PROVIDER EFFECTS OFF/);
  assert.match(html, /Authoritative migration 0033 metadata/);
  assert.match(html, /href="\/portal\/content\/assets" aria-current="page"/);
  assert.match(html, /action="\/portal\/content\/assets\/quarantine"/);
  assert.match(html, /type="hidden" name="outcome" value="quarantined"/);
  assert.match(html, new RegExp(`type="hidden" name="evidence_sha256" value="${authoritative.items[0]!.contentSha256}"`));
  assert.match(html, /Clear locked/);
  assert.match(html, /Approval locked/);
  assert.doesNotMatch(html, />Usable</);
  assert.doesNotMatch(html, /name="outcome" value="clear"|Approve now|Publish now|Generate now/i);
  assert.doesNotMatch(html, /<img\b|<script\b|content_resource_path|asset_resource_path/i);
});

test('company-assets presenter drops unknown raw/private fields and rejects poisoned boundaries', () => {
  const fixture = authoritativeSnapshot();
  const poisoned = {
    ...fixture,
    itemPage: {
      ...fixture.itemPage,
      items: [{
        ...fixture.itemPage.items[0]!,
        rawContent: 'DO-NOT-RENDER-RAW-CONTENT',
        artworkBytes: 'DO-NOT-RENDER-ARTWORK',
        prompt: 'DO-NOT-RENDER-PROMPT',
        knowledge: 'DO-NOT-RENDER-KNOWLEDGE',
      }],
    },
  } as unknown as PortalCompanyAssetsSnapshot;
  const view = presentCompanyAssets(poisoned);
  assert.doesNotMatch(JSON.stringify(view), /DO-NOT-RENDER/);

  assert.throws(() => presentCompanyAssets({
    ...fixture,
    providerEffects: true,
  } as unknown as PortalCompanyAssetsSnapshot), CompanyAssetsPresentationError);
  assert.throws(() => presentCompanyAssets({
    ...fixture,
    reviewRepresentationAvailable: true,
  } as unknown as PortalCompanyAssetsSnapshot), CompanyAssetsPresentationError);
  assert.throws(() => presentCompanyAssets({
    ...fixture,
    dataset: 'browser_payload',
  } as unknown as PortalCompanyAssetsSnapshot), CompanyAssetsPresentationError);
  assert.throws(() => presentCompanyAssets({
    ...fixture,
    selectedRelease: null,
  } as unknown as PortalCompanyAssetsSnapshot), /latest page row/);
  assert.throws(() => presentCompanyAssets({
    ...fixture,
    itemPage: { ...fixture.itemPage, hasMore: 'yes' },
  } as unknown as PortalCompanyAssetsSnapshot), CompanyAssetsPresentationError);
  assert.throws(() => presentCompanyAssets({
    ...fixture,
    releases: [{ ...fixture.releases[0]!, latestUsable: 'yes' }],
    selectedRelease: { ...fixture.selectedRelease!, latestUsable: 'yes' },
  } as unknown as PortalCompanyAssetsSnapshot), CompanyAssetsPresentationError);
});

function dependencies(overrides: Partial<PgPortalCompanyAssetsDependencies> = {}) {
  const snapshot = authoritativeSnapshot();
  const contexts: DatabaseRequestContext[] = [];
  const calls = { releases: 0, items: 0, commands: 0 };
  const deps: PgPortalCompanyAssetsDependencies = {
    principalResolver: { resolve: async () => PRINCIPAL },
    accessReader: {
      load: async (context) => {
        contexts.push(context);
        return snapshot.workspace;
      },
    },
    readService: {
      listReleases: async (_context, input) => {
        calls.releases += 1;
        assert.deepEqual(input, { limit: 10 });
        return snapshot.releases;
      },
      listItems: async (_context, input) => {
        calls.items += 1;
        assert.deepEqual(input, {
          sourceReleaseId: snapshot.selectedRelease!.sourceReleaseId,
          limit: 50,
        });
        return snapshot.itemPage;
      },
    },
    commandService: {
      decideQuarantine: async (_context, command) => {
        calls.commands += 1;
        if (command.outcome !== 'quarantined') throw new Error('unexpected clear command');
        return {
          disposition: 'applied',
          quarantineDecisionId: 'a7500000-0000-4000-8000-000000000001',
          sourceReleaseId: command.sourceReleaseId,
          releaseItemId: command.releaseItemId,
          itemType: command.itemType,
          itemId: command.itemId,
          itemContentSha256: command.itemContentSha256,
          itemBrandSha256: command.itemBrandSha256,
          dimension: command.dimension,
          outcome: command.outcome,
          reasonCode: command.reasonCode,
          evidenceSha256: command.evidenceSha256,
          providerEffects: false,
        };
      },
    },
    ...overrides,
  };
  return { deps, snapshot, contexts, calls };
}

test('PostgreSQL company-assets service preserves role-facing bounds and exact quarantine tuple', async () => {
  const setup = dependencies();
  const service = new PgPortalCompanyAssetsService(setup.deps);
  const read = await service.snapshot(IDENTITY);
  assert.equal(read.ok, true);
  assert.deepEqual(setup.calls, { releases: 1, items: 1, commands: 0 });
  assert.equal(setup.contexts[0]?.actorKind, 'user');
  assert.equal(setup.contexts[0]?.workspaceId, PRINCIPAL.workspaceId);
  assert.deepEqual(
    setup.contexts[0]?.portalSessionTokenHash,
    createHash('sha256').update(SESSION).digest(),
  );

  const input = quarantineInput(setup.snapshot);
  const result = await service.quarantine(IDENTITY, input);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.outcome, 'quarantined');
    assert.equal(result.releaseItemId, input.releaseItemId);
    assert.equal(result.evidenceSha256, input.itemContentSha256);
    assert.equal(result.providerEffects, false);
  }
  assert.equal(setup.calls.commands, 1);
  assert.equal('clear' in service, false);
  assert.equal('approve' in service, false);
  assert.equal('publish' in service, false);
});

test('PostgreSQL company-assets service rejects clear, arbitrary evidence and non-manager commands before write', async () => {
  const setup = dependencies();
  const service = new PgPortalCompanyAssetsService(setup.deps);
  const input = quarantineInput(setup.snapshot);

  const clear = await service.quarantine(IDENTITY, {
    ...input,
    outcome: 'clear',
  } as never);
  assert.equal(clear.ok, false);
  if (!clear.ok) assert.equal(clear.kind, 'review_unavailable');

  const arbitraryEvidence = await service.quarantine(IDENTITY, {
    ...input,
    evidenceSha256: 'f'.repeat(64),
  });
  assert.equal(arbitraryEvidence.ok, false);
  if (!arbitraryEvidence.ok) assert.equal(arbitraryEvidence.kind, 'validation');
  assert.equal(setup.calls.commands, 0);

  const forbiddenSetup = dependencies({
    accessReader: {
      load: async () => ({ ...setup.snapshot.workspace, canManage: false }),
    },
  });
  const forbidden = await new PgPortalCompanyAssetsService(forbiddenSetup.deps)
    .quarantine(IDENTITY, input);
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.kind, 'forbidden');
  assert.equal(forbiddenSetup.calls.commands, 0);
});

test('PostgreSQL company-assets service rejects malformed command results', async () => {
  const setup = dependencies({
    commandService: {
      decideQuarantine: async (_context, command) => {
        if (command.outcome !== 'quarantined') throw new Error('unexpected clear command');
        return {
          disposition: 'applied',
          quarantineDecisionId: 'a7500000-0000-4000-8000-000000000001',
          sourceReleaseId: command.sourceReleaseId,
          releaseItemId: 'a7200000-0000-4000-8000-000000000099',
          itemType: command.itemType,
          itemId: command.itemId,
          itemContentSha256: command.itemContentSha256,
          itemBrandSha256: command.itemBrandSha256,
          dimension: command.dimension,
          outcome: command.outcome,
          reasonCode: command.reasonCode,
          evidenceSha256: command.evidenceSha256,
          providerEffects: false,
        };
      },
    },
  });
  const result = await new PgPortalCompanyAssetsService(setup.deps)
    .quarantine(IDENTITY, quarantineInput(setup.snapshot));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, 'exact_item_conflict');
});
