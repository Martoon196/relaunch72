/**
 * The twelve page states from the second review of the SEO report, and the change behind each check the headline can
 * name, so a test can really make the listed changes and compare the score with the promise (copied from the review).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { editorPage } from '../src/portal/seo-blog-article-view.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import * as sp from './seo-panel-fixtures.js';
const shell = () => ({ ...fx.shell(), preview: { needsYou: 1, path: '/x' } }) as never;
export function states(): Record<string, any> {
  const strongV = fx.version(4, sp.strongBody()); const badSlug = fx.version(5, { ...sp.strongBody(), slug: 'maximum-offer-guide' } as never);
  const pub = fx.pageData('published'); const mf = fx.pageData('must_fix'); const rd = fx.pageData('ready');
  const on = (d: any, v: any, issues: any = d.article.checks?.issues ?? []) => ({ ...d, article: { ...d.article, currentVersionId: v.id, ...(d.article.publishedVersionId ? { publishedVersionId: v.id } : {}), checks: { ...d.article.checks, versionId: v.id, issues } }, version: v, versions: [v] });
  return {
    'ready': { ...rd, articleBrief: sp.brief() },
    'ready, picture': { ...fx.pageData('ready_picture'), articleBrief: sp.brief() },
    'must fix (fresh)': { ...mf, articleBrief: sp.brief() },
    'stale checks with a must-fix': { ...mf, article: { ...mf.article, currentVersionId: strongV.id }, version: strongV, versions: [strongV], articleBrief: sp.brief() },
    'stale checks, fixture body': (() => { const v = fx.version(6, fx.body()); return { ...mf, article: { ...mf.article, currentVersionId: v.id }, version: v, versions: [v], articleBrief: sp.brief() }; })(),
    'live (published)': { ...pub, articleBrief: sp.brief() },
    'live, strong body, address lacks the phrase': { ...on(pub, badSlug, []), articleBrief: sp.brief() },
    'no brief': { ...rd, articleBrief: null },
    'no website': { ...fx.pageData('no_website'), articleBrief: sp.brief() },
    'scheduled': { ...fx.pageData('scheduled'), articleBrief: sp.measured() },
    'publishing now': { ...rd, article: { ...rd.article, delivery: 'publishing' }, articleBrief: sp.brief() },
    'strong body, ready': { ...on(rd, strongV, []), articleBrief: sp.brief() },
  };
}
export function lead(d: any) {
  const h = editorPage(shell(), { ...d, open: ['seo'] });
  const headline = /<h4 class="sp-sub sp-lead">([^<]+)<\/h4>/.exec(h)?.[1] ?? /<p class="sp-sub">([^<]+)<\/p>/.exec(h)?.[1] ?? '?';
  const top = /<ul class="sp-checks sp-top">([\s\S]*?)<\/ul>/.exec(h)?.[1] ?? '';
  const names = [...top.matchAll(/<strong>([^<]+)<\/strong>[\s\S]*?(?:<p class="sp-todo">([\s\S]*?)<\/p>)?<\/div><\/li>/g)].map((m) => `${m[1]}${/<a /.test(m[2] ?? '') ? '' : ' [NO LINK]'}`);
  const capNote = /<p class="ap-note sp-cap">([\s\S]*?)<\/p>/.exec(h)?.[1]?.replace(/<[^>]+>/g, '') ?? null;
  const score = Number(/SEO score (\d+) out of 100/.exec(h)?.[1]);
  const m = /from (\d+) to (\d+)/.exec(headline);
  return { headline, names, capNote, score, from: m ? Number(m[1]) : null, to: m ? Number(m[2]) : null, html: h };
}

const strong = sp.strongBody() as any;
const PIC = { kind: 'brand_asset', url: 'https://www.martinhowardproperty.example/images/terrace.jpg', alt: 'A terraced house with scaffolding during a refurbishment', provenance: '', width: 1536, height: 1024 };
export const FIX: Record<string, (b: any) => any> = {
  'A main picture with a picture description': (b) => ({ ...b, image: PIC }),
  'The search phrase is in the opening paragraph': (b) => { const intro = b.intro.replace('If you know how to appraise a deal,', 'If you know how to appraise a property deal,'); if (intro === b.intro) throw new Error('opening'); return { ...b, intro }; },
  'The questions people ask are answered': (b) => ({ ...b, sections: [...b.sections, strong.sections.find((s: any) => s.id === 'extra-1')] }),
  'The search phrase is in one or two sub-headings': (b) => ({ ...b, sections: [{ ...b.sections[0], heading: 'How to appraise a property deal, step by step' }, ...b.sections.slice(1)] }),
  'A link to another page on your own site': (b) => ({ ...b, sections: b.sections.map((s: any, i: number) => i === 9 ? { ...s, body: `${s.body}\n\nIf you want a second opinion, [book a deal review](https://www.martinhowardproperty.example/deal-review).` } : s) }),
  'Article length': (b) => ({ ...b, sections: [...b.sections, { id: 'len-1', heading: 'A worked example from start to finish', body: 'Take a tired three-bedroom terrace on the market at £140,000. Similar houses in good order on the same street have sold for about £195,000 in the last year, so that is the end value.\n\nThe work is a new kitchen and bathroom, a rewire, plastering and decoration, which two builders price at around £28,000. Add a tenth for surprises. Buying costs, including tax, legal fees and a survey, come to roughly £7,500, and six months of finance, insurance and council tax add another £5,000.\n\nNow take those costs and the profit you need away from the end value. With a target profit of £30,000, the most you can pay is a little under £122,000. The asking price is too high, but an offer near £120,000 would leave the deal intact. Written down like this, the number is easy to explain to the agent and easy to walk away from if the seller will not move.' }, { id: 'len-2', heading: 'What to do when the numbers are close', body: 'A deal that only just works is not a deal yet. Go back through each line and ask which figure you are least sure of. It is usually the cost of the work or the end value.\n\nGet a second quote, look for one more comparable sale, and see whether the gap closes. If it does not, lower your offer by the amount of the doubt and let the seller decide.' }] }),
  'Varied wording': (b) => ({ ...b, sections: b.sections.map((s: any) => s.id === 'extra-2' ? { ...s, body: s.body.replace('What is left is your maximum offer.', 'The figure that remains is the most you should pay.') } : s) }),
  'Sub-headings': (b) => ({ ...b, sections: b.sections.map((s: any) => /bad day/.test(s.heading) ? { ...s, body: `${s.body} Most investors skip this step, and it is the one that protects them when prices dip.` } : s) }),
};
