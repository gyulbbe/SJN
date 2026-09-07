import { describe, it, expect } from 'vitest';
import { reconstructionAppearanceQuad } from '../src/lib/reconstruction/appearance';
import { homography, transformPoint } from '../src/lib/render/math';
import type { ReconstructionCandidate, ReconstructionPlane } from '../src/lib/reconstruction/types';
const candidate: ReconstructionCandidate = {
  id: 'window',
  kind: 'window',
  bounds: { left: 0.4, top: 0.2, right: 0.65, bottom: 0.5 },
  foot: { x: 0.5, y: 0.5 },
  color: '#ddddee',
  pixels: 1000,
  evidence: { semanticPixels: 1000, meanMargin: 8 },
  status: 'placed',
};
const plane: ReconstructionPlane = {
  id: 'wall',
  face: 'back',
  quad: [
    { x: 0.2, y: 0.1 },
    { x: 0.85, y: 0.1 },
    { x: 0.85, y: 0.85 },
    { x: 0.2, y: 0.85 },
  ],
  depthStart: 0,
  depthEnd: 1,
  confirmed: false,
  tile: { color: '#99bbbb', widthMm: 300, heightMm: 300, groutWidth: 2, estimated: true },
};
describe('observed frame crop', () => {
  it('keeps the detected extent when rectifying a frontal window', () => {
    const q = reconstructionAppearanceQuad(candidate, plane)!;
    expect(q[0].x).toBeCloseTo(0.4, 5);
    expect(q[0].y).toBeCloseTo(0.2, 5);
    expect(q[2].x).toBeCloseTo(0.65, 5);
    expect(q[2].y).toBeCloseTo(0.5, 5);
  });
  it('follows the source wall perspective before projecting to the common room', () => {
    const side = {
      ...plane,
      face: 'right' as const,
      quad: [
        { x: 0.5, y: 0.3 },
        { x: 0.95, y: 0.05 },
        { x: 0.95, y: 0.95 },
        { x: 0.5, y: 0.7 },
      ] as ReconstructionPlane['quad'],
    };
    const c = { ...candidate, bounds: { left: 0.64, top: 0.23, right: 0.83, bottom: 0.49 } };
    const q = reconstructionAppearanceQuad(c, side)!;
    expect(q).toBeDefined();
    const uv = q.map((p) => transformPoint(homography(side.quad), p));
    expect(uv[0].y).toBeCloseTo(uv[1].y, 6);
    expect(uv[2].y).toBeCloseTo(uv[3].y, 6);
    expect(Math.abs(q[0].y - q[1].y)).toBeGreaterThan(0.01);
  });
  it('never crops a floor appliance or an invalid reference plane', () => {
    expect(reconstructionAppearanceQuad({ ...candidate, kind: 'toilet' }, plane)).toBeUndefined();
    expect(
      reconstructionAppearanceQuad(candidate, {
        ...plane,
        quad: [plane.quad[0], plane.quad[0], plane.quad[0], plane.quad[0]],
      }),
    ).toBeUndefined();
  });
});
