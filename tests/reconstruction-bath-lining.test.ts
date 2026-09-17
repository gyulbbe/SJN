import { describe, expect, it } from 'vitest';
import { Mesh, MeshStandardMaterial } from 'three';
import { createTemplateModel, disposeTemplateModel } from '../src/lib/reconstruction/templates';
import { fixtureReconstructionSchema } from '../src/lib/storage/validation';
import { estimateCandidateFixture } from '../src/lib/reconstruction';
import { reconstructionDefaults, type ReconstructionCandidate } from '../src/lib/reconstruction/types';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
const options = {
  kind: 'bath' as const,
  version: 2 as const,
  color: '#242323',
  widthMm: 1500,
  heightMm: 600,
  depthMm: 750,
};
function snapshot(lining?: string) {
  const group = createTemplateModel({ ...options, bathLiningColor: lining });
  try {
    return group.children.map((node) => {
      const mesh = node as Mesh;
      return {
        name: mesh.name,
        attributes: Object.fromEntries(
          Object.entries(mesh.geometry.attributes).map(([key, attribute]) => [
            key,
            Array.from(attribute.array),
          ]),
        ),
        indices: mesh.geometry.index ? Array.from(mesh.geometry.index.array) : null,
        materials: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((material) => {
          const m = material as MeshStandardMaterial;
          return {
            color: m.color.getHexString(),
            roughness: m.roughness,
            metalness: m.metalness,
            opacity: m.opacity,
          };
        }),
      };
    });
  } finally {
    disposeTemplateModel(group);
  }
}
describe('optional bath interior finish', () => {
  it('preserves the original material choices and exact geometry when omitted', () => {
    const old = snapshot(),
      group = createTemplateModel(options);
    try {
      expect(old[0].materials[0].color).toBe('242323');
      expect(old[0].materials[0].roughness).toBe(0.32);
      expect(old[1].materials[0].roughness).toBe(0.58);
      for (const rim of old.filter((m) => m.name.startsWith('bath-rim-')))
        expect(rim.materials[0].color).toBe('242323');
      expect(old.length).toBe(group.children.length);
      for (let i = 0; i < old.length; i++)
        expect(old[i].attributes.position).toEqual(
          Array.from((group.children[i] as Mesh).geometry.attributes.position.array),
        );
    } finally {
      disposeTemplateModel(group);
    }
  });
  it('changes only the inside/rim materials, retaining the exterior, chrome, geometry and support names', () => {
    const old = snapshot(),
      next = snapshot('#eeefeb');
    expect(next.map((m) => ({ attributes: m.attributes, indices: m.indices, name: m.name }))).toEqual(
      old.map((m) => ({ attributes: m.attributes, indices: m.indices, name: m.name })),
    );
    expect(next[0]).toEqual(old[0]);
    for (let i = 6; i < old.length; i++) expect(next[i]).toEqual(old[i]);
    expect(next[1].materials[0].color).not.toBe(old[1].materials[0].color);
    for (const rim of next.filter((m) => m.name.startsWith('bath-rim-')))
      expect(rim.materials[0].color).toBe('eeefeb');
  });
  it('allows a user-selected lining rather than forcing every registered bath to white', () => {
    const next = snapshot('#345678');
    expect(next[0].materials[0].color).toBe('242323');
    for (const rim of next.filter((m) => m.name.startsWith('bath-rim-')))
      expect(rim.materials[0].color).toBe('345678');
  });
  it('round-trips optional finish and its source without adding it to old fixtures', () => {
    const meta = { ...options, provenance: { color: 'inferred' as const } };
    expect(fixtureReconstructionSchema.parse(meta)).not.toHaveProperty('bathLiningColor');
    const next = {
      ...meta,
      bathLiningColor: '#eeefeb',
      provenance: { ...meta.provenance, bathLiningColor: 'default' as const },
    };
    expect(fixtureReconstructionSchema.parse(next)).toEqual(next);
    expect(fixtureReconstructionSchema.safeParse({ ...next, bathLiningColor: 'not-a-color' }).success).toBe(
      false,
    );
    expect(fixtureReconstructionSchema.safeParse({ ...next, kind: 'toilet' }).success).toBe(false);
  });
  it('new analysis plans declare default lining independently of observed body color', () => {
    const c: ReconstructionCandidate = {
      id: 'bath',
      kind: 'bath',
      source: 'deeplab',
      bounds: { left: 0.1, top: 0.3, right: 0.8, bottom: 0.8 },
      foot: { x: 0.5, y: 0.8 },
      color: '#242323',
      pixels: 1000,
      evidence: { semanticPixels: 1000, meanMargin: 3 },
      status: 'unplaced',
    };
    const result = estimateCandidateFixture(
      c,
      { version: 2, analysis: 'partial', planes: [], warnings: [], candidates: [c] },
      DEFAULT_ROOM,
      { face: 'floor', u: 0.5, v: 0.5 },
    );
    expect(result.bathLiningColor).toBe('#eeefeb');
    expect(result.provenance.bathLiningColor).toBe('default');
    expect(reconstructionDefaults('bath')).not.toHaveProperty('bathLiningColor');
  });
});
