import { describe, expect, it } from 'vitest';
import { quoteSourceSignature } from '../src/lib/quote';
import { resizedRoomScene } from '../src/lib/room-editing';
import { createRoomSurfaces, DEFAULT_ROOM } from '../src/lib/room-geometry';
import { roomSurfaceAreas } from '../src/lib/room-surface-areas';
import { viewerSurfacePatches } from '../src/lib/room-viewer/surfaces';
import { buildWallFeaturePieces } from '../src/lib/room-viewer/wall-feature-geometry';
import {
  featureFields,
  featureFromClick,
  featureFromDrag,
  featureUv,
  movedFeature,
  wallFeatureTitle,
  withFields,
} from '../src/lib/wall-feature-editing';
import {
  ledgeFootprints,
  resolveWallFeature,
  validateWallFeatures,
  type WallFeatureV1,
} from '../src/lib/wall-features';
import { DEFAULT_COLOR, EMPTY_MASK, type Scene } from '../src/lib/types';

const room = { ...DEFAULT_ROOM };
const id = (n: number) => 'cccccccc-cccc-4ccc-8ccc-' + n.toString(16).padStart(12, '0');
type Ledge = Extract<WallFeatureV1, { kind: 'ledge' }>;
const ledge = (over: Partial<Ledge> = {}): Ledge => ({
  version: 1,
  id: id(1),
  source: 'user',
  kind: 'ledge',
  face: 'back',
  leftMm: 750,
  bottomMm: 0,
  widthMm: 900,
  heightMm: 800,
  depthMm: 150,
  ...over,
});
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
  wallFeatures: features,
});
const area = (value: Scene, roomFace: string) => {
  const surface = value.surfaces.find((item) => item.roomFace === roomFace && !item.region)!;
  return roomSurfaceAreas(value).get(surface.id)!.areaM2!;
};

describe('a ledge is validated', () => {
  const messages = (...features: unknown[]) =>
    validateWallFeatures(room, features).map((issue) => issue.message);
  it('stands on the floor and reaches its wall ends', () => {
    expect(messages(ledge())).toEqual([]);
    expect(messages(ledge({ leftMm: 0, widthMm: 2400 }))).toEqual([]);
    expect(messages(ledge({ bottomMm: 700 }))).toEqual([]);
  });
  it('stays in the wall, below the ceiling and inside the room', () => {
    expect(messages(ledge({ leftMm: 1600 }))[0]).toContain('벽 안');
    expect(messages(ledge({ leftMm: -1 })).length).toBeGreaterThan(0);
    expect(messages(ledge({ bottomMm: -1 })).length).toBeGreaterThan(0);
    expect(messages(ledge({ heightMm: 2400 }))[0]).toContain('천장');
    expect(messages(ledge({ bottomMm: 1600 }))[0]).toContain('천장');
    expect(messages(ledge({ depthMm: 1001 })).length).toBeGreaterThan(0);
    const shallow = { ...room, depthMm: 900 };
    expect(validateWallFeatures(shallow, [ledge({ depthMm: 900 })])[0].message).toContain('방 안');
  });
  it('takes only its own fields', () => {
    expect(messages({ ...ledge(), topMm: 100 }).length).toBeGreaterThan(0);
    expect(messages({ ...ledge(), bottomMm: undefined }).length).toBeGreaterThan(0);
  });
  it('refuses what it would meet: its wall, another wall’s ledge, a niche it would cover', () => {
    expect(messages(ledge(), ledge({ id: id(2), leftMm: 1000 }))[0]).toContain('겹치거나');
    const cornerBack = ledge({ leftMm: 0, widthMm: 900 });
    const cornerLeft = ledge({ id: id(2), face: 'left', leftMm: 1500, widthMm: 900 });
    expect(messages(cornerBack, cornerLeft)[0]).toContain('겹치거나');
    const coveredNiche: WallFeatureV1 = {
      version: 1,
      id: id(3),
      source: 'user',
      kind: 'closed-niche',
      face: 'left',
      leftMm: 2000,
      topMm: 1800,
      widthMm: 300,
      heightMm: 300,
      depthMm: 100,
    };
    expect(messages(cornerBack, coveredNiche)[0]).toContain('겹치거나');
    expect(messages(ledge(), coveredNiche)).toEqual([]);
  });
  it('resolves out into the room on every wall', () => {
    const bounds = (face: Ledge['face']) => resolveWallFeature(room, ledge({ face })).worldBounds;
    expect(bounds('back')).toEqual({ min: [-450, 0, 0], max: [450, 800, 150] });
    expect(bounds('left')).toEqual({ min: [-1200, 0, 750], max: [-1050, 800, 1650] });
    expect(bounds('right')).toEqual({ min: [1050, 0, 750], max: [1200, 800, 1650] });
    expect(resolveWallFeature(room, ledge()).protrudes).toBe(true);
  });
});

describe('what a ledge covers', () => {
  it('the floor under it, none when it hangs, and only a wall its end lies against', () => {
    const faces = (over: Partial<Ledge>) =>
      ledgeFootprints(room, resolveWallFeature(room, ledge(over))).map((part) => part.face);
    expect(faces({})).toEqual(['floor']);
    expect(faces({ bottomMm: 700 })).toEqual([]);
    expect(faces({ leftMm: 0 })).toEqual(['floor', 'left']);
    expect(faces({ leftMm: 1500 })).toEqual(['floor', 'right']);
    // A side wall's front end is the room's open front; its back end meets the back wall.
    expect(faces({ face: 'left', leftMm: 0 })).toEqual(['floor']);
    expect(faces({ face: 'left', leftMm: 1500 })).toEqual(['floor', 'back']);
    expect(faces({ face: 'right', leftMm: 0 })).toEqual(['floor', 'back']);
    expect(faces({ face: 'right', leftMm: 1500 })).toEqual(['floor']);
  });
});

describe('a ledge in the tile areas', () => {
  const plain = scene([]);
  it('adds its front sides and top to the wall and takes its foot off the floor', () => {
    const value = scene([ledge()]);
    // Sides 2 × 0.15 × 0.8 = 0.24, top 0.9 × 0.15 = 0.135; the floor loses the same 0.135.
    expect(area(value, 'back') - area(plain, 'back')).toBeCloseTo(0.375, 9);
    expect(area(value, 'floor') - area(plain, 'floor')).toBeCloseTo(-0.135, 9);
    expect(area(value, 'left')).toBeCloseTo(area(plain, 'left'), 9);
  });
  it('adds an underside when it hangs, and the floor keeps its tiles', () => {
    const value = scene([ledge({ bottomMm: 700 })]);
    expect(area(value, 'back') - area(plain, 'back')).toBeCloseTo(0.24 + 0.135 * 2, 9);
    expect(area(value, 'floor')).toBeCloseTo(area(plain, 'floor'), 9);
  });
  it('tiles no end lying against a wall, and that wall loses what is covered', () => {
    const value = scene([ledge({ leftMm: 0 })]);
    expect(area(value, 'back') - area(plain, 'back')).toBeCloseTo(0.12 + 0.135, 9);
    expect(area(value, 'left') - area(plain, 'left')).toBeCloseTo(-0.12, 9);
    expect(area(value, 'floor') - area(plain, 'floor')).toBeCloseTo(-0.135, 9);
  });
  it('is the same on the side walls', () => {
    const value = scene([ledge({ face: 'right', leftMm: 0 })]);
    expect(area(value, 'right') - area(plain, 'right')).toBeCloseTo(0.12 + 0.135, 9);
    expect(area(value, 'back') - area(plain, 'back')).toBeCloseTo(-0.12, 9);
    expect(area(value, 'floor') - area(plain, 'floor')).toBeCloseTo(-0.135, 9);
  });
});

describe('a ledge as geometry', () => {
  const pieces = (feature: Ledge) => {
    const value = scene([feature]);
    return buildWallFeaturePieces(room as never, viewerSurfacePatches(value).patches, [feature]).pieces;
  };
  it('has a front, two ends and a top before the wall, and no underside on the floor', () => {
    const list = pieces(ledge()).filter((piece) => piece.featureId);
    expect(list.map((piece) => piece.role).sort()).toEqual([
      'front',
      'reveal-left',
      'reveal-right',
      'reveal-top',
    ]);
    const front = list.find((piece) => piece.role === 'front')!;
    expect(front.worldBounds.min.z).toBe(150);
    expect(front.worldBounds.max.z).toBe(150);
    expect(front.protrudes).toBe(true);
    const top = list.find((piece) => piece.role === 'reveal-top')!;
    expect(top.worldBounds.min.toArray()).toEqual([-450, 800, 0]);
    expect(top.worldBounds.max.toArray()).toEqual([450, 800, 150]);
  });
  it('looks out of the box on every face', () => {
    const list = pieces(ledge({ bottomMm: 700 })).filter((piece) => piece.featureId);
    const normal = (role: string) => list.find((piece) => piece.role === role)!.expectedNormal;
    expect(normal('front')).toEqual([0, 0, 1]);
    expect(normal('reveal-top')).toEqual([0, 1, 0]);
    expect(normal('reveal-bottom')).toEqual([0, -1, 0]);
    expect(normal('reveal-left')[0]).toBe(-1);
    expect(normal('reveal-right')[0]).toBe(1);
    for (const piece of list) {
      const geometry = piece.geometry;
      geometry.computeVertexNormals();
      const made = geometry.getAttribute('normal');
      expect(made.getX(0)).toBeCloseTo(piece.expectedNormal[0], 6);
      expect(made.getY(0)).toBeCloseTo(piece.expectedNormal[1], 6);
      expect(made.getZ(0)).toBeCloseTo(piece.expectedNormal[2], 6);
    }
  });
  it('continues the wall’s tiles round its corners', () => {
    const list = pieces(ledge()).filter((piece) => piece.featureId);
    const top = list.find((piece) => piece.role === 'reveal-top')!.geometry.getAttribute('uv');
    // The top unfolds upwards from the wall: 150 mm above its edge in the wall's own chart.
    const edge = 1 - 800 / 2400;
    expect(top.getY(0)).toBeCloseTo(edge, 6);
    expect(top.getY(2)).toBeCloseTo(edge - 150 / 2400, 6);
  });
  it('marks an end flat on another wall, and only that end', () => {
    const list = pieces(ledge({ leftMm: 0 })).filter((piece) => piece.featureId);
    expect(list.find((piece) => piece.role === 'reveal-left')!.againstFace).toBe('left');
    expect(list.find((piece) => piece.role === 'reveal-right')!.againstFace).toBeUndefined();
    const open = pieces(ledge({ face: 'left', leftMm: 0 })).filter((piece) => piece.featureId);
    expect(open.find((piece) => piece.role === 'reveal-left')!.againstFace).toBeUndefined();
  });
  it('leaves a niche as it was', () => {
    const niche: WallFeatureV1 = {
      version: 1,
      id: id(4),
      source: 'user',
      kind: 'closed-niche',
      face: 'back',
      leftMm: 600,
      topMm: 600,
      widthMm: 600,
      heightMm: 600,
      depthMm: 200,
    };
    const value = scene([niche]);
    const list = buildWallFeaturePieces(room as never, viewerSurfacePatches(value).patches, [niche]).pieces;
    const interior = list.filter((piece) => piece.featureId);
    expect(interior.every((piece) => !piece.protrudes && !piece.againstFace)).toBe(true);
    expect(interior.find((piece) => piece.role === 'rear')!.worldBounds.min.z).toBe(-200);
    expect(interior.find((piece) => piece.role === 'reveal-top')!.expectedNormal).toEqual([0, -1, 0]);
  });
});

describe('drawing and editing a ledge', () => {
  const draw = { depthMm: 150, snap: false, materials: {}, shape: 'ledge' as const };
  const value = scene([]);
  it('a drag past the foot stands it on the floor, and near a wall end reaches it', () => {
    const made = featureFromDrag(value, 'back', { u: 0.002, v: 0.6 }, { u: 0.5, v: 1 }, draw)
      .feature as Ledge;
    expect(made).toMatchObject({ kind: 'ledge', leftMm: 0, bottomMm: 0, widthMm: 1200, depthMm: 150 });
    expect(made.heightMm).toBe(960);
    const end = featureFromDrag(value, 'back', { u: 0.5, v: 0.6 }, { u: 0.999, v: 1 }, draw).feature as Ledge;
    expect(end.leftMm + end.widthMm).toBe(2400);
  });
  it('a drag above the floor hangs it; a niche keeps its margin', () => {
    const made = featureFromDrag(value, 'back', { u: 0.25, v: 0.5 }, { u: 0.75, v: 0.6 }, draw)
      .feature as Ledge;
    expect(made).toMatchObject({ kind: 'ledge', bottomMm: 960, heightMm: 240 });
    const niche = featureFromDrag(
      value,
      'back',
      { u: 0.002, v: 0.5 },
      { u: 0.5, v: 0.6 },
      {
        ...draw,
        shape: 'niche',
      },
    ).feature!;
    expect(niche.kind).toBe('closed-niche');
    expect(niche.leftMm).toBe(10);
  });
  it('a snapped drag stays below the ceiling', () => {
    const made = featureFromDrag(
      value,
      'back',
      { u: 0.1, v: 0.001 },
      { u: 0.5, v: 0.5 },
      { ...draw, snap: true },
    ).feature as Ledge;
    expect(validateWallFeatures(room, [made])).toEqual([]);
  });
  it('a click stands the usual ledge on the floor, centred and inside the wall', () => {
    const made = featureFromClick(room, 'back', { u: 0.5, v: 0.2 }, draw) as Ledge;
    expect(made).toMatchObject({
      kind: 'ledge',
      leftMm: 600,
      bottomMm: 0,
      widthMm: 1200,
      heightMm: 900,
      depthMm: 150,
    });
    const narrow = featureFromClick({ ...room, heightMm: 1500 }, 'back', { u: 0.99, v: 0.5 }, draw) as Ledge;
    expect(narrow.leftMm + narrow.widthMm).toBe(2400);
    expect(narrow.heightMm).toBe(750);
  });
  it('moves sideways on the floor, both ways when hanging, and stays in its wall', () => {
    expect(movedFeature(ledge(), room, 0.1, 0.1)).toMatchObject({ leftMm: 990, bottomMm: 0 });
    expect(movedFeature(ledge(), room, -1, 0)).toMatchObject({ leftMm: 0 });
    expect(movedFeature(ledge(), room, 1, 0)).toMatchObject({ leftMm: 1500 });
    const hung = movedFeature(ledge({ bottomMm: 700 }), room, 0, -0.1) as Ledge;
    expect(hung.bottomMm).toBe(940);
    expect((movedFeature(ledge({ bottomMm: 700 }), room, 0, 1) as Ledge).bottomMm).toBe(10);
  });
  it('keeps its kind through the card’s fields, and is named', () => {
    const fields = featureFields(ledge({ bottomMm: 300 }), room);
    expect(fields).toEqual({ leftMm: 750, bottomMm: 300, widthMm: 900, heightMm: 800, depthMm: 150 });
    expect(withFields(ledge(), { ...fields, bottomMm: 0 }, room)).toEqual(ledge({ heightMm: 800 }));
    expect(withFields(ledge(), { ...fields, depthMm: 90 }, room).kind).toBe('ledge');
    expect(wallFeatureTitle(ledge())).toBe('정면 벽 · 젠다이');
    expect(featureUv(ledge(), room)).toEqual({
      left: 750 / 2400,
      right: 1650 / 2400,
      top: 1600 / 2400,
      bottom: 1,
    });
  });
});

describe('a ledge across the project', () => {
  it('keeps its height above the floor when the room grows', () => {
    const resized = resizedRoomScene(
      scene([ledge()]),
      { ...room, heightMm: 3000 },
      { originalAssetId: 'n', previewAssetId: 'n', imageWidth: 1500, imageHeight: 1000 },
    );
    const [kept] = resized.wallFeatures as Ledge[];
    expect(kept).toMatchObject({ bottomMm: 0, heightMm: 800 });
    expect(resolveWallFeature(resized.room!, kept).openingMm).toMatchObject({ top: 2200, bottom: 3000 });
  });
  it('changes the quote’s signature when it changes', () => {
    const signature = (feature: Ledge) => quoteSourceSignature(scene([feature]));
    expect(signature(ledge())).toBe(signature(ledge()));
    expect(signature(ledge({ bottomMm: 100 }))).not.toBe(signature(ledge()));
    expect(signature(ledge({ heightMm: 700 }))).not.toBe(signature(ledge()));
  });
});
