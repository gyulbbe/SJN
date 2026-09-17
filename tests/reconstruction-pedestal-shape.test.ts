import { createHash } from 'node:crypto';
import { Box3, Mesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createTemplateModel, disposeTemplateModel } from '../src/lib/reconstruction/templates';
import { fixtureReconstructionSchema } from '../src/lib/storage/validation';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';

const parameters = {
  kind: 'basin' as const,
  version: 2 as const,
  basinVariant: 'pedestal' as const,
  color: '#efefea',
  widthMm: 600,
  heightMm: 800,
  depthMm: 480,
};
const digest = (mesh: Mesh) => {
  const hash = createHash('sha256');
  for (const name of ['position', 'normal'])
    hash.update(Buffer.from(mesh.geometry.getAttribute(name).array.buffer));
  if (mesh.geometry.index) hash.update(Buffer.from(mesh.geometry.index.array.buffer));
  return hash.digest('hex');
};
const observation: SceneUnderstanding = {
  schemaVersion: 1,
  roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: ['No calibrated camera'] },
  relations: [],
  candidates: [
    {
      id: 'basin',
      kind: 'basin',
      mounting: 'floor',
      wall: 'back',
      basinStyle: 'pedestal',
      shape: 'rectangular',
      reflection: 'physical',
      bounds: { left: 0.2, top: 0.25, right: 0.5, bottom: 0.6 },
      evidence: ['Synthetic contract test; no pedestal cross-section observation'],
      uncertainty: [],
    },
  ],
};
const baseline: ReconstructionReview = {
  version: 2,
  analysis: 'partial',
  planes: [],
  candidates: [],
  warnings: [],
};
const manual = { basin: { face: 'floor' as const, u: 0.5, v: 0.5, baseHeightMm: 0 } };
const run = (overrides: Record<string, 'round' | 'rectangular'> = {}, positioned = true) =>
  buildCandidatePipeline(
    observation,
    baseline,
    DEFAULT_ROOM,
    { width: 500, height: 500 },
    positioned ? manual : {},
    observation,
    {},
    undefined,
    undefined,
    {},
    overrides,
  );

describe('independent user-confirmed pedestal cross-section', () => {
  it.each(['round', 'rectangular'] as const)(
    'keeps the historic cylinder for a %s bowl until explicitly selected',
    (basinShape) => {
      const legacy = createTemplateModel({ ...parameters, basinShape });
      const explicit = createTemplateModel({ ...parameters, basinShape, pedestalShape: 'round' });
      try {
        const before = legacy.getObjectByName('basin-pedestal') as Mesh;
        expect(before.geometry.type).toBe('CylinderGeometry');
        expect(explicit.children.map((mesh) => digest(mesh as Mesh))).toEqual(
          legacy.children.map((mesh) => digest(mesh as Mesh)),
        );
      } finally {
        disposeTemplateModel(legacy);
        disposeTemplateModel(explicit);
      }
    },
  );
  it.each(['round', 'rectangular'] as const)(
    'changes only the support geometry for a %s bowl at the same physical size',
    (basinShape) => {
      const old = createTemplateModel({ ...parameters, basinShape });
      const next = createTemplateModel({ ...parameters, basinShape, pedestalShape: 'rectangular' });
      try {
        const before = old.getObjectByName('basin-pedestal') as Mesh;
        const after = next.getObjectByName('basin-pedestal') as Mesh;
        expect(after.geometry.type).toBe('BoxGeometry');
        expect(after.userData.pedestalShape).toBe('rectangular');
        expect(digest(after)).not.toBe(digest(before));
        expect(
          next.children.filter((n) => n.name !== 'basin-pedestal').map((n) => digest(n as Mesh)),
        ).toEqual(old.children.filter((n) => n.name !== 'basin-pedestal').map((n) => digest(n as Mesh)));
        const bounds = new Box3().setFromObject(next),
          size = bounds.getSize(new Vector3());
        expect(size.x).toBeCloseTo(parameters.widthMm, 3);
        expect(size.y).toBeCloseTo(parameters.heightMm, 3);
        expect(size.z).toBeCloseTo(parameters.depthMm, 3);
        expect(bounds.min.y).toBeCloseTo(0, 3);
        const stem = new Box3().setFromObject(after).getSize(new Vector3());
        expect(stem.x).toBeGreaterThan(new Box3().setFromObject(before).getSize(new Vector3()).x);
      } finally {
        disposeTemplateModel(old);
        disposeTemplateModel(next);
      }
    },
  );
  it('does not manufacture a support on wall or vanity basins and does not change v1 geometry', () => {
    for (const basinVariant of ['wall', 'vanity'] as const) {
      const model = createTemplateModel({ ...parameters, basinVariant, pedestalShape: 'rectangular' });
      expect(model.getObjectByName('basin-pedestal')).toBeUndefined();
      disposeTemplateModel(model);
    }
    const legacy = createTemplateModel({ ...parameters, version: 1 });
    const supplied = createTemplateModel({ ...parameters, version: 1, pedestalShape: 'rectangular' });
    expect(supplied.children.map((n) => digest(n as Mesh))).toEqual(
      legacy.children.map((n) => digest(n as Mesh)),
    );
    disposeTemplateModel(legacy);
    disposeTemplateModel(supplied);
  });
  it('stores explicit shape/source, preserves absence, and rejects invalid enum values', () => {
    expect(fixtureReconstructionSchema.parse(parameters)).toEqual(parameters);
    const input = { ...parameters, pedestalShape: 'rectangular', provenance: { pedestalShape: 'user' } };
    expect(fixtureReconstructionSchema.parse(input)).toEqual(input);
    expect(fixtureReconstructionSchema.safeParse({ ...input, pedestalShape: 'hexagonal' }).success).toBe(
      false,
    );
  });
  it('keeps automatic observations and all placement/dimension values unchanged after a user shape choice', () => {
    const original = structuredClone(observation),
      unchanged = run(),
      revised = run({ basin: 'rectangular' });
    expect(unchanged.plans.basin?.pedestalShape).toBeUndefined();
    expect(revised.plans.basin).toMatchObject({
      pedestalShape: 'rectangular',
      provenance: { pedestalShape: 'user' },
    });
    for (const key of [
      'u',
      'v',
      'face',
      'widthMm',
      'heightMm',
      'depthMm',
      'baseHeightMm',
      'yawDegrees',
      'basinShape',
    ] as const)
      expect(revised.plans.basin?.[key]).toEqual(unchanged.plans.basin?.[key]);
    expect(revised.pipeline.automaticUnderstanding).toEqual(original);
    expect(revised.pipeline.understanding).toEqual(original);
    expect(observation).toEqual(original);
    expect(run().plans.basin).toEqual(unchanged.plans.basin);
  });
  it('does not resolve camera/position holds merely by choosing a cross-section', () => {
    const result = run({ basin: 'rectangular' }, false);
    expect(result.pipeline.camera.status).toBe('held');
    expect(result.plans.basin).toBeNull();
    expect(result.pipeline.userPedestalShapes).toEqual({ basin: 'rectangular' });
  });
  it('rejects fabricated values and missing targets instead of changing unrelated candidates', () => {
    expect(() => run({ missing: 'round' })).toThrow(/기둥/);
    expect(() => run({ basin: 'square' as 'round' })).toThrow(/기둥/);
  });
});
