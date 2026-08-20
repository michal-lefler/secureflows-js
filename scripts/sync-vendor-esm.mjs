import fs from "node:fs";
import path from "node:path";

// Generic: copy selected ESM build files from `dist/esm/` into an arbitrary vendor dir.
//
// Usage:
//   node scripts/sync-vendor-esm.mjs --dest ../usecases/hello-world-single-html/vendor/secureflows-js
//   node scripts/sync-vendor-esm.mjs --dest <dir> --files index.js secureFlows.js

const here = process.cwd(); // secureflows-js/
const esmDir = path.join(here, "dist", "esm");

const args = parseArgs(process.argv.slice(2));
const dest = args.dest ? path.resolve(here, args.dest) : null;
const files = args.files?.length ? args.files : ["index.js", "secureFlows.js"];

if (!dest) {
  throw new Error("Missing --dest <dir>");
}

ensureExists(esmDir, "secureflows-js must be built first (dist/esm missing).");

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

for (const f of files) {
  const src = path.join(esmDir, f);
  ensureExists(src, `Missing build output file: ${f}`);
  fs.copyFileSync(src, path.join(dest, f));
}

console.log(`Synced secureflows-js ESM -> ${dest}`);

function ensureExists(p, hint) {
  if (!fs.existsSync(p)) throw new Error(`${hint}\nMissing: ${p}`);
}

function parseArgs(argv) {
  const out = { dest: null, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dest") {
      out.dest = argv[++i] ?? null;
      continue;
    }
    if (a === "--files") {
      // Consume remaining args as files until next flag or end.
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        out.files.push(argv[++i]);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

