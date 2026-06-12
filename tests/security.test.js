import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(SRC)
  .filter((f) => /\.(js|json|html|css)$/.test(f))
  .map((f) => ({ name: f, content: readFileSync(f, 'utf8') }));

describe('source security', () => {
  it('scans at least the expected number of files', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('contains no hardcoded AWS access keys', () => {
    for (const { name, content } of files) {
      expect(content, name).not.toMatch(/AKIA[0-9A-Z]{16}/);
    }
  });

  it('uses no plain-http URLs', () => {
    for (const { name, content } of files) {
      const hits = content.match(/['"]http:\/\/[^'"]+['"]/g) || [];
      expect(hits, name).toEqual([]);
    }
  });

  it('never disables TLS verification', () => {
    for (const { name, content } of files) {
      expect(content, name).not.toMatch(/rejectUnauthorized\s*:\s*false/);
      expect(content, name).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    }
  });
});
