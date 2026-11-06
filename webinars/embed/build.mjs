// Builds the embed into ../public/v1 (served by Workers static assets):
//   embed.js       tiny classic loader for <script src=… data-key=… defer>
//   embed-app.js   the Lit components (ES module, loaded by the loader)
//   chunks/*       lazily loaded code (hls.js only loads when a browser needs it)
import { build } from 'esbuild';
import { rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../public/v1/', import.meta.url));
rmSync(out + 'chunks', { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const common = { bundle: true, minify: true, sourcemap: false, target: ['es2020', 'safari14'], legalComments: 'none', logLevel: 'info' };

await build({ ...common, entryPoints: [fileURLToPath(new URL('./src/loader.ts', import.meta.url))], outfile: out + 'embed.js', format: 'iife' });
await build({
  ...common,
  entryPoints: { 'embed-app': fileURLToPath(new URL('./src/app.ts', import.meta.url)) },
  outdir: out,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
});
