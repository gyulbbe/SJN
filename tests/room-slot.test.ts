import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  DEFAULT_SLOT,
  SLOT_GAP_MM,
  findFreeSlot,
  fixtureDepthMm,
  slotBox,
  slotObstacles,
  type PlacedBox,
  type SlotBox,
} from '../src/lib/room-slot';
import type { RoomFace, RoomPlacement } from '../src/lib/room-types';
import { DEFAULT_COLOR, EMPTY_MASK, type FixtureInstance } from '../src/lib/types';

const room = DEFAULT_ROOM; // 2400 × 2400 × 2400
const full = { left: 0, top: 0, right: 1, bottom: 1 };
const box = (widthMm: number, heightMm: number, depthMm: number, anchor = { x: 0.5, y: 1 }): SlotBox => ({
  widthMm,
  heightMm,
  depthMm,
  anchor,
  contentBounds: full,
});
const placed = (b: SlotBox, u: number, v: number): PlacedBox => ({ ...b, u, v });
const toilet = box(400, 760, 700);
const bath = box(1700, 560, 750);
const basin = box(600, 500, 400, { x: 0.5, y: 0.5 });

/** Independent of room-slot's own maths: the box a floor product covers, in mm on the floor. */
function floorRect(b: SlotBox, u: number, v: number) {
  const x = u * room.widthMm,
    z = v * room.depthMm;
  return { x0: x - b.widthMm / 2, x1: x + b.widthMm / 2, z0: z - b.depthMm / 2, z1: z + b.depthMm / 2 };
}
type Rect = ReturnType<typeof floorRect>;
const apart = (a: Rect, b: Rect, gap = SLOT_GAP_MM) =>
  a.x1 + gap <= b.x0 + 1e-6 ||
  b.x1 + gap <= a.x0 + 1e-6 ||
  a.z1 + gap <= b.z0 + 1e-6 ||
  b.z1 + gap <= a.z0 + 1e-6;
const insideFloor = (r: Rect) =>
  r.x0 >= -0.5 && r.x1 <= room.widthMm + 0.5 && r.z0 >= -0.5 && r.z1 <= room.depthMm + 0.5;

describe('the free place for a new product on a face', () => {
  it('is the default place on an empty face, for every face', () => {
    for (const face of ['floor', 'back', 'left', 'right'] as RoomFace[]) {
      const slot = findFreeSlot(room, face, face === 'floor' ? toilet : basin, []);
      expect(slot).toEqual({ ...DEFAULT_SLOT, status: 'default' });
    }
  });

  it('moves beside a product that stands on the default place, with the gap kept, inside the face', () => {
    const first = placed(toilet, DEFAULT_SLOT.u, DEFAULT_SLOT.v);
    const slot = findFreeSlot(room, 'floor', toilet, [first]);
    expect(slot.status).toBe('moved');
    expect([slot.u, slot.v]).not.toEqual([DEFAULT_SLOT.u, DEFAULT_SLOT.v]);
    const next = floorRect(toilet, slot.u, slot.v);
    expect(insideFloor(next)).toBe(true);
    expect(apart(next, floorRect(toilet, first.u, first.v))).toBe(true);
  });

  it('finds the place nearest the default one: just clear of the first product on one axis', () => {
    const first = placed(toilet, DEFAULT_SLOT.u, DEFAULT_SLOT.v);
    const slot = findFreeSlot(room, 'floor', toilet, [first]);
    const a = floorRect(toilet, first.u, first.v),
      b = floorRect(toilet, slot.u, slot.v);
    const alongX = Math.max(b.x0 - a.x1, a.x0 - b.x1),
      alongZ = Math.max(b.z0 - a.z1, a.z0 - b.z1);
    expect(Math.max(alongX, alongZ)).toBeGreaterThanOrEqual(SLOT_GAP_MM - 1e-6);
    expect(Math.max(alongX, alongZ)).toBeLessThan(SLOT_GAP_MM + 50 + 1e-6);
  });

  it('keeps four products apart one after another: toilet, smart toilet, bathtub, then another toilet', () => {
    const items = [toilet, box(400, 780, 700), bath, toilet];
    const obstacles: PlacedBox[] = [];
    for (const item of items) {
      const slot = findFreeSlot(room, 'floor', item, obstacles);
      expect(slot.status === 'default' || slot.status === 'moved', JSON.stringify(slot)).toBe(true);
      const rect = floorRect(item, slot.u, slot.v);
      expect(insideFloor(rect)).toBe(true);
      for (const other of obstacles)
        expect(apart(rect, floorRect(other, other.u, other.v)), `${item.widthMm} vs ${other.widthMm}`).toBe(
          true,
        );
      obstacles.push(placed(item, slot.u, slot.v));
    }
  });

  it('goes to the default place and says so when the face is full', () => {
    const wall = placed(box(2400, 2400, 2400), 0.5, 0.5);
    const slot = findFreeSlot(room, 'floor', toilet, [wall]);
    expect(slot).toEqual({ ...DEFAULT_SLOT, status: 'crowded' });
  });

  it('leaves a product bigger than the face on the default place without calling it crowded', () => {
    const slot = findFreeSlot(room, 'floor', box(5000, 800, 700), []);
    expect(slot).toEqual({ ...DEFAULT_SLOT, status: 'default' });
  });

  it('puts a wall product beside, above or below another wall product, on the wall', () => {
    const first = placed(basin, DEFAULT_SLOT.u, DEFAULT_SLOT.v);
    const slot = findFreeSlot(room, 'back', basin, [first]);
    expect(slot.status).toBe('moved');
    // On the back wall u runs across (2400 mm) and v down (2400 mm); a wall box is width × height.
    const rect = (u: number, v: number) => ({
      x0: u * 2400 - 300,
      x1: u * 2400 + 300,
      y0: v * 2400 - 250,
      y1: v * 2400 + 250,
    });
    const a = rect(first.u, first.v),
      b = rect(slot.u, slot.v);
    expect(b.x0).toBeGreaterThanOrEqual(-0.5);
    expect(b.x1).toBeLessThanOrEqual(2400.5);
    expect(b.y0).toBeGreaterThanOrEqual(-0.5);
    expect(b.y1).toBeLessThanOrEqual(2400.5);
    const clear =
      b.x0 >= a.x1 + SLOT_GAP_MM - 1e-6 ||
      a.x0 >= b.x1 + SLOT_GAP_MM - 1e-6 ||
      b.y0 >= a.y1 + SLOT_GAP_MM - 1e-6 ||
      a.y0 >= b.y1 + SLOT_GAP_MM - 1e-6;
    expect(clear).toBe(true);
  });

  it('reads the left wall through its own u (it runs front to back there): no box leaves the wall', () => {
    const first = placed(basin, 0.5, 0.55);
    const second = findFreeSlot(room, 'left', basin, [first]);
    expect(second.status).toBe('moved');
    expect(second.u * 2400 - 300).toBeGreaterThanOrEqual(-0.5);
    expect(second.u * 2400 + 300).toBeLessThanOrEqual(2400.5);
    const third = findFreeSlot(room, 'left', basin, [first, placed(basin, second.u, second.v)]);
    expect(third.u * 2400 - 300).toBeGreaterThanOrEqual(-0.5);
    expect(third.u * 2400 + 300).toBeLessThanOrEqual(2400.5);
    expect([third.u, third.v]).not.toEqual([second.u, second.v]);
  });

  it('sizes a room that is not square by its own face: the left wall by the room depth', () => {
    const narrow = { ...room, widthMm: 1800, depthMm: 3200 };
    const first = placed(basin, 0.5, 0.55);
    const slot = findFreeSlot(narrow, 'left', basin, [first]);
    expect(slot.status).toBe('moved');
    expect(slot.u * 3200 - 300).toBeGreaterThanOrEqual(-0.5);
    expect(slot.u * 3200 + 300).toBeLessThanOrEqual(3200.5);
  });

  it('follows the anchor: a box that hangs to the right of its anchor stays on the face', () => {
    const rightHanging = box(600, 760, 500, { x: 0, y: 1 });
    const slot = findFreeSlot(room, 'floor', rightHanging, [placed(rightHanging, 0.5, 0.55)]);
    expect(slot.status).toBe('moved');
    expect(slot.u * 2400).toBeGreaterThanOrEqual(-0.5);
    expect(slot.u * 2400 + 600).toBeLessThanOrEqual(2400.5);
  });

  it('counts the scale: a product shown at 200% covers twice the width and depth', () => {
    const placement: RoomPlacement = {
      face: 'floor',
      u: 0.5,
      v: 0.55,
      scale: 2,
      widthMm: 400,
      heightMm: 760,
      imageAspect: 0.5,
      contentBounds: full,
    };
    const scaled = slotBox(placement, { x: 0.5, y: 1 }, 700);
    expect([scaled.widthMm, scaled.heightMm, scaled.depthMm]).toEqual([800, 1520, 1400]);
  });
});

describe('the products already on a face', () => {
  const fixture = (id: string, face: RoomFace, extra: Partial<FixtureInstance> = {}): FixtureInstance => ({
    id,
    name: id,
    materialVersionId: 'm-' + id,
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.2,
    height: 0.3,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    roomPlacement: {
      face,
      u: 0.5,
      v: 0.55,
      scale: 1,
      widthMm: 400,
      heightMm: 760,
      imageAspect: 0.5,
      contentBounds: full,
    },
    ...extra,
  });
  const materials = {
    'm-a': { depthMm: 700 },
    'm-b': { depthMm: 500 },
    'm-c': { depthMm: 300 },
    'm-d': { depthMm: 300 },
  };

  it('are the products on that face only, locked ones too, without the one being replaced', () => {
    const scene = {
      fixtures: [
        fixture('a', 'floor'),
        fixture('b', 'floor', { locked: true }),
        fixture('c', 'back'),
        fixture('d', 'floor', { roomPlacement: undefined }),
      ],
    };
    expect(slotObstacles(scene, 'floor', materials).map((o) => o.depthMm)).toEqual([700, 500]);
    expect(slotObstacles(scene, 'floor', materials, ['a']).map((o) => o.depthMm)).toEqual([500]);
    expect(slotObstacles(scene, 'back', materials)).toHaveLength(1);
    expect(slotObstacles(scene, 'left', materials)).toHaveLength(0);
  });

  it('take their depth from the standard model, else the material, else a guess from the width', () => {
    const model = fixture('a', 'floor', {
      reconstruction: {
        version: 2,
        kind: 'toilet',
        color: '#fff',
        widthMm: 400,
        heightMm: 760,
        depthMm: 650,
      },
    });
    expect(fixtureDepthMm(model, materials)).toBe(650);
    expect(fixtureDepthMm(fixture('b', 'floor'), materials)).toBe(500);
    expect(fixtureDepthMm(fixture('z', 'floor'), materials)).toBe(0);
    const unknown = slotObstacles({ fixtures: [fixture('z', 'floor')] }, 'floor', materials)[0];
    expect(unknown.depthMm).toBe(200); // half the width when the depth is not known
  });

  it('a locked product is an obstacle: the new product keeps clear of it', () => {
    const scene = { fixtures: [fixture('a', 'floor', { locked: true })] };
    const obstacles = slotObstacles(scene, 'floor', materials);
    const slot = findFreeSlot(room, 'floor', toilet, obstacles);
    expect(slot.status).toBe('moved');
    expect(
      apart(floorRect(toilet, slot.u, slot.v), floorRect(obstacles[0], obstacles[0].u, obstacles[0].v)),
    ).toBe(true);
  });
});
