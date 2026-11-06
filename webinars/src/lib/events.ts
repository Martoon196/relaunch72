/**
 * Every webinar action becomes an event row (raw analytics stream) and, for each matching
 * webhook endpoint, a delivery that the Queue consumer signs and POSTs to Growth HQ.
 *
 * The payload is fully built at emit time (so retries are byte-identical) and carries a
 * `crm` block — the Growth HQ action this event maps to, computed from the brand's CRM
 * mapping — so a Growth HQ workflow can apply it without its own lookup tables.
 */
import type { Env, Mode } from '../env.js';
import { resolveConfig, type BrandRow, type BrandSettings } from './config.js';
import { newId, nowIso, parseJson } from './util.js';

export const EVENT_TYPES = [
  'registrant.created',
  'registrant.updated',
  'session.started',
  'session.ended',
  'attendee.joined',
  'attendee.left',
  'attendee.no_show',
  'cta.clicked',
  'question.asked',
  'poll.answered',
  'recording.ready',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EmitInput {
  brandId: string;
  mode: Mode;
  type: EventType;
  webinarId?: string | null;
  sessionId?: string | null;
  registrantId?: string | null;
  data?: Record<string, unknown>;
  /** Fields merged into the registrant block (e.g. the plaintext magic link, only known at registration). */
  registrantExtra?: Record<string, unknown>;
  now?: number;
}

export interface CrmHint {
  action: string | null;
  tags_add: string[];
  tags_remove: string[];
  lead_score_delta: number;
  pipeline_id?: string | null;
  stage_id?: string | null;
  sequence?: string | null;
  stop_sequence?: string | null;
  custom_field?: { key: string; value: unknown } | null;
  note?: string | null;
  notify_owner?: boolean;
}

export function crmHint(type: EventType, settings: BrandSettings, webinarSlug: string | null, data: Record<string, unknown>): CrmHint {
  const crm = settings.crm;
  const tag = (s: string) => `${crm.tag_prefix}:${webinarSlug ?? 'unknown'}:${s}`;
  const base: CrmHint = { action: null, tags_add: [], tags_remove: [], lead_score_delta: 0 };
  switch (type) {
    case 'registrant.created':
    case 'registrant.updated':
      return { ...base, action: 'upsert_contact', tags_add: [tag('registered')], sequence: type === 'registrant.created' ? 'webinar_confirmation_and_reminders' : null };
    case 'attendee.joined':
      return { ...base, action: 'tag_contact', tags_add: [tag('attended')], tags_remove: [tag('no_show')], stop_sequence: 'webinar_no_show', lead_score_delta: crm.lead_score.attended };
    case 'attendee.left': {
      const pct = Number(data.percent_watched ?? 0);
      return pct >= crm.engaged_threshold_pct
        ? { ...base, action: 'score_contact', tags_add: [tag('engaged')], lead_score_delta: crm.lead_score.engaged }
        : { ...base, action: null };
    }
    case 'attendee.no_show':
      return { ...base, action: 'start_sequence', tags_add: [tag('no_show')], sequence: 'webinar_missed_it_replay' };
    case 'cta.clicked':
      return { ...base, action: 'create_opportunity', tags_add: [tag('cta_clicked')], pipeline_id: crm.pipeline_id ?? null, stage_id: crm.stage_id ?? null, notify_owner: true, lead_score_delta: crm.lead_score.cta_clicked };
    case 'question.asked':
      return { ...base, action: 'add_note', note: String(data.body ?? ''), lead_score_delta: crm.lead_score.question_asked };
    case 'poll.answered':
      return { ...base, action: data.crm_field ? 'set_custom_field' : null, custom_field: data.crm_field ? { key: String(data.crm_field), value: data.option } : null };
    case 'recording.ready':
      return { ...base, action: 'unlock_replay' };
    default:
      return base;
  }
}

interface WebinarLite { id: string; slug: string; title: string; type: string }
interface SessionLite { id: string; starts_at: string | null; ends_at: string | null; kind: string; status: string }
interface RegistrantLite { id: string; email: string; name: string; phone: string | null; utm_json: string; source_url: string | null; answers_json: string; ghq_contact_id: string | null; session_id: string | null }

export async function emitEvent(env: Pick<Env, 'DB' | 'WEBHOOKS'>, input: EmitInput): Promise<string> {
  const db = env.DB;
  const ts = nowIso(input.now);
  const brand = await db.prepare('SELECT * FROM brands WHERE id = ?').bind(input.brandId).first<BrandRow>();
  if (!brand) throw new Error(`emitEvent: unknown brand ${input.brandId}`);

  const registrant = input.registrantId
    ? await db.prepare('SELECT id, email, name, phone, utm_json, source_url, answers_json, ghq_contact_id, session_id, webinar_id FROM registrants WHERE id = ?').bind(input.registrantId).first<RegistrantLite & { webinar_id: string }>()
    : null;
  const sessionId = input.sessionId ?? registrant?.session_id ?? null;
  const session = sessionId
    ? await db.prepare('SELECT id, webinar_id, starts_at, ends_at, kind, status FROM sessions WHERE id = ?').bind(sessionId).first<SessionLite & { webinar_id: string }>()
    : null;
  const webinarId = input.webinarId ?? session?.webinar_id ?? registrant?.webinar_id ?? null;
  const webinar = webinarId
    ? await db.prepare('SELECT id, slug, title, type, overrides_json FROM webinars WHERE id = ?').bind(webinarId).first<WebinarLite & { overrides_json: string }>()
    : null;

  const cfg = resolveConfig(brand, webinar?.overrides_json);
  const data = input.data ?? {};
  const id = newId('evt');
  const payload = {
    id,
    type: input.type,
    created_at: ts,
    mode: input.mode,
    brand: { id: brand.id, slug: brand.slug, name: brand.name, ghq_account_id: cfg.settings.crm.account_id ?? brand.ghq_account_id },
    webinar: webinar ? { id: webinar.id, slug: webinar.slug, title: webinar.title, type: webinar.type } : null,
    session: session ? { id: session.id, starts_at: session.starts_at, ends_at: session.ends_at, kind: session.kind, status: session.status } : null,
    registrant: registrant
      ? {
          id: registrant.id,
          email: registrant.email,
          name: registrant.name,
          phone: registrant.phone,
          answers: parseJson(registrant.answers_json, {}),
          utm: parseJson(registrant.utm_json, {}),
          source_url: registrant.source_url,
          ghq_contact_id: registrant.ghq_contact_id,
          ...(input.registrantExtra ?? {}),
        }
      : null,
    data,
    crm: crmHint(input.type, cfg.settings, webinar?.slug ?? null, data),
  };

  const stmts: D1PreparedStatement[] = [
    db.prepare('INSERT INTO events (id, brand_id, mode, type, registrant_id, session_id, webinar_id, data_json, ts) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, brand.id, input.mode, input.type, registrant?.id ?? null, session?.id ?? null, webinar?.id ?? null, JSON.stringify(payload), ts),
  ];

  const endpoints = await db
    .prepare('SELECT id, events FROM webhook_endpoints WHERE brand_id = ? AND mode = ? AND active = 1')
    .bind(brand.id, input.mode)
    .all<{ id: string; events: string }>();
  const deliveryIds: string[] = [];
  for (const ep of endpoints.results ?? []) {
    const wanted = parseJson<string[]>(ep.events, ['*']);
    if (!wanted.includes('*') && !wanted.includes(input.type)) continue;
    const did = newId('dlv');
    deliveryIds.push(did);
    stmts.push(
      db.prepare('INSERT INTO webhook_deliveries (id, endpoint_id, event_id, status, attempts, next_attempt_at, created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(did, ep.id, id, 'pending', 0, ts, ts),
    );
  }
  await db.batch(stmts);
  if (deliveryIds.length) {
    try {
      await env.WEBHOOKS.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } })));
    } catch (err) {
      // The cron sweeper re-enqueues pending deliveries, so a queue hiccup only delays them.
      console.error('webhook enqueue failed', err);
    }
  }
  return id;
}
