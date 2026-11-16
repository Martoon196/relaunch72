/**
 * Neutral owner words: the one place that turns internal reasons, diagnostics and error text into plain sentences a
 * client may read. Nothing returned here names a supplier, a model, a model maker, a method pack, a product name or
 * internal vocabulary, and every sentence still says truthfully what happens next.
 *
 * Two kinds of text, two functions:
 * - `ownerWords`: error, diagnostic and progress text the engine produced (a task's error or progress, a refusal).
 *   Known engine templates are replaced by plain sentences; anything still internal falls back to a generic stop.
 * - `noticeWords`: success lines and notices. Only a few exact engine phrases are reworded; there is never a
 *   fallback, so a success line never turns into a failure.
 *
 * In both, the owner's own words pass untouched: quoted titles and names (“…”, "…", ‘…’) and web addresses are
 * lifted out before anything is matched and put back exactly as they were. Ordinary words that can be names
 * (Opus, Gemini, Prompt, Token, Provider, Supplier, Claude) are never matched on their own.
 *
 * Stored records keep their raw text. These functions only decide what is shown; the founder's screens add the raw
 * text underneath (see src/portal/owner-detail.ts).
 */
import { researchDiagnostic, type ResearchDiagnostic } from './programme.js';

type Category = ResearchDiagnostic['category'];

const RESEARCH_UNAVAILABLE = { summary: 'Research is not available for this business right now.', next: 'Nothing more is spent and nothing repeats by itself. Once it is available again, you can choose to try again from Topics.' };
/** What the owner reads about research, by the diagnostic's category (never its stored summary, which may name the supplier). */
const RESEARCH_WORDS: Record<Category, { readonly summary: string; readonly next: string }> = {
  transient: { summary: 'The research service had a temporary problem.', next: 'We try again automatically, at most twice, within your research allowance.' },
  task_failed: { summary: 'The research service could not complete this research.', next: 'Nothing more is spent. You can choose to try again from Topics.' },
  credentials: RESEARCH_UNAVAILABLE,
  verification: RESEARCH_UNAVAILABLE,
  payment: RESEARCH_UNAVAILABLE,
  daily_limit: { summary: 'Research has reached its limit for today.', next: 'Nothing more is spent and nothing repeats by itself. You can choose to try again from Topics tomorrow.' },
  entitlement: RESEARCH_UNAVAILABLE,
  unknown: { summary: 'The research service could not complete this, and we cannot tell whether it finished.', next: 'Nothing repeats by itself. Review the earlier result, then choose to try again from Topics if you want to.' },
};
/** A temporary problem that is no longer being retried (its two automatic retries or the month's research allowance are used up). */
const RESEARCH_NOT_RETRYING = 'It will not try again by itself: its automatic retries or this month’s research allowance are used up. You can try again from Topics when you are ready.';

/**
 * The neutral summary and next step for a research diagnostic. `retrying` says whether an automatic retry is really
 * queued: only then does a temporary problem promise one.
 */
export function researchWords(diagnostic: Pick<ResearchDiagnostic, 'category'>, context: { readonly retrying?: boolean; readonly reason?: string | null } = {}): { readonly summary: string; readonly next: string } {
  const words = RESEARCH_WORDS[diagnostic.category] ?? RESEARCH_WORDS.unknown;
  if (diagnostic.category === 'transient' && (context.reason === 'retries_exhausted' || context.retrying === false)) return { summary: words.summary, next: RESEARCH_NOT_RETRYING };
  return words;
}

/** The optional demand-data warning, which never names who measures demand. */
export const DEMAND_UNAVAILABLE = 'Search demand figures are not available for this plan, so demand is described in words instead.';

// Every summary the research diagnostics can store, so a stored job or event message is recognised by what it says.
// Built on first use: programme.ts also imports this module.
let knownResearch: readonly { readonly summary: string; readonly category: Category }[] | null = null;
const KNOWN_RESEARCH = () => knownResearch ??= (() => {
  const all = [40101, 40103, 40100, 40104, 40200, 40203, 40204, 50000].map((code) => researchDiagnostic(code));
  all.push(researchDiagnostic(null, 401), researchDiagnostic(null, 403), researchDiagnostic(null, 500), researchDiagnostic(null));
  return all.map((d) => ({ summary: d.summary, category: d.category }));
})();

// ─── Owner text: lifted out before matching, put back untouched ─────────────

/** Hosts that belong to the platform's suppliers: an address on one of them is internal, never the owner's. */
const SUPPLIER_HOST = /(?:^|\.)(?:dataforseo\.com|anthropic\.com|claude\.ai|claude\.com|openai\.com|zernio\.com|serpapi\.com)$/i;
const OWNER_SPAN = /“[^”]*”|‘[^’]*’|"[^"\n]{1,300}"|https?:\/\/[^\s"<>)]+/g;
/** Code-like text (a JSON error body): its straight quotes are not the owner's. */
const CODE_SPAN = /“[^”]*”|‘[^’]*’|https?:\/\/[^\s"<>)]+/g;

function masked(raw: string): { text: string; restore: (t: string) => string } {
  const spans: string[] = [];
  const text = raw.replace(/\{\s*"|":/.test(raw) ? CODE_SPAN : OWNER_SPAN, (m) => {
    if (/^https?:/.test(m)) { try { if (SUPPLIER_HOST.test(new URL(m.replace(/[.,;:]+$/, '')).hostname)) return m; } catch { /* not an address */ } }
    spans.push(m); return `\u0000${spans.length - 1}\u0000`;
  });
  return { text, restore: (t) => t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => spans[Number(i)]!) };
}

// ─── Sentences ───────────────────────────────────────────────────────────────

const WRITING_UNREACHABLE = 'The writing service could not be reached. Nothing was changed. You can try again from Activity.';
const DRAFT_NOT_ACCEPTED = 'The draft did not meet the writing standard, so it was not saved. Its use of your writing allowance is recorded. You can try again from Activity.';
const STANDARD_UNAVAILABLE = 'The writing standard for this business is not available right now, so this task is waiting. Nothing was changed. You can try again from Activity once it is available.';
const WRITING_UNCONFIRMED = 'The last writing step did not confirm its result, so it will not repeat by itself. Check Activity before trying again.';
const IMAGE_FAILED = 'Image generation could not finish. Nothing was published or approved. You can try again.';
const SOCIAL_NOT_LINKED = 'Your social accounts are not linked yet. Ask whoever set up your account to link them.';
/** Last resort: something internal stopped the task and its words cannot be shown. Errors only, never a success line. */
const GENERIC_STOP = 'Something stopped this task before it finished. Nothing was published. You can try again from Activity.';

type Rule = readonly [RegExp, string | ((match: string) => string)];

/**
 * Engine messages that are internal from start to finish: the whole message becomes the sentence. Matched on the
 * text with the owner's words lifted out.
 */
const WHOLE: readonly Rule[] = [
  [/\bopenai\b|gpt-image|dall-e|image request failed|\/v1\/images\//i, IMAGE_FAILED],
  // The engine's budget refusal (BudgetExceededError) carries the raw units; the owner reads what it means.
  [/^Writing allowance: .*Used [\d,]+; ceiling/s, 'There is not enough writing allowance left this month for this, so nothing was started. You can raise the allowance in Publishing settings.'],
  [/^Research allowance: .*Used [\d,]+; ceiling/s, 'There is not enough research allowance left this month for this, so nothing was started. You can raise the allowance in Publishing settings.'],
  [/^Image allowance: .*Used [\d,]+; ceiling/s, 'There is not enough image allowance left this month for this, so nothing was started. You can raise the allowance in Publishing settings.'],
  [/retry allowance or search ceiling is exhausted/i, `${RESEARCH_WORDS.transient.summary} ${RESEARCH_NOT_RETRYING}`],
  [/method generation outcome is uncertain/i, WRITING_UNCONFIRMED],
  [/invalid_request_error|stop_reason|max_tokens|prompt is too long|context window/i, 'The writing service could not finish this draft. Nothing was changed. You can try again from Activity.'],
  [/writing model could not be reached|could not reach the writing model|\banthropic\b|overloaded_error|rate_limit_error|api_error|authentication_error|\bAPIError\b|\bAPIConnection|"request_id"|\breq_[0-9A-Za-z]{6,}/i, WRITING_UNREACHABLE],
  [/production methods could not produce|bounded method context|did not return a usable result/i, DRAFT_NOT_ACCEPTED],
  [/\bmethods?\b.*\b(release|hash|dependenc|capability|assignment|assigned|identity|file is missing|approval)|\b(release|dependency|capability|assignment|assigned)\b.*\bmethods?\b|^Unavailable capability|^Missing exact dependency|^Cyclic method|^Duplicate method|^Public commercial method|^Production methods are disabled|reviewed packs/i, STANDARD_UNAVAILABLE],
  // The social posting supplier's own setup steps: the client cannot do them and never sees its name.
  [/^Enter the 24-character account id/i, 'That account could not be used. Ask whoever set up your account to link it.'],
  [/\bzernio\b|externalId|provider profile|provider dashboard/i, SOCIAL_NOT_LINKED],
];

/**
 * Website connection checks (src/seo-blog/publishers): the owner's own website credential. Replaced where they
 * appear, so a label or address before them stays exactly as it was. Each stays an instruction the owner can follow.
 */
const WEBSITE: readonly Rule[] = [
  [/The token can read the repository but cannot write to it\./g, 'Your website connection can read but cannot write. Reconnect it with write access.'],
  [/GitHub refused the saved token\. Reconnect the website\./g, 'GitHub refused your website connection. Reconnect the website.'],
  [/GitHub refused the token\./g, 'GitHub refused your website connection. Reconnect it with a new access key.'],
  [/The repository or branch was not found, or the token cannot see it\./g, 'The repository or branch was not found, or your website connection cannot see it. Check the names, or reconnect with access to that repository.'],
  [/GitHub fine-grained token with Contents read\/write on this repository only/gi, 'GitHub access key with read and write access to this repository only'],
];

/** Exact engine phrases that are fine apart from one internal word. Applied to errors and success lines alike. */
const PHRASES: readonly Rule[] = [
  [/\ba writing model API key\b/g, 'the writing service'],
  [/\bConnect a model API key\b/g, 'Connect the writing service'],
  [/\bno new model call\b/g, 'nothing is written again'],
  [/\bwithout (?:a new|another) model call\b/g, 'without writing again'],
  [/\bmodel calls\b/g, 'writing steps'],
  [/\b(?:This|A|The|the|a|this|previous|earlier) model call\b/g, (m: string) => m.replace('model call', 'writing step')],
  [/\bmodel run\b/g, 'writing step'],
  [/\bthe writing model\b/g, 'the writing service'],
  [/\bwriting model\b/g, 'writing service'],
  [/\bused model tokens\b/g, 'used writing allowance'],
  [/\bmodel tokens\b/g, 'writing units'],
  [/\babout [\d,]+ tokens of [\d,]+ remaining this month\./g, 'within this month’s writing allowance.'],
  [/\bsupplier attempts\b/g, 'research attempts'],
  [/\bresearch provider\b/g, 'research service'],
  [/\bNo provider call was made\b/g, 'Nothing was sent'],
  [/\bno image provider was called\b/g, 'no image service was used'],
  [/\bfor the provider\b/g, 'for the image service'],
  [/\bimage provider\b/g, 'image service'],
  [/\bThe provider(?=’s content policy)/g, 'The image service'],
  [/\buncertain provider outcome\b/g, 'uncertain delivery outcome'],
  [/\buntil the provider confirms\b/g, 'until the social network confirms'],
  [/\bthe host that receives the provider callback\b/g, 'the address your account was set up on'],
  [/\bthis provider has confirmed\b/g, 'the social network has confirmed'],
  [/\bA provider listing\b/g, 'A listing'],
  [/\bProvider accounts\b/g, 'Social accounts'],
  [/\bsimulated (extraction|plan|draft|text|mode)\b/g, 'practice $1'],
  [/\bThe provider callback names a different profile\./g, 'That account connection was for a different profile.'],
  [/\bThe provider callback is invalid\./g, 'That account connection could not be checked. Try connecting it again.'],
  [/\bThe provider callback could not be recorded\./g, 'That account connection could not be recorded. Try connecting it again.'],
  [/\bprovider-verified\b/g, 'verified'],
  [/\bNo historical supplier code, cost or usage was invented\./g, 'No earlier cost or usage was guessed.'],
];

/** Phrases only for error text (never a success line): lower-case engine words with no other meaning there. */
const ERROR_PHRASES: readonly Rule[] = [
  [/\bthe provider\b/g, 'the connected service'],
  [/\bprovider\b/g, 'connected service'],
  [/\bthe supplier\b/g, 'the research service'],
  [/\bsupplier\b/g, 'research service'],
];

/**
 * What would still reveal how the work is done, in engine error text with the owner's words lifted out: who supplies
 * data, model ids and makers, method packs, rule ids, product names and code-like identifiers. Bare words that are
 * also everyday names (Opus, Gemini, Claude, Prompt, Token, Provider) are matched only in the engine's lower-case use.
 */
const REVEALING = new RegExp([
  'dataforseo', 'data for seo', '\\b(?:Claude|Sonnet|Opus|Haiku|Gemini|GPT)[ -]?\\d', '\\b[\\w-]+\\.md@\\d', 'serpapi', '\\banthropic\\b', '\\bopenai\\b', '\\bzernio\\b', 'claude-(?:opus|sonnet|haiku|instant|\\d)', 'gpt-\\d', 'gpt-image',
  '\\bAPI key\\b', '\\bmethod packs?\\b', '\\bproduction packs?\\b', '\\bproduction methods\\b', '\\bpromptVersion\\b', '\\btask_id\\b', '\\b40[0-9]{3}\\b',
  '\\b(?:production-core|editorial-planning|blog-writing|conversion-copy|social-repurposing|visual-briefing|email-writing|advocacy-and-referral|brand-context-building|offer-design|journey-review|audience-resonance)\\b',
  '\\b(?:core|plan|blog|cta|social|visual|email|advocacy|brand|offer|journey|audience)\\.[a-z]+(?:-[a-z]+)+\\b',
  '\\bRL72 [A-Z]', 'Engine Room', 'Longform Forge', 'Hook &(?:amp;)? Close', 'Inbox Engine', 'Word of Mouth Engine', 'Brain Builder', 'Deal Shaper', 'Funnel Scan', 'Focus Room',
].join('|'), 'i');
const LOWER_INTERNAL = /\b(?:tokens?|providers?|suppliers?|prompts?|simulated)\b/;

/** True when engine text (owner words lifted out) would reveal the supplier, a model, a method pack or internal vocabulary. */
export function revealsInternals(text: string): boolean {
  const t = masked(text).text;
  return REVEALING.test(t) || LOWER_INTERNAL.test(t);
}

const apply = (text: string, rules: readonly Rule[]) => rules.reduce((t, [re, to]) => typeof to === 'string' ? t.replace(re, to) : t.replace(re, to), text);

/**
 * The owner-facing version of engine error, diagnostic or progress text (a task's error or progress, a refusal, a
 * status answer). Text that is already neutral comes back exactly as it was; the owner's quoted words and addresses
 * always come back untouched.
 */
export function ownerWords(raw: string): string {
  if (!raw) return raw;
  const research = KNOWN_RESEARCH().find((k) => raw.startsWith(k.summary) || raw.includes(`: ${k.summary}`));
  if (research && !/retry allowance or search ceiling is exhausted/i.test(raw)) {
    const w = researchWords(research, /search ceiling is exhausted|explicit owner resume/i.test(raw) ? { retrying: false } : {});
    return `${w.summary} ${w.next}`;
  }
  const m = masked(raw);
  for (const [pattern, sentence] of WHOLE) if (pattern.test(m.text)) return sentence as string;
  const text = apply(apply(apply(m.text, WEBSITE), PHRASES), ERROR_PHRASES);
  if (REVEALING.test(text) || LOWER_INTERNAL.test(text)) return GENERIC_STOP;
  return m.restore(text);
}

/**
 * The owner-facing version of a success line or notice. Only exact engine phrases change; the owner's words and
 * everything else stay as they were, and a success line never becomes an error.
 */
export function noticeWords(raw: string): string {
  if (!raw) return raw;
  const m = masked(raw);
  let text = apply(apply(m.text, WEBSITE), PHRASES);
  text = text.replace(/\bZernio profile\b/g, 'social profile').replace(/\bProduction packs? /g, 'Writing standards ').replace(/\bproduction packs?\b/g, 'writing standards');
  return m.restore(text);
}

/** Activity kinds whose message is engine error or diagnostic text (everything else is a success or record line). */
const DIAGNOSTIC_KINDS = /^(?:job\.(?!cancelled$|resumed_allowance$)|publish\.(?:held|failed|cancelled)$|image\.held$|social\.attest\.)/;

/**
 * An activity line. Error lines (by the event's kind) read as plain sentences; the engine's task prefix ("write: …")
 * goes. Success and record lines keep every word of the owner's, with only exact engine phrases reworded.
 */
export function ownerActivityWords(raw: string, kind?: string): string {
  const task = /^([a-z_]+): (.*)$/s.exec(raw);
  const diagnostic = kind ? DIAGNOSTIC_KINDS.test(kind) : Boolean(task);
  if (!diagnostic) return noticeWords(raw);
  if (task && (!kind || kind.startsWith('job.'))) {
    const words = ownerWords(task[2]!);
    return words === task[2] ? raw : words;
  }
  return ownerWords(raw);
}
