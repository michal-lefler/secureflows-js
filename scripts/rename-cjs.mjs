import fs from "node:fs";
import path from "node:path";

const tmpDir = path.join(process.cwd(), "dist", "cjs-tmp");
const outDir = path.join(process.cwd(), "dist", "cjs");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (!entry.name.endsWith(".js") && !entry.name.endsWith(".map")) continue;

  const from = path.join(tmpDir, entry.name);
  const to = path.join(
    outDir,
    entry.name.endsWith(".js") ? entry.name.replace(/\.js$/, ".cjs") : entry.name,
  );
  fs.copyFileSync(from, to);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

