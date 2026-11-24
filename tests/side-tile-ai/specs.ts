/**
 * The side-tile AI trial's scenes: tests/fixture-haze/specs.ts `gloss` (the registered glossy tiles of the
 * user's note "정면하고 옆면이 너무 다르게 보여") with the same room, walls, floors, toilets, places and
 * sides, but without their basins (registered only on a local dev server, not in the public catalogue).
 */
import type { SceneSpec } from '../export-photoreal/scene-builder';
import { TILES, TOILETS } from './needed.mjs';

const ROOM = { widthMm: 2400, depthMm: 2400, heightMm: 2400 };
const toilet = (prefix: string) => ({ id: 'photo-toilet', prefix, face: 'floor' as const, u: 0.72, v: 0.2 });
const DRAFTS = [
  { id: 'olive', wall: TILES.olive, floor: TILES.greyFloor, toilet: TOILETS.lc3200, azimuths: [0, 90] },
  { id: 'black', wall: TILES.black, floor: TILES.stoneFloor, toilet: TOILETS.lc2200, azimuths: [0] },
  { id: 'beige', wall: TILES.beige, floor: TILES.greyFloor, toilet: TOILETS.lc3100j, azimuths: [90] },
  { id: 'white', wall: TILES.white, floor: TILES.stoneFloor, toilet: TOILETS.hsc606, azimuths: [0] },
];

export function trialSpecs(materialIds: readonly string[]): SceneSpec[] {
  const one = (prefix: string) => {
    const found = materialIds.filter((id) => id.startsWith(prefix));
    if (found.length !== 1) throw new Error(`material ${prefix}: ${found.length} matches`);
    return found[0];
  };
  return DRAFTS.flatMap((d) =>
    d.azimuths.map((azimuth) => {
      const t = toilet(d.toilet);
      return {
        id: `${d.id}-${azimuth}`,
        label: `side-tile ${d.id} ${azimuth}°`,
        room: ROOM,
        wall: one(d.wall),
        floor: one(d.floor),
        products: [{ id: t.id, materialId: one(t.prefix), face: t.face, u: t.u, v: t.v }],
        azimuth,
      };
    }),
  );
}

/**
 * Backlog item 6 (light streaks and shadows the AI draws over big fixtures): a 3000 × 2400 room with the
 * export-photoreal `large` scene's bath (the app's standard model, 1500 × 560 × 750 mm, on the back wall)
 * and a registered toilet, under the same registered tiles. The bath is a standard model because the
 * public catalogue has no registered bath with direction photos (only "욕조 test", one top photo,
 * 2026-11-21): reference scenes, as the user ruled for standard-model scenes on 2026-11-17.
 * Chosen with SIDE_TILE_SPECS=big.
 */
const BIG_ROOM = { widthMm: 3000, depthMm: 2400, heightMm: 2400 };
const BATH = {
  id: 'bath',
  kind: 'bath',
  face: 'floor' as const,
  u: 0.27,
  v: 0.17,
  widthMm: 1500,
  heightMm: 560,
  depthMm: 750,
};
const BIG = [
  { id: 'olive', wall: TILES.olive, floor: TILES.greyFloor, toilet: TOILETS.lc3200, azimuths: [0, 90] },
  { id: 'black', wall: TILES.black, floor: TILES.stoneFloor, toilet: TOILETS.lc2200, azimuths: [0] },
  { id: 'beige', wall: TILES.beige, floor: TILES.greyFloor, toilet: TOILETS.lc3100j, azimuths: [0] },
  { id: 'white', wall: TILES.white, floor: TILES.stoneFloor, toilet: TOILETS.hsc606, azimuths: [0, 90] },
];
export function bigFixtureSpecs(materialIds: readonly string[]): SceneSpec[] {
  const one = (prefix: string) => {
    const found = materialIds.filter((id) => id.startsWith(prefix));
    if (found.length !== 1) throw new Error(`material ${prefix}: ${found.length} matches`);
    return found[0];
  };
  return BIG.flatMap((d) =>
    d.azimuths.map((azimuth) => ({
      id: `bath-${d.id}-${azimuth}`,
      label: `big fixture ${d.id} ${azimuth}°`,
      room: BIG_ROOM,
      wall: one(d.wall),
      floor: one(d.floor),
      standard: [BATH],
      products: [{ id: 'photo-toilet', materialId: one(d.toilet), face: 'floor' as const, u: 0.85, v: 0.2 }],
      azimuth,
    })),
  );
}
/** The scene set the trial tools draw: SIDE_TILE_SPECS=big for item 6, else the side-tile scenes. */
export const sceneSpecs = (materialIds: readonly string[]) =>
  process.env.SIDE_TILE_SPECS === 'big' ? bigFixtureSpecs(materialIds) : trialSpecs(materialIds);
