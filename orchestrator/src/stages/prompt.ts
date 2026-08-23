import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from '../paths.js';

export interface PromptHeader {
  version: string;
  stage: string;
  model: string;
  date: string;
}

export interface LoadedPrompt {
  header: PromptHeader;
  body: string;
  sha256: string;
  file: string;
}

/** Parse a prompt source with either Unix (LF) or Windows (CRLF) line endings. */
export function parsePromptSource(raw: string, fileName: string): LoadedPrompt {
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
  if (!m) throw new Error(`${fileName}: missing prompt header block (--- version|stage|model|date ---)`);

  const header: Partial<PromptHeader> = {};
  for (const line of (m[1] as string).split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) (header as Record<string, string>)[kv[1] as string] = (kv[2] as string).trim();
  }
  for (const key of ['version', 'stage', 'model', 'date'] as const) {
    if (!header[key]) throw new Error(`${fileName}: prompt header missing "${key}"`);
  }

  return {
    header: header as PromptHeader,
    body: raw.slice(m[0].length).trim(),
    sha256,
    file: fileName,
  };
}

/**
 * Prompts live in /prompts/*.md with a frontmatter header block
 * (version|stage|model|date). The run manifest pins version + file hash so a
 * run is always reproducible against the exact prompt that produced it.
 */
export function loadPrompt(fileName: string): LoadedPrompt {
  const file = path.join(PROMPTS_DIR, fileName);
  const raw = fs.readFileSync(file, 'utf8');
  return parsePromptSource(raw, fileName);
}
