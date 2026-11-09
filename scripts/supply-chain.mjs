import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPPLY_CHAIN_POLICY_VERSION = 1;
export const TRUSTED_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
export const DECLARED_INSTALL_SCRIPT_ALLOWLIST = Object.freeze(new Set([
  'node_modules/esbuild@0.28.1',
  'node_modules/fsevents@2.3.3',
]));

const LIFECYCLE_SCRIPT_NAMES = Object.freeze(new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'dependencies',
]));
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const LOCKFILE_PATH = path.join(REPOSITORY_ROOT, 'package-lock.json');
const SBOM_PATH = path.join(REPOSITORY_ROOT, 'security', 'sbom.cdx.json');

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function packageNameFromPath(packagePath, entry) {
  const marker = 'node_modules/';
  const index = packagePath.lastIndexOf(marker);
  if (index >= 0) {
    const pathName = packagePath.slice(index + marker.length);
    if (entry.name?.trim() && entry.name.trim() !== pathName) {
      throw new Error(`Lockfile package ${packagePath} name does not match its install path`);
    }
    return pathName;
  }
  if (entry.name?.trim()) return entry.name.trim();
  throw new Error(`Lockfile package ${packagePath} has no name`);
}

function componentRef(packagePath, entry) {
  const name = packageNameFromPath(packagePath, entry);
  return `npm:${name}@${entry.version ?? 'workspace'}#${packagePath || '.'}`;
}

function assertLifecycleScriptsAbsent(packagePath, entry) {
  for (const scriptName of Object.keys(entry.scripts ?? {})) {
    if (LIFECYCLE_SCRIPT_NAMES.has(scriptName)) {
      throw new Error(`Lifecycle script ${scriptName} is forbidden in ${packagePath || 'root package'}`);
    }
  }
}

export function verifyPackageManifest(value, label) {
  assertObject(value, label);
  if (value.scripts === undefined) return;
  assertObject(value.scripts, `${label} scripts`);
  assertLifecycleScriptsAbsent(label, { scripts: value.scripts });
}

function assertExternalPackage(packagePath, entry) {
  if (!entry.version?.trim()
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.version)) {
    throw new Error(`External package ${packagePath} has no exact canonical version`);
  }
  if (!entry.resolved?.trim()) throw new Error(`External package ${packagePath} has no resolved archive`);
  let resolved;
  try {
    resolved = new URL(entry.resolved);
  } catch {
    throw new Error(`External package ${packagePath} has an invalid resolved archive`);
  }
  if (resolved.origin !== TRUSTED_REGISTRY_ORIGIN || resolved.username || resolved.password) {
    throw new Error(`External package ${packagePath} is not pinned to the trusted npm registry`);
  }
  const packageName = packageNameFromPath(packagePath, entry);
  const packageNameMatch = /^(?:@[a-z0-9][a-z0-9._-]*\/)?([a-z0-9][a-z0-9._-]*)$/.exec(packageName);
  if (!packageNameMatch) {
    throw new Error(`External package ${packagePath} has a non-canonical npm package name`);
  }
  const expectedPathname = `/${packageName}/-/${packageNameMatch[1]}-${entry.version}.tgz`;
  if (resolved.pathname !== expectedPathname || resolved.search || resolved.hash) {
    throw new Error(`External package ${packagePath} archive does not match its package name and version`);
  }
  const integrity = entry.integrity ?? '';
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error(`External package ${packagePath} has no single SHA-512 integrity digest`);
  }
  const encodedDigest = integrity.slice('sha512-'.length);
  const digest = Buffer.from(encodedDigest, 'base64');
  if (digest.length !== 64 || digest.toString('base64') !== encodedDigest) {
    throw new Error(`External package ${packagePath} SHA-512 integrity digest must be exactly 64 bytes`);
  }
  if (entry.hasInstallScript) {
    const declaration = `${packagePath}@${entry.version}`;
    if (!DECLARED_INSTALL_SCRIPT_ALLOWLIST.has(declaration)) {
      throw new Error(`Unreviewed dependency lifecycle script declared by ${declaration}`);
    }
  }
}

export function verifyPackageLock(value) {
  assertObject(value, 'package-lock.json');
  if (value.lockfileVersion !== 3) throw new Error('package-lock.json must use lockfileVersion 3');
  assertObject(value.packages, 'package-lock.json packages');
  const entries = Object.entries(value.packages);
  const root = value.packages[''];
  if (!root) throw new Error('package-lock.json is missing its root package');
  assertLifecycleScriptsAbsent('', root);

  const declaredInstallScripts = [];
  let externalPackageCount = 0;
  for (const [packagePath, entry] of entries) {
    if (!packagePath) continue;
    assertLifecycleScriptsAbsent(packagePath, entry);
    if (entry.link) {
      if (!entry.resolved || entry.resolved.includes('..') || entry.resolved.startsWith('/') || /^[A-Za-z]:/.test(entry.resolved)) {
        throw new Error(`Workspace link ${packagePath} must stay inside the repository`);
      }
      if (!value.packages[entry.resolved]) {
        throw new Error(`Workspace link ${packagePath} points to a missing package`);
      }
      continue;
    }
    if (!packagePath.includes('node_modules/')) continue;
    assertExternalPackage(packagePath, entry);
    externalPackageCount += 1;
    if (entry.hasInstallScript) declaredInstallScripts.push(`${packagePath}@${entry.version}`);
  }

  declaredInstallScripts.sort(compareText);
  const expectedDeclarations = [...DECLARED_INSTALL_SCRIPT_ALLOWLIST].sort(compareText);
  if (declaredInstallScripts.join('\n') !== expectedDeclarations.join('\n')) {
    throw new Error('Declared dependency lifecycle-script allowlist is stale');
  }
  return {
    packageCount: entries.length,
    externalPackageCount,
    declaredInstallScripts,
    canonicalLockSha256: sha256(canonicalJson(value)),
  };
}

function dependencyTargetPath(packages, packagePath, dependencyName) {
  let base = packagePath;
  while (true) {
    const marker = base.lastIndexOf('node_modules/');
    const parent = marker >= 0 ? base.slice(0, marker) : '';
    const candidate = `${parent}node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    if (marker < 0) return undefined;
    base = parent.replace(/\/$/, '');
  }
}

function dependencyRefs(packages, packagePath, entry) {
  const names = new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.devDependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
  ]);
  return [...names].sort(compareText).map((name) => {
    const target = dependencyTargetPath(packages, packagePath, name);
    if (!target || !packages[target]) {
      throw new Error(`Lockfile cannot resolve ${name} from ${packagePath || 'root package'}`);
    }
    return componentRef(target, packages[target]);
  }).sort(compareText);
}

export function buildCycloneDxSbom(value) {
  const verification = verifyPackageLock(value);
  const packages = value.packages;
  const root = packages[''];
  const rootName = value.name ?? root.name ?? 'relaunch72';
  const rootVersion = value.version ?? root.version ?? '0.0.0';
  const rootRef = `npm:${rootName}@${rootVersion}#.`;
  const components = [];
  const dependencies = [];

  for (const [packagePath, entry] of Object.entries(packages).sort(([left], [right]) => compareText(left, right))) {
    if (!packagePath || (!packagePath.includes('node_modules/') && !entry.link)) continue;
    const isWorkspace = !packagePath.includes('node_modules/') || entry.link === true;
    const resolvedPath = entry.link ? entry.resolved : packagePath;
    const resolvedEntry = entry.link ? packages[resolvedPath] : entry;
    const ref = componentRef(packagePath, resolvedEntry);
    const properties = [{ name: 'relaunch72:package-lock-path', value: packagePath }];
    if (entry.link) properties.push({ name: 'relaunch72:workspace-path', value: resolvedPath });
    if (resolvedEntry.resolved) properties.push({ name: 'relaunch72:resolved', value: resolvedEntry.resolved });
    const component = {
      type: isWorkspace ? 'application' : 'library',
      'bom-ref': ref,
      name: packageNameFromPath(packagePath, resolvedEntry),
      version: resolvedEntry.version ?? 'workspace',
      scope: resolvedEntry.dev || resolvedEntry.optional ? 'optional' : 'required',
      properties,
    };
    if (resolvedEntry.integrity) {
      component.hashes = [{ alg: 'SHA-512', content: resolvedEntry.integrity.slice('sha512-'.length) }];
    }
    if (resolvedEntry.license) component.licenses = [{ license: { name: resolvedEntry.license } }];
    components.push(component);
    dependencies.push({
      ref,
      dependsOn: dependencyRefs(packages, entry.link ? resolvedPath : packagePath, resolvedEntry),
    });
  }

  components.sort((left, right) => compareText(left['bom-ref'], right['bom-ref']));
  dependencies.sort((left, right) => compareText(left.ref, right.ref));
  dependencies.unshift({
    ref: rootRef,
    dependsOn: Object.entries(packages)
      .filter(([, entry]) => entry.link === true)
      .map(([packagePath, entry]) => componentRef(packagePath, packages[entry.resolved]))
      .sort(compareText),
  });
  return {
    $schema: 'https://cyclonedx.org/schema/bom-1.5.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: rootName,
        version: rootVersion,
        properties: [
          { name: 'relaunch72:canonical-package-lock-sha256', value: verification.canonicalLockSha256 },
          { name: 'relaunch72:supply-chain-policy-version', value: String(SUPPLY_CHAIN_POLICY_VERSION) },
        ],
      },
      tools: {
        components: [{
          type: 'application',
          name: 'relaunch72-package-lock-sbom',
          version: String(SUPPLY_CHAIN_POLICY_VERSION),
        }],
      },
    },
    components,
    dependencies,
  };
}

export function renderCycloneDxSbom(value) {
  return canonicalJson(buildCycloneDxSbom(value));
}

export async function runSupplyChainCommand(mode) {
  if (mode !== '--check' && mode !== '--write') throw new Error('Use --check or --write');
  const lock = JSON.parse(await readFile(LOCKFILE_PATH, 'utf8'));
  const rootManifest = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  verifyPackageManifest(rootManifest, 'root package.json');
  if (!Array.isArray(rootManifest.workspaces)
      || rootManifest.workspaces.some((workspace) => typeof workspace !== 'string' || /[*?{}]/.test(workspace))) {
    throw new Error('Root package workspaces must be an explicit list of repository paths');
  }
  for (const workspace of rootManifest.workspaces) {
    const workspacePath = path.resolve(REPOSITORY_ROOT, workspace);
    const relativeWorkspace = path.relative(REPOSITORY_ROOT, workspacePath);
    if (!relativeWorkspace || relativeWorkspace.startsWith('..') || path.isAbsolute(relativeWorkspace)) {
      throw new Error('Workspace package path escapes the repository');
    }
    const manifest = JSON.parse(await readFile(path.join(workspacePath, 'package.json'), 'utf8'));
    verifyPackageManifest(manifest, `${workspace}/package.json`);
  }
  const verification = verifyPackageLock(lock);
  const expected = renderCycloneDxSbom(lock);
  if (mode === '--write') {
    await mkdir(path.dirname(SBOM_PATH), { recursive: true });
    await writeFile(SBOM_PATH, expected, { encoding: 'utf8', flag: 'w' });
    console.log(`CycloneDX SBOM written for ${verification.externalPackageCount} external packages.`);
    return;
  }
  let actual;
  try {
    actual = await readFile(SBOM_PATH, 'utf8');
  } catch {
    throw new Error('Tracked CycloneDX SBOM is missing; run npm run sbom:write and review it');
  }
  if (actual.replace(/\r\n?/g, '\n') !== expected) {
    throw new Error('Tracked CycloneDX SBOM is stale; run npm run sbom:write and review the lockfile diff');
  }
  console.log(`Supply-chain gate passed for ${verification.externalPackageCount} external packages; SBOM is current.`);
}

const [invokedPath, modulePath] = await Promise.all([
  process.argv[1] ? realpath(path.resolve(process.argv[1])).catch(() => '') : '',
  realpath(fileURLToPath(import.meta.url)),
]);
if (invokedPath.toLowerCase() === modulePath.toLowerCase()) {
  if (process.argv.length !== 3) {
    console.error('Use --check or --write');
    process.exitCode = 1;
  } else {
    runSupplyChainCommand(process.argv[2]).catch((error) => {
      console.error(error instanceof Error ? error.message : 'Supply-chain verification failed');
      process.exitCode = 1;
    });
  }
}
