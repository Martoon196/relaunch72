import type { WebinarStudioSnapshot } from './webinar-studio-presenter.js';

export const PROPERTY_PREDATOR_WEBINAR_AS_OF = '2026-08-26T10:30:00.000Z';

const EVENT_SHA = 'a76c5b4d3e2f1098a76c5b4d3e2f1098a76c5b4d3e2f1098a76c5b4d3e2f1098';
const TEMPLATE_SHA_A = '11c05c20b103a3ed0ad5bf93f59de9159d5c514cd44328930005b2ae36bbc738';
const TEMPLATE_SHA_B = '22c05c20b103a3ed0ad5bf93f59de9159d5c514cd44328930005b2ae36bbc738';
const TEMPLATE_SHA_C = '33c05c20b103a3ed0ad5bf93f59de9159d5c514cd44328930005b2ae36bbc738';
const TEMPLATE_SHA_D = '44c05c20b103a3ed0ad5bf93f59de9159d5c514cd44328930005b2ae36bbc738';

export function createPropertyPredatorWebinarStudioFixture(): WebinarStudioSnapshot {
  const snapshot: WebinarStudioSnapshot = {
    workspaceId: 'workspace-property-predator-test',
    workspaceName: 'Property Predator Growth HQ',
    asOf: PROPERTY_PREDATOR_WEBINAR_AS_OF,
    event: Object.freeze({
      eventId: 'webinar-opportunity-autopsy',
      revisionId: 'webinar-revision-004',
      revisionNumber: 4,
      revisionSha256: EVENT_SHA,
      title: 'The Opportunity Autopsy',
      promise: 'Learn the seven signals that expose a profitable property opportunity before the spreadsheet starts lying to you.',
      scheduledAt: '2026-09-03T18:30:00.000Z',
      durationMinutes: 75,
      timezoneLabel: 'Europe/London',
      hostLabel: 'Martin · Property Predator',
      lifecycle: 'rehearsal_ready',
      environment: 'test',
      providerEventId: null,
    }),
    proofs: Object.freeze([
      {
        proofId: 'proof-runbook',
        label: 'Immutable runbook approved',
        detail: 'Exact webinar revision, teaching sequence and offer handoff were approved together.',
        required: true,
        state: 'verified',
        evidenceRef: 'approval:webinar-revision-004',
        verifiedAt: '2026-08-26T09:02:00.000Z',
        expiresAt: '2026-09-04T22:00:00.000Z',
      },
      {
        proofId: 'proof-offer',
        label: 'Single offer contract',
        detail: 'The room resolves to one owned Property Predator offer and one call to action.',
        required: true,
        state: 'verified',
        evidenceRef: 'approval:offer-opportunity-autopsy-v2',
        verifiedAt: '2026-08-26T09:07:00.000Z',
        expiresAt: '2026-09-04T22:00:00.000Z',
      },
      {
        proofId: 'proof-assets',
        label: 'Teaching assets locked',
        detail: 'Slides, proof cards, poll wording and replay assets resolve to immutable versions.',
        required: true,
        state: 'verified',
        evidenceRef: 'manifest:webinar-assets-v6',
        verifiedAt: '2026-08-26T09:12:00.000Z',
        expiresAt: '2026-09-04T22:00:00.000Z',
      },
      {
        proofId: 'proof-consent',
        label: 'Registration consent copy',
        detail: 'TEST registration and replay follow-up language has been reviewed; every delivery step still re-checks consent.',
        required: true,
        state: 'verified',
        evidenceRef: 'approval:consent-copy-v3',
        verifiedAt: '2026-08-26T09:16:00.000Z',
        expiresAt: '2026-09-04T22:00:00.000Z',
      },
      {
        proofId: 'proof-captioning',
        label: 'Captioning rehearsal',
        detail: 'Optional accessibility rehearsal is logged without implying a connected live caption provider.',
        required: false,
        state: 'verified',
        evidenceRef: 'rehearsal:caption-track-002',
        verifiedAt: '2026-08-26T09:21:00.000Z',
        expiresAt: null,
      },
    ]),
    registration: Object.freeze([
      { stageId: 'landing', label: 'Registration page', detail: 'Fictional people reaching the owned event page.', count: 420, truth: 'simulated' },
      { stageId: 'registered', label: 'Registered', detail: 'Completed TEST registrations with explicit reminder consent.', count: 180, truth: 'simulated' },
      { stageId: 'confirmed', label: 'Confirmed', detail: 'Confirmed the session and selected a calendar reminder.', count: 154, truth: 'simulated' },
      { stageId: 'attended', label: 'Entered live room', detail: 'Fictional attendance plan, not observed provider data.', count: 108, truth: 'simulated' },
      { stageId: 'offer-engaged', label: 'Reached the offer', detail: 'Planned audience still present for the conversion moment.', count: 62, truth: 'simulated' },
    ]),
    speakers: Object.freeze([
      {
        speakerId: 'speaker-martin',
        name: 'Martin',
        role: 'Lead Predator · Host',
        promise: 'Turn deal analysis into a fast, repeatable decision rather than another spreadsheet ritual.',
        readiness: 'ready',
      },
      {
        speakerId: 'speaker-ops',
        name: 'Growth HQ Producer',
        role: 'Room producer',
        promise: 'Protect the pace, capture questions and mark every evidence-bearing engagement signal.',
        readiness: 'ready',
      },
    ]),
    runOfShow: Object.freeze([
      { segmentId: 'seg-welcome', kind: 'welcome', title: 'Open the case file', operatorCue: 'Set the enemy: attractive deals that collapse under proper scrutiny.', startMinute: 0, endMinute: 5, speakerId: 'speaker-martin', assetVersionId: 'asset-cold-open-v3', expectedAudience: 108, attendanceTruth: 'simulated' },
      { segmentId: 'seg-framework', kind: 'teaching', title: 'The seven-signal scan', operatorCue: 'Teach the full Opportunity Autopsy framework before touching examples.', startMinute: 5, endMinute: 18, speakerId: 'speaker-martin', assetVersionId: 'asset-framework-v6', expectedAudience: 104, attendanceTruth: 'simulated' },
      { segmentId: 'seg-proof', kind: 'proof', title: 'Deal room teardown', operatorCue: 'Reveal each warning sign against one fictional acquisition case.', startMinute: 18, endMinute: 30, speakerId: 'speaker-martin', assetVersionId: 'asset-case-study-v4', expectedAudience: 98, attendanceTruth: 'simulated' },
      { segmentId: 'seg-poll', kind: 'interaction', title: 'Name the hidden risk', operatorCue: 'Launch the TEST poll and pause for audience reasoning.', startMinute: 30, endMinute: 38, speakerId: 'speaker-ops', assetVersionId: 'asset-risk-poll-v2', expectedAudience: 92, attendanceTruth: 'simulated' },
      { segmentId: 'seg-decision', kind: 'teaching', title: 'Build the decision line', operatorCue: 'Translate the signals into pursue, renegotiate or kill.', startMinute: 38, endMinute: 53, speakerId: 'speaker-martin', assetVersionId: 'asset-decision-line-v5', expectedAudience: 84, attendanceTruth: 'simulated' },
      { segmentId: 'seg-offer', kind: 'offer', title: 'Join Property Predator', operatorCue: 'Present one offer, one promise and one owned destination.', startMinute: 53, endMinute: 63, speakerId: 'speaker-martin', assetVersionId: 'asset-offer-v2', expectedAudience: 62, attendanceTruth: 'simulated' },
      { segmentId: 'seg-qa', kind: 'qa', title: 'Objection clinic', operatorCue: 'Prioritise questions with high-intent scoring signals.', startMinute: 63, endMinute: 72, speakerId: 'speaker-martin', assetVersionId: null, expectedAudience: 51, attendanceTruth: 'simulated' },
      { segmentId: 'seg-close', kind: 'close', title: 'Close the case', operatorCue: 'Repeat the decision and tell people exactly what happens next.', startMinute: 72, endMinute: 75, speakerId: 'speaker-martin', assetVersionId: 'asset-close-v1', expectedAudience: 44, attendanceTruth: 'simulated' },
    ]),
    engagementSignals: Object.freeze([
      { signalId: 'signal-arrival', kind: 'arrival', label: 'Room arrival', detail: 'Entered the fictional TEST room before the framework began.', minute: 2, people: 108, truth: 'simulated', leadScoreDelta: 4 },
      { signalId: 'signal-poll', kind: 'poll', label: 'Risk poll answered', detail: 'Selected a hidden-risk answer during the case teardown.', minute: 33, people: 71, truth: 'simulated', leadScoreDelta: 8 },
      { signalId: 'signal-resource', kind: 'resource', label: 'Autopsy checklist opened', detail: 'Opened the owned deal-screening checklist.', minute: 47, people: 46, truth: 'simulated', leadScoreDelta: 10 },
      { signalId: 'signal-offer', kind: 'offer', label: 'Offer intent', detail: 'Reached the one approved call to action.', minute: 58, people: 34, truth: 'simulated', leadScoreDelta: 18 },
      { signalId: 'signal-question', kind: 'question', label: 'Acquisition question', detail: 'Submitted a deal-specific question for the objection clinic.', minute: 66, people: 19, truth: 'simulated', leadScoreDelta: 14 },
      { signalId: 'signal-departure', kind: 'departure', label: 'Stayed to close', detail: 'Remained in the fictional room through the final handoff.', minute: 74, people: 44, truth: 'simulated', leadScoreDelta: 6 },
    ]),
    replay: Object.freeze([
      { stepId: 'replay-thank-you', afterHours: 0, channel: 'email', audienceLabel: 'All consented TEST registrants', templateVersionId: 'template-replay-thanks-v4', templateSha256: TEMPLATE_SHA_A, approvedVersionId: 'template-replay-thanks-v4', approvedSha256: TEMPLATE_SHA_A, executionMode: 'simulated', consentGate: 'required' },
      { stepId: 'replay-no-show', afterHours: 2, channel: 'whatsapp', audienceLabel: 'Consented TEST no-shows only', templateVersionId: 'template-no-show-v3', templateSha256: TEMPLATE_SHA_B, approvedVersionId: 'template-no-show-v3', approvedSha256: TEMPLATE_SHA_B, executionMode: 'simulated', consentGate: 'required' },
      { stepId: 'replay-proof', afterHours: 24, channel: 'email', audienceLabel: 'Attended but did not reach offer', templateVersionId: 'template-replay-proof-v5', templateSha256: TEMPLATE_SHA_C, approvedVersionId: 'template-replay-proof-v5', approvedSha256: TEMPLATE_SHA_C, executionMode: 'simulated', consentGate: 'required' },
      { stepId: 'replay-close', afterHours: 48, channel: 'sms', audienceLabel: 'High-intent consented TEST leads', templateVersionId: 'template-replay-close-v2', templateSha256: TEMPLATE_SHA_D, approvedVersionId: 'template-replay-close-v2', approvedSha256: TEMPLATE_SHA_D, executionMode: 'simulated', consentGate: 'required' },
    ]),
    adapter: Object.freeze({
      adapterId: 'webinar-test-adapter',
      providerLabel: 'Webinar provider · simulated adapter',
      state: 'test_ready',
      environment: 'test',
      healthCheckedAt: '2026-08-26T10:22:00.000Z',
      webhookContractVersion: 'webinar-events.v1.test',
      capabilities: Object.freeze(['Event rehearsal', 'Registration simulation', 'Attendance fixtures', 'Replay event contract', 'Engagement fixtures']),
      providerEffects: false,
    }),
  };
  return Object.freeze(snapshot);
}
