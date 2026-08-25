import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InvalidConversionJourneyDefinitionError,
  PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY,
  PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS,
  PROPERTY_PREDATOR_SELF_SERVE_JOURNEY,
  defineConversionJourney,
  type ConversionJourneyDefinitionInput,
} from '../src/conversion-pg/index.js';
import { PROPERTY_PREDATOR_EXTERNAL_EVENT_TYPES } from '../src/integrations/external-events/index.js';

type Mutable<T> = T extends readonly (infer TItem)[]
  ? Mutable<TItem>[]
  : T extends object
    ? { -readonly [TKey in keyof T]: Mutable<T[TKey]> }
    : T;

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

function input(): ConversionJourneyDefinitionInput {
  return {
    slug: 'test-journey', name: 'Test journey', description: 'A small valid journey.', version: 1,
    milestones: [
      { key: 'lead', name: 'Lead', position: 1, semantic: 'lead', isCompletion: false },
      { key: 'offer', name: 'Offer', position: 2, semantic: 'offer', isCompletion: false },
      { key: 'sale', name: 'Sale', position: 3, semantic: 'sale', isCompletion: true },
    ],
    triggers: [
      { kind: 'event', sourceKey: 'identity.account.created', milestoneKey: 'lead', mode: 'direct', frequency: 'once_per_enrollment' },
      { kind: 'commerce', sourceKey: 'payment_collected', milestoneKey: 'sale', mode: 'direct', frequency: 'once_per_enrollment' },
    ],
    scoreModel: {
      slug: 'test-lead-score', name: 'Test lead score', version: 1,
      components: [
        { key: 'fit', name: 'Fit', maxPoints: 40 },
        { key: 'intent', name: 'Intent', maxPoints: 60 },
      ],
      rules: [
        {
          key: 'account-created', componentKey: 'fit', kind: 'event', sourceKey: 'identity.account.created',
          points: 40, reason: 'The account was created.', mode: 'direct', frequency: 'once_per_enrollment',
        },
        {
          key: 'analysis-completed', componentKey: 'intent', kind: 'event', sourceKey: 'product.analysis.completed',
          points: 20, reason: 'Completed an analysis.', mode: 'direct', frequency: 'once_per_enrollment',
        },
      ],
      bands: [
        { key: 'quiet', name: 'Quiet', minScore: 0, maxScore: 19 },
        { key: 'warm', name: 'Warm', minScore: 20, maxScore: 59 },
        { key: 'hot', name: 'Hot', minScore: 60, maxScore: 100 },
      ],
    },
  };
}

function expectInvalid(value: unknown, pattern: RegExp): void {
  assert.throws(
    () => defineConversionJourney(value as ConversionJourneyDefinitionInput),
    (error: unknown) => error instanceof InvalidConversionJourneyDefinitionError && pattern.test(error.message),
  );
}

test('Property Predator ships distinct product-led and literal LAPS blueprints', () => {
  assert.deepEqual(PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS.map((item) => item.slug), [
    'property-predator-self-serve', 'property-predator-agency-laps',
  ]);
  assert.deepEqual(PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.milestones.map((item) => item.name), [
    'Lead', 'Activated', 'Priced', 'Sale',
  ]);
  assert.deepEqual(PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY.milestones.map((item) => item.name), [
    'Lead', 'Appointment', 'Presentation', 'Sale',
  ]);
  for (const blueprint of PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS) {
    assert.match(blueprint.definitionHash, /^[0-9a-f]{64}$/);
    assert.match(blueprint.scoreModel.definitionHash, /^[0-9a-f]{64}$/);
    assert.equal(blueprint.scoreModel.components.reduce((sum, item) => sum + item.maxPoints, 0), 100);
    assert.equal(blueprint.milestones.filter((item) => item.isCompletion).length, 1);
    assert.ok(Object.isFrozen(blueprint));
    assert.ok(Object.isFrozen(blueprint.scoreModel.rules));
  }
  assert.equal(
    PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.scoreModel.definitionHash,
    PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY.scoreModel.definitionHash,
  );
});

test('Property Predator V1 accepts only current bridge events and commerce-authoritative sales', () => {
  const acceptedEventSources = new Set<string>(PROPERTY_PREDATOR_EXTERNAL_EVENT_TYPES);
  for (const blueprint of PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS) {
    for (const trigger of blueprint.triggers) {
      if (trigger.kind === 'event') assert.ok(acceptedEventSources.has(trigger.sourceKey));
    }
    const sale = blueprint.milestones.find((item) => item.semantic === 'sale')!;
    const saleTriggers = blueprint.triggers.filter((item) => item.milestoneKey === sale.key);
    assert.deepEqual(saleTriggers, [{
      kind: 'commerce', sourceKey: 'payment_collected', milestoneKey: 'sale',
      mode: 'direct', frequency: 'once_per_enrollment',
    }]);
    assert.ok(!blueprint.triggers.some((item) => /pricing|checkout|purchase_completed/.test(item.sourceKey)));
  }
  assert.ok(!PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.triggers.some((item) => item.milestoneKey === 'priced'));
});

test('canonical SHA-256 ignores property insertion order and trimmed display whitespace', () => {
  const first = defineConversionJourney(input());
  const source = input();
  const reordered = {
    scoreModel: {
      rules: source.scoreModel.rules,
      version: source.scoreModel.version,
      bands: source.scoreModel.bands,
      name: ` ${source.scoreModel.name} `,
      components: source.scoreModel.components,
      slug: source.scoreModel.slug,
    },
    triggers: source.triggers,
    milestones: source.milestones,
    description: `  ${source.description}  `,
    version: source.version,
    name: ` ${source.name} `,
    slug: source.slug,
  } as ConversionJourneyDefinitionInput;
  const second = defineConversionJourney(reordered);
  assert.equal(first.definitionHash, second.definitionHash);
  assert.equal(first.scoreModel.definitionHash, second.scoreModel.definitionHash);
  assert.deepEqual(first, second);

  const changed = clone(source);
  changed.scoreModel.version += 1;
  const changedDefinition = defineConversionJourney(changed);
  assert.notEqual(first.scoreModel.definitionHash, changedDefinition.scoreModel.definitionHash);
  assert.notEqual(first.definitionHash, changedDefinition.definitionHash);
});

test('component maxima must total 100 and score rules cannot exceed a component ceiling', () => {
  const wrongTotal = clone(input());
  wrongTotal.scoreModel.components[0]!.maxPoints = 39;
  expectInvalid(wrongTotal, /total exactly 100 points/);

  const overAllocated = clone(input());
  overAllocated.scoreModel.rules[0]!.points = 41;
  expectInvalid(overAllocated, /above its 40-point maximum/);

  const unknownComponent = clone(input());
  unknownComponent.scoreModel.rules[0]!.componentKey = 'missing';
  expectInvalid(unknownComponent, /references unknown component missing/);
});

test('score bands are ordered, contiguous and cover every score from 0 to 100', () => {
  const gap = clone(input());
  gap.scoreModel.bands[1]!.minScore = 21;
  expectInvalid(gap, /ordered and contiguous/);

  const noZero = clone(input());
  noZero.scoreModel.bands[0]!.minScore = 1;
  expectInvalid(noZero, /begin at score 0/);

  const noHundred = clone(input());
  noHundred.scoreModel.bands[2]!.maxScore = 99;
  expectInvalid(noHundred, /end at score 100/);
});

test('milestones have canonical positions, supported semantics and one completion', () => {
  const wrongPosition = clone(input());
  wrongPosition.milestones[1]!.position = 3;
  expectInvalid(wrongPosition, /position must be 2/);

  const semantic = clone(input());
  semantic.milestones[1]!.semantic = 'priced' as never;
  expectInvalid(semantic, /semantic is invalid/);

  const none = clone(input());
  none.milestones[2]!.isCompletion = false;
  expectInvalid(none, /exactly one completion milestone/);

  const two = clone(input());
  two.milestones[0]!.isCompletion = true;
  expectInvalid(two, /exactly one completion milestone/);
});

test('definition-local milestone, component, rule, band and trigger identities are unique', () => {
  const milestone = clone(input());
  milestone.milestones[1]!.key = 'lead';
  expectInvalid(milestone, /milestones contains duplicate key lead/);

  const component = clone(input());
  component.scoreModel.components[1]!.key = 'fit';
  expectInvalid(component, /scoreModel.components contains duplicate key fit/);

  const rule = clone(input());
  rule.scoreModel.rules[1]!.key = 'account-created';
  expectInvalid(rule, /scoreModel.rules contains duplicate key account-created/);

  const band = clone(input());
  band.scoreModel.bands[1]!.key = 'quiet';
  expectInvalid(band, /scoreModel.bands contains duplicate key quiet/);

  const trigger = clone(input());
  trigger.triggers.push(clone(trigger.triggers[0]!));
  expectInvalid(trigger, /triggers contains duplicate key event:identity.account.created/);
});

test('triggers are direct, once per enrollment and reference real milestones', () => {
  const derived = clone(input());
  derived.triggers[0]!.mode = 'derived' as never;
  expectInvalid(derived, /must be direct/);

  const repeatable = clone(input());
  repeatable.triggers[0]!.frequency = 'repeatable' as never;
  expectInvalid(repeatable, /must be once_per_enrollment/);

  const missing = clone(input());
  missing.triggers[0]!.milestoneKey = 'unknown';
  expectInvalid(missing, /references unknown milestone unknown/);

  const emptyTriggers = clone(input());
  emptyTriggers.triggers = [];
  assert.equal(defineConversionJourney(emptyTriggers).triggers.length, 0);
});

test('sale authority is commerce payment_collected and never a generic event', () => {
  const eventSale = clone(input());
  eventSale.triggers[1]!.kind = 'event';
  eventSale.triggers[1]!.sourceKey = 'commerce.purchase.completed';
  expectInvalid(eventSale, /commerce payment_collected if and only if.*sale/);

  const genericCommerce = clone(input());
  genericCommerce.triggers[1]!.sourceKey = 'purchase_completed';
  expectInvalid(genericCommerce, /commerce triggers must use payment_collected/);

  const commerceLead = clone(input());
  commerceLead.triggers[1]!.milestoneKey = 'lead';
  expectInvalid(commerceLead, /if and only if.*sale/);
});

test('score rules are explainable, direct and award points only once per enrollment', () => {
  const missingReason = clone(input());
  missingReason.scoreModel.rules[0]!.reason = '   ';
  expectInvalid(missingReason, /reason is required/);

  const derived = clone(input());
  derived.scoreModel.rules[0]!.mode = 'formula' as never;
  expectInvalid(derived, /must be direct/);

  const repeatable = clone(input());
  repeatable.scoreModel.rules[0]!.frequency = 'per_event' as never;
  expectInvalid(repeatable, /must be once_per_enrollment/);

  const untypedSource = clone(input());
  untypedSource.scoreModel.rules[0]!.kind = 'unknown' as never;
  expectInvalid(untypedSource, /kind must be event or commerce/);

  const commerce = clone(input());
  commerce.scoreModel.rules.push({
    key: 'payment-collected', componentKey: 'intent', kind: 'commerce', sourceKey: 'payment_collected',
    points: 40, reason: 'A payment was collected.', mode: 'direct', frequency: 'once_per_enrollment',
  });
  assert.equal(defineConversionJourney(commerce).scoreModel.rules.at(-1)!.sourceKey, 'payment_collected');
});

test('consent, permission and suppression facts can never become score points', () => {
  for (const signal of ['privacy.consent.updated', 'contact.permission.confirmed', 'suppression.removed', 'email.opt-in']) {
    const forbidden = clone(input());
    forbidden.scoreModel.rules[0]!.sourceKey = signal;
    expectInvalid(forbidden, /keep communication eligibility separate/);
  }

  const forbiddenComponent = clone(input());
  forbiddenComponent.scoreModel.components[0]!.name = 'Marketing permission';
  expectInvalid(forbiddenComponent, /cannot make consent, permission or suppression a score component/);
});

test('score rules use a positive audited source registry, not only a privacy deny-list', () => {
  const unregistered = clone(input());
  unregistered.scoreModel.rules[0]!.sourceKey = 'privacy.preference.updated';
  expectInvalid(unregistered, /not in the audited scoreable-source registry/);

  const plausibleButUnregistered = clone(input());
  plausibleButUnregistered.scoreModel.rules[0]!.sourceKey = 'product.video.watched';
  expectInvalid(plausibleButUnregistered, /not in the audited scoreable-source registry/);
});

test('strict validation rejects unknown fields and malformed slugs or keys', () => {
  const unknown = clone(input()) as Mutable<ConversionJourneyDefinitionInput> & { expression?: string };
  unknown.expression = 'score > 20';
  expectInvalid(unknown, /unknown field expression/);

  const nestedUnknown = clone(input()) as unknown as { milestones: Array<Record<string, unknown>> };
  nestedUnknown.milestones[0]!.weight = 12;
  expectInvalid(nestedUnknown, /unknown field weight/);

  const malformedSlug = clone(input());
  malformedSlug.slug = 'Test Journey';
  expectInvalid(malformedSlug, /lowercase kebab-case slug/);

  const malformedKey = clone(input());
  malformedKey.milestones[0]!.key = 'Lead Stage';
  expectInvalid(malformedKey, /safe lowercase key/);
});
