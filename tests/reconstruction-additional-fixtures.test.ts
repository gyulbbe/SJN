import { Box3, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createTemplateModel, disposeTemplateModel } from '../src/lib/reconstruction/templates';
import { reconstructionDefaults, reconstructionLabels } from '../src/lib/reconstruction/types';
import { categoryLabels } from '../src/lib/types';
import { fixtureReconstructionSchema } from '../src/lib/storage/validation';

const kinds = ['shower', 'wallCabinet', 'lowPartition'] as const;

describe('additional visible bathroom fixture templates', () => {
  it.each(kinds)('%s has explicit supported defaults and persists through the fixture schema', (kind) => {
    const defaults = reconstructionDefaults(kind);
    expect(reconstructionLabels[kind]).toBeTruthy();
    expect(categoryLabels[kind]).toBeTruthy();
    const input = {
      version: 2 as const,
      kind,
      color: defaults.color,
      widthMm: defaults.widthMm,
      heightMm: defaults.heightMm,
      depthMm: defaults.depthMm,
      baseHeightMm: defaults.baseHeightMm,
      provenance: { kind: 'model', dimensions: 'default', position: 'inferred' },
    };
    expect(fixtureReconstructionSchema.parse(input)).toEqual(input);
    expect(defaults.face).toBe(kind === 'lowPartition' ? 'floor' : 'back');
    expect(defaults.baseHeightMm).toBe(kind === 'lowPartition' ? 0 : kind === 'shower' ? 750 : 1300);
  });

  for (const kind of kinds) {
    it.each([
      { widthMm: 300, heightMm: 900, depthMm: 120 },
      { widthMm: 700, heightMm: 1200, depthMm: 350 },
      { widthMm: 1200, heightMm: 450, depthMm: 75 },
    ])(`${kind} occupies exactly its requested physical box %j`, (dimensions) => {
      const model = createTemplateModel({ kind, version: 2, color: '#cccccc', ...dimensions });
      try {
        const bounds = new Box3().setFromObject(model);
        const size = bounds.getSize(new Vector3());
        expect(size.x).toBeCloseTo(dimensions.widthMm, 3);
        expect(size.y).toBeCloseTo(dimensions.heightMm, 3);
        expect(size.z).toBeCloseTo(dimensions.depthMm, 3);
        expect(bounds.min.y).toBeCloseTo(0, 3);
        expect(bounds.min.x).toBeCloseTo(-dimensions.widthMm / 2, 3);
        expect(bounds.min.z).toBeCloseTo(-dimensions.depthMm / 2, 3);
        expect(model.children.length).toBeGreaterThan(0);
        model.traverse((node) => {
          if (!(node instanceof Mesh)) return;
          const positions = node.geometry.getAttribute('position');
          expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          for (const material of materials) {
            const surface = material as MeshStandardMaterial;
            expect(surface.map).toBeNull();
            expect(surface.alphaMap).toBeNull();
            expect(surface.transparent).toBe(false);
          }
        });
      } finally {
        disposeTemplateModel(model);
      }
    });
  }

  it('models a wall shower as distinct mixer, rail, head and curved hose rather than an enclosure', () => {
    const model = createTemplateModel({ ...reconstructionDefaults('shower'), kind: 'shower', version: 2 });
    try {
      for (const name of ['shower-mixer', 'shower-rail', 'shower-head', 'shower-hose'])
        expect(model.getObjectByName(name)).toBeInstanceOf(Mesh);
      const hose = model.getObjectByName('shower-hose') as Mesh;
      expect(hose.geometry.type).toBe('TubeGeometry');
      const mixer = new Box3().setFromObject(model.getObjectByName('shower-mixer')!);
      const head = new Box3().setFromObject(model.getObjectByName('shower-head')!);
      const hoseBounds = new Box3().setFromObject(hose);
      expect(head.min.y).toBeGreaterThan(mixer.max.y);
      expect(hoseBounds.min.y).toBeLessThan(mixer.min.y);
      expect(model.children.filter((node) => node.name === 'shower-control')).toHaveLength(2);
      expect(model.children.some((node) => /glass|enclosure|mirror|basin/.test(node.name))).toBe(false);
    } finally {
      disposeTemplateModel(model);
    }
  });

  it.each([1, 2, 4])('models a %i-door wall cabinet without mirrored or window surfaces', (doorCount) => {
    const model = createTemplateModel({
      ...reconstructionDefaults('wallCabinet'),
      kind: 'wallCabinet',
      version: 2,
      doorCount,
    });
    try {
      expect(model.children.filter((node) => node.name === 'wall-cabinet-door')).toHaveLength(doorCount);
      expect(model.children.filter((node) => node.name === 'wall-cabinet-handle')).toHaveLength(doorCount);
      for (const node of model.children) {
        const mesh = node as Mesh;
        expect(mesh.geometry.type).not.toBe('PlaneGeometry');
        expect((mesh.material as MeshStandardMaterial).vertexColors).toBe(false);
      }
      expect(model.getObjectByName('basin-bowl')).toBeUndefined();
      expect(model.getObjectByName('vanity-plinth')).toBeUndefined();
    } finally {
      disposeTemplateModel(model);
    }
  });

  it('joins the opaque low partition body and cap without adding glass or a basin', () => {
    const options = reconstructionDefaults('lowPartition');
    const model = createTemplateModel({ ...options, kind: 'lowPartition', version: 2 });
    try {
      expect(model.children).toHaveLength(2);
      const body = new Box3().setFromObject(model.getObjectByName('low-partition-body')!);
      const cap = new Box3().setFromObject(model.getObjectByName('low-partition-cap')!);
      expect(body.min.y).toBeCloseTo(0, 3);
      expect(body.max.y).toBeCloseTo(cap.min.y, 3);
      expect(cap.max.y).toBeCloseTo(options.heightMm, 3);
      expect(cap.getSize(new Vector3()).x).toBeCloseTo(options.widthMm, 3);
    } finally {
      disposeTemplateModel(model);
    }
  });
});
