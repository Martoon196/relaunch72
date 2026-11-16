/**
 * Seeded random website-door cards over pages full of prices, for the rules-v3 price-structure tests. `makeCase(i)` is
 * deterministic: the same index always gives the same pages and the same model answer (with a proposed price structure on
 * some offers). brand-dna-random-cards-8eca59d.json holds, for each index, a hash of what 8eca59d made of the same answer
 * with every `pricing` removed (recorded from an export of 8eca59d; the page reader's action text "▸ " never appears here, as 8eca59d never wrote it), so the test can prove the plain path is unchanged.
 */
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

const NAMES = ['Starter', 'Pro', 'Pro Plus', 'Course', 'The Members Room', 'Members Room', 'Mentoring', 'Gold'];
const AMOUNTS = ['£49', '£49 a month', '£490 a year', '£997', '£1,497', '£67 a month', '£47 a month', '£3,997', '£25', '£9.99', '12% of monthly rent'];
const BITS = ['or', ',', 'Webinar price:', 'for the first 100', 'Set-up fee:', '3 x £525', '6 x £699', '(£4,194 in total)', 'was', 'now', 'Free', 'free', 'credits in full against Mentoring',
  'instead of £67', 'Save £50', 'Total:', 'per walk', 'Founders’ price', 'Early bird:', 'until 1 March', 'We help landlords.', '2 x £80 tyres'];

export interface RandomCase {
  readonly docs: { id: string; text: string; page?: string }[];
  readonly offers: { name: string; description: string; price: string | null; url: null; sourceDocumentId: string; pricing?: { lines: { kind: 'other' | 'plan' | 'special'; text: string; label?: string | null; for?: string | null; total?: string | null }[] } }[];
}

export function makeCase(i: number): RandomCase {
  const random = rng(1000 + i * 7919);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(random() * a.length)]!;
  const line = () => Array.from({ length: 1 + Math.floor(random() * 5) }, () => (random() < 0.5 ? pick(AMOUNTS) : pick(BITS))).join(' ');
  const page = () => {
    const out: string[] = [];
    for (let k = 0; k < 2 + Math.floor(random() * 4); k++) {
      const name = pick(NAMES);
      const r = random();
      if (r < 0.15) out.push(`| ${name} | ${line()} | ${line()}`);
      else { out.push(`${random() < 0.7 ? '## ' : random() < 0.5 ? '• ' : ''}${name}`); for (let j = 0; j < Math.floor(random() * 4); j++) out.push(line()); }
    }
    return out.join('\n');
  };
  const docs = Array.from({ length: 1 + Math.floor(random() * 2) }, (_, k) => ({ id: `d${k}`, text: page(), ...(random() < 0.5 ? { page: `https://x.example/${k}` } : {}) }));
  const words = (t: string) => t.split(/\s+/);
  const slice = () => { const d = pick(docs); const ws = words(d.text.replace(/^(?:#+ |• |\| |▸ )/gmu, '')); const a = Math.floor(random() * ws.length); return ws.slice(a, a + 1 + Math.floor(random() * 4)).join(' '); };
  const offers = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
    const lines = random() < 0.6 ? Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
      const kind = pick(['other', 'plan', 'special'] as const);
      return { kind, text: random() < 0.6 ? pick(AMOUNTS.concat(['3 x £525', '6 x £699'])) : slice(), label: random() < 0.6 ? slice() : null, for: kind === 'plan' ? pick([null, '£1,497', '£997', '£3,997']) : null, total: kind === 'plan' && random() < 0.3 ? '£4,194 in total' : null };
    }) : null;
    return { name: pick(NAMES), description: '', price: random() < 0.2 ? null : pick([...AMOUNTS, 'Free', slice()]), url: null, sourceDocumentId: pick(docs).id, ...(lines ? { pricing: { lines } } : {}) };
  });
  return { docs, offers };
}
