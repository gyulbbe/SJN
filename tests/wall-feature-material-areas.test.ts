import { describe, expect, it } from 'vitest';
import { BufferGeometry, Vector3 } from 'three';
import {
  calculateMaterialUsage,
  ensureMaterialUsage,
  setUsageArea,
  setUsageQuantity,
} from '../src/lib/material-usage';
import { roomSurfaceAreaM2, roomSurfaceAreas } from '../src/lib/room-surface-areas';
import { createQuote, quoteSourceSignature, resyncRoomQuote, roomAreaForSurfaces } from '../src/lib/quote';
import { buildWallFeaturePieces } from '../src/lib/room-viewer/wall-feature-geometry';
import { viewerSurfaceGeometry, viewerSurfacePatches } from '../src/lib/room-viewer/surfaces';
import {
  DEFAULT_COLOR,
  DEFAULT_TILE,
  EMPTY_MASK,
  type LegacyProjectDocument,
  type MaterialVersion,
  type Scene,
  type Surface,
} from '../src/lib/types';
import type { WallFeatureV1 } from '../src/lib/wall-features';

const id = (n: number) => 'bbbbbbbb-bbbb-4bbb-8bbb-' + n.toString(16).padStart(12, '0');
const niche = (n = 1): Extract<WallFeatureV1, { kind: 'closed-niche' }> => ({
  id: id(n),
  version: 1,
  kind: 'closed-niche',
  source: 'user',
  face: 'back',
  leftMm: 500,
  topMm: 900,
  widthMm: 800,
  heightMm: 1200,
  depthMm: 200,
});
const alcove = (n = 1): Extract<WallFeatureV1, { kind: 'floor-alcove' }> => ({
  id: id(n),
  version: 1,
  kind: 'floor-alcove',
  source: 'user',
  face: 'back',
  leftMm: 500,
  topMm: 900,
  widthMm: 800,
  depthMm: 200,
});
function surface(id: string, patch: Partial<Surface> = {}): Surface {
  return {
    id,
    name: id,
    kind: 'wall',
    roomFace: 'back',
    geometryMode: 'room',
    widthMm: 4000,
    heightMm: 3000,
    calibrated: false,
    materialVersionId: 'tile-v1',
    quad: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    mask: EMPTY_MASK(),
    tile: { ...DEFAULT_TILE },
    color: { ...DEFAULT_COLOR },
    ...patch,
  };
}
function scene(features: WallFeatureV1[] = [niche()], surfaces = [surface('back')]): Scene {
  return {
    originalAssetId: 'photo',
    previewAssetId: 'preview',
    imageWidth: 1200,
    imageHeight: 900,
    room: { kind: 'parametric', version: 1, widthMm: 4000, depthMm: 3000, heightMm: 3000 },
    surfaces,
    fixtures: [],
    wallFeatures: features,
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
function material(id = 'tile-v1'): MaterialVersion {
  return {
    id,
    materialId: id,
    version: 1,
    name: id,
    brand: '',
    code: '',
    category: 'tile',
    scope: 'personal',
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 600,
    depthMm: 10,
    usage: 'both',
    installation: 'floor',
    coverAssetId: 'cover',
    imageAssetIds: [],
    textureAssetIds: [],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#fff',
    defaultPattern: 'grid',
    createdAt: '2026-09-15T00:00:00Z',
    pricing: { unit: 'm2', unitPrice: 10000, boxCoverageM2: null, piecesPerBox: null, wastePercent: 0 },
  };
}
function project(value: Scene): LegacyProjectDocument {
  return {
    id: 'project',
    name: 'Authored area test',
    ownerId: 'local',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 0,
    scene: value,
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    createdAt: '2026-09-15T00:00:00Z',
    updatedAt: '2026-09-15T00:00:00Z',
  };
}
const materials = { 'tile-v1': material(), 'tile-v2': material('tile-v2') };

function triangleArea(geometry: BufferGeometry): number {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex()!;
  let area = 0;
  for (let offset = 0; offset < index.count; offset += 3) {
    const a = new Vector3().fromBufferAttribute(position, index.getX(offset));
    const b = new Vector3().fromBufferAttribute(position, index.getX(offset + 1));
    const c = new Vector3().fromBufferAttribute(position, index.getX(offset + 2));
    area += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return area / 1_000_000;
}
function actualGeometryAreas(value: Scene): Map<string, number> {
  const { patches } = viewerSurfacePatches(value);
  const shapes = buildWallFeaturePieces(value.room!, patches, value.wallFeatures!);
  const totals = new Map<string, number>();
  const add = (id: string | undefined, area: number) => {
    if (id) totals.set(id, (totals.get(id) ?? 0) + area);
  };
  try {
    for (const piece of shapes.pieces) add(piece.sourceSurfaceId, triangleArea(piece.geometry));
    for (const patch of patches)
      if (!shapes.affectedFaces.has(patch.face)) {
        const geometry = viewerSurfaceGeometry(value.room!, patch);
        try {
          add(patch.surface?.id, triangleArea(geometry));
        } finally {
          geometry.dispose();
        }
      }
  } finally {
    shapes.dispose();
  }
  return totals;
}

describe('authored wall feature surface areas', () => {
  it('replaces the opening with an equal rear and adds all four reveals', () => {
    const value = scene();
    expect(roomSurfaceAreaM2(value, 'back')).toBeCloseTo(12 + 2 * 0.2 * (0.8 + 1.2), 12);
    expect(calculateMaterialUsage(value, materials).rows[0]).toMatchObject({
      areaM2: 12.8,
      quantity: 12.8,
      amount: 128000,
    });
    expect(roomAreaForSurfaces(value, ['back'], 'tile-v1')).toBe(12.8);
  });

  it('adds the floor extension to the floor material, without a second bottom reveal', () => {
    const value = scene(
      [alcove()],
      [surface('back'), surface('floor', { kind: 'floor', roomFace: 'floor', materialVersionId: 'tile-v2' })],
    );
    expect(roomSurfaceAreaM2(value, 'back')).toBe(13);
    expect(roomSurfaceAreaM2(value, 'floor')).toBe(12.16);
    expect(roomAreaForSurfaces(value, ['back'])).toBe(13);
    expect(roomAreaForSurfaces(value, ['floor'])).toBe(12.16);
    expect(calculateMaterialUsage(value, materials).rows.map((row) => row.areaM2)).toEqual([13, 12.16]);
  });

  it('splits reveal heights across child bands before the remaining parent', () => {
    const value = scene(
      [niche()],
      [
        surface('parent'),
        surface('lower', { reconstructionBand: { from: 0.5, to: 1 }, materialVersionId: 'tile-v2' }),
      ],
    );
    expect(roomSurfaceAreaM2(value, 'parent')).toBeCloseTo(6.4, 12);
    expect(roomSurfaceAreaM2(value, 'lower')).toBeCloseTo(6.4, 12);
    expect(roomAreaForSurfaces(value, ['parent', 'lower'])).toBeCloseTo(12.8, 12);
    expect(roomAreaForSurfaces(value, ['parent', 'lower'], 'tile-v1')).toBeNull();
  });

  it.each([
    { topMm: 1500, heightMm: 600, parent: 6, lower: 6.56 },
    { topMm: 900, heightMm: 600, parent: 6.56, lower: 6 },
  ])('assigns horizontal reveals into the opening at exact band boundaries: %j', (example) => {
    const value = scene(
      [{ ...niche(), topMm: example.topMm, heightMm: example.heightMm }],
      [surface('parent'), surface('lower', { reconstructionBand: { from: 0.5, to: 1 } })],
    );
    expect(roomSurfaceAreaM2(value, 'parent')).toBeCloseTo(example.parent, 12);
    expect(roomSurfaceAreaM2(value, 'lower')).toBeCloseTo(example.lower, 12);
  });

  it('does not bill the parent for an unassigned child band', () => {
    const value = scene(
      [niche()],
      [
        surface('parent'),
        surface('unassigned', { reconstructionBand: { from: 0.5, to: 1 }, materialVersionId: undefined }),
      ],
    );
    expect(calculateMaterialUsage(value, materials).rows[0].areaM2).toBeCloseTo(6.4, 12);
    expect(roomSurfaceAreaM2(value, 'unassigned')).toBeCloseTo(6.4, 12);
  });

  it('sums multiple separated niches with independent depths', () => {
    const value = scene([niche(), { ...niche(2), leftMm: 2000, depthMm: 300 }]);
    expect(roomSurfaceAreaM2(value, 'back')).toBe(14);
  });

  it.each(['left', 'back', 'right'] as const)(
    'matches actual CPU triangle areas for both feature kinds on %s',
    (face) => {
      for (const feature of [
        { ...niche(), face },
        { ...alcove(), face },
      ]) {
        const value = scene(
          [feature],
          [
            surface('parent', { roomFace: face }),
            surface('middle', { roomFace: face, reconstructionBand: { from: 0.4, to: 0.6 } }),
            surface('floor', { kind: 'floor', roomFace: 'floor' }),
          ],
        );
        const actual = actualGeometryAreas(value);
        for (const [id, entry] of roomSurfaceAreas(value))
          expect(entry.areaM2).toBeCloseTo(actual.get(id)!, 9);
      }
    },
  );

  it('matches geometry with multiple nonoverlapping niches crossing independent bands', () => {
    const value = scene(
      [niche(), { ...niche(2), leftMm: 2200, topMm: 300, heightMm: 2400, depthMm: 300 }],
      [
        surface('parent'),
        surface('upper', { reconstructionBand: { from: 0.1, to: 0.3 } }),
        surface('lower', { reconstructionBand: { from: 0.6, to: 0.9 } }),
      ],
    );
    const actual = actualGeometryAreas(value);
    for (const [id, entry] of roomSurfaceAreas(value)) expect(entry.areaM2).toBeCloseTo(actual.get(id)!, 9);
  });

  it('retains gaps as unassigned geometry rather than billing another band', () => {
    const value = scene([niche()], [surface('lower', { reconstructionBand: { from: 0.5, to: 1 } })]);
    expect(roomSurfaceAreaM2(value, 'lower')).toBeCloseTo(6.4, 12);
  });

  it.each([
    [surface('parent'), surface('another-full')],
    [
      surface('a', { reconstructionBand: { from: 0, to: 0.6 } }),
      surface('b', { reconstructionBand: { from: 0.5, to: 1 } }),
    ],
    [surface('bad', { reconstructionBand: { from: 1, to: 0 } })],
    [surface('bad', { geometryMode: 'manual' })],
    [surface('same'), surface('same', { roomFace: 'left' })],
  ])('does not report an automatic area for ambiguous surfaces: %j', (...surfaces) => {
    const value = scene([niche()], surfaces);
    expect(calculateMaterialUsage(value, materials).rows.every((row) => row.areaM2 === null)).toBe(true);
    expect(
      roomAreaForSurfaces(
        value,
        surfaces.map((surface) => surface.id),
      ),
    ).toBeNull();
  });

  it('leaves photo masks unresolved rather than estimating their physical net area', () => {
    const masked = surface('back');
    masked.mask.holes = [
      [
        { x: 0, y: 0 },
        { x: 0.2, y: 0 },
        { x: 0.2, y: 0.2 },
      ],
    ];
    const value = scene([niche()], [masked]);
    expect(roomSurfaceAreaM2(value, 'back')).toBeUndefined();
    expect(roomSurfaceAreas(value).get('back')?.issue).toContain('마스크');
    expect(roomAreaForSurfaces(value, ['back'])).toBeNull();
    expect(calculateMaterialUsage(value, materials).complete).toBe(false);
  });

  it('refuses malformed structures instead of silently using the old flat wall', () => {
    const value = scene([{ ...niche(), depthMm: 0 }]);
    expect(roomSurfaceAreaM2(value, 'back')).toBeUndefined();
    expect(roomAreaForSurfaces(value, ['back'])).toBeNull();
    expect(calculateMaterialUsage(value, materials).rows[0].areaM2).toBeNull();
  });

  it('does not mutate source scenes while computing derived areas', () => {
    const value = scene(
      [alcove()],
      [surface('back'), surface('floor', { roomFace: 'floor', kind: 'floor' })],
    );
    const before = JSON.stringify(value);
    roomSurfaceAreas(value);
    calculateMaterialUsage(value, materials);
    roomAreaForSurfaces(value, ['back', 'floor']);
    expect(JSON.stringify(value)).toBe(before);
  });
});

describe('commercial overrides and legacy compatibility', () => {
  it('preserves explicit area and purchase quantity while exposing the new room area', () => {
    const value = scene();
    let state = ensureMaterialUsage(value, materials);
    state = setUsageArea(state, 'back', 7);
    state = setUsageQuantity(state, calculateMaterialUsage(value, materials, state).rows[0], 9);
    const before = JSON.stringify(state);
    const changed = { ...value, wallFeatures: [{ ...niche(), depthMm: 400 }] };
    const row = calculateMaterialUsage(changed, materials, state).rows[0];
    expect(row).toMatchObject({ areaM2: 7, quantity: 9, quantityMode: 'manual', amount: 90000 });
    expect(row.areas[0].roomAreaM2).toBe(13.6);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('updates room-linked quote copies without changing saved originals or manual commercial fields', () => {
    const value = scene();
    const quote = createQuote(project(value), materials);
    quote.lines[0].quantityMode = 'manual';
    quote.lines[0].quantity = 10;
    quote.lines[0].quantityConfirmed = true;
    quote.lines[0].note = 'explicit order';
    const before = JSON.stringify(quote);
    const changed = { ...value, wallFeatures: [{ ...niche(), depthMm: 400 }] };
    const next = resyncRoomQuote(quote, changed);
    expect(next.lines[0]).toMatchObject({
      areaM2: 13.6,
      quantity: 10,
      quantityConfirmed: true,
      note: 'explicit order',
    });
    expect(next.sourceSignature).toBe(quote.sourceSignature);
    expect(JSON.stringify(quote)).toBe(before);
    quote.lines[0].areaSource = 'manual';
    quote.lines[0].areaM2 = 8;
    expect(resyncRoomQuote(quote, changed)).toBe(quote);
  });

  it('requires re-confirmation only when an automatic quote quantity changes', () => {
    const value = scene();
    const quote = createQuote(project(value), materials);
    quote.lines[0].quantityConfirmed = true;
    const next = resyncRoomQuote(quote, { ...value, wallFeatures: [{ ...niche(), depthMm: 400 }] });
    expect(next.lines[0].areaM2).toBe(13.6);
    expect(next.lines[0].quantityConfirmed).toBe(false);
    expect(quote.lines[0].quantityConfirmed).toBe(true);
  });

  it('records structure changes in source signatures but keeps old empty-scene signatures exact', () => {
    const value = scene([]);
    const without = structuredClone(value);
    delete without.wallFeatures;
    expect(quoteSourceSignature(value)).toBe(quoteSourceSignature(without));
    expect(calculateMaterialUsage(value, materials)).toEqual(calculateMaterialUsage(without, materials));
    expect(roomAreaForSurfaces(value, ['back'])).toBe(roomAreaForSurfaces(without, ['back']));
    const structured = scene();
    expect(quoteSourceSignature(structured)).not.toBe(quoteSourceSignature(value));
    expect(quoteSourceSignature({ ...structured, wallFeatures: [{ ...niche(), depthMm: 400 }] })).not.toBe(
      quoteSourceSignature(structured),
    );
    const pair = scene([niche(), { ...niche(2), leftMm: 2200 }]);
    expect(quoteSourceSignature(pair)).toBe(
      quoteSourceSignature({ ...pair, wallFeatures: [...pair.wallFeatures!].reverse() }),
    );
  });

  it('rejects nonexistent, repeated or mismatched quote source references', () => {
    const value = scene();
    expect(roomAreaForSurfaces(value, ['missing'])).toBeNull();
    expect(roomAreaForSurfaces(value, ['back', 'back'])).toBeNull();
    expect(roomAreaForSurfaces(value, ['back'], 'different-version')).toBeNull();
    expect(roomSurfaceAreaM2(value, 'missing')).toBeUndefined();
  });
});
