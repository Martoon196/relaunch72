import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const runnerUrl = new URL('./require-integration.ts', import.meta.url);
const helperUrl = new URL('./database-helper.ts', import.meta.url);
const packageUrl = new URL('../../package.json', import.meta.url);

async function sources(): Promise<{
  runner: string;
  helper: string;
  packageJson: { scripts?: Record<string, string> };
}> {
  const [runner, helper, rawPackage] = await Promise.all([
    readFile(runnerUrl, 'utf8'),
    readFile(helperUrl, 'utf8'),
    readFile(packageUrl, 'utf8'),
  ]);
  return {
    runner: runner.replace(/\r\n?/g, '\n'),
    helper: helper.replace(/\r\n?/g, '\n'),
    packageJson: JSON.parse(rawPackage) as { scripts?: Record<string, string> },
  };
}

test('explicit integration entrypoint preflights the disposable URL and reset acknowledgement before execution', async () => {
  const { runner, helper, packageJson } = await sources();
  const script = packageJson.scripts?.['test:db:integration'];

  assert.equal(
    script,
    'node --import ./test/windows-node24-shim.mjs --import tsx test/db/require-integration.ts',
  );
  assert.doesNotMatch(script ?? '', /--env-file/);
  assert.match(runner, /const rawUrl = process\.env\.TEST_DATABASE_URL\?\.trim\(\);/);
  assert.match(runner, /if \(!rawUrl\) \{[\s\S]*?throw new Error\(/);
  assert.match(runner, /assertDisposableTestDatabase\(rawUrl\);/);
  assert.match(
    helper,
    /export const DISPOSABLE_BRANCH_CONFIRMATION = 'reset-disposable-branch';/,
  );
  assert.match(
    helper,
    /branchConfirmation = process\.env\.TEST_DATABASE_RESET_CONFIRM\?\.trim\(\)/,
  );
  assert.match(helper, /new URL\(rawUrl\)/);
  assert.match(helper, /if \(!TEST_NAME_PATTERN\.test\(database\)/);
  assert.match(
    helper,
    /if \(branchConfirmation !== DISPOSABLE_BRANCH_CONFIRMATION\) \{[\s\S]*?throw new Error\(/,
  );

  const urlGuard = runner.indexOf('if (!rawUrl)');
  const disposableGuard = runner.indexOf('assertDisposableTestDatabase(rawUrl);');
  const enableIntegration = runner.indexOf(
    'process.env.RELAUNCH72_DATABASE_INTEGRATION = DATABASE_INTEGRATION_CONFIRMATION;',
  );
  const spawnChild = runner.indexOf('const child = spawn(');
  assert.ok(urlGuard >= 0);
  assert.ok(urlGuard < disposableGuard);
  assert.ok(disposableGuard < enableIntegration);
  assert.ok(enableIntegration < spawnChild);
  assert.doesNotMatch(runner, /process\.env\.TEST_DATABASE_RESET_CONFIRM\s*=/);
});

test('runner dynamically discovers every database integration test including public social', async () => {
  const { runner } = await sources();
  const integrationFiles = (await readdir(new URL('.', import.meta.url), {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.integration.test.ts'))
    .map((entry) => entry.name)
    .sort();

  assert.ok(integrationFiles.length >= 20);
  assert.ok(integrationFiles.includes('public-social-campaign.integration.test.ts'));
  assert.match(runner, /await readdir\(new URL\('\.', import\.meta\.url\)\)/);
  assert.match(
    runner,
    /\.filter\(\(filename\) => filename\.endsWith\('\.integration\.test\.ts'\)\)/,
  );
  assert.match(runner, /\.sort\(\)/);
  assert.match(runner, /\.map\(\(filename\) => `test\/db\/\$\{filename\}`\)/);
  assert.match(runner, /integrationFiles\.length < 20/);
  assert.match(
    runner,
    /integrationFiles\.includes\('test\/db\/public-social-campaign\.integration\.test\.ts'\)/,
  );
  assert.doesNotMatch(runner, /const integrationFiles\s*=\s*\[/);
});

test('runner launches one serial node test child with only the inherited environment', async () => {
  const { runner } = await sources();

  assert.match(runner, /spawn\(process\.execPath, \[/);
  assert.match(
    runner,
    /'--import', '\.\/test\/windows-node24-shim\.mjs',[\s\S]*?'--import', 'tsx',[\s\S]*?'--test',[\s\S]*?'--test-concurrency=1',[\s\S]*?\.\.\.integrationFiles/,
  );
  assert.match(
    runner,
    /\{\s*cwd: process\.cwd\(\),\s*env: process\.env,\s*stdio: 'inherit',\s*windowsHide: true,\s*\}/,
  );
  assert.doesNotMatch(runner, /\benv:\s*\{/);
  assert.doesNotMatch(runner, /\bshell:\s*true/);
});

test('runner never renders connection secrets and propagates every child failure as nonzero', async () => {
  const { runner, packageJson } = await sources();
  const script = packageJson.scripts?.['test:db:integration'] ?? '';

  assert.equal([...runner.matchAll(/\brawUrl\b/g)].length, 3);
  assert.doesNotMatch(runner, /console\.(?:log|info|warn|error)|process\.(?:stdout|stderr)\.write/);
  assert.doesNotMatch(runner, /JSON\.stringify\(process\.env\)|TEST_DATABASE_URL\s*[:=]\s*\$\{/);
  assert.doesNotMatch(script, /\becho\b|\bprintenv\b|\|\||;|&&/i);

  assert.match(runner, /const \[code, signal\] = await once\(child, 'exit'\)/);
  assert.match(
    runner,
    /if \(code !== 0\) \{\s*throw new Error\(`disposable integration suite failed \(\$\{signal \?\? code \?\? 'unknown'\}\)`\);\s*\}/,
  );
  assert.doesNotMatch(runner, /process\.exitCode\s*=\s*0|\.catch\(\(\) => undefined\)/);
});
