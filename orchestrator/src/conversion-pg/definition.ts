import { createHash } from 'node:crypto';
import {
  CONVERSION_JOURNEY_SCHEMA_VERSION,
  type ConversionJourneyDefinition,
  type ConversionJourneyDefinitionInput,
  type ConversionJourneyTriggerDefinition,
  type ConversionMilestoneDefinition,
  type ConversionMilestoneSemantic,
  type ConversionScoreBandDefinition,
  type ConversionScoreComponentDefinition,
  type ConversionScoreModelDefinition,
  type ConversionScoreRuleDefinition,
} from './types.js';
import { isConversionScoreableSource } from './scoreable-sources.js';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SOURCE_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,149}$/;
const MAX_MILESTONES = 32;
const MAX_TRIGGERS = 256;
const MAX_COMPONENTS = 16;
const MAX_RULES = 256;
const MAX_BANDS = 32;

const MILESTONE_SEMANTICS = new Set<ConversionMilestoneSemantic>([
  'lead', 'appointment', 'presentation', 'activation',
  'offer', 'sale', 'retention', 'custom',
]);
const FORBIDDEN_SCORING_SEMANTICS = /(?:consent|permission|suppress|opt[\s_.-]*(?:in|out)|unsubscrib|do[\s_.-]*not[\s_.-]*contact)/i;

export class InvalidConversionJourneyDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConversionJourneyDefinitionError';
  }
}

type DataRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new InvalidConversionJourneyDefinitionError(message);
}

function record(value: unknown, path: string): DataRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(`${path} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return invalid(`${path} must not contain symbol properties`);
  }
  for (const [property, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      return invalid(`${path}.${property} must be an enumerable data property`);
    }
  }
  return value as DataRecord;
}

function exactKeys(value: DataRecord, expected: readonly string[], path: string): void {
  const expectedKeys = new Set(expected);
  const unexpected = Object.keys(value).filter((property) => !expectedKeys.has(property));
  const missing = expected.filter((property) => !Object.prototype.hasOwnProperty.call(value, property));
  if (unexpected.length > 0) invalid(`${path} contains unknown field ${unexpected[0]}`);
  if (missing.length > 0) invalid(`${path} is missing required field ${missing[0]}`);
}

function array(value: unknown, path: string, maximum: number, allowEmpty = false): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`);
  if (!allowEmpty && value.length === 0) invalid(`${path} must not be empty`);
  if (value.length > maximum) invalid(`${path} must contain at most ${maximum} items`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) invalid(`${path} must not contain sparse entries`);
  }
  return value;
}

function text(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string') invalid(`${path} must be text`);
  const normalized = value.trim();
  if (!normalized) invalid(`${path} is required`);
  if (normalized.length > maximum) invalid(`${path} must contain at most ${maximum} characters`);
  if (/\p{Cc}/u.test(normalized)) invalid(`${path} must not contain control characters`);
  return normalized;
}

function slug(value: unknown, path: string): string {
  const normalized = text(value, path, 63);
  if (!SLUG_PATTERN.test(normalized)) invalid(`${path} must be a lowercase kebab-case slug`);
  return normalized;
}

function key(value: unknown, path: string): string {
  const normalized = text(value, path, 63);
  if (!KEY_PATTERN.test(normalized)) invalid(`${path} must be a safe lowercase key`);
  return normalized;
}

function sourceKey(value: unknown, path: string): string {
  const normalized = text(value, path, 150);
  if (!SOURCE_KEY_PATTERN.test(normalized)) invalid(`${path} must be a safe lowercase source key`);
  return normalized;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(`${path} must be boolean`);
  return value;
}

function directMode(value: unknown, path: string): 'direct' {
  if (value !== 'direct') invalid(`${path} must be direct`);
  return value;
}

function oncePerEnrollment(value: unknown, path: string): 'once_per_enrollment' {
  if (value !== 'once_per_enrollment') invalid(`${path} must be once_per_enrollment`);
  return value;
}

function assertUnique(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid(`${path} contains duplicate key ${value}`);
    seen.add(value);
  }
}

function milestone(value: unknown, index: number): ConversionMilestoneDefinition {
  const path = `milestones[${index}]`;
  const input = record(value, path);
  exactKeys(input, ['key', 'name', 'position', 'semantic', 'isCompletion'], path);
  const semantic = text(input.semantic, `${path}.semantic`, 20) as ConversionMilestoneSemantic;
  if (!MILESTONE_SEMANTICS.has(semantic)) invalid(`${path}.semantic is invalid`);
  const normalized = Object.freeze({
    key: key(input.key, `${path}.key`),
    name: text(input.name, `${path}.name`, 120),
    position: integer(input.position, `${path}.position`, 1, MAX_MILESTONES),
    semantic,
    isCompletion: boolean(input.isCompletion, `${path}.isCompletion`),
  });
  if (normalized.position !== index + 1) {
    invalid(`${path}.position must be ${index + 1} so milestone order is canonical`);
  }
  return normalized;
}

function trigger(value: unknown, index: number): ConversionJourneyTriggerDefinition {
  const path = `triggers[${index}]`;
  const input = record(value, path);
  exactKeys(input, ['kind', 'sourceKey', 'milestoneKey', 'mode', 'frequency'], path);
  if (input.kind !== 'event' && input.kind !== 'commerce') invalid(`${path}.kind must be event or commerce`);
  const normalized = Object.freeze({
    kind: input.kind,
    sourceKey: sourceKey(input.sourceKey, `${path}.sourceKey`),
    milestoneKey: key(input.milestoneKey, `${path}.milestoneKey`),
    mode: directMode(input.mode, `${path}.mode`),
    frequency: oncePerEnrollment(input.frequency, `${path}.frequency`),
  });
  if (normalized.kind === 'commerce' && normalized.sourceKey !== 'payment_collected') {
    invalid(`${path} commerce triggers must use payment_collected`);
  }
  return normalized;
}

function scoreComponent(value: unknown, index: number): ConversionScoreComponentDefinition {
  const path = `scoreModel.components[${index}]`;
  const input = record(value, path);
  exactKeys(input, ['key', 'name', 'maxPoints'], path);
  const normalized = Object.freeze({
    key: key(input.key, `${path}.key`),
    name: text(input.name, `${path}.name`, 120),
    maxPoints: integer(input.maxPoints, `${path}.maxPoints`, 1, 100),
  });
  if (FORBIDDEN_SCORING_SEMANTICS.test(`${normalized.key} ${normalized.name}`)) {
    invalid(`${path} cannot make consent, permission or suppression a score component`);
  }
  return normalized;
}

function scoreBand(value: unknown, index: number): ConversionScoreBandDefinition {
  const path = `scoreModel.bands[${index}]`;
  const input = record(value, path);
  exactKeys(input, ['key', 'name', 'minScore', 'maxScore'], path);
  const minScore = integer(input.minScore, `${path}.minScore`, 0, 100);
  const maxScore = integer(input.maxScore, `${path}.maxScore`, 0, 100);
  if (maxScore < minScore) invalid(`${path}.maxScore must not be lower than minScore`);
  return Object.freeze({
    key: key(input.key, `${path}.key`),
    name: text(input.name, `${path}.name`, 120),
    minScore,
    maxScore,
  });
}

function scoreRule(value: unknown, index: number): ConversionScoreRuleDefinition {
  const path = `scoreModel.rules[${index}]`;
  const input = record(value, path);
  exactKeys(input, ['key', 'componentKey', 'kind', 'sourceKey', 'points', 'reason', 'mode', 'frequency'], path);
  if (input.kind !== 'event' && input.kind !== 'commerce') invalid(`${path}.kind must be event or commerce`);
  const normalized = Object.freeze({
    key: key(input.key, `${path}.key`),
    componentKey: key(input.componentKey, `${path}.componentKey`),
    kind: input.kind,
    sourceKey: sourceKey(input.sourceKey, `${path}.sourceKey`),
    points: integer(input.points, `${path}.points`, 1, 100),
    reason: text(input.reason, `${path}.reason`, 500),
    mode: directMode(input.mode, `${path}.mode`),
    frequency: oncePerEnrollment(input.frequency, `${path}.frequency`),
  });
  if (FORBIDDEN_SCORING_SEMANTICS.test(
    `${normalized.key} ${normalized.componentKey} ${normalized.sourceKey} ${normalized.reason}`,
  )) {
    invalid(`${path} cannot score consent, permission, opt-in/out or suppression state; keep communication eligibility separate`);
  }
  if (!isConversionScoreableSource(normalized.kind, normalized.sourceKey)) {
    invalid(`${path} source ${normalized.kind}:${normalized.sourceKey} is not in the audited scoreable-source registry`);
  }
  return normalized;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('canonical definition contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([entryKey, child]) => `${JSON.stringify(entryKey)}:${stableJson(child)}`).join(',')}}`;
  }
  return invalid('canonical definition contains a non-JSON value');
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function scoreModel(value: unknown): ConversionScoreModelDefinition {
  const input = record(value, 'scoreModel');
  exactKeys(input, ['slug', 'name', 'version', 'components', 'bands', 'rules'], 'scoreModel');

  const components = Object.freeze(array(input.components, 'scoreModel.components', MAX_COMPONENTS).map(scoreComponent));
  assertUnique(components.map((component) => component.key), 'scoreModel.components');
  const componentTotal = components.reduce((sum, component) => sum + component.maxPoints, 0);
  if (componentTotal !== 100) invalid(`scoreModel components must total exactly 100 points; received ${componentTotal}`);

  const bands = Object.freeze(array(input.bands, 'scoreModel.bands', MAX_BANDS).map(scoreBand));
  assertUnique(bands.map((band) => band.key), 'scoreModel.bands');
  if (bands[0]!.minScore !== 0) invalid('scoreModel bands must begin at score 0');
  for (let index = 1; index < bands.length; index += 1) {
    const previous = bands[index - 1]!;
    const current = bands[index]!;
    if (current.minScore !== previous.maxScore + 1) {
      invalid(`scoreModel bands must be ordered and contiguous between ${previous.key} and ${current.key}`);
    }
  }
  if (bands[bands.length - 1]!.maxScore !== 100) invalid('scoreModel bands must end at score 100');

  const rules = Object.freeze(array(input.rules, 'scoreModel.rules', MAX_RULES, true).map(scoreRule));
  assertUnique(rules.map((rule) => rule.key), 'scoreModel.rules');
  assertUnique(rules.map((rule) => `${rule.kind}:${rule.sourceKey}`), 'scoreModel rule sources');
  const componentByKey = new Map(components.map((component) => [component.key, component]));
  for (const rule of rules) {
    if (!componentByKey.has(rule.componentKey)) {
      invalid(`score rule ${rule.key} references unknown component ${rule.componentKey}`);
    }
  }
  for (const component of components) {
    const allocated = rules
      .filter((rule) => rule.componentKey === component.key)
      .reduce((sum, rule) => sum + rule.points, 0);
    if (allocated > component.maxPoints) {
      invalid(`score rules allocate ${allocated} points to ${component.key}, above its ${component.maxPoints}-point maximum`);
    }
  }

  const payload = Object.freeze({
    schemaVersion: CONVERSION_JOURNEY_SCHEMA_VERSION,
    slug: slug(input.slug, 'scoreModel.slug'),
    name: text(input.name, 'scoreModel.name', 120),
    version: integer(input.version, 'scoreModel.version', 1, 2_147_483_647),
    components,
    bands,
    rules,
  });
  return Object.freeze({ ...payload, definitionHash: sha256(payload) });
}

/**
 * Validate, normalise, canonically hash and deeply freeze one journey blueprint.
 * Array order is definition data; object property insertion order is not.
 */
export function defineConversionJourney(value: ConversionJourneyDefinitionInput): ConversionJourneyDefinition {
  const input = record(value, 'definition');
  exactKeys(input, ['slug', 'name', 'description', 'version', 'milestones', 'triggers', 'scoreModel'], 'definition');

  const milestones = Object.freeze(array(input.milestones, 'milestones', MAX_MILESTONES).map(milestone));
  assertUnique(milestones.map((item) => item.key), 'milestones');
  if (milestones.filter((item) => item.isCompletion).length !== 1) {
    invalid('milestones must contain exactly one completion milestone');
  }
  const milestoneByKey = new Map(milestones.map((item) => [item.key, item]));

  const triggers = Object.freeze(array(input.triggers, 'triggers', MAX_TRIGGERS, true).map(trigger));
  assertUnique(triggers.map((item) => `${item.kind}:${item.sourceKey}`), 'triggers');
  for (const item of triggers) {
    const target = milestoneByKey.get(item.milestoneKey);
    if (!target) invalid(`trigger ${item.kind}:${item.sourceKey} references unknown milestone ${item.milestoneKey}`);
    if ((target.semantic === 'sale') !== (item.kind === 'commerce')) {
      invalid(`trigger ${item.kind}:${item.sourceKey} must use commerce payment_collected if and only if its milestone semantic is sale`);
    }
  }

  const normalizedScoreModel = scoreModel(input.scoreModel);
  const payload = Object.freeze({
    schemaVersion: CONVERSION_JOURNEY_SCHEMA_VERSION,
    slug: slug(input.slug, 'definition.slug'),
    name: text(input.name, 'definition.name', 120),
    description: text(input.description, 'definition.description', 1_000),
    version: integer(input.version, 'definition.version', 1, 2_147_483_647),
    milestones,
    triggers,
    scoreModelDefinitionHash: normalizedScoreModel.definitionHash,
  });
  return Object.freeze({
    schemaVersion: payload.schemaVersion,
    slug: payload.slug,
    name: payload.name,
    description: payload.description,
    version: payload.version,
    milestones,
    triggers,
    scoreModel: normalizedScoreModel,
    definitionHash: sha256(payload),
  });
}
