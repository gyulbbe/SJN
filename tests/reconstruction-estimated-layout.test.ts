import { buildEstimatedCameraDirections } from '../src/lib/reconstruction/estimated-camera-directions';
import { inspectEstimatedPhotoRelations } from '../src/lib/reconstruction/estimated-relation-evidence';
import { Quaternion, Euler, Vector3 } from 'three';
import {
  buildEstimatedDepthWallEvidence,
  estimatedDepthWallOrientation,
} from '../src/lib/reconstruction/estimated-plane-evidence';
import type {
  DepthRoomObservation,
  DepthPlaneObservation,
} from '../src/lib/reconstruction/depth-room-geometry';
import { parseFixtureAppearance } from '../src/lib/reconstruction/fixture-appearance-observation';
import {
  buildEstimatedRoomLayoutExperiment,
  inspectEstimatedRoomStructure,
} from '../src/lib/reconstruction/estimated-room-layout';
import { reconstructionDefaults } from '../src/lib/reconstruction/types';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import {
  buildEstimatedCandidatePipeline,
  type LayoutObservationInput,
} from '../src/lib/reconstruction/estimated-layout';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';
import { validateSourceFixture } from '../src/lib/reconstruction/source-camera';

const room = { ...DEFAULT_ROOM };
const image = { width: 960, height: 1280 };
const baseline: ReconstructionReview = {
  version: 2,
  analysis: 'partial',
  candidates: [],
  planes: [],
  warnings: [],
};
const candidate = (overrides: Partial<SceneCandidate> = {}): SceneCandidate => ({
  id: 'basin-1',
  kind: 'basin',
  bounds: { left: 0.3, top: 0.45, right: 0.65, bottom: 0.64 },
  mounting: 'wall',
  wall: 'unknown',
  basinStyle: 'wall',
  shape: 'rectangular',
  reflection: 'physical',
  evidence: ['Synthetic observation for contract testing, not an actual AI result.'],
  uncertainty: [],
  ...overrides,
});
function input(candidates: SceneCandidate[], layoutObservation?: LayoutObservationInput) {
  const understanding: SceneUnderstanding = {
    schemaVersion: 1,
    candidates,
    relations: [],
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: ['camera unresolved'] },
  };
  return {
    understanding,
    baseline,
    room,
    image,
    strictResult: buildCandidatePipeline(understanding, baseline, room, image),
    layoutObservation,
  };
}

describe('visible-relation estimated layout', () => {
  it('preserves observed bowl counts and their source in estimated plans', () => {
    for (const source of ['model', 'user', 'geometry', 'default'] as const) {
      const args = input([candidate({ bowlCount: 2, provenance: { bowlCount: source } })]);
      const output = buildEstimatedCandidatePipeline(args);
      expect(output.plans['basin-1']?.bowlCount).toBe(2);
      expect(output.plans['basin-1']?.provenance?.bowlCount).toBe(source === 'geometry' ? 'inferred' : source);
    }
    const output = buildEstimatedCandidatePipeline(input([candidate()]));
    expect(output.plans['basin-1']?.bowlCount).toBe(1);
    expect(output.plans['basin-1']?.provenance?.bowlCount).toBe('default');
  });

  it('places an observed wall basin even when strict camera is held, without changing strict observations', () => {
    const args = input([candidate()]);
    expect(args.strictResult.pipeline.camera.status).toBe('held');
    expect(args.strictResult.plans['basin-1']).toBeNull();
    const original = structuredClone(args);
    const output = buildEstimatedCandidatePipeline(args);
    expect(output.plans['basin-1']).not.toBeNull();
    expect(output.plans['basin-1']?.face).not.toBe('floor');
    expect(output.plans['basin-1']?.basinVariant).toBe('wall');
    expect(output.pipeline.camera).toEqual(original.strictResult.pipeline.camera);
    expect(output.pipeline.placements).toEqual(original.strictResult.pipeline.placements);
    expect(args).toEqual(original);
    expect(output.pipeline.estimatedLayout.nodes[0].selected?.sources.position).toBe('estimated');
    expect(output.review.candidates[0].requiresReview).toBe(true);
  });

  it('uses a general footprint for a cropped toilet and does not call the cropped edge a contact', () => {
    const args = input([
      candidate({
        id: 'toilet-1',
        kind: 'toilet',
        mounting: 'unknown',
        basinStyle: 'unknown',
        bounds: { left: 0, top: 0.4, right: 0.43, bottom: 1 },
      }),
    ]);
    const result = buildEstimatedCandidatePipeline(args);
    const plan = result.plans['toilet-1'];
    expect(plan?.face).toBe('floor');
    expect(plan?.baseHeightMm).toBe(0);
    expect(result.pipeline.estimatedLayout.nodes[0].selected?.anchorRole).toBe('floor-footprint-centre');
    expect(result.pipeline.understanding.candidates[0].anchor).toBeUndefined();
    expect(
      validateSourceFixture(room, undefined, {
        ...plan!,
        widthMm: plan!.widthMm!,
        heightMm: plan!.heightMm!,
        depthMm: plan!.depthMm!,
      }).valid,
    ).toBe(true);
  });

  it('keeps actual wall observations and relative order in the selected scene', () => {
    const args = input(
      [
        candidate({ id: 'left-basin', bounds: { left: 0.18, top: 0.45, right: 0.43, bottom: 0.63 } }),
        candidate({
          id: 'right-toilet',
          kind: 'toilet',
          mounting: 'floor',
          basinStyle: 'unknown',
          bounds: { left: 0.58, top: 0.53, right: 0.82, bottom: 0.91 },
        }),
      ],
      {
        observations: [
          { id: 'left-basin', wall: 'back' },
          { id: 'right-toilet', wall: 'back' },
        ],
        relations: [{ fromId: 'left-basin', toId: 'right-toilet', type: 'leftOf', note: 'test' }],
      },
    );
    const result = buildEstimatedCandidatePipeline(args);
    expect(result.plans['left-basin']?.face).toBe('back');
    expect(result.plans['left-basin']?.u).toBeLessThan(result.plans['right-toilet']!.u);
    const nodes = result.pipeline.estimatedLayout.nodes;
    expect(nodes.every((node) => node.selected?.physicalCheck.valid)).toBe(true);
    expect(nodes[0].selected?.sources.wall).toBe('model-observed');
  });

  it('does not invent unseen fixtures or promote reflected objects', () => {
    const empty = buildEstimatedCandidatePipeline(input([]));
    expect(empty.plans).toEqual({});
    const reflected = buildEstimatedCandidatePipeline(input([candidate({ reflection: 'reflected' })]));
    expect(reflected.plans['basin-1']).toBeNull();
    expect(reflected.pipeline.estimatedLayout.nodes[0].status).toBe('excluded');
  });

  it('retains unsupported basin support as held instead of inventing a pedestal', () => {
    const result = buildEstimatedCandidatePipeline(
      input([candidate({ mounting: 'unknown', basinStyle: 'unknown' })]),
    );
    expect(result.plans['basin-1']).toBeNull();
    expect(result.pipeline.estimatedLayout.nodes[0].status).toBe('held');
    expect(result.pipeline.estimatedLayout.nodes[0].observed.basinStyle).toBe('unknown');
  });

  it('does not turn unknown categories or invalid observations into products', () => {
    const result = buildEstimatedCandidatePipeline(
      input([
        candidate({ id: 'unknown', kind: 'unknown' }),
        candidate({
          id: 'invalid',
          validation: {
            status: 'needs-review',
            issues: [{ code: 'invalid-kind', message: 'unresolved type' }],
          },
        }),
      ]),
    );
    expect(Object.values(result.plans).filter(Boolean)).toHaveLength(0);
    expect(result.pipeline.estimatedLayout.nodes).toHaveLength(2);
  });

  it('preserves an explicit manual placement without replacing it with the best image fit', () => {
    const args = input([candidate({ wall: 'back' })]);
    const manual = {
      face: 'back' as const,
      u: 0.72,
      v: 0.7,
      baseHeightMm: 650,
      widthMm: 600,
      heightMm: 320,
      depthMm: 450,
    };
    args.strictResult = buildCandidatePipeline(args.understanding, baseline, room, image, {
      'basin-1': manual,
    });
    const originalPlan = structuredClone(args.strictResult.plans['basin-1']);
    const result = buildEstimatedCandidatePipeline({ ...args, manualIdSet: new Set(['basin-1']) });
    expect(result.plans['basin-1']).toEqual(originalPlan);
    expect(result.pipeline.estimatedLayout.nodes[0].selected?.sources.position).toBe('user');
  });

  it('produces deterministic and physically bounded proposals without mutating camera display settings', () => {
    const args = input([
      candidate({
        id: 'glass',
        kind: 'glassPartition',
        mounting: 'floor',
        basinStyle: 'unknown',
        bounds: { left: 0.25, top: 0.1, right: 0.48, bottom: 0.92 },
      }),
    ]);
    const first = buildEstimatedCandidatePipeline(args);
    const second = buildEstimatedCandidatePipeline(args);
    expect(first).toEqual(second);
    expect(first.plans.glass?.placementPolicy).toBe('preserve');
    expect(first.pipeline.estimatedLayout.nodes[0].selected?.physicalCheck.valid).toBe(true);
    expect(first.pipeline.camera.camera).toBeUndefined();
  });
  it('keeps model wall claims defeasible and records a conflicting chosen wall', () => {
    const args = input([candidate({ bounds: { left: 0.38, top: 0.45, right: 0.65, bottom: 0.62 } })], {
      observations: [{ id: 'basin-1', wall: 'left', orientation: 'toward-camera' }],
      relations: [],
    });
    const result = buildEstimatedCandidatePipeline(args);
    const node = result.pipeline.estimatedLayout.nodes[0];
    expect(node.observationChecks?.[0].observed).toBe('left');
    expect(node.alternatives.some((entry) => entry.plan.face !== 'left')).toBe(true);
    expect(node.observed.wall).toBe('unknown');
    if (node.selected?.plan.face !== 'left') {
      expect(node.selected?.sources.wall).toBe('estimated');
      expect(node.observationChecks?.[0].status).toBe('conflicts');
    }
  });

  it('renders an explicitly observed bowl-support relationship as one assembly and preserves both observations', () => {
    const args = input(
      [
        candidate({
          id: 'bowl',
          mounting: 'countertop',
          basinStyle: 'vanity',
          shape: 'round',
          bounds: { left: 0.38, top: 0.48, right: 0.65, bottom: 0.57 },
        }),
        candidate({
          id: 'cabinet',
          kind: 'vanity',
          mounting: 'floor',
          basinStyle: 'unknown',
          shape: 'unknown',
          bounds: { left: 0.3, top: 0.55, right: 0.7, bottom: 0.85 },
        }),
      ],
      {
        observations: [],
        relations: [
          { fromId: 'bowl', toId: 'cabinet', type: 'supportedBy', note: 'Observed bowl rests on cabinet.' },
        ],
      },
    );
    const result = buildEstimatedCandidatePipeline(args);
    expect(result.plans.bowl).toBeNull();
    expect(result.plans.cabinet).not.toBeNull();
    expect(result.plans.cabinet?.basinShape).toBe('round');
    expect(result.pipeline.estimatedLayout.assemblies).toEqual([
      expect.objectContaining({ parentId: 'cabinet', componentIds: ['bowl'], source: 'model-observed' }),
    ]);
    expect(result.pipeline.understanding).toEqual(args.strictResult.pipeline.understanding);
    expect(result.pipeline.estimatedLayout.nodes.map((node) => node.observed.id)).toEqual([
      'bowl',
      'cabinet',
    ]);
  });

  it('does not invent a support relationship from overlapping image rectangles', () => {
    const args = input([
      candidate({
        id: 'bowl',
        basinStyle: 'vanity',
        bounds: { left: 0.38, top: 0.48, right: 0.65, bottom: 0.57 },
      }),
      candidate({
        id: 'cabinet',
        kind: 'vanity',
        mounting: 'floor',
        basinStyle: 'unknown',
        bounds: { left: 0.3, top: 0.55, right: 0.7, bottom: 0.85 },
      }),
    ]);
    const result = buildEstimatedCandidatePipeline(args);
    expect(result.pipeline.estimatedLayout.assemblies).toEqual([]);
  });
  it('can attach observed glass to a low partition top without calling its height measured', () => {
    const args = input(
      [
        candidate({
          id: 'support',
          kind: 'lowPartition',
          mounting: 'floor',
          basinStyle: 'unknown',
          bounds: { left: 0.34, top: 0.55, right: 0.68, bottom: 0.88 },
        }),
        candidate({
          id: 'glass',
          kind: 'glassPartition',
          mounting: 'floor',
          basinStyle: 'unknown',
          bounds: { left: 0.36, top: 0.18, right: 0.66, bottom: 0.56 },
        }),
      ],
      {
        observations: [],
        relations: [
          {
            fromId: 'glass',
            toId: 'support',
            type: 'supportedBy',
            note: 'Glass bottom rests on the partition top.',
          },
        ],
      },
    );
    const manual = {
      face: 'floor' as const,
      u: 0.5,
      v: 0.45,
      baseHeightMm: 0,
      widthMm: 900,
      heightMm: 1100,
      depthMm: 150,
      yawDegrees: 0,
    };
    args.strictResult = buildCandidatePipeline(args.understanding, baseline, room, image, {
      support: manual,
    });
    const result = buildEstimatedCandidatePipeline({ ...args, manualIdSet: new Set(['support']) });
    const glass = result.plans.glass;
    expect(glass?.partitionTopCandidate?.parentCandidateId).toBe('support');
    expect(glass?.baseHeightMm).toBe(1100);
    expect(glass?.support?.provenance.kind).toBe('inferred');
    expect(glass?.support?.evidence?.length).toBeGreaterThan(0);
    expect(
      result.pipeline.estimatedLayout.nodes.find((node) => node.candidateId === 'glass')?.selected
        ?.physicalCheck.valid,
    ).toBe(true);
  });

  it('does not add a parent-supported glass relation from image overlap alone', () => {
    const args = input([
      candidate({
        id: 'bath',
        kind: 'bath',
        mounting: 'floor',
        basinStyle: 'unknown',
        bounds: { left: 0.2, top: 0.6, right: 0.8, bottom: 0.8 },
      }),
      candidate({
        id: 'glass',
        kind: 'glassPartition',
        mounting: 'floor',
        basinStyle: 'unknown',
        bounds: { left: 0.4, top: 0.1, right: 0.65, bottom: 0.63 },
      }),
    ]);
    const result = buildEstimatedCandidatePipeline(args);
    expect(result.plans.glass?.bathRimCandidate).toBeUndefined();
    expect(
      result.pipeline.estimatedLayout.nodes
        .find((node) => node.candidateId === 'glass')
        ?.alternatives.every((entry) => !entry.plan.bathRimCandidate),
    ).toBe(true);
  });
});

describe('isolated source-camera and lining diagnostics', () => {
  it('keeps compact camera results available in an explicitly requested expanded experiment', () => {
    const args = input([candidate()]);
    const original = structuredClone(args);
    const compact = buildEstimatedCandidatePipeline(args);
    const expanded = buildEstimatedCandidatePipeline({ ...args, cameraSearch: 'expanded-v1' });
    expect(compact.pipeline.estimatedLayout.cameraSearch).toBe('compact');
    expect(compact.pipeline.estimatedLayout.hypotheses).toHaveLength(6);
    expect(expanded.pipeline.estimatedLayout.hypotheses.length).toBeGreaterThan(6);
    for (const old of compact.pipeline.estimatedLayout.hypotheses) {
      expect(expanded.pipeline.estimatedLayout.hypotheses.find((h) => h.id === old.id)).toEqual(old);
    }
    expect(expanded.pipeline.estimatedLayout.hypotheses[0].score).toBeLessThanOrEqual(
      compact.pipeline.estimatedLayout.hypotheses[0].score,
    );
    expect(args).toEqual(original);
    expect(expanded.pipeline.camera).toEqual(compact.pipeline.camera);
    const plan = expanded.plans['basin-1']!;
    expect(
      validateSourceFixture(room, undefined, {
        ...plan,
        widthMm: plan.widthMm!,
        heightMm: plan.heightMm!,
        depthMm: plan.depthMm!,
      }).valid,
    ).toBe(true);
  });

  it('separates invisible-camera missing penalties from successful image fit', () => {
    const args = input([candidate()]);
    args.strictResult.pipeline.camera.camera = {
      version: 1,
      positionMm: [0, 1200, -5000],
      quaternion: [0, 0, 0, 1],
      verticalFovDegrees: 65,
      image,
    };
    const result = buildEstimatedCandidatePipeline(args);
    const held = result.pipeline.estimatedLayout.hypotheses.find((h) => h.id === 'observed-source-camera')!;
    expect(held.placedCount).toBe(0);
    expect(held.heldCandidateIds).toEqual(['basin-1']);
    expect(held.projectionAvailability[0].physicalProposalCount).toBeGreaterThan(0);
    expect(held.projectionAvailability[0].projectableProposalCount).toBe(0);
    expect(held.scoreTerms.image).toBe(0);
    expect(held.scoreTerms.missing).toBeGreaterThan(0);
    for (const h of result.pipeline.estimatedLayout.hypotheses) {
      expect(Object.values(h.scoreTerms).reduce((a, b) => a + b, 0)).toBeCloseTo(h.score, 8);
    }
    expect(result.plans['basin-1']).not.toBeNull();
  });

  it('uses a light lining only for newly estimated baths and leaves existing manual plans intact', () => {
    const args = input([
      candidate({
        id: 'bath-1',
        kind: 'bath',
        basinStyle: 'unknown',
        mounting: 'floor',
        bounds: { left: 0.2, top: 0.6, right: 0.9, bottom: 0.88 },
      }),
    ]);
    const result = buildEstimatedCandidatePipeline(args);
    expect(result.plans['bath-1']?.bathLiningColor).toBe('#eeefeb');
    expect(result.plans['bath-1']?.provenance?.bathLiningColor).toBe('default');
    const existing = structuredClone(result.plans['bath-1']!);
    delete existing.bathLiningColor;
    delete existing.provenance!.bathLiningColor;
    args.strictResult.plans['bath-1'] = existing;
    const original = structuredClone(args.strictResult.plans);
    const preserved = buildEstimatedCandidatePipeline({ ...args, manualIdSet: new Set(['bath-1']) });
    expect(preserved.plans['bath-1']).toEqual(existing);
    expect(args.strictResult.plans).toEqual(original);
  });
});

describe('unconfirmed room proportion experiment', () => {
  it('compares original and hypothetical rooms with identical nominal products without editing the input', () => {
    const args = input([candidate()]);
    const before = structuredClone(args);
    const progress: number[] = [];
    const experiment = buildEstimatedRoomLayoutExperiment({
      ...args,
      cameraSearch: 'compact',
      widthHeightRatios: [0.65, 1],
      depthHeightRatios: [0.85, 1],
      onProgress: (event) => progress.push(event.completed),
    });
    expect(experiment.status).toBe('unconfirmed-experiment');
    expect(experiment.summaries).toHaveLength(4);
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(experiment.summaries.every((row) => row.room.heightMm === room.heightMm)).toBe(true);
    expect(experiment.original.room).toEqual(room);
    const nominal = reconstructionDefaults('basin', 'wall');
    for (const result of [experiment.original.result, experiment.selected.result]) {
      const plan = result.plans['basin-1']!;
      expect([plan.widthMm, plan.heightMm, plan.depthMm]).toEqual([
        nominal.widthMm,
        nominal.heightMm,
        nominal.depthMm,
      ]);
    }
    expect(args).toEqual(before);
    expect(experiment.ambiguity.nearTieCount).toBeGreaterThanOrEqual(1);
    expect(
      experiment.summaries.every((row) => row.structure.cornerCount === 0 && row.structure.lineCount === 0),
    ).toBe(true);
  });

  it('counts only recorded structural lines and penalizes incompatible directions', () => {
    const source = {
      version: 1 as const,
      positionMm: [0, 1200, 3000] as [number, number, number],
      quaternion: [0, 0, 0, 1] as [number, number, number, number],
      verticalFovDegrees: 65,
      image,
    };
    const vertical = {
      orthogonal: true as const,
      evidence: [],
      uncertainty: [],
      lines: [
        {
          axis: 'height' as const,
          start: { x: 0.5, y: 0.1 },
          end: { x: 0.5, y: 0.9 },
          evidence: ['synthetic vertical'],
        },
      ],
    };
    const correct = inspectEstimatedRoomStructure(room, source, vertical);
    const wrong = inspectEstimatedRoomStructure(room, source, {
      ...vertical,
      lines: [{ ...vertical.lines[0], axis: 'width' }],
    });
    expect(correct.lineCount).toBe(1);
    expect(correct.score).toBeCloseTo(0, 8);
    expect(wrong.score).toBeGreaterThan(3);
    expect(
      inspectEstimatedRoomStructure(room, source, { orthogonal: 'unknown', evidence: [], uncertainty: [] })
        .lineCount,
    ).toBe(0);
  });

  it('rejects manual placements instead of moving them into hypothetical rooms', () => {
    expect(() =>
      buildEstimatedRoomLayoutExperiment({
        ...input([candidate()]),
        manualIdSet: new Set(['basin-1']),
        widthHeightRatios: [1],
        depthHeightRatios: [1],
      }),
    ).toThrow();
  });
});

describe('observed fixture appearance in estimated layout', () => {
  const appearanceFor = (args: ReturnType<typeof input>, rows: Parameters<typeof JSON.stringify>[0][]) =>
    parseFixtureAppearance(JSON.stringify({ schemaVersion: 1, observations: rows }), args.understanding);
  const row = (id: string, changes: Record<string, unknown> = {}) => ({
    id,
    note: 'Synthetic visible structure for a contract test, not an actual AI result.',
    kind: 'mirror',
    context: 'physical',
    sameObjectAs: null,
    shape: 'rectangular',
    counterSupport: 'unknown',
    ...changes,
  });

  it('uses a floating open counter envelope above the floor instead of a low enclosing cabinet', () => {
    const args = input([
      candidate({ id: 'counter', kind: 'vanity', mounting: 'wall', basinStyle: 'unknown' }),
    ]);
    const appearance = appearanceFor(args, [
      row('counter', {
        kind: 'open_counter_basin',
        shape: 'oval',
        counterSupport: 'wall',
      }),
    ]);
    const result = buildEstimatedCandidatePipeline({
      ...input(appearance.understanding.candidates),
      appearance,
      sizeFactors: [1],
    });
    const plan = result.plans.counter!;
    expect(plan.vanityStyle).toBe('open-counter');
    expect(plan.counterSupport).toBe('wall');
    expect(plan.face).not.toBe('floor');
    expect([plan.widthMm, plan.heightMm, plan.depthMm]).toEqual([1000, 330, 550]);
    expect(plan.baseHeightMm).toBeGreaterThanOrEqual(550);
    expect(plan.provenance?.vanityStyle).toBe('model');
    expect(result.pipeline.estimatedLayout.appearance?.decisions[0].original).toEqual(
      args.understanding.candidates[0],
    );
  });

  it('places confirmed counter panels on the floor and keeps the nominal complete envelope', () => {
    const args = input([
      candidate({ id: 'counter', kind: 'vanity', mounting: 'floor', basinStyle: 'unknown' }),
    ]);
    const appearance = appearanceFor(args, [
      row('counter', {
        kind: 'open_counter_basin',
        shape: 'oval',
        counterSupport: 'both-panels',
      }),
    ]);
    const result = buildEstimatedCandidatePipeline({
      ...input(appearance.understanding.candidates),
      appearance,
      sizeFactors: [1],
    });
    expect(result.plans.counter?.face).toBe('floor');
    expect(result.plans.counter?.baseHeightMm).toBe(0);
    expect(result.plans.counter?.heightMm).toBe(950);
    expect(result.plans.counter?.counterSupport).toBe('both-panels');
  });

  it('preserves observed oval mirrors while user model options win over a later observation', () => {
    const args = input([
      candidate({ id: 'mirror', kind: 'mirror', mounting: 'wall', basinStyle: 'unknown' }),
    ]);
    const appearance = appearanceFor(args, [row('mirror', { shape: 'oval' })]);
    const updated = input(appearance.understanding.candidates);
    const first = buildEstimatedCandidatePipeline({ ...updated, appearance });
    expect(first.plans.mirror?.mirrorShape).toBe('oval');
    const user = {
      ...first.plans.mirror!,
      mirrorShape: 'arched' as const,
      provenance: { ...first.plans.mirror!.provenance, mirrorShape: 'user' as const },
    };
    updated.strictResult.plans.mirror = user;
    const second = buildEstimatedCandidatePipeline({ ...updated, appearance });
    expect(second.plans.mirror?.mirrorShape).toBe('arched');
    expect(second.plans.mirror?.provenance?.mirrorShape).toBe('user');
    const manual = buildEstimatedCandidatePipeline({
      ...updated,
      appearance,
      manualIdSet: new Set(['mirror']),
    });
    expect(manual.plans.mirror).toEqual(user);
  });

  it('excludes only an explicit validated same-object alias and preserves both original nodes', () => {
    const a = candidate({ id: 'mirror-a', kind: 'mirror', mounting: 'wall', basinStyle: 'unknown' });
    const b = { ...a, id: 'mirror-b' };
    const args = input([a, b]);
    const appearance = appearanceFor(args, [row(a.id), row(b.id, { sameObjectAs: a.id })]);
    const result = buildEstimatedCandidatePipeline({
      ...input(appearance.understanding.candidates),
      appearance,
    });
    expect(result.pipeline.estimatedLayout.nodes).toHaveLength(2);
    expect(result.pipeline.estimatedLayout.nodes.find((n) => n.candidateId === b.id)?.status).toBe(
      'excluded',
    );
    expect(result.plans[b.id]).toBeNull();
    expect(result.plans[a.id]).not.toBeNull();
    expect(
      result.pipeline.estimatedLayout.nodes.find((n) => n.candidateId === b.id)?.observed.bounds,
    ).toEqual(b.bounds);
    const noRelation = appearanceFor(args, [row(a.id), row(b.id)]);
    const unconfirmed = buildEstimatedCandidatePipeline({
      ...input(noRelation.understanding.candidates),
      appearance: noRelation,
    });
    expect(
      unconfirmed.pipeline.estimatedLayout.nodes.find((n) => n.candidateId === b.id)?.reasons.join(' '),
    ).not.toContain('동일 실물');
  });
});

const wallPlane = (
  id: string,
  normal: [number, number, number] = [0, 0, -1],
  occupied = '1'.repeat(4096),
): DepthPlaneObservation => {
  const offset = 2;
  const point: [number, number, number] =
    Math.abs(normal[2]) > 0.1 ? [0, 0, -offset / normal[2]] : [(-offset - normal[2]) / normal[0], 0, 1];
  return {
    id,
    normalCamera: normal,
    offset,
    medianPointCamera: point,
    inlierCount: 200,
    inlierFraction: 0.4,
    imageAreaFraction: 0.2,
    rmsResidual: 0.002,
    imageSupport: { width: 64, height: 64, occupied, bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
  };
};
const planeInput = (walls = [wallPlane('back-fragment')]) => ({
  expectedInputFingerprint: 'a'.repeat(64),
  observation: {
    version: 1,
    inputFingerprint: 'a'.repeat(64),
    image,
    model: { id: 'synthetic-depth-contract-test', revision: 'unit-only' },
    coordinateSystem: 'opencv-camera',
    scale: 'model-estimated-metres',
    intrinsics: { fx: 1, fy: 0.75, cx: 0.5, cy: 0.5 },
    floor: {
      id: 'floor',
      normalCamera: [0, -1, 0],
      offset: 1,
      medianPointCamera: [0, 1, 2],
      inlierCount: 200,
      inlierFraction: 0.8,
      imageAreaFraction: 0.2,
      rmsResidual: 0.002,
    },
    walls,
  } as DepthRoomObservation,
});

describe('independent surrounding depth wall evidence', () => {
  it('groups parallel fragments without unblocking strict source-camera inference', () => {
    const a = wallPlane('back-a');
    const b = wallPlane('back-b', [0.1, 0, -Math.sqrt(0.99)]);
    const args = input([candidate()]);
    const evidenceInput = planeInput([a, b]);
    const before = structuredClone(evidenceInput);
    const result = buildEstimatedCandidatePipeline({ ...args, depthWallEvidence: evidenceInput });
    expect(result.pipeline.camera).toEqual(args.strictResult.pipeline.camera);
    expect(result.pipeline.camera.status).toBe('held');
    expect(result.pipeline.estimatedLayout.depthWallEvidence?.families).toHaveLength(1);
    expect(result.pipeline.estimatedLayout.depthWallEvidence?.nodes[0].status).toBe('supported');
    expect(result.pipeline.estimatedLayout.nodes[0].selected?.scoreTerms.depthWallOrientation).toBeTypeOf(
      'number',
    );
    expect(result.pipeline.estimatedLayout.nodes[0].selected?.sources.position).toBe('estimated');
    expect(evidenceInput).toEqual(before);
  });

  it('holds wrong fingerprints and does not merge opposite wall orientations', () => {
    const invalid = planeInput();
    invalid.expectedInputFingerprint = 'b'.repeat(64);
    expect(buildEstimatedDepthWallEvidence(invalid, [candidate()], image).status).toBe('held');
    const x = Math.sqrt(1 - 0.01 ** 2);
    const opposite = buildEstimatedDepthWallEvidence(
      planeInput([wallPlane('left', [x, 0, -0.01]), wallPlane('right', [-x, 0, -0.01])]),
      [candidate()],
      image,
    );
    expect(opposite.families).toHaveLength(2);
    expect(opposite.nodes[0].status).toBe('held');
  });

  it('canonicalizes an equivalent plane equation without merging opposite walls', () => {
    const flipped = wallPlane('flipped');
    flipped.normalCamera = [0, 0, 1];
    flipped.offset = -2;
    const evidence = buildEstimatedDepthWallEvidence(
      planeInput([wallPlane('regular'), flipped]),
      [candidate()],
      image,
    );
    expect(evidence.families).toHaveLength(1);
    expect(evidence.families[0].normalCamera).toEqual([0, 0, -1]);
  });

  it('does not use object interiors or occluded mirror/glass cells as supporting walls', () => {
    const item = candidate();
    const interior = Array.from({ length: 4096 }, (_, i) => {
      const x = ((i % 64) + 0.5) / 64,
        y = (Math.floor(i / 64) + 0.5) / 64;
      return x >= item.bounds.left &&
        x <= item.bounds.right &&
        y >= item.bounds.top &&
        y <= item.bounds.bottom
        ? '1'
        : '0';
    }).join('');
    expect(
      buildEstimatedDepthWallEvidence(
        planeInput([wallPlane('interior', [0, 0, -1], interior)]),
        [item],
        image,
      ).nodes[0].status,
    ).toBe('held');
    const glass = candidate({
      id: 'glass',
      kind: 'glassPartition',
      bounds: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
    });
    const masked = buildEstimatedDepthWallEvidence(planeInput(), [item, glass], image);
    expect(masked.nodes[0].status).toBe('held');
    expect(masked.nodes[0].support[0].maskedOccupiedCells).toBeGreaterThan(0);
    expect(masked.nodes[1].status).toBe('excluded');
  });

  it('scores normals through full camera quaternion rather than naming front-facing pixels back', () => {
    const q = new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0));
    const camera = {
      version: 1 as const,
      image,
      positionMm: [0, 1000, 2000] as [number, number, number],
      quaternion: q.toArray() as [number, number, number, number],
      verticalFovDegrees: 65,
    };
    expect(estimatedDepthWallOrientation([0, 0, -1], camera, 'left').penalty).toBeLessThan(1e-8);
    expect(estimatedDepthWallOrientation([0, 0, -1], camera, 'back').penalty).toBeGreaterThan(1);
    const rolled = new Quaternion().setFromEuler(new Euler(0, 0, Math.PI / 2));
    camera.quaternion = rolled.toArray() as [number, number, number, number];
    expect(estimatedDepthWallOrientation([0, 1, 0], camera, 'left').penalty).toBeLessThan(1e-8);
  });

  it('excludes explicit manual and reflected fixtures from model wall scoring', () => {
    const reflected = candidate({ id: 'reflection', reflection: 'reflected' });
    const result = buildEstimatedDepthWallEvidence(
      planeInput(),
      [candidate(), reflected],
      image,
      new Set(['basin-1']),
    );
    expect(result.nodes.every((n) => n.status === 'excluded')).toBe(true);
  });
});

describe('depth wall evidence remains optional under invalid geometry', () => {
  it('does not alter candidate plans when the independent image fingerprint fails', () => {
    const args = input([candidate()]);
    const invalid = planeInput();
    invalid.expectedInputFingerprint = 'b'.repeat(64);
    const original = buildEstimatedCandidatePipeline(args);
    const result = buildEstimatedCandidatePipeline({ ...args, depthWallEvidence: invalid });
    expect(result.plans).toEqual(original.plans);
    expect(result.pipeline.camera).toEqual(original.pipeline.camera);
    expect(result.pipeline.estimatedLayout.depthWallEvidence?.status).toBe('held');
  });

  it('rejects weak floor support and wall planes inconsistent with gravity', () => {
    const weak = planeInput();
    weak.observation.floor!.inlierFraction = 0.1;
    const missingUp = buildEstimatedDepthWallEvidence(weak, [candidate()], image);
    expect(missingUp.status).toBe('held');
    expect(missingUp.nodes).toHaveLength(0);
    const horizontal = wallPlane('horizontal');
    horizontal.normalCamera = [0, -1, 0];
    horizontal.medianPointCamera = [0, 2, 1];
    const result = buildEstimatedDepthWallEvidence(planeInput([horizontal]), [candidate()], image);
    expect(result.rejectedPlanes).toContainEqual({
      id: 'horizontal',
      reason: 'not-perpendicular-to-observed-floor',
    });
    expect(result.nodes[0].status).toBe('held');
  });
});

describe('photo-relative relation consistency', () => {
  const top = candidate({
    id: 'top',
    kind: 'mirror',
    bounds: { left: 0.1, top: 0.1, right: 0.3, bottom: 0.3 },
  });
  const bottom = candidate({ id: 'bottom', bounds: { left: 0.6, top: 0.6, right: 0.8, bottom: 0.8 } });
  const relation = (type: LayoutObservationInput['relations'][number]['type']) => ({
    fromId: 'top',
    toId: 'bottom',
    type,
    note: 'Synthetic relation only.',
  });

  it('holds clear reversed x/y order but preserves raw relationships and original candidates', () => {
    const relations = [relation('rightOf'), relation('below'), relation('leftOf'), relation('above')];
    const before = structuredClone(relations);
    const checks = inspectEstimatedPhotoRelations([top, bottom], relations);
    expect(checks.rejected.map((r) => r.relation.type)).toEqual(['rightOf', 'below']);
    expect(checks.accepted.map((r) => r.type)).toEqual(['leftOf', 'above']);
    expect(checks.checks.every((r) => r.intervalGap! > 0.01)).toBe(true);
    expect(relations).toEqual(before);
  });

  it('does not label overlapping, cropped or nearby boxes as opposite order', () => {
    const overlap = candidate({ id: 'bottom', bounds: { left: 0.2, top: 0.2, right: 0.9, bottom: 0.9 } });
    const nearby = candidate({
      id: 'bottom',
      bounds: { left: 0.295, top: 0.295, right: 0.305, bottom: 0.305 },
    });
    for (const item of [overlap, nearby]) {
      const result = inspectEstimatedPhotoRelations([top, item], [relation('rightOf'), relation('below')]);
      expect(result.rejected).toHaveLength(0);
      expect(result.checks.every((c) => c.status === 'inconclusive')).toBe(true);
    }
  });

  it('never infers room depth, mounting walls or support from image ordering', () => {
    const relations = ['inFrontOf', 'behind', 'supportedBy', 'attachedTo', 'visibleThrough'].map((type) =>
      relation(type as LayoutObservationInput['relations'][number]['type']),
    );
    const result = inspectEstimatedPhotoRelations([top, bottom], relations);
    expect(result.accepted).toEqual(relations);
    expect(result.checks.every((c) => c.status === 'not-photo-relative')).toBe(true);
  });

  it('scores checked relations while retaining a separate raw baseline for actual-cache experiments', () => {
    const rawRelation = {
      fromId: 'bottom',
      toId: 'top',
      type: 'above' as const,
      note: 'Contradicts separated boxes.',
    };
    const args = input([top, bottom], { observations: [], relations: [rawRelation] });
    const before = structuredClone(args);
    const checked = buildEstimatedCandidatePipeline(args);
    const raw = buildEstimatedCandidatePipeline({ ...args, photoRelationPolicy: 'raw-experiment' });
    expect(checked.pipeline.estimatedLayout.relations).toEqual([rawRelation]);
    expect(checked.pipeline.estimatedLayout.relationConsistency?.accepted).toEqual([]);
    expect(checked.pipeline.estimatedLayout.relationConsistency?.rejected[0].relation).toEqual(rawRelation);
    expect(checked.pipeline.estimatedLayout.hypotheses[0].scoreTerms.relations).toBe(0);
    expect(raw.pipeline.estimatedLayout.photoRelationPolicy).toBe('raw-experiment');
    expect(raw.pipeline.estimatedLayout.relations).toEqual([rawRelation]);
    expect(checked.pipeline.camera).toEqual(before.strictResult.pipeline.camera);
    expect(args).toEqual(before);
  });
});

describe('optional observed camera directions', () => {
  it('uses rotation/FOV observations but keeps exactly the supplied translation grid', () => {
    const positions: [number, number, number][] = [
      [-200, 1400, 2800],
      [200, 1400, 2800],
    ];
    const observation = planeInput();
    const result = buildEstimatedCameraDirections(observation, image, positions);
    expect(result.status).toBe('available');
    expect(result.hypotheses).toHaveLength(6);
    expect(
      result.hypotheses.every((h) =>
        positions.some((p) => JSON.stringify(p) === JSON.stringify(h.camera.positionMm)),
      ),
    ).toBe(true);
    const back = result.hypotheses.find((h) => h.assignedWall === 'back')!;
    const worldUp = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(...back.camera.quaternion));
    expect(worldUp.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-8);
    expect(back.camera.verticalFovDegrees).toBeCloseTo((2 * Math.atan(0.5 / 0.75) * 180) / Math.PI);
    const scaled = structuredClone(observation);
    for (const p of [scaled.observation.floor!, ...scaled.observation.walls]) {
      p.offset *= 3;
      p.medianPointCamera = p.medianPointCamera.map((v) => v * 3) as [number, number, number];
      p.rmsResidual *= 3;
    }
    expect(buildEstimatedCameraDirections(scaled, image, positions).hypotheses).toEqual(result.hypotheses);
  });

  it('rejects off-centre or nonsquare intrinsics instead of fitting another camera silently', () => {
    for (const modify of [
      (v: ReturnType<typeof planeInput>) => {
        v.observation.intrinsics.cx = 0.52;
      },
      (v: ReturnType<typeof planeInput>) => {
        v.observation.intrinsics.fx = 1.2;
      },
    ]) {
      const bad = planeInput();
      modify(bad);
      expect(buildEstimatedCameraDirections(bad, image, [[0, 1400, 2800]]).status).toBe('held');
    }
  });

  it('preserves camera roll encoded in the floor normal and groups equivalent wall fragments', () => {
    const tilted = planeInput();
    tilted.observation.floor!.normalCamera = [-1, 0, 0];
    tilted.observation.floor!.medianPointCamera = [1, 0, 2];
    const result = buildEstimatedCameraDirections(tilted, image, [[0, 1400, 2800]]);
    const h = result.hypotheses.find((h) => h.assignedWall === 'back')!;
    const q = new Quaternion(...h.camera.quaternion);
    expect(new Vector3(-1, 0, 0).applyQuaternion(q).distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-8);
    expect(Math.abs(q.z)).toBeGreaterThan(0.5);
  });

  it('keeps original compact hypotheses and strict held-camera diagnostics unchanged', () => {
    const args = input([candidate()]);
    const original = buildEstimatedCandidatePipeline(args);
    const result = buildEstimatedCandidatePipeline({ ...args, cameraDirectionEvidence: planeInput() });
    expect(result.pipeline.camera).toEqual(original.pipeline.camera);
    expect(result.pipeline.camera.status).toBe('held');
    expect(result.pipeline.estimatedLayout.cameraDirectionObservation?.status).toBe('available');
    for (const h of original.pipeline.estimatedLayout.hypotheses) {
      const preserved = result.pipeline.estimatedLayout.hypotheses.find((item) => item.id === h.id)!;
      expect(preserved.camera).toEqual(h.camera);
      expect(preserved.score).toBe(h.score);
    }
    expect(result.pipeline.estimatedLayout.hypotheses.length).toBeGreaterThan(6);
  });
});

describe('derived assembly observation bounds', () => {
  const bowl = candidate({ id: 'bowl', bounds: { left: 0.4, top: 0.45, right: 0.7, bottom: 0.55 } });
  const counter = candidate({
    id: 'counter',
    kind: 'vanity',
    mounting: 'wall',
    bounds: { left: 0.3, top: 0.52, right: 0.8, bottom: 0.8 },
  });
  const args = () =>
    input([bowl, counter], {
      observations: [],
      relations: [
        {
          fromId: 'bowl',
          toId: 'counter',
          type: 'supportedBy',
          note: 'Explicit synthetic support observation.',
        },
      ],
    });
  it('compares a combined model to a derived union while preserving every original observation', () => {
    const source = args(),
      before = structuredClone(source);
    const combined = buildEstimatedCandidatePipeline(source);
    const record = combined.pipeline.estimatedLayout.assemblies[0].observationBounds!;
    expect(record.status).toBe('combined');
    expect(record.bounds).toEqual({ left: 0.3, top: 0.45, right: 0.8, bottom: 0.8 });
    expect(record.observations).toEqual([
      { candidateId: 'counter', bounds: counter.bounds },
      { candidateId: 'bowl', bounds: bowl.bounds },
    ]);
    expect(
      combined.pipeline.estimatedLayout.nodes.find((n) => n.candidateId === 'counter')!.observed.bounds,
    ).toEqual(counter.bounds);
    expect(
      combined.pipeline.estimatedLayout.nodes.find((n) => n.candidateId === 'bowl')!.observed.bounds,
    ).toEqual(bowl.bounds);
    expect(combined.plans.bowl).toBeNull();
    expect(source).toEqual(before);
  });
  it('retains parent-only scoring as an explicit comparison policy and does not invent a support relation', () => {
    const original = buildEstimatedCandidatePipeline({
      ...args(),
      assemblyBoundsPolicy: 'parent-only-experiment',
    });
    expect(original.pipeline.estimatedLayout.assemblyBoundsPolicy).toBe('parent-only-experiment');
    const none = buildEstimatedCandidatePipeline(input([bowl, counter]));
    expect(none.pipeline.estimatedLayout.assemblies).toEqual([]);
  });
  it('records inconsistent disjoint support boxes as held without inventing a combined area', () => {
    const far = candidate({ ...bowl, bounds: { left: 0.01, top: 0.1, right: 0.2, bottom: 0.2 } });
    const source = input([far, counter], {
      observations: [],
      relations: [
        {
          fromId: 'bowl',
          toId: 'counter',
          type: 'supportedBy',
          note: 'Inconsistent synthetic relation.',
        },
      ],
    });
    const result = buildEstimatedCandidatePipeline(source);
    const bounds = result.pipeline.estimatedLayout.assemblies[0].observationBounds!;
    expect(bounds.status).toBe('held');
    expect(bounds.bounds).toEqual(counter.bounds);
    expect(
      result.pipeline.estimatedLayout.nodes.find((n) => n.candidateId === 'counter')!.reasons.join(' '),
    ).toContain('합치지');
  });
});

describe('isolated scoring experiments (synthetic contracts, not photo quality)', () => {
  it('records unverified depth without mutating or deleting the observed relationship', () => {
    const args = input(
      [
        candidate({ id: 'basin-a', bounds: { left: 0.2, top: 0.4, right: 0.42, bottom: 0.62 } }),
        candidate({
          id: 'toilet-b',
          kind: 'toilet',
          mounting: 'floor',
          basinStyle: 'unknown',
          bounds: { left: 0.58, top: 0.55, right: 0.8, bottom: 0.95 },
        }),
      ],
      {
        observations: [],
        relations: [
          {
            fromId: 'toilet-b',
            toId: 'basin-a',
            type: 'behind',
            note: 'Do not parse this note to reverse the enum.',
          },
        ],
      },
    );
    const before = structuredClone(args);
    const out = buildEstimatedCandidatePipeline({ ...args, depthRelationPolicy: 'hold-unverified' });
    const details = out.pipeline.estimatedLayout;
    expect(details.relations).toEqual(before.layoutObservation!.relations);
    expect(details.depthRelationEvidence?.scoredRelations).toEqual([]);
    expect(details.depthRelationEvidence?.heldRelations[0]).toMatchObject({
      effectiveWeight: 0,
      status: 'unverified',
      relation: before.layoutObservation!.relations[0],
    });
    expect(args).toEqual(before);
    expect(out.pipeline.understanding).toEqual(args.understanding);
  });
  it('keeps plans and camera identical when there is no front/back relation', () => {
    const args = input([candidate()], { observations: [], relations: [] });
    const control = buildEstimatedCandidatePipeline(args);
    const changed = buildEstimatedCandidatePipeline({ ...args, depthRelationPolicy: 'hold-unverified' });
    expect(changed.plans).toEqual(control.plans);
    expect(changed.pipeline.estimatedLayout.camera).toEqual(control.pipeline.estimatedLayout.camera);
    expect(changed.pipeline.estimatedLayout.hypotheses).toEqual(control.pipeline.estimatedLayout.hypotheses);
  });
  it('uses actual pixel units for the optional bowl-region heuristic and preserves the candidate', () => {
    const args = input([
      candidate({
        mounting: 'floor',
        basinStyle: 'pedestal',
        bounds: { left: 0.2, top: 0.3, right: 0.5, bottom: 0.55 },
      }),
    ]);
    args.image = { width: 1200, height: 800 };
    args.strictResult = buildCandidatePipeline(args.understanding, baseline, room, args.image);
    const before = structuredClone(args);
    const control = buildEstimatedCandidatePipeline({ ...args, basinRegionPolicy: 'legacy-normalized' });
    const changed = buildEstimatedCandidatePipeline(args);
    expect(control.pipeline.estimatedLayout.basinRegionPolicy).toBe('legacy-normalized');
    const node = changed.pipeline.estimatedLayout.nodes[0];
    expect(node.basinRegion).toMatchObject({ bowlOnly: true, source: 'aspect-heuristic-not-observed-part' });
    expect(node.basinRegion?.pixelAspect).toBeCloseTo(200 / 360);
    expect(node.basinRegion?.normalizedAspect).toBeGreaterThan(0.65);
    expect(node.observed).toEqual(args.understanding.candidates[0]);
    expect(args).toEqual(before);
  });
});

describe('camera ranking stays separate from scene solving', () => {
  it('keeps every scene score and plan when no typed kind conflict is supplied', () => {
    const args = input([candidate()]);
    const before = structuredClone(args);
    const control = buildEstimatedCandidatePipeline({ ...args, cameraRankingPolicy: 'joint-score' });
    const trial = buildEstimatedCandidatePipeline(args);
    expect(trial.pipeline.estimatedLayout.cameraRanking?.status).toBe('no-conflicts');
    expect(trial.plans).toEqual(control.plans);
    expect(trial.pipeline.estimatedLayout.camera).toEqual(control.pipeline.estimatedLayout.camera);
    expect(trial.pipeline.estimatedLayout.nodes).toEqual(control.pipeline.estimatedLayout.nodes);
    expect(
      trial.pipeline.estimatedLayout.hypotheses.map((entry) => {
        const h = { ...entry };
        delete h.cameraRankingScore;
        return h;
      }),
    ).toEqual(control.pipeline.estimatedLayout.hypotheses);
    expect(args).toEqual(before);
  });
  it('records a class conflict but falls back when the remaining camera evidence is insufficient', () => {
    const args = input([
      candidate({ id: 'changed-object', kind: 'wallShelf', mounting: 'wall', basinStyle: 'unknown' }),
    ]);
    const appearance = parseFixtureAppearance(
      JSON.stringify({
        schemaVersion: 1,
        observations: [
          {
            id: 'changed-object',
            kind: 'mirror',
            context: 'physical',
            sameObjectAs: null,
            shape: 'rectangular',
            counterSupport: 'unknown',
            note: 'Synthetic mismatch to verify fallback, not actual recognition.',
          },
        ],
      }),
      args.understanding,
    );
    const request = {
      ...args,
      understanding: appearance.understanding,
      appearance,
      strictResult: buildCandidatePipeline(appearance.understanding, baseline, room, image),
    };
    const before = structuredClone(request);
    const control = buildEstimatedCandidatePipeline({ ...request, cameraRankingPolicy: 'joint-score' });
    const trial = buildEstimatedCandidatePipeline(request);
    expect(trial.pipeline.estimatedLayout.cameraRanking).toMatchObject({
      status: 'insufficient',
      conflicts: [{ candidateId: 'changed-object', originalKind: 'wallShelf', effectiveKind: 'mirror' }],
    });
    expect(trial.plans).toEqual(control.plans);
    expect(trial.pipeline.estimatedLayout.camera).toEqual(control.pipeline.estimatedLayout.camera);
    for (const h of trial.pipeline.estimatedLayout.hypotheses) {
      const old = control.pipeline.estimatedLayout.hypotheses.find((row) => row.id === h.id)!;
      expect(h.score).toBe(old.score);
      expect(h.scoreTerms).toEqual(old.scoreTerms);
      expect(h.heldCandidateIds).toEqual(old.heldCandidateIds);
    }
    expect(request).toEqual(before);
  });
});

// Synthetic contract checks; photo-quality evidence comes from the actual corpus runs.
describe('suspended curtain estimated placement', () => {
  it('uses a hanging anchor while preserving the raw scene and strict hold', () => {
    const args = input([candidate({
      id: 'hanging-panel', kind: 'showerCurtain', mounting: 'suspended', basinStyle: 'unknown',
      bounds: { left: .62, top: .08, right: 1, bottom: .91 },
      provenance: { kind: 'model', mounting: 'geometry' },
    })]);
    const before = structuredClone(args);
    expect(args.strictResult.plans['hanging-panel']).toBeNull();
    const result = buildEstimatedCandidatePipeline(args);
    const plan = result.plans['hanging-panel']!;
    const selected = result.pipeline.estimatedLayout.nodes[0].selected!;
    expect(plan.kind).toBe('showerCurtain');
    expect(plan.face).toBe('floor');
    expect(selected.anchorRole).toBe('suspension-support-centre');
    expect(selected.sources.mounting).toBe('geometry-derived');
    expect(plan.provenance?.mounting).toBe('inferred');
    expect(selected.plan.provenance?.mounting).toBe('inferred');
    expect(selected.sources.position).toBe('estimated');
    expect(selected.hangingAnchorMm?.[1]).toBeGreaterThan(plan.baseHeightMm!);
    expect(selected.hangingAnchorMm?.[1]).toBeLessThanOrEqual(plan.baseHeightMm! + plan.heightMm!);
    expect(selected.physicalCheck.valid).toBe(true);
    expect(result.review.candidates[0].installation?.mode).toBe('suspended');
    expect(args).toEqual(before);
  });
  it('keeps duplicate observations but emits only one suspended standard model', () => {
    const first = candidate({ id: 'curtain-a', kind: 'showerCurtain', mounting: 'suspended', basinStyle: 'unknown' });
    const args = input([first, { ...structuredClone(first), id: 'curtain-b' }]);
    const result = buildEstimatedCandidatePipeline(args);
    expect(args.understanding.candidates).toHaveLength(2);
    expect(Object.values(result.plans).filter(Boolean)).toHaveLength(1);
    expect(result.pipeline.resolution.entries.filter(e => e.disposition === 'duplicate')).toHaveLength(1);
    expect(result.pipeline.estimatedLayout.nodes.filter(e => e.status === 'excluded')).toHaveLength(1);
  });
});
