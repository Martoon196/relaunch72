import fs from 'node:fs';
import './src/config.js';
import { STAGES } from './src/stages/defs.js';
import { runStage } from './src/stages/runner.js';
import { AnthropicClient } from './src/llm/client.js';
import type { Intake } from './src/types.js';

async function main() {
  const dir = '/home/user/relaunch72/runs/20260706-142416-trades-c7af';
  const intake = JSON.parse(fs.readFileSync(`${dir}/intake.json`, 'utf8')) as Intake;
  const prior: Record<string, unknown> = {};
  for (const s of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']) {
    const f = `${dir}/${s.toLowerCase()}.json`;
    if (fs.existsSync(f)) prior[s] = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const tmp = fs.mkdtempSync('/tmp/s7probe-');
  const client = new AnthropicClient();
  console.log('Running S7 with maxTokens', STAGES.S7!.maxTokens, '…');
  const { record } = await runStage(STAGES.S7!, intake, prior, { runDir: tmp, client });
  console.log('S7 status:', record.status, '| attempts:', record.attempts.length, '| cost $' + record.cost_usd.toFixed(4));
  for (const a of record.attempts) console.log('  attempt', a.attempt, 'stop:', a.stop_reason, 'out:', a.tokens_out, 'qa:', a.qa_issues.map((i) => i.check).join(',') || 'none', 'schema-errs:', a.schema_errors.length);
  for (const flag of record.flags) console.log('  flag:', flag);
}
main().catch((e) => { console.error(e); process.exit(1); });
