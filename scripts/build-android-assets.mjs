import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'android/app/src/main/assets/public');
await mkdir(path.join(output, 'vendor'), { recursive: true });
await build({ entryPoints: [path.join(root, 'prototype/app.mjs')], outfile: path.join(output, 'app.js'), bundle: true, format: 'iife', target: 'chrome100', charset: 'utf8' });
for (const file of ['style.css', 'icon.svg']) await copyFile(path.join(root, 'prototype', file), path.join(output, file));
await copyFile(path.join(root, 'node_modules/jszip/dist/jszip.min.js'), path.join(output, 'vendor/jszip.min.js'));
await copyFile(path.join(root, 'node_modules/js-sha256/build/sha256.min.js'), path.join(output, 'vendor/sha256.min.js'));
const index = (await readFile(path.join(root, 'prototype/index.html'), 'utf8'))
  .replace(/^\s*<link rel="manifest"[^>]*>\r?\n/m, '')
  .replace('<script type="module" src="/app.mjs"></script>', '<script src="/app.js"></script>');
await writeFile(path.join(output, 'index.html'), index);
console.log('安卓离线页面已打包');
