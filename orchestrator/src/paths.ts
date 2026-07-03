import path from 'node:path';
import { fileURLToPath } from 'node:url';

// orchestrator/src → repo root is two levels up. Everything path-related goes
// through here so the CLI works regardless of cwd (npm workspace scripts run
// with cwd = orchestrator/).
const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '..', '..');
export const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');
export const RUNS_DIR = path.join(REPO_ROOT, 'runs');
