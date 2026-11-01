/**
 * LLM-backed stages for the blog engine: brand-profile extraction, autonomous
 * cluster planning, full article writing and single-section regeneration.
 *
 * All calls go through the platform `LlmClient` (live Anthropic API or the
 * explicit mock). A mock run is recorded as `simulated` and shown as such.
 * Untrusted material (uploads, fetched pages, research passages) is fenced in
 * tagged data blocks; the prompts treat it as data, never instructions.
 */

import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import { stageModel } from '../config.js';
import { extractJson } from '../llm/json.js';
import type { LlmClient } from '../llm/client.js';
import { loadPrompt, type LoadedPrompt } from '../stages/prompt.js';
import type {
  ArticleBody, ArticleBrief, ArticlePromotionPack, BrandProfile, GenerationRecord, InventoryPage, KnowledgeDocument, LengthPreference, ResearchSource,
} from './types.js';
import { SeoBlogError } from './types.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<AnySchema, ValidateFunction>();
function validatorFor(schema: AnySchema): ValidateFunction {
  let v = validators.get(schema);
  if (!v) { v = ajv.compile(schema); validators.set(schema, v); }
  return v;
}

export class GenerationUnavailableError extends SeoBlogError {
  constructor(message = 'Article generation is not configured. Connect a model API key before generating.') {
    super(409, message, 'generation_unavailable');
  }
}

export interface JsonCallResult<T> {
  readonly value: T;
  readonly record: GenerationRecord;
}

/** One schema-validated JSON call with a single critique retry; never ships unvalidated output. */
export async function callJson<T>(llm: LlmClient, input: {
  readonly prompt: LoadedPrompt;
  readonly system?: string;
  readonly user: string;
  readonly schema: AnySchema;
  readonly maxTokens: number;
  readonly validate?: (value: T) => string[];
}): Promise<JsonCallResult<T>> {
  const model = stageModel(input.prompt.header.stage, input.prompt.header.model);
  const validate = validatorFor(input.schema);
  let tokensIn = 0;
  let tokensOut = 0;
  let critique = '';
  let previous = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: input.user }];
    if (critique) {
      messages.push({ role: 'assistant', content: previous.slice(0, 60_000) || '{}' });
      messages.push({ role: 'user', content: `Your previous answer was rejected:\n${critique}\nReturn corrected JSON only.` });
    }
    let response;
    try {
      response = await llm.complete({
        model, maxTokens: input.maxTokens, system: input.system ?? input.prompt.body, messages, thinking: false,
        meta: { stage: input.prompt.header.stage, attempt },
      });
    } catch (error) {
      throw new GenerationUnavailableError(`The writing model could not be reached (${(error as Error).message.slice(0, 160)}). Nothing was changed.`);
    }
    tokensIn += response.tokensIn;
    tokensOut += response.tokensOut;
    previous = response.text;
    const parsed = extractJson(response.text);
    if ('error' in parsed) { critique = `Not valid JSON: ${parsed.error}`; continue; }
    if (!validate(parsed.value)) {
      critique = (validate.errors ?? []).slice(0, 12).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('\n');
      continue;
    }
    const problems = input.validate?.(parsed.value as T) ?? [];
    if (problems.length > 0) { critique = problems.slice(0, 12).join('\n'); continue; }
    return {
      value: parsed.value as T,
      record: { mode: llm.mode === 'live' ? 'live' : 'simulated', model: response.model || model, promptVersion: `${input.prompt.file}@${input.prompt.header.version}#${input.prompt.sha256.slice(0, 12)}`, tokensIn, tokensOut },
    };
  }
  throw new SeoBlogError(422, `The model did not return a usable result after a retry. ${critique.split('\n')[0] ?? ''}`.trim(), 'generation_rejected');
}

export function dataBlock(tag: string, value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  // Neutralise attempts to close the fence from inside the data.
  return `<${tag}>\n${text.replace(new RegExp(`</?${tag}\\b[^>]*>`, 'gi'), '[removed tag]')}\n</${tag}>`;
}

export async function writeArticlePromotions(llm: LlmClient, profile: BrandProfile, article: ArticleBody): Promise<JsonCallResult<{ posts: ArticlePromotionPack['posts'] }>> {
  return callJson(llm, {
    prompt: loadPrompt('seo-blog-social.md'), maxTokens: 2400,
    user: [dataBlock('brand_profile', profileForPrompt(profile)), dataBlock('blog_article', article)].join('\n\n'),
    schema: { type: 'object', additionalProperties: false, required: ['posts'], properties: { posts: {
      type: 'array', minItems: 2, maxItems: 2, items: { type: 'object', additionalProperties: false,
        required: ['network', 'title', 'copy', 'artworkInstructions'], properties: {
          network: { enum: ['instagram', 'linkedin'] }, title: { type: 'string', minLength: 3, maxLength: 200 },
          copy: { type: 'string', minLength: 30, maxLength: 1800 }, artworkInstructions: { type: 'string', minLength: 10, maxLength: 800 },
        } },
    } } },
    validate: value => [
      ...(new Set(value.posts.map(p => p.network)).size !== 2 ? ['Provide exactly one post per network.'] : []),
      ...value.posts.flatMap(p => /https?:\/\/|<\/?[a-z]/i.test(p.copy) ? ['Copy must contain no URLs or HTML.'] : []),
    ],
  });
}

// ─── Profile ─────────────────────────────────────────────────────────────────

const STR = { type: 'string' } as const;
const STR_ARR = { type: 'array', items: STR, maxItems: 40 } as const;

export const PROFILE_SCHEMA: AnySchema = {
  type: 'object',
  required: ['summary', 'audiences', 'positioning', 'offers', 'conversionPages', 'voice', 'approvedClaims', 'exclusions', 'conflicts', 'missingFacts'],
  properties: {
    summary: { type: 'string', minLength: 10, maxLength: 1200 },
    audiences: STR_ARR,
    positioning: { type: 'string', maxLength: 1200 },
    offers: { type: 'array', maxItems: 30, items: { type: 'object', required: ['name', 'description'], properties: {
      name: STR, description: STR, price: { type: ['string', 'null'] }, url: { type: ['string', 'null'] }, sourceDocumentId: { type: ['string', 'null'] },
    } } },
    conversionPages: { type: 'array', maxItems: 20, items: { type: 'object', required: ['url', 'label'], properties: { url: STR, label: STR } } },
    voice: { type: 'object', required: ['tone', 'do', 'dont', 'examples'], properties: { tone: STR_ARR, do: STR_ARR, dont: STR_ARR, examples: { type: 'array', items: STR, maxItems: 5 } } },
    approvedClaims: STR_ARR,
    exclusions: STR_ARR,
    conflicts: { type: 'array', maxItems: 30, items: { type: 'object', required: ['field', 'detail', 'documentIds'], properties: { field: STR, detail: STR, documentIds: STR_ARR } } },
    missingFacts: STR_ARR,
  },
};

export type ExtractedProfile = Pick<BrandProfile, 'summary' | 'audiences' | 'positioning' | 'offers' | 'conversionPages' | 'voice' | 'approvedClaims' | 'exclusions' | 'conflicts' | 'missingFacts'>;

export async function extractProfile(llm: LlmClient, input: {
  readonly brandName: string;
  readonly website: string | null;
  readonly documents: readonly KnowledgeDocument[];
}): Promise<JsonCallResult<ExtractedProfile>> {
  const readable = input.documents.filter((d) => d.active && d.text);
  if (readable.length === 0) throw new SeoBlogError(409, 'Upload at least one readable guidance document or paste brand text first.', 'no_knowledge');
  const docs = readable.map((d) => ({ id: d.id, version: d.version, category: d.category, title: d.title, text: (d.text ?? '').slice(0, 60_000) }));
  const prompt = loadPrompt('seo-blog-profile.md');
  const ids = new Set(readable.map((d) => d.id));
  return callJson<ExtractedProfile>(llm, {
    prompt,
    schema: PROFILE_SCHEMA,
    maxTokens: 8000,
    user: [`Brand name: ${input.brandName}`, `Website: ${input.website ?? '(not supplied)'}`, dataBlock('knowledge_documents', docs)].join('\n\n'),
    validate: (v) => [
      ...v.offers.filter((o) => o.price && (!o.sourceDocumentId || !ids.has(o.sourceDocumentId))).map((o) => `offer "${o.name}" has a price without a valid sourceDocumentId`),
      ...v.conversionPages.filter((p) => !/^https:\/\//.test(p.url)).map((p) => `conversion page ${p.url} is not an absolute https URL`),
    ],
  });
}

// ─── Planning ────────────────────────────────────────────────────────────────

const SLUG = { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', minLength: 3, maxLength: 80 } as const;

function planArticle(role: 'pillar' | 'supporting'): AnySchema {
  return {
    type: 'object',
    required: ['role', 'slug', 'working_title', 'target_query', 'search_intent', 'related_questions', 'angle', 'outline', 'key_points', 'why_fit', 'cta_url', 'internal_links', 'source_ids'],
    properties: {
      role: { type: 'string', enum: [role] },
      slug: SLUG,
      working_title: { type: 'string', minLength: 10, maxLength: 120 },
      target_query: { type: 'string', minLength: 6, maxLength: 140 },
      search_intent: { type: 'string', enum: ['buy', 'compare', 'learn'] },
      related_questions: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 6, maxLength: 160 } },
      angle: { type: 'string', minLength: 20, maxLength: 500 },
      outline: { type: 'array', minItems: role === 'pillar' ? 4 : 3, maxItems: 12, items: { type: 'string', minLength: 4, maxLength: 140 } },
      key_points: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'string', minLength: 10, maxLength: 400 } },
      why_fit: { type: 'string', minLength: 20, maxLength: 500 },
      cta_url: { type: ['string', 'null'] },
      internal_links: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 3, maxLength: 500 } },
      source_ids: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 20 } },
    },
  };
}

export const PLAN_SCHEMA: AnySchema = {
  type: 'object',
  required: ['topic', 'money_page', 'pillar', 'supporting', 'provenance_note'],
  properties: {
    topic: { type: 'string', minLength: 3, maxLength: 160 },
    money_page: { type: 'object', required: ['url', 'label'], properties: { url: { type: ['string', 'null'] }, label: { type: 'string', maxLength: 120 } } },
    pillar: planArticle('pillar'),
    supporting: { type: 'array', minItems: 6, maxItems: 6, items: planArticle('supporting') },
    provenance_note: { type: 'string', minLength: 10, maxLength: 800 },
  },
};

export interface PlannedArticle {
  readonly role: 'pillar' | 'supporting';
  readonly slug: string;
  readonly working_title: string;
  readonly target_query: string;
  readonly search_intent: 'buy' | 'compare' | 'learn';
  readonly related_questions: string[];
  readonly angle: string;
  readonly outline: string[];
  readonly key_points: string[];
  readonly why_fit: string;
  readonly cta_url: string | null;
  readonly internal_links: string[];
  readonly source_ids: string[];
}

export interface PlannedCluster {
  readonly topic: string;
  readonly money_page: { readonly url: string | null; readonly label: string };
  readonly pillar: PlannedArticle;
  readonly supporting: PlannedArticle[];
  readonly provenance_note: string;
}

export function shortSourceIds(sources: readonly ResearchSource[]): Map<string, ResearchSource> {
  return new Map(sources.map((s, i) => [`S${i + 1}`, s]));
}

export function profileForPrompt(profile: BrandProfile): Record<string, unknown> {
  return {
    summary: profile.summary, audiences: profile.audiences, positioning: profile.positioning, offers: profile.offers,
    conversionPages: profile.conversionPages, voice: profile.voice, approvedClaims: profile.approvedClaims,
    exclusions: profile.exclusions, unresolvedConflicts: profile.conflicts, missingFacts: profile.missingFacts,
  };
}

export async function proposeCluster(llm: LlmClient, input: {
  readonly brandName: string;
  readonly profile: BrandProfile;
  readonly inventory: readonly InventoryPage[];
  readonly sources: readonly ResearchSource[];
  readonly focus: string | null;
  readonly excluded: readonly string[];
  readonly sourceArticleUrl: string | null;
}): Promise<JsonCallResult<PlannedCluster>> {
  const short = shortSourceIds(input.sources);
  const inventoryUrls = new Set(input.inventory.filter((p) => p.fetchStatus === 'ok').flatMap((p) => [p.url, p.canonical].filter((u): u is string => Boolean(u))));
  const conversion = new Set(input.profile.conversionPages.map((p) => p.url));
  return callJson<PlannedCluster>(llm, {
    prompt: loadPrompt('seo-blog-plan.md'),
    schema: PLAN_SCHEMA,
    maxTokens: 16000,
    user: [
      `Brand: ${input.brandName}`,
      dataBlock('brand_profile', profileForPrompt(input.profile)),
      dataBlock('website_inventory', input.inventory.filter((p) => p.fetchStatus === 'ok').slice(0, 120).map((p) => ({ url: p.canonical ?? p.url, title: p.title, headings: p.headings.slice(0, 6), editorial: p.editorial }))),
      dataBlock('research_sources', [...short].map(([id, s]) => ({ id, url: s.url, title: s.title, primary: s.primary, passage: s.passage }))),
      dataBlock('owner_inputs', { focus: input.focus, excluded_subjects: input.excluded, source_article: input.sourceArticleUrl }),
    ].join('\n\n'),
    validate: (v) => {
      const problems: string[] = [];
      const all = [v.pillar, ...v.supporting];
      const slugs = new Set(all.map((a) => a.slug));
      if (slugs.size !== all.length) problems.push('slugs must be unique across the cluster');
      for (const a of all) {
        for (const id of a.source_ids) if (!short.has(id)) problems.push(`${a.slug}: unknown source id ${id}`);
        for (const link of a.internal_links) {
          if (/^https?:\/\//.test(link) ? !inventoryUrls.has(link) : !slugs.has(link)) problems.push(`${a.slug}: internal link ${link} is neither an existing page nor a cluster slug`);
        }
        if (a.cta_url && !conversion.has(a.cta_url) && !inventoryUrls.has(a.cta_url)) problems.push(`${a.slug}: cta_url must be a conversion page or existing page`);
        const excluded = input.excluded.find((x) => x && `${a.working_title} ${a.target_query}`.toLowerCase().includes(x.toLowerCase()));
        if (excluded) problems.push(`${a.slug}: covers excluded subject "${excluded}"`);
      }
      return problems;
    },
  });
}

// ─── Writing ─────────────────────────────────────────────────────────────────

export const ARTICLE_SCHEMA: AnySchema = {
  type: 'object',
  required: ['title', 'seo_title', 'meta_description', 'excerpt', 'intro', 'sections', 'conclusion', 'faqs', 'image_alt', 'public_source_ids'],
  properties: {
    title: { type: 'string', minLength: 10, maxLength: 140 },
    seo_title: { type: 'string', minLength: 10, maxLength: 70 },
    meta_description: { type: 'string', minLength: 50, maxLength: 170 },
    excerpt: { type: 'string', minLength: 20, maxLength: 400 },
    intro: { type: 'string', minLength: 40, maxLength: 4000 },
    sections: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'object', required: ['heading', 'body'], properties: {
      heading: { type: 'string', minLength: 3, maxLength: 140 }, body: { type: 'string', minLength: 40, maxLength: 12000 },
    } } },
    conclusion: { type: 'string', minLength: 20, maxLength: 3000 },
    faqs: { type: 'array', maxItems: 8, items: { type: 'object', required: ['q', 'a'], properties: { q: { type: 'string', minLength: 5, maxLength: 200 }, a: { type: 'string', minLength: 10, maxLength: 1500 } } } },
    image_alt: { type: 'string', minLength: 5, maxLength: 200 },
    public_source_ids: { type: 'array', maxItems: 20, items: { type: 'string' } },
  },
};

export interface WrittenArticle {
  readonly title: string;
  readonly seo_title: string;
  readonly meta_description: string;
  readonly excerpt: string;
  readonly intro: string;
  readonly sections: { heading: string; body: string }[];
  readonly conclusion: string;
  readonly faqs: { q: string; a: string }[];
  readonly image_alt: string;
  readonly public_source_ids: string[];
}

const LENGTH_HINT: Record<LengthPreference, string> = {
  concise: 'concise — cover the question fully, about 700–1,100 words',
  standard: 'standard — thorough but tight, about 1,100–1,800 words',
  'in-depth': 'in-depth — comprehensive pillar treatment, about 1,800–2,800 words, only if every section earns its place',
};

export function sourceMarkers(text: string): string[] {
  return [...text.matchAll(/\[src:([A-Za-z0-9-]{1,64})\]/g)].map((m) => m[1]!);
}

export async function writeArticle(llm: LlmClient, input: {
  readonly profile: BrandProfile;
  readonly brief: ArticleBrief;
  readonly sources: readonly ResearchSource[];
  readonly linkable: readonly { url: string; title: string | null }[];
  readonly length: LengthPreference;
}): Promise<JsonCallResult<WrittenArticle> & { readonly short: Map<string, ResearchSource> }> {
  const short = shortSourceIds(input.sources);
  const prompt = loadPrompt('seo-blog-article.md');
  const allowedLinks = new Set([...input.linkable.map((l) => l.url), ...input.sources.map((s) => s.url)]);
  const result = await callJson<WrittenArticle>(llm, {
    prompt,
    system: prompt.body.replace('{{LENGTH}}', LENGTH_HINT[input.length]),
    schema: ARTICLE_SCHEMA,
    maxTokens: 16000,
    user: [
      dataBlock('brand_profile', profileForPrompt(input.profile)),
      dataBlock('brief', {
        role: input.brief.role, working_title: input.brief.workingTitle, target_query: input.brief.targetQuery,
        search_intent: input.brief.searchIntent, related_questions: input.brief.relatedQuestions, angle: input.brief.angle,
        outline: input.brief.outline, key_points: input.brief.keyPoints, call_to_action: input.brief.cta,
      }),
      dataBlock('research_sources', [...short].map(([id, s]) => ({ id, url: s.url, title: s.title, primary: s.primary, passage: s.passage }))),
      dataBlock('linkable_pages', input.linkable.slice(0, 80)),
    ].join('\n\n'),
    validate: (v) => {
      const text = [v.intro, ...v.sections.map((s) => s.body), v.conclusion, ...v.faqs.map((f) => f.a)].join('\n');
      const problems = sourceMarkers(text).filter((id) => !short.has(id)).map((id) => `unknown source marker [src:${id}]`);
      for (const m of text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) if (!allowedLinks.has(m[1]!)) problems.push(`link ${m[1]} is not a listed page or source`);
      if (/<\s*[a-z!\/]/i.test(text)) problems.push('HTML is not allowed inside bodies');
      for (const id of v.public_source_ids) if (!short.has(id)) problems.push(`unknown public source id ${id}`);
      return problems;
    },
  });
  return { ...result, short };
}

export async function rewriteSection(llm: LlmClient, input: {
  readonly profile: BrandProfile;
  readonly outline: readonly string[];
  readonly section: { heading: string; body: string };
  readonly instruction: string;
  readonly sources: readonly ResearchSource[];
  readonly linkable: readonly { url: string; title: string | null }[];
}): Promise<JsonCallResult<{ heading: string; body: string }> & { readonly short: Map<string, ResearchSource> }> {
  const short = shortSourceIds(input.sources);
  const allowedLinks = new Set([...input.linkable.map((l) => l.url), ...input.sources.map((s) => s.url)]);
  const result = await callJson<{ heading: string; body: string }>(llm, {
    prompt: loadPrompt('seo-blog-section.md'),
    schema: { type: 'object', required: ['heading', 'body'], properties: { heading: { type: 'string', minLength: 3, maxLength: 140 }, body: { type: 'string', minLength: 40, maxLength: 12000 } } },
    maxTokens: 6000,
    user: [
      dataBlock('brand_profile', profileForPrompt(input.profile)),
      dataBlock('article_outline', input.outline),
      dataBlock('section', input.section),
      dataBlock('owner_instruction', input.instruction.slice(0, 1000) || 'Improve clarity and usefulness without changing the facts.'),
      dataBlock('research_sources', [...short].map(([id, s]) => ({ id, url: s.url, title: s.title, passage: s.passage }))),
      dataBlock('linkable_pages', input.linkable.slice(0, 80)),
    ].join('\n\n'),
    validate: (v) => {
      const problems = sourceMarkers(v.body).filter((id) => !short.has(id)).map((id) => `unknown source marker [src:${id}]`);
      for (const m of v.body.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) if (!allowedLinks.has(m[1]!)) problems.push(`link ${m[1]} is not a listed page or source`);
      if (/<\s*[a-z!\/]/i.test(v.body)) problems.push('HTML is not allowed inside bodies');
      return problems;
    },
  });
  return { ...result, short };
}

/** Replace short prompt ids ([src:S3]) with durable source ids. */
export function resolveMarkers(text: string, short: Map<string, ResearchSource>): string {
  return text.replace(/\[src:([A-Za-z0-9-]{1,64})\]/g, (m, id: string) => {
    const source = short.get(id);
    return source ? `[src:${source.id}]` : m;
  });
}
