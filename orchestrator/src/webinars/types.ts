/** Shared webinar shapes and settings validation. */

export type WebinarKind = 'live' | 'on_demand' | 'scheduled_recording';
export type WebinarStatus = 'draft' | 'published' | 'cancelled' | 'archived';
export type VideoState = 'none' | 'awaiting_upload' | 'processing' | 'ready' | 'failed';
export type LiveState = 'not_provisioned' | 'provisioning' | 'idle' | 'connected' | 'reconnecting' | 'disconnected' | 'unknown';
export type SessionState = 'scheduled' | 'live' | 'ended';
export type RecordingState = 'none' | 'processing' | 'ready' | 'failed' | 'not_recorded';

export const KIND_LABEL: Readonly<Record<WebinarKind, string>> = Object.freeze({
  live: 'Live webinar',
  on_demand: 'On-demand recording',
  scheduled_recording: 'Scheduled presentation of a recording',
});

export interface RegistrationQuestion {
  readonly id: string;
  readonly label: string;
  readonly type: 'text' | 'select';
  readonly required: boolean;
  readonly options: readonly string[];
}

export interface WebinarCta {
  readonly label: string;
  readonly url: string;
  /** manual: the host reveals it; timed: it appears at a position in the session. */
  readonly mode: 'manual' | 'timed';
  readonly atSeconds: number | null;
  readonly body: string;
}

export interface WebinarSettings {
  readonly questions: readonly RegistrationQuestion[];
  /** Shown above the button. Registration itself is the request for event messages. */
  readonly serviceNotice: string;
  /** Optional marketing opt-in wording; null hides the checkbox entirely. */
  readonly marketingConsentText: string | null;
  readonly consentVersion: string;
  readonly privacyUrl: string | null;
  readonly cta: WebinarCta | null;
  readonly replay: { readonly enabled: boolean; readonly availableDays: number | null };
  readonly reminderOffsetsMinutes: readonly number[];
  readonly roomOpensMinutesBefore: number;
  readonly questionsEnabled: boolean;
  readonly questionsModerated: boolean;
  readonly accentColor: string | null;
  readonly crmOpportunityPrefix: string;
}

export const DEFAULT_SETTINGS: WebinarSettings = Object.freeze({
  questions: Object.freeze([]),
  serviceNotice: 'We will email your access link, reminders before it starts and, if a replay is offered, when it is ready.',
  marketingConsentText: null,
  consentVersion: 'webinar-1',
  privacyUrl: null,
  cta: null,
  replay: Object.freeze({ enabled: true, availableDays: 7 }),
  reminderOffsetsMinutes: Object.freeze([1440, 60]),
  roomOpensMinutesBefore: 15,
  questionsEnabled: true,
  questionsModerated: true,
  accentColor: null,
  crmOpportunityPrefix: 'Webinar',
});

const HTTPS_URL = /^https:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/;

function text(v: unknown, max: number, fallback = ''): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : fallback;
}

/** Tolerant reader for stored settings: unknown or malformed values fall back to defaults. */
export function readSettings(raw: unknown): WebinarSettings {
  const s = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const questions = (Array.isArray(s.questions) ? s.questions : []).slice(0, 5).flatMap((q, i): RegistrationQuestion[] => {
    const r = (q ?? {}) as Record<string, unknown>;
    const label = text(r.label, 120);
    if (!label) return [];
    const options = (Array.isArray(r.options) ? r.options : []).map((o) => text(o, 80)).filter(Boolean).slice(0, 12);
    const type = r.type === 'select' && options.length >= 2 ? 'select' : 'text';
    return [Object.freeze({ id: `q${i + 1}`, label, type, required: r.required === true, options: Object.freeze(type === 'select' ? options : []) })];
  });
  const ctaRaw = (s.cta && typeof s.cta === 'object' ? s.cta : null) as Record<string, unknown> | null;
  const ctaUrl = ctaRaw ? text(ctaRaw.url, 2000) : '';
  const ctaLabel = ctaRaw ? text(ctaRaw.label, 80) : '';
  const cta: WebinarCta | null = ctaRaw && ctaLabel && HTTPS_URL.test(ctaUrl) ? Object.freeze({
    label: ctaLabel, url: ctaUrl, body: text(ctaRaw.body, 400),
    mode: ctaRaw.mode === 'timed' ? 'timed' : 'manual',
    atSeconds: ctaRaw.mode === 'timed' && Number.isInteger(ctaRaw.atSeconds) && (ctaRaw.atSeconds as number) >= 0 && (ctaRaw.atSeconds as number) <= 86_400 ? ctaRaw.atSeconds as number : null,
  }) : null;
  const replayRaw = (s.replay && typeof s.replay === 'object' ? s.replay : {}) as Record<string, unknown>;
  const days = replayRaw.availableDays;
  const offsets = (Array.isArray(s.reminderOffsetsMinutes) ? s.reminderOffsetsMinutes : DEFAULT_SETTINGS.reminderOffsetsMinutes)
    .filter((n): n is number => Number.isInteger(n) && (n as number) >= 5 && (n as number) <= 10_080);
  const opens = s.roomOpensMinutesBefore;
  const accent = text(s.accentColor, 7);
  const privacy = text(s.privacyUrl, 500);
  const marketing = text(s.marketingConsentText, 500);
  return Object.freeze({
    questions: Object.freeze(questions),
    serviceNotice: text(s.serviceNotice, 500) || DEFAULT_SETTINGS.serviceNotice,
    marketingConsentText: marketing || null,
    consentVersion: text(s.consentVersion, 40) || DEFAULT_SETTINGS.consentVersion,
    privacyUrl: HTTPS_URL.test(privacy) ? privacy : null,
    cta,
    replay: Object.freeze({
      enabled: replayRaw.enabled === undefined ? DEFAULT_SETTINGS.replay.enabled : replayRaw.enabled === true,
      availableDays: days === null ? null : Number.isInteger(days) && (days as number) >= 1 && (days as number) <= 3650 ? days as number : DEFAULT_SETTINGS.replay.availableDays,
    }),
    reminderOffsetsMinutes: Object.freeze([...new Set(offsets)].sort((a, b) => b - a).slice(0, 4)),
    roomOpensMinutesBefore: Number.isInteger(opens) && (opens as number) >= 0 && (opens as number) <= 120 ? opens as number : DEFAULT_SETTINGS.roomOpensMinutesBefore,
    questionsEnabled: s.questionsEnabled === undefined ? true : s.questionsEnabled === true,
    questionsModerated: s.questionsModerated === undefined ? true : s.questionsModerated === true,
    accentColor: /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : null,
    crmOpportunityPrefix: text(s.crmOpportunityPrefix, 40) || DEFAULT_SETTINGS.crmOpportunityPrefix,
  });
}

/** The full event as the services see it (rows from app.webinar_events). */
export interface WebinarEvent {
  readonly workspaceId: string;
  readonly id: string;
  readonly publicKey: string;
  readonly kind: WebinarKind;
  readonly status: WebinarStatus;
  readonly title: string;
  readonly summary: string;
  readonly presenterName: string;
  readonly presenterTitle: string;
  readonly timezone: string;
  readonly startsAt: string | null;
  readonly durationMinutes: number;
  readonly capacity: number | null;
  readonly settings: WebinarSettings;
  readonly scheduleVersion: number;
  readonly videoUid: string | null;
  readonly videoState: VideoState;
  readonly videoDurationSeconds: number | null;
  readonly liveInputUid: string | null;
  readonly liveState: LiveState;
  readonly liveCheckedAt: string | null;
  readonly sessionState: SessionState;
  readonly sessionStartedAt: string | null;
  readonly sessionEndedAt: string | null;
  readonly recordingUid: string | null;
  readonly recordingState: RecordingState;
  readonly recordingDurationSeconds: number | null;
  readonly ctaRevealedAt: string | null;
}

export interface WebinarBrand {
  readonly workspaceName: string;
  readonly productName: string | null;
  readonly primaryColor: string | null;
  readonly accentColor: string | null;
  readonly supportEmail: string | null;
}

function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' && v ? new Date(v).toISOString() : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Maps either a camelCase JSON object (definer functions) or a snake_case row. */
export function toEvent(r: Record<string, unknown>): WebinarEvent {
  const g = (camel: string, snake: string): unknown => (camel in r ? r[camel] : r[snake]);
  return Object.freeze({
    workspaceId: String(g('workspaceId', 'workspace_id')),
    id: String(r.id),
    publicKey: String(g('publicKey', 'public_key')),
    kind: g('kind', 'kind') as WebinarKind,
    status: g('status', 'status') as WebinarStatus,
    title: String(g('title', 'title')),
    summary: String(g('summary', 'summary') ?? ''),
    presenterName: String(g('presenterName', 'presenter_name') ?? ''),
    presenterTitle: String(g('presenterTitle', 'presenter_title') ?? ''),
    timezone: String(g('timezone', 'timezone')),
    startsAt: iso(g('startsAt', 'starts_at')),
    durationMinutes: Number(g('durationMinutes', 'duration_minutes')),
    capacity: num(g('capacity', 'capacity')),
    settings: readSettings(g('settings', 'settings')),
    scheduleVersion: Number(g('scheduleVersion', 'schedule_version')),
    videoUid: (g('videoUid', 'video_uid') as string | null) ?? null,
    videoState: g('videoState', 'video_state') as VideoState,
    videoDurationSeconds: num(g('videoDurationSeconds', 'video_duration_seconds')),
    liveInputUid: (g('liveInputUid', 'live_input_uid') as string | null) ?? null,
    liveState: g('liveState', 'live_state') as LiveState,
    liveCheckedAt: iso(g('liveCheckedAt', 'live_checked_at')),
    sessionState: g('sessionState', 'session_state') as SessionState,
    sessionStartedAt: iso(g('sessionStartedAt', 'session_started_at')),
    sessionEndedAt: iso(g('sessionEndedAt', 'session_ended_at')),
    recordingUid: (g('recordingUid', 'recording_uid') as string | null) ?? null,
    recordingState: g('recordingState', 'recording_state') as RecordingState,
    recordingDurationSeconds: num(g('recordingDurationSeconds', 'recording_duration_seconds')),
    ctaRevealedAt: iso(g('ctaRevealedAt', 'cta_revealed_at')),
  });
}
