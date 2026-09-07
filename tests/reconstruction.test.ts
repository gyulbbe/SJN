import { describe, expect, it } from 'vitest';
import { Vector3, Mesh } from 'three';
import {
  extractReconstructionCandidates,
  ADE_OBJECTS,
  representativeColor,
  representativeObjectColor,
} from '../src/lib/reconstruction/candidates';
import {
  mapReconstructionCandidate,
  periodicLineSpacing,
  analyzePlaneAppearance,
  remapReconstructionCandidates,
  reviewFromSegmentation,
} from '../src/lib/reconstruction/analysis';
import { projectReconstructionFixture } from '../src/lib/reconstruction/projection';
import { createTemplateModel } from '../src/lib/reconstruction/templates';
import { DEFAULT_ROOM, createRoomCamera, roomFacePoint, createRoomSurfaces } from '../src/lib/room-geometry';
import { DEFAULT_COLOR, EMPTY_MASK, type FixtureInstance, type Quad, type Scene } from '../src/lib/types';
import type {
  ReconstructionCandidate,
  ReconstructionPlane,
  ReconstructionReview,
} from '../src/lib/reconstruction/types';

const unit: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
function candidate(): ReconstructionCandidate {
  return {
    id: 'c',
    kind: 'toilet',
    bounds: { left: 0.3, top: 0.2, right: 0.5, bottom: 0.8 },
    foot: { x: 0.4, y: 0.8 },
    color: '#eeeeee',
    pixels: 200,
    evidence: { semanticPixels: 200, meanMargin: 3 },
    status: 'unplaced',
  };
}
function plane(face: ReconstructionPlane['face'] = 'floor'): ReconstructionPlane {
  return {
    id: face,
    face,
    quad: structuredClone(unit),
    depthStart: 0.1,
    depthEnd: 0.6,
    confirmed: false,
    tile: { color: '#999999', widthMm: 300, heightMm: 300, groutWidth: 0, estimated: true },
  };
}
function review(planes: ReconstructionPlane[]): ReconstructionReview {
  return { version: 1, analysis: 'complete', planes, warnings: [], candidates: [] };
}
function fixture(): FixtureInstance {
  return {
    id: 'f',
    name: '거울',
    materialVersionId: 'm',
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.1,
    height: 0.2,
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    roomPlacement: {
      face: 'left',
      u: 0.4,
      v: 0.4,
      scale: 1,
      widthMm: 600,
      heightMm: 800,
      imageAspect: 0.75,
      contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
    },
    reconstruction: {
      kind: 'mirror',
      version: 1,
      color: '#cccccc',
      widthMm: 600,
      heightMm: 800,
      depthMm: 25,
    },
  };
}

describe('compact reconstruction candidates', () => {
  it('uses the official background-inclusive ADE20K indices', () => {
    expect(ADE_OBJECTS).toEqual({
      9: 'window',
      15: 'door',
      28: 'mirror',
      38: 'bath',
      48: 'basin',
      66: 'toilet',
    });
  });
  it('separates disconnected objects of one kind and keeps bounded evidence without masks or logits', () => {
    const width = 64,
      height = 64,
      labels = new Uint8Array(width * height),
      rgba = new Uint8ClampedArray(width * height * 4).fill(220);
    const fill = (left: number, top: number, right: number, bottom: number, label: number) => {
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) labels[y * width + x] = label;
    };
    fill(3, 10, 12, 24, 66);
    fill(30, 12, 40, 27, 66);
    fill(0, 30, 10, 46, 15);
    fill(20, 2, 22, 4, 28);
    const values = new Float32Array(2 * 2 * 151);
    for (let i = 0; i < 4; i++) values[i * 151 + 66] = 8;
    const result = extractReconstructionCandidates({
      width,
      height,
      labels,
      rgba,
      logits: {
        values,
        width: 2,
        height: 2,
        channels: 151,
        cropWidth: 64,
        cropHeight: 64,
        paddedWidth: 64,
        paddedHeight: 64,
      },
    });
    expect(result).toHaveLength(3);
    expect(result.filter((c) => c.kind === 'toilet')).toHaveLength(2);
    expect(result.find((c) => c.kind === 'door')?.warning).toContain('잘린');
    expect(result.find((c) => c.kind === 'toilet')?.evidence.meanMargin).toBe(8);
    expect(
      result.every((c) => c.status === 'unplaced' && c.foot.x >= c.bounds.left && c.foot.x <= c.bounds.right),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Float32|logits|mask/);
  });
  it('ignores deep shadows and reflections when a representative colour has support', () => {
    const rgba = new Uint8ClampedArray(20 * 4);
    for (let i = 0; i < 20; i++)
      rgba.set(i < 12 ? [140, 130, 120, 255] : i < 16 ? [5, 5, 5, 255] : [255, 255, 255, 255], i * 4);
    expect(
      representativeColor(
        rgba,
        Array.from({ length: 20 }, (_, i) => i),
      ),
    ).toBe('#8c8278');
    expect(() =>
      extractReconstructionCandidates({
        width: 513,
        height: 1,
        labels: new Uint8Array(513),
        rgba: new Uint8ClampedArray(513 * 4),
      }),
    ).toThrow();
  });
});

it('estimates an object body from lit pixels without turning coloured ceramic white', () => {
  const rgba = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 100; i++)
    rgba.set(i < 65 ? [65, 90, 95, 255] : i < 96 ? [120, 180, 195, 255] : [255, 255, 255, 255], i * 4);
  expect(
    representativeObjectColor(
      rgba,
      Array.from({ length: 100 }, (_, i) => i),
    ),
  ).toBe('#78b4c3');
});

it('uses a finite neutral fallback for an empty object and preserves a reflection-only sample without inventing colour', () => {
  expect(representativeObjectColor(new Uint8ClampedArray(16), [0, 1, 2, 3])).toBe('#c0c0c0');
  expect(
    representativeObjectColor(
      new Uint8ClampedArray(80).fill(255),
      Array.from({ length: 20 }, (_, i) => i),
    ),
  ).toBe('#ffffff');
});

describe('source photograph calibration', () => {
  it('retains weak object evidence for manual review instead of fabricating an automatic placement', () => {
    const weak = candidate();
    weak.kind = 'door';
    weak.evidence.meanMargin = 1.1;
    expect(mapReconstructionCandidate(weak, review([plane('left')]))).toBeUndefined();
  });
  it('does not invent planes or tile grids when the image has no room evidence', () => {
    const masks = { width: 64, height: 64, wall: new Uint8Array(4096), floor: new Uint8Array(4096) };
    const result = reviewFromSegmentation(masks, new Uint8ClampedArray(4096 * 4).fill(190), DEFAULT_ROOM);
    expect(result.analysis).toBe('partial');
    expect(result.planes).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('중립색'))).toBe(true);
  });
  it('infers a grid only when both rectified axes have repeated grout evidence', () => {
    const rgba = new Uint8ClampedArray(160 * 160 * 4);
    for (let y = 0; y < 160; y++)
      for (let x = 0; x < 160; x++) {
        const light = x % 20 === 10 || y % 20 === 10 ? 150 : 190;
        rgba.set([light, light, light, 255], (y * 160 + x) * 4);
      }
    const result = analyzePlaneAppearance({
      plane: plane(),
      room: DEFAULT_ROOM,
      rgba,
      width: 160,
      height: 160,
      mask: new Uint8Array(160 * 160).fill(255),
    });
    expect(result.groutWidth).toBe(2);
    expect(result.widthMm).toBe(300);
    expect(result.heightMm).toBe(150);
    expect(result.estimated).toBe(true);
  });
  it('maps a photographed floor interval into part of the room depth instead of the whole room', () => {
    const result = mapReconstructionCandidate(candidate(), review([plane()]));
    expect(result?.face).toBe('floor');
    expect(result?.u).toBeCloseTo(0.4);
    expect(result?.v).toBeCloseTo(0.5);
    const invalid = candidate();
    invalid.foot.y = -1;
    expect(mapReconstructionCandidate(invalid, review([plane()]))).toBeUndefined();
  });
  it('keeps ambiguous wall objects unplaced and respects cropped wall height and side depth direction', () => {
    const c = candidate();
    c.kind = 'mirror';
    c.bounds = { left: 0.3, right: 0.5, top: 0.3, bottom: 0.5 };
    const p = plane('left');
    p.verticalStart = 0.25;
    p.verticalEnd = 1;
    const placement = mapReconstructionCandidate(c, review([p]));
    expect(placement?.u).toBeCloseTo(0.6);
    expect(placement?.v).toBeCloseTo(0.55);
    expect(mapReconstructionCandidate(c, review([p, plane('right')]))).toBeUndefined();
  });
  it('requires repeated consistent grout lines and leaves plain/noisy surfaces without fabricated grids', () => {
    const repeated = Array.from({ length: 160 }, (_, x) => (x % 20 === 10 ? 150 : 190));
    expect(periodicLineSpacing(repeated)).toBeCloseTo(0.125);
    expect(periodicLineSpacing(Array(160).fill(190))).toBeUndefined();
    expect(
      periodicLineSpacing(Array.from({ length: 160 }, (_, x) => ([12, 47, 90, 103].includes(x) ? 140 : 190))),
    ).toBeUndefined();
    const p = plane(),
      rgba = new Uint8ClampedArray(160 * 160 * 4);
    for (let i = 0; i < 160 * 160; i++) rgba.set([180, 170, 160, 255], i * 4);
    expect(
      analyzePlaneAppearance({
        plane: p,
        room: DEFAULT_ROOM,
        rgba,
        width: 160,
        height: 160,
        mask: new Uint8Array(160 * 160).fill(255),
      }),
    ).toEqual({ ...p.tile, color: '#b4aaa0', groutWidth: 0 });
  });
  it('remaps only linked candidates and preserves original source and unlinked products', () => {
    const f = fixture();
    f.reconstruction!.kind = 'toilet';
    f.roomPlacement!.face = 'floor';
    const second = { ...structuredClone(f), id: 'manual' };
    const scene: Scene = {
      room: { ...DEFAULT_ROOM },
      originalAssetId: 'o',
      previewAssetId: 'p',
      imageWidth: 1536,
      imageHeight: 1024,
      surfaces: createRoomSurfaces(DEFAULT_ROOM),
      fixtures: [f, second],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    };
    const r = review([plane()]);
    r.candidates = [{ ...candidate(), fixtureId: 'f', status: 'placed' }];
    const next = remapReconstructionCandidates(scene, r);
    expect(next.fixtures[0].roomPlacement?.v).toBeCloseTo(
      0.5 - (f.reconstruction!.depthMm * f.roomPlacement!.scale) / (2 * DEFAULT_ROOM.depthMm),
    );
    expect(next.fixtures[1]).toEqual(second);
    expect(scene.fixtures[0].roomPlacement?.v).toBe(0.4);
  });
});

describe('original reconstruction templates and planar projection', () => {
  it('builds distinct non-empty toilet, basin and bath models without external assets', () => {
    const geometries = ['toilet', 'basin', 'bath'].map((kind) =>
      createTemplateModel({
        kind: kind as 'toilet' | 'basin' | 'bath',
        color: '#eeeeee',
        widthMm: 600,
        heightMm: 800,
        depthMm: 500,
      }),
    );
    expect(geometries.every((group) => group.children.length >= 5)).toBe(true);
    expect(
      new Set(geometries.map((group) => group.children.map((part) => (part as Mesh).geometry.type).join(',')))
        .size,
    ).toBe(3);
  });
  it('projects all four mirror corners onto its selected wall and refreshes after movement and room resize', () => {
    const f = fixture();
    projectReconstructionFixture(DEFAULT_ROOM, f, 1.5);
    const original = structuredClone(f.projectedQuad);
    const origin = roomFacePoint(DEFAULT_ROOM, 'left', 0.4, 0.4),
      camera = createRoomCamera(DEFAULT_ROOM, 1.5);
    const topLeft = origin
      .clone()
      .add(new Vector3(0, 400, 300))
      .project(camera);
    expect(f.projectedQuad![0].x).toBeCloseTo((topLeft.x + 1) / 2, 12);
    expect(f.projectedQuad![0].y).toBeCloseTo((1 - topLeft.y) / 2, 12);
    f.roomPlacement!.u = 0.7;
    projectReconstructionFixture(DEFAULT_ROOM, f, 1.5);
    expect(f.projectedQuad).not.toEqual(original);
    const moved = structuredClone(f.projectedQuad);
    projectReconstructionFixture({ ...DEFAULT_ROOM, depthMm: 4000 }, f, 1.5);
    expect(f.projectedQuad).not.toEqual(moved);
    f.reconstruction!.kind = 'basin';
    projectReconstructionFixture(DEFAULT_ROOM, f, 1.5);
    expect(f.projectedQuad).toBeUndefined();
  });
});
