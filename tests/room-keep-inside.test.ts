import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { normalizeRoomScene } from '../src/lib/room-editing';
import { fixtureSlotBox, keepBoxInside } from '../src/lib/room-slot';
import { insidePlace, wallContactPlace } from '../src/lib/room-wall-contact';
import { contactFixture, contactMaterial, contactScene, CONTACT_CASES } from './helpers/fixture-contact';
import type { FixtureInstance, MaterialVersion } from '../src/lib/types';

/**
 * A photo product stays whole inside the room (user, 2026-11-16: a toilet stood half outside the
 * room in the AI view). A toilet 370 wide, 640 deep, with 정면·오른쪽·왼쪽·뒤 photos.
 */
const toilet = CONTACT_CASES[1];
const materials: Record<string, MaterialVersion> = { m: contactMaterial(toilet) };
const VIEW = { 정면: 0, 오른쪽: 1, 왼쪽: 2, 뒤: 3 } as const;
const room = { ...DEFAULT_ROOM };
function floorToilet(view: keyof typeof VIEW = '정면', u = 0.5, v = 0.55): FixtureInstance {
  const fixture = contactFixture(toilet, u, v);
  fixture.viewIndex = VIEW[view];
  return fixture;
}
/** The footprint's left and right edges across the room (mm from the left wall), as the slot box has it. */
function across(fixture: FixtureInstance) {
  const box = fixtureSlotBox(fixture, materials)!;
  const share =
    (fixture.anchor.x - box.contentBounds.left) / (box.contentBounds.right - box.contentBounds.left);
  const at = fixture.roomPlacement!.u * room.widthMm;
  return { left: at - share * box.widthMm, right: at + (1 - share) * box.widthMm };
}

describe('a photo product stays whole inside the room', () => {
  it('moves a box at the wall in until its edge meets the wall, and leaves one inside exactly as it was', () => {
    const box = {
      widthMm: 400,
      heightMm: 700,
      depthMm: 600,
      anchor: { x: 0.5, y: 1 },
      contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
    };
    const at = keepBoxInside(room, 'floor', box, { u: 0, v: 1 });
    expect(at.u * room.widthMm).toBeCloseTo(200, 6);
    expect(at.v * room.depthMm).toBeCloseTo(room.depthMm - 300, 6);
    const inside = { u: 0.4123, v: 0.5 };
    expect(keepBoxInside(room, 'floor', box, inside)).toEqual(inside);
    // Larger than the face: centred.
    const huge = keepBoxInside(room, 'floor', { ...box, widthMm: room.widthMm * 2 }, { u: 0, v: 0.5 });
    expect(huge.u).toBeCloseTo(0.5, 6);
    // On a wall: across it and between floor and ceiling.
    const wall = keepBoxInside(room, 'back', { ...box, anchor: { x: 0.5, y: 0.5 } }, { u: 1, v: 0 });
    expect(wall.u * room.widthMm).toBeCloseTo(room.widthMm - 200, 6);
    expect(wall.v * room.heightMm).toBeCloseTo(350, 6);
  });

  it('a product facing a side wall is measured the other way round (its depth across the room)', () => {
    const side = floorToilet('오른쪽', 0, 0.5);
    const at = insidePlace(room, side, materials)!;
    expect(at.u * room.widthMm).toBeCloseTo(320, 6);
  });

  it('a standard model and a product whose material is not read yet keep their place', () => {
    const model = floorToilet('정면', 0, 0.5);
    model.reconstruction = {
      version: 2,
      kind: 'toilet',
      color: '#fff',
      widthMm: 400,
      heightMm: 750,
      depthMm: 680,
    };
    expect(insidePlace(room, model, materials)).toEqual({ u: 0, v: 0.5 });
    expect(insidePlace(room, floorToilet('정면', 0, 0.5), {})).toEqual({ u: 0, v: 0.5 });
  });

  it('a product dragged past the left wall stops with its edge on the wall (every edit)', () => {
    const before = floorToilet('정면', 0.3, 0.55);
    const after = floorToilet('정면', 0, 0.55);
    const next = contactScene([after]);
    normalizeRoomScene(contactScene([before]), next, materials);
    const edges = across(next.fixtures[0]);
    expect(edges.left).toBeGreaterThanOrEqual(-1e-6);
    expect(edges.left).toBeLessThan(1);
    // An untouched product saved at the wall is left as it was (its drawing keeps it inside).
    const saved = contactScene([floorToilet('정면', 0, 0.55)]);
    normalizeRoomScene(structuredClone(saved), saved, materials);
    expect(saved.fixtures[0].roomPlacement!.u).toBe(0);
  });

  it('a bigger scale is kept inside too', () => {
    const before = floorToilet('정면', 0.05, 0.55);
    const after = floorToilet('정면', 0.05, 0.55);
    after.roomPlacement!.scale = 2;
    const next = contactScene([after]);
    normalizeRoomScene(contactScene([before]), next, materials);
    expect(across(next.fixtures[0]).left).toBeGreaterThanOrEqual(-1e-6);
  });

  it('against the back wall it keeps its back on the wall and stays clear of the side walls', () => {
    const fixture = floorToilet('정면', 0, 0.55);
    fixture.roomPlacement!.againstWall = true;
    const place = wallContactPlace(room, fixture, materials)!;
    expect(place.v).toBe(320 / 2400);
    expect(place.u * room.widthMm).toBeGreaterThan(0);
    const moved = structuredClone(fixture);
    moved.roomPlacement!.u = place.u;
    expect(across(moved).left).toBeGreaterThanOrEqual(-1e-6);
  });
});
