// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  measureWall2d,
  measureWall3d,
  WALL_CASES,
  WALL_MODEL_KINDS,
  WALLS,
  wallFixture,
  wallMaterial,
  wallModel,
  wallScene,
} from './helpers/wall-contact';

/**
 * The wall-contact table (docs/wall-contact-results-20261024.md): how far each wall product's
 * visible picture is from its wall, from the four sides of the 3D room and in the 2D editor. Run with
 * SJN_WALL_MEASURE=1; it writes test-results/wall-contact/measure.json.
 */
const run = process.env.SJN_WALL_MEASURE === '1';
const round = (n: number) => Math.round(n * 10) / 10;

describe.runIf(run)('wall contact measurement', () => {
  it('measures photos and standard models on the three walls', async () => {
    const rows: Record<string, unknown>[] = [];
    for (const c of WALL_CASES)
      for (const wall of WALLS) {
        const material = wallMaterial(c);
        const fixture = wallFixture(c, wall);
        const three = await measureWall3d(wallScene([structuredClone(fixture)]), material, c.photos, wall);
        const flat = measureWall2d(wallScene([structuredClone(fixture)]), material, wall);
        rows.push({
          case: c.name,
          wall,
          photo: material.views[fixture.viewIndex].direction,
          '2d': { near: round(flat.nearMm), far: round(flat.farMm), onWall: flat.onWall },
          '3d': three.sides.map((s) => ({
            quarter: s.quarter,
            photo: s.direction,
            near: round(s.nearMm),
            far: round(s.farMm),
          })),
        });
      }
    for (const kind of WALL_MODEL_KINDS)
      for (const wall of WALLS) {
        const fixture = wallModel(kind, wall);
        const three = await measureWall3d(
          wallScene([fixture]),
          wallMaterial(WALL_CASES[0]),
          WALL_CASES[0].photos,
          wall,
        );
        rows.push({
          case: '표준 모형 ' + kind,
          wall,
          '3d': three.sides.map((s) => ({ quarter: s.quarter, near: round(s.nearMm), far: round(s.farMm) })),
        });
      }
    mkdirSync('test-results/wall-contact', { recursive: true });
    writeFileSync('test-results/wall-contact/measure.json', JSON.stringify(rows, null, 2));
    for (const row of rows) console.log(JSON.stringify(row));
    expect(rows.length).toBeGreaterThan(0);
  }, 60000);
});
