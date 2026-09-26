import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { BAND_TARGET_MS, BandPlanner, cropProjectionRows } from '../src/lib/room-viewer/accumulate';
import { chooseTileCount } from '../src/lib/room-viewer/renderer';

describe('export tiles', () => {
  it('keeps a GPU at one tile and splits slow devices so a tile stays short', () => {
    // A GPU's probe estimate (about 50–300 ms for a whole 4096 sample) never splits.
    for (const ms of [20, 80, 300, 600]) expect(chooseTileCount(ms)).toBe(1);
    expect(chooseTileCount(1_000)).toBe(4);
    expect(chooseTileCount(4_000)).toBe(16);
    expect(chooseTileCount(15_000)).toBe(64);
    expect(chooseTileCount(60_000)).toBe(64);
    for (const ms of [700, 2_000, 4_800, 19_000]) expect(ms / chooseTileCount(ms)).toBeLessThanOrEqual(300);
  });

  it('sizes bands from the last band so each lands near the target time', () => {
    const planner = new BandPlanner(2400);
    expect(planner.next(2400)).toBe(150);
    // 150 rows took 300 ms (software rendering): the next band shrinks toward BAND_TARGET_MS,
    // by at most a quarter per step.
    planner.record(150, 300);
    expect(planner.next(2400)).toBe(Math.round(150 * (BAND_TARGET_MS / 300)));
    planner.record(150, 6000);
    expect(planner.next(2400)).toBe(Math.round(150 / 4));
    // A fast band grows at most fourfold per step, and never past the rows left.
    planner.record(30, 1);
    expect(planner.next(2400)).toBe(120);
    expect(planner.next(50)).toBe(50);
    planner.record(2400, 0);
    expect(planner.next(2400)).toBe(2400);
  });

  it('crops the projection so a tile of rows fills the viewport', () => {
    const camera = new PerspectiveCamera(60, 1.5, 10, 10000);
    camera.position.set(0, 1500, 3000);
    camera.updateMatrixWorld(true);
    const points = [new Vector3(0, 1200, 0), new Vector3(-800, 300, 500), new Vector3(600, 2100, -200)];
    const full = points.map((p) => p.clone().project(camera));
    const rows = 683;
    for (const [row, count] of [
      [0, 171],
      [171, 171],
      [512, 171],
    ]) {
      const tile = camera.clone();
      cropProjectionRows(tile, row, count, rows);
      points.forEach((p, i) => {
        const cropped = p.clone().project(tile);
        // x and depth are untouched; y maps the tile's rows onto −1…1.
        expect(cropped.x).toBeCloseTo(full[i].x, 9);
        expect(cropped.z).toBeCloseTo(full[i].z, 9);
        const pixelRow = ((full[i].y + 1) / 2) * rows;
        expect(((cropped.y + 1) / 2) * count + row).toBeCloseTo(pixelRow, 6);
      });
    }
  });
});
