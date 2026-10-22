// Stamp index.html with content hashes of the scripts and styles it loads, so a
// browser that cached an older copy never mixes it with newer files after a
// deploy (GitHub Pages caches files for ten minutes). Module imports inside
// src/*.js stay clean: an import map in index.html redirects them to the
// versioned URLs.
//
// Usage: node scripts/stamp-assets.mjs           rewrite index.html
//        node scripts/stamp-assets.mjs --check   fail if index.html is stale
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexFile = path.join(root, 'index.html');
const check = process.argv.includes('--check');

const hashOf = (file) => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex').slice(0, 10);
const modules = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js')).sort().map((f) => `src/${f}`);
const assets = ['config.js', 'styles.css', ...modules];
const versions = Object.fromEntries(assets.map((f) => [f, hashOf(f)]));

let html = fs.readFileSync(indexFile, 'utf8');
const before = html;
const stamp = (attr, file) => {
  const re = new RegExp(`${attr}="${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\?v=[0-9a-f]+)?"`);
  if (!re.test(html)) throw new Error(`index.html does not reference ${file} with ${attr}=`);
  html = html.replace(re, `${attr}="${file}?v=${versions[file]}"`);
};
stamp('href', 'styles.css');
stamp('src', 'config.js');
stamp('src', 'src/main.js');

const map = { imports: Object.fromEntries(modules.map((f) => [`./${f}`, `./${f}?v=${versions[f]}`])) };
const mapTag = `<script type="importmap" id="asset-versions">${JSON.stringify(map)}</script>`;
if (/<script type="importmap" id="asset-versions">[\s\S]*?<\/script>/.test(html)) {
  html = html.replace(/<script type="importmap" id="asset-versions">[\s\S]*?<\/script>/, mapTag);
} else {
  // The import map must come before the first module script.
  const marker = '  <script src="config.js';
  if (!html.includes(marker)) throw new Error('cannot find where to put the import map');
  html = html.replace(marker, `  ${mapTag}\n${marker}`);
}

if (html === before) {
  console.log('index.html is up to date');
} else if (check) {
  console.error('error: index.html is out of date with the scripts and styles it loads: run npm run stamp and commit the result');
  process.exit(1);
} else {
  fs.writeFileSync(indexFile, html);
  console.log(`Stamped index.html: ${assets.map((f) => `${f}@${versions[f]}`).join(', ')}`);
}
