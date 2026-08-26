import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPropertyPredatorAutomationStudioFixture,
  PROPERTY_PREDATOR_AUTOMATION_STUDIO_AS_OF,
} from '../src/portal/automation-studio-fixtures.js';
import {
  AUTOMATION_STUDIO_MAX_NODES,
  AUTOMATION_STUDIO_ROUTE,
  presentAutomationStudio,
  type AutomationNodeSnapshot,
  type AutomationStudioSnapshot,
} from '../src/portal/automation-studio-presenter.js';
import { renderAutomationStudioBody } from '../src/portal/automation-studio-view.js';

function present(snapshot = createPropertyPredatorAutomationStudioFixture(), node?: unknown) {
  return presentAutomationStudio(snapshot, { node });
}

test('Automation Studio presents a complete TEST flow with deterministic activation evidence', () => {
  const view = present();
  assert.equal(AUTOMATION_STUDIO_ROUTE, '/portal/automations');
  assert.equal(view.workspaceName, 'Property Predator Growth HQ');
  assert.equal(view.environment, 'test');
  assert.equal(view.environmentLabel, 'TEST');
  assert.equal(view.runtimeState, 'paused');
  assert.equal(view.asOf, PROPERTY_PREDATOR_AUTOMATION_STUDIO_AS_OF);
  assert.equal(view.nodes.length, 7);
  assert.deepEqual(view.nodes.map((node) => node.kind), [
    'trigger', 'condition', 'guard', 'guard', 'wait', 'action', 'action',
  ]);
  assert.deepEqual(view.metrics, {
    nodes: 7,
    actions: 2,
    checksPassed: 11,
    checksTotal: 11,
    proofPassed: 3,
    proofTotal: 3,
    simulatedSteps: 7,
  });
  assert.equal(view.testActivationGate.open, true);
  assert.equal(view.testActivationGate.label, 'OPEN');
  assert.equal(view.testActivationGate.canRequestActivation, true);
  assert.equal(view.testActivationGate.canRequestPause, false);
  assert.equal(view.liveActivationGate.open, false);
  assert.equal(view.liveActivationGate.label, 'CLOSED');
  assert.equal(view.commandBoundaryAvailable, false);
  assert.equal(view.simulation.providerEffects, false);
  assert.equal(view.simulation.contactEffects, false);
  assert.equal(view.simulation.steps.at(-1)?.nodeTitle, 'Record education journey enrolment');
  assert.ok(view.nodes.every((node) => node.nodeReady));
});

test('Automation Studio node selection is deterministic and unknown input fails to the first step', () => {
  const selected = present(undefined, 'action-create-whatsapp-draft');
  assert.equal(selected.selectedNode.nodeId, 'action-create-whatsapp-draft');
  assert.equal(selected.selectedNode.effect, 'draft_only');
  assert.equal(selected.selectedNode.providerMode, 'simulated');
  assert.ok(selected.selectedNode.incoming.some((route) => route.nodeTitle === 'Wait 20 minutes'));
  assert.ok(selected.selectedNode.outgoing.some((route) => route.nodeTitle === 'Record education journey enrolment'));

  const unknown = present(undefined, '<script>unknown</script>');
  assert.equal(unknown.selectedNode.nodeId, 'trigger-autopsy-form');
  assert.equal(unknown.nodes.filter((node) => node.selected).length, 1);
});

test('TEST activation fails closed without consent, approval, TEST isolation or a zero-effect simulation', () => {
  const fixture = createPropertyPredatorAutomationStudioFixture();
  const consentNode = fixture.nodes.find((node) => node.nodeId === 'guard-whatsapp-consent');
  assert.ok(consentNode);
  const withoutConsent: AutomationStudioSnapshot = {
    ...fixture,
    nodes: fixture.nodes.map((node) => node.nodeId === consentNode.nodeId
      ? { ...node, guardKind: null }
      : node),
  };
  const consentView = present(withoutConsent);
  assert.equal(consentView.testActivationGate.open, false);
  assert.equal(consentView.readinessChecks.find((check) => check.key === 'consent-ancestor')?.passed, false);
  assert.equal(consentView.readinessChecks.find((check) => check.key === 'configured-nodes')?.passed, false);

  const approvalNode = fixture.nodes.find((node) => node.nodeId === 'guard-human-approval');
  assert.ok(approvalNode);
  const withoutApproval: AutomationStudioSnapshot = {
    ...fixture,
    nodes: fixture.nodes.map((node) => node.nodeId === approvalNode.nodeId
      ? { ...node, guardKind: null }
      : node),
  };
  assert.equal(present(withoutApproval).readinessChecks.find((check) => check.key === 'approval-ancestor')?.passed, false);

  const liveInput = present({ ...fixture, environment: 'live' });
  assert.equal(liveInput.testActivationGate.open, false);
  assert.equal(liveInput.readinessChecks.find((check) => check.key === 'test-environment')?.passed, false);
  assert.equal(liveInput.liveActivationGate.open, false);

  const effectfulSimulation = present({
    ...fixture,
    simulation: { ...fixture.simulation, providerEffects: true },
  });
  assert.equal(effectfulSimulation.testActivationGate.open, false);
  assert.equal(effectfulSimulation.readinessChecks.find((check) => check.key === 'zero-effect-simulation')?.passed, false);
  assert.equal(effectfulSimulation.simulation.providerEffects, false);
});

test('Automation Studio rejects cycles, unreachable steps, expired proof and oversized flow input', () => {
  const fixture = createPropertyPredatorAutomationStudioFixture();
  const cyclic = present({
    ...fixture,
    edges: [...fixture.edges, {
      edgeId: 'edge-cycle-back-to-trigger',
      fromNodeId: 'action-enrol-education',
      toNodeId: 'trigger-autopsy-form',
      label: 'Unsafe loop',
      path: 'always',
    }],
  });
  assert.equal(cyclic.testActivationGate.open, false);
  assert.equal(cyclic.readinessChecks.find((check) => check.key === 'connected-acyclic')?.passed, false);

  const orphan: AutomationNodeSnapshot = {
    ...fixture.nodes[0]!,
    nodeId: 'orphan-test-action',
    kind: 'action',
    title: 'Unreachable TEST action',
    effect: 'internal_test',
  };
  const unreachable = present({ ...fixture, nodes: [...fixture.nodes, orphan] });
  assert.equal(unreachable.testActivationGate.open, false);
  assert.equal(unreachable.readinessChecks.find((check) => check.key === 'connected-acyclic')?.passed, false);

  const firstProof = fixture.readinessProofs[0];
  assert.ok(firstProof);
  const expired = present({
    ...fixture,
    readinessProofs: [{ ...firstProof, expiresAt: '2026-08-26T10:29:59.000Z' }, ...fixture.readinessProofs.slice(1)],
  });
  assert.equal(expired.readinessProofs[0]?.state, 'expired');
  assert.equal(expired.testActivationGate.open, false);

  const oversized = present({
    ...fixture,
    nodes: Array.from({ length: AUTOMATION_STUDIO_MAX_NODES + 3 }, (_, index) => ({
      ...fixture.nodes[index % fixture.nodes.length]!,
      nodeId: `oversized-node-${index}`,
    })),
  });
  assert.equal(oversized.nodes.length, AUTOMATION_STUDIO_MAX_NODES);
  assert.equal(oversized.inputTruncated, true);
  assert.equal(oversized.testActivationGate.open, false);
  assert.equal(oversized.readinessChecks.find((check) => check.key === 'bounded-graph')?.passed, false);
});

test('Automation Studio renders a premium touch-responsive and accessible visual builder with no command boundary', () => {
  const html = renderAutomationStudioBody(present());
  assert.match(html, /<article class="auto" aria-labelledby="auto-title" data-provider-effects="none" data-contact-effects="none" data-command-boundary="absent">/);
  assert.match(html, /Build the logic\. <em>Prove the safety\.<\/em>/);
  assert.match(html, /aria-label="Visual automation builder"/);
  assert.match(html, /aria-label="Accessible automation flow in execution order"/);
  assert.match(html, /aria-label="Automation node library"/);
  assert.match(html, /aria-label="Selected node configuration"/);
  assert.match(html, /Consent before outbound draft/);
  assert.match(html, /Approval before outbound draft/);
  assert.match(html, /Latest zero-effect simulation/);
  assert.match(html, /Audit trail/);
  assert.match(html, /TEST activation gate<\/small><b>OPEN<\/b>/);
  assert.match(html, /LIVE activation gate<\/small><b>CLOSED<\/b>/);
  assert.match(html, /Activate TEST · unavailable/);
  assert.match(html, /Pause TEST · unavailable/);
  assert.match(html, /Run TEST simulation · unavailable/);
  assert.match(html, /disabled aria-disabled="true"/);
  assert.match(html, /Provider effects <b>0<\/b>/);
  assert.match(html, /Contact effects <b>0<\/b>/);
  assert.match(html, /min-height:46px/);
  assert.match(html, /@media\(max-width:820px\)/);
  assert.match(html, /@media\(max-width:560px\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.doesNotMatch(html, /<form|method="post"|Publish now|Send now|Go live|Connect provider/i);
});

test('Automation Studio escapes hostile display content and rejects credential-shaped configuration', () => {
  const fixture = createPropertyPredatorAutomationStudioFixture();
  const firstNode = fixture.nodes[0];
  const firstProof = fixture.readinessProofs[0];
  const firstAudit = fixture.audit[0];
  const firstStep = fixture.simulation.steps[0];
  assert.ok(firstNode);
  assert.ok(firstProof);
  assert.ok(firstAudit);
  assert.ok(firstStep);
  const hostile: AutomationStudioSnapshot = {
    ...fixture,
    workspaceName: '<script>alert(1)</script> A&B',
    name: '<img src=x onerror=alert(2)>',
    nodes: [{
      ...firstNode,
      title: '</h3><script>alert(3)</script>',
      detail: '<svg onload=alert(4)>',
      configuration: [
        ...firstNode.configuration,
        { key: 'apiKey', label: 'Provider API key', value: 'SUPER-SECRET-MUST-NOT-RENDER' },
      ],
    }, ...fixture.nodes.slice(1)],
    readinessProofs: [{ ...firstProof, label: '<img src=x onerror=alert(5)>' }, ...fixture.readinessProofs.slice(1)],
    simulation: {
      ...fixture.simulation,
      steps: [{ ...firstStep, detail: '</p><script>alert(6)</script>' }, ...fixture.simulation.steps.slice(1)],
    },
    audit: [{ ...firstAudit, actorLabel: '<svg onload=alert(7)>' }, ...fixture.audit.slice(1)],
  };
  const view = present(hostile);
  const html = renderAutomationStudioBody(view);
  assert.equal(view.nodes[0]?.rejectedConfigurationCount, 1);
  assert.equal(view.testActivationGate.open, false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; A&amp;B/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(html, /&lt;\/h3&gt;&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.match(html, /sensitive or oversized setting rejected/);
  assert.doesNotMatch(html, /SUPER-SECRET-MUST-NOT-RENDER|Provider API key|apiKey/i);
  assert.doesNotMatch(html, /<(?:script|img|svg)\b/i);
});

test('Automation Studio requires at least one bounded flow node', () => {
  const fixture = createPropertyPredatorAutomationStudioFixture();
  assert.throws(
    () => present({ ...fixture, nodes: [], edges: [] }),
    /requires at least one bounded flow node/,
  );
});
