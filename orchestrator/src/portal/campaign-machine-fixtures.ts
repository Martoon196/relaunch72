import { createHash } from 'node:crypto';
import {
  campaignMachineStepContentSha256,
  type CampaignMachineSnapshot,
  type CampaignMachineStepSnapshot,
} from './campaign-machine-presenter.js';

export const PROPERTY_PREDATOR_CAMPAIGN_MACHINE_AS_OF = '2026-08-29T08:00:00.000Z';

const TEMPLATE_ID = 'c5100000-0000-4000-8000-000000000001';
const VERSION_ID = 'c5110000-0000-4000-8000-000000000001';
const VERSION_SHA256 = sha256('propertypredator:owned-office-lead-activation-nurture:v1');

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function step(input: Omit<CampaignMachineStepSnapshot, 'contentSha256' | 'providerEffects'>): CampaignMachineStepSnapshot {
  return Object.freeze({
    ...input,
    contentSha256: campaignMachineStepContentSha256(input),
    providerEffects: false,
  });
}

/**
 * Owned-office/fictitious planning evidence only. The wording is a prepared
 * Property Predator nurture proposal, not an approved customer campaign. No
 * recipient, provider account, destination URL or delivery capability exists
 * in this fixture.
 */
export function createPropertyPredatorCampaignMachineFixture(): CampaignMachineSnapshot {
  return Object.freeze({
    workspaceName: 'Property Predator Growth HQ',
    asOf: PROPERTY_PREDATOR_CAMPAIGN_MACHINE_AS_OF,
    templates: Object.freeze([
      Object.freeze({
        templateId: TEMPLATE_ID,
        templateKey: 'owned-office-lead-activation-nurture',
        name: 'First Hunt · Lead-to-Activation Nurture',
        description: 'A reusable Property Predator sequence that turns a captured lead into one useful product action, while every non-response becomes an owned admin task instead of silent spam.',
        audienceLabel: 'Owned-office rehearsal identity · future approved self-serve leads',
        environment: 'prepared' as const,
        version: Object.freeze({
          versionId: VERSION_ID,
          versionNumber: 1,
          definitionSha256: VERSION_SHA256,
          immutable: true as const,
          createdAt: '2026-08-29T07:30:00.000Z',
          brandBrainReleaseId: 'b1000000-0000-4000-8000-000000000001',
          brandBrainManifestSha256: '87af0778a10534854628281387190bb5221112fe1c306df0ab83cb6ad5ee9759',
          canonicalBrandVersion: 'Property Predator Brand Brain · reviewed source release',
          specialistChain: Object.freeze([
            'founder-gpt.offer-architect',
            'founder-gpt.direct-response-copywriter',
            'propertypredator.owned.email/v1',
            'propertypredator.growth-hq.operator/v1',
          ]),
          lapsTrack: 'self_serve' as const,
          journeySlug: 'property-predator-self-serve',
          entryStage: 'lead' as const,
          targetStage: 'activated' as const,
          activationWindowId: null,
          audienceVersionId: null,
          offerVersionId: null,
          providerEffects: false as const,
        }),
        recipe: Object.freeze({
          recipeId: 'c5120000-0000-4000-8000-000000000001',
          recipeVersionId: 'c5130000-0000-4000-8000-000000000001',
          templateVersionId: VERSION_ID,
          recipeSha256: sha256('propertypredator:first-hunt-recipe:v1'),
          entryEventKey: 'identity.account.created',
          stopEventKeys: Object.freeze([
            'product.analysis.completed',
            'communication.consent.withdrawn',
            'communication.suppressed',
            'conversation.reply.received',
            'sale.evidenced',
          ]),
          idempotencyScope: 'workspace.contact.template-version.step',
          providerEffects: false as const,
        }),
        steps: Object.freeze([
          step({
            stepId: 'c5200000-0000-4000-8000-000000000001',
            templateVersionId: VERSION_ID,
            position: 1,
            stepKey: 'welcome-first-hunt',
            kind: 'email',
            delayMinutes: 0,
            triggerEventKey: 'identity.account.created',
            targetLapsStage: 'activated',
            ownedSpecialistId: 'propertypredator.owned.email/v1',
            subject: 'You’re in. Now make the postcode earn its keep.',
            previewText: 'One useful action beats another night across twelve tabs.',
            body: 'You’ve got access. Good. Now use it on one real property you already understand. Start with the postcode, challenge the weak assumption and finish with a decision you can explain. No spreadsheet theatre. No hopeful numbers. One useful analysis — with reasons, not vibes.',
            ctaLabel: 'Run your first analysis',
            requiresHumanApproval: true,
            requiresCurrentPermission: true,
          }),
          step({
            stepId: 'c5200000-0000-4000-8000-000000000002',
            templateVersionId: VERSION_ID,
            position: 2,
            stepKey: 'admin-first-call',
            kind: 'operator_task',
            delayMinutes: 30,
            triggerEventKey: 'automation.timer.elapsed',
            targetLapsStage: 'lead',
            ownedSpecialistId: 'propertypredator.growth-hq.operator/v1',
            subject: null,
            previewText: null,
            body: 'Call the new lead. Confirm what they buy, what they are looking at now and the first decision they need Property Predator to help them make. Record the outcome and next action in Lead 360.',
            ctaLabel: null,
            requiresHumanApproval: false,
            requiresCurrentPermission: false,
          }),
          step({
            stepId: 'c5200000-0000-4000-8000-000000000003',
            templateVersionId: VERSION_ID,
            position: 3,
            stepKey: 'asking-price-anchor',
            kind: 'email',
            delayMinutes: 1_440,
            triggerEventKey: 'automation.timer.elapsed',
            targetLapsStage: 'activated',
            ownedSpecialistId: 'propertypredator.owned.email/v1',
            subject: 'The asking price is the anchor. Not the answer.',
            previewText: 'Price plus works versus the honest ceiling — that is the deal.',
            body: 'Most bad property decisions begin by accepting somebody else’s anchor. The guide price is not the value. The asking price is not the offer. Put one live opportunity through your own thresholds and force the numbers to answer a harder question: what price would actually make this work?',
            ctaLabel: 'Solve the number below asking',
            requiresHumanApproval: true,
            requiresCurrentPermission: true,
          }),
          step({
            stepId: 'c5200000-0000-4000-8000-000000000004',
            templateVersionId: VERSION_ID,
            position: 4,
            stepKey: 'evidence-before-excitement',
            kind: 'email',
            delayMinutes: 4_320,
            triggerEventKey: 'automation.timer.elapsed',
            targetLapsStage: 'activated',
            ownedSpecialistId: 'propertypredator.owned.email/v1',
            subject: 'Kill the weak assumption before it kills the deal.',
            previewText: 'The owner. The risks. The number. Then the verdict.',
            body: 'A deal does not improve because the spreadsheet looks tidy. Challenge the rent. Challenge the works. Challenge the exit. Then verify the ownership, title, planning and physical position before acting. Property Predator is decision support. Your job is still to make the decision.',
            ctaLabel: 'Run the evidence check',
            requiresHumanApproval: true,
            requiresCurrentPermission: true,
          }),
          step({
            stepId: 'c5200000-0000-4000-8000-000000000005',
            templateVersionId: VERSION_ID,
            position: 5,
            stepKey: 'stop-hunting-on-hunches',
            kind: 'email',
            delayMinutes: 10_080,
            triggerEventKey: 'automation.timer.elapsed',
            targetLapsStage: 'activated',
            ownedSpecialistId: 'propertypredator.owned.email/v1',
            subject: 'Still hunting with a hunch?',
            previewText: 'One postcode. One useful answer. Start there.',
            body: 'If you have not run the first analysis yet, do not turn it into a project. Pick one property. Use honest inputs. Read the reasons behind the result. If the evidence does not support the deal, that is not failure. That is time and capital you did not waste.',
            ctaLabel: 'Analyse one property',
            requiresHumanApproval: true,
            requiresCurrentPermission: true,
          }),
          step({
            stepId: 'c5200000-0000-4000-8000-000000000006',
            templateVersionId: VERSION_ID,
            position: 6,
            stepKey: 'stalled-lead-review',
            kind: 'operator_task',
            delayMinutes: 14_400,
            triggerEventKey: 'automation.timer.elapsed',
            targetLapsStage: 'lead',
            ownedSpecialistId: 'propertypredator.growth-hq.operator/v1',
            subject: null,
            previewText: null,
            body: 'Review the stalled lead. Do not send another automatic message. Check replies, consent, suppression, product evidence and prior call outcomes; then choose a human next action or close the nurture with a recorded reason.',
            ctaLabel: null,
            requiresHumanApproval: false,
            requiresCurrentPermission: false,
          }),
        ]),
        approval: Object.freeze({
          requestId: 'c5140000-0000-4000-8000-000000000001',
          decisionId: null,
          templateVersionId: VERSION_ID,
          templateVersionSha256: VERSION_SHA256,
          state: 'review_required' as const,
          reviewerLabel: null,
          decidedAt: null,
        }),
        reporting: Object.freeze({
          reportingIdentityId: 'c5150000-0000-4000-8000-000000000001',
          templateVersionId: VERSION_ID,
          templateVersionSha256: VERSION_SHA256,
          reportingKey: 'pp.self-serve.lead-to-activation.first-hunt.v1',
          attributionNamespace: 'propertypredator.campaign-machine',
          metricSchemaSha256: sha256('entries,steps_completed,stops,activations,admin_tasks,approvals:v1'),
        }),
        blockers: Object.freeze([
          'Owned-office rehearsal only. No customer recipient or provider operation is attached.',
          'Every email remains a proposal until the exact immutable version is approved.',
        ]),
      }),
    ]),
  });
}
