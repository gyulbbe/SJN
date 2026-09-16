import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { buildEstimatedCandidatePipeline } from '../src/lib/reconstruction/estimated-layout';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';

// Authored normalized regions and a user-positioned support. No corpus photo or measured coordinates.
// The image-only top choices put the pane behind the tub, contrary to the independent relation.
function input() {
  const baseline: ReconstructionReview = {
    version: 2,
    analysis: 'partial',
    candidates: [],
    planes: [],
    warnings: [],
  };
  const room = { ...DEFAULT_ROOM };
  const image = { width: 960, height: 1280 };
  const understanding: SceneUnderstanding = {
    schemaVersion: 1,
    candidates: [
      { id: 'tub', kind: 'bath', bounds: { left: 0.2, top: 0.55, right: 0.9, bottom: 0.9 } },
      { id: 'pane', kind: 'glassPartition', bounds: { left: 0.15, top: 0.1, right: 0.45, bottom: 0.55 } },
    ].map((item) => ({
      ...item,
      kind: item.kind as 'bath' | 'glassPartition',
      mounting: 'floor',
      wall: 'unknown',
      basinStyle: 'unknown',
      shape: 'rectangular',
      reflection: 'physical',
      evidence: ['Synthetic unit observation; not an AI result.'],
      uncertainty: [],
    })),
    relations: [],
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  };
  const strictResult = buildCandidatePipeline(understanding, baseline, room, image, {
    tub: {
      face: 'floor',
      u: 0.6,
      v: 0.45,
      yawDegrees: 0,
      baseHeightMm: 0,
      widthMm: 1500,
      heightMm: 600,
      depthMm: 750,
    },
  });
  return {
    understanding,
    baseline,
    room,
    image,
    strictResult,
    manualIdSet: new Set(['tub']),
    layoutObservation: {
      observations: [],
      relations: [
        {
          fromId: 'pane',
          toId: 'tub',
          type: 'inFrontOf' as const,
          note: 'The pane stands in front of the tub.',
        },
      ],
    },
  };
}

describe('pair-aware scene search', () => {
  it('considers a lower unary-ranked pane that satisfies depth without moving the user tub', () => {
    const args = input();
    const original = structuredClone(args);
    const result = buildEstimatedCandidatePipeline(args);
    const layout = result.pipeline.estimatedLayout;
    const pane = layout.nodes.find((node) => node.candidateId === 'pane')!;
    const tub = layout.nodes.find((node) => node.candidateId === 'tub')!;
    const paneBox = pane.selected!.physicalCheck.worldBoundsMm!;
    const tubBox = tub.selected!.physicalCheck.worldBoundsMm!;
    expect((paneBox.min[2] + paneBox.max[2]) / 2).toBeGreaterThan((tubBox.min[2] + tubBox.max[2]) / 2);
    expect(layout.hypotheses[0].scoreTerms.relations).toBe(0);
    expect(layout.hypotheses[0].placedCount).toBe(2);
    expect(pane.selected!.physicalCheck.valid).toBe(true);
    expect(pane.selected!.sceneChecks?.every((check) => !check.collision)).toBe(true);
    expect(pane.selected!.proposalSearch!.unaryRank).toBeGreaterThan(36);
    expect(pane.selected!.proposalSearch!.projectableProposalCount).toBeGreaterThan(
      pane.selected!.proposalSearch!.unaryRank,
    );
    // The search is broader, but the public alternative list stays bounded and includes its winner.
    expect(pane.alternatives.length).toBeLessThanOrEqual(5);
    expect(
      pane.alternatives.some(
        (alternative) =>
          alternative.plan === pane.selected!.plan ||
          JSON.stringify(alternative.plan) === JSON.stringify(pane.selected!.plan),
      ),
    ).toBe(true);
    expect(result.plans.tub).toEqual(original.strictResult.plans.tub);
    expect(args).toEqual(original);
  });
});
