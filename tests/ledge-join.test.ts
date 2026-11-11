/**
 * Ledges that touch are one piece of masonry (docs/wall-ledge-join-results-20261111.md): what the
 * validation lets meet, how a small gap is closed, what the two hide of each other in the 3D pieces
 * and in the tile areas, and which ledges share a floor contact.
 */
import { describe, expect, it } from 'vitest';
import { createRoomSurfaces, DEFAULT_ROOM } from '../src/lib/room-geometry';
import { roomSurfaceAreas } from '../src/lib/room-surface-areas';
import { viewerSurfacePatches } from '../src/lib/room-viewer/surfaces';
import { buildWallFeaturePieces, type WallFeaturePiece } from '../src/lib/room-viewer/wall-feature-geometry';
import {
  joinedLedges,
  LEDGE_JOIN_GAP_MM,
  LEDGE_OVERLAP_MESSAGE,
  ledgeCovers,
  ledgeGroups,
  validateWallFeatures,
  type WallFeatureV1,
} from '../src/lib/wall-features';
import { DEFAULT_COLOR, EMPTY_MASK, type Scene } from '../src/lib/types';

const room = { ...DEFAULT_ROOM };
const id = (n: number) => 'dddddddd-dddd-4ddd-8ddd-' + n.toString(16).padStart(12, '0');
type Ledge = Extract<WallFeatureV1, { kind: 'ledge' }>;
const ledge = (n: number, over: Partial<Ledge> = {}): Ledge => ({
  version: 1,
  id: id(n),
  source: 'user',
  kind: 'ledge',
  face: 'back',
  leftMm: 300,
  bottomMm: 0,
  widthMm: 800,
  heightMm: 900,
  depthMm: 200,
  ...over,
});
const niche = (n: number, over: Partial<WallFeatureV1> = {}): WallFeatureV1 =>
  ({
    version: 1,
    id: id(n),
    source: 'user',
    kind: 'closed-niche',
    face: 'back',
    leftMm: 1100,
    topMm: 1600,
    widthMm: 400,
    heightMm: 300,
    depthMm: 100,
    ...over,
  }) as WallFeatureV1;
/** The shapes of the browser test: side by side, a stair, round the corner, one on the other. */
const side = (gap = 0) => [ledge(1), ledge(2, { leftMm: 1100 + gap, widthMm: 700 })];
const stair = (gap = 0) => [
  ledge(1, { widthMm: 700 }),
  ledge(2, { leftMm: 1000 + gap, widthMm: 800, heightMm: 600 }),
];
const corner = (gap = 0) => [
  ledge(1, { leftMm: 0, widthMm: 1200, heightMm: 1000, depthMm: 100 }),
  // The left wall runs from the room's front (u = 0) to the back wall.
  ledge(2, {
    face: 'left',
    leftMm: room.depthMm - 100 - gap - 1000,
    widthMm: 1000,
    heightMm: 1000,
    depthMm: 100,
  }),
];
const stack = (gap = 0) => [
  ledge(1, { widthMm: 1000, heightMm: 600 }),
  ledge(2, { widthMm: 1000, bottomMm: 600 + gap, heightMm: 300, depthMm: 120 }),
];
const messages = (features: WallFeatureV1[]) =>
  validateWallFeatures(room, features).map((issue) => issue.message);
const scene = (features: WallFeatureV1[]): Scene => ({
  originalAssetId: 'o',
  previewAssetId: 'p',
  imageWidth: 1200,
  imageHeight: 800,
  room: { ...room },
  surfaces: createRoomSurfaces(room, 1.5),
  fixtures: [],
  protection: EMPTY_MASK(),
  color: { ...DEFAULT_COLOR },
  ...(features.length ? { wallFeatures: features } : {}),
});
/** A whole face's tile area in mm². */
const area = (features: WallFeatureV1[], roomFace: string) => {
  const value = scene(features);
  const surface = value.surfaces.find((item) => item.roomFace === roomFace && !item.region)!;
  return roomSurfaceAreas(value).get(surface.id)!.areaM2! * 1e6;
};
const pieces = (features: WallFeatureV1[]) =>
  buildWallFeaturePieces(room as never, viewerSurfacePatches(scene(features)).patches, features).pieces;
const of = (list: WallFeaturePiece[], n: number, role: string) =>
  list.filter((piece) => piece.featureId === id(n) && piece.role === role);
const quadArea = (piece: WallFeaturePiece) => {
  const size = piece.worldBounds.max
    .clone()
    .sub(piece.worldBounds.min)
    .toArray()
    .sort((a, b) => b - a);
  return size[0] * size[1];
};

describe('ledges may touch', () => {
  it('side by side, one on the other and round a corner', () => {
    for (const shape of [side, stair, corner, stack]) expect(messages(shape())).toEqual([]);
    // The other way round the corner: the back ledge's end on the side ledge's front.
    expect(
      messages([
        ledge(1, { face: 'left', leftMm: 1400, widthMm: 1000, depthMm: 100 }),
        ledge(2, { leftMm: 100, widthMm: 900 }),
      ]),
    ).toEqual([]);
  });
  it('but never share a volume', () => {
    expect(messages([ledge(1), ledge(2, { leftMm: 1099.9, widthMm: 700 })])).toEqual([LEDGE_OVERLAP_MESSAGE]);
    expect(messages([ledge(1), ledge(2, { leftMm: 500 })])).toEqual([LEDGE_OVERLAP_MESSAGE]);
    // Both in the corner square.
    const issues = validateWallFeatures(room, [
      ledge(1, { leftMm: 0, depthMm: 100 }),
      ledge(2, { face: 'left', leftMm: 1400, widthMm: 1000, depthMm: 100 }),
    ]);
    expect(issues.map((issue) => [issue.code, issue.message])).toEqual([
      ['volume-collision', LEDGE_OVERLAP_MESSAGE],
    ]);
    expect(messages([ledge(1, { heightMm: 600 }), ledge(2, { bottomMm: 599, heightMm: 300 })])).toEqual([
      LEDGE_OVERLAP_MESSAGE,
    ]);
  });
  it('a rounding error apart is touching, either way', () => {
    expect(messages([ledge(1), ledge(2, { leftMm: 1100 - 1e-7 })])).toEqual([]);
    expect(messages([ledge(1), ledge(2, { leftMm: 1100 + 1e-7 })])).toEqual([]);
    expect(messages([ledge(1), ledge(2, { leftMm: 1100 - 1e-5 })])).toEqual([LEDGE_OVERLAP_MESSAGE]);
  });
  it('a niche still needs clear wall beside a ledge', () => {
    const beside = niche(2, { topMm: 1700, heightMm: 300 });
    expect(messages([ledge(1), beside])[0]).toContain('겹치거나 맞닿는');
    expect(messages([ledge(1), niche(2, { leftMm: 1101 })])).toEqual([]);
  });
});

describe('a small gap is closed', () => {
  const built = (features: WallFeatureV1[]) => joinedLedges(room, features);
  it('up to 5 mm, by the later ledge, and the stored numbers stay', () => {
    expect(LEDGE_JOIN_GAP_MM).toBe(5);
    for (const gap of [1, 5]) {
      const features = side(gap);
      const before = JSON.stringify(features);
      const [a, b] = built(features);
      expect(b.openingMm.left).toBe(a.openingMm.right);
      expect(b.openingMm.right).toBe(1800 + gap);
      expect(b.worldBounds.min[0]).toBe(a.worldBounds.max[0]);
      expect(b.opening.left).toBe(a.opening.right);
      expect(a.openingMm).toEqual({ left: 300, top: 1500, right: 1100, bottom: 2400 });
      expect(JSON.stringify(features)).toBe(before);
    }
    const [a, b] = built(side(6));
    expect([a.openingMm.right, b.openingMm.left]).toEqual([1100, 1106]);
  });
  it('whichever comes first in the list', () => {
    const [b, a] = built([...side(2)].reverse());
    // The first of the list (here the right one) stays; the left one reaches it.
    expect(b.openingMm.left).toBe(1102);
    expect(a.openingMm.right).toBe(1102);
  });
  it('upwards, and round the corner by the ledge whose end faces the gap', () => {
    const [low, high] = built(stack(3));
    expect(high.openingMm.bottom).toBe(low.openingMm.top);
    expect(high.heightMm).toBe(303);
    const [back, left] = built(corner(2));
    // The side ledge's end comes to the back ledge's front; no depth changes.
    expect(left.worldBounds.min[2]).toBe(back.worldBounds.max[2]);
    expect(left.openingMm.right).toBe(room.depthMm - 100);
    expect([back.depthMm, left.depthMm]).toEqual([100, 100]);
    // The same when the back ledge is the later one: its depth is not what closes the gap.
    const [left2, back2] = built([...corner(2)].reverse());
    expect(left2.worldBounds.min[2]).toBe(100);
    expect(back2.depthMm).toBe(100);
  });
  it('not across an edge or a corner only, and not into a third feature', () => {
    // Above and beside: the two meet at no face.
    const diagonal = [ledge(1, { heightMm: 600 }), ledge(2, { leftMm: 1102, bottomMm: 600, heightMm: 300 })];
    expect(built(diagonal)[1].openingMm.left).toBe(1102);
    // A niche stands 4 mm past the gap's other side: reaching the first ledge would not touch it.
    const withNiche = [ledge(1), ledge(2, { leftMm: 1103, widthMm: 500 }), niche(3, { leftMm: 1700 })];
    expect(messages(withNiche)).toEqual([]);
    expect(built(withNiche)[1].openingMm.left).toBe(1100);
  });
  it('makes edges a rounding error apart the same number', () => {
    const [a, b] = built([ledge(1, { leftMm: 300.1, widthMm: 799.9 }), ledge(2, { leftMm: 1100 })]);
    expect(b.openingMm.left).toBe(a.openingMm.right);
    expect(b.opening.left).toBe(a.opening.right);
  });
  it('leaves one ledge, far ledges and niches exactly as resolved', () => {
    const features = [
      ledge(1),
      ledge(2, { leftMm: 1200, widthMm: 500 }),
      niche(3, { leftMm: 1900, widthMm: 300 }),
    ];
    const [a, b, c] = built(features);
    expect(a.openingMm).toEqual({ left: 300, top: 1500, right: 1100, bottom: 2400 });
    expect(b.openingMm.left).toBe(1200);
    expect(c.protrudes).toBeUndefined();
    expect(built(undefined)).toEqual([]);
  });
});

describe('what touching ledges hide of each other', () => {
  it('names the covered rectangles of each face', () => {
    const [a, b] = joinedLedges(room, stair());
    expect(ledgeCovers(room, a, [a, b])).toEqual([
      { role: 'reveal-right', by: 'back', a0: 1800, a1: 2400, b0: 0, b1: 200 },
    ]);
    expect(ledgeCovers(room, b, [a, b])).toEqual([
      { role: 'reveal-left', by: 'back', a0: 1800, a1: 2400, b0: 0, b1: 200 },
    ]);
    const [back, left] = joinedLedges(room, corner());
    expect(ledgeCovers(room, back, [back, left])).toEqual([
      { role: 'front', by: 'left', a0: 0, a1: 100, b0: 1400, b1: 2400 },
    ]);
    expect(ledgeCovers(room, left, [back, left])).toEqual([
      { role: 'reveal-right', by: 'back', a0: 1400, a1: 2400, b0: 0, b1: 100 },
    ]);
    const [low, high] = joinedLedges(room, stack());
    expect(ledgeCovers(room, low, [low, high]).map((cover) => [cover.role, cover.b0, cover.b1])).toEqual([
      ['reveal-top', 0, 120],
    ]);
    expect(ledgeCovers(room, high, [low, high]).map((cover) => cover.role)).toEqual(['reveal-bottom']);
    expect(ledgeCovers(room, a, joinedLedges(room, side(6)))).toEqual([]);
  });
  it('side by side: no faces between them, tops that meet', () => {
    const list = pieces(side());
    expect(of(list, 1, 'reveal-right')).toEqual([]);
    expect(of(list, 2, 'reveal-left')).toEqual([]);
    expect(of(list, 1, 'reveal-left')).toHaveLength(1);
    expect(of(list, 2, 'reveal-right')).toHaveLength(1);
    expect(of(list, 1, 'reveal-top')[0].worldBounds.max.x).toBe(
      of(list, 2, 'reveal-top')[0].worldBounds.min.x,
    );
    // A gap of the old rule is built the same.
    expect(of(pieces(side(1)), 1, 'reveal-right')).toEqual([]);
    // Well apart, both ends are there.
    expect(of(pieces(side(6)), 1, 'reveal-right')).toHaveLength(1);
  });
  it('a stair: the taller one’s side shows above the lower one', () => {
    const list = pieces(stair());
    const shown = of(list, 1, 'reveal-right');
    expect(shown).toHaveLength(1);
    expect([shown[0].worldBounds.min.y, shown[0].worldBounds.max.y]).toEqual([600, 900]);
    expect(shown[0].againstFace).toBeUndefined();
    expect(of(list, 2, 'reveal-left')).toEqual([]);
  });
  it('one on the other: the lower top shows before the shallower upper one', () => {
    const list = pieces(stack());
    const top = of(list, 1, 'reveal-top');
    expect(top).toHaveLength(1);
    expect([top[0].worldBounds.min.z, top[0].worldBounds.max.z]).toEqual([120, 200]);
    expect(of(list, 2, 'reveal-bottom')).toEqual([]);
  });
  it('round the corner: the hidden faces wait for the other wall to be hidden', () => {
    const list = pieces(corner());
    // The back ledge's front under the side ledge's end, and that end.
    const fronts = of(list, 1, 'front');
    const covered = fronts.filter((piece) => piece.againstFace === 'left');
    expect(covered).toHaveLength(1);
    expect([covered[0].worldBounds.min.x, covered[0].worldBounds.max.x]).toEqual([-1200, -1100]);
    expect(fronts.filter((piece) => !piece.againstFace)).toHaveLength(1);
    expect(of(list, 2, 'reveal-right').map((piece) => piece.againstFace)).toEqual(['back']);
    expect(of(list, 2, 'reveal-left').map((piece) => piece.againstFace)).toEqual([undefined]);
    // The butt joint: the back ledge's top runs to the wall, the side ledge's ends at its front.
    expect(of(list, 1, 'reveal-top')[0].worldBounds.min.x).toBe(-1200);
    expect(of(list, 2, 'reveal-top')[0].worldBounds.min.z).toBe(100);
    // Its end on the left wall is as before.
    expect(of(list, 1, 'reveal-left').map((piece) => piece.againstFace)).toEqual(['left']);
  });
  it('a ledge standing alone is built from the same quads as before', () => {
    const alone = pieces([ledge(1)]).filter((piece) => piece.featureId);
    expect(alone.map((piece) => piece.role)).toEqual(['front', 'reveal-left', 'reveal-right', 'reveal-top']);
    expect(Array.from(alone[1].geometry.getAttribute('position').array)).toEqual([
      -900, 900, 0, -900, 900, 200, -900, 0, 200, -900, 0, 0,
    ]);
  });
});

describe('touching ledges in the tile areas', () => {
  const plain = (face: string) => area([], face);
  const added = (features: WallFeatureV1[], face = 'back') => area(features, face) - plain(face);
  it('side by side is one ledge of the whole width, with or without the old gap', () => {
    const one = added([ledge(1, { widthMm: 1500 })]);
    expect(added(side())).toBeCloseTo(one, 6);
    // 1 mm closed by the later ledge: it is a millimetre wider on top.
    expect(added(side(1))).toBeCloseTo(added([ledge(1, { widthMm: 1501 })]), 6);
    expect(area(side(), 'floor')).toBeCloseTo(area([ledge(1, { widthMm: 1500 })], 'floor'), 6);
    // 6 mm apart, both ends are tiled.
    expect(added(side(6))).toBeCloseTo(one + 2 * 900 * 200, 6);
  });
  it('a stair loses the shared face on both', () => {
    const [a, b] = stair();
    expect(added(stair())).toBeCloseTo(added([a]) + added([b]) - 2 * 600 * 200, 6);
  });
  it('one on the other loses the covered top and the underside', () => {
    const [a, b] = stack();
    expect(added(stack())).toBeCloseTo(added([a]) + added([b]) - 2 * 1000 * 120, 6);
  });
  it('round the corner loses the side ledge’s end and what it covers of the back ledge', () => {
    const [back, left] = corner();
    const contact = 100 * 1000;
    expect(added(corner())).toBeCloseTo(added([back]) - contact, 6);
    // The left wall: the back ledge covers 100 × 1000 of it, as before; the side ledge's end is untiled.
    expect(added(corner(), 'left')).toBeCloseTo(added([back], 'left') + added([left], 'left') - contact, 6);
    expect(added(corner(), 'floor')).toBeCloseTo(added([back], 'floor') + added([left], 'floor'), 6);
  });
  it('is the area of the pieces that are drawn', () => {
    for (const features of [side(), side(1), stair(), stack(), corner()]) {
      const list = pieces(features);
      for (const face of ['back', 'left'] as const) {
        if (!features.some((feature) => feature.face === face)) continue;
        const drawn = list
          .filter((piece) => piece.tileFace === face && !piece.againstFace)
          .reduce((sum, piece) => sum + quadArea(piece), 0);
        // The wall behind a ledge's end is still a drawn piece; no tile goes there.
        const behind =
          face === 'left' && features.some((f) => f.face === 'back' && f.leftMm === 0) ? 100 * 1000 : 0;
        expect(area(features, face)).toBeCloseTo(drawn - behind, 4);
      }
    }
  });
});

describe('ledges that touch are one body on the floor', () => {
  it('groups them, and leaves the others alone', () => {
    const features = [
      ...side(),
      ledge(3, { face: 'right', leftMm: 600 }),
      niche(4, { leftMm: 1900, widthMm: 300 }),
    ];
    expect(messages(features)).toEqual([]);
    expect(ledgeGroups(room, joinedLedges(room, features))).toEqual([0, 0, 2, -1]);
    expect(ledgeGroups(room, joinedLedges(room, corner()))).toEqual([0, 0]);
    expect(ledgeGroups(room, joinedLedges(room, side(6)))).toEqual([0, 1]);
  });
});
