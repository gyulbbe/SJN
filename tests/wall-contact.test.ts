// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { Mesh, Texture, Vector3 } from 'three';
import { createRoomCamera, DEFAULT_ROOM, projectRoomPoint, roomFacePoint } from '../src/lib/room-geometry';
import { buildViewerFixtures, ProductAssetCache } from '../src/lib/room-viewer/fixtures';
import { normalizeRoomScene, reprojectRoomScene } from '../src/lib/room-editing';
import { projectRoomFixture, shownDirection } from '../src/lib/room-fixtures';
import { showAsPhoto, showAsStandardModel } from '../src/lib/standard-model-view';
import type { MaterialVersion, Point, Scene } from '../src/lib/types';
import { cameraOn } from './helpers/fixture-contact';
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
  type WallCase,
  type WallSide,
} from './helpers/wall-contact';

/**
 * A product on a wall always touches it (docs/wall-contact-results-20261024.md): what shows of it is
 * 1 mm in front of the wall from every side of the 3D room and in the 2D editor, a 정면 or 뒤 photo
 * lies on the wall, and the 2D picture on a side wall is the 3D room's from the front.
 */
const GAP = 2;
const lies = (direction?: string) => direction === '정면' || direction === '뒤';

describe('a wall product touches its wall', () => {
  it('3D: what shows is within 2 mm of the wall from the four sides; a 정면 or 뒤 photo lies on it', async () => {
    for (const c of WALL_CASES)
      for (const wall of WALLS) {
        const { sides } = await measureWall3d(
          wallScene([wallFixture(c, wall)]),
          wallMaterial(c),
          c.photos,
          wall,
        );
        expect(sides).toHaveLength(4);
        for (const side of sides) {
          const where = `${c.name} ${wall} ${side.quarter} ${side.direction}`;
          expect(side.nearMm, where).toBeGreaterThanOrEqual(0.5);
          expect(side.nearMm, where).toBeLessThanOrEqual(GAP);
          // Lying on the wall, all of it is there; a profile stands out by about the product's depth.
          if (lies(side.direction)) expect(side.farMm, where).toBeLessThanOrEqual(GAP);
          else expect(side.farMm, where).toBeLessThan(c.depthMm * 1.1 + GAP);
        }
      }
  });

  it('3D: the standard models of wall kinds have their back on the wall from the four sides', async () => {
    for (const kind of WALL_MODEL_KINDS)
      for (const wall of WALLS) {
        const { sides } = await measureWall3d(
          wallScene([wallModel(kind, wall)]),
          wallMaterial(WALL_CASES[0]),
          WALL_CASES[0].photos,
          wall,
        );
        for (const side of sides) {
          expect(Math.abs(side.nearMm), `${kind} ${wall} ${side.quarter}`).toBeLessThanOrEqual(GAP);
        }
      }
  });

  it('2D: what shows touches the wall; a 정면 photo on a side wall is drawn on the wall', () => {
    for (const c of WALL_CASES)
      for (const wall of WALLS) {
        const material = wallMaterial(c);
        const fixture = wallFixture(c, wall);
        const drawn = measureWall2d(wallScene([fixture]), material, wall);
        const direction = material.views[fixture.viewIndex].direction;
        const where = `${c.name} ${wall} ${direction}`;
        expect(drawn.onWall, where).toBe(wall !== 'back' && lies(direction));
        // The back wall's picture is measured on the wall plane itself (it is parallel to the screen).
        expect(drawn.nearMm, where).toBeGreaterThanOrEqual(wall === 'back' ? -0.001 : 0.5);
        expect(drawn.nearMm, where).toBeLessThanOrEqual(GAP);
        if (drawn.onWall || wall === 'back') expect(drawn.farMm, where).toBeLessThanOrEqual(GAP);
      }
  });

  it('2D and 3D agree: the picture on a side wall has the 3D photo plane’s corners from the front', async () => {
    const c = WALL_CASES[1]; // the user's shower: 정면 only, the anchor on the slide bar
    for (const wall of ['left', 'right'] as WallSide[]) {
      const scene = wallScene([wallFixture(c, wall)]);
      reprojectRoomScene(scene, { m: wallMaterial(c) });
      const quad = scene.fixtures[0].projectedQuad!;
      expect(quad).toHaveLength(4);
      const cache = new ProductAssetCache(async () => undefined);
      vi.spyOn(cache, 'image').mockImplementation(async () => ({
        texture: new Texture(),
        bounds: c.photos[0].bounds,
        aspect: c.photos[0].aspect,
        canvas: { width: 100, height: 100 } as HTMLCanvasElement,
      }));
      const built = await buildViewerFixtures(scene, { m: wallMaterial(c) }, async () => undefined, cache);
      built.updateView(cameraOn(0));
      built.group.updateMatrixWorld(true);
      let plane: Mesh | undefined;
      built.group.traverse((node) => {
        if (node instanceof Mesh && node.visible && node.userData.viewIndex !== undefined) plane = node;
      });
      plane!.geometry.computeBoundingBox();
      const box = plane!.geometry.boundingBox!;
      const camera = createRoomCamera(DEFAULT_ROOM, scene.imageWidth / scene.imageHeight);
      const screen = (x: number, y: number): Point => {
        const p = new Vector3(x, y, box.min.z).applyMatrix4(plane!.matrixWorld).project(camera);
        return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
      };
      const corners = [
        screen(box.min.x, box.max.y),
        screen(box.max.x, box.max.y),
        screen(box.max.x, box.min.y),
        screen(box.min.x, box.min.y),
      ];
      for (const [i, corner] of corners.entries()) {
        expect(quad[i].x, `${wall} corner ${i}`).toBeCloseTo(corner.x, 4);
        expect(quad[i].y, `${wall} corner ${i}`).toBeCloseTo(corner.y, 4);
      }
      built.dispose();
      cache.dispose();
    }
  });
});

describe('editing a wall product in 2D', () => {
  /** The scene with its product dragged to where `u`, `v` draws it. */
  const dragged = (c: WallCase, wall: WallSide, u: number, v: number) => {
    const material = wallMaterial(c);
    const before = wallScene([wallFixture(c, wall)]);
    reprojectRoomScene(before, { m: material });
    const after = structuredClone(before);
    const target = structuredClone(before.fixtures[0]);
    Object.assign(target.roomPlacement!, { u, v });
    projectRoomFixture(
      before.room!,
      target,
      before.imageWidth / before.imageHeight,
      undefined,
      shownDirection(target, { m: material }),
    );
    after.fixtures[0].position = target.position;
    return { before, after, material, dropped: target.position };
  };
  it('reads a drag back to the place it was drawn at, on a side wall and the back wall', () => {
    for (const c of [WALL_CASES[1], WALL_CASES[2], WALL_CASES[3]])
      for (const wall of WALLS) {
        const { before, after, material, dropped } = dragged(c, wall, 0.62, 0.27);
        normalizeRoomScene(before, after, { m: material });
        const placement = after.fixtures[0].roomPlacement!;
        expect(placement.u, `${c.name} ${wall}`).toBeCloseTo(0.62, 9);
        expect(placement.v, `${c.name} ${wall}`).toBeCloseTo(0.27, 9);
        // Drawn again where it was dropped.
        expect(after.fixtures[0].position.x).toBeCloseTo(dropped.x, 9);
        expect(after.fixtures[0].position.y).toBeCloseTo(dropped.y, 9);
      }
  });

  it('a wall product drops "벽에 붙이기" (a floor product’s switch) at the next edit', () => {
    const c = WALL_CASES[3];
    const before = wallScene([wallFixture(c, 'left')]);
    before.fixtures[0].roomPlacement!.againstWall = true;
    const after = structuredClone(before);
    after.fixtures[0].color.warmth = 0.2;
    normalizeRoomScene(before, after, { m: wallMaterial(c) });
    expect('againstWall' in after.fixtures[0].roomPlacement!).toBe(false);
  });

  it('keeps a picture drawn on its wall until its material is read, and the standard model switch takes it away and back', () => {
    const c = WALL_CASES[3]; // the wall basin, 정면 only
    const material: MaterialVersion = wallMaterial(c);
    const scene: Scene = wallScene([wallFixture(c, 'right')]);
    reprojectRoomScene(scene, { m: material });
    const drawn = structuredClone(scene.fixtures[0].projectedQuad);
    expect(drawn).toHaveLength(4);
    // Opened before the material arrives: the saved picture stays as it was.
    reprojectRoomScene(scene, {});
    expect(scene.fixtures[0].projectedQuad).toEqual(drawn);
    // As its standard model it is a 3D model (no picture on the wall); as a photo again, on the wall.
    expect(showAsStandardModel(scene, scene.fixtures[0].id, material)).toBe(true);
    reprojectRoomScene(scene, { m: material });
    expect(scene.fixtures[0].projectedQuad).toBeUndefined();
    expect(showAsPhoto(scene, scene.fixtures[0].id, material)).toBe(true);
    reprojectRoomScene(scene, { m: material });
    expect(scene.fixtures[0].projectedQuad).toHaveLength(4);
    // Its anchor is on its place on the wall, 1 mm in front of it.
    const placement = scene.fixtures[0].roomPlacement!;
    const anchor = roomFacePoint(DEFAULT_ROOM, 'right', placement.u, placement.v);
    anchor.x -= 1;
    const expected = projectRoomPoint(DEFAULT_ROOM, anchor, scene.imageWidth / scene.imageHeight);
    expect(scene.fixtures[0].position.x).toBeCloseTo(expected.x, 12);
    expect(scene.fixtures[0].position.y).toBeCloseTo(expected.y, 12);
  });
});
