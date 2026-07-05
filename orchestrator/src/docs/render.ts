/**
 * Render a completed run's stage outputs to branded documents (LS-15).
 * HTML always; PDF via the pre-installed headless Chromium (D-017 — no
 * external doc service, no network). Rendering is re-runnable and separate
 * from the pipeline: fix a template, re-render, nothing re-generates.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Intake, RunManifest } from '../types.js';
import { renderIndex, renderStageDoc, type DocMeta } from './templates.js';

const CHROMIUM_CANDIDATES = [
  process.env.RELAUNCH72_CHROMIUM ?? '',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
].filter(Boolean);

function findChromium(): string | null {
  for (const p of CHROMIUM_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export interface RenderResult {
  docsDir: string;
  html: string[];
  pdf: string[];
}

export async function renderRun(runDir: string, opts: { pdf: boolean }): Promise<RenderResult> {
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`No manifest.json in ${runDir} — is this a run directory?`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RunManifest;
  const intake = JSON.parse(fs.readFileSync(path.join(runDir, 'intake.json'), 'utf8')) as Intake;

  const passed = manifest.stages.filter((s) => s.status === 'passed' && s.output_file);
  if (passed.length === 0) throw new Error(`Run ${manifest.run_id} has no passed stages to render`);

  const meta: DocMeta = {
    business: typeof intake.A1 === 'string' ? intake.A1 : String(intake.A1 ?? ''),
    runId: manifest.run_id,
    generatedAt: new Date().toISOString(),
    mock: manifest.mode === 'mock',
  };

  const docsDir = path.join(runDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });

  const htmlFiles: string[] = [];
  const stageIds: string[] = [];
  for (const stage of passed) {
    const output = JSON.parse(fs.readFileSync(path.join(runDir, stage.output_file as string), 'utf8')) as unknown;
    const html = renderStageDoc(stage.stage, output, meta);
    const file = `${stage.stage.toLowerCase()}.html`;
    fs.writeFileSync(path.join(docsDir, file), html, 'utf8');
    htmlFiles.push(file);
    stageIds.push(stage.stage);
  }
  fs.writeFileSync(path.join(docsDir, 'index.html'), renderIndex(meta, intake, stageIds), 'utf8');
  htmlFiles.unshift('index.html');

  const pdfFiles: string[] = [];
  if (opts.pdf) {
    const executablePath = findChromium();
    if (!executablePath) {
      throw new Error(
        'PDF requested but no Chromium found — set RELAUNCH72_CHROMIUM to a Chrome/Chromium binary path',
      );
    }
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath });
    try {
      const page = await browser.newPage();
      for (const file of htmlFiles) {
        await page.goto(`file://${path.join(docsDir, file)}`, { waitUntil: 'load' });
        const pdfFile = file.replace(/\.html$/, '.pdf');
        await page.pdf({
          path: path.join(docsDir, pdfFile),
          format: 'A4',
          printBackground: true,
          margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' },
        });
        pdfFiles.push(pdfFile);
      }
    } finally {
      await browser.close();
    }
  }

  return { docsDir, html: htmlFiles, pdf: pdfFiles };
}
