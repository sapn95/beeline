// Builds the loadable/publishable extension into dist/ by copying src/ and
// stamping the manifest version from package.json (single source of truth).
// Pass --zip to also produce the upload archive for the Chrome Web Store.

import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(SRC, DIST, { recursive: true });

const manifestPath = join(DIST, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = pkg.version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (!existsSync(join(DIST, 'icons', 'icon-128.png'))) {
  throw new Error('icons missing — run `npm run icons` first');
}

console.log(`built dist/ for v${pkg.version}`);

if (process.argv.includes('--zip')) {
  const zipName = `myapps-launcher-v${pkg.version}.zip`;
  rmSync(join(ROOT, zipName), { force: true });
  // Zip the *contents* of dist/ so manifest.json sits at the archive root,
  // which is what the Chrome Web Store expects.
  execFileSync('zip', ['-r', '-X', join(ROOT, zipName), '.'], { cwd: DIST, stdio: 'inherit' });
  console.log(`packaged ${zipName}`);
}
