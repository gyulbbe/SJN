import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Box3, Mesh, Vector3 } from 'three';
import { createTemplateModel, disposeTemplateModel } from '../src/lib/reconstruction/templates';
import {
  fixtureVariantErrors,
  SHOWER_VARIANTS,
  showerVariantDefaults,
  showerModelPartBounds,
} from '../src/lib/reconstruction/fixture-variants';
import { fixtureReconstructionSchema } from '../src/lib/storage/validation';
import type { ReconstructionStandardOptions } from '../src/lib/reconstruction/types';
import type { FixtureInstance, Scene } from '../src/lib/types';
import Controls, {
  fixtureForm,
  type FixtureForm,
} from '../src/components/reconstruction/reconstruction-fixture-controls';
import legacy from './fixtures/shower-legacy-geometry-v1.json';
import { showerGeometrySignature } from './helpers/shower-geometry-signature.mjs';

describe('optional shower variants preserve saved geometry and explicit user values', () => {
  for (const [index, row] of legacy.cases.entries())
    it('matches the source-before legacy vertex/material signature ' + index, () => {
      const model = createTemplateModel({
        ...row.options,
        kind: 'shower',
        version: row.options.version as 1 | 2 | undefined,
      });
      try {
        expect(showerGeometrySignature(model)).toEqual(row.signature);
        expect(showerModelPartBounds(model)).toEqual({});
      } finally {
        disposeTemplateModel(model);
      }
    });
  for (const showerVariant of SHOWER_VARIANTS)
    for (const custom of [false, true])
      it(
        showerVariant + ' keeps whole-envelope dimensions and inspectable part bounds, custom=' + custom,
        () => {
          const dims = custom
            ? { widthMm: 223, heightMm: 681, depthMm: 137 }
            : showerVariantDefaults(showerVariant);
          const model = createTemplateModel({
            ...dims,
            kind: 'shower',
            version: 2,
            color: '#9caaad',
            showerVariant,
          });
          try {
            const box = new Box3().setFromObject(model, true),
              size = box.getSize(new Vector3());
            expect(size.x).toBeCloseTo(dims.widthMm, 2);
            expect(size.y).toBeCloseTo(dims.heightMm, 2);
            expect(size.z).toBeCloseTo(dims.depthMm, 2);
            expect(box.min.y).toBeCloseTo(0, 3);
            const parts = showerModelPartBounds(model);
            if (showerVariant === 'overhead-head') {
              expect(parts.handset).toBeUndefined();
              expect(parts.hose).toBeUndefined();
              expect(parts.rail).toBeUndefined();
              expect(parts['overhead-head']!.meshNames).toContain('shower-overhead-arm');
              expect(model.children.some((n) => /hose|handset|rail|mixer|control/.test(n.name))).toBe(false);
            } else {
              expect(parts.handset).toBeDefined();
              expect(parts.hose).toBeDefined();
              expect(parts.handset!.meshNames).toContain('shower-handset-head');
              expect(parts.handset!.meshNames).toContain('shower-handset-holder');
              expect(parts.handset!.size[1]).toBeLessThan(dims.heightMm * 0.5);
              expect(parts.hose!.size[1]).toBeGreaterThan(parts.handset!.size[1]);
              if (showerVariant === 'hand-spray' || showerVariant === 'handheld-wall') {
                expect(parts.rail).toBeUndefined();
                expect(parts['overhead-head']).toBeUndefined();
                expect(model.children.some((n) => n.name === 'shower-mixer')).toBe(showerVariant === 'handheld-wall');
                expect(model.children.some((n) => n.name === 'shower-handset-trigger')).toBe(showerVariant === 'hand-spray');
              } else {
                expect(parts.rail).toBeDefined();
                expect(Boolean(parts['overhead-head'])).toBe(showerVariant === 'overhead-set');
                if (showerVariant === 'overhead-set') {
                  expect(parts['overhead-head']!.meshNames).toContain('shower-overhead-arm');
                  expect(parts['overhead-head']!.min[1]).toBeGreaterThan(parts.handset!.max[1]);
                }
              }
            }
            for (const part of Object.values(parts)) {
              expect([...part.min, ...part.max, ...part.size].every(Number.isFinite)).toBe(true);
              expect(part.min[1]).toBeGreaterThanOrEqual(-0.01);
              expect(part.max[1]).toBeLessThanOrEqual(dims.heightMm + 0.01);
            }
            for (const n of model.children) {
              expect(n).toBeInstanceOf(Mesh);
              const mesh = n as Mesh;
              expect(Array.from(mesh.geometry.attributes.position.array).every(Number.isFinite)).toBe(true);
              for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
                expect((material as { map?: unknown }).map).toBeFalsy();
            }
          } finally {
            disposeTemplateModel(model);
          }
        },
      );
  it('declares editable whole-kit defaults and returns independent objects', () => {
    expect(SHOWER_VARIANTS.map((v) => showerVariantDefaults(v))).toEqual([
      {
        widthMm: 180,
        heightMm: 450,
        depthMm: 120,
        baseHeightMm: 450,
        face: 'back',
        showerVariant: 'hand-spray',
      },
      {
        widthMm: 250,
        heightMm: 1000,
        depthMm: 250,
        baseHeightMm: 850,
        face: 'back',
        showerVariant: 'handheld-rail',
      },
      {
        widthMm: 350,
        heightMm: 1300,
        depthMm: 500,
        baseHeightMm: 750,
        face: 'back',
        showerVariant: 'overhead-set',
      },
      {
        widthMm: 350, heightMm: 1100, depthMm: 150, baseHeightMm: 800,
        face: 'back', showerVariant: 'handheld-wall',
      },
      {
        widthMm: 220, heightMm: 180, depthMm: 320, baseHeightMm: 1950,
        face: 'back', showerVariant: 'overhead-head',
      },
    ]);
    const changed = showerVariantDefaults('hand-spray');
    changed.heightMm = 1;
    expect(showerVariantDefaults('hand-spray').heightMm).toBe(450);
  });
  it('persists subtype and provenance without inventing defaults in old records', () => {
    const old = {
      kind: 'shower',
      version: 2,
      color: '#999999',
      widthMm: 223,
      heightMm: 681,
      depthMm: 137,
      baseHeightMm: 533,
    };
    expect(fixtureReconstructionSchema.parse(old)).toEqual(old);
    expect(fixtureReconstructionSchema.parse(old)).not.toHaveProperty('showerVariant');
    for (const showerVariant of SHOWER_VARIANTS) {
      const value = {
        ...old,
        showerVariant,
        provenance: { showerVariant: 'user', dimensions: 'user', height: 'user' },
      };
      expect(fixtureReconstructionSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    }
  });
  it('rejects unsupported variants, v1 subtype data and wrong fixture kinds', () => {
    const good = {
      version: 2 as const,
      kind: 'shower',
      color: '#999999',
      ...showerVariantDefaults('hand-spray'),
    };
    expect(fixtureVariantErrors(good)).toEqual([]);
    expect(fixtureVariantErrors({ ...good, face: 'floor' })).not.toEqual([]);
    for (const patch of [
      { showerVariant: 'invented' },
      { showerVariant: null },
      { version: 1 },
      { kind: 'basin' },
      { kind: 'wallShelf' },
    ])
      expect(fixtureReconstructionSchema.safeParse({ ...good, ...patch }).success).toBe(false);
    expect(
      fixtureReconstructionSchema.safeParse({ ...good, showerVariant: undefined, version: 1 }).success,
    ).toBe(true);
  });
});

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
const roomScene = { room: { heightMm: 2400 } } as Scene;
function storedFixture(showerVariant?: ReconstructionStandardOptions['showerVariant']) {
  return {
    reconstruction: {
      kind: 'shower',
      version: 2,
      color: '#999999',
      widthMm: 223,
      heightMm: 681,
      depthMm: 137,
      baseHeightMm: 533,
      showerVariant,
    },
    roomPlacement: { face: 'left', u: 0.23, v: 0.67, scale: 1 },
    anchor: { x: 0.5, y: 0.5 },
  } as FixtureInstance;
}
describe('simple shower controls', () => {
  it('restores legacy or explicit subtype without inferring it from other dimensions', () => {
    expect(fixtureForm(roomScene, storedFixture()).showerVariant).toBeUndefined();
    expect(fixtureForm(roomScene, storedFixture('hand-spray')).showerVariant).toBe('hand-spray');
    expect(fixtureForm(roomScene, storedFixture('hand-spray')).baseHeightMm).toBe(533);
  });
  it('changes only the selected subtype, preserving existing size and installation', () => {
    const value = fixtureForm(roomScene, storedFixture()),
      onChange = vi.fn(),
      dimensions = { widthMm: 223, depthMm: 137 };
    const tree = Controls({
      kind: 'shower',
      dimensions,
      value,
      disabled: false,
      onChange,
      onBasinVariant: vi.fn(),
    });
    const select = elements(tree).find((e) => e.props['aria-label'] === '샤워 형태')!;
    (select.props.onChange as (e: unknown) => void)({ target: { value: 'hand-spray' } });
    expect(onChange).toHaveBeenCalledWith({ ...value, showerVariant: 'hand-spray' });
    expect(value.showerVariant).toBeUndefined();
    expect(dimensions).toEqual({ widthMm: 223, depthMm: 137 });
    expect(renderToStaticMarkup(tree)).toContain('기존 모양 유지');
    expect(renderToStaticMarkup(tree)).not.toContain('이 형태의 기본 규격 적용');
  });
  it('applies defaults only through the separate explicit callback', () => {
    const value: FixtureForm = fixtureForm(roomScene, storedFixture('hand-spray')),
      onChange = vi.fn(),
      onShowerDefaults = vi.fn();
    const tree = Controls({
      kind: 'shower',
      dimensions: { widthMm: 223, depthMm: 137 },
      value,
      disabled: false,
      onChange,
      onBasinVariant: vi.fn(),
      onShowerDefaults,
    });
    const button = elements(tree).find(
      (e) => e.type === 'button' && e.props.children === '이 형태의 기본 규격 적용',
    )!;
    (button.props.onClick as () => void)();
    expect(onShowerDefaults).toHaveBeenCalledWith('hand-spray');
    expect(onChange).not.toHaveBeenCalled();
    expect(value.baseHeightMm).toBe(533);
    expect(renderToStaticMarkup(tree)).toContain('실측값이 아니며');
  });
});
