import { describe, expect, it } from 'vitest';
import { Box3, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { createTemplateModel } from '../src/lib/reconstruction/templates';
import {
  fitReconstructionFootprint,
  frontContactToCentre,
  orientationAngle,
  projectReconstructionFixture,
  reconstructionVolumeProjection,
} from '../src/lib/reconstruction/projection';
import { estimateCandidateFixture } from '../src/lib/reconstruction';
import { DEFAULT_ROOM, createRoomCamera, roomFacePoint } from '../src/lib/room-geometry';
import { DEFAULT_COLOR, EMPTY_MASK, type FixtureInstance, type Quad } from '../src/lib/types';
import type { ReconstructionCandidate, ReconstructionReview } from '../src/lib/reconstruction/types';

const quad: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
const fixture = (): FixtureInstance => ({
  id: 'vanity',
  name: '세면대 하부장',
  materialVersionId: 'v',
  viewIndex: 0,
  position: { x: 0, y: 0 },
  width: 0.1,
  height: 0.1,
  rotation: 0,
  anchor: { x: 0.55, y: 0.83 },
  locked: false,
  shadow: { x: 0, y: 0, opacity: 0.16, blur: 0.008, scale: 1 },
  occlusion: EMPTY_MASK(),
  color: { ...DEFAULT_COLOR },
  roomPlacement: {
    face: 'floor',
    u: 0,
    v: 1,
    widthMm: 1200,
    heightMm: 850,
    scale: 1,
    imageAspect: 1.2,
    contentBounds: { left: 0.03, top: 0.02, right: 0.96, bottom: 0.97 },
  },
  reconstruction: {
    kind: 'vanity',
    widthMm: 1200,
    heightMm: 850,
    depthMm: 550,
    color: '#80a9a9',
    orientation: 'left',
    version: 1,
  },
});

describe('reconstruction model dimensions and floor contact', () => {
  it('puts each complete silhouette on y=0 within exactly its nominal W/H/D box', () => {
    for (const kind of ['toilet', 'basin', 'vanity', 'bath'] as const) {
      const model = createTemplateModel({
        kind,
        color: '#92afad',
        widthMm: 1200,
        heightMm: 850,
        depthMm: 600,
      });
      const bounds = new Box3().setFromObject(model),
        size = bounds.getSize(new Vector3());
      expect(bounds.min.y).toBeCloseTo(0, 3);
      expect(bounds.min.x).toBeCloseTo(-600, 3);
      expect(bounds.max.x).toBeCloseTo(600, 3);
      expect(bounds.min.z).toBeCloseTo(-300, 3);
      expect(bounds.max.z).toBeCloseTo(300, 3);
      expect(size.y).toBeCloseTo(850, 3);
      model.traverse((node) => {
        if (node instanceof Mesh) {
          node.geometry.dispose();
          for (const m of Array.isArray(node.material) ? node.material : [node.material]) m.dispose();
        }
      });
    }
  });
  it('has separate cabinet and white ceramic materials and two basins for a wide vanity', () => {
    const model = createTemplateModel({
      kind: 'vanity',
      color: '#71a5aa',
      widthMm: 1400,
      heightMm: 850,
      depthMm: 550,
    });
    const bowls = model.children.filter(
      (node) => node instanceof Mesh && node.geometry.type === 'LatheGeometry',
    );
    expect(bowls).toHaveLength(2);
    const colors = new Set(
      model.children
        .map((node) => (node as Mesh).material)
        .flat()
        .map((material) => (material instanceof MeshStandardMaterial ? material.color.getHexString() : '')),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
  it('keeps every oriented footprint inside the room even at corners and oversized input', () => {
    for (const orientation of ['back', 'left', 'right'] as const)
      for (const u of [0, 0.5, 1])
        for (const v of [0, 0.5, 1]) {
          const input = {
            face: 'floor' as const,
            u,
            v,
            widthMm: 2800,
            heightMm: 850,
            depthMm: 650,
            orientation,
          };
          const fit = fitReconstructionFootprint(DEFAULT_ROOM, input);
          const width = (orientation === 'back' ? input.widthMm : input.depthMm) * fit.scale;
          const depth = (orientation === 'back' ? input.depthMm : input.widthMm) * fit.scale;
          expect(fit.u * DEFAULT_ROOM.widthMm - width / 2).toBeGreaterThanOrEqual(-0.001);
          expect(fit.u * DEFAULT_ROOM.widthMm + width / 2).toBeLessThanOrEqual(DEFAULT_ROOM.widthMm + 0.001);
          expect(fit.v * DEFAULT_ROOM.depthMm - depth / 2).toBeGreaterThanOrEqual(-0.001);
          expect(fit.v * DEFAULT_ROOM.depthMm + depth / 2).toBeLessThanOrEqual(DEFAULT_ROOM.depthMm + 0.001);
        }
  });
  it('converts a visible front contact to the footprint centre once, in the installation direction', () => {
    const source = { face: 'floor' as const, u: 0.5, v: 0.5 };
    expect(frontContactToCentre(DEFAULT_ROOM, source, 480, 'back').v).toBeCloseTo(0.4);
    expect(frontContactToCentre(DEFAULT_ROOM, source, 480, 'left').u).toBeCloseTo(0.4);
    expect(frontContactToCentre(DEFAULT_ROOM, source, 480, 'right').u).toBeCloseTo(0.6);
    expect(frontContactToCentre(DEFAULT_ROOM, { ...source, face: 'back' }, 480, 'back')).toEqual({
      ...source,
      face: 'back',
    });
    expect(new Vector3(0, 0, 1).applyAxisAngle(new Vector3(0, 1, 0), orientationAngle('left')).x).toBeCloseTo(
      1,
    );
  });
  it('uses the projected volume envelope and keeps the stored ground anchor instead of fitting a flat W/H image', () => {
    const product = fixture();
    projectReconstructionFixture(DEFAULT_ROOM, product, 1.5);
    const placement = product.roomPlacement!;
    const origin = roomFacePoint(DEFAULT_ROOM, 'floor', placement.u, placement.v).project(
      createRoomCamera(DEFAULT_ROOM, 1.5),
    );
    expect(product.position).toEqual({ x: (origin.x + 1) / 2, y: (1 - origin.y) / 2 });
    expect(product.anchor).toEqual({ x: 0.55, y: 0.83 });
    const projected = reconstructionVolumeProjection(
      DEFAULT_ROOM,
      { ...placement, depthMm: 550, orientation: 'left' },
      1.5,
    );
    expect(product.width).toBeCloseTo(projected.right - projected.left);
    expect(product.height).toBeCloseTo(projected.bottom - projected.top);
    expect(product.projectedQuad).toBeUndefined();
    expect(placement.u).toBeGreaterThan(0);
    expect(placement.v).toBeLessThan(1);
  });
  it('derives observed object dimensions from source bounds rather than always returning category defaults', () => {
    const review: ReconstructionReview = {
      version: 1,
      analysis: 'complete',
      warnings: [],
      candidates: [],
      planes: [
        {
          id: 'back',
          face: 'back',
          quad,
          depthStart: 0,
          depthEnd: 1,
          confirmed: true,
          tile: { color: '#888888', widthMm: 300, heightMm: 300, groutWidth: 0, estimated: true },
        },
      ],
    };
    const candidate: ReconstructionCandidate = {
      id: 'object',
      kind: 'vanity',
      bounds: { left: 0.2, right: 0.5, top: 0.35, bottom: 0.7 },
      foot: { x: 0.35, y: 0.7 },
      color: '#80aaaa',
      pixels: 5000,
      evidence: { semanticPixels: 5000, meanMargin: 4 },
      status: 'unplaced',
    };
    const small = estimateCandidateFixture(candidate, review, DEFAULT_ROOM, {
      face: 'floor',
      u: 0.4,
      v: 0.6,
    });
    const large = estimateCandidateFixture(
      { ...candidate, bounds: { ...candidate.bounds, right: 0.9 } },
      review,
      DEFAULT_ROOM,
      { face: 'floor', u: 0.6, v: 0.6 },
    );
    expect(small.widthMm).toBe(720);
    expect(large.widthMm).toBe(1680);
    expect(small.heightMm).toBe(840);
    expect(large.orientation).toBe('back');
  });
});
