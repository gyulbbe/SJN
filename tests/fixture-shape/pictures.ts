/**
 * The fixture-shape trial's pictures (no AI call, docs/fixture-shape-20261120.md): for every registered
 * scene's result of today's app prompt (fixture-glare `final`, else `diffsemi`: the same prompt), today's
 * app picture (`now`) and P1 (`p1`: a ceramic that looks metal, material-method.ts metalScores bands ≥ 6.5
 * and ≥ 3 × the render's, goes back as the render's fixture, pasteRender), T1 (`t1`: a thin piece the
 * model drew sticking up out of a fixture, such as a tap over a basin, is wall: protrusion.ts) and both
 * (`p1t1`).
 *
 * With --sets reg,new: those sets' results too (an earlier prompt; the finishing steps take any result).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-shape/pictures.ts [--only g-black] [--sets reg,new]
 * Output: test-results/fixture-shape-20261120/pictures/<id>.{now,p1,t1,p1t1,ref}.png, p1.json
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { png } from '../extra-ai/app-view';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { metalScores, pasteRender } from '../fixture-material/material-method';
import { loadInput } from '../fixture-shadows/load';
import { trimProtrusions } from './protrusion';
import { GLARE, OUT } from './paths.mjs';

const i = process.argv.indexOf('--only');
const only = i > 0 ? process.argv[i + 1].split(',') : undefined;
const dir = join(OUT as string, 'pictures');
mkdirSync(dir, { recursive: true });
const done = new Set<string>();
const rows: unknown[] = [];
const j = process.argv.indexOf('--sets');
const extra = j > 0 ? process.argv[j + 1].split(',') : [];
for (const variant of ['final', 'diffsemi', ...extra])
  for (const source of haze((extra.includes(variant) ? variant : `glare-${variant}`) as HazeSet)) {
    const id = extra.includes(variant) ? source.id : source.id.slice(0, -variant.length - 1);
    // Registered products and tiles only (the reviewer's ask 11-19).
    if (!/^[gnr]-/.test(id) || done.has(id)) continue;
    if (only && !only.some((o) => id.startsWith(o))) continue;
    const loaded = await loadInput(source);
    if (!loaded) continue;
    done.add(id);
    const { input } = loaded;
    const app = refineCurrentResult(input);
    if (!app.shown) continue;
    const scores = metalScores(input, app);
    const metal = new Set(scores.filter((s) => s.bands >= 6.5 && s.ratio >= 3).map((s) => s.fixture));
    const pasted = metal.size ? pasteRender(input, metal) : undefined;
    writeFileSync(join(dir, `${id}.now.png`), await png(app.shown));
    writeFileSync(join(dir, `${id}.p1.png`), await png(pasted?.image ?? app.shown));
    // T1: the cut-outs without thin pieces sticking up, then today's steps (and P1 on that).
    const { dx, dy } = app.review.framing;
    const trim = trimProtrusions({ ...input, size: input.raw, dx, dy });
    const t1Input = { ...input, cuts: trim.cuts };
    const t1 = trim.trimmed.length ? refineCurrentResult(t1Input) : app;
    const t1Pasted = metal.size ? pasteRender(t1Input, metal) : undefined;
    writeFileSync(join(dir, `${id}.t1.png`), await png(t1.shown ?? app.shown));
    writeFileSync(join(dir, `${id}.p1t1.png`), await png(t1Pasted?.image ?? t1.shown ?? app.shown));
    const ref = join(GLARE as string, 'pictures', `${id}.ref.png`);
    if (existsSync(ref)) copyFileSync(ref, join(dir, `${id}.ref.png`));
    rows.push({ id, variant, metal: [...metal], scores, trimmed: trim.trimmed });
    console.log(
      id.padEnd(24),
      variant.padEnd(8),
      metal.size ? `P1 ${[...metal].map((k) => input.fixtures[k].kind).join(',')}` : '-',
      trim.trimmed.length
        ? `T1 ${trim.trimmed.map((t) => `${input.fixtures[t.fixture].kind} ${t.width}×${t.height}px (${t.pixels})`).join(', ')}`
        : '',
    );
  }
writeFileSync(join(OUT as string, 'p1.json'), JSON.stringify(rows, null, 1));
