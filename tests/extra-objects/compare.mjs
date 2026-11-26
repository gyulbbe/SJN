// Backlog item 8: the trial trimCarried (refine.ts --tuning '{"carried":…}' --suffix <s>) against today's
// app result of the same saved answer, byte for byte, with the pieces it took off each cut-out (from the
// refine summaries copied to test-results/extra-objects-20261126/<s>-<tree>.json).
//   node tests/extra-objects/compare.mjs k1
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';
import { OUT, SETS } from './sheets.mjs';

const suffix = process.argv[2] ?? 'k1';
const trees = [...SETS, ['extra-objects-20261126/local/app', 'refined', 'local']];
const rows = [];
let same = 0;
for (const [tree, base] of trees) {
  const root = join(ROOT, 'test-results', ...tree.split('/'));
  const parts = tree.split('/');
  const rev = parts.pop();
  const summaryFile = join(OUT, `${suffix}-${parts.join('-')}-${rev}.json`);
  const summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : {};
  const dir = join(root, `refined-${suffix}`);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
    const [a, b] = await Promise.all(
      [join(root, base, file), join(dir, file)].map((p) => sharp(p).ensureAlpha().raw().toBuffer()),
    );
    let n = 0;
    for (let i = 0; i < a.length; i += 4)
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
    const id = file.slice(0, -4);
    const trims = (summary[`${rev}/${id}`]?.trimmed ?? []).filter((t) => t.why);
    if (!n && !trims.length) {
      same++;
      continue;
    }
    rows.push({ tree, id, changed: n, trims });
    console.log(
      `${tree}/${id}`.padEnd(56),
      `${n} px`.padEnd(10),
      trims.map((t) => `${t.why} f${t.fixture} ${t.pixels}px ${t.width}×${t.height}`).join('; '),
    );
  }
}
console.log({ same, changed: rows.filter((r) => r.changed).length });
