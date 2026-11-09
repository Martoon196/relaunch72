/**
 * Durable Creative Studio render jobs. Drafting, editing, refreshing, focal changes, storyboards and video recording
 * run in the background worker instead of inside the HTTP request. The owner's request records one job (keyed by the
 * form's command id, so a refresh or double click returns the same job); the worker runs the same service method
 * for that job's sponsor. Every service command is itself idempotent, so a retried job replays instead of duplicating.
 * Rendering is local (Chromium on the worker): no provider is called and nothing is charged.
 */
import type { SeoBlogStore } from '../seo-blog/store.js';
import { SeoBlogError, type Job } from '../seo-blog/types.js';
import type { BackgroundComponent } from './types.js';
import type { ConceptPatch } from './service.js';

export const CREATIVE_RENDER_SCHEMA = 'relaunch72.creative-render/v1' as const;
export const CREATIVE_RENDER_STAGE = 'creative_render' as const;

/** Backgrounds are resolved and stored by the owner's request; the worker re-verifies the stored bytes. */
export type PreparedBackground = { readonly kind: 'keep' } | { readonly kind: 'neutral' } | { readonly kind: 'prepared'; readonly component: BackgroundComponent };
export type RenderOperation =
  | { readonly op: 'draft'; readonly raw: Readonly<Record<string, string | readonly string[]>>; readonly background: PreparedBackground }
  | { readonly op: 'refresh'; readonly setId: string; readonly conceptKey: string; readonly heads: readonly string[] }
  | { readonly op: 'edit'; readonly setId: string; readonly conceptKey: string; readonly heads: readonly string[]; readonly patch: ConceptPatch; readonly background: PreparedBackground }
  | { readonly op: 'focal'; readonly versionId: string; readonly focal: { readonly x: number; readonly y: number } }
  | { readonly op: 'storyboard'; readonly setId: string; readonly conceptKey: string; readonly placement: string; readonly likeness: boolean }
  | { readonly op: 'storyboard_edit'; readonly versionId: string; readonly scenes: readonly Readonly<Record<string, unknown>>[] }
  | { readonly op: 'video'; readonly versionId: string };
export interface RenderResult { readonly setId: string; readonly anchor: string | null; readonly message: string }
export interface RenderPayload {
  readonly schema: typeof CREATIVE_RENDER_SCHEMA;
  readonly commandId: string;
  readonly sponsorUserId: string;
  readonly operation: RenderOperation;
  readonly result?: RenderResult;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPS = new Set(['draft', 'refresh', 'edit', 'focal', 'storyboard', 'storyboard_edit', 'video']);
export const RENDER_LABEL: Readonly<Record<RenderOperation['op'], string>> = Object.freeze({
  draft: 'Creating artwork', refresh: 'Re-rendering a concept', edit: 'Saving concept changes', focal: 'Moving the focal point',
  storyboard: 'Drafting a storyboard', storyboard_edit: 'Saving the storyboard', video: 'Recording and checking the video',
});

export function isCreativeRenderJob(job: Pick<Job, 'kind' | 'payload'>): boolean {
  return job.kind === 'write' && job.payload.stage === CREATIVE_RENDER_STAGE;
}

export function newRenderJob(brandId: string, sponsorUserId: string, commandId: string, operation: RenderOperation, now: string): Job {
  if (!UUID.test(brandId) || !UUID.test(sponsorUserId) || !UUID.test(commandId) || !OPS.has(operation.op)) throw new SeoBlogError(400, 'Refresh the page and try again.');
  const render: RenderPayload = { schema: CREATIVE_RENDER_SCHEMA, commandId: commandId.toLowerCase(), sponsorUserId, operation };
  return { id: commandId.toLowerCase(), brandId, kind: 'write', idempotencyKey: `creative-render:${commandId.toLowerCase()}`, payload: { stage: CREATIVE_RENDER_STAGE, render },
    state: 'queued', attempts: 0, maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null, runAfter: now, progress: `${RENDER_LABEL[operation.op]}…`,
    error: null, createdAt: now, updatedAt: now, rowVersion: 0 };
}

export function decodeRenderJob(job: Job): RenderPayload {
  const r = job.payload.render as Record<string, unknown> | undefined;
  const op = (r?.operation as Record<string, unknown> | undefined)?.op;
  if (!isCreativeRenderJob(job) || !r || r.schema !== CREATIVE_RENDER_SCHEMA || r.commandId !== job.id || typeof r.sponsorUserId !== 'string' || !UUID.test(r.sponsorUserId)
    || typeof op !== 'string' || !OPS.has(op)) throw new SeoBlogError(409, 'This render task is not recognised. Nothing was rendered.');
  return r as unknown as RenderPayload;
}

/** The service surface a render job needs; the worker builds it for the job's sponsor. */
export interface RenderService {
  draft(actorId: string, brandId: string, commandId: string, raw: Readonly<Record<string, string | readonly string[] | undefined>>, choice: PreparedBackground): Promise<{ setId: string; note: string | null; replayed: boolean }>;
  refreshConcept(actorId: string, brandId: string, setId: string, conceptKey: string, commandId: string, heads: readonly string[]): Promise<{ replayed: boolean }>;
  editConcept(actorId: string, brandId: string, setId: string, conceptKey: string, commandId: string, heads: readonly string[], patch: ConceptPatch, choice: PreparedBackground): Promise<{ replayed: boolean; changed: string[] }>;
  editFocal(actorId: string, brandId: string, versionId: string, commandId: string, focal: { x: number; y: number }): Promise<{ replayed: boolean }>;
  createStoryboard(actorId: string, brandId: string, setId: string, conceptKey: string, placement: never, commandId: string, likeness: boolean): Promise<{ replayed: boolean }>;
  editStoryboard(actorId: string, brandId: string, versionId: string, commandId: string, scenes: readonly Record<string, unknown>[]): Promise<{ replayed: boolean; changed: string[] }>;
  renderVideo(actorId: string, brandId: string, versionId: string, commandId: string): Promise<{ replayed: boolean; playable: boolean }>;
  artworkSet(actorId: string, brandId: string, versionId: string): Promise<string>;
}

/** Runs one decoded operation through the ordinary service methods (the same code the request used to run inline). */
export async function executeRender(service: RenderService, brandId: string, p: RenderPayload): Promise<RenderResult> {
  const a = p.sponsorUserId, c = p.commandId, o = p.operation;
  switch (o.op) {
    case 'draft': {
      const r = await service.draft(a, brandId, c, o.raw, o.background);
      return { setId: r.setId, anchor: null, message: r.replayed ? 'These images were already created.' : `Images created for review.${r.note ? ` ${r.note}` : ''}` };
    }
    case 'refresh':
      await service.refreshConcept(a, brandId, o.setId, o.conceptKey, c, o.heads);
      return { setId: o.setId, anchor: null, message: 'Concept re-rendered from the current brand context. Review the new versions.' };
    case 'edit': {
      const r = await service.editConcept(a, brandId, o.setId, o.conceptKey, c, o.heads, o.patch, o.background);
      return { setId: o.setId, anchor: null, message: r.changed.length ? `Saved: ${r.changed.join(', ')} changed. New versions need review.` : 'No change to save.' };
    }
    case 'focal': {
      const setId = await service.artworkSet(a, brandId, o.versionId);
      await service.editFocal(a, brandId, o.versionId, c, { x: o.focal.x, y: o.focal.y });
      return { setId, anchor: null, message: 'Focal point moved for this format only. The new version needs review.' };
    }
    case 'storyboard':
      await service.createStoryboard(a, brandId, o.setId, o.conceptKey, o.placement as never, c, o.likeness);
      return { setId: o.setId, anchor: null, message: 'Storyboard drafted from this concept. It is a plan, not a video; review the scenes, then render.' };
    case 'storyboard_edit': {
      const setId = await service.artworkSet(a, brandId, o.versionId);
      const r = await service.editStoryboard(a, brandId, o.versionId, c, o.scenes);
      return { setId, anchor: null, message: r.changed.length ? `Storyboard saved (${r.changed.slice(0, 4).join(', ')}${r.changed.length > 4 ? '…' : ''}). Render a new video to include the changes.` : 'No change to save.' };
    }
    case 'video': {
      const setId = await service.artworkSet(a, brandId, o.versionId);
      const r = await service.renderVideo(a, brandId, o.versionId, c);
      return { setId, anchor: null, message: r.playable ? 'Video rendered and verified as playable. Review it before approving.' : 'The video did not pass the playback check and cannot be approved. Render it again.' };
    }
  }
}

const sameClaim = (current: Job, claim: Job) => current.state === 'running' && current.leaseOwner === claim.leaseOwner && current.attempts === claim.attempts;

/**
 * Worker coordinator for one claimed render job. Owner-correctable problems (changed facts, newer versions, missing
 * inputs) stop the job with the service's message; an unavailable renderer or an unexpected error is retried once.
 */
export async function runCreativeRenderJob(claim: Job, deps: {
  readonly store: Pick<SeoBlogStore, 'getJob' | 'updateJob'>;
  readonly service: (payload: RenderPayload, claim: Job) => RenderService;
  readonly now: () => string;
}): Promise<Job> {
  const current = await deps.store.getJob(claim.brandId, claim.id);
  if (!current || !sameClaim(current, claim)) return current ?? claim;
  const finish = async (patch: Partial<Job>): Promise<Job> => {
    const latest = await deps.store.getJob(claim.brandId, claim.id);
    if (!latest || !sameClaim(latest, claim)) return latest ?? claim;
    return deps.store.updateJob({ ...latest, leaseOwner: null, leaseExpiresAt: null, updatedAt: deps.now(), ...patch });
  };
  let payload: RenderPayload;
  try { payload = decodeRenderJob(current); } catch (e) { return finish({ state: 'blocked', error: (e as Error).message, progress: (e as Error).message }); }
  try {
    const result = await executeRender(deps.service(payload, current), claim.brandId, payload);
    return finish({ state: 'done', error: null, progress: result.message, payload: { ...current.payload, render: { ...payload, result } } });
  } catch (e) {
    const status = e instanceof SeoBlogError ? e.status : 500;
    const retry = status >= 500 && current.attempts < current.maxAttempts;
    const message = status < 500 ? (e as Error).message.slice(0, 600)
      : retry ? 'The renderer was unavailable. The task will be retried shortly; nothing was published.' : 'The artwork could not be rendered on the server. Nothing was published. Try again later.';
    return finish({ state: retry ? 'queued' : 'blocked', error: retry ? null : message, progress: message,
      ...(retry ? { runAfter: new Date(Date.parse(deps.now()) + 60_000).toISOString() } : {}) });
  }
}
