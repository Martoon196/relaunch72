/**
 * Keyword rail CLI — enrich a Soro content cluster's fan-out queries with search
 * volume, ranked by demand.
 *
 *   # £0 dry run (deterministic mock volumes, labelled 'mock'):
 *   npm run keyword -- --run runs/<id> --mock
 *
 *   # Live (needs DATAFORSEO_LOGIN/PASSWORD in .env):
 *   npm run keyword -- --run runs/<id>
 *
 * Reads cc.json (the cluster), pulls volume for the pillar + supporting target
 * queries, writes keyword-report.json ranked high→low. Mock output is clearly
 * labelled and must not be presented to a customer as real. Exit 0 ok · 1 error.
 */

import fs from 'node:fs';
import path from 'node:path';
import '../config.js';
import { MockKeywordProvider } from './mock.js';
import { DataForSeoProvider } from './dataforseo.js';
import type { KeywordProvider } from './types.js';

interface CliArgs { run?: string; mock: boolean }

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mock: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') args.run = argv[++i];
    else if (a === '--mock') args.mock = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run keyword -- --run runs/<id> [--mock]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.run) throw new Error('Provide --run <run dir> (a run with a cc.json content cluster)');
  return args;
}

interface Cluster {
  topic: string;
  pillar: { slug: string; target_query: string };
  supporting: { slug: string; target_query: string }[];
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(args.run as string);
  const ccFile = path.join(runDir, 'cc.json');
  if (!fs.existsSync(ccFile)) throw new Error(`${runDir} has no cc.json — run the content engine first (npm run content).`);
  const cluster = JSON.parse(fs.readFileSync(ccFile, 'utf8')) as Cluster;

  const targets = [
    { slug: cluster.pillar.slug, role: 'pillar', query: cluster.pillar.target_query },
    ...cluster.supporting.map((s) => ({ slug: s.slug, role: 'supporting', query: s.target_query })),
  ];
  const queries = targets.map((t) => t.query);

  const provider: KeywordProvider = args.mock ? new MockKeywordProvider() : new DataForSeoProvider();
  console.log(`Keyword volumes for ${path.basename(runDir)} — ${queries.length} queries · provider: ${provider.mode}${provider.mode === 'live' ? ' (DataForSEO)' : ''}`);

  const metrics = await provider.metrics(queries);
  const byKeyword = new Map(metrics.map((m) => [m.keyword.toLowerCase(), m]));

  const ranked = targets
    .map((t) => {
      const m = byKeyword.get(t.query.toLowerCase());
      return { ...t, volume: m?.volume ?? null, difficulty: m?.difficulty ?? null, cpc: m?.cpc ?? null, source: m?.source ?? provider.mode };
    })
    .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));

  for (const r of ranked) {
    console.log(`   ${String(r.volume ?? '—').padStart(7)}  ${r.role.padEnd(10)} ${r.query}`);
  }

  const report = {
    run: path.basename(runDir),
    topic: cluster.topic,
    provider: provider.mode,
    source: metrics[0]?.source ?? provider.mode,
    generated_for: 'query prioritisation — NOT for injection into article copy',
    queries: ranked,
  };
  fs.writeFileSync(path.join(runDir, 'keyword-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n✓ Report written: ${runDir}/keyword-report.json`);
  if (provider.mode === 'mock') console.log('NOTE: mock provider — volumes are synthetic (source: mock) and must never be shown to a customer as real.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  });
