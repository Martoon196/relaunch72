/**
 * Neutral owner words: the one place that turns internal reasons, diagnostics and error text into plain sentences a
 * client may read. Nothing returned here names a supplier, a model, a model maker, a method pack, a product name or
 * internal vocabulary, and every sentence still says truthfully what happens next.
 *
 * Stored records keep their raw text. These functions only decide what is shown; the founder's screens add the raw
 * text underneath (see src/portal/owner-detail.ts).
 */
import { researchDiagnostic, type ResearchDiagnostic } from './programme.js';

type Category = ResearchDiagnostic['category'];

/** What the owner reads about research, by the diagnostic's category (never its stored summary, which may name the supplier). */
const RESEARCH_WORDS: Record<Category, { readonly summary: string; readonly next: string }> = {
  transient: { summary: 'The research service had a temporary problem.', next: 'We try again automatically, at most twice, within your research allowance.' },
  task_failed: { summary: 'The research service could not complete this research.', next: 'Nothing more is spent. You can choose to try again from Topics.' },
  credentials: { summary: 'Research is not available for this business right now.', next: 'Nothing more is spent and nothing repeats by itself. Once it is available again, you can choose to try again from Topics.' },
  verification: { summary: 'Research is not available for this business right now.', next: 'Nothing more is spent and nothing repeats by itself. Once it is available again, you can choose to try again from Topics.' },
  payment: { summary: 'Research is not available for this business right now.', next: 'Nothing more is spent and nothing repeats by itself. Once it is available again, you can choose to try again from Topics.' },
  daily_limit: { summary: 'Research has reached its limit for today.', next: 'Nothing more is spent and nothing repeats by itself. You can choose to try again from Topics tomorrow.' },
  entitlement: { summary: 'Research is not available for this business right now.', next: 'Nothing more is spent and nothing repeats by itself. Once it is available again, you can choose to try again from Topics.' },
  unknown: { summary: 'The research service could not complete this, and we cannot tell whether it finished.', next: 'Nothing repeats by itself. Review the earlier result, then choose to try again from Topics if you want to.' },
};

/** The neutral summary and next step for a research diagnostic. */
export function researchWords(diagnostic: Pick<ResearchDiagnostic, 'category'>): { readonly summary: string; readonly next: string } {
  return RESEARCH_WORDS[diagnostic.category] ?? RESEARCH_WORDS.unknown;
}

/** The optional demand-data warning, which never names who measures demand. */
export const DEMAND_UNAVAILABLE = 'Search demand figures are not available for this plan, so demand is described in words instead.';

// Every summary the research diagnostics can store, so a stored job or event message is recognised by what it says.
// Built on first use: programme.ts also imports this module.
let knownResearch: readonly { readonly summary: string; readonly category: Category }[] | null = null;
const KNOWN_RESEARCH = () => knownResearch ??= (() => {
  const all = [40101, 40103, 40100, 40104, 40200, 40203, 40204].map((code) => researchDiagnostic(code));
  all.push(researchDiagnostic(null, 401), researchDiagnostic(null));
  return all.map((d) => ({ summary: d.summary, category: d.category }));
})();

/** Writing-step failures that came from the writing service itself (connection, overload, the SDK's own error text). */
const WRITING_UNREACHABLE = 'The writing service could not be reached. Nothing was changed. You can try again from Activity.';
/** The draft came back but did not pass the writing standard and its checks. */
const DRAFT_NOT_ACCEPTED = 'The draft did not meet the writing standard, so it was not saved. Its use of your writing allowance is recorded. You can try again from Activity.';
/** The writing standard (method configuration) is not usable for this business at the moment. */
const STANDARD_UNAVAILABLE = 'The writing standard for this business is not available right now, so this task is waiting. Nothing was changed. You can try again from Activity once it is available.';
/** The writing step started but its result was not confirmed. */
const WRITING_UNCONFIRMED = 'The last writing step did not confirm its result, so it will not repeat by itself. Check Activity before trying again.';
/** Last resort: something internal stopped the task and its words cannot be shown. */
const GENERIC_STOP = 'Something stopped this task before it finished. Nothing was published. You can try again from Activity.';

const WHOLE_MESSAGE: readonly (readonly [RegExp, string])[] = [
  // Image generation failures name the image service, its model and its maker.
  [/openai|gpt-image|dall-e|image request failed|\/v1\/images\//i, 'Image generation could not finish. Nothing was published or approved. You can try again.'],
  // The engine's budget refusal (BudgetExceededError) carries the raw units; the owner reads what it means.
  [/^Writing allowance: .*Used [\d,]+; ceiling/s, 'There is not enough writing allowance left this month for this, so nothing was started. You can raise the allowance in Publishing settings.'],
  [/^Research allowance: .*Used [\d,]+; ceiling/s, 'There is not enough research allowance left this month for this, so nothing was started. You can raise the allowance in Publishing settings.'],
  [/^Image allowance: .*Used [\d,]+; ceiling/s, 'There is not enough image allowance left this month for this, so nothing was started. You can raise the allowance in Publishing settings.'],
  [/method generation outcome is uncertain/i, WRITING_UNCONFIRMED],
  [/writing model could not be reached|could not reach the writing model|anthropic|overloaded_error|rate_limit_error|api_error|authentication_error|\bAPIError\b|\bAPIConnection/i, WRITING_UNREACHABLE],
  [/production methods could not produce|bounded method context|did not return a usable result/i, DRAFT_NOT_ACCEPTED],
  [/\bmethods?\b.*\b(release|hash|dependenc|capability|assignment|assigned|identity|file is missing|approval)|\b(release|dependency|capability|assignment|assigned)\b.*\bmethods?\b|^Unavailable capability|^Missing exact dependency|^Cyclic method|^Duplicate method|^Public commercial method/i, STANDARD_UNAVAILABLE],
];

/** Phrase-level changes for text that is otherwise fine to show: internal vocabulary becomes owner vocabulary. */
const PHRASES: readonly (readonly [RegExp, string])[] = [
  [/\ba writing model API key\b/gi, 'the writing service'],
  [/\bAPI key\b/gi, 'connection'],
  [/\bno new model call\b/gi, 'nothing is written again'],
  [/\bwithout a new model call\b/gi, 'without writing again'],
  [/\bmodel calls\b/gi, 'writing steps'],
  [/\bmodel call\b/gi, 'writing step'],
  [/\bmodel run\b/gi, 'writing step'],
  [/\bthe writing model\b/gi, 'the writing service'],
  [/\bwriting model\b/gi, 'writing service'],
  [/\bmodel tokens\b/gi, 'writing units'],
  [/\b(\d[\d,]*) tokens\b/gi, '$1 writing units'],
  [/\bsupplier attempts\b/gi, 'research attempts'],
  [/\bsupplier charges?\b/gi, 'research costs'],
  [/\bresearch provider\b/gi, 'research service'],
  [/\bimage provider\b/gi, 'image service'],
  [/\bthe provider\b(?=.{0,3}s content policy)/gi, 'the image service'],
  [/\bthe provider\b/gi, 'the connected service'],
  [/\bprovider\b/gi, 'connected service'],
  [/\bthe supplier\b/gi, 'the research service'],
  [/\bsupplier\b/gi, 'research service'],
  [/\bsimulated\b/gi, 'practice'],
];

/**
 * Anything that would reveal how the work is done: who supplies the data, which model or model maker writes,
 * which method pack or product name shapes the writing, and internal identifiers. Used to decide when a message
 * must be replaced as a whole. Kept specific so ordinary owner text (an article title, a business name) passes.
 */
const REVEALING = /dataforseo|data for seo|serpapi|anthropic|\bclaude\b|claude-|sonnet|\bopus\b|haiku|\bopenai\b|\bgpt\b|gpt-|gemini|\bzernio\b|\bAPI key\b|\bmethod packs?\b|\bproduction packs?\b|\bprompt(?:s|Version)?\b|\btokens?\b|\bsupplier\b|\bprovider\b|\bsimulated\b|\btask_id\b|\b40[0-9]{3}\b|\b(?:production-core|editorial-planning|blog-writing|conversion-copy|social-repurposing|visual-briefing|email-writing|advocacy-and-referral|brand-context-building|offer-design|journey-review|audience-resonance)\b|\b(?:core|plan|blog|cta|social|visual|email|advocacy|brand|offer|journey|audience)\.[a-z]+(?:-[a-z]+)+\b|\bRL72 [A-Z]|Engine Room|Longform Forge|Hook &(?:amp;)? Close|Inbox Engine|Word of Mouth Engine|Art Director|Editor.s Desk|Brain Builder|Deal Shaper|Funnel Scan|Focus Room/i;

/** True when the text would reveal the supplier, a model or maker, a method pack or product name, or internal vocabulary. */
export function revealsInternals(text: string): boolean {
  return REVEALING.test(text);
}

/**
 * The owner-facing version of a stored message (a task's error or progress, an activity line, a signed page notice).
 * Text that is already neutral comes back exactly as it was.
 */
export function ownerWords(raw: string): string {
  if (!raw) return raw;
  const research = KNOWN_RESEARCH().find((k) => raw.startsWith(k.summary) || raw.includes(`: ${k.summary}`));
  if (research) { const w = researchWords(research); return `${w.summary} ${w.next}`; }
  for (const [pattern, sentence] of WHOLE_MESSAGE) if (pattern.test(raw)) return sentence;
  let text = raw;
  for (const [pattern, replacement] of PHRASES) text = text.replace(pattern, replacement);
  return revealsInternals(text) ? GENERIC_STOP : text;
}

/** An activity line: the engine prefixes task failures with the task kind ("write: …"); the owner reads the sentence. */
export function ownerActivityWords(raw: string): string {
  const task = /^(inventory|plan|write|publish|daily|profile|image|campaign|social|brand_dna|[a-z_]+): (.*)$/s.exec(raw);
  if (task && /^[a-z_]+$/.test(task[1]!)) {
    const words = ownerWords(task[2]!);
    return words === task[2] ? raw : words;
  }
  return ownerWords(raw);
}
