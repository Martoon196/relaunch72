import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import { createPropertyPredatorBrandBrainFixture } from '../src/portal/brand-brain-fixtures.js';
import type {
  PortalBrandBrainRequestIdentity,
  PortalBrandBrainService,
} from '../src/portal/brand-brain-service.js';
import {
  CAMPAIGN_WIZARD_CREATE_TEST_ROUTE,
  CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE,
  CAMPAIGN_WIZARD_ROUTE,
  campaignWizardNoticeFromQuery,
  campaignWizardNoticeToken,
} from '../src/portal/campaign-wizard-actions.js';
import {
  PropertyPredatorGenerationBridgeError,
  type PropertyPredatorGenerateDraftCommand,
} from '../src/company-content-adapter/property-predator-generation.js';
import { planPropertyPredatorMarketingDraft } from '../src/company-content-adapter/property-predator-marketing-draft-plan.js';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import type { PortalCompanyContentService } from '../src/portal/company-content-service.js';
import { createPropertyPredatorContentCatalogFixture } from '../src/portal/content-control-room-fixtures.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import type {
  PortalCancelPublicSocialPlanningTargetInput,
  PortalCreatePublicSocialCampaignPlanInput,
  PortalPublicSocialRequestIdentity,
  PortalPublicSocialService,
  PortalReschedulePublicSocialTargetInput,
} from '../src/portal/public-social-service.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';
import type {
  SocialPlannerTargetProjection,
  SocialPlanningCalendarProjection,
} from '../src/social-campaign-pg/types.js';

const SECRET = 'planning-mutations-router-session-secret';
const SESSION = Buffer.alloc(32, 73).toString('base64url');
const OTHER_SESSION = Buffer.alloc(32, 74).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const NOW = '2026-08-27T12:00:00.000Z';
const CONTENT_CALENDAR_ROUTE = '/portal/content/calendar';
const RESCHEDULE_ROUTE = '/portal/content/calendar/test-reschedule';
const CANCEL_ROUTE = '/portal/content/calendar/test-cancel';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const IDS = Object.freeze({
  workspace: '91000000-0000-4000-8000-000000000001',
  user: '92000000-0000-4000-8000-000000000001',
  campaign: '93000000-0000-4000-8000-000000000001',
  revision: '94000000-0000-4000-8000-000000000001',
  intent: '95000000-0000-4000-8000-000000000001',
  successorIntent: '95000000-0000-4000-8000-000000000002',
  targetOne: '96000000-0000-4000-8000-000000000001',
  targetTwo: '96000000-0000-4000-8000-000000000002',
  contentItem: '97000000-0000-4000-8000-000000000001',
  contentVersion: '98000000-0000-4000-8000-000000000001',
  mediaOne: '99000000-0000-4000-8000-000000000001',
  mediaTwo: '99000000-0000-4000-8000-000000000002',
});

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: IDS.user,
    userEmail: 'owner@propertypredator.test',
    workspaceId: IDS.workspace,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: {
      id: IDS.workspace,
      name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      snapshotAt: NOW,
      canWrite: true,
    },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: {
      id: IDS.workspace,
      name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      snapshotAt: NOW,
      canWrite: true,
    },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function postgres(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: SECRET,
    secure: false,
    requestId: () => 'planning-mutations-router-request',
    now: () => Date.parse(NOW),
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth,
    crm,
    ...overrides,
  };
}

function request(method: 'GET' | 'POST', url: string, cookie?: string, body = '') {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = {
    ...(cookie ? { cookie } : {}),
    ...(method === 'POST' ? {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    } : {}),
  };
  setImmediate(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function response() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers?: Record<string, string | string[]>) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(headers ?? {})) {
        this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join('\n') : value;
      }
      return this;
    },
    end(body?: string) { if (body) this.body = body; },
  };
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  deps: PostgresPortalDeps,
  form?: URLSearchParams,
  cookie = COOKIE,
) {
  const res = response();
  await handlePortal(
    request(method, url, cookie, form?.toString() ?? '') as never,
    res as never,
    deps,
  );
  return res;
}

function target(
  targetId: string,
  network: SocialPlannerTargetProjection['network'],
  targetLabel: string,
): SocialPlannerTargetProjection {
  return Object.freeze({
    targetId,
    network,
    targetLabel,
    environment: 'test',
    providerEffects: 'none',
  });
}

function planningRow(
  overrides: Partial<SocialPlanningCalendarProjection> = {},
): SocialPlanningCalendarProjection {
  return Object.freeze({
    intentId: IDS.intent,
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 1,
    campaignTitle: 'Evidence Week',
    desiredFor: '2026-08-28T09:30:00.000Z',
    contentItemId: IDS.contentItem,
    contentVersionId: IDS.contentVersion,
    contentSha256: 'a'.repeat(64),
    intentSha256: 'b'.repeat(64),
    targetId: IDS.targetOne,
    network: 'linkedin',
    targetLabel: 'LinkedIn owned TEST rail',
    planningState: 'awaiting_revalidation',
    materializedPostId: null,
    materializedOperationId: null,
    operationState: null,
    revalidationState: 'waiting_for_window',
    nextRevalidationAt: '2026-08-28T08:30:00.000Z',
    lastErrorCode: null,
    updatedAt: '2026-08-27T11:45:00.000Z',
    environment: 'test',
    providerEffects: 'none',
    ...overrides,
  });
}

interface SocialCalls {
  snapshots: Array<Readonly<{ identity: PortalPublicSocialRequestIdentity; input: unknown }>>;
  plans: Array<Readonly<{
    identity: PortalPublicSocialRequestIdentity;
    input: PortalCreatePublicSocialCampaignPlanInput;
  }>>;
  reschedules: Array<Readonly<{
    identity: PortalPublicSocialRequestIdentity;
    input: PortalReschedulePublicSocialTargetInput;
  }>>;
  cancels: Array<Readonly<{
    identity: PortalPublicSocialRequestIdentity;
    input: PortalCancelPublicSocialPlanningTargetInput;
  }>>;
}

function socialService(
  calls: SocialCalls,
  row: SocialPlanningCalendarProjection = planningRow(),
): PortalPublicSocialService {
  return {
    snapshot: async (identity, input) => {
      calls.snapshots.push({ identity, input });
      return {
        ok: true,
        snapshot: {
          workspace: {
            workspaceId: IDS.workspace,
            workspaceName: 'Property Predator Growth HQ',
            timezone: 'Europe/London',
            snapshotAt: NOW,
            canManage: true,
          },
          campaign: { items: [], hasMore: false },
          calendar: { items: [], hasMore: false },
          planning: {
            targets: {
              items: [
                target(IDS.targetOne, 'linkedin', 'LinkedIn owned TEST rail'),
                target(IDS.targetTwo, 'instagram', 'Instagram owned TEST rail'),
              ],
              hasMore: false,
            },
            calendar: { items: [row], hasMore: false },
          },
          environment: 'test',
          providerEffects: 'none',
        },
      };
    },
    createRevision: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    createCampaignPlan: async (identity, input) => {
      calls.plans.push({ identity, input });
      return {
        ok: true,
        result: {
          campaignId: IDS.campaign,
          revisionId: IDS.revision,
          intentId: IDS.intent,
          intentSha256: row.intentSha256,
          disposition: 'applied',
        },
        environment: 'test',
        providerEffects: 'none',
      };
    },
    reschedule: async (identity, input) => {
      calls.reschedules.push({ identity, input });
      return {
        ok: true,
        result: { successorIntentId: IDS.successorIntent, disposition: 'applied' },
        environment: 'test',
        providerEffects: 'none',
      };
    },
    cancel: async (identity, input) => {
      calls.cancels.push({ identity, input });
      return {
        ok: true,
        result: {
          intentId: input.intentId,
          targetId: input.targetId,
          state: 'cancelled',
          disposition: 'applied',
        },
        environment: 'test',
        providerEffects: 'none',
      };
    },
  };
}

function freshCalls(): SocialCalls {
  return { snapshots: [], plans: [], reschedules: [], cancels: [] };
}

function contentService(
  brandSha256?: string,
  empty = false,
  workspaceId: string = IDS.workspace,
  approvalDecisionId?: string,
): PortalCompanyContentService {
  const fixture = createPropertyPredatorContentCatalogFixture();
  const copy = fixture.items[0]!;
  const artwork = fixture.items[2]!;
  return {
    snapshot: async () => ({
      ok: true,
      snapshot: {
        workspace: {
          workspaceId,
          workspaceName: 'Property Predator Growth HQ',
          snapshotAt: NOW,
          canWrite: true,
          canManage: true,
        },
        catalog: {
          items: empty ? [] : [
            Object.freeze({
              ...copy,
              contentItemId: IDS.contentItem,
              contentVersionId: IDS.contentVersion,
              contentSha256: 'a'.repeat(64),
              ...(brandSha256 ? { brandSha256 } : {}),
              ...(approvalDecisionId ? { approvalDecisionId } : {}),
              sourceCheckedAt: '2026-08-27T11:55:00.000Z',
              sourceExpiresAt: '2026-08-27T12:05:00.000Z',
              sourceFresh: true,
              publishable: true,
            }),
            Object.freeze({
              ...artwork,
              contentVersionId: IDS.mediaOne,
              ...(brandSha256 ? { brandSha256 } : {}),
              approvalStatus: 'approved' as const,
              approvalStale: false,
              sourceCheckedAt: '2026-08-27T11:55:00.000Z',
              sourceExpiresAt: '2026-08-27T12:05:00.000Z',
              sourceFresh: true,
              publishable: true,
            }),
          ],
          nextCursor: null,
        },
      },
    }),
    requestApproval: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    decideApproval: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  };
}

function readyBrandBrainSnapshot() {
  const fixture = JSON.parse(JSON.stringify(createPropertyPredatorBrandBrainFixture())) as
    ReturnType<typeof createPropertyPredatorBrandBrainFixture>;
  return {
    ...fixture,
    workspace: { ...fixture.workspace, workspaceId: IDS.workspace, canManage: true },
    brain: {
      ...fixture.brain,
      activated: true,
      sourceFresh: true,
      evaluationPassed: true,
      visualPolicyConflict: false,
      reviews: [
        ...fixture.brain.reviews,
        {
          dimension: 'brand_readiness' as const,
          decision: 'approved' as const,
          decisionId: 'b3000000-0000-4000-8000-000000000003',
        },
      ],
      specialists: fixture.brain.specialists.map((profile) => (
        profile.profileId === 'propertypredator.owned.social/v1'
          ? { ...profile, capabilities: ['post', 'thread'], runtimeReady: true, blockedReason: null }
          : profile
      )),
    },
  };
}

function readyBrandBrainService(): PortalBrandBrainService {
  return { snapshot: async () => ({ ok: true, snapshot: readyBrandBrainSnapshot() }) };
}

function campaignGenerationRuntime(
  calls: PropertyPredatorGenerateDraftCommand[],
  beforeReturn?: (command: PropertyPredatorGenerateDraftCommand) => Promise<void>,
) {
  return {
    generateAndStage: async (_identity: unknown, input: any) => {
        const command: PropertyPredatorGenerateDraftCommand = {
          ...input.generation,
          contextSha256: digest(canonicalCompanyContentJson(input.draftPlan)),
        };
        calls.push(command);
        await beforeReturn?.(command);
        const payload = Object.freeze({
          body: 'The headline gets attention. The evidence earns the next decision.',
          contextSha256: command.contextSha256,
          cta_url: 'https://propertypredator.com/learn',
          kind: 'post' as const,
          platform: command.brief.platform,
          schema: 'propertypredator.company-content/v1' as const,
          title: 'Start with the evidence',
          type: 'generated' as const,
        });
        const usage = Object.freeze({
          accountingState: 'provider_tokens_unpriced' as const,
          inputTokens: 700,
          outputTokens: 140,
          model: 'test-company-content-model',
          providerRequestId: 'provider-request-review-router-0001',
        });
        const draft = {
          ok: true as const,
          schemaVersion: 1 as const,
          brandSha256: command.expectedBrandSha256,
          contentSha256: digest(canonicalCompanyContentJson(payload)),
          contextSha256: command.contextSha256,
          draftId: 'd1000000-0000-4000-8000-000000000001',
          itemVersion: 1,
          payload,
          status: 'source_review_required' as const,
          usage,
          usageSha256: digest(canonicalCompanyContentJson(usage)),
          versionId: 'd2000000-0000-4000-8000-000000000001',
        };
        const ordinal = ['linkedin', 'facebook', 'instagram', 'x', 'tiktok']
          .indexOf(command.brief.platform) + 1;
        return { ok: true as const, draft: {
          status: 'draft' as const,
          approvalStatus: 'unrequested' as const,
          reviewRequired: true as const,
          publishable: false as const,
          providerEffects: false as const,
          disposition: 'applied' as const,
          sourceItemId: draft.draftId,
          sourceDraftId: draft.draftId,
          sourceVersionId: draft.versionId,
          sourceItemVersion: 1,
          planSha256: digest('plan'),
          brandSha256: draft.brandSha256,
          usageSha256: draft.usageSha256,
          generationContextSha256: command.contextSha256,
          draft,
          reviewTarget: {
            contentItemId: `97000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`,
            contentVersionId: `98000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`,
            versionNumber: 1,
            contentSha256: draft.contentSha256,
          },
        }};
    },
  };
}

function brandBrainService(calls: PortalBrandBrainRequestIdentity[]): PortalBrandBrainService {
  return {
    snapshot: async (identity) => {
      calls.push(identity);
      const fixture = createPropertyPredatorBrandBrainFixture();
      return {
        ok: true,
        snapshot: {
          ...fixture,
          workspace: { ...fixture.workspace, workspaceId: IDS.workspace },
        },
      };
    },
  };
}

function baseCreateForm(): URLSearchParams {
  const form = new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: 'campaign-command-0001',
    environment: 'test',
    timezone: 'Europe/London',
    return_to: CONTENT_CALENDAR_ROUTE,
    title: 'Property Predator evidence sprint',
    objective: 'Prove an owned education rhythm using exact approved company assets.',
    content_version_id: IDS.contentVersion,
    desired_for_local: '2026-08-28T10:30',
    max_attempts: '2',
    confirm_test_only: 'confirmed',
  });
  form.append('target_ids', IDS.targetOne.toUpperCase());
  form.append('target_ids', IDS.targetTwo);
  form.append('media_version_ids', IDS.mediaOne);
  form.append('media_version_ids', IDS.mediaTwo.toUpperCase());
  return form;
}

function baseReviewDraftForm(): URLSearchParams {
  const snapshot = readyBrandBrainSnapshot();
  const plan = planPropertyPredatorMarketingDraft({
    selection: 'property-predator-self-serve:activated',
    brandBrainSnapshot: snapshot,
  });
  return new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: 'campaign-review-draft-command-0001',
    expected_plan_sha256: plan.planSha256,
    laps: plan.selection.key,
    provider_effects: 'generation_only',
    platform: 'linkedin',
    tone: 'direct and useful',
    topic: 'Show why evidence should earn the next property decision.',
    approved_fact_version_id: IDS.contentVersion,
    approved_asset_version_id: IDS.mediaOne,
    confirm_generation_only: 'confirmed',
  });
}

function baseCalendarForm(kind: 'reschedule' | 'cancel'): URLSearchParams {
  const form = new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: `${kind}-command-0001`,
    intent_id: IDS.intent,
    target_id: IDS.targetOne,
    intent_sha256: 'b'.repeat(64),
    expected_updated_at: '2026-08-27T11:45:00.000Z',
    reason: kind === 'reschedule' ? 'Move this TEST rehearsal after review.' : 'Stop this obsolete TEST target.',
    return_mode: 'week',
    return_date: '2026-08-28',
    return_channel: 'linkedin',
  });
  if (kind === 'reschedule') {
    form.set('desired_for_local', '2026-08-29T11:00');
    form.set('confirm_change', 'confirmed');
  } else {
    form.set('confirm_cancel', 'confirmed');
  }
  return form;
}

test('GET campaign wizard joins safe company content and TEST targets into one protected form', async () => {
  const calls = freshCalls();
  const brandCalls: PortalBrandBrainRequestIdentity[] = [];
  const result = await call('GET', `${CAMPAIGN_WIZARD_ROUTE}?laps=property-predator-agency-laps%3Apresentation`, postgres({
    publicSocial: socialService(calls),
    companyContent: contentService(),
    brandBrain: brandBrainService(brandCalls),
  }));

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /One idea\. <em>Every channel\.<\/em>/);
  assert.match(result.body, new RegExp(`action="${CAMPAIGN_WIZARD_CREATE_TEST_ROUTE}"`));
  assert.match(result.body, new RegExp(`name="content_version_id" value="${IDS.contentVersion}"`));
  assert.match(result.body, new RegExp(`name="media_version_ids" value="${IDS.mediaOne}"`));
  assert.match(result.body, new RegExp(`name="target_ids" value="${IDS.targetOne}"`));
  assert.match(result.body, new RegExp(`name="target_ids" value="${IDS.targetTwo}"`));
  assert.match(result.body, /data-environment="test"/);
  assert.match(result.body, /data-provider-effects="none"/);
  assert.match(result.body, /data-marketing-draft-preflight/);
  assert.match(result.body, /Your chosen goal[\s\S]*Presentation/);
  assert.match(result.body, /value="property-predator-agency-laps:presentation" selected/);
  assert.match(result.body, /Offer Architect/);
  assert.match(result.body, /Writing methods/);
  assert.doesNotMatch(result.body, /Generate with AI|Run specialist|Call model/i);
  assert.doesNotMatch(
    result.body,
    /name="(?:body|body_text|provider|provider_id|connection_id|account_ref|storage_key|credential|publish)"/i,
  );
  assert.equal(calls.snapshots.length, 1);
  assert.deepEqual(calls.snapshots[0]?.identity, {
    sessionToken: SESSION,
    requestId: 'planning-mutations-router-request',
  });
  assert.deepEqual(brandCalls, [{
    sessionToken: SESSION,
    requestId: 'planning-mutations-router-request',
  }]);
});

test('Campaign Wizard stays operational and makes Brand Brain failure a visible draft-only blocker', async () => {
  const calls = freshCalls();
  const result = await call('GET', CAMPAIGN_WIZARD_ROUTE, postgres({
    publicSocial: socialService(calls),
    companyContent: contentService(),
    brandBrain: {
      snapshot: async () => { throw new Error('private infrastructure detail'); },
    },
  }));

  assert.equal(result.statusCode, 200);
  assert.match(result.body, /Brand Brain metadata is unavailable/);
  assert.match(result.body, new RegExp(`action="${CAMPAIGN_WIZARD_CREATE_TEST_ROUTE}"`));
  assert.doesNotMatch(result.body, /private infrastructure detail/);
});

test('Campaign Wizard exposes one exact generation-only form only when the runtime and evidence align', async () => {
  const brain = readyBrandBrainSnapshot();
  const generationCalls: PropertyPredatorGenerateDraftCommand[] = [];
  const result = await call('GET', CAMPAIGN_WIZARD_ROUTE, postgres({
    publicSocial: socialService(freshCalls()),
    companyContent: contentService(brain.brain.runtimeBrandSha256),
    brandBrain: readyBrandBrainService(),
    campaignDrafts: campaignGenerationRuntime(generationCalls),
  }));

  assert.equal(result.statusCode, 200);
  assert.match(result.body, new RegExp(`action="${CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE}"`));
  assert.match(result.body, /Create posts for every channel/);
  assert.match(result.body, /name="platform" value="linkedin" checked/);
  assert.match(result.body, /name="platform" value="facebook" checked/);
  assert.match(result.body, /name="platform" value="instagram" checked/);
  assert.match(result.body, /name="platform" value="x" checked/);
  assert.match(result.body, /name="platform" value="tiktok" checked/);
  assert.match(result.body, /data-channel-pack-form/);
  assert.match(result.body, /data-pack-media-drop/);
  assert.doesNotMatch(result.body, /data-media-upload-url/);
  assert.match(result.body, /src="\/portal\/assets\/campaign-wizard\.js"/);
  assert.match(result.body, /name="topic" maxlength="20000"/);
  assert.match(result.body, /What do you want to talk about\?/);
  assert.match(result.body, /Type a rough idea or paste notes, a transcript, an article or a post\./);
  assert.doesNotMatch(result.body, /Paste your original content/);
  assert.match(result.body, /data-draft-generation-progress role="status" aria-live="polite" hidden/);
  assert.match(result.body, /name="approved_fact_version_id"/);
  assert.match(result.body, /name="approved_asset_version_id"/);
  assert.match(result.body, /name="provider_effects" value="generation_only"/);
  assert.match(result.body, /name="confirm_generation_only" value="confirmed"/);
  assert.match(result.body, />Create my drafts<\/button>/);
  assert.match(result.body, /<summary>Advanced source settings<\/summary>/);
  assert.match(result.body, /data-outbound-effects="none"/);
  assert.doesNotMatch(result.body, /name="(?:workspace_id|provider_id|credential|send|schedule|publish)"/i);
  assert.equal(generationCalls.length, 0);
});

test('Campaign Wizard locks a valid draft generation submit before the browser can send it twice', async () => {
  const result = await call('GET', '/portal/assets/campaign-wizard.js', postgres());

  assert.equal(result.statusCode, 200);
  assert.match(result.body, /let submitted = false/);
  assert.match(result.body, /if \(submitted\) \{ event\.preventDefault\(\); return; \}/);
  assert.match(result.body, /submitted = true/);
  assert.match(result.body, /form\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(result.body, /submit\.disabled = true/);
  assert.match(result.body, /Creating your drafts… You can stay on this page while we work\./);
  assert.match(result.body, /seconds elapsed/);
});

test('Campaign Wizard exposes the five-channel review composer without pre-seeded catalogue evidence', async () => {
  const brain = readyBrandBrainSnapshot();
  brain.brain.sourceFresh = false;
  brain.brain.visualPolicyConflict = true;
  const generationCalls: PropertyPredatorGenerateDraftCommand[] = [];
  const result = await call('GET', CAMPAIGN_WIZARD_ROUTE, postgres({
    publicSocial: socialService(freshCalls()),
    companyContent: contentService(brain.brain.runtimeBrandSha256, true),
    brandBrain: { snapshot: async () => ({ ok: true, snapshot: brain }) },
    campaignDrafts: campaignGenerationRuntime(generationCalls),
  }));

  assert.equal(result.statusCode, 200);
  assert.match(result.body, /Create posts for every channel/);
  assert.match(result.body, /name="platform" value="tiktok" checked/);
  assert.match(result.body, /No approved fact pack is attached/);
  assert.match(result.body, /No approved library asset is attached/);
  assert.match(result.body, /data-pack-media-drop/);
  assert.match(result.body, /Nothing will be posted until you review it/i);
  assert.doesNotMatch(result.body, /brand brain not ready/);
  assert.equal(generationCalls.length, 0);
});

test('authenticated CSRF-bound campaign generation re-reads exact evidence and renders an unsendable review result', async () => {
  const brain = readyBrandBrainSnapshot();
  const generationCalls: PropertyPredatorGenerateDraftCommand[] = [];
  const result = await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256),
    brandBrain: readyBrandBrainService(),
    campaignDrafts: campaignGenerationRuntime(generationCalls),
  }), baseReviewDraftForm());

  assert.equal(result.statusCode, 303);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0]!.maximumCostMinor, 250);
  assert.equal(generationCalls[0]!.brief.kind, 'post');
  assert.equal(generationCalls[0]!.brief.platform, 'linkedin');
  assert.match(result.headers.location ?? '', /^\/portal\/content\/items\/97000000-0000-4000-8000-000000000001\/versions\/98000000-0000-4000-8000-000000000001\/review\?notice=/);
});

test('a validated prepared media variant remains visible beside a saved single-channel draft', async () => {
  const brain = readyBrandBrainSnapshot();
  const generationCalls: PropertyPredatorGenerateDraftCommand[] = [];
  const form = baseReviewDraftForm();
  form.append('media_variant', JSON.stringify({
    platform: 'linkedin', mediaType: 'image',
    url: 'https://media.zernio.com/prepared/linkedin.png',
    width: 1200, height: 630, contentSha256: '7'.repeat(64),
    treatment: 'browser_cover_crop',
  }));
  const result = await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256),
    brandBrain: readyBrandBrainService(),
    campaignDrafts: campaignGenerationRuntime(generationCalls),
  }), form);

  assert.equal(result.statusCode, 201);
  assert.equal(result.headers.location, undefined);
  assert.equal(generationCalls.length, 1);
  assert.match(result.body, /https:\/\/media\.zernio\.com\/prepared\/linkedin\.png/);
  assert.match(result.body, /linkedin feed post · media preview · not saved with this text version/i);
  assert.match(result.body, /Review saved version/);
  assert.match(result.body, /Nothing was posted/);
});

test('one source creates a native five-channel pack without any outbound effect', async () => {
  const brain = readyBrandBrainSnapshot();
  const generationCalls: PropertyPredatorGenerateDraftCommand[] = [];
  const form = baseReviewDraftForm();
  form.append('platform', 'facebook');
  form.append('platform', 'instagram');
  form.append('platform', 'x');
  form.append('platform', 'tiktok');
  form.set('topic', `${'A useful Property Predator source paragraph. '.repeat(20)}\nKeep the same claim.`);
  const result = await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256),
    brandBrain: readyBrandBrainService(),
    campaignDrafts: campaignGenerationRuntime(generationCalls),
  }), form);

  assert.equal(result.statusCode, 201);
  assert.deepEqual(generationCalls.map((call) => call.brief.platform), [
    'linkedin', 'facebook', 'instagram', 'x', 'tiktok',
  ]);
  assert.equal(new Set(generationCalls.map((call) => call.idempotencyKey)).size, 5);
  assert.ok(generationCalls.every((call) => call.brief.topic === form.get('topic')));
  assert.match(result.body, /Drafts saved\. <em>Review next\.<\/em>/);
  assert.match(result.body, /html\[data-theme="light"\] \.cdr/);
  assert.match(result.body, /Saved · review required/);
  assert.match(result.body, /Nothing was posted/);
  assert.match(result.body, /LinkedIn/i);
  assert.match(result.body, /Facebook/i);
  assert.match(result.body, /Instagram/i);
  assert.match(result.body, />x</i);
  assert.match(result.body, /TikTok/i);
  assert.match(result.body, /Review saved version/);
});

test('one source creates a five-channel review pack with no catalogue evidence', async () => {
  const brain = readyBrandBrainSnapshot();
  brain.brain.sourceFresh = false;
  brain.brain.visualPolicyConflict = true;
  const generationCalls: PropertyPredatorGenerateDraftCommand[] = [];
  const form = baseReviewDraftForm();
  form.set('expected_plan_sha256', planPropertyPredatorMarketingDraft({
    selection: 'property-predator-self-serve:activated',
    brandBrainSnapshot: brain,
  }).planSha256);
  form.delete('approved_fact_version_id');
  form.delete('approved_asset_version_id');
  form.append('platform', 'facebook');
  form.append('platform', 'instagram');
  form.append('platform', 'x');
  form.append('platform', 'tiktok');
  const result = await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256, true),
    brandBrain: { snapshot: async () => ({ ok: true, snapshot: brain }) },
    campaignDrafts: campaignGenerationRuntime(generationCalls),
  }), form);

  assert.equal(result.statusCode, 201);
  assert.equal(generationCalls.length, 5);
  assert.match(result.body, /Drafts saved\. <em>Review next\.<\/em>/);
  assert.match(result.body, /Nothing was posted/);
});

test('campaign generation rejects invalid CSRF and changed exact evidence before the provider runtime', async () => {
  const brain = readyBrandBrainSnapshot();
  const calls: PropertyPredatorGenerateDraftCommand[] = [];
  const dependencies = postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256),
    brandBrain: readyBrandBrainService(),
    campaignDrafts: campaignGenerationRuntime(calls),
  });
  const invalidCsrf = baseReviewDraftForm();
  invalidCsrf.set('_csrf', 'invalid');
  const invalid = await call(
    'POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, dependencies, invalidCsrf,
  );
  assert.equal(invalid.statusCode, 400);

  const stale = baseReviewDraftForm();
  stale.set('expected_plan_sha256', 'f'.repeat(64));
  const changed = await call(
    'POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, dependencies, stale,
  );
  assert.equal(changed.statusCode, 409);
  assert.equal(calls.length, 0);
});

test('five-channel generation runs as one bounded concurrent pack instead of multiplying request time', async () => {
  const brain = readyBrandBrainSnapshot();
  const generationCalls: PropertyPredatorGenerateDraftCommand[] = [];
  let releaseGeneration!: () => void;
  const generationGate = new Promise<void>((resolve) => { releaseGeneration = resolve; });
  const form = baseReviewDraftForm();
  form.append('platform', 'facebook');
  form.append('platform', 'instagram');
  form.append('platform', 'x');
  form.append('platform', 'tiktok');

  const pending = call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256),
    brandBrain: readyBrandBrainService(),
    campaignDrafts: campaignGenerationRuntime(generationCalls, async () => generationGate),
  }), form);
  for (let attempt = 0; attempt < 20 && generationCalls.length < 5; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const callsStartedBeforeAnyCompleted = generationCalls.length;
  releaseGeneration();
  const result = await pending;

  assert.equal(callsStartedBeforeAnyCompleted, 5);
  assert.equal(result.statusCode, 201);
  assert.deepEqual(generationCalls.map((call) => call.brief.platform), [
    'linkedin', 'facebook', 'instagram', 'x', 'tiktok',
  ]);
});

test('a channel failure keeps successful saved versions reviewable without claiming the pack completed', async () => {
  const brain = readyBrandBrainSnapshot();
  const generationCalls: PropertyPredatorGenerateDraftCommand[] = [];
  const form = baseReviewDraftForm();
  form.append('platform', 'facebook');
  const result = await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256),
    brandBrain: readyBrandBrainService(),
    campaignDrafts: campaignGenerationRuntime(generationCalls, async (command) => {
      if (command.brief.platform === 'facebook') throw new Error('synthetic save failure');
    }),
  }), form);

  assert.equal(result.statusCode, 207);
  assert.equal(generationCalls.length, 2);
  assert.match(result.body, /Some channels could not be saved/);
  assert.match(result.body, /facebook/i);
  assert.match(result.body, /Review saved version/);
  assert.doesNotMatch(result.body, /Facebook<\/strong><span>Saved/);
  assert.match(result.body, /Retry only failed channels/);
  assert.match(result.body, /name="command_key" value="campaign-review-draft-command-0001"/);
  assert.match(result.body, /name="platform" value="facebook"/);
  assert.doesNotMatch(result.body, /name="platform" value="linkedin"/);
});

test('failed-channel retry reuses exact generation and persistence identities without rerunning saved channels', async () => {
  const brain = readyBrandBrainSnapshot();
  const observed: Array<{ platform: string; generation: string; persistence: string }> = [];
  let failFacebookSave = true;
  const baseRuntime = campaignGenerationRuntime([]);
  const campaignDrafts = {
    generateAndStage: async (identity: any, input: any) => {
      observed.push({
        platform: input.generation.brief.platform,
        generation: input.generation.idempotencyKey,
        persistence: input.persistenceCommandKey,
      });
      if (input.generation.brief.platform === 'facebook' && failFacebookSave) {
        return { ok: false as const, kind: 'unavailable' as const, message: 'Save unavailable.' };
      }
      return baseRuntime.generateAndStage(identity, input);
    },
  };
  const initial = baseReviewDraftForm();
  initial.append('platform', 'facebook');
  const first = await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256),
    brandBrain: readyBrandBrainService(), campaignDrafts,
  }), initial);
  assert.equal(first.statusCode, 207);

  failFacebookSave = false;
  const retry = baseReviewDraftForm();
  retry.delete('platform');
  retry.append('platform', 'facebook');
  const evidenceHash = first.body.match(/name="expected_evidence_sha256" value="([0-9a-f]{64})"/)?.[1];
  assert.ok(evidenceHash);
  retry.set('expected_evidence_sha256', evidenceHash);
  const second = await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256),
    brandBrain: readyBrandBrainService(), campaignDrafts,
  }), retry);
  assert.equal(second.statusCode, 303);

  assert.deepEqual(observed.map((item) => item.platform), ['linkedin', 'facebook', 'facebook']);
  assert.equal(observed[1]!.generation, observed[2]!.generation);
  assert.equal(observed[1]!.persistence, observed[2]!.persistence);
  assert.equal(observed.filter((item) => item.platform === 'linkedin').length, 1);

  const changedEvidence = await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256, false, IDS.workspace,
      '99000000-0000-4000-8000-000000000099'),
    brandBrain: readyBrandBrainService(), campaignDrafts,
  }), retry);
  assert.equal(changedEvidence.statusCode, 409);
  assert.match(changedEvidence.body, /evidence for this retry changed/);
  assert.equal(observed.length, 3, 'a changed approval cannot turn a retry into a newly charged generation');
});

test('draft replay keys bind workspace, topic and exact approved evidence so changed intent cannot alias', async () => {
  const brain = readyBrandBrainSnapshot();
  const observed: Array<{ generation: string; persistence: string }> = [];
  const service = campaignGenerationRuntime([]);
  const capturing = {
    generateAndStage: async (identity: any, input: any) => {
      observed.push({ generation: input.generation.idempotencyKey, persistence: input.persistenceCommandKey });
      return service.generateAndStage(identity, input);
    },
  };
  const base = baseReviewDraftForm();
  await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256), brandBrain: readyBrandBrainService(), campaignDrafts: capturing,
  }), base);
  const laterSnapshotService = contentService(brain.brain.runtimeBrandSha256);
  await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: {
      ...laterSnapshotService,
      snapshot: async (identity) => {
        const outcome = await laterSnapshotService.snapshot(identity);
        return outcome.ok ? { ...outcome, snapshot: {
          ...outcome.snapshot,
          workspace: { ...outcome.snapshot.workspace, snapshotAt: '2026-09-08T04:05:06.000Z' },
        } } : outcome;
      },
    },
    brandBrain: readyBrandBrainService(), campaignDrafts: capturing,
  }), baseReviewDraftForm());
  const changedTopic = baseReviewDraftForm();
  changedTopic.set('topic', 'A materially different source topic.');
  await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256), brandBrain: readyBrandBrainService(), campaignDrafts: capturing,
  }), changedTopic);
  await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256, false, '91000000-0000-4000-8000-000000000002'),
    brandBrain: { snapshot: async () => ({ ok: true as const, snapshot: {
      ...readyBrandBrainSnapshot(),
      workspace: { ...readyBrandBrainSnapshot().workspace, workspaceId: '91000000-0000-4000-8000-000000000002' },
    } }) },
    campaignDrafts: capturing,
  }), baseReviewDraftForm());

  await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(
      brain.brain.runtimeBrandSha256,
      false,
      IDS.workspace,
      '99000000-0000-4000-8000-000000000099',
    ),
    brandBrain: readyBrandBrainService(),
    campaignDrafts: capturing,
  }), baseReviewDraftForm());

  assert.equal(new Set(observed.map((item) => item.generation)).size, 4);
  assert.equal(new Set(observed.map((item) => item.persistence)).size, 4);
  assert.deepEqual(observed[1], observed[0]);
});

test('campaign generation explains an unusable source without inventing an evidence mismatch', async () => {
  const brain = readyBrandBrainSnapshot();
  const campaignDrafts = {
    generateAndStage: async () => ({
      ok: false as const,
      kind: 'unavailable' as const,
      message: new PropertyPredatorGenerationBridgeError('upstream_rejected').message,
    }),
  };
  const result = await call('POST', CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE, postgres({
    companyContent: contentService(brain.brain.runtimeBrandSha256),
    brandBrain: readyBrandBrainService(),
    campaignDrafts,
  }), baseReviewDraftForm());

  assert.equal(result.statusCode, 503);
  assert.match(result.body, /Drafts could not be saved/);
  assert.match(result.body, /Retry only failed channels/);
  assert.match(result.body, /name="command_key" value="campaign-review-draft-command-0001"/);
  assert.doesNotMatch(result.body, /evidence did not match|integrity mismatch/i);
});

test('production calendar CSP permits its same-origin protected mutation enhancement', async () => {
  const calls = freshCalls();
  const result = await call('GET', CONTENT_CALENDAR_ROUTE, postgres({
    publicSocial: socialService(calls),
    companyContent: contentService(),
  }));

  assert.equal(result.statusCode, 200);
  assert.match(result.headers['content-security-policy'] ?? '', /connect-src 'self'/);
  assert.match(result.body, /\/portal\/assets\/content-calendar\.js/);
  assert.match(result.body, new RegExp(`action="${RESCHEDULE_ROUTE}"`));
  assert.match(result.body, new RegExp(`action="${CANCEL_ROUTE}"`));
});

test('atomic wizard POST preserves repeated targets/media and exposes only browser-safe IDs', async () => {
  const calls = freshCalls();
  const result = await call('POST', CAMPAIGN_WIZARD_CREATE_TEST_ROUTE, postgres({
    publicSocial: socialService(calls),
    companyContent: contentService(),
  }), baseCreateForm());

  assert.equal(result.statusCode, 303);
  assert.match(result.headers.location ?? '', /^\/portal\/content\/calendar\?notice=planned\./);
  assert.equal(calls.plans.length, 1);
  assert.deepEqual(calls.plans[0], {
    identity: {
      sessionToken: SESSION,
      requestId: 'planning-mutations-router-request',
    },
    input: {
      commandKey: 'campaign-command-0001',
      title: 'Property Predator evidence sprint',
      objective: 'Prove an owned education rhythm using exact approved company assets.',
      contentVersionId: IDS.contentVersion,
      desiredFor: '2026-08-28T09:30:00.000Z',
      maxAttempts: 2,
      targetIds: [IDS.targetOne, IDS.targetTwo],
      mediaVersionIds: [IDS.mediaOne, IDS.mediaTwo],
    },
  });
  const input = calls.plans[0]!.input as unknown as Record<string, unknown>;
  for (const unsafe of [
    'workspaceId', 'body', 'bodyText', 'provider', 'providerId', 'connectionId',
    'testAccountRef', 'storageKey', 'credential', 'publish',
  ]) assert.equal(Object.hasOwn(input, unsafe), false, `${unsafe} escaped into command DTO`);
});

test('wizard POST rejects CSRF, duplicate singleton, unknown fields and DST gap/fold fail closed', async () => {
  const calls = freshCalls();
  const service = socialService(calls);
  const invalidForms: URLSearchParams[] = [];

  const csrf = baseCreateForm();
  csrf.set('_csrf', 'invalid-csrf');
  invalidForms.push(csrf);

  const duplicate = baseCreateForm();
  duplicate.append('title', 'Attacker-selected duplicate');
  invalidForms.push(duplicate);

  const unknown = baseCreateForm();
  unknown.set('provider_id', 'live-provider-forgery');
  invalidForms.push(unknown);

  const springGap = baseCreateForm();
  springGap.set('desired_for_local', '2026-03-29T01:30');
  invalidForms.push(springGap);

  const autumnFold = baseCreateForm();
  autumnFold.set('desired_for_local', '2026-10-25T01:30');
  invalidForms.push(autumnFold);

  for (const form of invalidForms) {
    const result = await call('POST', CAMPAIGN_WIZARD_CREATE_TEST_ROUTE, postgres({
      publicSocial: service,
      companyContent: contentService(),
    }), form);
    assert.equal(result.statusCode, 303);
    assert.match(result.headers.location ?? '', /^\/portal\/campaigns\/new\?notice=invalid\./);
    assert.doesNotMatch(result.headers.location ?? '', /live-provider-forgery|Attacker-selected/);
  }

  assert.equal(calls.plans.length, 0);
  assert.equal(calls.snapshots.length, 2, 'only the two structurally valid DST forms may read timezone truth');
  assert.equal(calls.reschedules.length, 0);
  assert.equal(calls.cancels.length, 0);
});

test('PRG mutation notices are allowlisted, signed and bound to the authenticated session', async () => {
  const calls = freshCalls();
  const deps = postgres({ publicSocial: socialService(calls), companyContent: contentService() });
  const posted = await call('POST', CAMPAIGN_WIZARD_CREATE_TEST_ROUTE, deps, baseCreateForm());
  const location = posted.headers.location ?? '';
  const redirectQuery = new URL(location, 'https://growth-hq.invalid').searchParams;
  const verified = campaignWizardNoticeFromQuery(redirectQuery, SECRET, SESSION);
  assert.equal(verified?.title, 'Durable TEST campaign planned');
  assert.match(verified?.detail ?? '', /No provider was called/);
  assert.equal(campaignWizardNoticeFromQuery(redirectQuery, SECRET, OTHER_SESSION), undefined);

  const safeToken = campaignWizardNoticeToken(SECRET, SESSION, 'planned');
  const safePage = await call(
    'GET',
    `${CAMPAIGN_WIZARD_ROUTE}?notice=${encodeURIComponent(safeToken)}`,
    deps,
  );
  assert.equal(safePage.statusCode, 200);
  assert.match(safePage.body, /Durable TEST campaign planned/);
  assert.match(safePage.body, /No provider was called/);

  const forgedPage = await call(
    'GET',
    `${CAMPAIGN_WIZARD_ROUTE}?notice=planned.attacker&detail=RAW_PROVIDER_SECRET`,
    deps,
  );
  assert.equal(forgedPage.statusCode, 200);
  assert.doesNotMatch(forgedPage.body, /Durable TEST campaign planned|RAW_PROVIDER_SECRET/);
});

test('calendar reschedule and cancel reject stale evidence before either mutation runs', async () => {
  const calls = freshCalls();
  const service = socialService(calls);

  const staleSha = baseCalendarForm('reschedule');
  staleSha.set('intent_sha256', 'c'.repeat(64));
  const reschedule = await call('POST', RESCHEDULE_ROUTE, postgres({ publicSocial: service }), staleSha);
  assert.equal(reschedule.statusCode, 303);
  assert.match(reschedule.headers.location ?? '', /notice=conflict\./);
  assert.match(reschedule.headers.location ?? '', /mode=week/);
  assert.match(reschedule.headers.location ?? '', /date=2026-08-28/);
  assert.match(reschedule.headers.location ?? '', /channel=linkedin/);

  const staleTimestamp = baseCalendarForm('cancel');
  staleTimestamp.set('expected_updated_at', '2026-08-27T11:44:59.000Z');
  const cancel = await call('POST', CANCEL_ROUTE, postgres({ publicSocial: service }), staleTimestamp);
  assert.equal(cancel.statusCode, 303);
  assert.match(cancel.headers.location ?? '', /notice=conflict\./);

  assert.equal(calls.snapshots.length, 2);
  assert.equal(calls.reschedules.length, 0);
  assert.equal(calls.cancels.length, 0);
});

test('calendar exact-evidence reschedule and cancel invoke only durable TEST command DTOs', async () => {
  const calls = freshCalls();
  const service = socialService(calls);

  const rescheduled = await call(
    'POST', RESCHEDULE_ROUTE, postgres({ publicSocial: service }), baseCalendarForm('reschedule'),
  );
  assert.equal(rescheduled.statusCode, 303);
  assert.match(rescheduled.headers.location ?? '', /notice=rescheduled\./);
  assert.deepEqual(calls.reschedules[0]?.input, {
    commandKey: 'reschedule-command-0001',
    predecessorIntentId: IDS.intent,
    targetId: IDS.targetOne,
    newDesiredFor: '2026-08-29T10:00:00.000Z',
    reason: 'Move this TEST rehearsal after review.',
  });

  const cancelled = await call(
    'POST', CANCEL_ROUTE, postgres({ publicSocial: service }), baseCalendarForm('cancel'),
  );
  assert.equal(cancelled.statusCode, 303);
  assert.match(cancelled.headers.location ?? '', /notice=cancelled\./);
  assert.deepEqual(calls.cancels[0]?.input, {
    intentId: IDS.intent,
    targetId: IDS.targetOne,
    reason: 'Stop this obsolete TEST target.',
  });

  for (const input of [calls.reschedules[0]!.input, calls.cancels[0]!.input]) {
    const projected = input as unknown as Record<string, unknown>;
    for (const unsafe of [
      'workspaceId', 'provider', 'providerId', 'connectionId', 'accountRef',
      'storageKey', 'credential', 'body', 'publish',
    ]) assert.equal(Object.hasOwn(projected, unsafe), false);
  }
});
