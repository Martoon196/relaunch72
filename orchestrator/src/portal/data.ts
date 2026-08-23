/**
 * Assemble a client's dashboard: their CRM view (from the store) plus, if their
 * brand brain has been generated, the strategy (S3) and this period's artifacts
 * (Soro cluster, keyword report, ad set, social post) read from their run dir.
 * Everything degrades gracefully — a brand-new tenant still gets a valid (emptier)
 * dashboard.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Activity, Contact, PipelineStage, Tenant } from '../crm/types.js';
import type { CrmStore } from '../crm/store.js';

export interface DashboardData {
  tenant: Tenant;
  contacts: Contact[];
  pipeline: Record<PipelineStage, number>;
  activity: Activity[];
  brand?: { positioning?: string; pillars: string[]; sliders: Record<string, number> };
  artifacts: {
    cluster?: { topic: string; articles: { title: string; intent: string; role: string }[] };
    keywords?: { query: string; volume: number | null }[];
    ad?: { headlines: string[]; primary: string; cta: string };
    post?: { platform: string; hook: string; body: string };
  };
}

function readJsonSafe(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown; } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nonEmptyStringArray(value: unknown): string[] {
  return stringArray(value).map((item) => item.trim()).filter(Boolean);
}

function readBrand(dir: string): DashboardData['brand'] {
  const s3 = readJsonSafe(path.join(dir, 's3.json'));
  if (!isRecord(s3)) return undefined;
  // Pillar lead-in = the framing before the first colon/quote (drops raw quote fragments).
  const pillars = nonEmptyStringArray(s3.message_pillars).map((p) => p.split(/[:("]/)[0]!.trim()).filter(Boolean);
  const rawSliders = isRecord(s3.voice) && isRecord(s3.voice.sliders) ? s3.voice.sliders : {};
  const sliders = Object.fromEntries(Object.entries(rawSliders).filter((entry): entry is [string, number] => (
    typeof entry[1] === 'number' && Number.isFinite(entry[1])
  )));
  const positioning = nonEmptyString(s3.positioning_statement) ?? undefined;
  if (!positioning && pillars.length === 0 && Object.keys(sliders).length === 0) return undefined;
  return { positioning, pillars, sliders };
}

function readArtifacts(dir: string): DashboardData['artifacts'] {
  const out: DashboardData['artifacts'] = {};
  const cc = readJsonSafe(path.join(dir, 'cc.json'));
  const clusterTopic = isRecord(cc) ? nonEmptyString(cc.topic) : null;
  const pillarTitle = isRecord(cc) && isRecord(cc.pillar) ? nonEmptyString(cc.pillar.working_title) : null;
  const pillarIntent = isRecord(cc) && isRecord(cc.pillar) ? nonEmptyString(cc.pillar.search_intent) : null;
  if (isRecord(cc) && clusterTopic && isRecord(cc.pillar) && pillarTitle && pillarIntent) {
    const supporting = Array.isArray(cc.supporting) ? cc.supporting.flatMap((candidate) => (
      isRecord(candidate)
        ? (() => {
            const title = nonEmptyString(candidate.working_title);
            const intent = nonEmptyString(candidate.search_intent);
            return title && intent ? [{ title, intent, role: 'supporting' }] : [];
          })()
        : []
    )) : [];
    out.cluster = {
      topic: clusterTopic,
      articles: [
        { title: pillarTitle, intent: pillarIntent, role: 'pillar' },
        ...supporting,
      ],
    };
  }
  const kw = readJsonSafe(path.join(dir, 'keyword-report.json'));
  if (isRecord(kw) && Array.isArray(kw.queries)) {
    out.keywords = kw.queries.flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      const query = nonEmptyString(candidate.query);
      if (!query) return [];
      const volume = candidate.volume;
      return [{
        query,
        volume: typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 ? volume : null,
      }];
    });
  }
  const ad = readJsonSafe(path.join(dir, 'ad.json'));
  const firstAd = isRecord(ad) && Array.isArray(ad.ad_sets) ? ad.ad_sets[0] : undefined;
  if (isRecord(firstAd)) {
    const headlines = nonEmptyStringArray(firstAd.headlines);
    const primary = nonEmptyStringArray(firstAd.primary_texts)[0];
    const cta = nonEmptyString(firstAd.cta);
    if (headlines.length > 0 && primary && cta) out.ad = { headlines, primary, cta };
  }
  const s8 = readJsonSafe(path.join(dir, 's8.json'));
  const firstPost = isRecord(s8) && Array.isArray(s8.posts) ? s8.posts[0] : undefined;
  if (isRecord(firstPost)) {
    const platform = nonEmptyString(firstPost.platform);
    const hook = nonEmptyString(firstPost.hook);
    const body = nonEmptyString(firstPost.body);
    if (platform && hook && body) out.post = { platform, hook, body };
  }
  return out;
}

export function makeDashboard(store: CrmStore, runDirFor: (t: Tenant) => string | undefined) {
  return async function dashboard(tenantId: string): Promise<DashboardData | null> {
    let view;
    try { view = await store.tenantView(tenantId); } catch { return null; }
    const dir = runDirFor(view.tenant);
    const brand = dir && fs.existsSync(dir) ? readBrand(dir) : undefined;
    const artifacts = dir && fs.existsSync(dir) ? readArtifacts(dir) : {};
    return { tenant: view.tenant, contacts: view.contacts, pipeline: view.pipeline, activity: view.activity, brand, artifacts };
  };
}
