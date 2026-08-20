/**
 * Copies canonical repo docs into this package root for npm pack/publish.
 * Sources (single source of truth):
 *   - ../../safeHook/web/llms.txt
 *   - ../../.cursor/skills/secureflows-integration/SKILL.md
 *
 * This repo is a public mirror of the private secureFlows monorepo, which is where SKILL.md and
 * llms.txt actually get edited. There is no repoRoot here — SKILL.md and llms.txt are committed
 * directly at the package root instead, kept current by the monorepo's sync script. If those
 * committed copies are present, skip re-copying rather than failing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(packageRoot, '..');

const pairs = [
  [path.join(repoRoot, 'safeHook', 'web', 'llms.txt'), path.join(packageRoot, 'llms.txt')],
  [
    path.join(repoRoot, '.cursor', 'skills', 'secureflows-integration', 'SKILL.md'),
    path.join(packageRoot, 'SKILL.md'),
  ],
];

for (const [src, dest] of pairs) {
  if (!fs.existsSync(src)) {
    if (fs.existsSync(dest)) {
      console.log(
        `sync-pack-assets: no monorepo checkout at ${path.relative(repoRoot, src)}, keeping committed ${path.relative(packageRoot, dest)}`,
      );
      continue;
    }
    console.error(`sync-pack-assets: missing source file: ${path.relative(repoRoot, src)}`);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  console.log(
    `sync-pack-assets: ${path.relative(repoRoot, src)} -> ${path.relative(repoRoot, dest)}`,
  );
}
