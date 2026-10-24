/**
 * How big room products are drawn against their registered size (docs/product-scale-results-20261024.md
 * 2절). Run with SJN_SCALE_MEASURE=1 to print the table and write test-results/product-scale/measure.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import {
  asStandardModel,
  contactScene,
  measure2d,
  measure3d,
  SCALE_CASES,
  scaleFixture,
  scaleMaterial,
} from './helpers/product-scale';

const enabled = !!process.env.SJN_SCALE_MEASURE;
const pct = (value: number, of: number) => Math.round((value / of) * 1000) / 10;
describe.runIf(enabled)('room product size (measurement)', () => {
  it('prints the drawn size of each photo against the registered size', async () => {
    const rows: Record<string, unknown>[] = [];
    for (const c of SCALE_CASES)
      for (const depth of [c.depthMm, 0])
        for (const [chosen, label] of [
          [0, '정면 고름'],
          [1, '오른쪽 고름'],
        ] as const)
          for (const [u, v, where] of [
            [0.5, 0.55, '가운데'],
            [0.12, 0.85, '왼쪽 앞'],
          ] as const) {
            const material = scaleMaterial(c, depth);
            const row = (view: string, d: ReturnType<typeof measure2d>) =>
              rows.push({
                case: c.name,
                depth: depth ? '있음' : '없음',
                chosen: label,
                where,
                view,
                shown: d.direction,
                across: `${Math.round(d.acrossMm)}/${d.registeredAcrossMm}`,
                acrossPct: pct(d.acrossMm, d.registeredAcrossMm),
                height: `${Math.round(d.heightMm)}/${d.registeredHeightMm}`,
                heightPct: pct(d.heightMm, d.registeredHeightMm),
                solidHeightPct: pct(d.solidHeightMm, d.registeredHeightMm),
              });
            row('2D 편집', measure2d(c, scaleFixture(c, chosen, u, v)));
            for (const d of await measure3d(c, contactScene([scaleFixture(c, chosen, u, v)]), material))
              row(`3D ${d.quarter}`, d);
            if (chosen === 0 && where === '가운데') {
              const scene = asStandardModel(contactScene([scaleFixture(c, chosen, u, v)]), material);
              for (const d of await measure3d(c, scene, material)) row(`모형 ${d.quarter}`, d);
            }
          }
    mkdirSync('test-results/product-scale', { recursive: true });
    writeFileSync('test-results/product-scale/measure.json', JSON.stringify(rows, null, 1));
    console.table(rows.filter((r) => r.where === '가운데'));
  });
});
