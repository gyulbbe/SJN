import { describe, expect, it } from 'vitest';
import { Box3, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { createTemplateModel, disposeTemplateModel } from '../src/lib/reconstruction/templates';
import {
  fitReconstructionFootprint,
  reconstructionModelTransform,
  reconstructionVolumeProjection,
} from '../src/lib/reconstruction/projection';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';

describe('v2 standard geometry and physical mounting', () => {
  it('uses the wall rear-bottom anchor without intersecting the installation wall', () => {
    for (const face of ['back', 'left', 'right'] as const) {
      const transform = reconstructionModelTransform(DEFAULT_ROOM, {
        version: 2,
        face,
        u: 0.5,
        v: 0.3,
        baseHeightMm: 650,
        widthMm: 600,
        heightMm: 180,
        depthMm: 450,
      });
      const rear = new Vector3(0, 0, -225)
        .applyAxisAngle(new Vector3(0, 1, 0), transform.angle)
        .add(transform.origin);
      expect(rear.y).toBe(650);
      if (face === 'back') expect(rear.z).toBeCloseTo(0);
      else expect(rear.x).toBeCloseTo(((face === 'left' ? -1 : 1) * DEFAULT_ROOM.widthMm) / 2);
      const projection = reconstructionVolumeProjection(
        DEFAULT_ROOM,
        {
          version: 2,
          face,
          u: 0.5,
          v: 0.3,
          baseHeightMm: 650,
          widthMm: 600,
          heightMm: 180,
          depthMm: 450,
        },
        1.5,
      );
      expect(projection.bottom).toBeGreaterThan(projection.top);
    }
  });
  it('fits a rotated partition footprint and preserves its installation height', () => {
    const placement = {
      version: 2 as const,
      face: 'floor' as const,
      u: 0,
      v: 1,
      widthMm: 1200,
      heightMm: 1800,
      depthMm: 8,
      baseHeightMm: 500,
      yawDegrees: 37,
    };
    const fitted = fitReconstructionFootprint(DEFAULT_ROOM, placement);
    const transform = reconstructionModelTransform(DEFAULT_ROOM, { ...placement, ...fitted });
    expect(transform.origin.y).toBe(500);
    expect(transform.angle).toBeCloseTo((37 * Math.PI) / 180);
    expect(fitted.u).toBeGreaterThan(0);
    expect(fitted.v).toBeLessThan(1);
  });
  it('builds nonempty exact-size standard silhouettes, including a wall basin without a pedestal', () => {
    for (const kind of [
      'basin',
      'glassPartition',
      'mirrorCabinet',
      'wallShelf',
      'mirror',
      'window',
      'door',
    ] as const) {
      const model = createTemplateModel({
        kind,
        version: 2,
        color: '#dfdfdf',
        widthMm: 600,
        heightMm: 180,
        depthMm: 100,
        basinVariant: 'wall',
        basinShape: 'rectangular',
      });
      const bounds = new Box3().setFromObject(model),
        size = bounds.getSize(new Vector3());
      expect(size.x).toBeCloseTo(600, 3);
      expect(size.y).toBeCloseTo(180, 3);
      expect(size.z).toBeCloseTo(100, 3);
      expect(bounds.min.y).toBeCloseTo(0, 3);
      expect(model.children.length).toBeGreaterThan(0);
      if (kind === 'basin')
        expect(
          model.children.filter((n) => n instanceof Mesh && n.geometry.type === 'CylinderGeometry'),
        ).toHaveLength(1);
      disposeTemplateModel(model);
    }
  });
  it('makes the glass transparent without writing depth and never attaches source images to mirrors/windows', () => {
    for (const kind of ['glassPartition', 'mirror', 'mirrorCabinet', 'window'] as const) {
      const model = createTemplateModel({
        kind,
        version: 2,
        color: '#eeeeee',
        widthMm: 800,
        heightMm: 1000,
        depthMm: 20,
        opacity: 0.24,
      });
      const materials = model.children.flatMap((n) => {
        const material = (n as Mesh).material;
        return Array.isArray(material) ? material : [material];
      }) as MeshStandardMaterial[];
      expect(materials.every((m) => !m.map)).toBe(true);
      if (kind === 'glassPartition')
        expect(materials.some((m) => m.transparent && !m.depthWrite && m.opacity === 0.24)).toBe(true);
      disposeTemplateModel(model);
    }
  });
});
