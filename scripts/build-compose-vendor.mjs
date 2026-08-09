#!/usr/bin/env node
/**
 * Thin bundler only — no compose CSS/HTML/app logic lives here.
 *
 *   npm run build:vendor
 *
 * Source of truth (edit these):
 *   src/static/compose-ui.js                         fonts + blocks + colors
 *   src/component/dashboard/lib/compose-src/*.{mjs,css}
 *
 * Generated (do not hand-edit):
 *   src/component/dashboard/lib/compose-libs.js
 */
import * as esbuild from 'esbuild';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src/component/dashboard/lib/compose-src/index.mjs');
const outDir = join(root, 'src/component/dashboard/lib');
const outfile = join(outDir, 'compose-libs.js');

await mkdir(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  outfile,
  platform: 'browser',
  target: ['chrome120'],
  legalComments: 'none',
  logLevel: 'info',
  // Import "./foo.css" as a JS string for injectStyleOnce (not a side-effect stylesheet).
  loader: { '.css': 'text' },
});

// Quill snow tooltip input has neither id nor name — Chrome flags it.
{
  const banner = [
    '/* eslint-disable */',
    '/**',
    ' * GENERATED FILE — do not hand-edit.',
    ' * Source of truth for compose CSS/HTML/behavior:',
    ' *   src/component/dashboard/lib/compose-src/*.{mjs,css}',
    ' *   src/static/compose-ui.js',
    ' * Rebuild: npm run build:vendor',
    ' */',
    '',
  ].join('\n');
  let js = await readFile(outfile, 'utf8');
  js = js.replaceAll(
    '<input type="text" data-formula="e=mc^2"',
    '<input type="text" name="ql-tooltip" autocomplete="off" data-formula="e=mc^2"',
  );
  if (!js.startsWith('/* eslint-disable */')) js = banner + js;
  await writeFile(outfile, js);
}

for (const p of [
  join(root, 'src/component/dashboard/vendor/_entry.mjs'),
  join(root, 'src/component/dashboard/vendor/compose-libs.js'),
  join(outDir, 'compose-libs.css'),
]) {
  try { await unlink(p); } catch { /* ok */ }
}

console.log('Bundled', entry);
console.log('Wrote  ', outfile);
