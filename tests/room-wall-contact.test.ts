import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { roomPlacementSchema } from '../src/lib/room-validation';
import { findFreeSlot, fixtureSlotBox, slotObstacles } from '../src/lib/room-slot';
import { normalizeRoomScene, resizedRoomScene } from '../src/lib/room-editing';
import {
  applyWallContact,
  behindWall,
  freeWallSlot,
  productDepthMm,
  wallContactPlace,
  wallDistanceMm,
} from '../src/lib/room-wall-contact';
import { contactFixture, contactMaterial, contactScene, CONTACT_CASES } from './helpers/fixture-contact';
import type { FixtureInstance, MaterialVersion } from '../src/lib/types';

/** A toilet 370 wide, 640 deep, with 정면·오른쪽·왼쪽·뒤 photos (photo 0 is 정면). */
const toilet = CONTACT_CASES[1];
const material = contactMaterial(toilet);
const materials: Record<string, MaterialVersion> = { m: material };
const VIEW = { 정면: 0, 오른쪽: 1, 왼쪽: 2, 뒤: 3 } as const;
function floorToilet(view: keyof typeof VIEW = '정면', u = 0.5, v = 0.55): FixtureInstance {
  const fixture = contactFixture(toilet, u, v);
  fixture.viewIndex = VIEW[view];
  return fixture;
}
const room = { ...DEFAULT_ROOM };

describe('a floor product against the wall behind it', () => {
  it('finds the wall behind from the angle name, a standard model from its turn', () => {
    expect(behindWall(floorToilet('정면'), materials)).toBe('back');
    expect(behindWall(floorToilet('오른쪽'), materials)).toBe('left');
    expect(behindWall(floorToilet('왼쪽'), materials)).toBe('right');
    // Its back to the open front: no wall.
    expect(behindWall(floorToilet('뒤'), materials)).toBeUndefined();
    const model = floorToilet();
    model.reconstruction = {
      version: 2,
      kind: 'toilet',
      color: '#fff',
      widthMm: 400,
      heightMm: 750,
      depthMm: 680,
      baseHeightMm: 0,
      yawDegrees: 90,
    };
    expect(behindWall(model, materials)).toBe('left');
    model.reconstruction.yawDegrees = -90;
    expect(behindWall(model, materials)).toBe('right');
    model.reconstruction.yawDegrees = 10;
    expect(behindWall(model, materials)).toBe('back');
    // Only on the floor.
    const wall = floorToilet();
    wall.roomPlacement!.face = 'back';
    expect(behindWall(wall, materials)).toBeUndefined();
  });

  it('puts the back of the footprint on that wall and keeps the place along it', () => {
    // 640 deep in a 2400 room: its middle is 320 from the wall.
    expect(wallContactPlace(room, floorToilet('정면', 0.3), materials)).toEqual({ u: 0.3, v: 320 / 2400 });
    expect(wallContactPlace(room, floorToilet('오른쪽', 0.5, 0.7), materials)).toEqual({
      u: 320 / 2400,
      v: 0.7,
    });
    expect(wallContactPlace(room, floorToilet('왼쪽', 0.5, 0.7), materials)).toEqual({
      u: 1 - 320 / 2400,
      v: 0.7,
    });
    expect(wallContactPlace(room, floorToilet('뒤'), materials)).toBeUndefined();
    // The scale and a standard model's own depth count; without a depth, half the width (as the slot search).
    const scaled = floorToilet();
    scaled.roomPlacement!.scale = 1.5;
    expect(productDepthMm(scaled, materials)).toBe(960);
    expect(wallContactPlace(room, scaled, materials)!.v).toBe(0.2);
    const noDepth = { m: { ...material, depthMm: 0 } };
    expect(productDepthMm(floorToilet(), noDepth)).toBe(185);
    const model = floorToilet();
    model.reconstruction = {
      version: 2,
      kind: 'toilet',
      color: '#fff',
      widthMm: 400,
      heightMm: 750,
      depthMm: 600,
      baseHeightMm: 0,
      yawDegrees: 0,
    };
    expect(wallContactPlace(room, model, materials)!.v).toBe(0.125);
    // The distance to the wall before it is put there.
    expect(wallDistanceMm(room, floorToilet('정면', 0.5, 0.55), materials)).toBeCloseTo(1000, 6);
    expect(wallDistanceMm(room, floorToilet('뒤'), materials)).toBeUndefined();
  });

  it('stays against the wall when the room, the angle or the depth changes; lets go only when unmarked', () => {
    const fixture = floorToilet('정면', 0.4, 0.55);
    fixture.roomPlacement!.againstWall = true;
    expect(applyWallContact(room, fixture, materials)).toBe(true);
    expect(fixture.roomPlacement).toMatchObject({ u: 0.4, v: 320 / 2400 });
    expect(applyWallContact(room, fixture, materials)).toBe(false);
    // A deeper room: the same 320 mm from the wall.
    const deep = { ...room, depthMm: 3200 };
    applyWallContact(deep, fixture, materials);
    expect(fixture.roomPlacement!.v).toBe(0.1);
    // Turned to face right: its back goes on the left wall, at the same place along the room's depth.
    fixture.viewIndex = VIEW.오른쪽;
    applyWallContact(room, fixture, materials);
    expect(fixture.roomPlacement).toMatchObject({ u: 320 / 2400, v: 0.1 });
    // Turned to face 뒤: no wall behind, left where it is (still marked, so it comes back when turned again).
    fixture.viewIndex = VIEW.뒤;
    expect(applyWallContact(room, fixture, materials)).toBe(false);
    expect(fixture.roomPlacement).toMatchObject({ u: 320 / 2400, v: 0.1, againstWall: true });
    // Unmarked: never moved; and without its material (not read yet) nothing is guessed.
    const free = floorToilet('정면', 0.4, 0.55);
    expect(applyWallContact(room, free, materials)).toBe(false);
    const unread = floorToilet();
    unread.roomPlacement!.againstWall = true;
    expect(applyWallContact(room, unread, {})).toBe(false);
  });

  it('is kept by every edit (normalizeRoomScene) and by a room resize', () => {
    const fixture = floorToilet('정면', 0.4, 0.55);
    fixture.roomPlacement!.againstWall = true;
    const previous = contactScene([floorToilet('정면', 0.4, 0.55)]);
    const next = contactScene([fixture]);
    normalizeRoomScene(previous, next, materials);
    expect(next.fixtures[0].roomPlacement!.v).toBe(320 / 2400);
    // Without the materials (an older caller) it stays where its u/v says.
    const marked = floorToilet('정면', 0.4, 0.55);
    marked.roomPlacement!.againstWall = true;
    const other = contactScene([marked]);
    normalizeRoomScene(structuredClone(other), other);
    expect(other.fixtures[0].roomPlacement!.v).toBe(0.55);
    const resized = resizedRoomScene(
      next,
      { ...room, depthMm: 3200 },
      { originalAssetId: 'original', previewAssetId: 'preview', imageWidth: 1536, imageHeight: 1024 },
      materials,
    );
    expect(resized.fixtures[0].roomPlacement!.v).toBe(0.1);
  });

  it('finds a free place along the wall first, 50 mm from the others, and none when the wall is full', () => {
    const first = floorToilet('정면', 0.5);
    first.roomPlacement!.againstWall = true;
    applyWallContact(room, first, materials);
    const scene = contactScene([first]);
    const next = floorToilet('정면', 0.5);
    next.id = 'next';
    const box = fixtureSlotBox(next, materials)!;
    const slot = freeWallSlot(room, next, materials, box, slotObstacles(scene, 'floor', materials))!;
    // On the wall (same v), beside the first: 370 wide + 50 apart, on a 50 mm grid.
    // The search stores 4 places; the next edit puts it exactly on the wall.
    expect(slot.v).toBeCloseTo(320 / 2400, 4);
    expect(Math.abs(slot.u - 0.5) * room.widthMm).toBeGreaterThanOrEqual(370 + 50 - 1e-6);
    expect(slot.status).toBe('moved');
    // A wall too narrow for two: no place on it.
    const narrow = { ...room, widthMm: 700 };
    expect(
      freeWallSlot(narrow, next, materials, box, slotObstacles(scene, 'floor', materials)),
    ).toBeUndefined();
    // The ordinary search still goes anywhere on the face.
    expect(findFreeSlot(narrow, 'floor', box, slotObstacles(scene, 'floor', materials)).status).not.toBe(
      'crowded',
    );
    // No wall behind: no wall place.
    expect(freeWallSlot(room, floorToilet('뒤'), materials, box, [])).toBeUndefined();
  });

  it('stores the mark as an optional true, and reads placements without it', () => {
    const placement = floorToilet().roomPlacement!;
    expect(roomPlacementSchema.parse(placement)).not.toHaveProperty('againstWall');
    expect(roomPlacementSchema.parse({ ...placement, againstWall: true }).againstWall).toBe(true);
    expect(roomPlacementSchema.safeParse({ ...placement, againstWall: false }).success).toBe(false);
    expect(roomPlacementSchema.safeParse({ ...placement, againstWall: 'back' }).success).toBe(false);
  });
});
