// Builds the loadable/publishable extension by copying src/ and stamping the
// manifest version from package.json (single source of truth).
//
//   node scripts/build.mjs            -> dist/          (Chrome, MV3 service worker)
//   node scripts/build.mjs --firefox  -> dist-firefox/  (Firefox event page + gecko id)
//   add --zip to also produce the upload archive.
//
// One source tree, two targets: the only per-browser differences are the
// background declaration and the Firefox-required browser_specific_settings.

import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const flags = new Set(process.argv.slice(2));
const firefox = flags.has('--firefox');
const zip = flags.has('--zip');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, firefox ? 'dist-firefox' : 'dist');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// Skip macOS Finder cruft so it never lands in the package (AMO flags it).
cpSync(SRC, OUT, { recursive: true, filter: (s) => !s.endsWith('.DS_Store') });

const manifestPath = join(OUT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = pkg.version;

if (firefox) {
  // Firefox's stable MV3 background is an event page (scripts), not a service
  // worker; and a gecko id is required for storage.sync + AMO signing.
  manifest.background = { scripts: ['background.js'], type: 'module' };
  manifest.browser_specific_settings = {
    gecko: {
      id: 'beeline@sapn95.github.io',
      // data_collection_permissions is required by AMO and needs Firefox 140+
      // (Android 142+). Beeline transmits nothing off-device → "no data".
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: '142.0' },
  };
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (!existsSync(join(OUT, 'icons', 'icon-128.png'))) {
  throw new Error('icons missing — run `npm run icons` first');
}

console.log(
  `built ${firefox ? 'dist-firefox' : 'dist'}/ for v${pkg.version} (${firefox ? 'firefox' : 'chrome'})`,
);

if (zip) {
  const zipName = firefox
    ? `myapps-launcher-firefox-v${pkg.version}.zip`
    : `myapps-launcher-v${pkg.version}.zip`;
  rmSync(join(ROOT, zipName), { force: true });
  // Zip the *contents* of the out dir so manifest.json sits at the archive root.
  execFileSync('zip', ['-r', '-X', join(ROOT, zipName), '.', '-x', '*.DS_Store'], {
    cwd: OUT,
    stdio: 'inherit',
  });
  console.log(`packaged ${zipName}`);
}
