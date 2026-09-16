import { describe, expect, it } from 'vitest';
import { Box3, Mesh, Vector3 } from 'three';
import { createTemplateModel, disposeTemplateModel } from '../src/lib/reconstruction/templates';
import {
  fixtureVariantErrors,
  openCounterDefaults,
  OPEN_COUNTER_SUPPORTS,
} from '../src/lib/reconstruction/fixture-variants';
import { fixtureReconstructionSchema } from '../src/lib/supabase/validation';
const dimensions = { widthMm: 1000, heightMm: 950, depthMm: 550 },
  color = '#b5aea2';
function size(group: ReturnType<typeof createTemplateModel>, dims = dimensions) {
  const box = new Box3().setFromObject(group, true),
    v = box.getSize(new Vector3());
  expect(v.x).toBeCloseTo(dims.widthMm, 2);
  expect(v.y).toBeCloseTo(dims.heightMm, 2);
  expect(v.z).toBeCloseTo(dims.depthMm, 2);
  expect(box.min.y).toBeCloseTo(0, 3);
  for (const node of group.children) {
    const mesh = node as Mesh;
    expect(Array.from(mesh.geometry.attributes.position.array).every(Number.isFinite)).toBe(true);
  }
}
function geometry(group: ReturnType<typeof createTemplateModel>) {
  return group.children
    .map((node) => {
      const mesh = node as Mesh;
      return {
        name: node.name,
        positions: Array.from(mesh.geometry.attributes.position.array),
        indices: mesh.geometry.index ? Array.from(mesh.geometry.index.array) : null,
        materials: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => m.toJSON()),
      };
    })
    .map((row) => ({
      ...row,
      materials: row.materials.map(({ uuid, ...m }) => {
        void uuid;
        return m;
      }),
    }));
}
describe('explicit mirror and open-counter standard variants', () => {
  for (const mirrorShape of ['oval', 'arched'] as const)
    for (const hasFrame of [true, false])
      it(`${mirrorShape} frame=${hasFrame} has a shaped neutral surface and exact size`, () => {
        const d = { widthMm: 600, heightMm: 850, depthMm: 25 },
          model = createTemplateModel({ ...d, version: 2, kind: 'mirror', color, mirrorShape, hasFrame });
        try {
          size(model, d);
          expect(model.children.map((x) => x.name)).toEqual([
            'mirror-shaped-body',
            'mirror-neutral-shaped-face',
          ]);
          const body = (model.children[0] as Mesh).geometry.attributes.position;
          expect(
            Array.from({ length: body.count }, (_, i) => [body.getX(i), body.getY(i)]).some(
              ([x, y]) => Math.abs(x) > 299 && y > 849,
            ),
          ).toBe(false);
          expect((model.children[1] as Mesh).geometry.getAttribute('color')).toBeDefined();
        } finally {
          disposeTemplateModel(model);
        }
      });
  for (const counterSupport of OPEN_COUNTER_SUPPORTS)
    for (const basinShape of ['round', 'rectangular'] as const)
      it(`open ${counterSupport} ${basinShape} keeps the bowl on top and only selected panels`, () => {
        const defaults = openCounterDefaults(counterSupport),
          model = createTemplateModel({ ...defaults, version: 2, kind: 'vanity', color, basinShape });
        try {
          size(model, defaults);
          const names = model.children.map((n) => n.name);
          expect(names).toContain('open-counter-slab');
          expect(names.filter((n) => n.includes('panel'))).toEqual(
            counterSupport === 'wall'
              ? []
              : counterSupport === 'both-panels'
                ? ['open-counter-left-panel', 'open-counter-right-panel']
                : [`open-counter-${counterSupport}`],
          );
          const slab = new Box3().setFromObject(model.getObjectByName('open-counter-slab')!, true),
            bowl = new Box3().setFromObject(model.getObjectByName('basin-bowl')!, true);
          expect(bowl.min.y).toBeGreaterThanOrEqual(slab.max.y - 0.01);
          expect(names.some((n) => n.includes('door'))).toBe(false);
          if (counterSupport === 'wall') {
            expect(slab.min.y).toBeCloseTo(0, 3);
            expect(defaults.heightMm).toBe(330);
            expect(defaults.baseHeightMm).toBe(650);
          } else
            expect(
              new Box3().setFromObject(
                model.children.find((n) => n.name.includes('panel'))!,
                true,
              ).min.y,
            ).toBeCloseTo(0, 3);
        } finally {
          disposeTemplateModel(model);
        }
      });
  it('explicit rectangular/enclosed choices preserve old model geometry and materials', () => {
    for (const kind of ['mirror', 'vanity'] as const) {
      const original = createTemplateModel({ ...dimensions, kind, version: 2, color }),
        explicit = createTemplateModel({
          ...dimensions,
          kind,
          version: 2,
          color,
          ...(kind === 'mirror'
            ? { mirrorShape: 'rectangular' as const }
            : { vanityStyle: 'enclosed' as const }),
        });
      try {
        expect(geometry(explicit)).toEqual(geometry(original));
      } finally {
        disposeTemplateModel(original);
        disposeTemplateModel(explicit);
      }
    }
  });
  it('supports an existing basin vanity assembly without adding a second product', () => {
    const opts = { ...openCounterDefaults('right-panel'), version: 2 as const, color },
      a = createTemplateModel({ ...opts, kind: 'vanity' }),
      b = createTemplateModel({ ...opts, kind: 'basin', basinVariant: 'vanity' });
    try {
      expect(geometry(b)).toEqual(geometry(a));
    } finally {
      disposeTemplateModel(a);
      disposeTemplateModel(b);
    }
  });
  it('checks kind, parent style and actual support contact while retaining legacy data', () => {
    const core = { ...dimensions, version: 2 as const, kind: 'vanity', color };
    expect(fixtureReconstructionSchema.parse(core)).not.toHaveProperty('vanityStyle');
    const valid = {
      ...core,
      vanityStyle: 'open-counter' as const,
      counterSupport: 'wall' as const,
      baseHeightMm: 650,
      provenance: { vanityStyle: 'inferred' as const, counterSupport: 'user' as const },
    };
    expect(fixtureReconstructionSchema.parse(valid)).toEqual(valid);
    for (const patch of [
      { kind: 'toilet' },
      { vanityStyle: 'enclosed' },
      { counterSupport: undefined },
      { counterSupport: 'right-panel', baseHeightMm: 650 },
      { version: 1 },
    ])
      expect(fixtureReconstructionSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
    expect(fixtureVariantErrors({ ...valid, face: 'floor' })).not.toEqual([]);
    expect(fixtureVariantErrors({ ...valid, face: 'back' })).toEqual([]);
    const badMirror = { ...core, kind: 'mirror', mirrorShape: 'oval' as const };
    expect(fixtureReconstructionSchema.safeParse(badMirror).success).toBe(true);
    expect(fixtureReconstructionSchema.safeParse({ ...badMirror, kind: 'mirrorCabinet' }).success).toBe(
      false,
    );
  });
});
