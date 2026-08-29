import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCycloneDxSbom,
  canonicalJson,
  renderCycloneDxSbom,
  verifyPackageLock,
  verifyPackageManifest,
} from '../../scripts/supply-chain.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GATE_COMMAND = 'node scripts/supply-chain.mjs --check';
const BUILD_COMMAND = `npm ci --ignore-scripts --include=dev && ${GATE_COMMAND} && npm run typecheck && npm test`;

async function repositoryLock() {
  return JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
}

test('root package lock is registry-only, integrity-pinned and lifecycle-script bounded', async () => {
  const result = verifyPackageLock(await repositoryLock());
  assert.equal(result.packageCount, 70);
  assert.equal(result.externalPackageCount, 67);
  assert.deepEqual(result.declaredInstallScripts, [
    'node_modules/esbuild@0.28.1',
    'node_modules/fsevents@2.3.3',
  ]);
  assert.match(result.canonicalLockSha256, /^[a-f0-9]{64}$/);
});

test('gate rejects untrusted archives, missing integrity and new install scripts', async () => {
  const lock = await repositoryLock();
  for (const mutation of [
    { resolved: 'git+https://example.test/pwn.git' },
    { integrity: undefined },
    { hasInstallScript: true },
  ]) {
    const candidate = structuredClone(lock);
    candidate.packages['node_modules/ajv'] = { ...candidate.packages['node_modules/ajv'], ...mutation };
    assert.throws(() => verifyPackageLock(candidate), /trusted npm registry|SHA-512|lifecycle script/);
  }
});

test('gate rejects short digests, tarball substitution and package-name spoofing', async () => {
  const lock = await repositoryLock();
  const shortDigest = structuredClone(lock);
  shortDigest.packages['node_modules/ajv'].integrity = 'sha512-YQ==';
  assert.throws(() => verifyPackageLock(shortDigest), /exactly 64 bytes/);

  for (const [packagePath, resolved] of [
    ['node_modules/ajv', 'https://registry.npmjs.org/pg/-/pg-8.23.0.tgz'],
    ['node_modules/@types/pg', 'https://registry.npmjs.org/@types/node/-/node-22.15.3.tgz'],
  ]) {
    const substituted = structuredClone(lock);
    substituted.packages[packagePath].resolved = resolved;
    assert.throws(() => verifyPackageLock(substituted), /archive does not match/);
  }
  const spoofedName = structuredClone(lock);
  spoofedName.packages['node_modules/ajv'].name = 'pg';
  assert.throws(() => verifyPackageLock(spoofedName), /name does not match its install path/);
});

test('gate rejects lifecycle hooks and escaping workspace links', async () => {
  const lock = await repositoryLock();
  const lifecycle = structuredClone(lock);
  lifecycle.packages.orchestrator.scripts = { postinstall: 'node surprise.js' };
  assert.throws(() => verifyPackageLock(lifecycle), /Lifecycle script postinstall is forbidden/);
  const workspace = structuredClone(lock);
  workspace.packages['node_modules/@relaunch72/orchestrator'].resolved = '../outside';
  assert.throws(() => verifyPackageLock(workspace), /must stay inside the repository/);
});

test('checked-in manifests contain no install lifecycle hook', async () => {
  for (const relativePath of ['package.json', 'orchestrator/package.json']) {
    const manifest = JSON.parse(await readFile(path.join(ROOT, relativePath), 'utf8'));
    assert.doesNotThrow(() => verifyPackageManifest(manifest, relativePath));
  }
  assert.throws(
    () => verifyPackageManifest({ scripts: { prepare: 'node unreviewed.js' } }, 'fixture/package.json'),
    /Lifecycle script prepare is forbidden/,
  );
});

test('Render invokes a repository-owned built-in-only Node gate before application tooling', async () => {
  for (const [manifestName, expectedServiceCount] of [
    ['render.yaml', 1],
    ['render.property-predator.production.yaml', 8],
  ]) {
    const manifest = await readFile(path.join(ROOT, manifestName), 'utf8');
    const commands = [...manifest.matchAll(/^\s*buildCommand:\s*(.+)$/gm)].map((match) => match[1].trim());
    assert.equal(commands.length, expectedServiceCount);
    assert.deepEqual(commands, Array.from({ length: expectedServiceCount }, () => BUILD_COMMAND));
    assert.doesNotMatch(commands.join('\n'), /--import|tsx|esbuild|node_modules/);
  }
  const rootManifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(rootManifest.scripts['supply-chain:check'], GATE_COMMAND);
  assert.equal(rootManifest.scripts['sbom:write'], 'node scripts/supply-chain.mjs --write');

  const source = await readFile(path.join(ROOT, 'scripts', 'supply-chain.mjs'), 'utf8');
  const importSpecifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(importSpecifiers, ['node:crypto', 'node:fs/promises', 'node:path', 'node:url']);
  assert.doesNotMatch(source, /(?:^|\s)(?:require|import)\s*\(\s*['"](?!node:)/m);

  const execution = spawnSync(process.execPath, ['scripts/supply-chain.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /Supply-chain gate passed for 67 external packages; SBOM is current\./);
});

test('CycloneDX output is canonical, complete and exactly reproducible', async () => {
  const lock = await repositoryLock();
  const first = renderCycloneDxSbom(lock);
  assert.equal(first, renderCycloneDxSbom(structuredClone(lock)));
  const sbom = buildCycloneDxSbom(lock);
  assert.equal(sbom.serialNumber, undefined);
  assert.equal(sbom.metadata.timestamp, undefined);
  assert.equal(sbom.components.length, 68);
  assert.equal(first, canonicalJson(JSON.parse(first)));
  const componentRefs = new Set(sbom.components.map((component) => component['bom-ref']));
  assert.equal(componentRefs.size, sbom.components.length);
  const knownRefs = new Set([...componentRefs, 'npm:relaunch72@0.1.0#.']);
  for (const dependency of sbom.dependencies) {
    assert.equal(knownRefs.has(dependency.ref), true);
    assert.equal(dependency.dependsOn.every((ref) => knownRefs.has(ref)), true);
  }
  const workspace = sbom.dependencies.find((dependency) => dependency.ref.includes('@relaunch72/orchestrator'));
  assert.ok(workspace);
  assert.equal(workspace.dependsOn.some((ref) => ref.includes('@types/node')), true);
  assert.equal(workspace.dependsOn.some((ref) => ref.includes('typescript@')), true);
});

test('tracked CycloneDX file exactly matches the current root lockfile', async () => {
  const expected = renderCycloneDxSbom(await repositoryLock());
  const actual = (await readFile(path.join(ROOT, 'security', 'sbom.cdx.json'), 'utf8')).replace(/\r\n?/g, '\n');
  assert.equal(actual, expected);
});
