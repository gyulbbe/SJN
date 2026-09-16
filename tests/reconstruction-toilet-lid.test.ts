import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Box3, Mesh, Vector3 } from 'three';
import { inferToiletLidState } from '../src/lib/reconstruction/toilet-observations';
import { createTemplateModel, disposeTemplateModel } from '../src/lib/reconstruction/templates';
import { fixtureReconstructionSchema } from '../src/lib/supabase/validation';
import { estimateCandidateFixture } from '../src/lib/reconstruction';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { ReconstructionCandidate } from '../src/lib/reconstruction/types';

// Synthetic connected-component summary for rules, not an AI quality result.
function assembly(): ReconstructionCandidate {
  return {
    id: 'measured-assembly',
    kind: 'toilet',
    source: 'deeplab',
    bounds: { left: 0.05, top: 0.15, right: 0.45, bottom: 0.68 },
    foot: { x: 0.25, y: 0.68 },
    color: '#eeeeee',
    pixels: 1900,
    status: 'unplaced',
    evidence: {
      semanticPixels: 700,
      meanMargin: 1.2,
      contextualKind: 'toilet-assembly',
      contextualParts: {
        toiletPixels: 700,
        bowlPixels: 720,
        surroundRatio: 1,
        lidBounds: { left: 0.09, top: 0.2, right: 0.26, bottom: 0.45 },
        bowlBounds: { left: 0.05, top: 0.5, right: 0.45, bottom: 0.68 },
      },
    },
  };
}
const shape = { kind: 'toilet' as const, color: '#eeeeee', widthMm: 400, heightMm: 750, depthMm: 680 };
const fingerprint = (mesh: Mesh) => {
  const hash = createHash('sha256');
  for (const name of ['position', 'normal'])
    hash.update(Buffer.from(mesh.geometry.getAttribute(name).array.buffer));
  if (mesh.geometry.index) hash.update(Buffer.from(mesh.geometry.index.array.buffer));
  return hash.digest('hex');
};
describe('toilet lid evidence and compatibility', () => {
  it('infers open only from recorded connected lid/rim/bowl geometry without changing source observations', () => {
    const candidate = assembly(),
      original = structuredClone(candidate);
    expect(inferToiletLidState(candidate)).toEqual({
      value: 'open',
      source: 'inferred',
      basis: 'connected-toilet-lid-bowl',
    });
    expect(candidate).toEqual(original);
    const review = {
      version: 2 as const,
      analysis: 'partial' as const,
      planes: [],
      candidates: [candidate],
      warnings: [],
    };
    expect(
      estimateCandidateFixture(candidate, review, DEFAULT_ROOM, { face: 'floor', u: 0.5, v: 0.5 }),
    ).toMatchObject({ toiletLidState: 'open', provenance: { toiletLidState: 'inferred' } });
    delete candidate.evidence.contextualParts;
    candidate.warning = '열린 변기 · open lid';
    candidate.evidence.meanMargin = 10;
    expect(inferToiletLidState(candidate)).toBeUndefined();
    expect(
      estimateCandidateFixture(candidate, review, DEFAULT_ROOM, { face: 'floor', u: 0.5, v: 0.5 }),
    ).toMatchObject({ toiletLidState: 'closed', provenance: { toiletLidState: 'default' } });
  });
  it.each([
    [
      'Qwen text',
      (c: ReconstructionCandidate) => {
        c.source = 'qwen';
      },
    ],
    [
      'reflection',
      (c: ReconstructionCandidate) => {
        c.reflectionOf = 'mirror';
      },
    ],
    [
      'unresolved kind',
      (c: ReconstructionCandidate) => {
        c.requiresReview = true;
      },
    ],
    [
      'unsupported surround',
      (c: ReconstructionCandidate) => {
        c.evidence.contextualParts!.surroundRatio = 0.1;
      },
    ],
    [
      'missing lid bounds',
      (c: ReconstructionCandidate) => {
        delete c.evidence.contextualParts!.lidBounds;
      },
    ],
    [
      'lid below bowl',
      (c: ReconstructionCandidate) => {
        c.evidence.contextualParts!.lidBounds = { left: 0.1, right: 0.2, top: 0.6, bottom: 0.65 };
      },
    ],
    [
      'disjoint horizontal support',
      (c: ReconstructionCandidate) => {
        c.evidence.contextualParts!.bowlBounds!.left = 0.3;
      },
    ],
    [
      'invalid numbers',
      (c: ReconstructionCandidate) => {
        c.evidence.contextualParts!.toiletPixels = NaN;
      },
    ],
    [
      'unsupported pixels',
      (c: ReconstructionCandidate) => {
        c.evidence.contextualParts!.bowlPixels = 10;
      },
    ],
  ] as const)('does not infer an open lid from %s', (_name, mutate) => {
    const candidate = assembly();
    mutate(candidate);
    expect(inferToiletLidState(candidate)).toBeUndefined();
  });
  it.each([1, 2] as const)(
    'keeps the pre-field version %i geometry and body coordinates for both explicit states',
    (version) => {
      const legacy = createTemplateModel({ ...shape, version });
      try {
        expect(legacy.children).toHaveLength(9);
        expect(legacy.children.some((mesh) => mesh.name.startsWith('toilet-lid'))).toBe(false);
        const unchanged = legacy.children.map((n) => fingerprint(n as Mesh));
        for (const state of ['open', 'closed'] as const) {
          const model = createTemplateModel({ ...shape, version, toiletLidState: state });
          try {
            expect(model.children.slice(0, 9).map((n) => fingerprint(n as Mesh))).toEqual(unchanged);
            expect(model.children).toHaveLength(10);
            const lid = model.getObjectByName('toilet-lid-' + state)!;
            const lidSize = new Box3().setFromObject(lid).getSize(new Vector3());
            expect(state === 'open' ? lidSize.y > lidSize.z * 5 : lidSize.z > lidSize.y * 5).toBe(true);
            const size = new Box3().setFromObject(model).getSize(new Vector3());
            expect(size.x).toBeCloseTo(shape.widthMm, 3);
            expect(size.y).toBeCloseTo(shape.heightMm, 3);
            expect(size.z).toBeCloseTo(shape.depthMm, 3);
          } finally {
            disposeTemplateModel(model);
          }
        }
      } finally {
        disposeTemplateModel(legacy);
      }
    },
  );
  it('round-trips lid state/source, accepts absence, and rejects fabricated direct-model provenance', () => {
    const meta = { ...shape, version: 2 };
    expect(fixtureReconstructionSchema.parse(meta)).toEqual(meta);
    for (const source of ['inferred', 'default', 'user'] as const) {
      const input = { ...meta, toiletLidState: 'open', provenance: { toiletLidState: source } };
      expect(fixtureReconstructionSchema.parse(input)).toEqual(input);
    }
    expect(fixtureReconstructionSchema.safeParse({ ...meta, toiletLidState: 'ajar' }).success).toBe(false);
    expect(
      fixtureReconstructionSchema.safeParse({
        ...meta,
        toiletLidState: 'open',
        provenance: { toiletLidState: 'model' },
      }).success,
    ).toBe(false);
  });
});
