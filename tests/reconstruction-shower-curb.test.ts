import { describe, expect, it } from 'vitest';
import { Box3, Group, Mesh, MeshStandardMaterial, Vector3, type WebGLRenderer, Texture } from 'three';
import { StandardModelRenderer, type StandardFixturePass } from '../src/lib/render/standard-model-render';
import type { FixtureInstance } from '../src/lib/types';
import { createTemplateModel, disposeTemplateModel } from '../src/lib/reconstruction/templates';
import { defaultShowerCurb, reconstructionLocalBoxes } from '../src/lib/reconstruction/raised-glass-support';
import { validateSourceFixture } from '../src/lib/reconstruction/source-camera';
import { reconstructionVolumeProjection } from '../src/lib/reconstruction/projection';
import { fixtureReconstructionSchema } from '../src/lib/storage/validation';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { resolveManualDraft } from '../src/lib/reconstruction/lab-manual-placement';
import type { RaisedGlassSupport } from '../src/lib/reconstruction/types';
const support: RaisedGlassSupport = {
  kind: 'shower-curb',
  heightMm: 100,
  provenance: { kind: 'user', height: 'user' },
  curb: defaultShowerCurb(800, 8),
};
const shape = {
  kind: 'glassPartition' as const,
  version: 2 as const,
  color: '#bbccdd',
  widthMm: 800,
  heightMm: 1800,
  depthMm: 8,
  baseHeightMm: 100,
  face: 'floor' as const,
  u: 0.5,
  v: 0.5,
  yawDegrees: 0,
  support,
};
const fingerprint = (mesh: Mesh) => Array.from(mesh.geometry.getAttribute('position').array);
describe('explicit shower-curb geometry', () => {
  it('adds a grounded upstand and tile cap without changing any glass vertices or normalization', () => {
    const old = createTemplateModel({ ...shape, support: undefined }),
      next = createTemplateModel(shape);
    try {
      expect(next.children.slice(0, old.children.length).map((n) => fingerprint(n as Mesh))).toEqual(
        old.children.map((n) => fingerprint(n as Mesh)),
      );
      expect(next.children.length).toBe(old.children.length + 2);
      const body = next.getObjectByName('shower-curb-body')!,
        cap = next.getObjectByName('shower-curb-cap')!;
      const bb = new Box3().setFromObject(body),
        cb = new Box3().setFromObject(cap);
      expect(bb.min.y).toBeCloseTo(-100, 5);
      expect(cb.max.y).toBeCloseTo(0, 5);
      expect(bb.max.y).toBeCloseTo(cb.min.y, 5);
      expect(cb.getSize(new Vector3()).toArray()).toEqual([840, 12, 120]);
      for (const n of [body, cap])
        expect(((n as Mesh).material as MeshStandardMaterial).transparent).toBe(false);
      const size = new Box3().setFromObject(next).getSize(new Vector3());
      expect(size.toArray()).toEqual([840, 1900, 120]);
    } finally {
      disposeTemplateModel(old);
      disposeTemplateModel(next);
    }
  });
  it.each(['shower-curb', 'bath-rim'] as const)('retains the old height-only %s geometry', (kind) => {
    const m = createTemplateModel({ ...shape, support: { ...support, kind, curb: undefined } });
    expect(m.getObjectByName('shower-curb-body')).toBeUndefined();
    expect(new Box3().setFromObject(m).getSize(new Vector3()).toArray()).toEqual([800, 1800, 8]);
    disposeTemplateModel(m);
  });
  it('projects and validates both physical components, including rotated curb corners', () => {
    const full = reconstructionVolumeProjection(DEFAULT_ROOM, shape, 1.5);
    const glass = reconstructionVolumeProjection(
      DEFAULT_ROOM,
      { ...shape, support: { ...support, curb: undefined } },
      1.5,
    );
    expect(full.bottom).toBeGreaterThan(glass.bottom);
    expect(full.left).toBeLessThan(glass.left);
    const check = validateSourceFixture(DEFAULT_ROOM, undefined, shape);
    expect(check.valid).toBe(true);
    expect(check.worldBoundsMm?.min[1]).toBe(0);
    expect(check.worldBoundsMm?.max[1]).toBe(1900);
    const edge = { ...shape, yawDegrees: 90, u: 50 / 2400 };
    expect(
      validateSourceFixture(DEFAULT_ROOM, undefined, { ...edge, support: { ...support, curb: undefined } })
        .valid,
    ).toBe(true);
    expect(validateSourceFixture(DEFAULT_ROOM, undefined, edge).valid).toBe(false);
    expect(reconstructionLocalBoxes(shape)).toHaveLength(2);
  });
  it.each([{ widthMm: 790 }, { depthMm: 7 }, { widthMm: 0 }, { depthMm: Infinity }])(
    'rejects an undersized/invalid curb without widening it',
    (patch) => {
      const invalid = { ...shape, support: { ...support, curb: { ...support.curb!, ...patch } } };
      expect(validateSourceFixture(DEFAULT_ROOM, undefined, invalid).valid).toBe(false);
      expect(fixtureReconstructionSchema.safeParse(invalid).success).toBe(false);
    },
  );
  it('rejects a fake curb attached to a bath-rim and a scale that would float/sink the curb', () => {
    expect(
      validateSourceFixture(DEFAULT_ROOM, undefined, { ...shape, support: { ...support, kind: 'bath-rim' } })
        .valid,
    ).toBe(false);
    expect(validateSourceFixture(DEFAULT_ROOM, undefined, { ...shape, scale: 0.8 }).valid).toBe(false);
    expect(
      fixtureReconstructionSchema.safeParse({
        ...shape,
        support: { ...support, curb: { ...support.curb!, provenance: { width: 'model', depth: 'model' } } },
      }).success,
    ).toBe(false);
  });
  it('round trips default and user dimensions separately from unchanged glass dimensions', () => {
    const p = resolveManualDraft(
      {
        enabled: true,
        face: 'floor',
        u: '.5',
        v: '.5',
        baseHeightMm: '100',
        widthMm: '',
        heightMm: '',
        depthMm: '',
        yawDegrees: '0',
        support: {
          kind: 'shower-curb',
          heightMm: '100',
          curb: { widthMm: '900', depthMm: '120', widthSource: 'user', depthSource: 'default' },
        },
      },
      DEFAULT_ROOM,
      8,
    );
    expect(p.widthMm).toBeUndefined();
    expect(p.support?.curb).toEqual({
      widthMm: 900,
      depthMm: 120,
      provenance: { width: 'user', depth: 'default' },
    });
    expect(fixtureReconstructionSchema.parse({ ...shape, ...p }).support).toEqual(p.support);
  });
});

it('rebuilds and disposes cached curb geometry when width, depth or height changes', () => {
  // No GPU mock output: this checks the real geometry cache and material disposal contract.
  const renderer = new StandardModelRenderer({
    capabilities: { maxSamples: 0 },
    extensions: { has: () => false },
  } as unknown as WebGLRenderer);
  const cache = renderer as unknown as { entry(pass: StandardFixturePass): { model: Group } };
  const fixture = {
    reconstruction: structuredClone(shape),
    roomPlacement: { face: 'floor' },
  } as unknown as FixtureInstance;
  const pass = { fixture, standardKey: 'curb', occlusion: new Texture() };
  let entry = cache.entry(pass);
  expect(cache.entry(pass).model).toBe(entry.model);
  for (const patch of [{ widthMm: 1000 }, { depthMm: 180 }, { heightMm: 200 }]) {
    let disposed = false;
    const old = entry.model;
    (old.getObjectByName('shower-curb-body') as Mesh).geometry.addEventListener('dispose', () => {
      disposed = true;
    });
    if ('heightMm' in patch) fixture.reconstruction!.support!.heightMm = patch.heightMm!;
    else Object.assign(fixture.reconstruction!.support!.curb!, patch);
    entry = cache.entry(pass);
    expect(entry.model).not.toBe(old);
    expect(disposed).toBe(true);
  }
  const box = new Box3().setFromObject(entry.model);
  expect(box.getSize(new Vector3()).toArray()).toEqual([1000, 2000, 180]);
  renderer.dispose();
  pass.occlusion.dispose();
});
