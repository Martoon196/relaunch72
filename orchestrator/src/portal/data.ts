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

function readJsonSafe<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

function readBrand(dir: string): DashboardData['brand'] {
  const s3 = readJsonSafe<{ positioning_statement?: string; message_pillars?: string[]; voice?: { sliders?: Record<string, number> } }>(path.join(dir, 's3.json'));
  if (!s3) return undefined;
  // Pillar lead-in = the framing before the first colon/quote (drops raw quote fragments).
  const pillars = (s3.message_pillars ?? []).map((p) => p.split(/[:("]/)[0]!.trim()).filter(Boolean);
  return { positioning: s3.positioning_statement, pillars, sliders: s3.voice?.sliders ?? {} };
}

function readArtifacts(dir: string): DashboardData['artifacts'] {
  const out: DashboardData['artifacts'] = {};
  const cc = readJsonSafe<{ topic: string; pillar: { working_title: string; search_intent: string }; supporting: { working_title: string; search_intent: string }[] }>(path.join(dir, 'cc.json'));
  if (cc) {
    out.cluster = {
      topic: cc.topic,
      articles: [
        { title: cc.pillar.working_title, intent: cc.pillar.search_intent, role: 'pillar' },
        ...cc.supporting.map((s) => ({ title: s.working_title, intent: s.search_intent, role: 'supporting' })),
      ],
    };
  }
  const kw = readJsonSafe<{ queries: { query: string; volume: number | null }[] }>(path.join(dir, 'keyword-report.json'));
  if (kw) out.keywords = kw.queries.map((q) => ({ query: q.query, volume: q.volume }));
  const ad = readJsonSafe<{ ad_sets: { headlines: string[]; primary_texts: string[]; cta: string }[] }>(path.join(dir, 'ad.json'));
  if (ad?.ad_sets?.[0]) out.ad = { headlines: ad.ad_sets[0].headlines, primary: ad.ad_sets[0].primary_texts[0] ?? '', cta: ad.ad_sets[0].cta };
  const s8 = readJsonSafe<{ posts: { platform: string; hook: string; body: string }[] }>(path.join(dir, 's8.json'));
  if (s8?.posts?.[0]) out.post = { platform: s8.posts[0].platform, hook: s8.posts[0].hook, body: s8.posts[0].body };
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
