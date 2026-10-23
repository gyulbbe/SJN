/**
 * Measures where floor products meet the floor and the wall (docs/size-order-and-contact-results-20261024.md
 * 2절). Run with SJN_CONTACT_MEASURE=1 to print the table and write test-results/fixture-contact/measure.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  asStandardModel,
  CONTACT_CASES,
  contactFixture,
  contactMaterial,
  contactScene,
  measureContact,
} from './helpers/fixture-contact';

const enabled = !!process.env.SJN_CONTACT_MEASURE;
describe.runIf(enabled)('floor product contact (measurement)', () => {
  it('prints the floor and wall gaps from the four sides', async () => {
    const rows: Record<string, unknown>[] = [];
    for (const c of CONTACT_CASES) {
      const material = contactMaterial(c);
      // The default place (v 0.55), and the place whose footprint's back touches the back wall.
      const atWall = c.depthMm / 2 / DEFAULT_ROOM.depthMm;
      for (const [place, v, against] of [
        ['기본 자리', 0.55, false],
        ['발판 뒤가 벽', atWall, false],
        ['벽에 붙이기', 0.55, true],
      ] as const) {
        for (const model of [false, true]) {
          const fixture = contactFixture(c, 0.5, v);
          if (against) fixture.roomPlacement!.againstWall = true;
          const scene = contactScene([fixture]);
          if (model) asStandardModel(scene, material);
          const { sides } = await measureContact(scene, material, c.photos);
          const footprintBack = (against ? atWall : v) * DEFAULT_ROOM.depthMm - c.depthMm / 2;
          for (const side of sides)
            rows.push({
              case: c.name,
              place,
              shown: model ? '표준 모형' : side.direction,
              quarter: side.quarter,
              floorMm: Math.round(side.floorMm * 10) / 10,
              solidFloorMm: Math.round(side.solidFloorMm * 10) / 10,
              backMm: Math.round(side.backMm * 10) / 10,
              footprintBackMm: Math.round(footprintBack),
            });
        }
      }
    }
    mkdirSync('test-results/fixture-contact', { recursive: true });
    writeFileSync('test-results/fixture-contact/measure.json', JSON.stringify(rows, null, 1));
    console.table(rows);
  });
});
