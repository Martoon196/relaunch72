import { followupActivationBlockers, followupTimeline, type FollowupSequenceDefinition, type FollowupSequenceReadiness } from './definition.js';
import { followupCanPrepare, nextFollowupMessage, type FollowupRunState } from './state.js';
import { FlowDraftValidationError } from './channel-drafts.js';
export interface FlowSimulationEvent { readonly atMinutes: number; readonly type: 'pause' | 'resume' | 'stop' | 'unsubscribe' | 'reply' | 'booked' | 'purchased' }
export interface FlowSimulationOutcome { readonly position: number; readonly result: 'accepted' | 'failed' | 'unknown' }
export interface FlowSimulationScenario { readonly clock: string; readonly assumeConnections: boolean; readonly events: readonly FlowSimulationEvent[]; readonly outcomes: readonly FlowSimulationOutcome[] }
export interface FlowSimulationLine { readonly at: string; readonly position: number | null; readonly kind: string; readonly label: string }
const fail = (): never => { throw new FlowDraftValidationError('Choose a valid bounded simulation scenario.'); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const DEFAULT_FLOW_SIMULATION: FlowSimulationScenario = Object.freeze({ clock: '2026-11-01T09:00:00.000Z', assumeConnections: true, events: [], outcomes: [] });
export const FLOW_SIMULATION_CASES = ['happy', 'pause', 'reply', 'booked', 'purchased', 'unsubscribe', 'failed', 'unknown'] as const;
export function flowSimulationPreset(name: string, definition: FollowupSequenceDefinition): FlowSimulationScenario {
  if (!(FLOW_SIMULATION_CASES as readonly string[]).includes(name)) return fail();
  const first = followupTimeline(definition)[0]!;
  if (name === 'failed' || name === 'unknown') return { ...DEFAULT_FLOW_SIMULATION, outcomes: [{ position: first.position, result: name }] };
  if (name === 'pause') return { ...DEFAULT_FLOW_SIMULATION, events: [{ atMinutes: 0, type: 'pause' }, { atMinutes: 15, type: 'resume' }] };
  if (name !== 'happy') return { ...DEFAULT_FLOW_SIMULATION, events: [{ atMinutes: first.earliestOffsetMinutes + 1, type: name as FlowSimulationEvent['type'] }] };
  return DEFAULT_FLOW_SIMULATION;
}
export function parseFlowSimulation(value: unknown, definition: FollowupSequenceDefinition): FlowSimulationScenario {
  if (!record(value) || Object.keys(value).sort().join(',') !== ['clock', 'assumeConnections', 'events', 'outcomes'].sort().join(',')
      || typeof value.clock !== 'string' || !Number.isFinite(Date.parse(value.clock)) || new Date(value.clock).toISOString() !== value.clock
      || typeof value.assumeConnections !== 'boolean' || !Array.isArray(value.events) || value.events.length > 32 || !Array.isArray(value.outcomes) || value.outcomes.length > 24) return fail();
  const events = value.events.map((event): FlowSimulationEvent => {
    if (!record(event) || Object.keys(event).sort().join(',') !== 'atMinutes,type' || !Number.isSafeInteger(event.atMinutes) || Number(event.atMinutes) < 0 || Number(event.atMinutes) > 525600
        || !['pause', 'resume', 'stop', 'unsubscribe', 'reply', 'booked', 'purchased'].includes(String(event.type))) return fail();
    return Object.freeze({ atMinutes: Number(event.atMinutes), type: event.type as FlowSimulationEvent['type'] });
  }).sort((a, b) => a.atMinutes - b.atMinutes);
  const messages = new Set(followupTimeline(definition).map(step => step.position)), seen = new Set<number>();
  const outcomes = value.outcomes.map((outcome): FlowSimulationOutcome => {
    if (!record(outcome) || Object.keys(outcome).sort().join(',') !== 'position,result' || !Number.isSafeInteger(outcome.position)
        || !messages.has(Number(outcome.position)) || seen.has(Number(outcome.position)) || !['accepted', 'failed', 'unknown'].includes(String(outcome.result))) return fail();
    seen.add(Number(outcome.position)); return Object.freeze({ position: Number(outcome.position), result: outcome.result as FlowSimulationOutcome['result'] });
  });
  return Object.freeze({ clock: value.clock, assumeConnections: value.assumeConnections, events: Object.freeze(events), outcomes: Object.freeze(outcomes) });
}
/** Pure synthetic walkthrough. Never accepts real recipient IDs and never writes evidence or contacts. */
export function simulateFollowupFlow(definition: FollowupSequenceDefinition, readiness: FollowupSequenceReadiness, input: unknown = DEFAULT_FLOW_SIMULATION) {
  const scenario = parseFlowSimulation(input, definition), lines: FlowSimulationLine[] = [], base = Date.parse(scenario.clock);
  const blockers = followupActivationBlockers(definition, readiness);
  const add = (now: number, position: number | null, kind: string, label: string) => lines.push(Object.freeze({ at: new Date(now).toISOString(), position, kind, label }));
  let state: FollowupRunState = 'active', clock = base, cursor = 0, consent = true, next = nextFollowupMessage(definition, -1, scenario.clock);
  const currentState = (): FollowupRunState => state;
  const event = (entry: FlowSimulationEvent) => {
    clock = Math.max(clock, base + entry.atMinutes * 60_000);
    if (state === 'stopped') return;
    if (entry.type === 'pause') state = 'paused';
    else if (entry.type === 'resume') { if (state === 'paused') state = 'active'; }
    else if (entry.type === 'stop' || entry.type === 'unsubscribe') { state = 'stopped'; if (entry.type === 'unsubscribe') consent = false; }
    else if (definition.stopOn[entry.type]) state = 'stopped';
    add(clock, null, 'simulated_event', `Simulated ${entry.type}${state === 'stopped' ? ' — future steps stopped' : ''}.`);
  };
  if (!scenario.assumeConnections && blockers.length) { state = 'held'; add(clock, null, 'real_blocker', 'Actual Start is blocked before any message: ' + blockers.join(', ') + '.'); }
  while (next && currentState() !== 'held' && currentState() !== 'stopped') {
    clock = Math.max(clock, Date.parse(next.dueAt));
    while (cursor < scenario.events.length && base + scenario.events[cursor]!.atMinutes * 60_000 <= clock) event(scenario.events[cursor++]!);
    while (currentState() === 'paused' && cursor < scenario.events.length) event(scenario.events[cursor++]!);
    if (currentState() === 'paused' || currentState() === 'stopped') break;
    const step = definition.steps[next.position]!;
    if (step.kind === 'wait') return fail();
    const expires = Date.parse(next.dueAt) + definition.expiryHours * 3_600_000;
    if (!followupCanPrepare({ state, currentPosition: next.position, deliveryPosition: next.position, dueAt: next.dueAt, expiresAt: new Date(expires).toISOString(), now: clock, consent, exactApproval: true, unknownProofId: null })) {
      state = 'failed'; add(clock, next.position, 'expired', 'Simulated retry window expired; no further step advances.'); break;
    }
    const outcome = scenario.outcomes.find(value => value.position === next!.position)?.result ?? 'accepted';
    add(clock, next.position, step.kind, `SIMULATION: ${step.kind} ${outcome}. Nothing was sent.`);
    if (outcome !== 'accepted') { state = outcome === 'unknown' ? 'held' : 'failed'; break; }
    next = nextFollowupMessage(definition, next.position, new Date(clock).toISOString());
    if (!next) state = 'completed';
  }
  return Object.freeze({ simulation: true as const, recipient: 'Alex · synthetic sample', noEffects: true as const, state,
    actualStartBlocked: blockers.length > 0, actualBlockers: blockers, lines: Object.freeze(lines), assumesSyntheticConnections: scenario.assumeConnections });
}
