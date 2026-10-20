/**
 * R8 of the side-view trial (docs/toilet-side-view-results-20261021.md), no AI call: the app's own
 * overlap (src/lib/direction-photo/candidate-order.ts) over graded answers. Pairs are a run's
 * consecutive seeds of one direction (1001·1002, 1003·1004, ...), as the form's two candidates; where
 * the pair's grades differ, does the larger overlap pick the better one (옆 > 살짝 사선 > 사선)?
 *
 * Usage: node tests/run-browser-test.mjs tests/direction-photo-real/side-order.ts <grades.json>...
 * (the grades files side-grade.mjs sheets were graded into; each row's `file` and its run's guide).
 */
import { existsSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { maskOverlap, outlineMask, overlapOrder } from '../../src/lib/direction-photo/candidate-order';

type Row = {
  file: string;
  run: string;
  view: string;
  seed: string;
  grade?: string;
  condition?: string;
  iou: number;
};
const RANK: Record<string, number> = { 옆: 2, '살짝 사선': 1, 사선: 0 };
const NAMES: Record<string, string> = { front: '정면', left: '왼쪽', right: '오른쪽' };

async function mask(file: string) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return outlineMask(data, info.width, info.height);
}
const guideOf = (row: Row) =>
  [`${row.run}/sent-guide-${row.view}.png`, `${row.run}/guide-${NAMES[row.view]}.png`].find(existsSync)!;

const rows = process.argv
  .slice(3)
  .flatMap((file) => JSON.parse(readFileSync(file, 'utf8')) as Row[])
  .filter((row) => row.grade);
const groups = new Map<string, Row[]>();
for (const row of rows) {
  const key = `${row.run}|${row.view}|${row.condition ?? ''}`;
  groups.set(key, [...(groups.get(key) ?? []), row]);
}
let pairs = 0,
  differ = 0,
  right = 0,
  agree = 0;
const misses: string[] = [];
for (const group of groups.values()) {
  group.sort((a, b) => Number(a.seed) - Number(b.seed));
  for (let i = 0; i + 1 < group.length; i += 2) {
    const pair = [group[i], group[i + 1]];
    const guide = (await mask(guideOf(pair[0])))!;
    const overlaps = await Promise.all(pair.map(async (row) => maskOverlap(guide, (await mask(row.file))!)));
    pairs++;
    // The trial's measure (measure.mjs) and the app's pick the same candidate first?
    if (overlapOrder(overlaps)[0] === overlapOrder(pair.map((row) => row.iou))[0]) agree++;
    if (RANK[pair[0].grade!] === RANK[pair[1].grade!]) continue;
    differ++;
    const first = pair[overlapOrder(overlaps)[0]];
    const better = RANK[pair[0].grade!] > RANK[pair[1].grade!] ? pair[0] : pair[1];
    if (first === better) right++;
    else misses.push(`${pair[0].run.split('/').pop()} ${pair[0].view} ${pair.map((r) => r.seed).join('·')}`);
  }
}
console.log(
  `쌍 ${pairs}, 등급이 다른 쌍 ${differ}, 앱의 겹침이 큰 쪽이 나은 쌍 ${right}, 시험 도구와 같은 후보를 앞에 둔 쌍 ${agree}/${pairs}`,
);
if (misses.length) console.log('틀린 쌍:', misses.join(', '));
