import '../config.js';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createImportCommandDatabasePool } from '../db/pool.js';
import { createPgLegacyImportTransactionRunner } from './repository.js';
import {
  type PropertyPredatorAccountSnapshotExportV2,
  verifyPropertyPredatorAccountSnapshotV2,
} from './property-predator-snapshot-v2.js';
import { PropertyPredatorSnapshotService } from './property-predator-snapshot-service.js';

interface CliArguments {
  fixture: string;
  workspaceId: string;
  userId: string;
  requestId: string;
}

const MAX_FIXTURE_BYTES = 50 * 1024 * 1024;

function usage(): never {
  throw new Error(
    'Usage: snapshot:preview --fixture <json> --workspace <uuid> --user <uuid> --confirm zero-write-preview',
  );
}

function argumentsFrom(argv: readonly string[]): CliArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) usage();
    values.set(key.slice(2), value);
  }
  if (values.get('confirm') !== 'zero-write-preview') usage();
  const fixture = values.get('fixture');
  const workspaceId = values.get('workspace');
  const userId = values.get('user');
  if (!fixture || !workspaceId || !userId) usage();
  return {
    fixture: path.resolve(fixture),
    workspaceId,
    userId,
    requestId: values.get('request') ?? `property-predator-snapshot-preview-${Date.now()}`,
  };
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2));
  const fixtureStat = await stat(args.fixture);
  if (!fixtureStat.isFile() || fixtureStat.size > MAX_FIXTURE_BYTES) {
    throw new Error('Snapshot preview fixture must be a file no larger than 50 MiB');
  }
  const fixtureBytes = await readFile(args.fixture);
  if (fixtureBytes.byteLength > MAX_FIXTURE_BYTES) {
    throw new Error('Snapshot preview fixture grew beyond the 50 MiB limit');
  }
  const parsed = JSON.parse(fixtureBytes.toString('utf8')) as PropertyPredatorAccountSnapshotExportV2;
  // Fail the entire collected snapshot before opening a database connection.
  verifyPropertyPredatorAccountSnapshotV2(parsed);

  const pool = createImportCommandDatabasePool(process.env);
  try {
    const runner = createPgLegacyImportTransactionRunner(pool);
    const service = new PropertyPredatorSnapshotService({ transactionRunner: runner });
    const report = await service.preview({
      actorKind: 'user',
      workspaceId: args.workspaceId,
      userId: args.userId,
      requestId: args.requestId,
    }, parsed);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Snapshot preview failed closed');
  process.exitCode = 1;
});
