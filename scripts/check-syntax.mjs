// Syntax-checks every JavaScript file in the project with `node --check`.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const SKIP = new Set(['.git', 'node_modules']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(m?js)$/.test(name)) yield path;
  }
}

let failed = 0;
let count = 0;
for (const file of walk(root)) {
  count++;
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    console.error(`✖ ${file}\n${result.stderr}`);
  }
}
console.log(failed ? `${failed} of ${count} files failed` : `✔ ${count} JavaScript files parse cleanly`);
process.exit(failed ? 1 : 0);
