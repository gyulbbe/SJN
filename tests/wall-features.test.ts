import { describe, expect, it } from 'vitest';
import { roomFacePoint } from '../src/lib/room-geometry';
import type { RoomDimensions } from '../src/lib/room-types';
import {
  resolveWallFeature,
  validateWallFeatures,
  validateWallFeatureResize,
  WALL_FEATURE_CONTACT_EPSILON_MM,
  WALL_FEATURE_MAX_COUNT,
  WALL_FEATURE_MAX_DEPTH_MM,
  WallFeatureValidationError,
  type WallFeatureFace,
  type WallFeatureV1,
} from '../src/lib/wall-features';

// Authored synthetic dimensions only; none of these openings are photograph annotations.
const room: RoomDimensions = { widthMm: 3200, depthMm: 4600, heightMm: 2800 };
const id = (n: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + n.toString(16).padStart(12, '0');
const niche = (n = 1): Extract<WallFeatureV1, { kind: 'closed-niche' }> => ({
  version: 1,
  id: id(n),
  kind: 'closed-niche',
  face: 'back',
  leftMm: 400,
  topMm: 300,
  widthMm: 800,
  heightMm: 600,
  depthMm: 200,
  source: 'user',
});
const alcove = (n = 1): Extract<WallFeatureV1, { kind: 'floor-alcove' }> => ({
  version: 1,
  id: id(n),
  kind: 'floor-alcove',
  face: 'back',
  leftMm: 400,
  topMm: 300,
  widthMm: 800,
  depthMm: 200,
  source: 'user',
});
const faces: WallFeatureFace[] = ['left', 'back', 'right'];
const codes = (features: unknown, targetRoom: RoomDimensions | undefined = room) =>
  validateWallFeatures(targetRoom, features).map((issue) => issue.code);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('authored wall feature contract', () => {
  it('leaves legacy scenes with absent or empty features alone', () => {
    expect(validateWallFeatures(undefined, undefined)).toEqual([]);
    expect(validateWallFeatures(undefined, [])).toEqual([]);
    const legacy = deepFreeze({ fixtures: [], surfaces: [] });
    expect(validateWallFeatureResize({}, room)).toEqual([]);
    expect(legacy).toEqual({ fixtures: [], surfaces: [] });
    expect(Object.hasOwn(legacy, 'wallFeatures')).toBe(false);
  });

  it.each([null, {}, 'wall', 1])('rejects a non-array feature collection: %j', (value) => {
    expect(codes(value)).toEqual(['invalid-features']);
  });

  it('requires a storage-compatible room for any feature', () => {
    const invalidRooms = [
      { ...room, widthMm: 499 },
      { ...room, depthMm: 20001 },
      { ...room, heightMm: 6001 },
      { ...room, heightMm: Infinity },
      { ...room, widthMm: 3200.5 },
      { ...room, kind: 'photo', version: 1 },
      { ...room, kind: 'parametric', version: 2 },
    ];
    expect(validateWallFeatures(undefined, [niche()]).map((issue) => issue.code)).toEqual(['invalid-room']);
    for (const invalidRoom of invalidRooms) expect(codes([niche()], invalidRoom)).toEqual(['invalid-room']);
    expect(codes([niche()])).toEqual([]);
    expect(codes([niche()], { ...room, kind: 'parametric', version: 1 } as RoomDimensions)).toEqual([]);
  });

  it('bounds work at 24 items without truncating the source list', () => {
    const features = Array.from({ length: WALL_FEATURE_MAX_COUNT }, (_, index) => ({
      ...niche(index + 1),
      leftMm: 100 + (index % 6) * 450,
      topMm: 100 + Math.floor(index / 6) * 600,
      widthMm: 300,
      heightMm: 400,
    }));
    expect(codes(features)).toEqual([]);
    const tooMany = deepFreeze([...features, niche(25)]);
    expect(codes(tooMany)).toEqual(['too-many-features']);
    expect(tooMany).toHaveLength(25);
  });

  it.each([null, [], false])('rejects a non-object row: %j', (value) => {
    expect(validateWallFeatures(room, [value])).toEqual([
      { code: 'invalid-feature', path: ['wallFeatures', 0], message: expect.any(String) },
    ]);
  });

  it.each([
    ['version', 2, 'invalid-version'],
    ['id', 'photograph-01', 'invalid-id'],
    ['kind', 'raised-wall', 'invalid-kind'],
    ['face', 'floor', 'invalid-face'],
    ['face', 'front', 'invalid-face'],
    ['source', 'inferred', 'invalid-source'],
    ['source', 'model', 'invalid-source'],
  ])('rejects unsupported %s=%s', (field, value, code) => {
    expect(validateWallFeatures(room, [{ ...niche(), [field]: value }])).toContainEqual(
      expect.objectContaining({ code, path: ['wallFeatures', 0, field], message: expect.any(String) }),
    );
  });

  it('rejects duplicate UUIDs including case variants while preserving spelling', () => {
    const first = niche();
    const second = { ...niche(), id: id(1).toUpperCase(), leftMm: 1500 };
    expect(codes([first, second])).toEqual(['duplicate-id']);
    expect(second.id).toBe(id(1).toUpperCase());
    expect(codes([first, { ...second, id: id(2) }])).toEqual([]);
  });

  it('does not silently accept photo boxes, inferred metadata or stored alcove heights', () => {
    for (const input of [
      { ...niche(), bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
      { ...niche(), confidence: 0.9 },
      { ...alcove(), heightMm: 500 },
      { ...alcove(), heightMm: undefined },
    ])
      expect(codes([input])).toContain('unexpected-field');
    expect(Object.hasOwn(alcove(), 'heightMm')).toBe(false);
  });

  it.each(['leftMm', 'topMm', 'widthMm', 'heightMm', 'depthMm'])('requires finite positive %s', (field) => {
    for (const value of [undefined, '200', NaN, Infinity, -Infinity])
      expect(validateWallFeatures(room, [{ ...niche(), [field]: value }])).toContainEqual(
        expect.objectContaining({ code: 'invalid-number', path: ['wallFeatures', 0, field] }),
      );
    for (const value of [0, -0, -1])
      expect(validateWallFeatures(room, [{ ...niche(), [field]: value }])).toContainEqual(
        expect.objectContaining({ code: 'invalid-size', path: ['wallFeatures', 0, field] }),
      );
  });

  it('accepts fractional authored millimetres and the exact depth limit, but never greater depth', () => {
    expect(
      codes([{ ...niche(), leftMm: 400.25, widthMm: 800.5, depthMm: WALL_FEATURE_MAX_DEPTH_MM }]),
    ).toEqual([]);
    expect(codes([{ ...niche(), depthMm: WALL_FEATURE_MAX_DEPTH_MM + 0.1 }])).toEqual(['invalid-size']);
  });

  it.each(faces)('keeps the opening strictly inside the %s wall edges', (face) => {
    const wallSpan = face === 'back' ? room.widthMm : room.depthMm;
    const feature = { ...niche(), face };
    expect(codes([{ ...feature, widthMm: wallSpan - feature.leftMm }])).toContain('out-of-bounds');
    expect(codes([{ ...feature, widthMm: wallSpan - feature.leftMm + 1 }])).toContain('out-of-bounds');
    expect(codes([{ ...feature, widthMm: wallSpan - feature.leftMm - 1 }])).toEqual([]);
    expect(codes([{ ...feature, heightMm: room.heightMm - feature.topMm }])).toContain('out-of-bounds');
    expect(codes([{ ...alcove(), face, topMm: room.heightMm }])).toContain('out-of-bounds');
  });

  it('rejects dimensions that disappear in numeric coordinate arithmetic', () => {
    expect(codes([{ ...niche(), widthMm: Number.MIN_VALUE }])).toContain('invalid-size');
    expect(codes([{ ...niche(), face: 'left', depthMm: Number.MIN_VALUE }])).toContain('invalid-size');
    expect(codes([{ ...niche(), topMm: Number.MAX_VALUE }])).toContain('out-of-bounds');
  });

  it('reports all independent invalid fields with their original index and ID', () => {
    const issues = validateWallFeatures(room, [
      niche(),
      { ...niche(2), face: 'front', depthMm: NaN, widthMm: -1 },
    ]);
    expect(issues).toHaveLength(3);
    expect(issues.every((issue) => issue.featureId === id(2) && issue.path[1] === 1)).toBe(true);
  });
});

describe('wall-local opening to world coordinates', () => {
  it.each(faces)('matches roomFacePoint for a %s niche and alcove', (face) => {
    for (const feature of [
      { ...niche(), face },
      { ...alcove(), face },
    ]) {
      const result = resolveWallFeature(room, feature);
      expect(result.wallSpanMm).toBe(face === 'back' ? room.widthMm : room.depthMm);
      expect(result.inwardNormal).toEqual(
        face === 'back' ? [0, 0, 1] : face === 'left' ? [1, 0, 0] : [-1, 0, 0],
      );
      expect(result.openingMm).toEqual({
        left: 400,
        top: 300,
        right: 1200,
        bottom: feature.kind === 'floor-alcove' ? 2800 : 900,
      });
      const allCorners: number[][] = [];
      for (const u of [result.opening.left, result.opening.right])
        for (const v of [result.opening.top, result.opening.bottom])
          for (const depth of [0, feature.depthMm]) {
            const mouth = roomFacePoint(room, face, u, v).toArray();
            allCorners.push(mouth.map((value, axis) => value - result.inwardNormal[axis] * depth));
          }
      for (const axis of [0, 1, 2]) {
        expect(result.worldBounds.min[axis]).toBeCloseTo(
          Math.min(...allCorners.map((point) => point[axis])),
          10,
        );
        expect(result.worldBounds.max[axis]).toBeCloseTo(
          Math.max(...allCorners.map((point) => point[axis])),
          10,
        );
      }
      expect(result.heightMm).toBe(feature.kind === 'floor-alcove' ? 2500 : 600);
      expect(result.worldBounds.min[1]).toBe(feature.kind === 'floor-alcove' ? 0 : 1900);
      expect(result.worldBounds.max[1]).toBe(2500);
      expect(result.opening.bottom).toBe(feature.kind === 'floor-alcove' ? 1 : 900 / 2800);
    }
  });

  it('returns independent derived values without mutating authored input', () => {
    const feature = deepFreeze(niche());
    const frozenRoom = deepFreeze({ ...room });
    const snapshot = JSON.stringify({ feature, frozenRoom });
    const first = resolveWallFeature(frozenRoom, feature);
    const second = resolveWallFeature(frozenRoom, feature);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.opening).not.toBe(second.opening);
    expect(first.worldBounds.min).not.toBe(second.worldBounds.min);
    expect(JSON.stringify({ feature, frozenRoom })).toBe(snapshot);
  });

  it('throws structured errors instead of producing invalid world geometry', () => {
    try {
      resolveWallFeature(room, { ...niche(), depthMm: 0 });
      expect.fail('invalid geometry should not resolve');
    } catch (error) {
      expect(error).toBeInstanceOf(WallFeatureValidationError);
      expect((error as WallFeatureValidationError).issues).toContainEqual(
        expect.objectContaining({ code: 'invalid-size', path: ['wallFeatures', 0, 'depthMm'] }),
      );
    }
  });
});

describe('multi-feature separation', () => {
  it.each([
    { leftMm: 1000, topMm: 600 },
    { leftMm: 1200, topMm: 300 },
    { leftMm: 400, topMm: 900 },
    { leftMm: 1200, topMm: 900 },
    { leftMm: 600, topMm: 400, widthMm: 100, heightMm: 100 },
  ])('rejects overlap, edge contact, corner contact or containment: %j', (dimensions) => {
    expect(validateWallFeatures(room, [niche(), { ...niche(2), ...dimensions }])).toEqual([
      expect.objectContaining({
        code: 'touching-or-overlap',
        featureId: id(2),
        relatedFeatureId: id(1),
        path: ['wallFeatures', 1],
      }),
    ]);
  });

  it('does not confuse overlapping tile bands with overlapping openings', () => {
    expect(codes([niche(), { ...niche(2), leftMm: 1500 }])).toEqual([]);
    expect(codes([niche(), { ...niche(3), topMm: 1200 }])).toEqual([]);
    expect(codes([alcove(), { ...alcove(2), leftMm: 1500 }])).toEqual([]);
  });

  it('uses bounded contact tolerance without moving stored edges', () => {
    const epsilon = WALL_FEATURE_CONTACT_EPSILON_MM;
    const near = deepFreeze({ ...niche(2), leftMm: 1200 + epsilon / 2 });
    expect(codes([niche(), near])).toEqual(['touching-or-overlap']);
    expect(near.leftMm).toBe(1200 + epsilon / 2);
    expect(codes([niche(), { ...near, leftMm: 1200 + epsilon * 2 }])).toEqual([]);
  });

  it('allows separated voids on different walls, including opposite walls', () => {
    expect(codes(faces.map((face, index) => ({ ...niche(index + 1), face })))).toEqual([]);
    expect(
      codes([
        { ...alcove(), face: 'left' },
        { ...alcove(2), face: 'right' },
      ]),
    ).toEqual([]);
  });

  it('conservatively rejects numerical near-contact at a shared 3D corner', () => {
    // Strict wall-edge margins prevent true cross-wall overlap in this v1 topology.
    // This synthetic sub-micrometre gap exercises the explicit volume guard tolerance.
    const gap = WALL_FEATURE_CONTACT_EPSILON_MM / 2;
    const back = { ...niche(), leftMm: gap };
    const left = { ...niche(2), face: 'left' as const, leftMm: room.depthMm - 800 - gap };
    expect(codes([back])).toEqual([]);
    expect(codes([left])).toEqual([]);
    expect(codes([back, left])).toEqual(['volume-collision']);
    expect(codes([back, { ...left, topMm: 1500 }])).toEqual([]);
  });

  it('does not skip pair validation after an unrelated malformed row', () => {
    const issues = validateWallFeatures(room, [null, niche(), { ...niche(2), leftMm: 1000 }]);
    expect(issues.map((issue) => issue.code)).toEqual(['invalid-feature', 'touching-or-overlap']);
    expect(issues[1].path).toEqual(['wallFeatures', 2]);
  });
});

describe('room resize preflight', () => {
  it('keeps stored millimetres while deriving new niche UV and alcove floor height', () => {
    const scene = deepFreeze({ room: { ...room }, wallFeatures: [niche(), { ...alcove(2), leftMm: 1500 }] });
    const snapshot = JSON.stringify(scene);
    const nextRoom = { widthMm: 4000, depthMm: 5000, heightMm: 3200 };
    expect(validateWallFeatureResize(scene, nextRoom)).toEqual([]);
    const oldNiche = resolveWallFeature(room, scene.wallFeatures[0]);
    const newNiche = resolveWallFeature(nextRoom, scene.wallFeatures[0]);
    expect(newNiche.openingMm).toEqual(oldNiche.openingMm);
    expect(newNiche.heightMm).toBe(600);
    expect(newNiche.opening.left).toBe(0.1);
    expect(newNiche.worldBounds.min[1] - oldNiche.worldBounds.min[1]).toBe(400);
    expect(resolveWallFeature(nextRoom, scene.wallFeatures[1]).heightMm).toBe(2900);
    expect(resolveWallFeature(nextRoom, scene.wallFeatures[1]).worldBounds.min[1]).toBe(0);
    expect(JSON.stringify(scene)).toBe(snapshot);
  });

  it.each([
    { feature: niche(), nextRoom: { ...room, widthMm: 1200 } },
    { feature: { ...niche(), face: 'left' as const }, nextRoom: { ...room, depthMm: 1200 } },
    { feature: { ...niche(), heightMm: 1000 }, nextRoom: { ...room, heightMm: 1200 } },
    { feature: { ...alcove(), topMm: 1500 }, nextRoom: { ...room, heightMm: 1500 } },
  ])('rejects resizing through an opening without clamping: %j', ({ feature, nextRoom }) => {
    const scene = deepFreeze({ room: { ...room }, wallFeatures: [feature] });
    const snapshot = JSON.stringify(scene);
    expect(validateWallFeatureResize(scene, nextRoom).map((issue) => issue.code)).toContain('out-of-bounds');
    expect(JSON.stringify(scene)).toBe(snapshot);
  });

  it('does not legitimize invalid old data by enlarging the room', () => {
    const scene = { room, wallFeatures: [{ ...niche(), leftMm: 3000 }] };
    expect(validateWallFeatureResize(scene, { ...room, widthMm: 8000 }).map((issue) => issue.code)).toContain(
      'out-of-bounds',
    );
    expect(validateWallFeatureResize({ wallFeatures: [niche()] }, room).map((issue) => issue.code)).toEqual([
      'invalid-room',
    ]);
  });
});
